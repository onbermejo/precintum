import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { npubEncode } from '../src/domain/identity/keys.ts';
import { newIdentity } from './support/fixtures.ts';

const run = promisify(execFile);

it('whoami censura credenciales de todas las URLs sin conectar a los servicios', async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('PRECINTUM_')),
  );
  const secrets = [
    'fixture-db-pass',
    'fixture-query-pass',
    'fixture-tsa-pass',
    'fixture-tsa-key',
    'fixture-relay-token',
    'fixture-fragment',
  ];
  const { stdout, stderr } = await run(
    process.execPath,
    [join(import.meta.dirname, '..', 'src', 'cli', 'index.ts'), 'whoami'],
    {
      env: {
        ...env,
        LOG_LEVEL: 'silent',
        PRECINTUM_NPUB: npubEncode(newIdentity().pubkey),
        PRECINTUM_DATABASE_URL:
          'postgres://operator:fixture-db-pass@db.example/db?password=fixture-query-pass&sslmode=require',
        PRECINTUM_RELAYS:
          'wss://relay.example/events?token=fixture-relay-token,wss://second.example',
        PRECINTUM_TSA_URL:
          'https://operator:fixture-tsa-pass@tsa.example/tsr?key=fixture-tsa-key#fixture-fragment',
        PRECINTUM_OTS_CALENDARS: 'https://calendar.example',
      },
      timeout: process.platform === 'win32' ? 60_000 : 30_000,
    },
  );
  expect(stdout).toContain('npub: npub1');
  expect(stdout).toContain('db.example');
  expect(stdout).toContain('relay.example');
  expect(stdout).toContain('tsa.example');
  expect(stdout).toContain('calendar.example');
  for (const secret of secrets) expect(stdout + stderr).not.toContain(secret);
});
