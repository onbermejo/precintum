/**
 * Árbol de Merkle según RFC 6962 (Certificate Transparency), §2.1:
 *
 *   MTH({})      = SHA-256()
 *   MTH({d0})    = SHA-256(0x00 || d0)
 *   MTH(D[n])    = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))   con k = mayor potencia de 2 < n
 *
 * Los prefijos 0x00 (hoja) y 0x01 (nodo) son la separación de dominio que impide presentar un
 * nodo interno como si fuera una hoja (segunda preimagen). La partición en potencias de 2 hace
 * que las pruebas de inclusión sean deterministas y que un tercero pueda reimplementarlo desde
 * la RFC sin leer nuestro código. Las hojas de Precintum son hashes de recibo (ya con dominio).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { bytesToHex, hexToBytes, isHex64 } from '../../shared/hex.ts';

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** Raíz del árbol vacío: SHA-256 de cero bytes. Es la raíz de un lote sin recibos (latido). */
export const EMPTY_ROOT: string = bytesToHex(sha256(new Uint8Array()));

export function leafHash(leaf: Uint8Array): Uint8Array {
  return sha256(concatBytes(LEAF_PREFIX, leaf));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(NODE_PREFIX, left, right));
}

/** Mayor potencia de 2 estrictamente menor que n (n >= 2). */
export function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function rootOf(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array());
  if (leaves.length === 1) return leafHash(leaves[0] as Uint8Array);
  const k = splitPoint(leaves.length);
  return nodeHash(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

/** Raíz (hex) de una lista de hojas (hex). */
export function merkleRoot(leavesHex: readonly string[]): string {
  return bytesToHex(rootOf(leavesHex.map(toBytes)));
}

export interface InclusionProof {
  /** Índice de la hoja, base 0. */
  index: number;
  /** Número total de hojas del árbol. */
  size: number;
  /** Hermanos desde la hoja hasta la raíz, en hex. */
  path: string[];
}

/** Prueba de inclusión RFC 6962 §2.1.1 para la hoja `index`. */
export function inclusionProof(leavesHex: readonly string[], index: number): InclusionProof {
  if (!Number.isInteger(index) || index < 0 || index >= leavesHex.length) {
    throw new Error(`índice ${index} fuera de rango (${leavesHex.length} hojas)`);
  }
  const path: string[] = [];
  const walk = (leaves: readonly Uint8Array[], m: number): void => {
    if (leaves.length <= 1) return;
    const k = splitPoint(leaves.length);
    if (m < k) {
      walk(leaves.slice(0, k), m);
      path.push(bytesToHex(rootOf(leaves.slice(k))));
    } else {
      walk(leaves.slice(k), m - k);
      path.push(bytesToHex(rootOf(leaves.slice(0, k))));
    }
  };
  walk(leavesHex.map(toBytes), index);
  return { index, size: leavesHex.length, path };
}

/**
 * Recalcula la raíz a partir de una hoja y su prueba y la compara. Es el algoritmo de
 * RFC 9162 §2.1.3.2 (la revisión de RFC 6962), que recorre la prueba de la hoja hacia la
 * raíz usando los bits del índice para saber si el hermano va a la izquierda o a la derecha.
 */
export function verifyInclusion(leafHex: string, proof: InclusionProof, rootHex: string): boolean {
  if (!isHex64(rootHex) || !isHex64(leafHex)) return false;
  if (!Number.isInteger(proof.index) || proof.index < 0 || proof.index >= proof.size) return false;
  let fn = proof.index;
  let sn = proof.size - 1;
  let r = leafHash(hexToBytes(leafHex));
  for (const siblingHex of proof.path) {
    if (!isHex64(siblingHex)) return false;
    const p = hexToBytes(siblingHex);
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while (fn !== 0 && (fn & 1) === 0) {
          fn >>>= 1;
          sn >>>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>>= 1;
    sn >>>= 1;
  }
  return sn === 0 && bytesToHex(r) === rootHex;
}

function toBytes(hex: string): Uint8Array {
  if (!isHex64(hex)) throw new Error('las hojas deben ser hex de 32 bytes');
  return hexToBytes(hex);
}
