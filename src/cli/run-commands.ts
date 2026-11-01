/**
 * `precintum run`: el agente como proceso (ADR-0002). Un solo proceso aloja la ingesta
 * (`POST /receipts`, ADR-0003), el planificador (cierre de ventanas, publicación, anclajes,
 * presencia en los testigos, borrados NIP-09), el panel de solo lectura y `/health`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { BatchService } from '../application/batch-service.ts';
import { Runner } from '../application/runner.ts';
import { WitnessWorker } from '../application/witness-service.ts';
import { checkPresence, detectDeletions } from '../application/witness-verifier.ts';
import { npubDecode, npubEncode } from '../domain/identity/keys.ts';
import { migrate } from '../infra/db/migrations.ts';
import { openSqlClient } from '../infra/db/open.ts';
import { SqlBatchStore } from '../infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../infra/db/sql-evidence-store.ts';
import { SqlWitnessStore } from '../infra/db/sql-witness-store.ts';
import { evidenceUnitOfWork } from '../infra/db/unit-of-work.ts';
import { startIngest } from '../infra/http/ingest-server.ts';
import { isLoopback, startPanel } from '../infra/http/panel-server.ts';
import { calendarOtsClient } from '../infra/ots/ots-client.ts';
import { closeAll, createRelayClients } from '../infra/relay/relay-pool.ts';
import { httpTsaClient } from '../infra/tsa/tsa-client.ts';
import { AppendOnlyFile } from '../infra/witness/append-only-file.ts';
import type { Config } from '../shared/config.ts';
import { bytesToHex, hexToBytes, isHex64 } from '../shared/hex.ts';
import { logger } from '../shared/logger.ts';
import { redactUrl } from '../shared/redact.ts';
import { tsaWarning } from './batch-commands.ts';
import { requireSigner } from './identity.ts';
import { parsePort } from './serve-commands.ts';

/** Cuántos de los últimos lotes se re-consultan en los testigos en cada pase de presencia. */
const PRESENCE_LOOKBACK = 5;

