/**
 * Un recibo cuyo instante declarado cae en
 * una ventana ya cerrada no puede quedar fuera de todo lote. La ingesta lo registra en la ventana
 * abierta; el export sigue verificando; y el cierre de lote y la ingesta comparten transacción y
 * lock. También: periodo de gracia, reconciliación de la outbox y rechazo de instantes futuros.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import { ExportService, verifyPackage } from '../src/application/export-service.ts';
import { recordVerification } from '../src/application/record-verification.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { SqlWitnessStore } from '../src/infra/db/sql-witness-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { hexToBytes } from '../src/shared/hex.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const W = 600;
const T0 = 1_700_000_400;
const DEDUP = hexToBytes('03'.repeat(32));

describe('recibo tardío, gracia y atomicidad del cierre', () => {
  let db: PgliteSqlClient;
  let evidence: SqlEvidenceStore;
  let batches: SqlBatchStore;
  let witness: SqlWitnessStore;
  const agent = newIdentity();

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    evidence = new SqlEvidenceStore(db);
    batches = new SqlBatchStore(db);
    witness = new SqlWitnessStore(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM witness_outbox');
    await db.query('DELETE FROM batches');
    await db.query('DELETE FROM ingest_dedup');
    await db.query('DELETE FROM receipts');
  });

  const service = (now: number, grace = 0) =>
    new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      identity: agent,
      policy: H,
      windowSeconds: W,
      graceSeconds: grace,
      now: () => now,
    });

  const record = (transactionId: string, at: number, now: number) =>
    recordVerification(
      evidence,
      { dedupKey: DEDUP, dedupTtlSeconds: 3_600, now: () => now },
      { transactionId, result: 'over_18', policy: H, verifier: H, at },
    );

  it('un recibo con `at` dentro de una ventana ya cerrada se registra en la ventana abierta', async () => {
    // Ventana 0 con un recibo; se cierra cuando ya estamos en la ventana 1.
    await record('tx-1', T0 + 60, T0 + 61);
    const now = T0 + W + 5;
    await service(now).closeDueWindows(now);
    expect(await evidence.closedUntil()).toBe(T0 + W);

    // Llega tarde (latencia del adaptador): declara T0 + 540, dentro de la ventana cerrada.
    const late = await record('tx-2', T0 + 540, now);
    expect(late).toMatchObject({ seq: 2, created: true, adjusted: true });
    const r2 = await evidence.receipts.get(2);
    expect(r2?.ts).toBe(T0 + W); // primer minuto de la ventana abierta

    // El lote 1 sigue cuadrando: su compromiso dice 1 recibo y hay 1 recibo en su ventana.
    expect(await evidence.receipts.inWindow(T0, T0 + W)).toHaveLength(1);
    // Al cerrar la ventana 1 el recibo tardío entra en el lote 2 y el paquete verifica.
    const later = T0 + 2 * W + 5;
    await service(later).closeDueWindows(later);
    const pkg = await new ExportService({ evidence, batches, windowSeconds: W }).exportRange(
      T0,
      T0 + 2 * W,
    );
    expect(pkg.batches.map((b) => b.count)).toEqual([1, 1]);
    expect(verifyPackage(pkg).ok).toBe(true);
  });

  it('un instante muy por delante del reloj del agente se rechaza', async () => {
    await expect(record('tx-f', T0 + 10_000, T0)).rejects.toThrow(/por delante del reloj/);
    // Dentro de la tolerancia se admite tal cual.
    const ok = await record('tx-g', T0 + 120, T0);
    expect(ok).toMatchObject({ created: true, adjusted: false });
  });

  it('el periodo de gracia retrasa el cierre y da tiempo al recibo tardío', async () => {
    await record('tx-1', T0 + 60, T0 + 61);
    const justAfter = T0 + W + 30;
    // Con 120 s de gracia, 30 s después del fin de la ventana aún no se cierra…
    expect(await service(justAfter, 120).closeDueWindows(justAfter)).toMatchObject({ closed: 0 });
    // …así que un recibo tardío de esa ventana entra en ella sin ajuste.
    const late = await record('tx-2', T0 + 570, justAfter);
    expect(late).toMatchObject({ adjusted: false });
    expect((await evidence.receipts.get(2))?.ts).toBe(T0 + 540);
    // Pasada la gracia, la ventana se cierra con los dos recibos.
    const afterGrace = T0 + W + 121;
    expect(await service(afterGrace, 120).closeDueWindows(afterGrace)).toMatchObject({
      closed: 1,
      receipts: 2,
    });
  });

  it('cerrar un lote y encolarlo en la outbox es una sola transacción', async () => {
    await record('tx-1', T0 + 60, T0 + 61);
    const now = T0 + W + 5;
    const s = await service(now).closeDueWindows(now);
    expect(s).toMatchObject({ closed: 1, reconciled: 0 });
    const head = await batches.head();
    const entry = await witness.outbox.get(head?.eventId ?? '');
    expect(entry?.status).toBe('pending');
    expect(await batches.notEnqueued(10)).toHaveLength(0);
  });

  it('un lote sin entrada en la outbox se reconcilia en el siguiente pase', async () => {
    await record('tx-1', T0 + 60, T0 + 61);
    const now = T0 + W + 5;
    await service(now).closeDueWindows(now);
    // Simula el fallo antiguo: el lote existe, pero su evento no está en la outbox.
    await db.query('DELETE FROM witness_outbox');
    expect(await batches.notEnqueued(10)).toHaveLength(1);
    const s = await service(now + 1).closeDueWindows(now + 1);
    expect(s).toMatchObject({ closed: 0, reconciled: 1 });
    expect(await batches.notEnqueued(10)).toHaveLength(0);
  });

  it('el tope de ventanas por pase deja el resto para el siguiente', async () => {
    await record('tx-1', T0 + 60, T0 + 61);
    const now = T0 + 10 * W + 5; // diez ventanas terminadas
    const svc = new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      identity: agent,
      policy: H,
      windowSeconds: W,
      maxWindowsPerPass: 4,
      now: () => now,
    });
    expect(await svc.closeDueWindows(now)).toMatchObject({ closed: 4, remaining: 6 });
    expect(await svc.closeDueWindows(now)).toMatchObject({ closed: 4, remaining: 2 });
    expect(await svc.closeDueWindows(now)).toMatchObject({ closed: 2, remaining: 0 });
  });

  it('la purga de la tabla de deduplicación se ejecuta en cada cierre', async () => {
    await record('tx-1', T0 + 60, T0 + 61); // caduca a T0 + 61 + 3600
    expect(
      (await db.query<{ n: number }>('SELECT count(*)::float8 AS n FROM ingest_dedup'))[0]?.n,
    ).toBe(1);
    const now = T0 + 61 + 3_600 + 1;
    await service(now).closeDueWindows(now);
    expect(
      (await db.query<{ n: number }>('SELECT count(*)::float8 AS n FROM ingest_dedup'))[0]?.n,
    ).toBe(0);
  });
});
