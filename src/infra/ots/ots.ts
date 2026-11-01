/**
 * OpenTimestamps (OTS) implementado desde el formato, sin la librería `opentimestamps` de npm
 * (arrastra `request`, deprecado, y `bitcore-lib`). El formato es pequeño y estable desde 2016:
 *
 *   fichero .ots  = MAGIC || varuint(1) || op_hash_fichero (0x08 = sha256) || digest || timestamp
 *   timestamp     = secuencia de (op || timestamp) y (0x00 || atestación); las ramas se
 *                   separan con 0xff antes de cada rama que no sea la última
 *   op            = 0x02 sha1 | 0x03 ripemd160 | 0x08 sha256 | 0x67 keccak256 |
 *                   0xf0 append(varbytes) | 0xf1 prepend(varbytes) | 0xf2 reverse | 0xf3 hexlify
 *   atestación    = tag de 8 bytes || varbytes(payload)
 *                   bitcoin  05 88 96 0d 73 d7 19 01   payload = varuint(altura de bloque)
 *                   pending  83 df e3 0d 2e f9 0c 8e   payload = varbytes(uri del calendario)
 *   varuint       = LEB128 (7 bits por byte, bit alto = continúa); varbytes = varuint(len) || bytes
 *
 * Semántica: partiendo del digest, aplicar las ops de una rama produce el mensaje que la
 * atestación afirma. Para "bitcoin", ese mensaje es la raíz Merkle del bloque `altura` en orden
 * interno (little-endian). Verificar = obtener esa raíz de un nodo Bitcoin o explorador de
 * confianza y comparar. Una atestación "pending" solo dice "el calendario X lo tiene y aún no
 * está en Bitcoin": hay que pedirle la actualización más tarde (`upgrade`).
 */
import { ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { assertCalendarUrl, isSupportedCalendarUrl } from '../../shared/calendar-url.ts';
import { bytesToHex, hexToBytes } from '../../shared/hex.ts';
import { type FetchLike, fetchWithTimeout } from '../../shared/http.ts';
import { redactUrl } from '../../shared/redact.ts';

export const OTS_MAGIC: Uint8Array = concatBytes(
  new Uint8Array([0x00]),
  utf8ToBytes('OpenTimestamps'),
  new Uint8Array([0x00, 0x00]),
  utf8ToBytes('Proof'),
  new Uint8Array([0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]),
);
export const OTS_MAJOR_VERSION = 1;

export const PUBLIC_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
] as const;

// ---------- ops ----------

export type Op =
  | { type: 'sha1' }
  | { type: 'ripemd160' }
  | { type: 'sha256' }
  | { type: 'keccak256' }
  | { type: 'append'; arg: Uint8Array }
  | { type: 'prepend'; arg: Uint8Array }
  | { type: 'reverse' }
  | { type: 'hexlify' };

const OP_TAG: Record<Op['type'], number> = {
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
  append: 0xf0,
  prepend: 0xf1,
  reverse: 0xf2,
  hexlify: 0xf3,
};
const TAG_OP = new Map(Object.entries(OP_TAG).map(([k, v]) => [v, k as Op['type']]));

export function applyOp(op: Op, msg: Uint8Array): Uint8Array {
  switch (op.type) {
    case 'sha1':
      return sha1(msg);
    case 'ripemd160':
      return ripemd160(msg);
    case 'sha256':
      return sha256(msg);
    case 'keccak256':
      return keccak_256(msg);
    case 'append':
      return concatBytes(msg, op.arg);
    case 'prepend':
      return concatBytes(op.arg, msg);
    case 'reverse':
      return Uint8Array.from(msg).reverse();
    case 'hexlify':
      return utf8ToBytes(bytesToHex(msg));
  }
}

// ---------- atestaciones ----------

export type Attestation =
  | { type: 'bitcoin'; height: number }
  | { type: 'pending'; uri: string }
  | { type: 'unknown'; tag: Uint8Array; payload: Uint8Array };

const BITCOIN_TAG = hexToBytes('0588960d73d71901');
const PENDING_TAG = hexToBytes('83dfe30d2ef90c8e');

// ---------- estructura ----------

export interface Timestamp {
  msg: Uint8Array;
  attestations: Attestation[];
  ops: Array<{ op: Op; next: Timestamp }>;
}