export async function cmdRun(
  cfg: Config,
  portArg: string | undefined,
  hostArg: string | undefined,
): Promise<void> {
  const identity = requireSigner(cfg);
  const panelPort = parsePort(portArg);
  const panelHost = hostArg ?? '127.0.0.1';
  if (!cfg.PRECINTUM_INGEST_TOKEN) {
    throw new Error(
      'falta PRECINTUM_INGEST_TOKEN: el adaptador del verifier se autentica con él (pnpm precintum keygen sugiere uno)',
    );
  }
  if (!cfg.PRECINTUM_DEDUP_KEY) {
    throw new Error(
      'falta PRECINTUM_DEDUP_KEY: en continuo, los reintentos del adaptador deben deduplicarse entre pases',
    );
  }
  const warning = tsaWarning(cfg);
  if (warning) console.error(warning);

  const rootPubkey = cfg.PRECINTUM_ROOT_NPUB ? npubDecode(cfg.PRECINTUM_ROOT_NPUB) : undefined;
  if (!rootPubkey) {
    console.error(
      'aviso: PRECINTUM_ROOT_NPUB sin definir; los borrados NIP-09 de la clave raíz y del directorio de claves no se vigilan',
    );
  }
  const db = await openSqlClient(cfg.PRECINTUM_DATABASE_URL);
  const release: Array<() => void | Promise<void>> = [() => db.close()];
  try {
    await migrate(db);
    const evidence = new SqlEvidenceStore(db);
    const batches = new SqlBatchStore(db);
    const witnessStore = new SqlWitnessStore(db);
    const relays = createRelayClients(cfg.PRECINTUM_RELAYS, { identity, logger });
    release.push(() => closeAll(relays));
    const worker = new WitnessWorker({
      store: witnessStore,
      relays,
      quorum: cfg.PRECINTUM_WITNESS_QUORUM,
      archive: new AppendOnlyFile(cfg.PRECINTUM_ARCHIVE_PATH),
      log: logger,
    });
    const batchService = new BatchService({
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

    const runner = new Runner({
      tasks: {
        closeWindows: (now) => batchService.closeDueWindows(now),
        publish: (now) => worker.runOnce(now),
        anchors: () => batchService.anchorPending(),
        presence: async (now) => {
          const head = await batches.head();
          if (!head) return;
          const recent = await batches.range(
            Math.max(1, head.seq - PRESENCE_LOOKBACK + 1),
            head.seq,
          );
          for (const b of recent) {
            const results = await checkPresence(b.eventId, relays, witnessStore, now);
            const down = results
              .filter((r) => r.status === 'unreachable')
              .map((r) => redactUrl(r.relay));
            if (down.length) {
              logger.warn(
                { seq: b.seq, relays: down },
                'testigos sin respuesta al comprobar presencia',
              );
            }
          }
        },
        deletions: (now) =>
          detectDeletions(
            { agentPubkey: identity.pubkey, rootPubkey },
            relays,
            witnessStore,
            0,
            now,
          ),
      },
      intervals: {
        closeWindows: cfg.PRECINTUM_RUN_TICK_SECONDS,
        publish: cfg.PRECINTUM_RUN_TICK_SECONDS,
        anchors: cfg.PRECINTUM_RUN_ANCHOR_SECONDS,
        presence: cfg.PRECINTUM_RUN_PRESENCE_SECONDS,
        deletions: cfg.PRECINTUM_RUN_DELETIONS_SECONDS,
      },
      log: logger,
    });

    release.push(() => runner.stop());
    const ingest = await startIngest(
      {
        evidence,
        record: {
          dedupKey: hexToBytes(cfg.PRECINTUM_DEDUP_KEY),
          dedupTtlSeconds: cfg.PRECINTUM_DEDUP_TTL_SECONDS,
          maxFutureSkewSeconds: cfg.PRECINTUM_MAX_FUTURE_SKEW_SECONDS,
        },
        token: cfg.PRECINTUM_INGEST_TOKEN,
        healthy: () => runner.healthy(),
        log: logger,
      },
      cfg.PRECINTUM_INGEST_PORT,
      cfg.PRECINTUM_INGEST_HOST,
    );
    release.push(() => ingest.close());
    const panel = await startPanel(
      {
        evidence,
        batches,
        witness: witnessStore,
        config: cfg,
        identity: { npub: npubEncode(identity.pubkey), pubkey: identity.pubkey },
      },
      panelPort,
      panelHost,
    );
    release.push(() => panel.close());
    if (!isLoopback(panelHost) || !isLoopback(cfg.PRECINTUM_INGEST_HOST)) {
      console.error(
        'AVISO: el panel o la ingesta escuchan fuera de esta máquina. El panel no tiene autenticación y la ingesta solo un token: pon delante un proxy inverso con TLS.',
      );
    }
    runner.start();

    console.log(`agente ${npubEncode(identity.pubkey)} en marcha`);
    console.log(
      `ingesta:  POST http://${cfg.PRECINTUM_INGEST_HOST}:${ingest.port}/receipts  (Authorization: Bearer …)`,
    );
    console.log(`salud:    GET  http://${cfg.PRECINTUM_INGEST_HOST}:${ingest.port}/health`);
    console.log(`panel:    http://${panelHost}:${panel.port}/   métricas: /metrics`);
    console.log(
      `cadencias: ventanas y outbox cada ${cfg.PRECINTUM_RUN_TICK_SECONDS} s · anclajes cada ${cfg.PRECINTUM_RUN_ANCHOR_SECONDS} s · presencia cada ${cfg.PRECINTUM_RUN_PRESENCE_SECONDS} s · borrados cada ${cfg.PRECINTUM_RUN_DELETIONS_SECONDS} s`,
    );
    console.log('Ctrl+C para parar.');

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      console.log('parando: se termina el pase en curso…');
      await runner.stop();
      await ingest.close();
      await panel.close();
      closeAll(relays);
      await db.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  } catch (error) {
    for (const close of release.reverse()) {
      try {
        await close();
      } catch {
        // Conservar el error de arranque y seguir liberando los demás recursos.
      }
    }
    throw error;
  }
}
