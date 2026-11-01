/**
 * Fija los vectores de docs/FORMATO-v1.md. Si uno de estos tests falla, el formato ha cambiado:
 * hay que publicar un v2 (dominios nuevos), no ajustar el vector.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { buildBatchEvent, commitCount } from '../src/domain/evidence/batch-event.ts';
import { canonicalize, DOMAINS, hashWithDomain } from '../src/domain/evidence/hash.ts';
import { buildKeyDirectoryEvent } from '../src/domain/evidence/key-directory.ts';
import {
  EMPTY_ROOT,
  inclusionProof,
  merkleRoot,
  verifyInclusion,
} from '../src/domain/evidence/merkle.ts';
import { GENESIS, type Receipt, receiptHash } from '../src/domain/evidence/receipt.ts';
import { identityFromSecretKey, nsecDecode } from '../src/domain/identity/keys.ts';
import { bytesToHex } from '../src/shared/hex.ts';

const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
const agent = identityFromSecretKey(nsecDecode(NSEC));
const POLICY = bytesToHex(sha256(utf8ToBytes('age_over_18/v1')));
const VERIFIER = bytesToHex(sha256(utf8ToBytes('av-srv-verifier-endpoint/0.11.0')));
const WINDOW = { start: 1_699_999_200, end: 1_700_002_800 };

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

describe('vectores del formato v1 (docs/FORMATO-v1.md)', () => {
  it('constantes: dominios, GENESIS, raíz vacía, identidad de pruebas', () => {
    expect(DOMAINS).toEqual({
      receipt: 'precintum/receipt/v1',
      genesis: 'precintum/genesis/v1',
      count: 'precintum/count/v1',
      archive: 'precintum/archive/v1',
      batch: 'precintum/batch/v1',
    });
    expect(GENESIS).toBe('7e6c350b2f5acef23c91fad3a671761d6ac9d4f23e22a4a58b140140ddcd61fd');
    expect(EMPTY_ROOT).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(agent.pubkey).toBe('147b42e0d67759fa91c6f831e9cde86e8d2e5135af77c18d3413a404bd1f6b03');
    expect(POLICY).toBe('1027bd716c3cca38b1eaad5bae0246e06cba9f82d350ef92f58e2ac9e9fb324f');
    expect(VERIFIER).toBe('cb18e2135d836b6231cc7f33d833faa46f3e3f5537da0997ad5219649e38b372');
  });

  it('recibos: JSON canónico y hashes encadenados', () => {
    expect(canonicalize(r1)).toBe(
      '{"nonce":"1111111111111111111111111111111111111111111111111111111111111111","policy":"1027bd716c3cca38b1eaad5bae0246e06cba9f82d350ef92f58e2ac9e9fb324f","prev":"7e6c350b2f5acef23c91fad3a671761d6ac9d4f23e22a4a58b140140ddcd61fd","result":"over_18","seq":1,"ts":1700000040,"v":1,"verifier":"cb18e2135d836b6231cc7f33d833faa46f3e3f5537da0997ad5219649e38b372"}',
    );
    expect(leaves).toEqual([
      '368e28f36234a7a1e91091d7ba6317e722c5ebce95b17366eb0866106aa97f70',
      'ee86f7f9e8c690decafcb083484e8501a5906d5922e7b2e9a61319e7c0e0a21c',
      'ece53f79344102646850d62916f867c96785ed1a326bd75acbf6cb775be461ac',
    ]);
  });

  it('árbol de Merkle RFC 6962: raíces y prueba de inclusión', () => {
    expect(merkleRoot([leaves[0] as string])).toBe(
      '6f2ef8077e09a3f0e559720e1a5048938e43b4574c6ab4993ac7fc3db5509c76',
    );
    expect(merkleRoot(leaves.slice(0, 2))).toBe(
      'b2dfda4127866d3776343f73bdf411a1b6ab8baf53ed06b5c6a8049b26af6028',
    );
    const root3 = '32399b79a2d3e559b39f8a4749f0a61441645684caf025f6e38da5a28ed88564';
    expect(merkleRoot(leaves)).toBe(root3);
    const proof = inclusionProof(leaves, 1);
    expect(proof).toEqual({
      index: 1,
      size: 3,
      path: [
        '6f2ef8077e09a3f0e559720e1a5048938e43b4574c6ab4993ac7fc3db5509c76',
        '34ab7147b915657cb550544abe586bb59d8bfa3dc72080db0c7b90bd0934801b',
      ],
    });
    expect(verifyInclusion(leaves[1] as string, proof, root3)).toBe(true);
  });

  it('compromiso del recuento', () => {
    expect(commitCount(3, '44'.repeat(32))).toBe(
      '91962088d23594e5f2021ee3620302ba04d3f9f89e167483ba17e0d7a474808d',
    );
  });

  it('evento de lote kind 7676: etiquetas, content e id', () => {
    const event = buildBatchEvent(
      {
        seq: 1,
        root: merkleRoot(leaves),
        prevRoot: GENESIS,
        windowStart: WINDOW.start,
        windowEnd: WINDOW.end,
        policy: POLICY,
        countCommitment: commitCount(3, '44'.repeat(32)),
      },
      agent,
    );
    expect(event.kind).toBe(7676);
    expect(event.created_at).toBe(WINDOW.end);
    expect(event.tags).toEqual([
      ['v', '1'],
      ['seq', '1'],
      ['prev', GENESIS],
      ['window', '1699999200', '1700002800'],
      ['policy', POLICY],
      ['count', '91962088d23594e5f2021ee3620302ba04d3f9f89e167483ba17e0d7a474808d'],
    ]);
    expect(event.content).toBe('32399b79a2d3e559b39f8a4749f0a61441645684caf025f6e38da5a28ed88564');
    expect(event.id).toBe('fb0bb11ad4617bd6ea2bf3484b2285f449b5288c5d0bc1d514c2914c8999cf0f');

    const line = { seq: 1, prev: GENESIS, event_id: event.id, pubkey: event.pubkey };
    expect(hashWithDomain(DOMAINS.archive, utf8ToBytes(canonicalize(line)))).toBe(
      '4e5acac128a6750b1a2d7c2d87d644afbd5e7aebcf0c3cc99e4a29bddba6b6d0',
    );
  });

  it('directorio de claves kind 37676: content con orden fijo e id', () => {
    const directory = buildKeyDirectoryEvent(
      { v: 1, keys: [{ pubkey: agent.pubkey, from: WINDOW.start, to: null }] },
      agent,
      WINDOW.start,
    );
    expect(directory.kind).toBe(37676);
    expect(directory.tags).toEqual([['d', 'precintum/keys']]);
    expect(directory.content).toBe(
      '{"v":1,"keys":[{"pubkey":"147b42e0d67759fa91c6f831e9cde86e8d2e5135af77c18d3413a404bd1f6b03","from":1699999200,"to":null}]}',
    );
    expect(directory.id).toBe('1b2eb99c2c4321a6f55e841875a95d20b058e3678373c390747f6c8e19daf145');
  });
});
