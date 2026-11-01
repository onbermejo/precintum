import { describe, expect, it } from 'vitest';
import { nextReceipt, verifyChain } from '../src/domain/evidence/chain.ts';
import {
  GENESIS,
  type Receipt,
  type ReceiptInput,
  receiptHash,
} from '../src/domain/evidence/receipt.ts';

const H = 'aa'.repeat(32);
const input = (at: number, result: ReceiptInput['result'] = 'over_18'): ReceiptInput => ({
  policy: H,
  verifier: H,
  result,
  at,
});

function chainOf(n: number): Receipt[] {
  const out: Receipt[] = [];
  let prev: Receipt | null = null;
  for (let i = 0; i < n; i++) {
    prev = nextReceipt(prev, input(1_700_000_000 + i * 60 + 7));
    out.push(prev);
  }
  return out;
}

describe('hash-chain de recibos', () => {
  it('el primer recibo apunta a GENESIS con seq 1 y trunca el ts', () => {
    const r = nextReceipt(null, input(1_700_000_047));
    expect(r.seq).toBe(1);
    expect(r.prev).toBe(GENESIS);
    expect(r.ts).toBe(1_700_000_040); // 1_700_000_040 es múltiplo de 60; 1_700_000_000 no
  });

  it('cada recibo enlaza con el hash del anterior', () => {
    const [a, b, c] = chainOf(3) as [Receipt, Receipt, Receipt];
    expect(b.prev).toBe(receiptHash(a));
    expect(c.prev).toBe(receiptHash(b));
    expect(c.seq).toBe(3);
  });

  it('no permite que el tiempo retroceda', () => {
    const a = nextReceipt(null, input(1_700_000_120));
    expect(() => nextReceipt(a, input(1_700_000_000))).toThrow(/no retrocede/);
  });

  it('una cadena bien formada verifica y devuelve su cabeza', () => {
    const chain = chainOf(5);
    const v = verifyChain(chain);
    expect(v).toMatchObject({ ok: true, length: 5, head: receiptHash(chain[4] as Receipt) });
  });

  it('detecta un UPDATE sobre un recibo intermedio y señala su posición (WOW 1)', () => {
    const chain = chainOf(5);
    const tampered = chain.map((r) => (r.seq === 3 ? { ...r, result: 'under_18' as const } : r));
    expect(verifyChain(tampered)).toMatchObject({ ok: false, at: 3 });
  });

  it('detecta un recibo borrado (hueco) y uno duplicado', () => {
    const chain = chainOf(5);
    expect(verifyChain(chain.filter((r) => r.seq !== 3))).toMatchObject({
      ok: false,
      at: 3,
      reason: expect.stringContaining('hueco'),
    });
    const dup = [...chain.slice(0, 3), chain[2], ...chain.slice(3)];
    expect(verifyChain(dup)).toMatchObject({ ok: false, at: 4 });
  });

  it('detecta reordenación', () => {
    const chain = chainOf(4);
    const swapped = [chain[0], chain[2], chain[1], chain[3]];
    expect(verifyChain(swapped)).toMatchObject({ ok: false, at: 2 });
  });

  it('sola no detecta truncado; con la cabeza o la longitud publicadas, sí', () => {
    const chain = chainOf(5);
    const truncated = chain.slice(0, 3);
    expect(verifyChain(truncated).ok).toBe(true); // límite documentado de la hash-chain
    expect(verifyChain(truncated, { expectLength: 5 })).toMatchObject({ ok: false, at: 4 });
    expect(verifyChain(truncated, { expectHead: receiptHash(chain[4] as Receipt) })).toMatchObject({
      ok: false,
      at: 3,
    });
  });

  it('detecta la alteración del último recibo si se conoce la cabeza', () => {
    const chain = chainOf(3);
    const head = receiptHash(chain[2] as Receipt);
    const altered = [...chain.slice(0, 2), { ...(chain[2] as Receipt), result: 'error' as const }];
    expect(verifyChain(altered).ok).toBe(true); // sin cabeza externa no hay sucesor que lo delate
    expect(verifyChain(altered, { expectHead: head })).toMatchObject({ ok: false, at: 3 });
  });

  it('puede verificar un tramo a partir de un punto conocido', () => {
    const chain = chainOf(6);
    const tail = chain.slice(3);
    expect(
      verifyChain(tail, { expectFirstSeq: 4, expectPrev: receiptHash(chain[2] as Receipt) }),
    ).toMatchObject({ ok: true, length: 3 });
  });

  it('rechaza basura en la cadena', () => {
    expect(verifyChain([{ hola: 1 }])).toMatchObject({ ok: false, at: 1 });
  });
});
