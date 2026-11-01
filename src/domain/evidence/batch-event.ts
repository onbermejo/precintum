/**
 * El evento de lote: lo ÚNICO que Precintum publica en relays públicos.
 *
 * Un lote agrupa los recibos de una ventana temporal fija (p. ej. una hora) en un árbol
 * Merkle y publica su raíz. Se publica UN evento por ventana, también si el lote
 * está vacío (latido): así la cadencia on-relay no revela actividad, y la ausencia de un lote
 * es detectable.
 *
 *   kind     7676  (regular: los relays lo guardan tal cual; no reemplazable, no borrable
 *                   salvo NIP-09, que el verificador trata como alerta). Sin asignar en el
 *                   README de NIPs a 2026-09-02. Provisional hasta registrarlo.
 *   content  raíz Merkle del lote (hex 64)
 *   created_at  instante de cierre: nunca anterior al fin de la ventana
 *   tags     ["v","1"]                 versión del formato
 *            ["seq","<n>"]             número de lote, monotónico y sin huecos
 *            ["prev","<raíz anterior>"] enlaza los lotes entre sí (o GENESIS)
 *            ["window","<ini>","<fin>"] ventana en segundos unix, [ini, fin)
 *            ["policy","<hash>"]        política vigente en la ventana
 *            ["count","<compromiso>"]   sha256 con dominio de "recuento:sal"; la sal y el
 *                                       recuento se revelan solo al auditor en el export
 *
 * Lo que NO lleva: hashes de recibos, recuentos en claro, ni tag ["client", …].
 */
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { isHex64 } from '../../shared/hex.ts';
import type { Identity } from '../identity/keys.ts';
import { type NostrEvent, signEvent } from '../nostr/event.ts';
import { DOMAINS, hashWithDomain } from './hash.ts';

export const BATCH_KIND = 7676;
export const BATCH_VERSION = '1';

export interface BatchData {
  seq: number;
  root: string;
  prevRoot: string;
  windowStart: number;
  windowEnd: number;
  policy: string;
  countCommitment: string;
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const intString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number);

/** Compromiso del recuento: revela que el operador fijó un número sin decir cuál. */
export function commitCount(count: number, salt: string): string {
  if (!Number.isInteger(count) || count < 0) throw new Error('count debe ser un entero >= 0');
  if (!isHex64(salt)) throw new Error('salt debe ser hex de 32 bytes');
  return hashWithDomain(DOMAINS.count, utf8ToBytes(`${count}:${salt}`));
}

export function buildBatchEvent(
  data: BatchData,
  identity: Identity,
  createdAt: number = data.windowEnd,
): NostrEvent {
  const parsed = batchDataSchema.safeParse(data);
  if (!parsed.success) throw new Error(`lote inválido: ${parsed.error.issues[0]?.message}`);
  if (createdAt < data.windowEnd) {
    throw new Error('lote inválido: created_at no puede ser anterior al fin de la ventana');
  }
  return signEvent(
    {
      kind: BATCH_KIND,
      created_at: createdAt,
      tags: [
        ['v', BATCH_VERSION],
        ['seq', String(data.seq)],
        ['prev', data.prevRoot],
        ['window', String(data.windowStart), String(data.windowEnd)],
        ['policy', data.policy],
        ['count', data.countCommitment],
      ],
      content: data.root,
    },
    identity,
  );
}

const batchDataSchema = z
  .object({
    seq: z.number().int().positive(),
    root: hex64,
    prevRoot: hex64,
    windowStart: z.number().int().nonnegative(),
    windowEnd: z.number().int().nonnegative(),
    policy: hex64,
    countCommitment: hex64,
  })
  .refine((d) => d.windowStart < d.windowEnd, {
    message: 'la ventana debe ser [ini, fin) con ini < fin',
  });

export type BatchParse = { ok: true; data: BatchData } | { ok: false; reason: string };

/**
 * Extrae y valida los datos de un evento de lote. No verifica la firma (eso lo hace
 * `verifyEvent` al recibirlo del relay) ni la coherencia con otros lotes.
 */
/** Etiquetas del formato: cada una aparece exactamente una vez. */
export const BATCH_TAGS = ['v', 'seq', 'prev', 'window', 'policy', 'count'] as const;

export function parseBatchEvent(event: NostrEvent): BatchParse {
  if (event.kind !== BATCH_KIND)
    return { ok: false, reason: `kind ${event.kind}, se esperaba ${BATCH_KIND}` };
  // Con dos ["seq", …] distintas, dos verificadores podrían leer valores distintos del mismo
  // evento firmado. Las etiquetas del formato son únicas; las ajenas se ignoran.
  for (const name of BATCH_TAGS) {
    const n = event.tags.filter((t) => t[0] === name).length;
    if (n === 0) return { ok: false, reason: `falta la tag ${name}` };
    if (n > 1) return { ok: false, reason: `tag ${name} repetida (${n} veces)` };
  }
  const tag = (name: string): string[] | undefined => event.tags.find((t) => t[0] === name);
  const v = tag('v')?.[1];
  if (v !== BATCH_VERSION)
    return { ok: false, reason: `versión ${v ?? 'ausente'}, se esperaba ${BATCH_VERSION}` };
  const seq = intString.safeParse(tag('seq')?.[1]);
  const window = tag('window');
  if (window !== undefined && window.length !== 3) {
    return { ok: false, reason: 'la tag window debe ser ["window", ini, fin]' };
  }
  const start = intString.safeParse(window?.[1]);
  const end = intString.safeParse(window?.[2]);
  if (!seq.success || !start.success || !end.success) {
    return { ok: false, reason: 'tags seq/window ausentes o no numéricas' };
  }
  const candidate = {
    seq: seq.data,
    root: event.content,
    prevRoot: tag('prev')?.[1] ?? '',
    windowStart: start.data,
    windowEnd: end.data,
    policy: tag('policy')?.[1] ?? '',
    countCommitment: tag('count')?.[1] ?? '',
  };
  const parsed = batchDataSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `${issue?.path.join('.') || 'lote'}: ${issue?.message}` };
  }
  if (event.created_at < parsed.data.windowEnd) {
    return {
      ok: false,
      reason: `created_at ${event.created_at} anterior al fin de la ventana ${parsed.data.windowEnd}`,
    };
  }
  return { ok: true, data: parsed.data };
}
