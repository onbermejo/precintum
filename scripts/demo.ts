/**
 * Demostración narrada y sin red: una hora de un verificador de edad convertida en evidencia.
 *
 *   pnpm demo     (deja demo-package.json y demo-package-tampered.json en la carpeta actual)
 *
 * Usa el código real (ingesta con su cuarentena, recibos encadenados, cierre de lote, evento
 * firmado, exportación y verificador) con una base de datos en memoria, dos relays en memoria (los
 * de los tests) y sellos con el formato real pero simulados: la TSA y Bitcoin necesitan red, y
 * `pnpm test:it` usa los de verdad. La narración va en inglés porque es lo primero que ve quien
 * evalúa el repositorio.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { BatchService } from '../src/application/batch-service.ts';
import {
  type EvidencePackage,
  ExportService,
  verifyPackage,
} from '../src/application/export-service.ts';
import { ingestVerification } from '../src/application/ingest.ts';
import { generateSecretKey, identityFromSecretKey } from '../src/domain/identity/keys.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { RelayClient } from '../src/infra/relay/relay-client.ts';
import { bytesToHex } from '../src/shared/hex.ts';
import { fakeOts, fakeTsa } from '../test/support/fake-anchors.ts';
import { MiniRelay } from '../test/support/mini-relay.ts';

const WINDOW = 3600;
/** 1 de octubre de 2026, 10:00 UTC: la hora que se registra. */
const T0 = Math.floor(Date.UTC(2026, 9, 1, 10, 0) / 1000);
const POLICY = bytesToHex(sha256(utf8ToBytes('age_over_18/v1')));

export interface DemoOptions {
  /** Carpeta donde se escriben los dos paquetes. Por defecto, la actual. */
  outDir?: string;
  /** Dónde va la narración. Por defecto, la consola. */
  say?: (line: string) => void;
}

export interface DemoResult {
  ingest: { tx1: number; tx2: number; withPersonalData: number; sameTxOtherResult: number };
  batch: { seq: number; count: number; root: string; eventId: string; sealGapSeconds: number };
  witnesses: { url: string; accepted: boolean; servesIt: boolean }[];
  verified: ReturnType<typeof verifyPackage>;
  tampered: ReturnType<typeof verifyPackage>;
  files: { good: string; tampered: string };
}

