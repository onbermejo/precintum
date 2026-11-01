import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdRelayInit, RELAY_DIR } from '../src/cli/relay-commands.ts';
import { identityFromSecretKey, nsecDecode } from '../src/domain/identity/keys.ts';
import { loadConfig } from '../src/shared/config.ts';

const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';

describe('relay init', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'precintum-relay-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('escribe config.toml y docker-compose.yml con la pubkey del agente', async () => {
    const cfg = loadConfig({ PRECINTUM_NSEC: NSEC });
    const dir = await cmdRelayInit(cfg, root);
    expect(dir).toBe(join(root, RELAY_DIR));
    const toml = await readFile(join(dir, 'config.toml'), 'utf8');
    const pubkey = identityFromSecretKey(nsecDecode(NSEC)).pubkey;
    expect(toml).toContain(`pubkey_whitelist = ["${pubkey}"]`);
    expect(toml).toContain('event_kind_blacklist = [5]');
    expect(await readFile(join(dir, 'docker-compose.yml'), 'utf8')).toContain('nostr-rs-relay');
  });

  it('no pisa una configuración existente salvo con --force', async () => {
    const cfg = loadConfig({ PRECINTUM_NSEC: NSEC });
    await cmdRelayInit(cfg, root);
    await expect(cmdRelayInit(cfg, root)).rejects.toThrow(/--force/);
    await expect(cmdRelayInit(cfg, root, { force: true })).resolves.toBe(join(root, RELAY_DIR));
  });

  it('sin clave privada explica qué falta', async () => {
    await expect(cmdRelayInit(loadConfig({}), root)).rejects.toThrow(/falta PRECINTUM_NSEC/);
  });
});
