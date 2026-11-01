/**
 * Genera los vectores de prueba de docs/FORMATO-v1.md a partir del código real:
 *   node scripts/format-vectors.ts
 * Si un vector cambia, el formato ha cambiado: hay que subir la versión del formato, no el doc.
 * La identidad es la clave de pruebas de la suite (pública en test/cli.test.ts); la firma Schnorr
 * lleva aleatoriedad auxiliar y varía en cada ejecución, el id del evento no.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { buildBatchEvent, commitCount } from '../src/domain/evidence/batch-event.ts';
import { canonicalize, DOMAINS, hashWithDomain } from '../src/domain/evidence/hash.ts';
import { buildKeyDirectoryEvent } from '../src/domain/evidence/key-directory.ts';
import { EMPTY_ROOT, inclusionProof, merkleRoot } from '../src/domain/evidence/merkle.ts';
import { GENESIS, type Receipt, receiptHash } from '../src/domain/evidence/receipt.ts';
import { identityFromSecretKey, nsecDecode } from '../src/domain/identity/keys.ts';
import { bytesToHex } from '../src/shared/hex.ts';

const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
const agent = identityFromSecretKey(nsecDecode(NSEC));

const POLICY = bytesToHex(sha256(utf8ToBytes('age_over_18/v1')));
const VERIFIER = bytesToHex(sha256(utf8ToBytes('av-srv-verifier-endpoint/0.11.0')));
const WINDOW = { start: 1_699_999_200, end: 1_700_002_800 }; // 3600 s, alineada

const r1: Receipt = {
  v: 1,
  seq: 1,
  prev: GENESIS,
  nonce: '11'.repeat(32),
  policy: POLICY,
  verifier: VERIFIER,
  result: 'over_18',
  ts: 1_700_000_040,
};
const r2: Receipt = {
  ...r1,
  seq: 2,
  prev: receiptHash(r1),
  nonce: '22'.repeat(32),
  result: 'under_18',
  ts: 1_700_000_100,
};
const r3: Receipt = {
  ...r1,
  seq: 3,
  prev: receiptHash(r2),
  nonce: '33'.repeat(32),
  result: 'error',
  ts: 1_700_000_160,
};
const leaves = [r1, r2, r3].map(receiptHash);
const SALT = '44'.repeat(32);
const root3 = merkleRoot(leaves);

const event = buildBatchEvent(
  {
    seq: 1,
    root: root3,
    prevRoot: GENESIS,
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    policy: POLICY,
    countCommitment: commitCount(3, SALT),
  },
  agent,
);
const directory = buildKeyDirectoryEvent(
  { v: 1, keys: [{ pubkey: agent.pubkey, from: WINDOW.start, to: null }] },
  agent,
  WINDOW.start,
);
const archiveLine = { seq: 1, prev: GENESIS, event_id: event.id, pubkey: event.pubkey };

const out = {
  identity: { nsec: NSEC, pubkey: agent.pubkey },
  domains: DOMAINS,
  genesis: GENESIS,
  emptyRoot: EMPTY_ROOT,
  policy: { label: 'age_over_18/v1', hash: POLICY },
  verifier: { label: 'av-srv-verifier-endpoint/0.11.0', hash: VERIFIER },
  receipts: [r1, r2, r3].map((r) => ({ canonical: canonicalize(r), hash: receiptHash(r) })),
  merkle: {
    root1: merkleRoot([leaves[0] as string]),
    root2: merkleRoot(leaves.slice(0, 2)),
    root3,
    proofOfSecond: inclusionProof(leaves, 1),
  },
  count: { count: 3, salt: SALT, commitment: commitCount(3, SALT) },
  batchEvent: {
    id: event.id,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  },
  keyDirectory: {
    id: directory.id,
    kind: directory.kind,
    tags: directory.tags,
    content: directory.content,
  },
  archiveLine: {
    canonical: canonicalize(archiveLine),
    hash: hashWithDomain(DOMAINS.archive, utf8ToBytes(canonicalize(archiveLine))),
  },
};
console.log(JSON.stringify(out, null, 2));
