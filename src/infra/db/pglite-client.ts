/**
 * PGlite: PostgreSQL compilado a WebAssembly, en el mismo proceso. Sin servicio externo.
 * Se usa en tests (en memoria) y como modo zero-config (`PRECINTUM_DATABASE_URL=pglite:./data/precintum`).
 * Es el mismo motor que el PostgreSQL 18 nativo: el SQL que pasa aquí pasa allí.
 *
 * Límite que hay que respetar: PGlite es de un solo proceso. Dos procesos sobre el mismo
 * directorio no fallan, se corrompen en silencio (el segundo escribe y el primero, al cerrar, lo
 * sobrescribe). Por eso `open(dataDir)` toma un fichero
 * de bloqueo con el PID y falla con un mensaje claro si otro proceso vivo lo tiene. Para operar en
 * continuo (panel + cierre de lotes + publicación) la base de datos es PostgreSQL.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { SqlClient } from './sql-client.ts';

type Queryable = Pick<PGlite, 'query' | 'exec'> | Transaction;

export const PGLITE_LOCK_FILE = '.precintum.lock';

class PgliteTx implements SqlClient {
  private readonly tx: Queryable;

  constructor(tx: Queryable) {
    this.tx = tx;
  }

  async query<Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const res = await this.tx.query<Row>(sql, [...params]);
    return res.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.tx.exec(sql);
  }

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    // Ya estamos dentro de una transacción: se reutiliza.
    return fn(this);
  }

  async close(): Promise<void> {}
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe pero no es nuestro. ESRCH: no existe.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Toma el bloqueo exclusivo del directorio o lanza si otro proceso vivo lo tiene. */
function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, PGLITE_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try {
          unlinkSync(path);
        } catch {
          // Ya no está: nada que hacer.
        }
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(path, 'utf8').trim());
      } catch {
        // Fichero ilegible: se trata como huérfano.
      }
      if (Number.isInteger(holder) && holder !== process.pid && pidAlive(holder)) {
        throw new Error(
          `otro proceso (pid ${holder}) tiene abierta la base de datos PGlite en ${dataDir}. ` +
            'PGlite admite un solo proceso a la vez: para ese proceso primero, o usa PostgreSQL ' +
            '(PRECINTUM_DATABASE_URL=postgres://…) si necesitas varios a la vez (panel + cierre de lotes).',
        );
      }
      // Bloqueo huérfano de un proceso muerto: se retira y se reintenta una vez.
      try {
        unlinkSync(path);
      } catch {
        // Otro proceso lo ha retirado a la vez; el reintento decide.
      }
    }
  }
  throw new Error(`no se pudo tomar el bloqueo de la base de datos PGlite en ${dataDir}`);
}

export class PgliteSqlClient implements SqlClient {
  private readonly db: PGlite;
  private readonly release: (() => void) | null;

  private constructor(db: PGlite, release: (() => void) | null) {
    this.db = db;
    this.release = release;
  }

  /** `dataDir` vacío = en memoria (sin bloqueo: no hay directorio que compartir). */
  static async open(dataDir?: string): Promise<PgliteSqlClient> {
    if (!dataDir) return new PgliteSqlClient(await PGlite.create(), null);
    const release = acquireLock(dataDir);
    try {
      return new PgliteSqlClient(await PGlite.create(dataDir), release);
    } catch (err) {
      release();
      throw err;
    }
  }

  async query<Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const res = await this.db.query<Row>(sql, [...params]);
    return res.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PgliteTx(tx)));
  }

  async close(): Promise<void> {
    try {
      await this.db.close();
    } finally {
      this.release?.();
    }
  }
}
