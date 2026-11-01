import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayClient, RelayError } from '../src/infra/relay/relay-client.ts';
import { newIdentity, note } from './support/fixtures.ts';
import { MiniRelay } from './support/mini-relay.ts';

describe('RelayClient contra un relay en memoria', () => {
  let relay: MiniRelay;
  let url: string;
  let client: RelayClient;
  const alice = newIdentity();

  beforeEach(async () => {
    relay = new MiniRelay();
    url = await relay.start();
    client = new RelayClient(url, {
      publishTimeoutMs: 500,
      eoseTimeoutMs: 500,
      connectTimeoutMs: 500,
    });
  });

  afterEach(async () => {
    client.close();
    await relay.stop();
  });

  it('publica y recibe el OK del relay', async () => {
    const e = note(alice, 'hola relay');
    const receipt = await client.publish(e);
    expect(receipt.accepted).toBe(true);
    expect(receipt.eventId).toBe(e.id);
    expect(receipt.relay).toBe(url);
    expect(relay.events).toHaveLength(1);
  });

  it('un evento con firma rota es rechazado por el relay', async () => {
    const e = { ...note(alice, 'x'), sig: '0'.repeat(128) };
    await expect(client.publish(e)).rejects.toMatchObject({ code: 'rejected' });
  });

  it('el rechazo por política llega con el motivo', async () => {
    await relay.stop();
    relay = new MiniRelay({ reject: () => 'blocked: not in allowlist' });
    url = await relay.start();
    client = new RelayClient(url, { publishTimeoutMs: 500 });
    await expect(client.publish(note(alice, 'x'))).rejects.toThrow(/blocked: not in allowlist/);
  });

  it('si el relay no contesta OK, falla por timeout', async () => {
    await relay.stop();
    relay = new MiniRelay({ swallowOk: true });
    url = await relay.start();
    client = new RelayClient(url, { publishTimeoutMs: 200 });
    const err = await client.publish(note(alice, 'x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe('timeout');
  });

  it('query devuelve lo almacenado que casa con el filtro y termina en EOSE', async () => {
    const e1 = await publish('uno', 100);
    await publish('dos', 200);
    const bob = newIdentity();
    await client.publish(note(bob, 'de bob', { created_at: 300 }));

    const byId = await client.query([{ ids: [e1.id] }]);
    expect(byId.map((e) => e.content)).toEqual(['uno']);

    const byAuthor = await client.query([{ authors: [alice.pubkey] }]);
    expect(byAuthor.map((e) => e.content)).toEqual(['dos', 'uno']); // más nuevo primero

    const limited = await client.query([{ authors: [alice.pubkey], limit: 1 }]);
    expect(limited.map((e) => e.content)).toEqual(['dos']);

    const nothing = await client.query([{ kinds: [30023] }]);
    expect(nothing).toEqual([]);
  });

  it('una suscripción abierta recibe eventos nuevos en tiempo real', async () => {
    const received: string[] = [];
    const sub = await client.subscribe([{ authors: [alice.pubkey] }], (e) =>
      received.push(e.content),
    );
    await sub.eose;
    expect(received).toEqual([]);

    const other = new RelayClient(url);
    await other.publish(note(alice, 'en vivo'));
    await waitFor(() => received.length === 1);
    expect(received).toEqual(['en vivo']);

    sub.close();
    await other.publish(note(alice, 'tras cerrar'));
    await sleep(50);
    expect(received).toEqual(['en vivo']);
    other.close();
  });

  it('descarta eventos que el relay envía pero no verifican, y basura', async () => {
    const received: string[] = [];
    const sub = await client.subscribe([{}], (e) => received.push(e.content));
    await sub.eose;
    const fake = { ...note(alice, 'falso'), content: 'manipulado' };
    relay.broadcastRaw(JSON.stringify(['EVENT', sub.id, fake]));
    relay.broadcastRaw('esto no es json');
    relay.broadcastRaw(JSON.stringify(['UNKNOWN', 1, 2]));
    await sleep(50);
    expect(received).toEqual([]);
  });

  it('si el relay corta la conexión, las suscripciones pendientes fallan con "closed"', async () => {
    await client.connect();
    const sub = await client.subscribe([{}], () => {});
    relay.dropAllConnections();
    await expect(sub.eose).rejects.toMatchObject({ code: 'closed' });
    expect(client.connected).toBe(false);
  });

  it('reconecta de forma transparente tras una caída', async () => {
    await client.publish(note(alice, 'antes'));
    relay.dropAllConnections();
    await waitFor(() => !client.connected);
    const receipt = await client.publish(note(alice, 'después'));
    expect(receipt.accepted).toBe(true);
    expect(relay.events).toHaveLength(2);
  });

  it('publicar el mismo evento dos veces a la vez resuelve ambas promesas con un solo OK', async () => {
    const e = note(alice, 'doble');
    const [a, b] = await Promise.all([client.publish(e), client.publish(e)]);
    expect(a.eventId).toBe(e.id);
    expect(b.eventId).toBe(e.id);
    expect(relay.events).toHaveLength(1);
  });

  it('un rechazo "auth-required:" se tipa como tal (NIP-42)', async () => {
    await relay.stop();
    relay = new MiniRelay({ reject: () => 'auth-required: please authenticate' });
    url = await relay.start();
    client = new RelayClient(url, { publishTimeoutMs: 500 });
    await expect(client.publish(note(alice, 'x'))).rejects.toMatchObject({
      code: 'auth-required',
    });
  });

  it('acepta frames binarios y el EOSE extendido de NIP-67', async () => {
    const received: string[] = [];
    const sub = await client.subscribe([{ authors: [alice.pubkey] }], (e) =>
      received.push(e.content),
    );
    await sub.eose;
    relay.broadcastBinary(JSON.stringify(['EVENT', sub.id, note(alice, 'binario')]));
    await waitFor(() => received.length === 1);
    expect(received).toEqual(['binario']);

    const sub2 = await client.subscribe([{ kinds: [30023] }], () => {});
    // El mini-relay ya envió su EOSE; simulamos además uno con pistas NIP-67.
    relay.broadcastRaw(JSON.stringify(['EOSE', sub2.id, ['finish']]));
    await expect(sub2.eose).resolves.toBeUndefined();
    sub.close();
    sub2.close();
  });

  it('una suscripción ya con EOSE se entera de la caída del relay por onClosed', async () => {
    let reason = '';
    const sub = await client.subscribe([{}], () => {}, { onClosed: (r) => (reason = r) });
    await sub.eose;
    relay.dropAllConnections();
    await waitFor(() => reason !== '');
    expect(reason).toBe('conexión cerrada');
  });

  it('close() durante connect() no deja el socket abierto', async () => {
    const c = new RelayClient(url, { connectTimeoutMs: 1000 });
    const p = c.connect();
    c.close();
    await expect(p).rejects.toMatchObject({ code: 'connect' });
    expect(c.connected).toBe(false);
  });

  it('query respeta el tope maxEvents', async () => {
    for (let i = 0; i < 5; i++) await client.publish(note(alice, `n${i}`, { created_at: 100 + i }));
    const some = await client.query([{ authors: [alice.pubkey] }], { maxEvents: 2 });
    expect(some).toHaveLength(2);
  });

  async function publish(content: string, created_at: number) {
    const e = note(alice, content, { created_at });
    await client.publish(e);
    return e;
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor: timeout');
    await sleep(10);
  }
}
