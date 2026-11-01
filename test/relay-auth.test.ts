import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_KIND, RelayClient } from '../src/infra/relay/relay-client.ts';
import { newIdentity, note } from './support/fixtures.ts';
import { MiniRelay } from './support/mini-relay.ts';

describe('NIP-42 contra un relay que exige autenticación', () => {
  let relay: MiniRelay;
  let url: string;
  const agent = newIdentity();

  beforeEach(async () => {
    relay = new MiniRelay({ requireAuth: true, blockedKinds: [5] });
    url = await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  it('sin identidad, el rechazo auth-required es un error final tipado', async () => {
    const client = new RelayClient(url, { publishTimeoutMs: 500 });
    await expect(client.publish(note(agent, 'x'))).rejects.toMatchObject({ code: 'auth-required' });
    expect(client.authChallenge).toMatch(/^challenge-/);
    expect(client.authenticatedAs).toBeNull();
    client.close();
  });

  it('con identidad, publish se autentica solo y reintenta una vez', async () => {
    const client = new RelayClient(url, { publishTimeoutMs: 500, identity: agent });
    const receipt = await client.publish(note(agent, 'autenticado'));
    expect(receipt.accepted).toBe(true);
    expect(client.authenticatedAs).toBe(agent.pubkey);
    expect(relay.events).toHaveLength(1);
    // El evento AUTH es efímero: kind 22242, con relay y challenge, y no se almacena.
    const auth = relay.authEvents[0];
    expect(auth?.kind).toBe(AUTH_KIND);
    expect(auth?.tags).toEqual([
      ['relay', url],
      ['challenge', client.authChallenge],
    ]);
    expect(relay.events.some((e) => e.kind === AUTH_KIND)).toBe(false);
    client.close();
  });

  it('authenticate() explícito funciona y falla claro sin challenge', async () => {
    const client = new RelayClient(url, { publishTimeoutMs: 500 });
    await client.connect();
    await new Promise((r) => setTimeout(r, 30)); // deja llegar el AUTH
    const receipt = await client.authenticate(agent);
    expect(receipt.accepted).toBe(true);
    expect(client.authenticatedAs).toBe(agent.pubkey);
    client.close();

    const silent = new MiniRelay(); // sin AUTH
    const silentUrl = await silent.start();
    const c2 = new RelayClient(silentUrl);
    await c2.connect();
    await expect(c2.authenticate(agent)).rejects.toMatchObject({ code: 'protocol' });
    c2.close();
    await silent.stop();
  });

  it('un kind 5 (borrado NIP-09) del propio agente es rechazado por el relay', async () => {
    const client = new RelayClient(url, { publishTimeoutMs: 500, identity: agent });
    const deletion = note(agent, '', { kind: 5, tags: [['e', '00'.repeat(32)]] });
    await expect(client.publish(deletion)).rejects.toMatchObject({
      code: 'rejected',
      message: expect.stringContaining('blocked: kind 5'),
    });
    client.close();
  });

  it('tras una reconexión hay que autenticarse otra vez (la sesión AUTH es por conexión)', async () => {
    const client = new RelayClient(url, { publishTimeoutMs: 500, identity: agent });
    await client.publish(note(agent, 'uno'));
    relay.dropAllConnections();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.authenticatedAs).toBeNull();
    const again = await client.publish(note(agent, 'dos'));
    expect(again.accepted).toBe(true);
    expect(client.authenticatedAs).toBe(agent.pubkey);
    expect(relay.authEvents).toHaveLength(2);
    client.close();
  });
});
