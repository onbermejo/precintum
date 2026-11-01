/**
 * Hash-chain de recibos.
 *
 * Cada recibo lleva `seq` y `prev = hash(recibo anterior)`. Eso da integridad interna: alterar
 * un recibo cambia su hash y rompe el `prev` del siguiente. Lo que NO da por sí sola es
 * completitud: una cadena íntegra puede estar truncada (el operador presenta hasta el k y
 * dice que ahí acaba). Para eso el verificador necesita un dato externo: el hash de cabeza
 * (`expectHead`) o la longitud (`expectLength`) publicados en un lote.
 */
import {
  GENESIS,
  newNonce,
  RECEIPT_VERSION,
  type Receipt,
  type ReceiptInput,
  receiptHash,
  receiptSchema,
  truncateToMinute,
} from './receipt.ts';

/** Construye el siguiente recibo de la cadena. `nonce` se inyecta solo en tests. */
export function nextReceipt(
  prev: Receipt | null,
  input: ReceiptInput,
  nonce = newNonce(),
): Receipt {
  const ts = truncateToMinute(input.at);
  if (prev && ts < prev.ts) {
    throw new Error(
      `ts ${ts} es anterior al del recibo previo (${prev.ts}); la cadena no retrocede`,
    );
  }
  const receipt: Receipt = {
    v: RECEIPT_VERSION,
    seq: prev ? prev.seq + 1 : 1,
    prev: prev ? receiptHash(prev) : GENESIS,
    nonce,
    policy: input.policy,
    verifier: input.verifier,
    result: input.result,
    ts,
  };
  // Valida formato (hex, truncado al minuto…) antes de que entre en la cadena.
  return receiptSchema.parse(receipt);
}

export interface VerifyChainOptions {
  /** `seq` que debe tener el primer recibo (por defecto 1). */
  expectFirstSeq?: number;
  /** `prev` que debe tener el primer recibo (por defecto GENESIS). */
  expectPrev?: string;
  /** Hash del último recibo según una fuente externa (evento de lote). Detecta truncado y alteración del último. */
  expectHead?: string;
  /** Número de recibos según una fuente externa. */
  expectLength?: number;
}

export type ChainVerdict =
  | { ok: true; length: number; head: string | null }
  | { ok: false; at: number; reason: string };

/**
 * Verifica una cadena. Si falla, `at` es el `seq` del recibo sospechoso: en un fallo de
 * `prev`, el sospechoso es el anterior (alterado) o el propio (sustituido); se señala el
 * anterior porque es el caso habitual (WOW 1: UPDATE sobre un recibo intermedio).
 */
export function verifyChain(
  receipts: readonly unknown[],
  opts: VerifyChainOptions = {},
): ChainVerdict {
  let prevHash = opts.expectPrev ?? GENESIS;
  let expectedSeq = opts.expectFirstSeq ?? 1;
  let prevTs = -1;

  for (const [index, raw] of receipts.entries()) {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, at: expectedSeq, reason: `recibo en posición ${index} malformado` };
    }
    const r = parsed.data;
    if (r.seq !== expectedSeq) {
      const kind = r.seq > expectedSeq ? 'hueco' : 'duplicado o reordenación';
      return {
        ok: false,
        at: expectedSeq,
        reason: `seq ${r.seq}, se esperaba ${expectedSeq} (${kind})`,
      };
    }
    if (r.prev !== prevHash) {
      return {
        ok: false,
        at: Math.max(expectedSeq - 1, 1),
        reason: `prev del recibo ${r.seq} no coincide con el hash del recibo ${r.seq - 1}: alterado o sustituido`,
      };
    }
    if (r.ts < prevTs) {
      return { ok: false, at: r.seq, reason: `ts retrocede (${r.ts} < ${prevTs})` };
    }
    prevHash = receiptHash(r);
    prevTs = r.ts;
    expectedSeq++;
  }

  const length = receipts.length;
  const head = length ? prevHash : null;
  if (opts.expectLength !== undefined && opts.expectLength !== length) {
    return {
      ok: false,
      at: Math.min(length, opts.expectLength) + 1,
      reason: `la cadena tiene ${length} recibos y la fuente externa dice ${opts.expectLength}: truncada o inflada`,
    };
  }
  if (opts.expectHead !== undefined && opts.expectHead !== head) {
    return {
      ok: false,
      at: Math.max(length, 1),
      reason:
        'el hash de cabeza no coincide con el publicado: último recibo alterado o cadena truncada',
    };
  }
  return { ok: true, length, head };
}
