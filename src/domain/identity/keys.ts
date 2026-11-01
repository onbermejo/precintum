/**
 * Identidad Nostr = un par de claves secp256k1.
 *
 *  - clave privada: 32 bytes aleatorios. Se muestra como `nsec1...` (NIP-19, bech32).
 *  - clave pública: coordenada X del punto P = d·G, 32 bytes. Se muestra como `npub1...`.
 *
 * En Nostr la pubkey es "x-only" (solo la X, sin prefijo 02/03) porque las firmas
 * son BIP-340 Schnorr, igual que en Bitcoin Taproot.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';
import { bytesToHex, hexToBytes, isHex64 } from '../../shared/hex.ts';

export type SecretKey = Uint8Array & { readonly length: 32 };
export type PubkeyHex = string; // 64 hex chars, x-only

export interface Identity {
  readonly secretKey: SecretKey;
  readonly pubkey: PubkeyHex;
}

export function generateSecretKey(): SecretKey {
  return schnorr.utils.randomSecretKey() as SecretKey;
}

export function getPublicKey(secretKey: Uint8Array): PubkeyHex {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

export function identityFromSecretKey(secretKey: Uint8Array): Identity {
  if (secretKey.length !== 32) throw new Error('la clave privada debe tener 32 bytes');
  return { secretKey: secretKey as SecretKey, pubkey: getPublicKey(secretKey) };
}

// ---------- NIP-19: bech32 con prefijos legibles ----------

// bech32 estándar limita a 90 caracteres; NIP-19 necesita más para los tipos TLV
// (nprofile, nevent, naddr). 5000 es el límite que usa nostr-tools.
const BECH32_LIMIT = 5000;

function encodeBech32(prefix: 'npub' | 'nsec', data: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(data), BECH32_LIMIT);
}

function decodeBech32(expected: 'npub' | 'nsec', s: string): Uint8Array {
  const { prefix, words } = bech32.decode(s as `${string}1${string}`, BECH32_LIMIT);
  if (prefix !== expected) throw new Error(`se esperaba ${expected}1..., llegó ${prefix}1...`);
  const bytes = bech32.fromWords(words);
  if (bytes.length !== 32) throw new Error(`${expected} debe contener 32 bytes`);
  return bytes;
}

export function nsecEncode(secretKey: Uint8Array): string {
  return encodeBech32('nsec', secretKey);
}

export function nsecDecode(nsec: string): SecretKey {
  return decodeBech32('nsec', nsec) as SecretKey;
}

export function npubEncode(pubkeyHex: PubkeyHex): string {
  if (!isHex64(pubkeyHex)) throw new Error('pubkey debe ser 64 hex');
  return encodeBech32('npub', hexToBytes(pubkeyHex));
}

export function npubDecode(npub: string): PubkeyHex {
  return bytesToHex(decodeBech32('npub', npub));
}
