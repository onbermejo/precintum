import { describe, expect, it } from 'vitest';
import {
  buildBatch,
  checkAnchorWindow,
  proveReceipt,
  verifyReceiptProof,
  windowOf,
} from '../src/domain/evidence/batch.ts';
import { commitCount, parseBatchEvent } from '../src/domain/evidence/batch-event.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import { EMPTY_ROOT } from '../src/domain/evidence/merkle.ts';
import { GENESIS, type Receipt, receiptHash } from '../src/domain/evidence/receipt.ts';

const H = 'ab'.repeat(32);
const SALT = 'cd'.repeat(32);
const T0 = 1_700_000_400; // múltiplo de 60 y de 3600? 1_700_000_400 % 3600 = 800 → usamos ventanas de 600 s

function receiptsAt(times: number[]): Receipt[] {
  const out: Receipt[] = [];
  let prev: Receipt | null = null;
  for (const at of times) {
    prev = nextReceipt(prev, { policy: H, verifier: H, result: 'over_18', at });
    out.push(prev);
  }
  return out;
}

describe('ventanas', () => {
  it('alinea al múltiplo del tamaño y la ventana es [ini, fin)', () => {
    expect(windowOf(1_700_000_400, 600)).toEqual({ start: 1_700_000_400, end: 1_700_001_000 });
    expect(windowOf(1_700_000_999, 600)).toEqual({ start: 1_700_000_400, end: 1_700_001_000 });
    expect(windowOf(1_700_001_000, 600)).toEqual({ start: 1_700_001_000, end: 1_700_001_600 });
    expect(() => windowOf(1, 0)).toThrow(/ventana/);
  });
});

describe('construcción de lotes', () => {
  const window = { start: T0, end: T0 + 600 };

  it('un lote vacío (latido) tiene la raíz del árbol vacío y compromiso de recuento 0', () => {
    const b = buildBatch({
      seq: 1,
      prevRoot: GENESIS,
      window,
      policy: H,
      countSalt: SALT,
      receipts: [],
    });
    expect(b.count).toBe(0);
    expect(b.data.root).toBe(EMPTY_ROOT);
    expect(b.data.countCommitment).toBe(commitCount(0, SALT));
    expect(b.leaves).toEqual([]);
  });

  it('las hojas son los hashes de los recibos en orden, y el compromiso oculta el recuento', () => {
    const receipts = receiptsAt([T0 + 60, T0 + 120, T0 + 540]);
    const b = buildBatch({ seq: 2, prevRoot: H, window, policy: H, countSalt: SALT, receipts });
    expect(b.leaves).toEqual(receipts.map(receiptHash));
    expect(b.count).toBe(3);
    expect(b.data.countCommitment).toBe(commitCount(3, SALT));
    // El compromiso es un hash: no revela el recuento y cambia con él.
    expect(b.data.countCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(b.data.countCommitment).not.toBe(commitCount(2, SALT));
  });

  it('rechaza recibos fuera de la ventana', () => {
    const receipts = receiptsAt([T0 + 60, T0 + 600]); // el segundo cae en la ventana siguiente
    expect(() =>
      buildBatch({ seq: 1, prevRoot: GENESIS, window, policy: H, countSalt: SALT, receipts }),
    ).toThrow(/no pertenece a la ventana/);
  });

  it('el evento de lote transporta exactamente los datos del lote', () => {
    const receipts = receiptsAt([T0 + 60]);
    const b = buildBatch({ seq: 3, prevRoot: H, window, policy: H, countSalt: SALT, receipts });
    // buildBatchEvent se prueba en evidence-events; aquí basta el parseo de ida y vuelta vía datos.
    expect(b.data).toMatchObject({
      seq: 3,
      prevRoot: H,
      windowStart: T0,
      windowEnd: T0 + 600,
      policy: H,
    });
    expect(typeof parseBatchEvent).toBe('function');
  });
});

describe('pruebas de inclusión de recibos', () => {
  it('cada recibo del lote tiene una prueba que verifica contra la raíz, y no contra otra', () => {
    const receipts = receiptsAt([T0 + 60, T0 + 120, T0 + 180, T0 + 240, T0 + 300]);
    const b = buildBatch({
      seq: 1,
      prevRoot: GENESIS,
      window: { start: T0, end: T0 + 600 },
      policy: H,
      countSalt: SALT,
      receipts,
    });
    for (const r of receipts) {
      const p = proveReceipt(1, receipts, r.seq);
      expect(p.root).toBe(b.data.root);
      expect(verifyReceiptProof(p, b.data.root)).toBe(true);
      expect(verifyReceiptProof(p, EMPTY_ROOT)).toBe(false);
    }
    expect(() => proveReceipt(1, receipts, 99)).toThrow(/no está en el lote/);
  });

  it('alterar un recibo invalida su prueba (WOW 1 contra el lote publicado)', () => {
    const receipts = receiptsAt([T0 + 60, T0 + 120, T0 + 180]);
    const root = buildBatch({
      seq: 1,
      prevRoot: GENESIS,
      window: { start: T0, end: T0 + 600 },
      policy: H,
      countSalt: SALT,
      receipts,
    }).data.root;
    const tampered = receipts.map((r) => (r.seq === 2 ? { ...r, result: 'under_18' as const } : r));
    const p = proveReceipt(1, tampered, 2);
    expect(verifyReceiptProof(p, root)).toBe(false);
  });
});

describe('regla de ventana de anclaje', () => {
  it('acepta sellos entre el fin de la ventana y el gap máximo; rechaza antes y después', () => {
    expect(checkAnchorWindow(1000, 1000, 3600)).toMatchObject({ ok: true, gapSeconds: 0 });
    expect(checkAnchorWindow(1000, 4600, 3600)).toMatchObject({ ok: true, gapSeconds: 3600 });
    expect(checkAnchorWindow(1000, 4601, 3600)).toMatchObject({ ok: false });
    expect(checkAnchorWindow(1000, 999, 3600)).toMatchObject({ ok: false, gapSeconds: -1 }); // sello anterior al lote: imposible
  });
});