export function newTimestamp(msg: Uint8Array): Timestamp {
  return { msg, attestations: [], ops: [] };
}

/** Añade una op a un timestamp y devuelve el subtimestamp resultante (reutiliza si ya existía). */
export function addOp(ts: Timestamp, op: Op): Timestamp {
  const key = opKey(op);
  const existing = ts.ops.find((o) => opKey(o.op) === key);
  if (existing) return existing.next;
  const next = newTimestamp(applyOp(op, ts.msg));
  ts.ops.push({ op, next });
  return next;
}

function opKey(op: Op): string {
  return `${OP_TAG[op.type].toString(16)}:${'arg' in op ? bytesToHex(op.arg) : ''}`;
}

function attestationKey(a: Attestation): string {
  if (a.type === 'bitcoin') return `${bytesToHex(BITCOIN_TAG)}:${a.height}`;
  if (a.type === 'pending') return `${bytesToHex(PENDING_TAG)}:${a.uri}`;
  return `${bytesToHex(a.tag)}:${bytesToHex(a.payload)}`;
}

// ---------- lectura / escritura binaria ----------

class Writer {
  private chunks: Uint8Array[] = [];
  bytes(b: Uint8Array): void {
    this.chunks.push(b);
  }
  byte(n: number): void {
    this.chunks.push(new Uint8Array([n]));
  }
  varuint(n: number): void {
    if (!Number.isInteger(n) || n < 0) throw new Error('varuint: entero >= 0');
    let v = n;
    while (true) {
      const b = v & 0x7f;
      v = Math.floor(v / 128);
      if (v === 0) {
        this.byte(b);
        return;
      }
      this.byte(b | 0x80);
    }
  }
  varbytes(b: Uint8Array): void {
    this.varuint(b.length);
    this.bytes(b);
  }
  result(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('OTS: fin de datos inesperado');
    return this.buf[this.pos++] as number;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('OTS: fin de datos inesperado');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    let shift = 1;
    while (true) {
      const b = this.byte();
      value += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return value;
      shift *= 128;
      if (shift > 2 ** 53) throw new Error('OTS: varuint demasiado grande');
    }
  }
  varbytes(max = 4096): Uint8Array {
    const n = this.varuint();
    if (n > max) throw new Error(`OTS: varbytes de ${n} bytes excede el máximo ${max}`);
    return this.bytes(n);
  }
}

function writeOp(w: Writer, op: Op): void {
  w.byte(OP_TAG[op.type]);
  if (op.type === 'append' || op.type === 'prepend') w.varbytes(op.arg);
}

function readOp(r: Reader, tag: number): Op {
  const type = TAG_OP.get(tag);
  if (!type) throw new Error(`OTS: op desconocida 0x${tag.toString(16)}`);
  if (type === 'append' || type === 'prepend') return { type, arg: r.varbytes() };
  return { type } as Op;
}

function writeAttestation(w: Writer, a: Attestation): void {
  const payload = new Writer();
  if (a.type === 'bitcoin') {
    w.bytes(BITCOIN_TAG);
    payload.varuint(a.height);
  } else if (a.type === 'pending') {
    w.bytes(PENDING_TAG);
    payload.varbytes(utf8ToBytes(a.uri));
  } else {
    w.bytes(a.tag);
    payload.bytes(a.payload);
  }
  w.varbytes(payload.result());
}

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8);
  const payload = r.varbytes();
  const pr = new Reader(payload);
  if (bytesToHex(tag) === bytesToHex(BITCOIN_TAG)) {
    const height = pr.varuint();
    if (pr.remaining !== 0) throw new Error('OTS: atestación bitcoin con bytes sobrantes');
    return { type: 'bitcoin', height };
  }
  if (bytesToHex(tag) === bytesToHex(PENDING_TAG)) {
    const uri = new TextDecoder().decode(pr.varbytes());
    if (pr.remaining !== 0) throw new Error('OTS: atestación pending con bytes sobrantes');
    if (!/^https?:\/\/[A-Za-z0-9._\-:/]+$/.test(uri) || !isSupportedCalendarUrl(uri))
      throw new Error('OTS: uri de calendario inválida');
    return { type: 'pending', uri };
  }
  return { type: 'unknown', tag, payload };
}

