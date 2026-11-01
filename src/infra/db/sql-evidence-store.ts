/**
 * Adaptador PostgreSQL de los puertos de evidencia. Mismo SQL para PGlite y pg.
 *
 * Nota sobre tipos: `pg` devuelve BIGINT como string y PGlite puede devolverlo como BigInt.
 * Para que ambos den `number`, las columnas BIGINT se leen con `::float8` (exacto hasta 2^53,
 * de sobra para seq y para segundos unix).
 */
import type {
  DedupStore,
  EvidenceStore,
  ReceiptRepository,
} from '../../domain/evidence/evidence-store.ts';
import {
  GENESIS,
  type Receipt,
  receiptHash,
  receiptSchema,
} from '../../domain/evidence/receipt.ts';
import type { SqlClient } from './sql-client.ts';

/**
 * Clave del lock de advisory que serializa la ingesta y el cierre de lotes. Se toma como sentencia
 * propia al abrir la transacción: una CTE no referenciada no se ejecuta.
 */
export const CHAIN_LOCK = 7676;

export class ChainIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainIntegrityError';
  }
}

type ReceiptRow = {
  seq: number;
  prev: string;
  nonce: string;
  policy: string;
  verifier: string;
  result: string;
  ts: number;
};

const RECEIPT_COLUMNS =
  'seq::float8 AS seq, prev, nonce, policy, verifier, result, ts::float8 AS ts';

function rowToReceipt(row: ReceiptRow): Receipt {
  return receiptSchema.parse({ v: 1, ...row });
}

class SqlReceiptRepository implements ReceiptRepository {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async head(): Promise<Receipt | null> {
    const rows = await this.db.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts ORDER BY seq DESC LIMIT 1`,
    );
    return rows[0] ? rowToReceipt(rows[0]) : null;
  }

  async append(receipt: Receipt): Promise<void> {
    const parsed = receiptSchema.parse(receipt);
    const hash = receiptHash(parsed);
    // El INSERT solo produce fila si el recibo encaja con la cabeza actual (o es el primero
    // sobre GENESIS): es la última línea de defensa. La serialización entre procesos la da el
    // lock que toma `SqlEvidenceStore.transaction` (y la PRIMARY KEY si alguien lo esquiva).
    const rows = await this.db.query<{ seq: number }>(
      `
      WITH head AS (SELECT seq, hash FROM receipts ORDER BY seq DESC LIMIT 1)
      INSERT INTO receipts (seq, hash, prev, nonce, policy, verifier, result, ts)
      SELECT $1::bigint, $2, $3, $4, $5, $6, $7, $8::bigint
      WHERE (
        (NOT EXISTS (SELECT 1 FROM head) AND $1::bigint = 1 AND $3 = $9)
        OR EXISTS (SELECT 1 FROM head WHERE head.seq + 1 = $1::bigint AND head.hash = $3)
      )
      RETURNING seq::float8 AS seq
      `,
      [
        parsed.seq,
        hash,
        parsed.prev,
        parsed.nonce,
        parsed.policy,
        parsed.verifier,
        parsed.result,
        parsed.ts,
        GENESIS,
      ],
    );
    if (rows.length === 0) {
      const head = await this.head();
      throw new ChainIntegrityError(
        head
          ? `el recibo seq=${parsed.seq} prev=${parsed.prev.slice(0, 8)}… no encaja con la cabeza seq=${head.seq} hash=${receiptHash(head).slice(0, 8)}…`
          : `la cadena está vacía: el primer recibo debe tener seq=1 y prev=GENESIS`,
      );
    }
  }

  async get(seq: number): Promise<Receipt | null> {
    const rows = await this.db.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE seq = $1::bigint`,
      [seq],
    );
    return rows[0] ? rowToReceipt(rows[0]) : null;
  }

  async range(fromSeq: number, toSeq: number): Promise<Receipt[]> {
    const rows = await this.db.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE seq BETWEEN $1::bigint AND $2::bigint ORDER BY seq`,
      [fromSeq, toSeq],
    );
    return rows.map(rowToReceipt);
  }

  async inWindow(start: number, end: number): Promise<Receipt[]> {
    const rows = await this.db.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE ts >= $1::bigint AND ts < $2::bigint ORDER BY seq`,
      [start, end],
    );
    return rows.map(rowToReceipt);
  }

  async firstTs(): Promise<number | null> {
    const rows = await this.db.query<{ ts: number }>(
      'SELECT ts::float8 AS ts FROM receipts ORDER BY seq LIMIT 1',
    );
    return rows[0]?.ts ?? null;
  }

  async count(): Promise<number> {
    const rows = await this.db.query<{ n: number }>('SELECT count(*)::float8 AS n FROM receipts');
    return rows[0]?.n ?? 0;
  }
}

class SqlDedupStore implements DedupStore {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async lookup(key: string, now: number): Promise<number | null> {
    const rows = await this.db.query<{ seq: number }>(
      'SELECT seq::float8 AS seq FROM ingest_dedup WHERE key = $1 AND expires_at > $2::bigint',
      [key, now],
    );
    return rows[0]?.seq ?? null;
  }

  async remember(key: string, seq: number, expiresAt: number): Promise<void> {
    await this.db.query(
      `INSERT INTO ingest_dedup (key, seq, expires_at) VALUES ($1, $2::bigint, $3::bigint)
       ON CONFLICT (key) DO UPDATE SET seq = EXCLUDED.seq, expires_at = EXCLUDED.expires_at`,
      [key, seq, expiresAt],
    );
  }

  async purgeExpired(now: number): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `WITH del AS (DELETE FROM ingest_dedup WHERE expires_at <= $1::bigint RETURNING 1)
       SELECT count(*)::float8 AS n FROM del`,
      [now],
    );
    return rows[0]?.n ?? 0;
  }
}

export class SqlEvidenceStore implements EvidenceStore {
  readonly receipts: ReceiptRepository;
  readonly dedup: DedupStore;
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
    this.receipts = new SqlReceiptRepository(db);
    this.dedup = new SqlDedupStore(db);
  }

  async closedUntil(): Promise<number | null> {
    const rows = await this.db.query<{ t: number | null }>(
      'SELECT max(window_end)::float8 AS t FROM batches',
    );
    return rows[0]?.t ?? null;
  }

  transaction<T>(fn: (tx: EvidenceStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => {
      await txDb.query('SELECT pg_advisory_xact_lock($1::bigint)', [CHAIN_LOCK]);
      return fn(new SqlEvidenceStore(txDb));
    });
  }
}
