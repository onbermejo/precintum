/**
 * El paquete de ejemplo incrustado en el verificador web (web/verify/src/13-example.js) tiene que
 * pasar los dos motores. Es lo primero que ve quien abre la página: si el ejemplo sale en rojo, el
 * verificador parece roto. Regenerar con `pnpm example:web` y `bash web/build.sh`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type EvidencePackage, verifyPackage } from '../src/application/export-service.ts';

const WEB = join(import.meta.dirname, '..', 'web', 'verify', 'src');

interface WebResult {
  ok: boolean;
  problems: Array<{ key: string }>;
  warnings: Array<{ key: string }>;
  notes: Array<{ key: string }>;
}
interface WebChecks {
  verifyPackage(pkg: unknown, opts?: { expectedPubkey?: string | undefined }): WebResult;
}

describe('paquete de ejemplo del verificador web', () => {
  for (const file of ['10-crypto.js', '11-checks.js', '13-example.js']) {
    new Function(readFileSync(join(WEB, file), 'utf8'))();
  }
  const g = globalThis as unknown as { PrecintumChecks: WebChecks; PRECINTUM_EXAMPLE: unknown };
  const example = g.PRECINTUM_EXAMPLE as EvidencePackage;

  it('es un paquete precintum/export/v1 con un lote latido y clave del agente declarada', () => {
    expect(example.format).toBe('precintum/export/v1');
    expect(example.totals.batches).toBe(3);
    expect(example.totals.empty).toBe(1);
    expect(example.agentPubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pasa el verificador del servidor sin problemas ni avisos', () => {
    const v = verifyPackage(example, { expectedPubkey: example.agentPubkey ?? undefined });
    expect(v.problems).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('pasa el verificador del navegador, con las notas sobre CMS y bloque', () => {
    const r = g.PrecintumChecks.verifyPackage(JSON.parse(JSON.stringify(example)), {
      expectedPubkey: example.agentPubkey ?? undefined,
    });
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notes.map((n) => n.key)).toContain('tsaCmsNotChecked');
  });
});