function writeTimestamp(w: Writer, ts: Timestamp): void {
  if (ts.attestations.length === 0 && ts.ops.length === 0) {
    throw new Error('OTS: un timestamp debe tener al menos una op o una atestación');
  }
  const atts = [...ts.attestations].sort((a, b) =>
    attestationKey(a).localeCompare(attestationKey(b)),
  );
  const ops = [...ts.ops].sort((a, b) => opKey(a.op).localeCompare(opKey(b.op)));
  for (const a of atts.slice(0, -1)) {
    w.byte(0xff);
    w.byte(0x00);
    writeAttestation(w, a);
  }
  const lastAtt = atts.at(-1);
  if (ops.length === 0) {
    w.byte(0x00);
    writeAttestation(w, lastAtt as Attestation);
    return;
  }
  if (lastAtt) {
    w.byte(0xff);
    w.byte(0x00);
    writeAttestation(w, lastAtt);
  }
  for (const { op, next } of ops.slice(0, -1)) {
    w.byte(0xff);
    writeOp(w, op);
    writeTimestamp(w, next);
  }
  const last = ops.at(-1) as { op: Op; next: Timestamp };
  writeOp(w, last.op);
  writeTimestamp(w, last.next);
}

function readTimestamp(r: Reader, msg: Uint8Array, depth = 0): Timestamp {
  if (depth > 256) throw new Error('OTS: anidamiento excesivo');
  const ts = newTimestamp(msg);
  const item = (tag: number): void => {
    if (tag === 0x00) {
      ts.attestations.push(readAttestation(r));
    } else {
      const op = readOp(r, tag);
      const next = readTimestamp(r, applyOp(op, msg), depth + 1);
      ts.ops.push({ op, next });
    }
  };
  let tag = r.byte();
  while (tag === 0xff) {
    item(r.byte());
    tag = r.byte();
  }
  item(tag);
  return ts;
}

export function serializeTimestamp(ts: Timestamp): Uint8Array {
  const w = new Writer();
  writeTimestamp(w, ts);
  return w.result();
}

export function deserializeTimestamp(bytes: Uint8Array, msg: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  const ts = readTimestamp(r, msg);
  if (r.remaining !== 0) throw new Error(`OTS: ${r.remaining} bytes sobrantes`);
  return ts;
}

/** Fichero .ots "detached": cabecera + digest sha256 del fichero + timestamp. */
export function serializeDetached(ts: Timestamp): Uint8Array {
  if (ts.msg.length !== 32)
    throw new Error('OTS: el digest del fichero debe ser sha256 (32 bytes)');
  const w = new Writer();
  w.bytes(OTS_MAGIC);
  w.varuint(OTS_MAJOR_VERSION);
  w.byte(OP_TAG.sha256);
  w.bytes(ts.msg);
  writeTimestamp(w, ts);
  return w.result();
}

export function deserializeDetached(bytes: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  const magic = r.bytes(OTS_MAGIC.length);
  if (bytesToHex(magic) !== bytesToHex(OTS_MAGIC)) throw new Error('OTS: cabecera mágica inválida');
  const version = r.varuint();
  if (version !== OTS_MAJOR_VERSION) throw new Error(`OTS: versión ${version} no soportada`);
  const hashTag = r.byte();
  if (hashTag !== OP_TAG.sha256)
    throw new Error('OTS: solo se admite sha256 como hash del fichero');
  const digest = r.bytes(32);
  const ts = readTimestamp(r, digest);
  if (r.remaining !== 0) throw new Error(`OTS: ${r.remaining} bytes sobrantes`);
  return ts;
}

// ---------- recorrido y verificación ----------

export interface AttestationAt {
  attestation: Attestation;
  /** Mensaje al que se refiere la atestación (para bitcoin: raíz Merkle del bloque, orden interno). */
  msg: Uint8Array;
  /** Subtimestamp que la contiene (para poder sustituir un "pending" por su actualización). */
  holder: Timestamp;
}

export function allAttestations(ts: Timestamp): AttestationAt[] {
  const out: AttestationAt[] = [];
  const walk = (t: Timestamp): void => {
    for (const attestation of t.attestations) out.push({ attestation, msg: t.msg, holder: t });
    for (const { next } of t.ops) walk(next);
  };
  walk(ts);
  return out;
}

