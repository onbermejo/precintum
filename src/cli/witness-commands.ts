/**
 * Comandos de la capa de testigos.
 *   witness run            un pase del worker de la outbox (publica lo pendiente)
 *   witness status         estado de la outbox, últimas alertas
 *   witness check <id>     ¿qué testigos siguen sirviendo el evento?
 *   witness deletions      busca borrados NIP-09 firmados por el agente
 */

import { WitnessWorker } from '../application/witness-service.ts';
import { checkPresence, detectDeletions } from '../application/witness-verifier.ts';
import { npubDecode } from '../domain/identity/keys.ts';
import { migrate } from '../infra/db/migrations.ts';
import { openSqlClient } from '../infra/db/open.ts';
import { SqlWitnessStore } from '../infra/db/sql-witness-store.ts';
import { closeAll, createRelayClients } from '../infra/relay/relay-pool.ts';
import { AppendOnlyFile } from '../infra/witness/append-only-file.ts';
import type { Config } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { redactDetail, redactUrl } from '../shared/redact.ts';
import { requireSigner } from './identity.ts';

async function open(cfg: Config) {
  const identity = requireSigner(cfg);
  const db = await openSqlClient(cfg.PRECINTUM_DATABASE_URL);
  await migrate(db);
  const store = new SqlWitnessStore(db);
  const relays = createRelayClients(cfg.PRECINTUM_RELAYS, { identity, logger });
  const archive = new AppendOnlyFile(cfg.PRECINTUM_ARCHIVE_PATH);
  const close = async () => {
    closeAll(relays);
    await db.close();
  };
  return { identity, store, relays, archive, close };
}

export async function cmdWitnessRun(cfg: Config): Promise<void> {
  const { store, relays, archive, close } = await open(cfg);
  try {
    const worker = new WitnessWorker({
      store,
      relays,
      quorum: cfg.PRECINTUM_WITNESS_QUORUM,
      archive,
      log: logger,
    });
    const s = await worker.runOnce();
    console.log(
      `procesados ${s.processed}: publicados ${s.published}, pendientes ${s.pending}, fallidos ${s.failed}`,
    );
  } finally {
    await close();
  }
}

export async function cmdWitnessStatus(cfg: Config): Promise<void> {
  const { store, close } = await open(cfg);
  try {
    const c = await store.outbox.counts();
    console.log(`outbox: pendientes ${c.pending}, publicados ${c.published}, fallidos ${c.failed}`);
    console.log(
      `relays: ${cfg.PRECINTUM_RELAYS.map(redactUrl).join(', ')} (quórum ${cfg.PRECINTUM_WITNESS_QUORUM})`,
    );
    const alerts = await store.alerts.list(10);
    if (alerts.length === 0) console.log('alertas: ninguna');
    for (const a of alerts) {
      console.log(
        `alerta #${a.id} ${a.kind} ${new Date(a.at * 1000).toISOString()} ${JSON.stringify(redactDetail(a.detail))}`,
      );
    }
  } finally {
    await close();
  }
}

export async function cmdWitnessCheck(cfg: Config, eventId: string | undefined): Promise<void> {
  if (!eventId || !/^[0-9a-f]{64}$/.test(eventId))
    throw new Error('witness check <id de evento hex>');
  const { store, relays, close } = await open(cfg);
  try {
    const results = await checkPresence(eventId, relays, store, Math.floor(Date.now() / 1000));
    const label = {
      present: 'conserva',
      absent: 'NO lo sirve',
      unreachable: 'sin respuesta (no se sabe)',
    };
    for (const r of results) {
      console.log(
        `${redactUrl(r.relay)}: ${label[r.status]}${r.lost ? ' (lo había aceptado: ALERTA)' : ''}`,
      );
    }
  } finally {
    await close();
  }
}

export async function cmdWitnessDeletions(cfg: Config): Promise<void> {
  const { identity, store, relays, close } = await open(cfg);
  try {
    const rootPubkey = cfg.PRECINTUM_ROOT_NPUB ? npubDecode(cfg.PRECINTUM_ROOT_NPUB) : undefined;
    const found = await detectDeletions(
      { agentPubkey: identity.pubkey, rootPubkey },
      relays,
      store,
      0,
      Math.floor(Date.now() / 1000),
    );
    const scope = rootPubkey ? 'agente, raíz y directorio de claves' : 'agente';
    console.log(
      found.length
        ? `ALERTA: ${found.length} borrado(s) NIP-09 (${scope}): ${found.map((e) => e.id.slice(0, 16)).join(', ')}`
        : `sin borrados NIP-09 (${scope}) en los testigos`,
    );
    if (!rootPubkey) {
      console.log(
        'aviso: PRECINTUM_ROOT_NPUB sin definir; los borrados de la clave raíz y del directorio de claves no se vigilan',
      );
    }
  } finally {
    await close();
  }
}
