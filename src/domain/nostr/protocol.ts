/**
 * Mensajes del protocolo cliente <-> relay. Todo viaja por WebSocket como arrays JSON
 * cuyo primer elemento es el tipo.
 *
 *   cliente -> relay        relay -> cliente
 *   ["EVENT", <event>]      ["EVENT", <sub_id>, <event>]
 *   ["REQ", <sub_id>, f…]   ["OK", <event_id>, <true|false>, <mensaje>]
 *   ["CLOSE", <sub_id>]     ["EOSE", <sub_id>, <hints?>]      (hints: NIP-67)
 *   ["AUTH", <event>]       ["CLOSED", <sub_id>, <mensaje>]
 *   ["COUNT", <sub_id>, f…] ["NOTICE", <mensaje>]
 *                           ["AUTH", <challenge>]              (NIP-42)
 *                           ["COUNT", <sub_id>, {count}]       (NIP-45)
 *
 * NIP-01 define los tres primeros de cada columna y EOSE/CLOSED/NOTICE. AUTH y COUNT
 * los añaden NIP-42 y NIP-45 y un relay legítimo puede enviarlos en cualquier momento:
 * hay que reconocerlos, no descartarlos como "mensaje raro".
 *
 * Validamos con zod TODO lo que llega del relay: un relay es un tercero no confiable.
 */
import { z } from 'zod';
import type { NostrEvent } from './event.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Filtro de suscripción (NIP-01). Los filtros los construimos nosotros, no los recibimos
 * de terceros, así que basta con el tipo: no hace falta validarlos con zod.
 */
export type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
} & {
  /** Tags indexadas: "#e", "#p", "#d", "#t", ... */
  [tag: `#${string}`]: string[];
};

export const eventSchema = z.object({
  id: hex64,
  pubkey: hex64,
  created_at: z.number().int(),
  kind: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

export const relayMessageSchema = z.union([
  z.tuple([z.literal('EVENT'), z.string(), eventSchema]),
  z.tuple([z.literal('OK'), hex64, z.boolean(), z.string()]),
  // NIP-67 permite un tercer elemento con pistas de paginación; NIP-01 manda ignorar
  // elementos extra que no se entiendan.
  z.tuple([z.literal('EOSE'), z.string()]).rest(z.unknown()),
  z.tuple([z.literal('CLOSED'), z.string(), z.string()]),
  z.tuple([z.literal('NOTICE'), z.string()]),
  z.tuple([z.literal('AUTH'), z.string()]),
  z.tuple([
    z.literal('COUNT'),
    z.string(),
    z.object({ count: z.number().int().nonnegative() }).loose(),
  ]),
]);

export type RelayMessage = z.infer<typeof relayMessageSchema>;

export type ClientMessage =
  | ['EVENT', NostrEvent]
  | ['REQ', string, ...Filter[]]
  | ['CLOSE', string]
  | ['AUTH', NostrEvent];

/**
 * Prefijos estandarizados del mensaje de OK y CLOSED (NIP-01 + NIP-42):
 *   duplicate: | pow: | blocked: | rate-limited: | invalid: | restricted: | mute: |
 *   auth-required: | error:
 * Devuelve el prefijo sin los dos puntos, o null si el mensaje no lleva ninguno.
 * La capa de testigos decide con esto qué se reintenta (rate-limited) y qué no (blocked).
 */
export function okPrefix(message: string): string | null {
  const m = /^([a-z][a-z-]*):/.exec(message);
  return m?.[1] ?? null;
}

/**
 * ¿Cumple `event` el filtro? Reglas NIP-01:
 *  - dentro de un filtro, cada campo es un AND; dentro de un campo, la lista es un OR
 *  - ids/authors se comparan por igualdad exacta (NIP-01 exige 64 hex; los prefijos antiguos están
 *    prohibidos, no solo deprecados)
 *  - "#x": [v1, v2] casa si el evento tiene alguna tag ["x", v1] o ["x", v2]
 */
export function matchesFilter(event: NostrEvent, f: Filter): boolean {
  if (f.ids && !f.ids.includes(event.id)) return false;
  if (f.authors && !f.authors.includes(event.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(event.kind)) return false;
  if (f.since !== undefined && event.created_at < f.since) return false;
  if (f.until !== undefined && event.created_at > f.until) return false;
  for (const [key, values] of Object.entries(f)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const tagName = key.slice(1);
    const wanted = values as string[];
    const has = event.tags.some(
      (t) => t[0] === tagName && t[1] !== undefined && wanted.includes(t[1]),
    );
    if (!has) return false;
  }
  return true;
}

export function matchesAnyFilter(event: NostrEvent, filters: Filter[]): boolean {
  return filters.some((f) => matchesFilter(event, f));
}
