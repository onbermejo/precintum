/**
 * Panel de administración: servidor HTTP de SOLO LECTURA.
 *
 * Decisiones de seguridad, porque un panel es superficie de ataque sobre el sistema de evidencia:
 *
 *  - **Solo GET y HEAD.** Cualquier otro método se rechaza con 405. No hay ninguna ruta que
 *    escriba en la base de datos: ni recibos, ni lotes, ni configuración. Lo que cambia el
 *    sistema se cambia en el despliegue, no desde un navegador.
 *  - **Solo rutas fijas.** No se sirve ningún fichero por ruta pedida, así que no hay recorrido
 *    de directorios posible. El panel es un único HTML incrustado en el binario.
 *  - **Nunca secretos.** La nsec, la clave de deduplicación y la contraseña de la TSA no salen
 *    en ninguna respuesta; de ellas solo se dice si están configuradas. Sí sale la clave pública,
 *    que es pública por definición.
 *  - **Sin CORS.** No se emite `Access-Control-Allow-Origin`, así que ninguna otra web puede
 *    leer estas respuestas desde el navegador de quien tenga el panel abierto.
 *  - **A localhost por defecto.** No hay autenticación: quien pueda abrir el puerto lo ve todo.
 *    Exponerlo fuera de la máquina exige pasar `--host` a conciencia, y la CLI avisa.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BatchStore } from '../../domain/evidence/batch-store.ts';
import type { EvidenceStore } from '../../domain/evidence/evidence-store.ts';
import type { WitnessStore } from '../../domain/witness/witness-store.ts';
import type { Config } from '../../shared/config.ts';
import { redactDetail, redactUrl, redactUrlsInText } from '../../shared/redact.ts';

export interface PanelDeps {
  evidence: EvidenceStore;
  batches: BatchStore;
  witness: WitnessStore;
  config: Config;
  /** npub y hex del agente, para identificar el despliegue. */
  identity: { npub: string; pubkey: string };
  now?: () => number;
  /** HTML del panel. Por defecto se lee de panel.html, junto a este fichero. */
  panelHtml?: string;
}

const HEADERS_JSON = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const HEADERS_HTML = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // El panel no carga nada de fuera. El HTML incrustado trae además su propia CSP con los hashes
  // de sus scripts (web/build.mjs); las dos se aplican a la vez y manda la más estricta.
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
};
const HEADERS_TEXT = {
  'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** ¿La dirección es solo accesible desde la propia máquina? */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function defaultPanelHtml(): string {
  try {
    return readFileSync(new URL('./panel.html', import.meta.url), 'utf8');
  } catch {
    return '<!-- panel.html no encontrado: ejecuta bash web/build.sh -->';
  }
}

export interface HealthReport {
  now: number;
  agent: { npub: string; pubkey: string };
  receipts: { total: number; lastHour: number; headSeq: number | null; headTs: number | null };
  batches: {
    total: number;
    headSeq: number | null;
    headWindow: [number, number] | null;
    headCount: number | null;
    headRoot: string | null;
    windowsBehind: number;
    withoutTsa: number;
    otsPending: number;
  };
  outbox: Record<string, number>;
  relays: Array<{ url: string; accepted: boolean | null; code: string; at: number | null }>;
  alerts: { total: number; kinds: Record<string, number> };
}

export class PanelService {
  private readonly deps: PanelDeps;

