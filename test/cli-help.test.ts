import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('la ayuda de CLI funciona sin el backend instalado', () => {
  let root: string;
  let cli: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'precintum-help-'));
    const sources = join(import.meta.dirname, '..', 'src');
    await Promise.all([
      mkdir(join(root, 'src', 'cli'), { recursive: true }),
      mkdir(join(root, 'src', 'shared'), { recursive: true }),
    ]);
    cli = join(root, 'src', 'cli', 'index.ts');
    await Promise.all([
      copyFile(join(sources, 'cli', 'index.ts'), cli),
      copyFile(join(sources, 'shared', 'redact.ts'), join(root, 'src', 'shared', 'redact.ts')),
      writeFile(join(root, 'package.json'), '{"type":"module"}\n', 'utf8'),
    ]);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each([
    { name: 'help', args: ['help'], code: 0 },
    { name: '--help', args: ['--help'], code: 0 },
    { name: '-h', args: ['-h'], code: 0 },
    { name: 'sin comando', args: [], code: 2 },
    { name: 'comando desconocido', args: ['not-a-command'], code: 2 },
  ])(
    '$name conserva ayuda y código de salida sin cargar DB, configuración o criptografía',
    async ({ args, code }) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('PRECINTUM_')),
      );
      const started = performance.now();
      let actual = 0;
      let stdout = '';
      let stderr = '';
      let killed = false;
      let signal: string | null = null;
      try {
        ({ stdout, stderr } = await run(process.execPath, [cli, ...args], {
          cwd: root,
          env: {
            ...env,
            LOG_LEVEL: 'silent',
            PRECINTUM_NSEC: 'synthetic-invalid-key',
            PRECINTUM_DATABASE_URL: 'synthetic-invalid-database',
          },
          timeout: 30_000,
        }));
      } catch (error) {
        const failure = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string | null;
        };
        actual = typeof failure.code === 'number' ? failure.code : 1;
        stdout = failure.stdout ?? '';
        stderr = failure.stderr ?? '';
        killed = failure.killed ?? false;
        signal = failure.signal ?? null;
      }
      const diagnostic = JSON.stringify({
        code: actual,
        elapsedMs: Math.round(performance.now() - started),
        killed,
        signal,
        stderr,
      });
      expect(actual, diagnostic).toBe(code);
      expect(code === 0 ? stdout : stderr).toContain('Usage: pnpm precintum <command>');
      expect(code === 0 ? stderr : stdout).toBe('');
      expect(stdout + stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    },
  );
});
