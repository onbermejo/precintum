import { describe, expect, it } from 'vitest';
import { ExportService, verifyPackage } from '../src/application/export-service.ts';
import { buildBatch } from '../src/domain/evidence/batch.ts';
import { buildBatchEvent } from '../src/domain/evidence/batch-event.ts';
import type { BatchRecord, BatchStore } from '../src/domain/evidence/batch-store.ts';
import type { EvidenceStore } from '../src/domain/evidence/evidence-store.ts';
import { GENESIS } from '../src/domain/evidence/receipt.ts';
import { newIdentity } from './support/fixtures.ts';

const T0 = 1_700_000_400;
const W = 600;

function scenario(initiallyEmpty = false) {
  const identity = newIdentity();
  const makeBatch = (seq: number, prevRoot: string): BatchRecord => {
    const countSalt = 'cd'.repeat(32);
    const built = buildBatch({
      seq,
      prevRoot,
      window: { start: T0 + (seq - 1) * W, end: T0 + seq * W },
      policy: 'ab'.repeat(32),
      countSalt,
      receipts: [],
    });
    const event = buildBatchEvent(built.data, identity);
    return {
      ...built.data,
      count: 0,
      countSalt,
      fromReceiptSeq: null,
      toReceiptSeq: null,
      eventId: event.id,
      event,
      tsaToken: null,
      tsaGenTime: null,
      ots: null,
      otsComplete: false,
    };
  };
  const first = makeBatch(1, GENESIS);
  const next = makeBatch(2, first.root);
  const records: BatchRecord[] = initiallyEmpty ? [] : [first];
  const hooks: { afterHead?: () => void; afterRange?: () => void } = {};
  const batches: BatchStore = {
    head: async () => {
      const head = records.at(-1) ?? null;
      hooks.afterHead?.();
      return head;
    },
    get: async (seq) => records.find((b) => b.seq === seq) ?? null,
    inTimeRange: async (from, to) => {
      const found = records.filter((b) => b.windowStart >= from && b.windowEnd <= to);
      hooks.afterRange?.();
      return found;
    },
    append: async (batch) => {
      records.push(batch);
    },
    range: async (from, to) => records.filter((b) => b.seq >= from && b.seq <= to),
    containingReceipt: async () => null,
    setTsa: async () => {},
    setOts: async () => {},
    pendingAnchors: async () => [],
    notEnqueued: async () => [],
    count: async () => records.length,
  };
  const evidence: EvidenceStore = {
    receipts: {
      head: async () => null,
      append: async () => {},
      get: async () => null,
      range: async () => [],
      inWindow: async () => [],
      firstTs: async () => null,
      count: async () => 0,
    },
    dedup: {
      lookup: async () => null,
      remember: async () => {},
      purgeExpired: async () => 0,
    },
    closedUntil: async () => records.at(-1)?.windowEnd ?? null,
    transaction: async (fn) => fn(evidence),
  };
  return {
    exporter: new ExportService({ evidence, batches, windowSeconds: W }),
    hooks,
    records,
    first,
    next,
  };
}

describe('exportación mientras se cierra otra ventana', () => {
  it('no denuncia un hueco si se cierra un lote después de leer el rango', async () => {
    const { exporter, hooks, records, next } = scenario();
    hooks.afterRange = () => records.push(next);
    const pkg = await exporter.exportRange(T0, T0 + 2 * W);
    expect(pkg.gaps).toEqual([]);
    expect(pkg.serviceEnd).toBe(T0 + W);
    expect(pkg.totals.windowsNotClosed).toBe(1);
    expect(verifyPackage(pkg).ok).toBe(true);
  });

  it('no incorpora lotes posteriores a la cabeza que se leyó al empezar', async () => {
    const { exporter, hooks, records, next } = scenario();
    hooks.afterHead = () => records.push(next);
    const pkg = await exporter.exportRange(T0, T0 + 2 * W);
    expect(pkg.batches.map((b) => b.seq)).toEqual([1]);
    expect(pkg.serviceEnd).toBe(T0 + W);
    expect(pkg.gaps).toEqual([]);
    expect(pkg.totals.windowsNotClosed).toBe(1);
    expect(verifyPackage(pkg).ok).toBe(true);
  });

  it('conserva un paquete vacío si el primer lote se cierra después de leer la cabeza', async () => {
    const { exporter, hooks, records, first } = scenario(true);
    hooks.afterHead = () => records.push(first);
    const pkg = await exporter.exportRange(T0, T0 + 2 * W);
    expect(pkg.batches).toEqual([]);
    expect(pkg.serviceStart).toBeNull();
    expect(pkg.serviceEnd).toBeNull();
    expect(pkg.gaps).toEqual([]);
    expect(pkg.totals.windowsBeforeService).toBe(2);
    expect(verifyPackage(pkg).ok).toBe(true);
  });
});
