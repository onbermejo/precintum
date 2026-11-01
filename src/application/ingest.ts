/**
 * Ingesta de verificaciones (ADR-0003): el mensaje que cualquier adaptador (verifier EUDI, webhook
 * de un vendor, la CLI) envía al agente, y su cuarentena.
 *
 * La cuarentena es el propio esquema: cerrado y estricto. Un cuerpo con un campo de más se rechaza
 * sin describir el campo; lo que no está en el esquema no se lee, no se registra y no se responde.
 * Así el único sitio donde la PII del verifier podría colarse es el adaptador, que vive fuera del
 * agente y tiene su propio contrato.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import type { EvidenceStore } from '../domain/evidence/evidence-store.ts';
import { isSafeLabel, RESULTS } from '../domain/evidence/receipt.ts';
import { bytesToHex, isHex64 } from '../shared/hex.ts';
import {
  ConflictError,
  type RecordVerificationDeps,
  type RecordVerificationResult,
  recordVerification,
} from './record-verification.ts';

/** Etiqueta legible (se hashea) o hash hex ya calculado: lo que admiten `policy` y `verifier`. */
export function hashLabel(value: string): string {
  return isHex64(value) ? value : bytesToHex(sha256(utf8ToBytes(value)));
}

/** Longitud máxima del cuerpo: un mensaje legítimo ocupa unos 200 bytes. */
export const INGEST_MAX_BODY_BYTES = 4_096;

/** Etiqueta de política o de verifier: formato de versión o hash hex (ver `LABEL_PATTERN`). */
const label = z.string().refine(isSafeLabel, 'etiqueta con formato no admitido');

export const ingestMessageSchema = z.strictObject({
  /** Identificador de la transacción en el verifier o en el vendor. Solo para idempotencia. */
  transactionId: z.string().min(1).max(256),
  result: z.enum(RESULTS),
  /** Etiqueta o hash hex de la política aplicada. */
  policy: label.default('age_over_18/v1'),
  /** Etiqueta o hash hex de la configuración del verifier que decidió. */
  verifier: label.default('unknown-verifier'),
  /** Instante según el adaptador, segundos unix. Si falta, el reloj del agente. */
  at: z.number().int().nonnegative().optional(),
});

export type IngestMessage = z.infer<typeof ingestMessageSchema>;

/**
 * Valida el cuerpo y registra el recibo. Devuelve `{ ok: false, status }` sin detalles para los
 * cuerpos inválidos: el motivo no viaja de vuelta (podría contener lo que se intentó colar).
 */
export async function ingestVerification(
  store: EvidenceStore,
  deps: RecordVerificationDeps,
  body: unknown,
): Promise<
  | { ok: true; result: RecordVerificationResult; verificationResult: IngestMessage['result'] }
  | { ok: false; status: 400 | 409 | 422 }
> {
  const parsed = ingestMessageSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400 };
  const msg = parsed.data;
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  try {
    const result = await recordVerification(store, deps, {
      transactionId: msg.transactionId,
      result: msg.result,
      policy: hashLabel(msg.policy),
      verifier: hashLabel(msg.verifier),
      at: msg.at ?? now,
    });
    return { ok: true, result, verificationResult: msg.result };
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, status: 422 };
    if (err instanceof ConflictError) return { ok: false, status: 409 };
    throw err;
  }
}
