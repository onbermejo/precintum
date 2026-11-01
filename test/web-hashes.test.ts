import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('el manifiesto de huellas se puede comprobar desde web para todas las páginas publicadas', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const web = resolve(root, 'web');
  const entries = readFileSync(resolve(web, 'HASHES.txt'), 'utf8').trim().split('\n');
  const paths: string[] = [];
  for (const entry of entries) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(entry);
    expect(match, 'formato sha256sum').not.toBeNull();
    if (!match) throw new Error('manifiesto inválido');
    const [, expected, path] = match;
    if (!path) throw new Error('falta la ruta');
    const target = resolve(web, path);
    const inside = relative(root, target);
    expect(isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)).toBe(false);
    expect(createHash('sha256').update(readFileSync(target)).digest('hex')).toBe(expected);
    paths.push(path);
  }
  expect(new Set(paths)).toEqual(
    new Set([
      'caso-nora.html',
      'verificador.html',
      'panel-demo.html',
      '../src/infra/http/panel.html',
    ]),
  );
});
