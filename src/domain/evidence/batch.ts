/**
 * Lotes: la unidad de publicación y anclaje. Cada ventana fija de tiempo produce un lote
 * (también si está vacío: latido) con la raíz Merkle de los recibos de la ventana.
 *
 * Reglas de completitud:
 *  - una raíz por ventana, sin huecos: `seq` consecutivo y `prevRoot` encadenado;
 *  - cadencia fija, así la ausencia de un lote es detectable y la presencia no revela actividad;
 *  - el recuento va como compromiso (sal revelada solo al auditor);
 *  - regla de ventana de anclaje: la prueba de tiempo del lote debe estar a menos de un gap
 *    máximo del fin de su ventana, o el lote se marca en rojo (defensa contra backdating).
 */
import { type BatchData, commitCount } from './batch-event.ts';
import {
  EMPTY_ROOT,
  type InclusionProof,
  inclusionProof,
  merkleRoot,
  verifyInclusion,
} from './merkle.ts';
import { type Receipt, receiptHash } from './receipt.ts';

export interface Window {
  /** Inicio, inclusivo (segundos unix). */
  start: number;
  /** Fin, exclusivo. */
  end: number;
}

/** Ventana alineada que contiene `ts`: [k·size, (k+1)·size). */
export function windowOf(ts: number, sizeSeconds: number): Window {
  if (!Number.isInteger(sizeSeconds) || sizeSeconds <= 0)
    throw new Error('tamaño de ventana inválido');
  const start = Math.floor(ts / sizeSeconds) * sizeSeconds;
  return { start, end: start + sizeSeconds };
}

export interface BuiltBatch {
  data: BatchData;
  /** Hashes de los recibos, en orden de `seq`: las hojas del árbol. */
  leaves: string[];
  count: number;
}

export interface BuildBatchInput {
  seq: number;
  prevRoot: string;
  window: Window;
  policy: string;
  countSalt: string;
  /** Recibos de la ventana, ordenados por seq. Puede estar vacío (latido). */
  receipts: readonly Receipt[];
}

export function buildBatch(input: BuildBatchInput): BuiltBatch {
  for (const r of input.receipts) {
    if (r.ts < input.window.start || r.ts >= input.window.end) {
      throw new Error(
        `el recibo ${r.seq} (ts ${r.ts}) no pertenece a la ventana [${input.window.start}, ${input.window.end})`,
      );
    }
  }
  const leaves = input.receipts.map(receiptHash);
  const root = leaves.length ? merkleRoot(leaves) : EMPTY_ROOT;
  return {
    data: {
      seq: input.seq,
      root,
      prevRoot: input.prevRoot,
      windowStart: input.window.start,
      windowEnd: input.window.end,
      policy: input.policy,
      countCommitment: commitCount(leaves.length, input.countSalt),
    },
    leaves,
    count: leaves.length,
  };
}

export interface ReceiptProof {
  receiptSeq: number;
  receiptHash: string;
  batchSeq: number;
  root: string;
  proof: InclusionProof;
}

/** Prueba de inclusión de un recibo en su lote, a partir de los recibos de la ventana. */
export function proveReceipt(
  batchSeq: number,
  receiptsInWindow: readonly Receipt[],
  receiptSeq: number,
): ReceiptProof {
  const index = receiptsInWindow.findIndex((r) => r.seq === receiptSeq);
  if (index < 0) throw new Error(`el recibo ${receiptSeq} no está en el lote ${batchSeq}`);
  const leaves = receiptsInWindow.map(receiptHash);
  return {
    receiptSeq,
    receiptHash: leaves[index] as string,
    batchSeq,
    root: merkleRoot(leaves),
    proof: inclusionProof(leaves, index),
  };
}

export function verifyReceiptProof(p: ReceiptProof, expectedRoot: string): boolean {
  return p.root === expectedRoot && verifyInclusion(p.receiptHash, p.proof, expectedRoot);
}

export interface AnchorWindowCheck {
  ok: boolean;
  /** Segundos entre el fin de la ventana y el instante de la prueba de tiempo (negativo = antes). */
  gapSeconds: number;
  maxGapSeconds: number;
}

/**
 * Regla de ventana de anclaje: el sello (TSA o bloque Bitcoin) debe estar entre el fin de la
 * ventana y `maxGap` segundos después. Un sello anterior al fin de la ventana es imposible
 * (el lote aún no existía); uno muy posterior es sospechoso de backdating con clave robada.
 */
export function checkAnchorWindow(
  windowEnd: number,
  anchorTime: number,
  maxGapSeconds: number,
): AnchorWindowCheck {
  const gapSeconds = anchorTime - windowEnd;
  return { ok: gapSeconds >= 0 && gapSeconds <= maxGapSeconds, gapSeconds, maxGapSeconds };
}
