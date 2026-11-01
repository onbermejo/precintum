/**
 * Capa de testigos: publicar un evento en N relays de M, con outbox y reintentos.
 *
 * Flujo: `enqueue(event)` archiva el evento en el append-only local y lo mete en la outbox.
 * `runOnce(now)` toma las entradas vencidas, publica en los relays que aún no lo han
 * aceptado, registra cada respuesta como telemetría y decide: publicado (quórum), pendiente
 * (con backoff) o fallido (todos los rechazos son definitivos o se agotaron los intentos).
 *
 * Nada de esto es evidencia para terceros: es la operativa que garantiza que lo que hay que
 * publicar acaba publicado, y que sabemos en qué testigos está.
 */
import type { NostrEvent } from '../domain/nostr/event.ts';
import {
  backoffSeconds,
  classifyFailure,
  DEFAULT_BACKOFF,
  type FailureClass,
  quorumMet,
} from '../domain/witness/policy.ts';
import type { WitnessRelay, WitnessStore } from '../domain/witness/witness-store.ts';
import type { AppendOnlyFile } from '../infra/witness/append-only-file.ts';
import type { Logger } from '../shared/logger.ts';
import { relayUrlKey } from '../shared/relay-url.ts';

export interface PublishOutcome {
  relay: string;
  ok: boolean;
  code: string;
  message: string;
  failure?: FailureClass;
}

function uniqueRelays(relays: readonly WitnessRelay[]): WitnessRelay[] {
  const unique = new Map<string, WitnessRelay>();
  for (const relay of relays) {
    const key = relayUrlKey(relay.url);
    if (!unique.has(key)) unique.set(key, relay);
  }
  return [...unique.values()];
}

/** Publica en las direcciones únicas y devuelve un resultado por relay. */
export async function publishToRelays(
  event: NostrEvent,
  relays: readonly WitnessRelay[],
): Promise<PublishOutcome[]> {
  const targets = uniqueRelays(relays);
  const settled = await Promise.allSettled(targets.map((r) => r.publish(event)));
  return settled.map((s, i) => {
    const relay = targets[i]?.url ?? `relay-${i}`;
    if (s.status === 'fulfilled') return { relay, ok: true, code: 'ok', message: s.value.message };
    const err = s.reason as { code?: unknown; detail?: unknown; message?: unknown };
    const code = typeof err?.code === 'string' ? err.code : 'unknown';
    // `detail` es el texto literal del relay (con su prefijo estandarizado); `message` lleva
    // adornos ("[relay] rechazado: …") y no sirve para clasificar.
    const message =
      typeof err?.detail === 'string' && err.detail !== ''
        ? err.detail
        : typeof err?.message === 'string'
          ? err.message
          : String(s.reason);
    return { relay, ok: false, code, message, failure: classifyFailure(code, message) };
  });
}

export interface WitnessWorkerDeps {
  store: WitnessStore;
  relays: readonly WitnessRelay[];
  /** Testigos que deben aceptar para dar el evento por publicado (N de M). */
  quorum: number;
  archive?: AppendOnlyFile;
  now?: () => number;
  random?: () => number;
  maxAttempts?: number;
  batchSize?: number;
  log?: Logger;
}

export interface RunSummary {
  processed: number;
  published: number;
  pending: number;
  failed: number;
}

export class WitnessWorker {
  private readonly deps: Required<Pick<WitnessWorkerDeps, 'store' | 'relays' | 'quorum'>> &
    WitnessWorkerDeps;

  constructor(deps: WitnessWorkerDeps) {
    quorumMet(0, deps.quorum); // valida el quórum
    const relays = uniqueRelays(deps.relays);
    if (deps.quorum > relays.length) {
      throw new Error(`quórum ${deps.quorum} imposible con ${relays.length} relays únicos`);
    }
    this.deps = { ...deps, relays };
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Encola y archiva. Idempotente por id de evento. Devuelve true si es nuevo. */
  async enqueue(event: NostrEvent): Promise<boolean> {
    const isNew = await this.deps.store.outbox.enqueue(event, this.now());
    if (isNew) await this.archive(event);
    return isNew;
  }

  /**
   * Solo el testigo local: lo llama el cierre de lotes tras confirmar la transacción que ya dejó
   * el evento en la outbox (el archivo no participa en transacciones de base de datos).
   */
  async archive(event: NostrEvent): Promise<void> {
    if (this.deps.archive) await this.deps.archive.append(event);
  }

  /** Un pase del worker. Se llama periódicamente (o a mano desde la CLI). */
  async runOnce(now: number = this.now()): Promise<RunSummary> {
    const summary: RunSummary = { processed: 0, published: 0, pending: 0, failed: 0 };
    const due = await this.deps.store.outbox.due(now, this.deps.batchSize ?? 50);
    for (const entry of due) {
      summary.processed++;
      const status = await this.attempt(entry.eventId, entry.event, entry.attempts, now);
      summary[status]++;
    }
    return summary;
  }

  private async attempt(
    eventId: string,
    event: NostrEvent,
    attemptsSoFar: number,
    now: number,
  ): Promise<'published' | 'pending' | 'failed'> {
    const { store, relays, quorum } = this.deps;
    const configured = new Set(relays.map((r) => relayUrlKey(r.url)));
    const acceptedRelays = new Set<string>();
    for (const url of await store.publications.acceptedRelays(eventId)) {
      let key: string;
      try {
        key = relayUrlKey(url);
      } catch {
        continue;
      }
      // Se conserva el historial, pero solo votan direcciones de la lista actual.
      if (configured.has(key)) acceptedRelays.add(key);
    }
    const targets = relays.filter((r) => !acceptedRelays.has(relayUrlKey(r.url)));
    const outcomes = targets.length ? await publishToRelays(event, targets) : [];

    for (const o of outcomes) {
      await store.publications.record({
        eventId,
        relay: o.relay,
        accepted: o.ok,
        code: o.code,
        message: o.message,
        at: now,
      });
      if (o.ok) acceptedRelays.add(relayUrlKey(o.relay));
    }

    const accepted = acceptedRelays.size;
    const attempts = attemptsSoFar + 1;
    const retryable = outcomes.some((o) => !o.ok && o.failure === 'retry');
    const maxAttempts = this.deps.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts;

    if (quorumMet(accepted, quorum)) {
      await store.outbox.update(eventId, { status: 'published', attempts, nextAttemptAt: now });
      this.deps.log?.info({ eventId, accepted, quorum }, 'evento publicado con quórum');
      return 'published';
    }
    if (!retryable || attempts >= maxAttempts) {
      await store.outbox.update(eventId, { status: 'failed', attempts, nextAttemptAt: now });
      await store.alerts.raise(
        'publish_failed',
        { eventId, accepted, quorum, attempts, outcomes },
        now,
      );
      this.deps.log?.error({ eventId, accepted, quorum, attempts }, 'evento sin quórum: fallido');
      return 'failed';
    }
    const delay = backoffSeconds(attempts, this.deps.random);
    await store.outbox.update(eventId, { status: 'pending', attempts, nextAttemptAt: now + delay });
    this.deps.log?.warn(
      { eventId, accepted, quorum, attempts, delay },
      'sin quórum; se reintentará',
    );
    return 'pending';
  }
}
