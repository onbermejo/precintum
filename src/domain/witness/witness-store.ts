/**
 * Puertos de la capa de testigos.
 *
 * Patrón outbox: lo que hay que publicar se persiste ANTES de intentar publicarlo. Un worker
 * lo reintenta con backoff. Si el proceso muere a mitad, nada se pierde: la outbox es la
 * cola y la base de datos es la fuente de verdad de "qué se ha publicado dónde".
 */
import type { NostrEvent } from '../nostr/event.ts';

export type OutboxStatus = 'pending' | 'published' | 'failed';

export interface OutboxEntry {
  eventId: string;
  event: NostrEvent;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: OutboxStatus;
}

export interface OutboxStore {
  /** Idempotente por id de evento: encolar dos veces el mismo evento no crea dos entradas. */
  enqueue(event: NostrEvent, now: number): Promise<boolean>;
  /** Entradas pendientes cuyo próximo intento ya ha vencido, ordenadas por vencimiento. */
  due(now: number, limit: number): Promise<OutboxEntry[]>;
  get(eventId: string): Promise<OutboxEntry | null>;
  update(
    eventId: string,
    patch: { status: OutboxStatus; attempts: number; nextAttemptAt: number },
  ): Promise<void>;
  counts(): Promise<Record<OutboxStatus, number>>;
}

/**
 * Telemetría de publicación: qué contestó cada relay a cada evento. Es lo que el operador
 * registró; NO es evidencia para terceros por sí sola. Sirve para el quórum, los
 * reintentos y el panel de continuidad.
 */
export interface PublicationRecord {
  eventId: string;
  relay: string;
  accepted: boolean;
  code: string;
  message: string;
  at: number;
}

export interface PublicationLog {
  record(p: PublicationRecord): Promise<void>;
  acceptedRelays(eventId: string): Promise<string[]>;
  forEvent(eventId: string): Promise<PublicationRecord[]>;
}

/** Verificación diferida: ¿el testigo sigue sirviendo el evento? */
export interface CheckRecord {
  eventId: string;
  relay: string;
  present: boolean;
  at: number;
}

export interface CheckLog {
  record(c: CheckRecord): Promise<void>;
  latest(eventId: string): Promise<CheckRecord[]>;
}

export interface Alert {
  id: number;
  kind: string;
  detail: Record<string, unknown>;
  at: number;
}

export interface AlertLog {
  raise(kind: string, detail: Record<string, unknown>, at: number): Promise<void>;
  list(limit: number): Promise<Alert[]>;
}

export interface WitnessStore {
  readonly outbox: OutboxStore;
  readonly publications: PublicationLog;
  readonly checks: CheckLog;
  readonly alerts: AlertLog;
  transaction<T>(fn: (tx: WitnessStore) => Promise<T>): Promise<T>;
}

/** Lo mínimo que el servicio de testigos necesita de un relay. `RelayClient` lo cumple. */
export interface WitnessRelay {
  readonly url: string;
  publish(event: NostrEvent): Promise<{ message: string }>;
  query(filters: Array<Record<string, unknown>>): Promise<NostrEvent[]>;
}
