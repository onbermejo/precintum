/**
 * El recibo: la unidad de evidencia de Precintum. Ver ADR-0001 (docs/adr/0001-esquema-recibo-v1.md).
 *
 * Contiene exactamente lo necesario para probar "el sistema del operador registró una
 * verificación con esta política, con este resultado, en este minuto" y NADA que permita
 * reidentificar o correlacionar a la persona:
 *
 *   v        versión del esquema
 *   seq      posición en la cadena (1, 2, 3…)
 *   prev     hash del recibo anterior (o GENESIS)
 *   nonce    32 bytes aleatorios generados por Precintum. No es función de nada del verifier.
 *   policy   hash de la política aplicada (qué se exigió: p. ej. age_over_18 con ZKP)
 *   verifier hash de la configuración del verifier (qué software y versión decidió)
 *   result   over_18 | under_18 | error
 *   ts       instante de la verificación, en segundos unix, TRUNCADO AL MINUTO
 *
 * Lo que NO hay y no habrá: id de sesión del verifier ni ningún derivado suyo (ni hasheado,
 * ni con sal: EDPB 02/2025 v2 lo considera dato personal mientras exista la sal), atributos,
 * IP, identificador de wallet, timestamp exacto. La correlación recibo↔transacción del
 * verifier vive en otra tabla, con TTL, y se destruye (ver application/record-verification.ts).
 */
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { bytesToHex } from '../../shared/hex.ts';
import { canonicalize, DOMAINS, hashWithDomain } from './hash.ts';

export const RECEIPT_VERSION = 1 as const;
export const RESULTS = ['over_18', 'under_18', 'error'] as const;
export type VerificationResult = (typeof RESULTS)[number];

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'debe ser hex de 32 bytes');

export const receiptSchema = z.strictObject({
  v: z.literal(RECEIPT_VERSION),
  seq: z.number().int().positive(),
  prev: hex64,
  nonce: hex64,
  policy: hex64,
  verifier: hex64,
  result: z.enum(RESULTS),
  ts: z
    .number()
    .int()
    .nonnegative()
    .refine((t) => t % 60 === 0, 'ts debe estar truncado al minuto'),
});

export type Receipt = z.infer<typeof receiptSchema>;

/** Los únicos campos que existen. Cualquier otro es un bug o una fuga. */
export const RECEIPT_FIELDS = Object.keys(receiptSchema.shape).sort() as readonly (keyof Receipt)[];

/** Lo que aporta el adaptador del verifier tras la cuarentena. Nada más entra al recibo. */
export interface ReceiptInput {
  /** Hash hex de la política aplicada. */
  policy: string;
  /** Hash hex de la configuración del verifier. */
  verifier: string;
  result: VerificationResult;
  /** Instante de la verificación en segundos unix. Se trunca al minuto. */
  at: number;
}

/**
 * Formato admitido para las etiquetas de política y de verifier (`age_over_18/v1`,
 * `av-srv-verifier-endpoint/0.11.0`) o un hash hex de 32 bytes: letras, números y `. _ : / -`, hasta
 * 64. Se hashean sin sal y el hash va al recibo; un texto libre podría llevar algo de la persona (un
 * nombre, un correo) y su hash se podría adivinar. Un hash hex de 64 caracteres también cumple.
 */
export const LABEL_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/;

export function isSafeLabel(value: string): boolean {
  return LABEL_PATTERN.test(value);
}

/** Hash del "recibo cero": el `prev` del primer recibo de una cadena. */
export const GENESIS: string = hashWithDomain(DOMAINS.genesis, new Uint8Array());

export function newNonce(): string {
  return bytesToHex(randomBytes(32));
}

export function truncateToMinute(seconds: number): number {
  return Math.floor(seconds / 60) * 60;
}

/** Hash con dominio del JSON canónico del recibo. Es lo que encadena y lo que va a Merkle. */
export function receiptHash(receipt: Receipt): string {
  return hashWithDomain(DOMAINS.receipt, utf8ToBytes(canonicalize(receipt)));
}

export type ReceiptCheck = { ok: true; receipt: Receipt } | { ok: false; reason: string };

export function validateReceipt(candidate: unknown): ReceiptCheck {
  const parsed = receiptSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, receipt: parsed.data };
  const reason = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
    .join('; ');
  return { ok: false, reason };
}
