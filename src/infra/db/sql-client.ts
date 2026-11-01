/**
 * Abstracción mínima sobre PostgreSQL para que el mismo SQL corra en PGlite (tests, modo
 * zero-config) y en un PostgreSQL real (desarrollo con el 18 nativo, producción).
 * No es un ORM: SQL a mano, parámetros posicionales `$1…$n`, filas como objetos planos.
 */
export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<Row[]>;
  /**
   * Ejecuta un script con varias sentencias separadas por `;` (migraciones). Sin parámetros:
   * el protocolo extendido (sentencias preparadas) solo admite una sentencia por llamada.
   */
  exec(sql: string): Promise<void>;
  /**
   * Ejecuta `fn` dentro de BEGIN/COMMIT (ROLLBACK si lanza). El cliente que recibe `fn` opera
   * en esa transacción. Llamar a `transaction` desde dentro de otra reutiliza la misma
   * (no hay savepoints en el MVP).
   */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
