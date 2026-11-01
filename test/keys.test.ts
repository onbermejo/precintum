import { nip19, getPublicKey as ntGetPublicKey } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  identityFromSecretKey,
  npubDecode,
  npubEncode,
  nsecDecode,
  nsecEncode,
} from '../src/domain/identity/keys.ts';

describe('identidad: claves secp256k1 + NIP-19', () => {
  it('genera 32 bytes y una pubkey x-only de 64 hex', () => {
    const sk = generateSecretKey();
    expect(sk).toHaveLength(32);
    expect(getPublicKey(sk)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dos claves nunca coinciden', () => {
    expect(generateSecretKey()).not.toEqual(generateSecretKey());
  });

  it('la pubkey coincide con la que calcula nostr-tools (oráculo)', () => {
    const sk = generateSecretKey();
    expect(getPublicKey(sk)).toBe(ntGetPublicKey(sk));
  });

  it('nsec/npub: ida y vuelta, y coinciden con nostr-tools', () => {
    const id = identityFromSecretKey(generateSecretKey());
    const nsec = nsecEncode(id.secretKey);
    const npub = npubEncode(id.pubkey);
    expect(nsec).toMatch(/^nsec1/);
    expect(npub).toMatch(/^npub1/);
    expect(nsecDecode(nsec)).toEqual(id.secretKey);
    expect(npubDecode(npub)).toBe(id.pubkey);
    expect(nsec).toBe(nip19.nsecEncode(id.secretKey));
    expect(npub).toBe(nip19.npubEncode(id.pubkey));
  });

  it('rechaza prefijos cruzados y checksums corruptos', () => {
    const id = identityFromSecretKey(generateSecretKey());
    const npub = npubEncode(id.pubkey);
    expect(() => nsecDecode(npub)).toThrow(/se esperaba nsec/);
    const corrupt = npub.slice(0, -1) + (npub.endsWith('q') ? 'p' : 'q');
    expect(() => npubDecode(corrupt)).toThrow();
  });

  it('rechaza claves privadas de longitud incorrecta', () => {
    expect(() => identityFromSecretKey(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
