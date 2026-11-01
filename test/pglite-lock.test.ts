/**
 * PGlite en disco es de un solo proceso y
 * dos instancias sobre el mismo directorio se corrompen en silencio. El cliente toma un bloqueo
 * con el PID y el segundo abridor falla con un mensaje claro; un bloqueo huérfano no impide abrir.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PGLITE_LOCK_FILE, PgliteSqlClient } from '../src/infra/db/pglite-client.ts';

describe('PGlite: bloqueo de instancia única por directorio', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = join(mkdtempSync(join(tmpdir(), 'precintum-pglite-')), 'data');
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(join(d, '..'), { recursive: true, force: true });
  });

  it('el segundo proceso sobre el mismo directorio falla con un aviso claro', async () => {
    const dir = tmp();
    const a = await PgliteSqlClient.open(dir);
    try {
      expect(readFileSync(join(dir, PGLITE_LOCK_FILE), 'utf8')).toBe(String(process.pid));
      // Mismo proceso, segunda apertura: el PID coincide, así que no puede saberse si es otro
      // proceso; se simula uno vivo distinto escribiendo el PID del padre (siempre existe).
      writeFileSync(join(dir, PGLITE_LOCK_FILE), String(process.ppid));
      await expect(PgliteSqlClient.open(dir)).rejects.toThrow(/un solo proceso a la vez/);
    } finally {
      await a.close();
    }
  }, 60_000);

  it('al cerrar se libera el bloqueo y se puede reabrir; un bloqueo huérfano no estorba', async () => {
    const dir = tmp();
    const a = await PgliteSqlClient.open(dir);
    await a.query('CREATE TABLE t (x int)');
    await a.close();
    // Bloqueo de un proceso que ya no existe.
    writeFileSync(join(dir, PGLITE_LOCK_FILE), '999999999');
    const b = await PgliteSqlClient.open(dir);
    try {
      expect(await b.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await b.close();
    }
  }, 60_000);

  it('en memoria no hay bloqueo: varias instancias conviven', async () => {
    const a = await PgliteSqlClient.open();
    const b = await PgliteSqlClient.open();
    await a.close();
    await b.close();
  }, 60_000);
});
