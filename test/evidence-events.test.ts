import { verifyEvent as ntVerifyEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  BATCH_KIND,
  type BatchData,
  buildBatchEvent,
  commitCount,
  parseBatchEvent,
} from '../src/domain/evidence/batch-event.ts';
import {
  buildKeyDirectoryEvent,
  isKeyValidAt,
  KEY_DIRECTORY_KIND,
  type KeyDirectory,
  parseKeyDirectoryEvent,
} from '../src/domain/evidence/key-directory.ts';
import { GENESIS } from '../src/domain/evidence/receipt.ts';
import { verifyEvent } from '../src/domain/nostr/event.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const SALT = 'cd'.repeat(32);

describe('evento de lote (kind 7676)', () => {
  const agent = newIdentity();
  const data: BatchData = {
    seq: 7,
    root: H,
    prevRoot: GENESIS,
    windowStart: 1_700_000_000,
    windowEnd: 1_700_003_600,
    policy: 'ef'.repeat(32),
    countCommitment: commitCount(42, SALT),
  };

  it('se construye firmado, con la raíz en content y sin recuento en claro', () => {
    const e = buildBatchEvent(data, agent);
    expect(e.kind).toBe(BATCH_KIND);
    expect(e.content).toBe(H);
    expect(e.created_at).toBe(data.windowEnd);
    expect(verifyEvent(e)).toEqual({ ok: true });
    expect(ntVerifyEvent(e)).toBe(true);
    expect(JSON.stringify(e)).not.toContain('"42"');
    expect(e.tags.some((t) => t[0] === 'client')).toBe(false);
  });

  it('parsea de vuelta exactamente los mismos datos', () => {
    const e = buildBatchEvent(data, agent);
    expect(parseBatchEvent(e)).toEqual({ ok: true, data });
  });

  it('el compromiso del recuento es verificable solo con la sal', () => {
    expect(commitCount(42, SALT)).toBe(data.countCommitment);
    expect(commitCount(43, SALT)).not.toBe(data.countCommitment);
    expect(commitCount(42, 'ee'.repeat(32))).not.toBe(data.countCommitment);
    expect(() => commitCount(-1, SALT)).toThrow();
  });

  it('rechaza ventanas vacías, kinds ajenos y tags rotas', () => {
    expect(() => buildBatchEvent({ ...data, windowEnd: data.windowStart }, agent)).toThrow(
      /ventana/,
    );
    const e = buildBatchEvent(data, agent);
    expect(parseBatchEvent({ ...e, kind: 1 })).toMatchObject({ ok: false });
    const sinSeq = { ...e, tags: e.tags.filter((t) => t[0] !== 'seq') };
    expect(parseBatchEvent(sinSeq)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('seq'),
    });
    const malaRaiz = { ...e, content: 'no-hex' };
    expect(parseBatchEvent(malaRaiz)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('root'),
    });
  });

  it('exige etiquetas únicas, window de tres elementos y created_at no anterior al fin', () => {
    const e = buildBatchEvent(data, agent);
    const dupSeq = { ...e, tags: [...e.tags, ['seq', '8']] };
    expect(parseBatchEvent(dupSeq)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('repetida'),
    });
    const winCorta = {
      ...e,
      tags: e.tags.map((t) => (t[0] === 'window' ? ['window', t[1] ?? ''] : t)),
    };
    expect(parseBatchEvent(winCorta)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('window'),
    });
    const antes = { ...e, created_at: data.windowEnd - 1 };
    expect(parseBatchEvent(antes)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('created_at'),
    });
    expect(() => buildBatchEvent(data, agent, data.windowEnd - 1)).toThrow(/created_at/);
    // Las etiquetas ajenas al formato se ignoran (compatibilidad hacia delante).
    expect(parseBatchEvent({ ...e, tags: [...e.tags, ['client', 'x']] })).toEqual({
      ok: true,
      data,
    });
  });
});

describe('directorio de claves (kind 37676)', () => {
  const root = newIdentity();
  const k1 = newIdentity().pubkey;
  const k2 = newIdentity().pubkey;
  const dir: KeyDirectory = {
    v: 1,
    keys: [
      { pubkey: k1, from: 1_700_000_000, to: 1_800_000_000 },
      { pubkey: k2, from: 1_800_000_000, to: null },
    ],
  };

  it('se publica como evento direccionable firmado por la clave raíz', () => {
    const e = buildKeyDirectoryEvent(dir, root, 1_800_000_000);
    expect(e.kind).toBe(KEY_DIRECTORY_KIND);
    expect(e.pubkey).toBe(root.pubkey);
    expect(e.tags).toEqual([['d', 'precintum/keys']]);
    expect(verifyEvent(e)).toEqual({ ok: true });
    expect(parseKeyDirectoryEvent(e)).toEqual({ ok: true, directory: dir });
  });

  it('decide qué clave era válida en cada instante (from inclusivo, to exclusivo)', () => {
    expect(isKeyValidAt(dir, k1, 1_700_000_000)).toBe(true);
    expect(isKeyValidAt(dir, k1, 1_799_999_999)).toBe(true);
    expect(isKeyValidAt(dir, k1, 1_800_000_000)).toBe(false);
    expect(isKeyValidAt(dir, k2, 1_800_000_000)).toBe(true);
    expect(isKeyValidAt(dir, k2, 9_999_999_999)).toBe(true);
    expect(isKeyValidAt(dir, 'ff'.repeat(32), 1_800_000_000)).toBe(false);
  });

  it('rechaza directorios malformados', () => {
    expect(() => buildKeyDirectoryEvent({ v: 1, keys: [] }, root, 1)).toThrow();
    expect(() =>
      buildKeyDirectoryEvent({ v: 1, keys: [{ pubkey: k1, from: 10, to: 5 }] }, root, 1),
    ).toThrow(/posterior/);
    const e = buildKeyDirectoryEvent(dir, root, 1_800_000_000);
    expect(parseKeyDirectoryEvent({ ...e, content: '{"v":2}' })).toMatchObject({ ok: false });
    expect(parseKeyDirectoryEvent({ ...e, tags: [] })).toMatchObject({ ok: false });
  });
});
