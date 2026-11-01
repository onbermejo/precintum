import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENESIS } from '../src/domain/evidence/receipt.ts';
import { AppendOnlyFile } from '../src/infra/witness/append-only-file.ts';
import { newIdentity, note } from './support/fixtures.ts';

describe('archivo append-only', () => {
  let dir: string;
  let path: string;
  const agent = newIdentity();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'precintum-archive-'));
    path = join(dir, 'witness', 'archive.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('empieza vacío y verifica', async () => {
    const a = new AppendOnlyFile(path);
    expect(await a.readAll()).toEqual([]);
    expect(await a.verify()).toEqual({ ok: true, length: 0, head: null });
  });

  it('anexa eventos encadenados, crea el directorio y verifica', async () => {
    const a = new AppendOnlyFile(path);
    const r1 = await a.append(note(agent, 'uno'));
    const r2 = await a.append(note(agent, 'dos'));
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    const lines = await a.readAll();
    expect(lines[0]?.prev).toBe(GENESIS);
    expect(lines[1]?.prev).toBe(r1.hash);
    expect(await a.verify()).toEqual({ ok: true, length: 2, head: r2.hash });
  });

  it('al reabrir continúa la cadena donde estaba', async () => {
    const a = new AppendOnlyFile(path);
    await a.append(note(agent, 'uno'));
    const b = new AppendOnlyFile(path);
    const r = await b.append(note(agent, 'dos'));
    expect(r.seq).toBe(2);
    expect(await b.verify()).toMatchObject({ ok: true, length: 2 });
  });

  it('rechaza eventos inválidos', async () => {
    const a = new AppendOnlyFile(path);
    await expect(a.append({ ...note(agent, 'x'), sig: '0'.repeat(128) })).rejects.toThrow(
      /inválido/,
    );
  });

  it('detecta una línea editada a mano y señala su posición', async () => {
    const a = new AppendOnlyFile(path);
    await a.append(note(agent, 'uno'));
    await a.append(note(agent, 'dos'));
    await a.append(note(agent, 'tres'));
    const raw = (await readFile(path, 'utf8')).split('\n');
    const line2 = JSON.parse(raw[1] as string);
    line2.event.content = 'DOS ALTERADO';
    raw[1] = JSON.stringify(line2);
    await writeFile(path, raw.join('\n'), 'utf8');
    expect(await a.verify()).toMatchObject({ ok: false, at: 2 });
  });

  it('detecta una línea borrada (hueco) y una línea con hash falsificado', async () => {
    const a = new AppendOnlyFile(path);
    await a.append(note(agent, 'uno'));
    await a.append(note(agent, 'dos'));
    await a.append(note(agent, 'tres'));
    const raw = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    await writeFile(path, `${[raw[0], raw[2]].join('\n')}\n`, 'utf8');
    expect(await a.verify()).toMatchObject({ ok: false, at: 2 });

    const line3 = JSON.parse(raw[2] as string);
    line3.hash = 'ff'.repeat(32);
    await writeFile(path, `${[raw[0], raw[1], JSON.stringify(line3)].join('\n')}\n`, 'utf8');
    expect(await a.verify()).toMatchObject({ ok: false, at: 3 });
  });
});
