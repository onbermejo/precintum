import type { NostrEvent } from '../nostr/event.ts';

/** Un lote cerrado, con su evento firmado y sus anclajes (que llegan después). */
export interface BatchRecord {
  seq: number;
  root: string;
  prevRoot: string;
  windowStart: number;
  windowEnd: number;
  policy: string;
  count: number;
  /** Sal del compromiso del recuento: solo se revela al auditor. */
  countSalt: string;
  /** Rango de recibos incluidos (null si el lote está vacío). */
  fromReceiptSeq: number | null;
  toReceiptSeq: number | null;
  eventId: string;
  event: NostrEvent;
  /** TimeStampToken RFC 3161 (DER) y su genTime, o null si aún no se ha sellado. */
  tsaToken: Uint8Array | null;
  tsaGenTime: number | null;
  /** Fichero .ots (detached) y si ya tiene atestación Bitcoin. */
  ots: Uint8Array | null;
  otsComplete: boolean;
}

export interface BatchStore {
  head(): Promise<BatchRecord | null>;
  append(batch: BatchRecord): Promise<void>;
  get(seq: number): Promise<BatchRecord | null>;
  range(fromSeq: number, toSeq: number): Promise<BatchRecord[]>;
  /**
   * Lotes cuya ventana está contenida en [from, to), ordenados por seq. Es la consulta de una
   * petición por fechas: la unidad es la ventana, no el recibo suelto.
   */
  inTimeRange(from: number, to: number): Promise<BatchRecord[]>;
  /** El lote que contiene el recibo `receiptSeq`, si lo hay. */
  containingReceipt(receiptSeq: number): Promise<BatchRecord | null>;
  setTsa(seq: number, token: Uint8Array, genTime: number): Promise<void>;
  setOts(seq: number, ots: Uint8Array, complete: boolean): Promise<void>;
  /** Lotes con algún anclaje pendiente: sin sello RFC 3161, sin .ots o con .ots aún no completo. */
  pendingAnchors(limit: number): Promise<BatchRecord[]>;
  /** Lotes cuyo evento no está en la outbox de testigos: nunca debería haberlos; se reconcilian. */
  notEnqueued(limit: number): Promise<BatchRecord[]>;
  count(): Promise<number>;
}
