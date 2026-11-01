/**
 * Unidad de trabajo del cierre de lotes: una transacción que abarca recibos, lotes y outbox,
 * con el lock de la cadena tomado. Es lo que permite que "guardar el lote" y "encolarlo para los
 * testigos" sean una sola cosa, y que la ingesta y el cierre nunca se pisen.
 */
import type { UnitOfWork } from '../../application/batch-service.ts';
import { SqlBatchStore } from './sql-batch-store.ts';
import type { SqlClient } from './sql-client.ts';
import { CHAIN_LOCK, SqlEvidenceStore } from './sql-evidence-store.ts';
import { SqlWitnessStore } from './sql-witness-store.ts';

export function evidenceUnitOfWork(db: SqlClient): UnitOfWork {
  return (fn) =>
    db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [CHAIN_LOCK]);
      return fn({
        evidence: new SqlEvidenceStore(tx),
        batches: new SqlBatchStore(tx),
        outbox: new SqlWitnessStore(tx).outbox,
      });
    });
}
