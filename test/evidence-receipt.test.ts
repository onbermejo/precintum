import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalize, DOMAINS, hashWithDomain } from '../src/domain/evidence/hash.ts';
import {
  GENESIS,
  newNonce,
  RECEIPT_FIELDS,
  type Receipt,
  receiptHash,
  truncateToMinute,
  validateReceipt,
} from '../src/domain/evidence/receipt.ts';
import { bytesToHex } from '../src/shared/hex.ts';

const H = '11'.repeat(32);

describe('JSON canónico', () => {
  it('ordena claves, no mete espacios y omite undefined', () => {
    expect(canonicalize({ b: 1, a: 'x', c: true, d: null, e: undefined })).toBe(
      '{"a":"x","b":1,"c":true,"d":null}',
    );
  });

  it('es estable ante el orden de inserción', () => {
    expect(canonicalize({ z: 1, a: 2 })).toBe(canonicalize({ a: 2, z: 1 }));
  });

  it('escapa strings como JSON y rechaza floats', () => {
    expect(canonicalize({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n"}');
    expect(() => canonicalize({ x: 1.5 })).toThrow(/enteros seguros/);
    expect(() => canonicalize({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/enteros seguros/);
  });
});

describe('hash con dominio', () => {
  it('es sha256(dominio || 0x0a || datos)', () => {
    const data = utf8ToBytes('hola');
    const expected = bytesToHex(sha256(utf8ToBytes(`${DOMAINS.receipt}\nhola`)));
    expect(hashWithDomain(DOMAINS.receipt, data)).toBe(expected);
  });

  it('dominios distintos dan hashes distintos para los mismos datos', () => {
    const data = utf8ToBytes('x');
    expect(hashWithDomain(DOMAINS.archive, data)).not.toBe(hashWithDomain(DOMAINS.count, data));
  });

  it('GENESIS es determinista', () => {
    expect(GENESIS).toBe(hashWithDomain(DOMAINS.genesis, new Uint8Array()));
    expect(GENESIS).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('recibo', () => {
  const valid: Receipt = {
    v: 1,
    seq: 1,
    prev: GENESIS,
    nonce: '22'.repeat(32),
    policy: H,
    verifier: H,
    result: 'over_18',
    ts: 1_700_000_040,
  };

  it('tiene exactamente los ocho campos previstos, y ninguno más', () => {
    expect(RECEIPT_FIELDS).toEqual([
      'nonce',
      'policy',
      'prev',
      'result',
      'seq',
      'ts',
      'v',
      'verifier',
    ]);
    expect(validateReceipt(valid).ok).toBe(true);
    expect(validateReceipt({ ...valid, session_id: 'abc' })).toMatchObject({ ok: false });
    expect(validateReceipt({ ...valid, ip: '1.2.3.4' })).toMatchObject({ ok: false });
  });

  it('exige ts truncado al minuto', () => {
    expect(validateReceipt({ ...valid, ts: 1_700_000_041 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('minuto'),
    });
    // Ojo: 1_700_000_000 NO es múltiplo de 60 (1_700_000_000 % 60 = 20). Los minutos
    // alineados cercanos son 1_699_999_980, 1_700_000_040, 1_700_000_100…
    expect(truncateToMinute(1_700_000_059)).toBe(1_700_000_040);
    expect(truncateToMinute(1_700_000_100)).toBe(1_700_000_100);
    expect(truncateToMinute(1_700_000_099)).toBe(1_700_000_040);
  });

  it('rechaza resultados fuera del enumerado y hex mal formado', () => {
    expect(validateReceipt({ ...valid, result: 'maybe' }).ok).toBe(false);
    expect(validateReceipt({ ...valid, nonce: 'zz'.repeat(32) }).ok).toBe(false);
    expect(validateReceipt({ ...valid, seq: 0 }).ok).toBe(false);
  });

  it('el hash es determinista y sensible a cualquier campo', () => {
    const h = receiptHash(valid);
    expect(h).toBe(receiptHash({ ...valid }));
    expect(receiptHash({ ...valid, result: 'under_18' })).not.toBe(h);
    expect(receiptHash({ ...valid, ts: valid.ts + 60 })).not.toBe(h);
    expect(receiptHash({ ...valid, nonce: '33'.repeat(32) })).not.toBe(h);
  });

  it('los nonces son de 32 bytes y no se repiten', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = newNonce();
      expect(n).toMatch(/^[0-9a-f]{64}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });
});
