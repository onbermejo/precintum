import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type EvidencePackage,
  ExportService,
  verifyPackage,
} from '../src/application/export-service.ts';
import type { BatchStore } from '../src/domain/evidence/batch-store.ts';
import type { EvidenceStore } from '../src/domain/evidence/evidence-store.ts';

interface WebChecks {
  verifyPackage(pkg: unknown): { ok: boolean; fatal?: string };
}

const WEB = join(import.meta.dirname, '..', 'web', 'verify', 'src');
const MAX_DATE_SECONDS = 8_640_000_000_000;

for (const file of ['10-crypto.js', '11-checks.js', '13-example.js']) {
  new Function(readFileSync(join(WEB, file), 'utf8'))();
}
const g = globalThis as unknown as {
  PrecintumChecks: WebChecks;
  PRECINTUM_EXAMPLE: EvidencePackage;
};
const example = g.PRECINTUM_EXAMPLE;
const web = g.PrecintumChecks;
const copy = (): EvidencePackage => structuredClone(example);

function rejected(pkg: EvidencePackage): void {
  // Los datos inválidos deben producir un veredicto, no una excepción del motor.
  expect(verifyPackage(pkg).ok).toBe(false);
  expect(web.verifyPackage(pkg).ok).toBe(false);
}

function accepted(pkg: EvidencePackage): void {
  expect(verifyPackage(pkg).ok).toBe(true);
  expect(web.verifyPackage(pkg).ok).toBe(true);
}

function emptyPackage(beforeService = false): EvidencePackage {
  const pkg = copy();
  const size = pkg.windowSeconds;
  pkg.requested = beforeService ? [-size, 0] : [0, size];
  pkg.covered = [...pkg.requested];
  pkg.batches = [];
  pkg.gaps = [];
  pkg.precedingReceiptHash = null;
  pkg.agentPubkey = null;
  if (!beforeService) {
    pkg.serviceStart = null;
    pkg.serviceEnd = null;
  }
  pkg.totals = {
    batches: 0,
    receipts: 0,
    empty: 0,
    withoutTsa: 0,
    withoutOts: 0,
    windowsBeforeService: 1,
    windowsNotClosed: 0,
  };
  return pkg;
}

