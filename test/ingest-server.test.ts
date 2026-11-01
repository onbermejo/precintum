/**
 * La ingesta es el único camino por el que entran verificaciones (ADR-0003). Lo que se prueba es
 * sobre todo lo que NO hace: no admite campos de más, no los describe, no los registra y no los
 * devuelve; no atiende sin token; no lee cuerpos grandes; y aplica la política de tiempo.
 */
import { request } from 'node:http';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashLabel, ingestMessageSchema } from '../src/application/ingest.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { type IngestServer, startIngest } from '../src/infra/http/ingest-server.ts';
import { hexToBytes } from '../src/shared/hex.ts';
import { createLogger } from '../src/shared/logger.ts';

const TOKEN = 'token-de-prueba-suficientemente-largo';
const T0 = 1_700_000_400;

describe('ingesta: POST /receipts', () => {
  let db: PgliteSqlClient;
  let evidence: SqlEvidenceStore;
  let server: IngestServer;
  let base: string;
  let logged = '';
  let clock = T0;
  let healthy = true;
  let healthError: Error | null = null;

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    evidence = new SqlEvidenceStore(db);
    const sink = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      },
    });
    server = await startIngest(
      {
        evidence,
        record: {
          dedupKey: hexToBytes('05'.repeat(32)),
          dedupTtlSeconds: 3_600,
          now: () => clock,
          maxFutureSkewSeconds: 300,
        },
        token: TOKEN,
        healthy: () => {
          if (healthError) throw healthError;
          return healthy;
        },
        log: createLogger({ level: 'info', destination: sink }),
      },
      0,
      '127.0.0.1',
    );
    base = `http://127.0.0.1:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    await server.close();
    await db.close();
  });

  beforeEach(async () => {
    logged = '';
    clock = T0;
    healthy = true;
    healthError = null;
    await db.query('DELETE FROM ingest_dedup');
    await db.query('DELETE FROM receipts');
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('registra una verificación y es idempotente por transactionId', async () => {
    const a = await post({ transactionId: 'tx-1', result: 'over_18' });
    expect(a.status).toBe(201);
    expect(await a.json()).toEqual({ seq: 1, created: true, adjusted: false });
    const again = await post({ transactionId: 'tx-1', result: 'over_18' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ seq: 1, created: false, adjusted: false });
    const r = await evidence.receipts.get(1);
    expect(r?.result).toBe('over_18');
    expect(r?.policy).toBe(hashLabel('age_over_18/v1'));
    expect(r?.ts).toBe(T0);
  });

  it('nada del cuerpo que no sea el mensaje sobrevive: ni en el recibo, ni en la respuesta, ni en el log', async () => {
    const pii = {
      transactionId: 'tx-2',
      result: 'over_18',
      given_name: 'Nora',
      birth_date: '2004-05-06',
      vp_token: 'eyJhbGciOi...',
      session: 'sess-7f3a',
      ip: '203.0.113.9',
    };
    const res = await post(pii);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'invalid' }));
    // Se rechazó: no hay recibo.
    expect(await evidence.receipts.count()).toBe(0);
    // Y ninguno de los valores aparece en lo que el servidor escribió.
    for (const leak of ['Nora', '2004-05-06', 'eyJhbGciOi', 'sess-7f3a', '203.0.113.9', 'tx-2']) {
      expect(logged).not.toContain(leak);
    }
    // Queda constancia de que se rechazó (con el código), sin nada del mensaje.
    expect(logged).toContain('mensaje rechazado');
  });

  it('el log de una ingesta correcta solo lleva seq, resultado y flags; nunca el transactionId', async () => {
    await post({ transactionId: 'presentation-muy-identificable', result: 'under_18' });
    expect(logged).toContain('"seq":1');
    expect(logged).toContain('"result":"under_18"');
    expect(logged).not.toContain('presentation-muy-identificable');
  });

  it('sin token, con token erróneo o con otro método, no atiende', async () => {
    const noAuth = await fetch(`${base}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactionId: 'x', result: 'over_18' }),
    });
    expect(noAuth.status).toBe(401);
    const wrong = await post(
      { transactionId: 'x', result: 'over_18' },
      { authorization: 'Bearer otro' },
    );
    expect(wrong.status).toBe(401);
    const get = await fetch(`${base}/receipts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const other = await fetch(`${base}/otra`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(other.status).toBe(404);
    expect(await evidence.receipts.count()).toBe(0);
  });

  it('rechaza JSON inválido, resultados fuera del enumerado, cuerpos grandes e instantes futuros', async () => {
    expect((await post('{no es json')).status).toBe(400);
    expect((await post({ transactionId: 'x', result: 'adult' })).status).toBe(400);
    expect((await post({ transactionId: 'x'.repeat(5_000), result: 'over_18' })).status).toBe(413);
    const future = await post({ transactionId: 'f', result: 'over_18', at: T0 + 10_000 });
    expect(future.status).toBe(422);
    expect(await evidence.receipts.count()).toBe(0);
  });

  it('la misma transacción con otro resultado responde 409, gana la primera y el log no dice cuál', async () => {
    expect((await post({ transactionId: 'tx-1', result: 'over_18' })).status).toBe(201);
    const c = await post({ transactionId: 'tx-1', result: 'under_18' });
    expect(c.status).toBe(409);
    expect(await c.json()).toEqual({ error: 'conflict' });
    expect((await evidence.receipts.get(1))?.result).toBe('over_18');
    expect(await evidence.receipts.count()).toBe(1);
    expect(logged).toContain('misma transacción con otro resultado');
    expect(logged).not.toContain('tx-1');
  });

  it('las etiquetas policy y verifier solo admiten formato de versión o hash: un nombre o un correo no', async () => {
    for (const verifier of ['Nora García', 'nora@example.org', 'x'.repeat(65)]) {
      expect((await post({ transactionId: 'tx-v', result: 'error', verifier })).status).toBe(400);
    }
    expect(
      (await post({ transactionId: 'tx-p', result: 'error', policy: 'age over 18' })).status,
    ).toBe(400);
    expect(await evidence.receipts.count()).toBe(0);
    expect(logged).not.toContain('Nora');
    const ok = await post({
      transactionId: 'tx-ok',
      result: 'error',
      verifier: 'av-srv-verifier-endpoint/0.11.0',
      policy: 'ab'.repeat(32),
    });
    expect(ok.status).toBe(201);
  });

  it('/health refleja la salud del planificador', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    healthy = false;
    expect((await fetch(`${base}/health`)).status).toBe(503);
  });

  it('una URL inválida sin token se rechaza sin filtrar la ruta ni detener el servidor', async () => {
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: server.port, method: 'GET', path: '//[' },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
          },
        );
        req.setTimeout(2_000, () => req.destroy(new Error('la petición no recibió respuesta')));
        req.on('error', reject);
        req.end();
      },
    );
    expect(response.status).toBe(400);
    expect(response.body).toBe(JSON.stringify({ error: 'invalid' }));
    expect(logged).not.toContain('//[');
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('un fallo del handler devuelve un error genérico y permite recuperarse', async () => {
    healthError = new Error('health-sensitive-detail');
    const failed = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'internal' });
    expect(logged).not.toContain('health-sensitive-detail');

    healthError = null;
    const recovered = await fetch(`${base}/health`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true });
  });

  it('el esquema es cerrado: un campo de más invalida el mensaje entero', () => {
    expect(ingestMessageSchema.safeParse({ transactionId: 'a', result: 'error' }).success).toBe(
      true,
    );
    expect(
      ingestMessageSchema.safeParse({ transactionId: 'a', result: 'error', name: 'x' }).success,
    ).toBe(false);
    expect(hashLabel('ab'.repeat(32))).toBe('ab'.repeat(32));
    expect(hashLabel('age_over_18/v1')).toMatch(/^[0-9a-f]{64}$/);
  });
});
