import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  dedupKeyFor,
  type RecordVerificationDeps,
  recordVerification,
} from '../src/application/record-verification.ts';
import { verifyChain } from '../src/domain/evidence/chain.ts';
import { canonicalize } from '../src/domain/evidence/hash.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';

const POLICY = '01'.repeat(32);
const VERIFIER = '02'.repeat(32);
const DEDUP_KEY = hexToBytes('03'.repeat(32));

describe('recordVerification', () => {
  let db: PgliteSqlClient;
  let store: SqlEvidenceStore;
  let clock = 1_700_000_000;
  const deps: RecordVerificationDeps = {
    dedupKey: DEDUP_KEY,
    dedupTtlSeconds: 3_600,
    now: () => clock,
  };
  const cmd = (transactionId: string, at = clock) => ({
    transactionId,
    result: 'over_18' as const,
    policy: POLICY,
    verifier: VERIFIER,
    at,
  });

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    store = new SqlEvidenceStore(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    clock = 1_700_000_000;
    await db.query('DELETE FROM ingest_dedup');
    await db.query('DELETE FROM receipts');
  });

  it('crea un recibo por transacción y es idempotente ante reintentos', async () => {
    const a = await recordVerification(store, deps, cmd('tx-1'));
    const again = await recordVerification(store, deps, cmd('tx-1'));
    const b = await recordVerification(store, deps, cmd('tx-2'));
    expect(a).toEqual({ seq: 1, created: true, adjusted: false });
    expect(again).toEqual({ seq: 1, created: false, adjusted: false });
    expect(b).toEqual({ seq: 2, created: true, adjusted: false });
    expect(await store.receipts.count()).toBe(2);
    expect(verifyChain(await store.receipts.range(1, 2))).toMatchObject({ ok: true, length: 2 });
  });

  it('la misma transacción con otro resultado es un conflicto: no crea ni cambia nada', async () => {
    await recordVerification(store, deps, cmd('tx-1'));
    await expect(
      recordVerification(store, deps, { ...cmd('tx-1'), result: 'under_18' }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.receipts.count()).toBe(1);
    expect((await store.receipts.get(1))?.result).toBe('over_18');
  });

  it('tras el TTL la correlación desaparece y un replay produce un recibo nuevo', async () => {
    await recordVerification(store, deps, cmd('tx-1'));
    clock += 3_600; // justo al expirar
    const replay = await recordVerification(store, deps, cmd('tx-1'));
    expect(replay).toEqual({ seq: 2, created: true, adjusted: false });
  });

  it('el recibo no contiene nada derivado del identificador del verifier', async () => {
    const txId = 'presentation-7f3a-muy-identificable';
    await recordVerification(store, deps, cmd(txId));
    const receipt = await store.receipts.get(1);
    expect(receipt).not.toBeNull();
    const json = canonicalize(receipt ?? {});
    const derivados = [
      txId,
      bytesToHex(sha256(utf8ToBytes(txId))),
      dedupKeyFor(DEDUP_KEY, txId),
      bytesToHex(DEDUP_KEY),
    ];
    for (const d of derivados) expect(json).not.toContain(d);
    // Y dos verificaciones con el mismo id (tras expirar) dan nonces distintos:
    clock += 10_000;
    await recordVerification(store, deps, cmd(txId));
    const r2 = await store.receipts.get(2);
    expect(r2?.nonce).not.toBe(receipt?.nonce);
  });

  it('trunca el instante al minuto y no deja que la cadena retroceda', async () => {
    await recordVerification(store, deps, cmd('a', 1_700_000_125));
    await recordVerification(store, deps, cmd('b', 1_700_000_010)); // reloj atrasado
    const [r1, r2] = await store.receipts.range(1, 2);
    expect(r1?.ts).toBe(1_700_000_100); // minuto alineado más cercano por debajo de …125
    expect(r2?.ts).toBe(1_700_000_100); // no retrocede: se queda en el minuto de la cabeza
  });

  it('exige una clave de deduplicación de 32 bytes', async () => {
    await expect(
      recordVerification(store, { ...deps, dedupKey: new Uint8Array(16) }, cmd('x')),
    ).rejects.toThrow(/32 bytes/);
  });
});
