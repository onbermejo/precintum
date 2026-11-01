/**
 * Comandos de la CLI: base de datos, recibos y cadena.
 * Son herramientas de operador y de demo; el flujo real llegará por el adaptador del
 * verifier, que llama al mismo caso de uso `recordVerification`.
 */
import { randomBytes } from '@noble/hashes/utils.js';
import { hashLabel } from '../application/ingest.ts';
import { recordVerification } from '../application/record-verification.ts';
import { verifyChain } from '../domain/evidence/chain.ts';
import {
  isSafeLabel,
  RESULTS,
  receiptHash,
  type VerificationResult,
} from '../domain/evidence/receipt.ts';
import { migrate } from '../infra/db/migrations.ts';
import { openSqlClient } from '../infra/db/open.ts';
import { SqlEvidenceStore } from '../infra/db/sql-evidence-store.ts';
import type { Config } from '../shared/config.ts';
import { bytesToHex, hexToBytes } from '../shared/hex.ts';
import { redactUrl } from '../shared/redact.ts';

export interface ReceiptAddOptions {
  result?: string | undefined;
  policy?: string | undefined;
  verifier?: string | undefined;
  tx?: string | undefined;
  at?: string | undefined;
}

/** Abre la base de datos y aplica migraciones pendientes. Devuelve el store y cómo cerrarlo. */
async function openStore(cfg: Config) {
  const db = await openSqlClient(cfg.PRECINTUM_DATABASE_URL);
  const applied = await migrate(db);
  return { store: new SqlEvidenceStore(db), applied, close: () => db.close() };
}

function dedupKey(cfg: Config): Uint8Array {
  if (cfg.PRECINTUM_DEDUP_KEY) return hexToBytes(cfg.PRECINTUM_DEDUP_KEY);
  console.error(
    'AVISO: sin PRECINTUM_DEDUP_KEY se usa una clave efímera; los reintentos entre ejecuciones no se deduplicarán.',
  );
  return randomBytes(32);
}

export async function cmdDbMigrate(cfg: Config): Promise<void> {
  const { applied, close } = await openStore(cfg);
  try {
    console.log(
      applied.length
        ? `migraciones aplicadas: ${applied.join(', ')}`
        : 'base de datos al día, sin migraciones pendientes',
    );
    console.log(`base de datos: ${redactUrl(cfg.PRECINTUM_DATABASE_URL)}`);
  } finally {
    await close();
  }
}

export async function cmdReceiptAdd(cfg: Config, opts: ReceiptAddOptions): Promise<void> {
  const result = opts.result as VerificationResult | undefined;
  if (!result || !RESULTS.includes(result)) {
    throw new Error(`--result debe ser uno de: ${RESULTS.join(' | ')}`);
  }
  const at = opts.at ? Number(opts.at) : Math.floor(Date.now() / 1000);
  if (!Number.isInteger(at) || at < 0) throw new Error('--at debe ser un entero (segundos unix)');
  for (const [flag, value] of [
    ['--policy', opts.policy],
    ['--verifier', opts.verifier],
  ] as const) {
    if (value !== undefined && !isSafeLabel(value)) {
      throw new Error(
        `${flag}: usa una etiqueta de versión (letras, números y . _ : / -, hasta 64) o un hash hex`,
      );
    }
  }
  const { store, close } = await openStore(cfg);
  try {
    const outcome = await recordVerification(
      store,
      {
        dedupKey: dedupKey(cfg),
        dedupTtlSeconds: cfg.PRECINTUM_DEDUP_TTL_SECONDS,
        maxFutureSkewSeconds: cfg.PRECINTUM_MAX_FUTURE_SKEW_SECONDS,
      },
      {
        transactionId: opts.tx ?? `manual-${bytesToHex(randomBytes(8))}`,
        result,
        policy: hashLabel(opts.policy ?? 'age_over_18/v1'),
        verifier: hashLabel(opts.verifier ?? 'manual-cli'),
        at,
      },
    );
    const receipt = await store.receipts.get(outcome.seq);
    console.log(
      outcome.created
        ? `recibo #${outcome.seq} creado (${receipt ? receiptHash(receipt).slice(0, 16) : '?'}…)`
        : `la transacción ya tenía recibo: #${outcome.seq} (idempotente, no se creó otro)`,
    );
    if (outcome.adjusted) {
      console.error(
        'nota: el minuto registrado es posterior al instante declarado (la cadena no retrocede ni entra en una ventana ya cerrada)',
      );
    }
    // La correlación transacción↔recibo caduca de verdad en cada pase, no solo en la consulta.
    await store.dedup.purgeExpired(Math.floor(Date.now() / 1000));
  } finally {
    await close();
  }
}

export async function cmdChainVerify(cfg: Config): Promise<boolean> {
  const { store, close } = await openStore(cfg);
  try {
    const n = await store.receipts.count();
    const receipts = n ? await store.receipts.range(1, n) : [];
    const verdict = verifyChain(receipts, { expectLength: n });
    if (verdict.ok) {
      console.log(
        `cadena íntegra: ${verdict.length} recibos, cabeza ${verdict.head?.slice(0, 16) ?? '(vacía)'}…`,
      );
      return true;
    }
    console.error(`CADENA ROTA en el recibo #${verdict.at}: ${verdict.reason}`);
    return false;
  } finally {
    await close();
  }
}

export async function cmdChainShow(cfg: Config, last = 10): Promise<void> {
  const { store, close } = await openStore(cfg);
  try {
    const n = await store.receipts.count();
    if (n === 0) {
      console.log('cadena vacía');
      return;
    }
    const from = Math.max(1, n - last + 1);
    const receipts = await store.receipts.range(from, n);
    console.log(`${n} recibos; mostrando ${from}..${n}`);
    console.log('seq      minuto (UTC)          resultado  hash');
    for (const r of receipts) {
      const when = new Date(r.ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
      console.log(
        `${String(r.seq).padEnd(8)} ${when.padEnd(21)} ${r.result.padEnd(10)} ${receiptHash(r).slice(0, 16)}…`,
      );
    }
  } finally {
    await close();
  }
}