/** Raíz Merkle de un bloque tal y como la muestran exploradores y `bitcoin-cli` (big-endian) → orden interno. */
export function displayHashToInternal(displayHex: string): Uint8Array {
  return Uint8Array.from(hexToBytes(displayHex)).reverse();
}

export interface BitcoinCheck {
  height: number;
  merkleRootInternal: string;
  ok: boolean;
}

/**
 * Verifica las atestaciones bitcoin con una función que devuelve la raíz Merkle (hex tal y como
 * la muestra un nodo o explorador) del bloque de esa altura. La confianza queda en esa función:
 * un nodo propio es la referencia; un explorador es una confianza delegada, y hay que decirlo.
 */
export async function verifyBitcoin(
  ts: Timestamp,
  merkleRootOf: (height: number) => Promise<string>,
): Promise<BitcoinCheck[]> {
  const out: BitcoinCheck[] = [];
  for (const { attestation, msg } of allAttestations(ts)) {
    if (attestation.type !== 'bitcoin') continue;
    const expected = displayHashToInternal(await merkleRootOf(attestation.height));
    out.push({
      height: attestation.height,
      merkleRootInternal: bytesToHex(msg),
      ok: bytesToHex(expected) === bytesToHex(msg),
    });
  }
  return out;
}

/** Fusiona `other` (mismo msg) dentro de `target`: unión de atestaciones y ops, recursivo. */
export function mergeTimestamp(target: Timestamp, other: Timestamp): void {
  if (bytesToHex(target.msg) !== bytesToHex(other.msg))
    throw new Error('OTS: merge de mensajes distintos');
  for (const a of other.attestations) {
    if (!target.attestations.some((t) => attestationKey(t) === attestationKey(a))) {
      target.attestations.push(a);
    }
  }
  for (const { op, next } of other.ops) {
    const mine = addOp(target, op);
    mergeTimestamp(mine, next);
  }
}

// ---------- calendarios ----------

export type { FetchLike } from '../../shared/http.ts';

/** Envía un digest al calendario; devuelve el timestamp (normalmente con una atestación "pending"). */
export async function calendarSubmit(
  calendarUrl: string,
  digest: Uint8Array,
  fetchImpl: FetchLike = fetch,
): Promise<Timestamp> {
  assertCalendarUrl(calendarUrl);
  const res = await fetchWithTimeout(fetchImpl, `${calendarUrl.replace(/\/$/, '')}/digest`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.opentimestamps.v1',
      'Content-Type': 'application/octet-stream',
    },
    body: digest,
  });
  if (!res.ok) throw new Error(`calendario ${redactUrl(calendarUrl)}: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return deserializeTimestamp(body, digest);
}

/** Pide al calendario la actualización de un compromiso pendiente. null si aún no está en Bitcoin. */
export async function calendarUpgrade(
  calendarUrl: string,
  commitment: Uint8Array,
  fetchImpl: FetchLike = fetch,
): Promise<Timestamp | null> {
  assertCalendarUrl(calendarUrl);
  const res = await fetchWithTimeout(
    fetchImpl,
    `${calendarUrl.replace(/\/$/, '')}/timestamp/${bytesToHex(commitment)}`,
    { headers: { Accept: 'application/vnd.opentimestamps.v1' } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`calendario ${redactUrl(calendarUrl)}: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return deserializeTimestamp(body, commitment);
}

/**
 * Sustituye cada atestación "pending" por lo que su calendario devuelva (si ya está en Bitcoin).
 * Devuelve cuántas se actualizaron. Idempotente: las que siguen pendientes se quedan como están.
 */
export async function upgrade(ts: Timestamp, fetchImpl: FetchLike = fetch): Promise<number> {
  let upgraded = 0;
  for (const { attestation, msg, holder } of allAttestations(ts)) {
    if (attestation.type !== 'pending') continue;
    const fresh = await calendarUpgrade(attestation.uri, msg, fetchImpl);
    if (!fresh) continue;
    mergeTimestamp(holder, fresh);
    holder.attestations = holder.attestations.filter((a) => a !== attestation);
    upgraded++;
  }
  return upgraded;
}

/** true si alguna rama termina en una atestación bitcoin. */
export function isComplete(ts: Timestamp): boolean {
  return allAttestations(ts).some((a) => a.attestation.type === 'bitcoin');
}
