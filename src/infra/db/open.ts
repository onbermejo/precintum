import { PgSqlClient } from './pg-client.ts';
import { PgliteSqlClient } from './pglite-client.ts';
import type { SqlClient } from './sql-client.ts';

/**
 * Abre la base de datos según la URL:
 *   pglite:memory           PGlite en memoria (tests)
 *   pglite:./data/precintum      PGlite persistido en disco (modo zero-config)
 *   postgres://user:pw@host:5432/db   PostgreSQL real (también postgresql://)
 */
export async function openSqlClient(url: string): Promise<SqlClient> {
  if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length).replace(/^\/\//, '');
    return PgliteSqlClient.open(target === '' || target === 'memory' ? undefined : target);
  }
  if (/^postgres(ql)?:\/\//.test(url)) return new PgSqlClient(url);
  throw new Error(`PRECINTUM_DATABASE_URL no reconocida: ${url}`);
}
