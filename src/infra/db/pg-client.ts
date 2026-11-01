/**
 * PostgreSQL real vía node-postgres (`pg`). Un Pool para consultas sueltas; para
 * transacciones se reserva una conexión y se hace BEGIN/COMMIT/ROLLBACK a mano.
 */
import pg from 'pg';
import { logger } from '../../shared/logger.ts';
import type { SqlClient } from './sql-client.ts';

const { Pool } = pg;

export interface PgOptions {
  /** Cuánto esperar una conexión libre o nueva. */
  connectionTimeoutMillis?: number;
  /** Plazo por sentencia en el servidor (statement_timeout). */
  statementTimeoutMillis?: number;
  /** Qué hacer con el error de una conexión ociosa (por defecto, registrarlo). */
  onError?: (err: Error) => void;
}

class PgTx implements SqlClient {
  private readonly client: pg.PoolClient;

  constructor(client: pg.PoolClient) {
    this.client = client;
  }

  async query<Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const res = await this.client.query<Row>(sql, [...params]);
    return res.rows;
  }

  async exec(sql: string): Promise<void> {
    // Sin parámetros, pg usa el protocolo simple, que admite varias sentencias.
    await this.client.query(sql);
  }

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

export class PgSqlClient implements SqlClient {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, opts: PgOptions = {}) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: opts.statementTimeoutMillis ?? 60_000,
    });
    // Sin este manejador, el error de una conexión ociosa (el servidor la cierra, se cae la red)
    // se emite sin oyente y tira el proceso entero. Con él, el pool la descarta y abre otra.
    const onError =
      opts.onError ??
      ((err: Error) => logger.error({ err: err.message }, 'conexión ociosa a PostgreSQL perdida'));
    this.pool.on('error', onError);
  }

  async query<Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const res = await this.pool.query<Row>(sql, [...params]);
    return res.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTx(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
