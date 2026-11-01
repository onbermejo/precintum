import { describe, expect, it } from 'vitest';
import { matchesFilter, okPrefix, relayMessageSchema } from '../src/domain/nostr/protocol.ts';
import { newIdentity, note } from './support/fixtures.ts';

describe('filtros NIP-01', () => {
  const alice = newIdentity();
  const bob = newIdentity();
  const e = note(alice, 'hola', {
    created_at: 1000,
    tags: [
      ['t', 'precintum'],
      ['p', bob.pubkey],
    ],
  });

  it('filtro vacío casa con todo', () => {
    expect(matchesFilter(e, {})).toBe(true);
  });

  it('ids / authors / kinds por igualdad exacta (OR dentro del campo)', () => {
    expect(matchesFilter(e, { ids: [e.id] })).toBe(true);
    expect(matchesFilter(e, { ids: ['0'.repeat(64)] })).toBe(false);
    expect(matchesFilter(e, { authors: [bob.pubkey, alice.pubkey] })).toBe(true);
    expect(matchesFilter(e, { authors: [bob.pubkey] })).toBe(false);
    expect(matchesFilter(e, { kinds: [0, 1] })).toBe(true);
    expect(matchesFilter(e, { kinds: [7] })).toBe(false);
  });

  it('since / until son inclusivos', () => {
    expect(matchesFilter(e, { since: 1000 })).toBe(true);
    expect(matchesFilter(e, { since: 1001 })).toBe(false);
    expect(matchesFilter(e, { until: 1000 })).toBe(true);
    expect(matchesFilter(e, { until: 999 })).toBe(false);
  });

  it('tags "#x" casan si alguna tag coincide', () => {
    expect(matchesFilter(e, { '#t': ['precintum'] })).toBe(true);
    expect(matchesFilter(e, { '#t': ['otro', 'precintum'] })).toBe(true);
    expect(matchesFilter(e, { '#t': ['otro'] })).toBe(false);
    expect(matchesFilter(e, { '#p': [bob.pubkey] })).toBe(true);
    expect(matchesFilter(e, { '#e': [e.id] })).toBe(false);
  });

  it('los campos se combinan con AND', () => {
    expect(matchesFilter(e, { authors: [alice.pubkey], kinds: [1], '#t': ['precintum'] })).toBe(
      true,
    );
    expect(matchesFilter(e, { authors: [alice.pubkey], kinds: [7] })).toBe(false);
  });
});

describe('parser de mensajes del relay', () => {
  it('acepta los cinco tipos NIP-01', () => {
    const e = note(newIdentity(), 'x');
    expect(relayMessageSchema.safeParse(['EVENT', 'sub', e]).success).toBe(true);
    expect(relayMessageSchema.safeParse(['OK', e.id, true, '']).success).toBe(true);
    expect(relayMessageSchema.safeParse(['EOSE', 'sub']).success).toBe(true);
    expect(relayMessageSchema.safeParse(['CLOSED', 'sub', 'reason']).success).toBe(true);
    expect(relayMessageSchema.safeParse(['NOTICE', 'hola']).success).toBe(true);
  });

  it('acepta AUTH (NIP-42), COUNT (NIP-45) y el EOSE extendido de NIP-67', () => {
    expect(relayMessageSchema.safeParse(['AUTH', 'challenge']).success).toBe(true);
    expect(relayMessageSchema.safeParse(['COUNT', 'sub', { count: 3 }]).success).toBe(true);
    expect(relayMessageSchema.safeParse(['EOSE', 'sub', ['finish']]).success).toBe(true);
  });

  it('rechaza basura y mensajes malformados', () => {
    expect(relayMessageSchema.safeParse(['OK', 'no-es-hex', true, '']).success).toBe(false);
    expect(relayMessageSchema.safeParse(['EVENT', 'sub', { id: 'x' }]).success).toBe(false);
    expect(relayMessageSchema.safeParse(['COUNT', 'sub', { count: -1 }]).success).toBe(false);
    expect(relayMessageSchema.safeParse(['WHATEVER', 'x']).success).toBe(false);
    expect(relayMessageSchema.safeParse('hola').success).toBe(false);
  });
});

describe('prefijos estandarizados de OK/CLOSED', () => {
  it('extrae el prefijo o devuelve null', () => {
    expect(okPrefix('duplicate: already have this event')).toBe('duplicate');
    expect(okPrefix('rate-limited: slow down')).toBe('rate-limited');
    expect(okPrefix('auth-required: we only accept events from registered users')).toBe(
      'auth-required',
    );
    expect(okPrefix('')).toBeNull();
    expect(okPrefix('sin prefijo')).toBeNull();
    expect(okPrefix('Blocked: mayúscula no es estándar')).toBeNull();
  });
});