  constructor(deps: PanelDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  async health(): Promise<HealthReport> {
    const now = this.now();
    const { evidence, batches, witness, config } = this.deps;
    const head = await evidence.receipts.head();
    const batchHead = await batches.head();
    const pending = await batches.pendingAnchors(1_000);
    const alerts = await witness.alerts.list(500);
    const kinds: Record<string, number> = {};
    for (const a of alerts) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;

    // Cuántas ventanas terminadas quedan sin cerrar: es la señal de que `batch close` no corre.
    const size = config.PRECINTUM_BATCH_WINDOW_SECONDS;
    let windowsBehind = 0;
    if (batchHead) {
      windowsBehind = Math.max(0, Math.floor((now - batchHead.windowEnd) / size));
    }

    // Último evento publicado: qué contestó cada relay configurado.
    const relays: HealthReport['relays'] = [];
    if (batchHead) {
      const records = await witness.publications.forEvent(batchHead.eventId);
      for (const url of config.PRECINTUM_RELAYS) {
        const r = records.find((x) => x.relay === url);
        relays.push({
          url: redactUrl(url),
          accepted: r ? r.accepted : null,
          code: redactUrlsInText(r?.code ?? ''),
          at: r?.at ?? null,
        });
      }
    } else {
      for (const url of config.PRECINTUM_RELAYS)
        relays.push({ url: redactUrl(url), accepted: null, code: '', at: null });
    }

    return {
      now,
      agent: this.deps.identity,
      receipts: {
        total: await evidence.receipts.count(),
        lastHour: (await evidence.receipts.inWindow(now - 3_600, now + 1)).length,
        headSeq: head?.seq ?? null,
        headTs: head?.ts ?? null,
      },
      batches: {
        total: await batches.count(),
        headSeq: batchHead?.seq ?? null,
        headWindow: batchHead ? [batchHead.windowStart, batchHead.windowEnd] : null,
        headCount: batchHead?.count ?? null,
        headRoot: batchHead?.root ?? null,
        windowsBehind,
        withoutTsa: pending.filter((b) => b.tsaToken === null).length,
        otsPending: pending.filter((b) => !b.otsComplete).length,
      },
      outbox: await witness.outbox.counts(),
      relays,
      alerts: { total: alerts.length, kinds },
    };
  }

  /** Últimos lotes, con su estado de anclaje. Sin la sal del recuento: eso solo va al auditor. */
  async recentBatches(limit: number): Promise<unknown[]> {
    const head = await this.deps.batches.head();
    if (!head) return [];
    const from = Math.max(1, head.seq - limit + 1);
    const list = await this.deps.batches.range(from, head.seq);
    return list.reverse().map((b) => ({
      seq: b.seq,
      window: [b.windowStart, b.windowEnd],
      count: b.count,
      root: b.root,
      eventId: b.eventId,
      tsaGenTime: b.tsaGenTime,
      hasTsa: b.tsaToken !== null,
      otsComplete: b.otsComplete,
      hasOts: b.ots !== null,
    }));
  }

  async alerts(limit: number): Promise<unknown[]> {
    return (await this.deps.witness.alerts.list(limit)).map((alert) => ({
      ...alert,
      detail: redactDetail(alert.detail),
    }));
  }

  /**
   * Configuración vigente, saneada. Se muestra para poder auditarla, no para editarla: cambiar
   * la configuración es la superficie de ataque real y se toca en el despliegue.
   */
  config(): Record<string, unknown> {
    const c = this.deps.config;
    return {
      database: redactUrl(c.PRECINTUM_DATABASE_URL),
      relays: c.PRECINTUM_RELAYS.map(redactUrl),
      witnessQuorum: c.PRECINTUM_WITNESS_QUORUM,
      batchWindowSeconds: c.PRECINTUM_BATCH_WINDOW_SECONDS,
      policy: c.PRECINTUM_POLICY,
      tsaUrl: redactUrl(c.PRECINTUM_TSA_URL),
      tsaAuth: c.PRECINTUM_TSA_USER ? 'configurada' : 'sin credenciales',
      otsCalendars: c.PRECINTUM_OTS_CALENDARS.map(redactUrl),
      anchorMaxGapSeconds: c.PRECINTUM_ANCHOR_MAX_GAP_SECONDS,
      dedupKey: c.PRECINTUM_DEDUP_KEY ? 'fija' : 'efímera',
      dedupTtlSeconds: c.PRECINTUM_DEDUP_TTL_SECONDS,
      archivePath: c.PRECINTUM_ARCHIVE_PATH,
      logLevel: c.LOG_LEVEL,
    };
  }

  /** Formato de exposición de Prometheus. Muchos clientes preferirán esto antes que el panel. */
  async metrics(): Promise<string> {
    const h = await this.health();
    const lines: string[] = [];
    const push = (name: string, help: string, type: string, value: number, labels?: string) => {
      lines.push(
        `# HELP ${name} ${help}`,
        `# TYPE ${name} ${type}`,
        `${name}${labels ?? ''} ${value}`,
      );
    };
    push('precintum_receipts_total', 'Recibos registrados en total.', 'counter', h.receipts.total);
    push(
      'precintum_receipts_last_hour',
      'Recibos de la última hora.',
      'gauge',
      h.receipts.lastHour,
    );
    push('precintum_batches_total', 'Lotes cerrados en total.', 'counter', h.batches.total);
    push(
      'precintum_batch_windows_behind',
      'Ventanas terminadas sin cerrar.',
      'gauge',
      h.batches.windowsBehind,
    );
    push(
      'precintum_batches_without_tsa',
      'Lotes sin sello RFC 3161.',
      'gauge',
      h.batches.withoutTsa,
    );
    push(
      'precintum_batches_ots_pending',
      'Lotes con anclaje en Bitcoin sin completar.',
      'gauge',
      h.batches.otsPending,
    );
    push('precintum_alerts_total', 'Alertas registradas.', 'gauge', h.alerts.total);
    lines.push(
      '# HELP precintum_outbox_entries Entradas de la cola de salida por estado.',
      '# TYPE precintum_outbox_entries gauge',
    );
    for (const [status, n] of Object.entries(h.outbox)) {
      lines.push(`precintum_outbox_entries{status="${status}"} ${n}`);
    }
    lines.push(
      '# HELP precintum_relay_last_publication_accepted Si el relay aceptó el último lote (1 sí, 0 no, ausente si no hay dato).',
      '# TYPE precintum_relay_last_publication_accepted gauge',
    );
    for (const r of h.relays) {
      if (r.accepted !== null) {
        lines.push(
          `precintum_relay_last_publication_accepted{relay="${r.url}"} ${r.accepted ? 1 : 0}`,
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

export interface PanelServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Crea el manejador HTTP. Separado del listen para poder probarlo. */
export function createPanelHandler(
  deps: PanelDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const service = new PanelService(deps);
  const html = deps.panelHtml ?? defaultPanelHtml();

  return (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { ...HEADERS_JSON, allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: 'solo lectura: este panel no acepta escrituras' }));
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    const send = (code: number, headers: Record<string, string>, body: string) => {
      res.writeHead(code, headers);
      res.end(method === 'HEAD' ? undefined : body);
    };
    const json = async (fn: () => Promise<unknown>) => {
      try {
        send(200, HEADERS_JSON, JSON.stringify(await fn()));
      } catch (err) {
        send(
          500,
          HEADERS_JSON,
          JSON.stringify({
            error: redactUrlsInText(err instanceof Error ? err.message : String(err)),
          }),
        );
      }
    };

    switch (path) {
      case '/':
      case '/index.html':
        return send(200, HEADERS_HTML, html);
      case '/api/health':
        return void json(() => service.health());
      case '/api/batches':
        return void json(() => service.recentBatches(50));
      case '/api/alerts':
        return void json(() => service.alerts(50));
      case '/api/config':
        return void json(async () => service.config());
      case '/metrics':
        return void (async () => {
          try {
            send(200, HEADERS_TEXT, await service.metrics());
          } catch (err) {
            send(
              500,
              HEADERS_TEXT,
              `# error: ${redactUrlsInText(err instanceof Error ? err.message : String(err))}\n`,
            );
          }
        })();
      default:
        return send(404, HEADERS_JSON, JSON.stringify({ error: 'no existe' }));
    }
  };
}

export function startPanel(deps: PanelDeps, port: number, host: string): Promise<PanelServer> {
  const server = createServer(createPanelHandler(deps));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
