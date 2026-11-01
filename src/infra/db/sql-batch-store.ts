/**
 * Adaptador PostgreSQL del puerto BatchStore. BYTEA para el token RFC 3161 y el .ots:
 * pg devuelve Buffer; PGlite devuelve Uint8Array. Ambos se normalizan a Uint8Array.
 */
import type { BatchRecord, BatchStore } from '../../domain/evidence/batch-store.ts';
import type { NostrEvent } from '../../domain/nostr/event.ts';
import { eventSchema } from '../../domain/nostr/protocol.ts';
import type { SqlClient } from './sql-client.ts';

type Row = {
  seq: number;
  root: string;
  prev_root: string;
  window_start: number;
  window_end: number;
  policy: string;
  count: number;
  count_salt: string;
  from_receipt_seq: number | null;
  to_receipt_seq: number | null;
  event_id: string;
  event: unknown;
  tsa_token: Uint8Array | null;
  tsa_gen_time: number | null;
  ots: Uint8Array | null;
  ots_complete: boolean;
};

const COLUMNS = `seq::float8 AS seq, root, prev_root, window_start::float8 AS window_start,
  window_end::float8 AS window_end, policy, count::int AS count, count_salt,
  from_receipt_seq::float8 AS from_receipt_seq, to_receipt_seq::float8 AS to_receipt_seq,
  event_id, event, tsa_token, tsa_gen_time::float8 AS tsa_gen_time, ots, ots_complete`;

function bytes(v: Uint8Array | null): Uint8Array | null {
  return v == null ? null : new Uint8Array(v);
}

function rowToBatch(r: Row): BatchRecord {
  const event: NostrEvent = eventSchema.parse(
    typeof r.event === 'string' ? JSON.parse(r.event) : r.event,
  );
  return {
    seq: r.seq,
    root: r.root,
    prevRoot: r.prev_root,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    policy: r.policy,
    count: r.count,
    countSalt: r.count_salt,
    fromReceiptSeq: r.from_receipt_seq,
    toReceiptSeq: r.to_receipt_seq,
    eventId: r.event_id,
    event,
    tsaToken: bytes(r.tsa_token),
    tsaGenTime: r.tsa_gen_time,
    ots: bytes(r.ots),
    otsComplete: r.ots_complete,
  };
}

export class SqlBatchStore implements BatchStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async head(): Promise<BatchRecord | null> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM batches ORDER BY seq DESC LIMIT 1`,
    );
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  async append(b: BatchRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO batches (seq, root, prev_root, window_start, window_end, policy, count, count_salt,
         from_receipt_seq, to_receipt_seq, event_id, event, tsa_token, tsa_gen_time, ots, ots_complete)
       VALUES ($1::bigint, $2, $3, $4::bigint, $5::bigint, $6, $7::int, $8,
         $9::bigint, $10::bigint, $11, $12::jsonb, $13, $14::bigint, $15, $16)`,
      [
        b.seq,
        b.root,
        b.prevRoot,
        b.windowStart,
        b.windowEnd,
        b.policy,
        b.count,
        b.countSalt,
        b.fromReceiptSeq,
        b.toReceiptSeq,
        b.eventId,
        JSON.stringify(b.event),
        b.tsaToken,
        b.tsaGenTime,
        b.ots,
        b.otsComplete,
      ],
    );
  }

  async get(seq: number): Promise<BatchRecord | null> {
    const rows = await this.db.query<Row>(`SELECT ${COLUMNS} FROM batches WHERE seq = $1::bigint`, [
      seq,
    ]);
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  async range(fromSeq: number, toSeq: number): Promise<BatchRecord[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM batches WHERE seq BETWEEN $1::bigint AND $2::bigint ORDER BY seq`,
      [fromSeq, toSeq],
    );
    return rows.map(rowToBatch);
  }

  async inTimeRange(from: number, to: number): Promise<BatchRecord[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM batches
       WHERE window_start >= $1::bigint AND window_end <= $2::bigint ORDER BY seq`,
      [from, to],
    );
    return rows.map(rowToBatch);
  }

  async containingReceipt(receiptSeq: number): Promise<BatchRecord | null> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM batches
       WHERE from_receipt_seq IS NOT NULL AND $1::bigint BETWEEN from_receipt_seq AND to_receipt_seq
       LIMIT 1`,
      [receiptSeq],
    );
    return rows[0] ? rowToBatch(rows[0]) : null;
  }

  async setTsa(seq: number, token: Uint8Array, genTime: number): Promise<void> {
    await this.db.query(
      'UPDATE batches SET tsa_token = $2, tsa_gen_time = $3::bigint WHERE seq = $1::bigint',
      [seq, token, genTime],
    );
  }

  async setOts(seq: number, ots: Uint8Array, complete: boolean): Promise<void> {
    await this.db.query('UPDATE batches SET ots = $2, ots_complete = $3 WHERE seq = $1::bigint', [
      seq,
      ots,
      complete,
    ]);
  }

  async pendingAnchors(limit: number): Promise<BatchRecord[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM batches WHERE NOT ots_complete OR tsa_token IS NULL ORDER BY seq LIMIT $1::int`,
      [limit],
    );
    return rows.map(rowToBatch);
  }

  async notEnqueued(limit: number): Promise<BatchRecord[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM batches
       WHERE NOT EXISTS (SELECT 1 FROM witness_outbox o WHERE o.event_id = batches.event_id)
       ORDER BY seq LIMIT $1::int`,
      [limit],
    );
    return rows.map(rowToBatch);
  }

  async count(): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*)::float8 AS n FROM batches');
    return rows[0]?.n ?? 0;
  }
}
