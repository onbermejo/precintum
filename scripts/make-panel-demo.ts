/**
 * Genera los datos de demostración del panel, para poder revisar su diseño sin arrancar el
 * agente. La versión que sirve `precintum serve` NO los lleva: si su API falla, muestra el error de
 * verdad. Solo la copia `web/panel-demo.html` los incrusta, y avisa de que son de demostración.
 *
 *   node scripts/make-panel-demo.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { BatchService, type OtsClient, type TsaClient } from '../src/application/batch-service.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import type { Receipt } from '../src/domain/evidence/receipt.ts';
import {
  generateSecretKey,
  identityFromSecretKey,
  npubEncode,
} from '../src/domain/identity/keys.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { SqlWitnessStore } from '../src/infra/db/sql-witness-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { PanelService } from '../src/infra/http/panel-server.ts';
import { loadConfig } from '../src/shared/config.ts';
import { bytesToHex } from '../src/shared/hex.ts';

const WINDOW = 3600;
const T0 = Math.floor(Date.UTC(2026, 8, 3, 8, 0) / 1000); // 10:00 en Madrid
const HOURS = 9;
const NOW = T0 + HOURS * WINDOW + 12 * 60;
const POLICY = bytesToHex(sha256(utf8ToBytes('age_over_18/v1')));
const VERIFIER = bytesToHex(sha256(utf8ToBytes('umbral/eudi-srv-verifier-endpoint/prod-01')));
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

const tsa: TsaClient = {
  async request(digest) {
    return {
      tokenDer: new Uint8Array([0x30, 0x82, ...digest.slice(0, 6)]),
      genTime: new Date((NOW - 30) * 1000),
    };
  },
};
const ots: OtsClient = {
  async submit(digest) {
    return new Uint8Array([0x00, 0x4f, ...digest.slice(0, 10)]);
  },
  async upgrade(bytes) {
    return { ots: bytes, complete: true };
  },
};

const db = await PgliteSqlClient.open();
await migrate(db);
const evidence = new SqlEvidenceStore(db);
const batches = new SqlBatchStore(db);
const witness = new SqlWitnessStore(db);
const identity = identityFromSecretKey(generateSecretKey());

// Un día de tráfico plausible: más por la tarde, con algún menor y algún error, y una hora
// muerta a media mañana para que se vea un latido.
const perHour = [3, 0, 5, 8, 11, 14, 9, 6, 4];
let prev: Receipt | null = null;
let seed = 7;
const rnd = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
// La cadena exige que el tiempo no retroceda (`nextReceipt` lo comprueba), así que se generan
// primero todos los instantes y se ordenan antes de escribir.
const events: Array<{ at: number; result: 'over_18' | 'under_18' | 'error' }> = [];
for (let h = 0; h < HOURS; h++) {
  for (let i = 0; i < (perHour[h] ?? 0); i++) {
    const r = rnd();
    events.push({
      at: T0 + h * WINDOW + Math.floor(rnd() * 3_500),
      result: r < 0.08 ? 'under_18' : r < 0.11 ? 'error' : 'over_18',
    });
  }
}
events.sort((a, b) => a.at - b.at);
for (const { at, result } of events) {
  prev = nextReceipt(prev, { policy: POLICY, verifier: VERIFIER, result, at });
  await evidence.receipts.append(prev);
}

const service = new BatchService({
  evidence,
  batches,
  tx: evidenceUnitOfWork(db),
  identity,
  policy: POLICY,
  windowSeconds: WINDOW,
  tsa,
  ots,
  now: () => NOW,
});
await service.closeDueWindows(NOW);
await service.anchorPending(100);

// Telemetría: el último lote lo aceptaron dos relays y el tercero lo limitó por tasa.
const head = await batches.head();
if (!head) throw new Error('sin lotes');
await witness.publications.record({
  eventId: head.eventId,
  relay: RELAYS[0] as string,
  accepted: true,
  code: '',
  message: '',
  at: NOW - 20,
});
await witness.publications.record({
  eventId: head.eventId,
  relay: RELAYS[1] as string,
  accepted: true,
  code: '',
  message: '',
  at: NOW - 19,
});
await witness.publications.record({
  eventId: head.eventId,
  relay: RELAYS[2] as string,
  accepted: false,
  code: 'rate-limited',
  message: 'slow down',
  at: NOW - 18,
});
await witness.alerts.raise(
  'witness_lost',
  { relay: RELAYS[0], batchSeq: head.seq - 4 },
  NOW - 3_600,
);

const cfg = loadConfig({
  PRECINTUM_RELAYS: RELAYS.join(','),
  PRECINTUM_DEDUP_KEY: 'ab'.repeat(32),
});
const panel = new PanelService({
  evidence,
  batches,
  witness,
  config: cfg,
  identity: { npub: npubEncode(identity.pubkey), pubkey: identity.pubkey },
  now: () => NOW,
});

const demo = {
  health: await panel.health(),
  batches: await panel.recentBatches(50),
  alerts: await panel.alerts(50),
  config: panel.config(),
};
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'web',
  'admin',
  'src',
  '11-demo.js',
);
writeFileSync(
  out,
  `/* Datos de DEMOSTRACIÓN del panel, generados por precintum/scripts/make-panel-demo.ts.
   Solo se incrustan en web/panel-demo.html, para poder revisar el diseño sin arrancar el agente.
   La copia que sirve \`precintum serve\` no los lleva: si su API falla, muestra el error de verdad. */
globalThis.PRECINTUM_PANEL_DEMO = ${JSON.stringify(demo)};
`,
  'utf8',
);
await db.close();
console.log(`escrito ${out}`);
console.log(`recibos: ${demo.health.receipts.total}, lotes: ${demo.health.batches.total}`);
