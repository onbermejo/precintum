/**
 * Test de integración contra relays públicos reales. Solo con PRECINTUM_IT=1 (pnpm test:it).
 * Publica una nota kind 1 con una identidad efímera y comprueba que el relay la devuelve.
 */
import { describe, expect, it } from 'vitest';
import { RelayClient } from '../src/infra/relay/relay-client.ts';
import { newIdentity, note } from './support/fixtures.ts';

const RELAYS = (
  process.env.PRECINTUM_IT_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net'
).split(',');

describe.each(RELAYS)('relay público %s', (url) => {
  it('acepta un evento y lo devuelve al consultarlo por id', async () => {
    const client = new RelayClient(url, { publishTimeoutMs: 10_000, eoseTimeoutMs: 10_000 });
    const e = note(newIdentity(), `precintum it ${new Date().toISOString()}`, {
      tags: [['client', 'precintum']],
    });
    const receipt = await client.publish(e);
    expect(receipt.accepted).toBe(true);
    const found = await client.query([{ ids: [e.id] }]);
    expect(found.map((x) => x.id)).toEqual([e.id]);
    client.close();
  }, 30_000);
});
