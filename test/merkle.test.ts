import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ROOT,
  inclusionProof,
  leafHash,
  merkleRoot,
  nodeHash,
  splitPoint,
  verifyInclusion,
} from '../src/domain/evidence/merkle.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';

const leaf = (i: number) => bytesToHex(sha256(new Uint8Array([i])));
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leaf(i));

describe('Merkle RFC 6962', () => {
  it('vectores conocidos: árbol vacío y hoja única', () => {
    // SHA-256("") — raíz del árbol vacío (RFC 6962 §2.1 y vectores de Certificate Transparency)
    expect(EMPTY_ROOT).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(merkleRoot([])).toBe(EMPTY_ROOT);
    // SHA-256(0x00) — árbol con una hoja vacía (vector de CT)
    expect(bytesToHex(leafHash(new Uint8Array()))).toBe(
      '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
    );
  });

  it('parte en la mayor potencia de 2 menor que n', () => {
    expect(splitPoint(2)).toBe(1);
    expect(splitPoint(3)).toBe(2);
    expect(splitPoint(4)).toBe(2);
    expect(splitPoint(5)).toBe(4);
    expect(splitPoint(8)).toBe(4);
    expect(splitPoint(9)).toBe(8);
  });

  it('la raíz de dos hojas es el nodo de sus hojas, con prefijos distintos', () => {
    const [a, b] = leaves(2) as [string, string];
    const expected = bytesToHex(nodeHash(leafHash(hexToBytes(a)), leafHash(hexToBytes(b))));
    expect(merkleRoot([a, b])).toBe(expected);
    // Sin separación de dominio, hoja y nodo de los mismos bytes coincidirían. Aquí no.
    expect(bytesToHex(leafHash(hexToBytes(a)))).not.toBe(bytesToHex(sha256(hexToBytes(a))));
  });

  it('la raíz es sensible al orden y a cada hoja', () => {
    const l = leaves(5);
    const root = merkleRoot(l);
    expect(merkleRoot([...l].reverse())).not.toBe(root);
    expect(merkleRoot([...l.slice(0, 4), leaf(99)])).not.toBe(root);
    expect(merkleRoot(l.slice(0, 4))).not.toBe(root);
  });

  it('pruebas de inclusión válidas para todas las hojas de árboles de 1 a 9 hojas', () => {
    for (let n = 1; n <= 9; n++) {
      const l = leaves(n);
      const root = merkleRoot(l);
      for (let i = 0; i < n; i++) {
        const proof = inclusionProof(l, i);
        expect(proof.size).toBe(n);
        expect(verifyInclusion(l[i] as string, proof, root)).toBe(true);
      }
    }
  });

  it('la longitud de la prueba es logarítmica', () => {
    expect(inclusionProof(leaves(1), 0).path).toHaveLength(0);
    expect(inclusionProof(leaves(2), 0).path).toHaveLength(1);
    expect(inclusionProof(leaves(8), 3).path).toHaveLength(3);
    expect(inclusionProof(leaves(9), 8).path).toHaveLength(1); // la hoja 9 cuelga sola del nivel superior
  });

  it('rechaza pruebas manipuladas: otra hoja, otro índice, otra raíz, hermano alterado', () => {
    const l = leaves(6);
    const root = merkleRoot(l);
    const proof = inclusionProof(l, 2);
    expect(verifyInclusion(l[3] as string, proof, root)).toBe(false);
    expect(verifyInclusion(l[2] as string, { ...proof, index: 3 }, root)).toBe(false);
    expect(verifyInclusion(l[2] as string, proof, leaf(7))).toBe(false);
    const tampered = { ...proof, path: [leaf(50), ...proof.path.slice(1)] };
    expect(verifyInclusion(l[2] as string, tampered, root)).toBe(false);
    expect(verifyInclusion(l[2] as string, { ...proof, path: proof.path.slice(1) }, root)).toBe(
      false,
    );
  });

  it('segunda preimagen: un nodo interno presentado como hoja no verifica', () => {
    const [a, b, c, d] = leaves(4) as [string, string, string, string];
    const root = merkleRoot([a, b, c, d]);
    // El nodo interno izquierdo, como bytes, es sha256(0x01||H(a)||H(b)).
    const innerLeft = bytesToHex(nodeHash(leafHash(hexToBytes(a)), leafHash(hexToBytes(b))));
    const innerRight = bytesToHex(nodeHash(leafHash(hexToBytes(c)), leafHash(hexToBytes(d))));
    // Un atacante afirma que `innerLeft` es una hoja de un árbol de 2 hojas con hermano `innerRight`.
    expect(verifyInclusion(innerLeft, { index: 0, size: 2, path: [innerRight] }, root)).toBe(false);
  });

  it('valida las entradas', () => {
    expect(() => inclusionProof(leaves(3), 3)).toThrow(/fuera de rango/);
    expect(() => merkleRoot(['no-hex'])).toThrow(/hex/);
  });
});
