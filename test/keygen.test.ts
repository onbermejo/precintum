import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKeygen, fillEnv, generateSecrets } from '../src/cli/keygen-commands.ts';
import { identityFromSecretKey, npubEncode, nsecDecode } from '../src/domain/identity/keys.ts';

describe('keygen', () => {
  let dir: string;
  let logged: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'precintum-keygen-'));
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('genera una identidad coherente, una clave de deduplicación y un token de ingesta', () => {
    const s = generateSecrets();
    expect(s.nsec).toMatch(/^nsec1[02-9ac-hj-np-z]{58}$/);
    expect(s.npub).toBe(npubEncode(identityFromSecretKey(nsecDecode(s.nsec)).pubkey));
    expect(s.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.dedupKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.ingestToken).toMatch(/^[0-9a-f]{48}$/);
  });

  it('fillEnv rellena las variables vacías de la plantilla y añade las que falten', () => {
    const s = generateSecrets();
    const out = fillEnv(
      '# cabecera\nPRECINTUM_NSEC=\nLOG_LEVEL=info\nPRECINTUM_DEDUP_KEY=viejo\n',
      s,
    );
    expect(out).toContain('# cabecera\n');
    expect(out).toContain(`PRECINTUM_NSEC=${s.nsec}\n`);
    expect(out).toContain('LOG_LEVEL=info\n');
    expect(out).toContain(`PRECINTUM_DEDUP_KEY=${s.dedupKey}\n`);
    expect(out).toContain(`PRECINTUM_INGEST_TOKEN=${s.ingestToken}\n`);
    expect(out).not.toContain('viejo');
  });

  it('--to-env escribe los secretos sin imprimirlos y nunca sobrescribe', async () => {
    const path = join(dir, '.env');
    await cmdKeygen(path);
    const written = await readFile(path, 'utf8');
    expect(written).toMatch(/^PRECINTUM_NSEC=nsec1/m);
    expect(written).toMatch(/^PRECINTUM_DEDUP_KEY=[0-9a-f]{64}$/m);
    expect(written).toMatch(/^PRECINTUM_INGEST_TOKEN=[0-9a-f]{48}$/m);
    const output = logged.join('\n');
    expect(output).toContain('npub: npub1');
    expect(output).not.toContain('nsec1');
    const token = /^PRECINTUM_INGEST_TOKEN=([0-9a-f]+)$/m.exec(written)?.[1];
    const dedup = /^PRECINTUM_DEDUP_KEY=([0-9a-f]+)$/m.exec(written)?.[1];
    expect(output).not.toContain(String(token));
    expect(output).not.toContain(String(dedup));

    await expect(cmdKeygen(path)).rejects.toThrow(/ya existe/);
    expect(await readFile(path, 'utf8')).toBe(written);
  });

  it('--to-env parte de .env.example si está al lado, conservando sus comentarios', async () => {
    await writeFile(
      join(dir, '.env.example'),
      '# Clave privada\nPRECINTUM_NSEC=\nPRECINTUM_RELAYS=wss://a.example\nPRECINTUM_DEDUP_KEY=\n',
      'utf8',
    );
    const path = join(dir, '.env');
    await cmdKeygen(path);
    const written = await readFile(path, 'utf8');
    expect(written.startsWith('# Clave privada\n')).toBe(true);
    expect(written).toContain('PRECINTUM_RELAYS=wss://a.example\n');
    expect(written).toMatch(/^PRECINTUM_NSEC=nsec1/m);
    expect(written).toMatch(/^PRECINTUM_INGEST_TOKEN=[0-9a-f]{48}$/m);
  });
});
