/**
 * Hashes con separación de dominio y JSON canónico.
 *
 * En Precintum hay muchos artefactos de 32 bytes: hash de recibo, hoja y nodo Merkle, raíz,
 * id de evento, compromiso de recuento. Sin una etiqueta de dominio, un verificador podría
 * aceptar el artefacto equivocado (o un atacante presentar un nodo interno como hoja: la
 * segunda preimagen de RFC 6962). Regla: nada se hashea "a pelo"; todo lleva dominio.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesToHex } from '../../shared/hex.ts';

export const DOMAINS = {
  receipt: 'precintum/receipt/v1',
  genesis: 'precintum/genesis/v1',
  count: 'precintum/count/v1',
  archive: 'precintum/archive/v1',
  batch: 'precintum/batch/v1',
} as const;
// Nota: hojas y nodos del árbol Merkle NO usan este esquema sino los prefijos 0x00/0x01 de
// RFC 6962 (ver merkle.ts), para que un tercero pueda reimplementar la verificación desde la RFC.

export type Domain = (typeof DOMAINS)[keyof typeof DOMAINS];

const SEPARATOR = new Uint8Array([0x0a]);

/** sha256(dominio || 0x0a || datos). El separador impide ambigüedades entre dominio y datos. */
export function hashWithDomain(domain: Domain, data: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes(domain), SEPARATOR, data)));
}

export type CanonicalValue = string | number | boolean | null;
export type CanonicalObject = Record<string, CanonicalValue | undefined>;

/**
 * JSON canónico para objetos planos: claves ordenadas por unidades de código UTF-16 (como
 * RFC 8785), sin espacios, solo enteros seguros (nada de floats), `undefined` se omite.
 * Dos procesos distintos que serialicen el mismo recibo obtienen el mismo byte a byte.
 */
export function canonicalize(obj: CanonicalObject): string {
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new Error(`valor no canonicalizable en "${key}": solo se admiten enteros seguros`);
    }
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(',')}}`;
}
