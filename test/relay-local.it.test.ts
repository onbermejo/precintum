/**
 * Test de integración contra el relay privado en Docker. Solo con PRECINTUM_IT=1 y
 * con el relay arrancado:
 *   PRECINTUM_NSEC=<nsec del agente> pnpm precintum relay init
 *   docker compose -f deploy/relay/docker-compose.yml up -d
 *   PRECINTUM_IT=1 PRECINTUM_NSEC=<mismo nsec> pnpm exec vitest run test/relay-local.it.test.ts
 * Comprueba: el agente publica (con NIP-42), otra clave es rechazada, un kind 5 es rechazado.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { identityFromSecretKey, nsecDecode } from '../src/domain/identity/keys.ts';
import { RelayClient } from '../src/infra/relay/relay-client.ts';
import { newIdentity, note } from './support/fixtures.ts';

const URL = process.env.PRECINTUM_IT_LOCAL_RELAY ?? 'ws://127.0.0.1:7000';
const NSEC = process.env.PRECINTUM_NSEC;

describe.skipIf(!NSEC)('relay privado en Docker (nostr-rs-relay)', () => {
  // Se decodifica en beforeAll y no aquí: vitest ejecuta el cuerpo del describe aunque lo salte, y sin
  // PRECINTUM_NSEC el decodificador fallaría al cargar el fichero.
  let agent: ReturnType<typeof identityFromSecretKey>;
  beforeAll(() => {
    agent = identityFromSecretKey(nsecDecode(NSEC as string));
  });

  it('el agente publica y el relay devuelve el evento', async () => {
    const client = new RelayClient(URL, { identity: agent, publishTimeoutMs: 10_000 });
    const e = note(agent, `precintum relay privado ${new Date().toISOString()}`);
    const receipt = await client.publish(e);
    expect(receipt.accepted).toBe(true);
    const found = await client.query([{ ids: [e.id] }]);
    expect(found.map((x) => x.id)).toEqual([e.id]);
    client.close();
  }, 30_000);

  it('NIP-42: el relay envía challenge y acepta el AUTH del agente (la allowlist no lo exige para escribir)', async () => {
    // nostr-rs-relay autoriza por la pubkey del evento (pubkey_whitelist); NIP-42 identifica
    // la conexión y protege lecturas restringidas, pero no sustituye a la allowlist.
    const client = new RelayClient(URL, { publishTimeoutMs: 10_000 });
    await client.connect();
    await new Promise((r) => setTimeout(r, 300));
    expect(client.authChallenge).not.toBeNull();
    const receipt = await client.authenticate(agent);
    expect(receipt.accepted).toBe(true);
    expect(client.authenticatedAs).toBe(agent.pubkey);
    client.close();
  }, 30_000);

  it('otra clave no puede escribir', async () => {
    const other = newIdentity();
    const client = new RelayClient(URL, { identity: other, publishTimeoutMs: 10_000 });
    await expect(client.publish(note(other, 'intruso'))).rejects.toMatchObject({
      code: expect.stringMatching(/rejected|restricted|auth-required/),
    });
    client.close();
  }, 30_000);

  it('un borrado (kind 5) del propio agente es rechazado', async () => {
    const client = new RelayClient(URL, { identity: agent, publishTimeoutMs: 10_000 });
    const deletion = note(agent, '', { kind: 5, tags: [['e', '00'.repeat(32)]] });
    await expect(client.publish(deletion)).rejects.toMatchObject({ code: 'rejected' });
    client.close();
  }, 30_000);
});