describe('rangos del paquete: servidor y navegador coinciden', () => {
  const [start, end] = example.covered;
  const malformed: Array<{ name: string; field: 'requested' | 'covered'; value: unknown }> = [
    { name: 'requested ausente', field: 'requested', value: undefined },
    { name: 'covered nulo', field: 'covered', value: null },
    { name: 'requested como texto', field: 'requested', value: `${start},${end}` },
    { name: 'covered con un extremo', field: 'covered', value: [start] },
    { name: 'requested con tres extremos', field: 'requested', value: [start, end, end + 1] },
    { name: 'extremo de covered como texto', field: 'covered', value: [String(start), end] },
    { name: 'extremo requested NaN', field: 'requested', value: [Number.NaN, end] },
    {
      name: 'extremo covered infinito',
      field: 'covered',
      value: [start, Number.POSITIVE_INFINITY],
    },
    {
      name: 'entero requested inseguro',
      field: 'requested',
      value: [start, Number.MAX_SAFE_INTEGER + 1],
    },
    {
      name: 'entero covered fuera de Date',
      field: 'covered',
      value: [start, Number.MAX_SAFE_INTEGER],
    },
    { name: 'requested invertido', field: 'requested', value: [end, start] },
    { name: 'covered sin duración', field: 'covered', value: [start, start] },
  ];

  it.each(malformed)('rechaza $name sin operar con extremos inválidos', ({ field, value }) => {
    const pkg = copy();
    const fields = pkg as unknown as Record<string, unknown>;
    if (value === undefined) delete fields[field];
    else fields[field] = value;
    rejected(pkg);
  });

  it.each([
    { name: 'inicio solicitado anterior', requested: [start - 1, end] },
    { name: 'fin solicitado posterior', requested: [start, end + 1] },
  ])('rechaza covered que no contiene el $name', ({ requested }) => {
    const pkg = copy();
    pkg.requested = requested as [number, number];
    rejected(pkg);
  });

  it.each([
    { name: 'primer lote', covered: [start + example.windowSeconds, end] },
    { name: 'último lote', covered: [start, end - example.windowSeconds] },
  ])('rechaza un rango que deja fuera el $name aunque requested quepa', ({ covered }) => {
    const pkg = copy();
    pkg.covered = covered as [number, number];
    pkg.requested = [...pkg.covered];
    rejected(pkg);
  });

  it.each([
    { name: 'tres extremos', value: [start, start + example.windowSeconds, end] },
    { name: 'nula', value: null },
  ])('rechaza una ventana de lote $name', ({ value }) => {
    const pkg = copy();
    const batch = pkg.batches[0];
    if (!batch) throw new Error('el ejemplo no tiene lotes');
    (batch as unknown as { window: unknown }).window = value;
    rejected(pkg);
  });

  it('rechaza covered fuera de rejilla aunque contenga requested y todos los lotes', () => {
    const pkg = copy();
    pkg.covered = [start - 1, end + 1];
    rejected(pkg);
  });

  it('acepta el ejemplo completo y un pedido parcial no alineado dentro de covered', () => {
    accepted(copy());
    const pkg = copy();
    pkg.requested = [start + 1, end - 1];
    accepted(pkg);
  });

  it('acepta un paquete vacío bien formado antes de existir el servicio', () => {
    accepted(emptyPackage());
  });

  it('acepta un pedido pre-epoch anterior al periodo de servicio conocido', () => {
    accepted(emptyPackage(true));
  });
});

function service(windowSeconds = 600) {
  const inTimeRange = vi.fn().mockResolvedValue([]);
  const exporter = new ExportService({
    evidence: {} as EvidenceStore,
    batches: { inTimeRange } as unknown as BatchStore,
    windowSeconds,
  });
  return { exporter, inTimeRange };
}

async function invalidExport(from: number, to: number, size = 600): Promise<void> {
  const { exporter, inTimeRange } = service(size);
  expect(() => exporter.alignRange(from, to)).toThrow();
  await expect(exporter.exportRange(from, to)).rejects.toThrow();
  expect(inTimeRange).not.toHaveBeenCalled();
}

describe('alineación de exportación: se rechaza antes de consultar almacenamiento', () => {
  it('rechaza extremos no finitos', async () => {
    await invalidExport(Number.NaN, 600);
    await invalidExport(0, Number.POSITIVE_INFINITY);
  });

  it('rechaza segundos fraccionarios', async () => {
    await invalidExport(0.5, 600);
  });

  it('rechaza enteros inseguros', async () => {
    await invalidExport(0, Number.MAX_SAFE_INTEGER + 1);
  });

  it('rechaza enteros seguros que no representan una fecha válida', async () => {
    await invalidExport(0, Number.MAX_SAFE_INTEGER);
  });

  it('rechaza intervalos vacíos o invertidos', async () => {
    await invalidExport(600, 600);
    await invalidExport(600, 0);
  });

  it('rechaza tamaños de ventana inválidos', async () => {
    for (const size of [
      0,
      -1,
      59,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await invalidExport(0, 600, size);
    }
  });

  it('rechaza una alineación que sale de Date aunque los extremos pedidos sean válidos', async () => {
    await invalidExport(MAX_DATE_SECONDS - 1, MAX_DATE_SECONDS, 601);
  });

  it('conserva la alineación de fechas válidas a ambos lados del epoch', () => {
    const { exporter, inTimeRange } = service();
    expect(exporter.alignRange(-1, 1)).toEqual([-600, 600]);
    expect(inTimeRange).not.toHaveBeenCalled();
  });
});
