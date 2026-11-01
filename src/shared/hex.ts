import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, hexToBytes };

const HEX_64 = /^[0-9a-f]{64}$/;

/** true si `s` es exactamente 32 bytes en hex minúscula (ids, pubkeys, claves). */
export function isHex64(s: string): boolean {
  return HEX_64.test(s);
}
