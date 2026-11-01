/**
 * Adaptador PostgreSQL de los puertos de testigos (outbox, telemetría, checks, alertas).
 * Mismo SQL para PGlite y pg. Los BIGINT se leen con ::float8 (ver sql-evidence-store.ts).
 */
import type { NostrEvent } from '../../domain/nostr/event.ts';
import { eventSchema } from '../../domain/nostr/protocol.ts';
import type {
  Alert,
  AlertLog,
  CheckLog,
  CheckRecord,
  OutboxEntry,
  OutboxStatus,
  OutboxStore,
  PublicationLog,
  PublicationRecord,
  WitnessStore,
} from '../../domain/witness/witness-store.ts';
import type { SqlClient } from './sql-client.ts';

type OutboxRow = {
  event_id: string;
  event: unknown;
  enqueued_at: number;
  attempts: number;
  next_attempt_at: number;
  status: OutboxStatus;
};

const OUTBOX_COLUMNS =
  'event_id, event, enqueued_at::float8 AS enqueued_at, attempts::int AS attempts, next_attempt_at::float8 AS next_attempt_at, status';

function rowToEntry(row: OutboxRow): OutboxEntry {
  const event: NostrEvent = eventSchema.parse(
    typeof row.event === 'string' ? JSON.parse(row.event) : row.event,
  );
  return {
    eventId: row.event_id,
    event,
    enqueuedAt: row.enqueued_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    status: row.status,
  };
}

class SqlOutboxStore implements OutboxStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async enqueue(event: NostrEvent, now: number): Promise<boolean> {
    const rows = await this.db.query<{ event_id: string }>(
      `INSERT INTO witness_outbox (event_id, event, enqueued_at, attempts, next_attempt_at, status)
       VALUES ($1, $2::jsonb, $3::bigint, 0, $3::bigint, 'pending')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, JSON.stringify(event), now],
    );
    return rows.length === 1;
  }

  async due(now: number, limit: number): Promise<OutboxEntry[]> {
    const rows = await this.db.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM witness_outbox
       WHERE status = 'pending' AND next_attempt_at <= $1::bigint
       ORDER BY next_attempt_at, event_id LIMIT $2::int`,
      [now, limit],
    );
    return rows.map(rowToEntry);
  }

  async get(eventId: string): Promise<OutboxEntry | null> {
    const rows = await this.db.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM witness_outbox WHERE event_id = $1`,
      [eventId],
    );
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async update(
    eventId: string,
    patch: { status: OutboxStatus; attempts: number; nextAttemptAt: number },
  ): Promise<void> {
    await this.db.query(
      `UPDATE witness_outbox SET status = $2, attempts = $3::int, next_attempt_at = $4::bigint
       WHERE event_id = $1`,
      [eventId, patch.status, patch.attempts, patch.nextAttemptAt],
    );
  }

  async counts(): Promise<Record<OutboxStatus, number>> {
    const rows = await this.db.query<{ status: OutboxStatus; n: number }>(
      'SELECT status, count(*)::float8 AS n FROM witness_outbox GROUP BY status',
    );
    const out: Record<OutboxStatus, number> = { pending: 0, published: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }
}

class SqlPublicationLog implements PublicationLog {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async record(p: PublicationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO witness_publications (event_id, relay, accepted, code, message, at)
       VALUES ($1, $2, $3, $4, $5, $6::bigint)
       ON CONFLICT (event_id, relay) DO UPDATE
         SET accepted = EXCLUDED.accepted, code = EXCLUDED.code, message = EXCLUDED.message, at = EXCLUDED.at`,
      [p.eventId, p.relay, p.accepted, p.code, p.message, p.at],
    );
  }

  async acceptedRelays(eventId: string): Promise<string[]> {
    const rows = await this.db.query<{ relay: string }>(
      'SELECT relay FROM witness_publications WHERE event_id = $1 AND accepted ORDER BY relay',
      [eventId],
    );
    return rows.map((r) => r.relay);
  }

  async forEvent(eventId: string): Promise<PublicationRecord[]> {
    const rows = await this.db.query<{
      event_id: string;
      relay: string;
      accepted: boolean;
      code: string;
      message: string;
      at: number;
    }>(
      'SELECT event_id, relay, accepted, code, message, at::float8 AS at FROM witness_publications WHERE event_id = $1 ORDER BY relay',
      [eventId],
    );
    return rows.map((r) => ({
      eventId: r.event_id,
      relay: r.relay,
      accepted: r.accepted,
      code: r.code,
      message: r.message,
      at: r.at,
    }));
  }
}

class SqlCheckLog implements CheckLog {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async record(c: CheckRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO witness_checks (event_id, relay, present, at) VALUES ($1, $2, $3, $4::bigint)
       ON CONFLICT (event_id, relay, at) DO NOTHING`,
      [c.eventId, c.relay, c.present, c.at],
    );
  }

  async latest(eventId: string): Promise<CheckRecord[]> {
    const rows = await this.db.query<{ relay: string; present: boolean; at: number }>(
      `SELECT DISTINCT ON (relay) relay, present, at::float8 AS at
       FROM witness_checks WHERE event_id = $1 ORDER BY relay, at DESC`,
      [eventId],
    );
    return rows.map((r) => ({ eventId, relay: r.relay, present: r.present, at: r.at }));
  }
}

class SqlAlertLog implements AlertLog {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async raise(kind: string, detail: Record<string, unknown>, at: number): Promise<void> {
    await this.db.query(
      'INSERT INTO witness_alerts (kind, detail, at) VALUES ($1, $2::jsonb, $3::bigint)',
      [kind, JSON.stringify(detail), at],
    );
  }

  async list(limit: number): Promise<Alert[]> {
    const rows = await this.db.query<{ id: number; kind: string; detail: unknown; at: number }>(
      'SELECT id::float8 AS id, kind, detail, at::float8 AS at FROM witness_alerts ORDER BY id DESC LIMIT $1::int',
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<
        string,
        unknown
      >,
      at: r.at,
    }));
  }
}

export class SqlWitnessStore implements WitnessStore {
  readonly outbox: OutboxStore;
  readonly publications: PublicationLog;
  readonly checks: CheckLog;
  readonly alerts: AlertLog;
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
    this.outbox = new SqlOutboxStore(db);
    this.publications = new SqlPublicationLog(db);
    this.checks = new SqlCheckLog(db);
    this.alerts = new SqlAlertLog(db);
  }

  transaction<T>(fn: (tx: WitnessStore) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => fn(new SqlWitnessStore(txDb)));
  }
}
