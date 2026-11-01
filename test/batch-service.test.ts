import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import { verifyReceiptProof } from '../src/domain/evidence/batch.ts';
import { commitCount, parseBatchEvent } from '../src/domain/evidence/batch-event.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import { EMPTY_ROOT } from '../src/domain/evidence/merkle.ts';
import { GENESIS, type Receipt } from '../src/domain/evidence/receipt.ts';
import type { NostrEvent } from '../src/domain/nostr/event.ts';
import { verifyEvent } from '../src/domain/nostr/event.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { fakeOts, fakeTsa } from './support/fake-anchors.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const W = 600; // ventana de 10 minutos para el test
const T0 = 1_700_000_400; // múltiplo de 600

describe('BatchService: cierre de ventanas y anclaje', () => {
  let db: PgliteSqlClient;
  let evidence: SqlEvidenceStore;
  let batches: SqlBatchStore;
  const agent = newIdentity();
  let enqueued: NostrEvent[] = [];
  let tsaCalls = 0;
  let tsaFails = false;
  let otsUpgradeComplete = false;

  const tsa = fakeTsa({
    genTime: () => new Date((T0 + 5 * W + 30) * 1000),
    before: () => {
      tsaCalls++;
      if (tsaFails) throw new Error('TSA caída');
    },
  });
  const ots = fakeOts({ completeOnUpgrade: () => otsUpgradeComplete });

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    evidence = new SqlEvidenceStore(db);
    batches = new SqlBatchStore(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    enqueued = [];
    tsaCalls = 0;
    tsaFails = false;
    otsUpgradeComplete = false;
    await db.query('DELETE FROM batches');
    await db.query('DELETE FROM ingest_dedup');
    await db.query('DELETE FROM receipts');
  });

  async function seedReceipts(times: number[]): Promise<Receipt[]> {
    const out: Receipt[] = [];
    let prev: Receipt | null = null;
    for (const at of times) {
      prev = nextReceipt(prev, { policy: H, verifier: H, result: 'over_18', at });
      await evidence.receipts.append(prev);
      out.push(prev);
    }
    return out;
  }

  function service(now: number) {
    return new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      afterCommit: async (e) => {
        enqueued.push(e);
      },
      identity: agent,
      policy: H,
      windowSeconds: W,
      tsa,
      ots,
      now: () => now,
    });
  }

  it('cierra todas las ventanas terminadas, incluidas las vacías, encadenadas y en orden', async () => {
    // Recibos en la ventana 0 (dos), ninguna en la 1, uno en la 2. "Ahora" está en la ventana 3.
    await seedReceipts([T0 + 60, T0 + 120, T0 + 2 * W + 60]);
    const now = T0 + 3 * W + 100;
    const s = await service(now).closeDueWindows(now);
    expect(s).toMatchObject({ closed: 3, empty: 1, receipts: 3, reconciled: 0, remaining: 0 });

    const all = await batches.range(1, 3);
    expect(all.map((b) => b.count)).toEqual([2, 0, 1]);
    expect(all.map((b) => [b.windowStart, b.windowEnd])).toEqual([
      [T0, T0 + W],
      [T0 + W, T0 + 2 * W],
      [T0 + 2 * W, T0 + 3 * W],
    ]);
    expect(all[0]?.prevRoot).toBe(GENESIS);
    expect(all[1]?.prevRoot).toBe(all[0]?.root);
    expect(all[1]?.root).toBe(EMPTY_ROOT);
    expect(all[2]?.prevRoot).toBe(all[1]?.root);
    expect(all[0]).toMatchObject({ fromReceiptSeq: 1, toReceiptSeq: 2 });
    expect(all[1]).toMatchObject({ fromReceiptSeq: null, toReceiptSeq: null });
    expect(all[2]).toMatchObject({ fromReceiptSeq: 3, toReceiptSeq: 3 });

    // Cada lote tiene su evento firmado, encolado en los testigos, y parsea a los mismos datos.
    expect(enqueued).toHaveLength(3);
    for (const [i, b] of all.entries()) {
      const e = enqueued[i] as NostrEvent;
      expect(e.id).toBe(b.eventId);
      expect(verifyEvent(e)).toEqual({ ok: true });
      const parsed = parseBatchEvent(e);
      expect(parsed).toMatchObject({
        ok: true,
        data: { seq: b.seq, root: b.root, prevRoot: b.prevRoot },
      });
      if (parsed.ok) expect(parsed.data.countCommitment).toBe(commitCount(b.count, b.countSalt));
      expect(e.created_at).toBe(b.windowEnd);
    }
    // Anclajes pedidos al cerrar: TSA y OTS (pendiente).
    expect(tsaCalls).toBe(3);
    expect(all.every((b) => b.tsaToken !== null && b.ots !== null && !b.otsComplete)).toBe(true);
  });

  it('no cierra la ventana en curso y es idempotente', async () => {
    await seedReceipts([T0 + 60]);
    const svc = service(T0 + W + 10);
    expect(await svc.closeDueWindows(T0 + W + 10)).toMatchObject({ closed: 1 });
    expect(await svc.closeDueWindows(T0 + W + 20)).toMatchObject({ closed: 0 });
    expect(await batches.count()).toBe(1);
    // Al avanzar el reloj una ventana más, cierra exactamente una (vacía).
    expect(await svc.closeDueWindows(T0 + 2 * W)).toMatchObject({
      closed: 1,
      empty: 1,
      receipts: 0,
    });
  });

  it('sin recibos, arranca en la ventana anterior a la actual y luego late cada ventana', async () => {
    const now = T0 + 5 * W + 10;
    // Primer cierre: un latido para la ventana anterior (0 recibos en ella es cierto); nada más atrás.
    expect(await service(now).closeDueWindows(now)).toMatchObject({
      closed: 1,
      empty: 1,
      receipts: 0,
    });
    expect((await batches.head())?.windowStart).toBe(T0 + 4 * W);
    expect(await service(now).closeDueWindows(now)).toMatchObject({ closed: 0 });
    // Una ventana después, otro latido; la cadena sigue sin huecos.
    expect(await service(now).closeDueWindows(now + W)).toMatchObject({ closed: 1, empty: 1 });
    const head = await batches.head();
    expect(head?.seq).toBe(2);
    expect(head?.windowStart).toBe(T0 + 5 * W);
    expect(head?.prevRoot).toBe((await batches.get(1))?.root);
  });

  it('una TSA caída no impide cerrar el lote; anchorPending lo sella después y completa el OTS', async () => {
    await seedReceipts([T0 + 60]);
    tsaFails = true;
    const svc = service(T0 + W + 1);
    await svc.closeDueWindows(T0 + W + 1);
    let b = await batches.get(1);
    expect(b?.tsaToken).toBeNull();
    expect(b?.ots).not.toBeNull();

    tsaFails = false;
    expect(await svc.anchorPending()).toEqual({ tsa: 1, otsSubmitted: 0, otsCompleted: 0 });
    b = await batches.get(1);
    expect(b?.tsaToken).not.toBeNull();
    expect(b?.tsaGenTime).toBe(T0 + 5 * W + 30);
    expect(b?.otsComplete).toBe(false);

    otsUpgradeComplete = true;
    expect(await svc.anchorPending()).toEqual({ tsa: 0, otsSubmitted: 0, otsCompleted: 1 });
    b = await batches.get(1);
    expect(b?.otsComplete).toBe(true);
    expect(await batches.pendingAnchors(10)).toEqual([]);
  });

  it('proofFor devuelve una prueba de inclusión verificable, o null si el recibo no está en un lote', async () => {
    const receipts = await seedReceipts([T0 + 60, T0 + 120, T0 + 180, T0 + W + 30]);
    const svc = service(T0 + W + 1);
    await svc.closeDueWindows(T0 + W + 1); // solo la primera ventana (3 recibos)
    for (const r of receipts.slice(0, 3)) {
      const found = await svc.proofFor(r.seq);
      expect(found).not.toBeNull();
      if (!found) continue;
      expect(found.batch.seq).toBe(1);
      expect(verifyReceiptProof(found.proof, found.batch.root)).toBe(true);
    }
    expect(await svc.proofFor(4)).toBeNull(); // su ventana aún no se ha cerrado
  });

  it('rechaza ventanas menores de un minuto', () => {
    expect(
      () =>
        new BatchService({
          evidence,
          batches,
          tx: evidenceUnitOfWork(db),
          identity: agent,
          policy: H,
          windowSeconds: 30,
        }),
    ).toThrow(/60 segundos/);
  });
});
