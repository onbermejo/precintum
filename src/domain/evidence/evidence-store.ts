/**
 * Puertos de persistencia del dominio de evidencia. El dominio define QUÉ se guarda;
 * infra/db decide CÓMO (PostgreSQL nativo en desarrollo y producción, PGlite en tests).
 */
import type { Receipt } from './receipt.ts';

export interface ReceiptRepository {
  /** Último recibo de la cadena, o null si está vacía. */
  head(): Promise<Receipt | null>;
  /**
   * Añade un recibo. Debe fallar si `seq` no es head+1 o si `prev` no es el hash de head:
   * la base de datos es la última línea de defensa contra una cadena rota.
   */
  append(receipt: Receipt): Promise<void>;
  get(seq: number): Promise<Receipt | null>;
  /** Recibos con seq en [fromSeq, toSeq], ordenados. */
  range(fromSeq: number, toSeq: number): Promise<Receipt[]>;
  /** Recibos con ts en [start, end), ordenados por seq (los lotes se cortan por ventana). */
  inWindow(start: number, end: number): Promise<Receipt[]>;
  /** ts del primer recibo, o null si no hay ninguno. */
  firstTs(): Promise<number | null>;
  count(): Promise<number>;
}

/**
 * Correlación efímera transacción-del-verifier ↔ recibo, para idempotencia. La clave es un
 * HMAC del identificador del verifier con una clave del operador; caduca y se purga. Es la
 * única tabla que une un recibo con algo del verifier, y por eso no forma parte del recibo.
 */
export interface DedupStore {
  lookup(key: string, now: number): Promise<number | null>;
  remember(key: string, seq: number, expiresAt: number): Promise<void>;
  /** Borra entradas caducadas. Devuelve cuántas. */
  purgeExpired(now: number): Promise<number>;
}

export interface EvidenceStore {
  readonly receipts: ReceiptRepository;
  readonly dedup: DedupStore;
  /**
   * Fin de la última ventana ya cerrada en un lote (segundos unix), o null si no hay lotes. Un
   * recibo nuevo nunca lleva `ts` anterior: esa ventana ya está publicada en los testigos.
   */
  closedUntil(): Promise<number | null>;
  /**
   * Ejecuta `fn` en una transacción con el lock de la cadena tomado; el store que recibe opera
   * dentro de ella. La ingesta y el cierre de lotes comparten ese lock y no se pisan.
   */
  transaction<T>(fn: (tx: EvidenceStore) => Promise<T>): Promise<T>;
}