const hhmm = (t: number): string => new Date(t * 1000).toISOString().slice(11, 16);
const short = (h: string): string => `${h.slice(0, 8)}…`;

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const say = opts.say ?? ((line: string) => console.log(line));
  const outDir = opts.outDir ?? process.cwd();

  const db = await PgliteSqlClient.open();
  const relays = [new MiniRelay(), new MiniRelay()];
  try {
    await migrate(db);
    const evidence = new SqlEvidenceStore(db);
    const batches = new SqlBatchStore(db);
    const identity = identityFromSecretKey(generateSecretKey());

    say('Precintum demo: one hour of an age verifier, recorded as evidence.');
    say(
      'Offline: the database and two relays run in memory; the time-stamp and the Bitcoin anchor are',
    );
    say('simulated (`pnpm test:it` uses the real ones).');
    say('');

    // 1 · Ingesta: el mismo caso de uso que hay detrás de POST /receipts.
    let clock = T0 + 25 * 60;
    const deps = {
      dedupKey: new Uint8Array(randomBytes(32)),
      dedupTtlSeconds: 86_400,
      now: () => clock,
    };
    const status = (o: Awaited<ReturnType<typeof ingestVerification>>): number =>
      o.ok ? (o.result.created ? 201 : 200) : o.status;
    say('1. Verifications arrive at the ingest endpoint (POST /receipts)');
    const a = await ingestVerification(evidence, deps, {
      transactionId: 'tx-1',
      result: 'over_18',
      at: T0 + 5 * 60,
    });
    say(
      `   tx-1  over_18                        -> ${status(a)}, receipt #${a.ok ? a.result.seq : '?'}`,
    );
    const b = await ingestVerification(evidence, deps, {
      transactionId: 'tx-2',
      result: 'under_18',
      at: T0 + 18 * 60,
    });
    say(
      `   tx-2  under_18                       -> ${status(b)}, receipt #${b.ok ? b.result.seq : '?'}`,
    );
    const pii = await ingestVerification(evidence, deps, {
      transactionId: 'tx-3',
      result: 'over_18',
      given_name: 'Nora',
      birth_date: '2004-05-06',
    });
    say(`   tx-3  with a name and a birth date   -> ${status(pii)}, nothing stored or logged`);
    const conflict = await ingestVerification(evidence, deps, {
      transactionId: 'tx-1',
      result: 'under_18',
      at: T0 + 20 * 60,
    });
    say(`   tx-1  again, with another result     -> ${status(conflict)}, the first one stands`);
    say(
      `   Each receipt holds eight fields and nothing about the person: ${(await evidence.receipts.count()).toString()} receipts, hash-chained.`,
    );
    say('');

    // 2 · Cierre de la ventana: raíz de Merkle, evento firmado, sello y ancla.
    clock = T0 + WINDOW + 60;
    const service = new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      identity,
      policy: POLICY,
      windowSeconds: WINDOW,
      tsa: fakeTsa({ genTime: () => new Date((T0 + WINDOW + 7) * 1000) }),
      ots: fakeOts({ completeOnUpgrade: () => true }),
      now: () => clock,
    });
    await service.closeDueWindows(clock);
    await service.anchorPending();
    const batch = await batches.head();
    if (!batch) throw new Error('demo: no batch was closed');
    const sealGap = (batch.tsaGenTime ?? 0) - batch.windowEnd;
    say(
      `2. The hour ${hhmm(batch.windowStart)}-${hhmm(batch.windowEnd)} UTC ends and the agent closes it`,
    );
    say(
      `   batch #${batch.seq}: ${batch.count} receipts -> Merkle root ${short(batch.root)} (32 bytes, nothing else)`,
    );
    say(`   signed Nostr event (kind 7676) ${short(batch.eventId)}`);
    say(
      `   time-stamp (simulated TSA) ${sealGap} s after the window closed: inside the 24 h anchoring window`,
    );
    say(
      `   Bitcoin anchor (simulated OpenTimestamps): ${batch.otsComplete ? 'complete' : 'pending'}`,
    );
    say('');

    // 3 · Testigos: el evento firmado va a dos relays independientes y se pide de vuelta.
    say('3. Two witnesses (relays in memory) receive the batch event');
    const witnesses: DemoResult['witnesses'] = [];
    for (const relay of relays) {
      const url = await relay.start();
      const client = new RelayClient(url, { identity });
      try {
        const receipt = await client.publish(batch.event);
        const found = await client.query([{ ids: [batch.eventId] }]);
        witnesses.push({ url, accepted: receipt.accepted, servesIt: found.length === 1 });
        say(
          `   ${url}  ${receipt.accepted ? 'accepted' : 'rejected'}, ${found.length === 1 ? 'serves it back by id' : 'does not serve it'}`,
        );
      } finally {
        client.close();
      }
    }
    say('');

    // 4 · El paquete de evidencia de esa hora, verificado desde cero.
    const pkg: EvidencePackage = await new ExportService({
      evidence,
      batches,
      windowSeconds: WINDOW,
      agentPubkey: identity.pubkey,
    }).exportRange(T0, T0 + WINDOW);
    const verified = verifyPackage(pkg, { expectedPubkey: identity.pubkey });
    const good = join(outDir, 'demo-package.json');
    writeFileSync(good, JSON.stringify(pkg, null, 2), 'utf8');
    say('4. The operator exports the evidence package for that hour; it is verified from scratch');
    say(
      `   ${verified.ok ? 'VERIFIED' : 'FAILED'}: ${verified.problems.length} problems, ${verified.warnings.length} warnings, ${verified.notes.length} notes (what cannot be checked offline)`,
    );
    say(`   -> ${good}`);
    say('');

    // 5 · El operador retoca un recibo y vuelve a exportar.
    const bad = structuredClone(pkg);
    for (const b2 of bad.batches) {
      for (const r of b2.receipts) if (r.result === 'under_18') r.result = 'over_18';
    }
    const tampered = verifyPackage(bad, { expectedPubkey: identity.pubkey });
    const badPath = join(outDir, 'demo-package-tampered.json');
    writeFileSync(badPath, JSON.stringify(bad, null, 2), 'utf8');
    say('5. A dishonest operator changes receipt #2 from under_18 to over_18 and exports again');
    say(
      `   ${tampered.ok ? 'VERIFIED (this should not happen)' : 'FAILED'}: the Merkle root recomputed from the receipts no longer matches`,
    );
    say('   the root inside the signed batch event, which the witnesses already hold.');
    say(`   -> ${badPath}`);
    say('');
    say('Open both files in web/verificador.html (nothing leaves the browser) to see every check.');

    return {
      ingest: {
        tx1: status(a),
        tx2: status(b),
        withPersonalData: status(pii),
        sameTxOtherResult: status(conflict),
      },
      batch: {
        seq: batch.seq,
        count: batch.count,
        root: batch.root,
        eventId: batch.eventId,
        sealGapSeconds: sealGap,
      },
      witnesses,
      verified,
      tampered,
      files: { good, tampered: badPath },
    };
  } finally {
    for (const relay of relays) await relay.stop().catch(() => undefined);
    await db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runDemo();
}
