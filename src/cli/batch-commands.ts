/**
 * Comandos de lotes y anclaje.
 *   batch close          cierra las ventanas terminadas (también vacías), publica y ancla
 *   batch status         lotes, cabeza, anclajes pendientes
 *   anchor upgrade       reintenta sellos RFC 3161 y actualiza los .ots pendientes
 *   proof <receiptSeq>   prueba de inclusión de un recibo en su lote, verificada
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { BatchService } from '../application/batch-service.ts';
import { WitnessWorker } from '../application/witness-service.ts';
import { checkAnchorWindow, verifyReceiptProof } from '../domain/evidence/batch.ts';
import { migrate } from '../infra/db/migrations.ts';
import { openSqlClient } from '../infra/db/open.ts';
import { SqlBatchStore } from '../infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../infra/db/sql-evidence-store.ts';
import { SqlWitnessStore } from '../infra/db/sql-witness-store.ts';
import { evidenceUnitOfWork } from '../infra/db/unit-of-work.ts';
import { calendarOtsClient } from '../infra/ots/ots-client.ts';
import { closeAll, createRelayClients } from '../infra/relay/relay-pool.ts';
import { httpTsaClient } from '../infra/tsa/tsa-client.ts';
import { AppendOnlyFile } from '../infra/witness/append-only-file.ts';
import type { Config } from '../shared/config.ts';
import { bytesToHex, isHex64 } from '../shared/hex.ts';
import { logger } from '../shared/logger.ts';
import { requireSigner } from './identity.ts';
import { tsaWarning } from './tsa-warning.ts';

export { DEV_TSA_HOSTS, tsaWarning } from './tsa-warning.ts';

async function open(cfg: Config) {
  const identity = requireSigner(cfg);
  const db = await openSqlClient(cfg.PRECINTUM_DATABASE_URL);
  await migrate(db);
  const evidence = new SqlEvidenceStore(db);
  const batches = new SqlBatchStore(db);
  const witnessStore = new SqlWitnessStore(db);
  const relays = createRelayClients(cfg.PRECINTUM_RELAYS, { identity, logger });
  const worker = new WitnessWorker({
    store: witnessStore,
    relays,
    quorum: cfg.PRECINTUM_WITNESS_QUORUM,
    archive: new AppendOnlyFile(cfg.PRECINTUM_ARCHIVE_PATH),
    log: logger,
  });
  const service = new BatchService({
    evidence,
    batches,
    tx: evidenceUnitOfWork(db),
    afterCommit: (e) => worker.archive(e),
    graceSeconds: cfg.PRECINTUM_BATCH_GRACE_SECONDS,
    identity,
    policy: isHex64(cfg.PRECINTUM_POLICY)
      ? cfg.PRECINTUM_POLICY
      : bytesToHex(sha256(utf8ToBytes(cfg.PRECINTUM_POLICY))),
    windowSeconds: cfg.PRECINTUM_BATCH_WINDOW_SECONDS,
    tsa: httpTsaClient(
      cfg.PRECINTUM_TSA_URL,
      cfg.PRECINTUM_TSA_USER && cfg.PRECINTUM_TSA_PASSWORD
        ? { user: cfg.PRECINTUM_TSA_USER, password: cfg.PRECINTUM_TSA_PASSWORD }
        : undefined,
    ),
    ots: calendarOtsClient(cfg.PRECINTUM_OTS_CALENDARS),
    log: logger,
  });
  const close = async () => {
    closeAll(relays);
    await db.close();
  };
  return { service, batches, close };
}

export async function cmdBatchClose(cfg: Config): Promise<void> {
  const warning = tsaWarning(cfg);
  if (warning) console.error(warning);
  const { service, close } = await open(cfg);
  try {
    const s = await service.closeDueWindows();
    console.log(
      `lotes cerrados: ${s.closed} (${s.empty} vacíos), recibos incluidos: ${s.receipts}` +
        (s.reconciled ? `; lotes reconciliados con la outbox: ${s.reconciled}` : '') +
        (s.remaining ? `; quedan ${s.remaining} ventanas para el siguiente pase` : ''),
    );
    console.log(
      'los eventos quedan en la outbox: ejecuta `pnpm precintum witness run` para publicarlos',
    );
  } finally {
    await close();
  }
}

export async function cmdBatchStatus(cfg: Config): Promise<void> {
  const { batches, close } = await open(cfg);
  try {
    const n = await batches.count();
    const head = await batches.head();
    console.log(`lotes: ${n}; ventana ${cfg.PRECINTUM_BATCH_WINDOW_SECONDS}s`);
    if (head) {
      const w = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
      console.log(
        `cabeza: #${head.seq} ventana [${w(head.windowStart)}, ${w(head.windowEnd)}) recibos ${head.count} raíz ${head.root.slice(0, 16)}…`,
      );
      console.log(
        `  RFC 3161: ${head.tsaGenTime ? `sellado ${w(head.tsaGenTime)}` : 'pendiente'}; OTS: ${head.ots ? (head.otsComplete ? 'en Bitcoin' : 'pendiente en calendario') : 'sin enviar'}`,
      );
    }
    const pending = await batches.pendingAnchors(1_000);
    console.log(
      `anclajes pendientes: ${pending.length} (sin sello RFC 3161: ${pending.filter((b) => b.tsaToken === null).length}; OTS sin completar: ${pending.filter((b) => !b.otsComplete).length})`,
    );
  } finally {
    await close();
  }
}

export async function cmdAnchorUpgrade(cfg: Config): Promise<void> {
  const { service, close } = await open(cfg);
  try {
    const r = await service.anchorPending();
    console.log(
      `sellos RFC 3161 nuevos: ${r.tsa}; OTS enviados: ${r.otsSubmitted}; OTS completados en Bitcoin: ${r.otsCompleted}`,
    );
  } finally {
    await close();
  }
}

export async function cmdProof(cfg: Config, receiptSeqArg: string | undefined): Promise<void> {
  const receiptSeq = Number(receiptSeqArg);
  if (!Number.isInteger(receiptSeq) || receiptSeq < 1) throw new Error('proof <seq de recibo>');
  const { service, close } = await open(cfg);
  try {
    const found = await service.proofFor(receiptSeq);
    if (!found) {
      console.log(
        `el recibo ${receiptSeq} aún no está en ningún lote (ejecuta \`pnpm precintum batch close\`)`,
      );
      process.exitCode = 1;
      return;
    }
    const { batch, proof } = found;
    const ok = verifyReceiptProof(proof, batch.root);
    const anchor = batch.tsaGenTime
      ? checkAnchorWindow(batch.windowEnd, batch.tsaGenTime, cfg.PRECINTUM_ANCHOR_MAX_GAP_SECONDS)
      : null;
    console.log(
      JSON.stringify(
        {
          receiptSeq,
          receiptHash: proof.receiptHash,
          batch: {
            seq: batch.seq,
            root: batch.root,
            window: [batch.windowStart, batch.windowEnd],
            eventId: batch.eventId,
          },
          proof: proof.proof,
          inclusionOk: ok,
          tsa: batch.tsaGenTime
            ? {
                genTime: batch.tsaGenTime,
                withinWindow: anchor?.ok,
                gapSeconds: anchor?.gapSeconds,
              }
            : null,
          ots: batch.ots ? { complete: batch.otsComplete, bytes: batch.ots.length } : null,
        },
        null,
        2,
      ),
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await close();
  }
}
