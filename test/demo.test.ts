import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DemoResult, runDemo } from '../scripts/demo.ts';

// `pnpm demo` es lo primero que ejecuta quien evalúa el repositorio: si se rompe, que lo diga un test.
describe('pnpm demo', () => {
  let dir: string;
  let result: DemoResult;
  const lines: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'precintum-demo-'));
    result = await runDemo({ outDir: dir, say: (l) => lines.push(l) });
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('la ingesta registra dos, rechaza los datos personales (400) y el cambio de resultado (409)', () => {
    expect(result.ingest).toEqual({
      tx1: 201,
      tx2: 201,
      withPersonalData: 400,
      sameTxOtherResult: 409,
    });
    expect(lines.join('\n')).not.toContain('Nora');
  });

  it('cierra un lote con los dos recibos, sellado dentro de la ventana de anclaje', () => {
    expect(result.batch.seq).toBe(1);
    expect(result.batch.count).toBe(2);
    expect(result.batch.sealGapSeconds).toBeGreaterThanOrEqual(0);
    expect(result.batch.sealGapSeconds).toBeLessThanOrEqual(86_400);
  });

  it('los dos testigos aceptan el evento y lo devuelven', () => {
    expect(result.witnesses).toHaveLength(2);
    for (const w of result.witnesses) expect(w).toMatchObject({ accepted: true, servesIt: true });
  });

  it('el paquete bueno verifica y el trucado no, por la raíz', () => {
    expect(result.verified.ok).toBe(true);
    expect(result.tampered.ok).toBe(false);
    expect(result.tampered.problems.join(' ')).toMatch(/raíz/);
    expect(existsSync(result.files.good)).toBe(true);
    expect(existsSync(result.files.tampered)).toBe(true);
  });
});
