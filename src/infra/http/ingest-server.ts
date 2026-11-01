/**
 * Servidor de ingesta (ADR-0003): `POST /receipts` con token compartido, más `GET /health`.
 *
 * Lo que este servidor NO hace, a propósito: no describe por qué rechaza un cuerpo (el motivo
 * podría contener lo que se intentó colar), no registra el cuerpo ni el `transactionId`, no
 * acepta más de 4 KB, no tiene CORS y escucha en la interfaz local por defecto.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INGEST_MAX_BODY_BYTES, ingestVerification } from '../../application/ingest.ts';
import type { RecordVerificationDeps } from '../../application/record-verification.ts';
import type { EvidenceStore } from '../../domain/evidence/evidence-store.ts';
import type { Logger } from '../../shared/logger.ts';

export interface IngestDeps {
  evidence: EvidenceStore;
  record: RecordVerificationDeps;
  /** Token compartido con el adaptador. Obligatorio. */
  token: string;
  /** Salud del proceso que aloja la ingesta (el planificador). Sin ella, /health responde 200. */
  healthy?: () => boolean;
  log?: Logger;
}

export interface IngestServer {
  port: number;
  close(): Promise<void>;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, HEADERS);
  res.end(JSON.stringify(body));
}

/** Comparación en tiempo constante sobre hashes: la longitud del token no se filtra. */
function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = header.slice('Bearer '.length).trim();
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(given, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Lee el cuerpo hasta `limit` bytes. Si se pasa, deja de guardar y sigue drenando (así el 413 llega
 * al cliente en vez de un socket cortado); si se pasa mucho, corta la conexión.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        chunks.length = 0;
        if (size > limit * 16) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(oversized ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('close', () => resolve(null));
    req.on('error', reject);
  });
}

export async function startIngest(
  deps: IngestDeps,
  port: number,
  host = '127.0.0.1',
): Promise<IngestServer> {
  if (deps.token.length < 16)
    throw new Error('el token de ingesta debe tener al menos 16 caracteres');
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // Ni la petición ni los detalles del fallo deben salir en la respuesta o el log.
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, 500, { error: 'internal' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://ingest.local');
    } catch {
      return send(res, 400, { error: 'invalid' });
    }
    if (url.pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
      const ok = deps.healthy ? deps.healthy() : true;
      return send(res, ok ? 200 : 503, { ok });
    }
    if (url.pathname !== '/receipts') return send(res, 404, { error: 'not-found' });
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(res, 405, { error: 'method' });
    }
    if (!tokenMatches(deps.token, req.headers.authorization)) {
      deps.log?.warn({ status: 401 }, 'mensaje rechazado: token ausente o incorrecto');
      return send(res, 401, { error: 'unauthorized' });
    }
    const raw = await readBody(req, INGEST_MAX_BODY_BYTES);
    if (raw === null) {
      deps.log?.warn({ status: 413 }, 'mensaje rechazado: demasiado grande');
      res.setHeader('connection', 'close');
      return send(res, 413, { error: 'too-large' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      deps.log?.warn({ status: 400 }, 'mensaje rechazado: no es JSON');
      return send(res, 400, { error: 'invalid' });
    }
    try {
      const outcome = await ingestVerification(deps.evidence, deps.record, body);
      if (!outcome.ok) {
        // Ni el cuerpo ni el campo que sobraba: solo que se rechazó y con qué código.
        const why =
          outcome.status === 409
            ? 'misma transacción con otro resultado'
            : outcome.status === 422
              ? 'instante fuera de lo admitido'
              : 'fuera del esquema';
        deps.log?.warn({ status: outcome.status }, `mensaje rechazado: ${why}`);
        return send(res, outcome.status, {
          error: outcome.status === 409 ? 'conflict' : 'invalid',
        });
      }
      const { seq, created, adjusted } = outcome.result;
      // Solo lo que no dice nada de nadie: ni cuerpo, ni transactionId.
      deps.log?.info(
        { seq, result: outcome.verificationResult, created, adjusted },
        created ? 'verificación registrada' : 'verificación repetida (idempotente)',
      );
      return send(res, created ? 201 : 200, { seq, created, adjusted });
    } catch (err) {
      deps.log?.error({ err: err instanceof Error ? err.message : String(err) }, 'ingesta fallida');
      return send(res, 500, { error: 'internal' });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
