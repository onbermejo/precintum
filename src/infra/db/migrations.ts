/**
 * Migraciones como SQL embebido (no ficheros .sql): así viajan dentro del build y no hay
 * que copiar nada a dist/. Cada migración se aplica una sola vez, en orden, dentro de una
 * transacción, y queda registrada en `schema_migrations`.
 */
import type { SqlClient } from './sql-client.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'receipts_and_dedup',
    sql: `
      -- La cadena de recibos. Las CHECK son la última línea de defensa: aunque el código
      -- falle, la base de datos no admite un recibo malformado.
      CREATE TABLE receipts (
        seq         BIGINT PRIMARY KEY,
        hash        TEXT   NOT NULL UNIQUE CHECK (hash  ~ '^[0-9a-f]{64}$'),
        prev        TEXT   NOT NULL        CHECK (prev  ~ '^[0-9a-f]{64}$'),
        nonce       TEXT   NOT NULL UNIQUE CHECK (nonce ~ '^[0-9a-f]{64}$'),
        policy      TEXT   NOT NULL        CHECK (policy   ~ '^[0-9a-f]{64}$'),
        verifier    TEXT   NOT NULL        CHECK (verifier ~ '^[0-9a-f]{64}$'),
        result      TEXT   NOT NULL        CHECK (result IN ('over_18', 'under_18', 'error')),
        ts          BIGINT NOT NULL        CHECK (ts >= 0 AND ts % 60 = 0),
        inserted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Correlación efímera con el verifier, solo para idempotencia. Se purga por TTL.
      -- ON DELETE CASCADE: si un recibo desaparece (nunca debería), su correlación también.
      CREATE TABLE ingest_dedup (
        key        TEXT   PRIMARY KEY,
        seq        BIGINT NOT NULL REFERENCES receipts(seq) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX ingest_dedup_expires_idx ON ingest_dedup (expires_at);
    `,
  },
  {
    id: 2,
    name: 'witness_outbox_and_telemetry',
    sql: `
      -- Outbox: lo que hay que publicar se persiste antes de intentarlo.
      CREATE TABLE witness_outbox (
        event_id        TEXT    PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
        event           JSONB   NOT NULL,
        enqueued_at     BIGINT  NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at BIGINT  NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'published', 'failed'))
      );
      CREATE INDEX witness_outbox_due_idx ON witness_outbox (status, next_attempt_at);

      -- Telemetría: qué contestó cada relay. Registrado por el operador; no es prueba para terceros.
      CREATE TABLE witness_publications (
        event_id TEXT    NOT NULL,
        relay    TEXT    NOT NULL,
        accepted BOOLEAN NOT NULL,
        code     TEXT    NOT NULL DEFAULT '',
        message  TEXT    NOT NULL DEFAULT '',
        at       BIGINT  NOT NULL,
        PRIMARY KEY (event_id, relay)
      );

      -- Verificación diferida: ¿el testigo sigue sirviendo el evento?
      CREATE TABLE witness_checks (
        event_id TEXT    NOT NULL,
        relay    TEXT    NOT NULL,
        present  BOOLEAN NOT NULL,
        at       BIGINT  NOT NULL,
        PRIMARY KEY (event_id, relay, at)
      );

      -- Alertas de primer nivel: borrados NIP-09 del propio agente, testigos que "olvidan", etc.
      CREATE TABLE witness_alerts (
        id     BIGSERIAL PRIMARY KEY,
        kind   TEXT   NOT NULL,
        detail JSONB  NOT NULL,
        at     BIGINT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: 'batches',
    sql: `
      -- Lotes: una raíz por ventana fija, encadenados por prev_root, con sus anclajes.
      CREATE TABLE batches (
        seq              BIGINT  PRIMARY KEY,
        root             TEXT    NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
        prev_root        TEXT    NOT NULL CHECK (prev_root ~ '^[0-9a-f]{64}$'),
        window_start     BIGINT  NOT NULL,
        window_end       BIGINT  NOT NULL CHECK (window_end > window_start),
        policy           TEXT    NOT NULL CHECK (policy ~ '^[0-9a-f]{64}$'),
        count            INTEGER NOT NULL CHECK (count >= 0),
        count_salt       TEXT    NOT NULL CHECK (count_salt ~ '^[0-9a-f]{64}$'),
        from_receipt_seq BIGINT,
        to_receipt_seq   BIGINT,
        event_id         TEXT    NOT NULL UNIQUE CHECK (event_id ~ '^[0-9a-f]{64}$'),
        event            JSONB   NOT NULL,
        tsa_token        BYTEA,
        tsa_gen_time     BIGINT,
        ots              BYTEA,
        ots_complete     BOOLEAN NOT NULL DEFAULT false,
        closed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX batches_window_idx ON batches (window_start);
    `,
  },
  {
    id: 4,
    name: 'drop_receipts_inserted_at',
    sql: `
      -- El instante exacto de inserción reenlazaba cada recibo con los logs del verifier con más
      -- precisión que el propio recibo. El minuto ya está en ts.
      ALTER TABLE receipts DROP COLUMN inserted_at;
    `,
  },
];

export async function migrate(client: SqlClient): Promise<number[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await client.query<{ id: number }>('SELECT id::int AS id FROM schema_migrations')).map(
      (r) => r.id,
    ),
  );
  const done: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await client.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
    });
    done.push(m.id);
  }
  return done;
}
