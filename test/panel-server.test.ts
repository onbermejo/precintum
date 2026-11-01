/**
 * El panel es superficie de ataque sobre el sistema de evidencia, así que lo que este test
 * comprueba no es solo que pinte datos: es que **no** haga nada más. Solo lectura, rutas fijas,
 * ningún secreto en las respuestas y ninguna cabecera que permita a otra web leerlo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import { parsePort } from '../src/cli/serve-commands.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import type { Receipt } from '../src/domain/evidence/receipt.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { SqlWitnessStore } from '../src/infra/db/sql-witness-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import {
  type HealthReport,
  isLoopback,
  type PanelServer,
  startPanel,
} from '../src/infra/http/panel-server.ts';
import { loadConfig } from '../src/shared/config.ts';
import { fakeOts, fakeTsa } from './support/fake-anchors.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const W = 600;
const T0 = 1_700_000_400;
const NOW = T0 + 3 * W + 30;
const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
const DEDUP = 'cd'.repeat(32);

interface BatchRow {
  seq: number;
  window: [number, number];
  count: number;
  root: string;
  hasTsa: boolean;
  otsComplete: boolean;
}
interface AlertRow {
  kind: string;
  detail: Record<string, unknown>;
  at: number;
}

describe('panel de operación: servidor de solo lectura', () => {
  let db: PgliteSqlClient;
  let panel: PanelServer;
  let base: string;
  const agent = newIdentity();

  /** `Response.json()` devuelve unknown con esta configuración de TS: se tipa aquí. */
  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(base + path);
    return (await res.json()) as T;
  }

  const tsa = fakeTsa({ genTime: () => new Date((T0 + 3 * W) * 1000) });
  const ots = fakeOts({ completeOnUpgrade: () => false });

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    const evidence = new SqlEvidenceStore(db);
    const batches = new SqlBatchStore(db);
    const witness = new SqlWitnessStore(db);

    let prev: Receipt | null = null;
    for (const at of [T0 + 60, T0 + 120, T0 + 2 * W + 60]) {
      prev = nextReceipt(prev, { policy: H, verifier: H, result: 'over_18', at });
      await evidence.receipts.append(prev);
    }
    const service = new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      identity: agent,
      policy: H,
      windowSeconds: W,
      tsa,
      ots,
      now: () => NOW,
    });
    await service.closeDueWindows(NOW);

    // Telemetría: dos relays aceptaron el último lote, uno lo rechazó por límite de tasa.
    const head = await batches.head();
    if (!head) throw new Error('sin lotes');
    await witness.publications.record({
      eventId: head.eventId,
      relay: 'wss://relay.damus.io',
      accepted: true,
      code: '',
      message: '',
      at: NOW,
    });
    await witness.publications.record({
      eventId: head.eventId,
      relay: 'wss://nos.lol',
      accepted: true,
      code: '',
      message: '',
      at: NOW,
    });
    await witness.publications.record({
      eventId: head.eventId,
      relay: 'wss://relay.primal.net',
      accepted: false,
      code: 'rate-limited',
      message: 'slow down',
      at: NOW,
    });
    await witness.alerts.raise(
      'witness_lost',
      { eventId: head.eventId, relay: 'wss://relay.damus.io' },
      NOW,
    );

    const config = loadConfig({
      PRECINTUM_NSEC: NSEC,
      PRECINTUM_DEDUP_KEY: DEDUP,
      PRECINTUM_TSA_USER: 'precintum',
      PRECINTUM_TSA_PASSWORD: 'muy-secreta',
    });
    panel = await startPanel(
      {
        evidence,
        batches,
        witness,
        config,
        identity: { npub: 'npub1ejemplo', pubkey: agent.pubkey },
        now: () => NOW,
        panelHtml: '<p>panel</p>',
      },
      0,
      '127.0.0.1',
    );
    base = `http://127.0.0.1:${panel.port}`;
  }, 60_000);

  afterAll(async () => {
    await panel.close();
    await db.close();
  });

  it('sirve el panel en la raíz, sin dejar que otra web lo lea', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    // Sin CORS: otra página abierta en el mismo navegador no puede leer estas respuestas.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(await res.text()).toBe('<p>panel</p>');
  });

  it('informa del estado: recibos, lotes, cola, relays y alertas', async () => {
    const h = await getJson<HealthReport>('/api/health');
    expect(h.receipts.total).toBe(3);
    expect(h.receipts.headSeq).toBe(3);
    expect(h.batches.total).toBe(3);
    expect(h.batches.headSeq).toBe(3);
    expect(h.batches.headWindow).toEqual([T0 + 2 * W, T0 + 3 * W]);
    expect(h.outbox.pending).toBe(3);
    expect(h.relays).toHaveLength(4);
    expect(h.relays.filter((r) => r.accepted === true)).toHaveLength(2);
    expect(h.relays.find((r) => r.accepted === false)?.code).toBe('rate-limited');
    expect(h.alerts.kinds.witness_lost).toBe(1);
    // Los .ots quedaron pendientes a propósito: el panel tiene que verlo.
    expect(h.batches.otsPending).toBe(3);
    expect(h.batches.withoutTsa).toBe(0);
  });

  it('cuenta las ventanas terminadas que siguen sin cerrar', async () => {
    // NOW está 30 s dentro de la ventana siguiente a la última cerrada: nada por cerrar todavía.
    const h = await getJson<HealthReport>('/api/health');
    expect(h.batches.windowsBehind).toBe(0);
  });

  it('lista los últimos lotes sin revelar la sal del recuento', async () => {
    const list = await getJson<BatchRow[]>('/api/batches');
    expect(list).toHaveLength(3);
    expect(list[0]?.seq).toBe(3); // más reciente primero
    expect(list[0]).toHaveProperty('root');
    expect(list[0]).not.toHaveProperty('countSalt');
    expect(JSON.stringify(list)).not.toContain('countSalt');
  });

  it('lista las alertas', async () => {
    const list = await getJson<AlertRow[]>('/api/alerts');
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('witness_lost');
  });

  it('muestra la configuración SIN ningún secreto', async () => {
    const res = await fetch(`${base}/api/config`);
    const body = await res.text();
    const cfg = JSON.parse(body) as Record<string, unknown>;
    expect(cfg.witnessQuorum).toBe(2);
    expect(cfg.batchWindowSeconds).toBe(3_600);
    expect(cfg.tsaAuth).toBe('configurada');
    expect(cfg.dedupKey).toBe('fija');
    // Lo que nunca puede salir de aquí:
    expect(body).not.toContain(NSEC);
    expect(body).not.toContain(DEDUP);
    expect(body).not.toContain('muy-secreta');
    expect(body).not.toContain('nsec1');
  });

  it('tapa la contraseña de una URL de base de datos', async () => {
    const cfg = loadConfig({
      PRECINTUM_NSEC: NSEC,
      PRECINTUM_DATABASE_URL: 'postgres://acta:clave-de-la-bd@localhost:5432/precintum',
    });
    const one = await startPanel(
      {
        evidence: new SqlEvidenceStore(db),
        batches: new SqlBatchStore(db),
        witness: new SqlWitnessStore(db),
        config: cfg,
        identity: { npub: 'npub1x', pubkey: agent.pubkey },
        panelHtml: '',
      },
      0,
      '127.0.0.1',
    );
    try {
      const body = await (await fetch(`http://127.0.0.1:${one.port}/api/config`)).text();
      expect(body).not.toContain('clave-de-la-bd');
      expect(body).toContain('***');
    } finally {
      await one.close();
    }
  });

  it('oculta credenciales de URL en configuración, salud, alertas y métricas sin cambiar los stores', async () => {
    // Todos los valores de este caso son credenciales sintéticas, nunca operativas.
    const relay =
      "wss://qa-relay-user:qa-relay-password@relay.example/path?token=qa-relay-token'qa-token-tail#qa-relay-fragment";
    const tsa = 'https://qa-tsa-user:qa-tsa-password@tsa.example/tsr?key=qa-tsa-token';
    const calendar = 'https://calendar.example/ots?access_token=qa-calendar-token';
    const database =
      'postgres://qa-db-user:qa-db-password@localhost/precintum?password=qa-query-password&sslmode=require';
    const cfg = loadConfig({
      PRECINTUM_DATABASE_URL: database,
      PRECINTUM_RELAYS: relay,
      PRECINTUM_WITNESS_QUORUM: '1',
      PRECINTUM_TSA_URL: tsa,
    });
    // Simula una configuración heredada: la carga nueva rechaza credenciales en calendarios OTS.
    cfg.PRECINTUM_OTS_CALENDARS = [calendar];
    const witness = new SqlWitnessStore(db);
    const alert = {
      id: 1,
      kind: 'publish_failed',
      detail: { outcomes: [{ relay, message: `connection failed: ${relay}` }], tsa, calendar },
      at: NOW,
    };
    witness.alerts.list = async () => [alert];
    witness.publications.forEvent = async (eventId) => [
      { eventId, relay, accepted: false, code: 'error', message: '', at: NOW },
    ];
    const one = await startPanel(
      {
        evidence: new SqlEvidenceStore(db),
        batches: new SqlBatchStore(db),
        witness,
        config: cfg,
        identity: { npub: 'npub1x', pubkey: agent.pubkey },
        now: () => NOW,
        panelHtml: '',
      },
      0,
      '127.0.0.1',
    );
    try {
      for (const path of [
        '/api/config',
        '/api/health',
        '/api/alerts',
        '/api/batches',
        '/metrics',
      ]) {
        const res = await fetch(`http://127.0.0.1:${one.port}${path}`);
        expect(res.status).toBe(200);
        const body = await res.text();
        if (path === '/api/config') {
          expect(JSON.parse(body)).toMatchObject({
            database: expect.stringContaining('qa-db-user:***@localhost/precintum?'),
            relays: [expect.stringContaining('relay.example/path?token=')],
            tsaUrl: expect.stringContaining('tsa.example/tsr?key='),
            otsCalendars: [expect.stringContaining('calendar.example/ots?access_token=')],
          });
          expect(body).toContain('sslmode=require');
        } else if (path === '/api/health') {
          expect(JSON.parse(body)).toMatchObject({
            receipts: { total: 3 },
            relays: [
              { url: expect.stringContaining('relay.example/path?token='), accepted: false },
            ],
          });
        } else if (path === '/api/alerts') {
          expect(JSON.parse(body)).toMatchObject([
            {
              kind: 'publish_failed',
              detail: {
                outcomes: [
                  {
                    relay: expect.stringContaining('relay.example/path?token='),
                    message: expect.stringContaining('connection failed: wss://'),
                  },
                ],
              },
            },
          ]);
        } else if (path === '/api/batches') {
          expect(JSON.parse(body)).toHaveLength(3);
          expect(JSON.parse(body)[0]).toMatchObject({ seq: 3, hasTsa: true });
        } else {
          expect(body).toMatch(/^precintum_receipts_total 3$/m);
          expect(body).toMatch(
            /^precintum_relay_last_publication_accepted\{relay="wss:\/\/.*relay\.example\/path\?token=[^"]+"\} 0$/m,
          );
        }
        for (const secret of [
          'qa-relay-user',
          'qa-relay-password',
          'qa-relay-token',
          'qa-token-tail',
          'qa-relay-fragment',
          'qa-tsa-user',
          'qa-tsa-password',
          'qa-tsa-token',
          'qa-calendar-token',
          'qa-db-password',
          'qa-query-password',
        ])
          expect(body, `${path} must hide ${secret}`).not.toContain(secret);
      }
      expect(cfg.PRECINTUM_RELAYS).toEqual([relay]);
      expect(cfg.PRECINTUM_TSA_URL).toBe(tsa);
      expect(cfg.PRECINTUM_OTS_CALENDARS).toEqual([calendar]);
      expect(cfg.PRECINTUM_DATABASE_URL).toBe(database);
      expect((await witness.alerts.list(1))[0]).toEqual(alert);
    } finally {
      await one.close();
    }
  });

  it('expone métricas en el formato de Prometheus', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/# TYPE precintum_receipts_total counter/);
    expect(body).toMatch(/^precintum_receipts_total 3$/m);
    expect(body).toMatch(/^precintum_batches_total 3$/m);
    expect(body).toMatch(/precintum_outbox_entries\{status="pending"\} 3/);
    expect(body).toMatch(/precintum_relay_last_publication_accepted\{relay="wss:\/\/nos\.lol"\} 1/);
    expect(body).toMatch(
      /precintum_relay_last_publication_accepted\{relay="wss:\/\/relay\.primal\.net"\} 0/,
    );
    expect(body).not.toContain('nsec1');
  });

  it('rechaza cualquier escritura: es de solo lectura', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/health`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
    // Y también en la raíz, no solo en la API.
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });

  it('solo tiene rutas fijas: no sirve ficheros por ruta pedida', async () => {
    for (const path of [
      '/etc/passwd',
      '/../package.json',
      '/api',
      '/api/receipts',
      '/panel.html',
      '/.env',
    ]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(404);
    }
  });

  it('responde a HEAD sin cuerpo', async () => {
    const res = await fetch(`${base}/api/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('reconoce las direcciones de loopback y valida el puerto', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(parsePort(undefined)).toBe(8_787);
    expect(parsePort('9000')).toBe(9_000);
    expect(() => parsePort('0')).toThrow(/puerto/);
    expect(() => parsePort('70000')).toThrow(/puerto/);
    expect(() => parsePort('ocho')).toThrow(/puerto/);
  });
});
