/**
 * Verificación diferida de testigos.
 *
 * "El testigo aceptó" (OK, telemetría) y "el testigo conserva" (un REQ por id, ahora) son
 * cosas distintas. Esta pieza pregunta a cada relay si sigue sirviendo un evento, registra
 * la respuesta y levanta alerta si un relay que lo había aceptado contesta que ya no lo tiene.
 * Un relay que no contesta no dice nada sobre la retención: se informa como "sin respuesta",
 * sin anotar ausencia ni alertar, para evitar falsos `witness_lost`.
 *
 * También busca borrados NIP-09 (`kind 5`) firmados por el propio agente o por la clave raíz
 * del operador, y los que apuntan al directorio de claves (`["a","37676:<raíz>:precintum/keys"]`):
 * para Precintum son un ataque (clave robada u operador deshonesto), nunca una orden legítima.
 */
import { KEY_DIRECTORY_D, KEY_DIRECTORY_KIND } from '../domain/evidence/key-directory.ts';
import type { NostrEvent } from '../domain/nostr/event.ts';
import type { WitnessRelay, WitnessStore } from '../domain/witness/witness-store.ts';
import { relayUrlKey } from '../shared/relay-url.ts';

export type PresenceStatus = 'present' | 'absent' | 'unreachable';

export interface PresenceResult {
  relay: string;
  /** present: lo sirve; absent: contestó y no lo tiene; unreachable: no contestó (no se sabe). */
  status: PresenceStatus;
  /** Atajo: `status === 'present'`. */
  present: boolean;
  /** true si el relay había aceptado el evento y ahora contesta que no lo tiene. */
  lost: boolean;
}

export async function checkPresence(
  eventId: string,
  relays: readonly WitnessRelay[],
  store: WitnessStore,
  now: number,
): Promise<PresenceResult[]> {
  const accepted = new Set<string>();
  for (const url of await store.publications.acceptedRelays(eventId)) {
    try {
      accepted.add(relayUrlKey(url));
    } catch {
      // Un registro histórico inválido no identifica un testigo.
    }
  }
  return Promise.all(
    relays.map(async (relay): Promise<PresenceResult> => {
      let present: boolean;
      try {
        const found = await relay.query([{ ids: [eventId] }]);
        present = found.some((e) => e.id === eventId);
      } catch {
        // Sin respuesta no hay dato: ni se anota como ausencia ni se alerta. El siguiente pase
        // volverá a preguntar; un relay caído mucho tiempo se ve en la telemetría de publicación.
        return { relay: relay.url, status: 'unreachable', present: false, lost: false };
      }
      await store.checks.record({ eventId, relay: relay.url, present, at: now });
      const lost = accepted.has(relayUrlKey(relay.url)) && !present;
      if (lost) await store.alerts.raise('witness_lost', { eventId, relay: relay.url }, now);
      return { relay: relay.url, status: present ? 'present' : 'absent', present, lost };
    }),
  );
}

export interface DeletionScope {
  /** Clave del agente: firma los lotes. */
  agentPubkey: string;
  /** Clave raíz del operador: firma el directorio de claves. Opcional. */
  rootPubkey?: string | undefined;
}

/** Dirección NIP-01 del directorio de claves de una raíz: `kind:pubkey:d`. */
export function keyDirectoryAddress(rootPubkey: string): string {
  return `${KEY_DIRECTORY_KIND}:${rootPubkey}:${KEY_DIRECTORY_D}`;
}

/** Filtros de la búsqueda: kind 5 de las claves vigiladas y los que apuntan al directorio. */
export function deletionFilters(
  scope: DeletionScope,
  since: number,
): Array<Record<string, unknown>> {
  const authors = scope.rootPubkey ? [scope.agentPubkey, scope.rootPubkey] : [scope.agentPubkey];
  const filters: Array<Record<string, unknown>> = [{ kinds: [5], authors, since }];
  if (scope.rootPubkey) {
    filters.push({ kinds: [5], '#a': [keyDirectoryAddress(scope.rootPubkey)], since });
  }
  return filters;
}

function tagValues(e: NostrEvent, name: string): string[] {
  return e.tags.flatMap((t) => {
    const v = t[1];
    return t[0] === name && v !== undefined ? [v] : [];
  });
}

/**
 * Busca eventos `kind 5` de las claves vigiladas en todos los relays desde `since`. Cada uno
 * distinto genera una alerta `deletion_request` (una sola vez por id de evento de borrado) con
 * el autor y lo que pide borrar: ids (`e`), direcciones (`a`) y kinds (`k`).
 */
export async function detectDeletions(
  scope: string | DeletionScope,
  relays: readonly WitnessRelay[],
  store: WitnessStore,
  since: number,
  now: number,
): Promise<NostrEvent[]> {
  const s: DeletionScope = typeof scope === 'string' ? { agentPubkey: scope } : scope;
  const filters = deletionFilters(s, since);
  const seen = new Map<string, NostrEvent>();
  await Promise.all(
    relays.map(async (relay) => {
      try {
        const found = await relay.query(filters);
        for (const e of found) if (e.kind === 5 && !seen.has(e.id)) seen.set(e.id, e);
      } catch {
        // Un relay caído no impide detectar en los demás.
      }
    }),
  );
  const known = new Set(
    (await store.alerts.list(1_000))
      .filter((a) => a.kind === 'deletion_request')
      .map((a) => String(a.detail.deletionEventId)),
  );
  for (const e of seen.values()) {
    if (known.has(e.id)) continue;
    await store.alerts.raise(
      'deletion_request',
      {
        deletionEventId: e.id,
        author: e.pubkey,
        targets: tagValues(e, 'e'),
        addresses: tagValues(e, 'a'),
        kinds: tagValues(e, 'k'),
        createdAt: e.created_at,
      },
      now,
    );
  }
  return [...seen.values()];
}
