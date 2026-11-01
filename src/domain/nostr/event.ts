/**
 * NIP-01: el evento es la única estructura de datos de Nostr.
 *
 * {
 *   id:         sha256 de la serialización canónica (hex, 32 bytes)
 *   pubkey:     autor (hex, 32 bytes, x-only)
 *   created_at: unix seconds
 *   kind:       entero que define el significado del evento
 *   tags:       [["e", "..."], ["p", "..."], ...]
 *   content:    string arbitrario
 *   sig:        firma Schnorr BIP-340 del id (hex, 64 bytes)
 * }
 *
 * Serialización canónica (NIP-01):
 *   JSON.stringify([0, pubkey, created_at, kind, tags, content])
 * Sin espacios y con los escapes de JSON estándar. El 0 es la "versión".
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesToHex, hexToBytes, isHex64 } from '../../shared/hex.ts';
import type { Identity, PubkeyHex } from '../identity/keys.ts';

export type Tag = string[];

export interface EventTemplate {
  kind: number;
  created_at: number;
  tags: Tag[];
  content: string;
}

export interface UnsignedEvent extends EventTemplate {
  pubkey: PubkeyHex;
}

export interface NostrEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

export function serializeEvent(e: UnsignedEvent): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

export function computeEventId(e: UnsignedEvent): string {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(e))));
}

export function signEvent(template: EventTemplate, identity: Identity): NostrEvent {
  const unsigned: UnsignedEvent = { ...template, pubkey: identity.pubkey };
  const id = computeEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), identity.secretKey));
  return { ...unsigned, id, sig };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verificación completa: forma + id recalculado + firma.
 * Devolvemos la razón del fallo porque en una capa de evidencia
 * "inválido" no basta: hay que saber *qué* se manipuló.
 */
export function verifyEvent(e: unknown): VerifyResult {
  if (!isShapedLikeEvent(e)) return { ok: false, reason: 'estructura inválida' };
  if (!isHex64(e.pubkey)) return { ok: false, reason: 'pubkey no es hex de 32 bytes' };
  if (!isHex64(e.id)) return { ok: false, reason: 'id no es hex de 32 bytes' };
  if (!/^[0-9a-f]{128}$/.test(e.sig)) return { ok: false, reason: 'sig no es hex de 64 bytes' };
  if (computeEventId(e) !== e.id)
    return { ok: false, reason: 'el id no coincide con el contenido' };
  let valid = false;
  try {
    valid = schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'firma inválida' };
}

export function isValidEvent(e: unknown): e is NostrEvent {
  return verifyEvent(e).ok;
}

function isShapedLikeEvent(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pubkey === 'string' &&
    typeof o.sig === 'string' &&
    typeof o.content === 'string' &&
    Number.isInteger(o.kind) &&
    Number.isInteger(o.created_at) &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))
  );
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
