import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import { GENESIS, type Receipt, receiptHash } from '../src/domain/evidence/receipt.ts';
import { MIGRATIONS, migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { ChainIntegrityError, SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';

const H = 'aa'.repeat(32);
const input = (at: number) => ({ policy: H, verifier: H, result: 'over_18' as const, at });

describe('SqlEvidenceStore sobre PGlite', () => {
  let db: PgliteSqlClient;
  let store: SqlEvidenceStore;

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    const applied = await migrate(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(db)).toEqual([]); // idempotente
    store = new SqlEvidenceStore(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM ingest_dedup');
    await db.query('DELETE FROM receipts');
  });

  it('empieza vacío', async () => {
    expect(await store.receipts.head()).toBeNull();
    expect(await store.receipts.count()).toBe(0);
    expect(await store.receipts.range(1, 10)).toEqual([]);
  });

  it('encadena recibos y los devuelve idénticos (tipos numéricos incluidos)', async () => {
    const r1 = nextReceipt(null, input(1_700_000_007));
    const r2 = nextReceipt(r1, input(1_700_000_067));
    await store.receipts.append(r1);
    await store.receipts.append(r2);
    expect(await store.receipts.head()).toEqual(r2);
    expect(await store.receipts.get(1)).toEqual(r1);
    expect(await store.receipts.range(1, 2)).toEqual([r1, r2]);
    expect(await store.receipts.count()).toBe(2);
    expect(typeof (await store.receipts.head())?.seq).toBe('number');
  });

  it('rechaza un primer recibo que no apunte a GENESIS o no tenga seq 1', async () => {
    const bad: Receipt = { ...nextReceipt(null, input(1_700_000_000)), prev: H };
    await expect(store.receipts.append(bad)).rejects.toBeInstanceOf(ChainIntegrityError);
    const bad2: Receipt = { ...nextReceipt(null, input(1_700_000_000)), seq: 2 };
    await expect(store.receipts.append(bad2)).rejects.toBeInstanceOf(ChainIntegrityError);
    expect(await store.receipts.count()).toBe(0);
  });

  it('rechaza un recibo que no encaje con la cabeza (prev o seq equivocados)', async () => {
    const r1 = nextReceipt(null, input(1_700_000_000));
    await store.receipts.append(r1);
    const forged: Receipt = { ...nextReceipt(r1, input(1_700_000_060)), prev: GENESIS };
    await expect(store.receipts.append(forged)).rejects.toThrow(/no encaja con la cabeza/);
    const skipped: Receipt = { ...nextReceipt(r1, input(1_700_000_060)), seq: 3 };
    await expect(store.receipts.append(skipped)).rejects.toBeInstanceOf(ChainIntegrityError);
    expect(await store.receipts.count()).toBe(1);
  });

  it('la base de datos rechaza recibos malformados aunque el código fallase', async () => {
    await expect(
      db.query(
        `INSERT INTO receipts (seq, hash, prev, nonce, policy, verifier, result, ts)
         VALUES (1, $1, $2, $3, $4, $4, 'over_18', 61)`,
        [H, GENESIS, 'bb'.repeat(32), H],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('no admite dos recibos con el mismo nonce', async () => {
    const r1 = nextReceipt(null, input(1_700_000_000));
    await store.receipts.append(r1);
    const r2 = nextReceipt(r1, input(1_700_000_060), r1.nonce);
    await expect(store.receipts.append(r2)).rejects.toThrow(/unique|duplicate/i);
  });

  it('dedup: recuerda, respeta el TTL y purga', async () => {
    const r1 = nextReceipt(null, input(1_700_000_000));
    await store.receipts.append(r1);
    await store.dedup.remember('k1', 1, 1_000);
    expect(await store.dedup.lookup('k1', 999)).toBe(1);
    expect(await store.dedup.lookup('k1', 1_000)).toBeNull(); // caducado
    expect(await store.dedup.lookup('otra', 0)).toBeNull();
    expect(await store.dedup.purgeExpired(1_000)).toBe(1);
    expect(await store.dedup.lookup('k1', 0)).toBeNull();
  });

  it('una transacción que falla no deja nada a medias', async () => {
    const r1 = nextReceipt(null, input(1_700_000_000));
    await expect(
      store.transaction(async (tx) => {
        await tx.receipts.append(r1);
        await tx.dedup.remember('k', 1, 10);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.receipts.count()).toBe(0);
    expect(await store.dedup.lookup('k', 0)).toBeNull();
  });

  it('el hash guardado coincide con el recalculado (no se confía en la BD para el hash)', async () => {
    const r1 = nextReceipt(null, input(1_700_000_000));
    await store.receipts.append(r1);
    const rows = await db.query<{ hash: string }>('SELECT hash FROM receipts WHERE seq = 1');
    expect(rows[0]?.hash).toBe(receiptHash(r1));
  });
});
