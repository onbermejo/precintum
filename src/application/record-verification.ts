/**
 * Caso de uso: registrar una verificación como recibo.
 *
 * Entra lo que la cuarentena del adaptador del verifier deja pasar: el id de la
 * transacción del verifier (solo para idempotencia), el resultado, la política, la
 * configuración del verifier y el instante. Sale un recibo encadenado.
 *
 * Idempotencia sin contaminar el recibo: la clave de deduplicación es HMAC(k, transaction_id)
 * con una clave del operador, vive en `ingest_dedup` con TTL y se purga. El recibo no contiene
 * nada derivado del transaction_id: ni el HMAC, ni un hash, ni la sal.
 *
 * Política de tiempo (ADR-0001): el `ts` del recibo es la hora de
 * REGISTRO según el reloj del agente, no la hora que declare el adaptador. El instante declarado
 * (`at`) solo puede adelantar el minuto dentro de la ventana abierta: nunca retrocede respecto a
 * la cabeza de la cadena ni entra en una ventana ya cerrada y publicada. Un recibo en una ventana
 * cerrada quedaría fuera de todo lote y el export lo señalaría como manipulación de un operador
 * honesto. Un `at` muy en el futuro se rechaza: es un reloj mal puesto, no un dato.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { nextReceipt } from '../domain/evidence/chain.ts';
import type { EvidenceStore } from '../domain/evidence/evidence-store.ts';
import type { VerificationResult } from '../domain/evidence/receipt.ts';
import { bytesToHex } from '../shared/hex.ts';

export interface RecordVerificationCommand {
  /** Identificador de la transacción en el verifier. Solo se usa para deduplicar. */
  transactionId: string;
  result: VerificationResult;
  /** Hash hex de la política aplicada. */
  policy: string;
  /** Hash hex de la configuración del verifier. */
  verifier: string;
  /** Instante de la verificación según el adaptador, segundos unix. Ver la política de tiempo. */
  at: number;
}

export interface RecordVerificationDeps {
  /** Clave HMAC del operador para las claves de deduplicación (32 bytes). */
  dedupKey: Uint8Array;
  /** Cuánto vive la correlación transacción↔recibo. Tras esto, el enlace desaparece. */
  dedupTtlSeconds: number;
  /** Reloj inyectable (segundos unix). Por defecto, el del sistema. */
  now?: () => number;
  /** Cuánto puede adelantarse `at` al reloj del agente antes de rechazarse (300 s por defecto). */
  maxFutureSkewSeconds?: number;
}

export interface RecordVerificationResult {
  seq: number;
  /** false si la transacción ya tenía recibo (reintento o replay). */
  created: boolean;
  /** true si el minuto registrado es posterior al instante declarado (cadena o ventana cerrada). */
  adjusted: boolean;
}

/** La transacción ya tiene recibo y llega con otro resultado: se rechaza y no se toca nada. */
export class ConflictError extends Error {
  readonly seq: number;
  constructor(seq: number) {
    super(`la transacción ya tiene el recibo #${seq} con otro resultado; no se registra otro`);
    this.name = 'ConflictError';
    this.seq = seq;
  }
}

export function dedupKeyFor(dedupKey: Uint8Array, transactionId: string): string {
  return bytesToHex(hmac(sha256, dedupKey, utf8ToBytes(transactionId)));
}

const ceilToMinute = (t: number): number => Math.ceil(t / 60) * 60;

export async function recordVerification(
  store: EvidenceStore,
  deps: RecordVerificationDeps,
  cmd: RecordVerificationCommand,
): Promise<RecordVerificationResult> {
  if (deps.dedupKey.length !== 32) throw new Error('dedupKey debe tener 32 bytes');
  if (!Number.isInteger(cmd.at) || cmd.at < 0)
    throw new RangeError('`at` debe ser un entero de segundos unix');
  const key = dedupKeyFor(deps.dedupKey, cmd.transactionId);
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const skew = deps.maxFutureSkewSeconds ?? 300;
  if (cmd.at > now + skew) {
    throw new RangeError(
      `el instante declarado (${cmd.at}) va ${cmd.at - now} s por delante del reloj del agente; el máximo admitido es ${skew} s`,
    );
  }

  return store.transaction(async (tx) => {
    const existing = await tx.dedup.lookup(key, now);
    if (existing !== null) {
      // Reintento legítimo: mismo resultado. Si cambia, gana el primero y se avisa con un error.
      const prior = await tx.receipts.get(existing);
      if (prior && prior.result !== cmd.result) throw new ConflictError(existing);
      return { seq: existing, created: false, adjusted: false };
    }

    const head = await tx.receipts.head();
    const closedUntil = await tx.closedUntil();
    // El minuto no retrocede respecto a la cabeza ni cae en una ventana ya cerrada: lo que se
    // prueba es el registro. `ceilToMinute` mantiene el ts dentro de la ventana abierta aunque
    // el tamaño de ventana no sea múltiplo de 60 (toda ventana dura al menos 60 s).
    const floor = Math.max(head?.ts ?? 0, closedUntil === null ? 0 : ceilToMinute(closedUntil));
    const at = Math.max(cmd.at, floor);
    const receipt = nextReceipt(head, {
      policy: cmd.policy,
      verifier: cmd.verifier,
      result: cmd.result,
      at,
    });
    await tx.receipts.append(receipt);
    await tx.dedup.remember(key, receipt.seq, now + deps.dedupTtlSeconds);
    return { seq: receipt.seq, created: true, adjusted: receipt.ts > cmd.at };
  });
}
