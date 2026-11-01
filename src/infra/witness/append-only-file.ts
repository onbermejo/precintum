/**
 * Archivo append-only: el tercer tipo de testigo, el que el operador controla y el que
 * sobrevive si todos los relays fallan.
 *
 * Un fichero JSONL en el que cada línea es {seq, prev, hash, event}: `prev` es el hash de la
 * línea anterior y `hash` el de esta (con dominio). Solo se anexa; nunca se reescribe. Es un
 * testigo débil frente al propio operador (puede regenerar el fichero entero), pero:
 *  - detecta corrupción accidental y ediciones a mano,
 *  - da un orden total local de todo lo publicado,
 *  - y es lo que se entrega al auditor junto con las pruebas de tiempo cuando un relay
 *    público deja de servir un evento.
 * La prueba fuerte frente al operador la dan los relays externos y el anclaje.
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize, DOMAINS, hashWithDomain } from '../../domain/evidence/hash.ts';
import { GENESIS } from '../../domain/evidence/receipt.ts';
import { type NostrEvent, verifyEvent } from '../../domain/nostr/event.ts';
import { eventSchema } from '../../domain/nostr/protocol.ts';

export interface ArchiveLine {
  seq: number;
  prev: string;
  hash: string;
  event: NostrEvent;
}

export type ArchiveVerdict =
  | { ok: true; length: number; head: string | null }
  | { ok: false; at: number; reason: string };

/** Hash de una línea: dominio + seq + prev + id del evento (el evento ya va firmado). */
function lineHash(seq: number, prev: string, event: NostrEvent): string {
  return hashWithDomain(
    DOMAINS.archive,
    utf8ToBytes(canonicalize({ seq, prev, event_id: event.id, pubkey: event.pubkey })),
  );
}

export class AppendOnlyFile {
  private readonly path: string;
  private head: { seq: number; hash: string } | null = null;
  private loaded = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Lee el fichero (si existe) para conocer la cabeza. Idempotente. */
  private async load(): Promise<ArchiveLine[]> {
    const lines = await this.readAll();
    const last = lines.at(-1);
    this.head = last ? { seq: last.seq, hash: last.hash } : null;
    this.loaded = true;
    return lines;
  }

  async readAll(): Promise<ArchiveLine[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as ArchiveLine);
  }

  /** Anexa un evento firmado. Devuelve su posición y hash en el archivo. */
  async append(event: NostrEvent): Promise<{ seq: number; hash: string }> {
    const v = verifyEvent(event);
    if (!v.ok) throw new Error(`no se archiva un evento inválido: ${v.reason}`);
    if (!this.loaded) await this.load();
    const seq = (this.head?.seq ?? 0) + 1;
    const prev = this.head?.hash ?? GENESIS;
    const hash = lineHash(seq, prev, event);
    const line: ArchiveLine = { seq, prev, hash, event };
    await mkdir(dirname(this.path), { recursive: true });
    // Anexar y forzar la escritura a disco antes de dar el evento por archivado: si el proceso o
    // la máquina caen justo después, la línea está; sin esto podría quedarse en la caché del SO.
    const fh = await open(this.path, 'a');
    try {
      await fh.appendFile(`${JSON.stringify(line)}\n`, 'utf8');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    this.head = { seq, hash };
    return { seq, hash };
  }

  /** Re-verifica todo el archivo: encadenado, hashes y firmas de los eventos. */
  async verify(): Promise<ArchiveVerdict> {
    const lines = await this.readAll();
    let prev = GENESIS;
    let expected = 1;
    for (const line of lines) {
      if (line.seq !== expected) {
        return { ok: false, at: expected, reason: `seq ${line.seq}, se esperaba ${expected}` };
      }
      if (line.prev !== prev) {
        return { ok: false, at: line.seq, reason: 'prev no coincide con la línea anterior' };
      }
      const parsed = eventSchema.safeParse(line.event);
      if (!parsed.success || !verifyEvent(parsed.data).ok) {
        return { ok: false, at: line.seq, reason: 'evento archivado inválido o alterado' };
      }
      if (lineHash(line.seq, line.prev, parsed.data) !== line.hash) {
        return { ok: false, at: line.seq, reason: 'hash de línea no coincide (línea alterada)' };
      }
      prev = line.hash;
      expected++;
    }
    return { ok: true, length: lines.length, head: lines.length ? prev : null };
  }
}
