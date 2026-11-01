import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFromSecretKey, npubEncode, nsecDecode } from '../src/domain/identity/keys.ts';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
// Las claves constantes de la suite son vectores públicos de prueba, nunca credenciales operativas.
const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
const NPUB = npubEncode(identityFromSecretKey(nsecDecode(NSEC)).pubkey);

/** Ejecuta la CLI como lo haría el usuario: proceso Node nuevo, .env vía variables. */
async function cli(args: string[], env: Record<string, string> = {}, timeout = 30_000) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, ...env, LOG_LEVEL: 'silent' },
      timeout,
    });
    return {
      code: 0,
      stdout,
      stderr,
      elapsedMs: performance.now() - started,
      killed: false,
      signal: null,
    };
  } catch (err) {
    const e = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      elapsedMs: performance.now() - started,
      killed: e.killed ?? false,
      signal: e.signal ?? null,
    };
  }
}

describe('CLI (procesos reales)', () => {
  let dataDir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'precintum-cli-'));
    env = {
      PRECINTUM_NSEC: NSEC,
      PRECINTUM_DATABASE_URL: `pglite:${dataDir.replaceAll('\\', '/')}`,
      PRECINTUM_DEDUP_KEY: '03'.repeat(32),
    };
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('sin comando imprime la ayuda en stderr y sale con 2', async () => {
    const r = await cli([]);
    expect(
      r.code,
      JSON.stringify({
        code: r.code,
        elapsedMs: r.elapsedMs,
        killed: r.killed,
        signal: r.signal,
        stderr: r.stderr,
      }),
    ).toBe(2);
    expect(r.stderr).toContain('Usage: pnpm precintum <command>');
  });

  it('help, --help y -h imprimen la ayuda en stdout, una línea por comando, y salen con 0', async () => {
    for (const args of [['help'], ['--help'], ['-h']]) {
      const r = await cli(args);
      expect(
        r.code,
        JSON.stringify({
          code: r.code,
          elapsedMs: r.elapsedMs,
          killed: r.killed,
          signal: r.signal,
          stderr: r.stderr,
        }),
      ).toBe(0);
      expect(r.stdout).toContain('Usage: pnpm precintum <command>');
      for (const cmd of [
        'keygen',
        'whoami',
        'chain verify',
        'batch close',
        'export --from',
        'witness check',
        'run [--port',
      ]) {
        expect(r.stdout).toContain(cmd);
      }
    }
  });

  it('keygen imprime nsec, npub, hex y una clave de deduplicación', async () => {
    const r = await cli(['keygen']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/nsec: nsec1[02-9ac-hj-np-z]{58}/);
    expect(r.stdout).toMatch(/npub: npub1[02-9ac-hj-np-z]{58}/);
    expect(r.stdout).toMatch(/hex : [0-9a-f]{64}/);
    expect(r.stdout).toMatch(/PRECINTUM_DEDUP_KEY sugerida: [0-9a-f]{64}/);
  });

  it('keygen --to-env escribe los secretos en el fichero, no los imprime y no sobrescribe', async () => {
    const path = join(dataDir, 'env-nuevo');
    const r = await cli(['keygen', '--to-env', path]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/npub: npub1/);
    expect(r.stdout).not.toContain('nsec1');
    const written = await readFile(path, 'utf8');
    expect(written).toMatch(/^PRECINTUM_NSEC=nsec1[02-9ac-hj-np-z]{58}$/m);
    expect(written).toMatch(/^PRECINTUM_INGEST_TOKEN=[0-9a-f]{48}$/m);
    const again = await cli(['keygen', '--to-env', path]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('ya existe');
  });

  it('whoami funciona solo con PRECINTUM_NPUB (solo lectura) y oculta la contraseña de la BD', async () => {
    const r = await cli(['whoami'], {
      PRECINTUM_NSEC: '',
      PRECINTUM_NPUB: NPUB,
      PRECINTUM_DATABASE_URL: 'postgres://precintum:s3cret@localhost:5432/precintum',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`npub: ${NPUB} (solo lectura: sin clave privada)`);
    expect(r.stdout).toContain('base de datos: postgres://precintum:***@localhost:5432/precintum');
    expect(r.stdout).not.toContain('s3cret');
  });

  it('whoami falla claro sin PRECINTUM_NSEC y funciona con ella', async () => {
    const sin = await cli(['whoami'], { PRECINTUM_NSEC: '' });
    expect(sin.code).toBe(1);
    expect(sin.stderr).toContain('falta PRECINTUM_NSEC');
    const con = await cli(['whoami'], env);
    expect(con.code).toBe(0);
    expect(con.stdout).toContain('npub: npub1');
    expect(con.stdout).toContain('base de datos: pglite:');
  });

  it('whoami avisa cuando la TSA configurada es la de desarrollo (freetsa) y calla con otra', async () => {
    const dev = await cli(['whoami'], env);
    expect(dev.stdout).toContain('TSA (RFC 3161): https://freetsa.org/tsr');
    expect(dev.stderr).toContain('TSA gratuita de DESARROLLO');
    const prod = await cli(['whoami'], {
      ...env,
      PRECINTUM_TSA_URL: 'https://tsa.ejemplo-qtsp.es/tsr',
    });
    expect(prod.stderr).not.toContain('DESARROLLO');
  });

  it('un PRECINTUM_NSEC mal formado da el mensaje de zod, no un stack trace', async () => {
    const r = await cli(['whoami'], { ...env, PRECINTUM_NSEC: NSEC.slice(0, -1) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('PRECINTUM_NSEC');
    expect(r.stderr).not.toContain('    at ');
  });

  it('db migrate → receipt add (idempotente) → chain show → chain verify, entre procesos', async () => {
    // PGlite crea la base en disco por primera vez; en Windows el arranque en frío puede superar 30 s.
    const m = await cli(['db', 'migrate'], env, process.platform === 'win32' ? 60_000 : 30_000);
    expect(m.code, JSON.stringify(m)).toBe(0);
    expect(m.stdout).toContain('migraciones aplicadas: 1');

    const a = await cli(['receipt', 'add', '--result', 'over_18', '--tx', 't1'], env);
    expect(a.code).toBe(0);
    expect(a.stdout).toContain('recibo #1 creado');

    const again = await cli(['receipt', 'add', '--result', 'over_18', '--tx', 't1'], env);
    expect(again.stdout).toContain('ya tenía recibo: #1');

    const b = await cli(['receipt', 'add', '--result', 'under_18', '--tx', 't2'], env);
    expect(b.stdout).toContain('recibo #2 creado');

    const show = await cli(['chain', 'show', '--last', '5'], env);
    expect(show.stdout).toContain('2 recibos');
    expect(show.stdout).toContain('under_18');

    const verify = await cli(['chain', 'verify'], env);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain('cadena íntegra: 2 recibos');
  }, 90_000);

  it('receipt add sin --result explica el error y sale con 1', async () => {
    const r = await cli(['receipt', 'add'], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--result debe ser uno de');
  });
});
