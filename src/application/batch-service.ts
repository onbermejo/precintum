/**
 * Cierre de lotes y anclaje.
 *
 * `closeDueWindows(now)`: por cada ventana terminada (más un periodo de gracia) y sin lote,
 * construye el lote (también vacío: latido), firma el evento `kind 7676` y, en UNA transacción,
 * guarda el lote y lo encola en la outbox de testigos: o las dos cosas o ninguna. Un
 * lote que existiera sin entrada en la outbox sería un eslabón que solo conoce la base de datos
 * del operador, justo lo que los testigos deben impedir; por eso además cada pase reconcilia.
 * Tras confirmar se archiva el evento en el append-only local y se piden los anclajes: sello
 * RFC 3161 y envío a los calendarios OpenTimestamps. Los anclajes van fuera de la transacción y
 * fuera del bucle (una TSA lenta no retrasa el cierre) y sus fallos se reintentan en
 * `anchorPending`.
 *
 * La transacción de cierre toma el mismo lock de advisory que la ingesta (`SqlEvidenceStore`):
 * un recibo no puede colarse en una ventana mientras se cierra, y la ingesta lee un `closedUntil`
 * estable. El periodo de gracia da margen a los recibos que llegan con latencia (polling del
 * verifier) justo después de que termine su ventana.
 *
 * El digest que se sella y se ancla es el **id del evento de lote**: compromete la raíz, la
 * ventana, el `seq`, el `prevRoot` y el compromiso del recuento, y la firma del agente lo
 * cubre. Sellar la raíz sola dejaría fuera la ventana y permitiría reutilizar el sello.
 */

import { buildBatch, proveReceipt, type ReceiptProof, windowOf } from '../domain/evidence/batch.ts';
import { buildBatchEvent } from '../domain/evidence/batch-event.ts';
import type { BatchRecord, BatchStore } from '../domain/evidence/batch-store.ts';
import type { EvidenceStore } from '../domain/evidence/evidence-store.ts';
import { GENESIS, newNonce } from '../domain/evidence/receipt.ts';
import type { Identity } from '../domain/identity/keys.ts';
import type { NostrEvent } from '../domain/nostr/event.ts';
import type { OutboxStore } from '../domain/witness/witness-store.ts';
import { hexToBytes } from '../shared/hex.ts';
import type { Logger } from '../shared/logger.ts';

/** Sello de tiempo RFC 3161 para un digest. Inyectable (tests). */
export interface TsaClient {
  request(digest: Uint8Array): Promise<{ tokenDer: Uint8Array; genTime: Date }>;
}

/** Anclaje OpenTimestamps para un digest. `submit` devuelve el .ots (pending); `upgrade` lo actualiza. */
export interface OtsClient {
  submit(digest: Uint8Array): Promise<Uint8Array>;
  upgrade(ots: Uint8Array): Promise<{ ots: Uint8Array; complete: boolean }>;
}

/** Los stores que participan en el cierre de un lote, ligados a una misma transacción. */
export interface CloseStores {
  evidence: EvidenceStore;
  batches: BatchStore;
  outbox: OutboxStore;
}

/**
 * Unidad de trabajo: ejecuta `fn` dentro de una transacción con el lock de la cadena tomado.
 * La construye infra (`evidenceUnitOfWork`) porque solo ella sabe ligar tres stores a la misma
 * conexión; el dominio y la aplicación solo ven la promesa de atomicidad.
 */
export type UnitOfWork = <T>(fn: (stores: CloseStores) => Promise<T>) => Promise<T>;

export interface BatchServiceDeps {
  evidence: EvidenceStore;
  batches: BatchStore;
  /** Transacción que abarca lote + outbox. */
  tx: UnitOfWork;
  /**
   * Se llama tras confirmar cada lote nuevo: archivo append-only u otros testigos locales. Un
   * fallo aquí no deshace el lote (ya está encolado para los relays): se registra como error.
   */
  afterCommit?: (event: NostrEvent) => Promise<unknown>;
  identity: Identity;
  /** Hash hex de la política vigente. */
  policy: string;
  windowSeconds: number;
  /**
   * Segundos que se esperan tras el fin de una ventana antes de cerrarla, para que entren los
   * recibos que llegan con latencia. 0 por defecto (los tests); la CLI pasa la configuración.
   */
  graceSeconds?: number;
  /** Tope de ventanas por pase (500 por defecto): protege de un arranque con meses de retraso. */
  maxWindowsPerPass?: number;
  tsa?: TsaClient;
  ots?: OtsClient;
  now?: () => number;
  log?: Logger;
}

export interface CloseSummary {
  closed: number;
  empty: number;
  receipts: number;
  /** Lotes que existían sin entrada en la outbox y se han encolado en este pase. */
  reconciled: number;
  /** Ventanas terminadas que quedan sin cerrar por el tope del pase. */
  remaining: number;
}

export class BatchService {
  private readonly deps: BatchServiceDeps;

  constructor(deps: BatchServiceDeps) {
    if (!Number.isInteger(deps.windowSeconds) || deps.windowSeconds < 60) {
      throw new Error('la ventana de lote debe ser un entero de al menos 60 segundos');
    }
    if (
      deps.graceSeconds !== undefined &&
      (!Number.isInteger(deps.graceSeconds) || deps.graceSeconds < 0)
    ) {
      throw new Error('el periodo de gracia debe ser un entero no negativo de segundos');
    }
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Cierra las ventanas terminadas (y fuera del periodo de gracia) que aún no tienen lote. */
  async closeDueWindows(now: number = this.now()): Promise<CloseSummary> {
    const summary: CloseSummary = { closed: 0, empty: 0, receipts: 0, reconciled: 0, remaining: 0 };
    const size = this.deps.windowSeconds;
    const grace = this.deps.graceSeconds ?? 0;
    const maxWindows = this.deps.maxWindowsPerPass ?? 500;

    // Higiene de cada pase: la correlación transacción↔recibo caduca de verdad, no solo en la
    // consulta; y ningún lote se queda sin camino hacia los testigos.
    await this.deps.evidence.dedup.purgeExpired(now);
    summary.reconciled = await this.reconcileOutbox(now);

    let head = await this.deps.batches.head();
    let start = head ? head.windowEnd : await this.firstWindowStart(now, size);
    const closed: BatchRecord[] = [];
    while (start + size + grace <= now) {
      if (closed.length >= maxWindows) {
        summary.remaining = Math.floor((now - grace - start) / size);
        this.deps.log?.warn(
          { closed: closed.length, remaining: summary.remaining },
          'tope de ventanas por pase alcanzado; el resto se cierra en el siguiente',
        );
        break;
      }
      const window = { start, end: start + size };
      const expectedPrev = head;
      const record = await this.deps.tx(async ({ evidence, batches, outbox }) => {
        // Con el lock tomado, la cabeza no puede haber cambiado; si cambió, otro proceso está
        // cerrando lotes a la vez y este pase se detiene sin romper nada.
        const current = await batches.head();
        if ((current?.seq ?? 0) !== (expectedPrev?.seq ?? 0)) {
          throw new Error('otro proceso ha cerrado lotes mientras tanto; repite el pase');
        }
        const receipts = await evidence.receipts.inWindow(window.start, window.end);
        const seq = (expectedPrev?.seq ?? 0) + 1;
        // La sal del compromiso del recuento se guarda con el lote y solo se revela al auditor.
        const countSalt = newNonce();
        const built = buildBatch({
          seq,
          prevRoot: expectedPrev?.root ?? GENESIS,
          window,
          policy: this.deps.policy,
          countSalt,
          receipts,
        });
        const event = buildBatchEvent(built.data, this.deps.identity, window.end);
        const rec: BatchRecord = {
          ...built.data,
          count: built.count,
          countSalt,
          fromReceiptSeq: receipts[0]?.seq ?? null,
          toReceiptSeq: receipts.at(-1)?.seq ?? null,
          eventId: event.id,
          event,
          tsaToken: null,
          tsaGenTime: null,
          ots: null,
          otsComplete: false,
        };
        await batches.append(rec);
        await outbox.enqueue(event, now);
        return rec;
      });
      if (this.deps.afterCommit) {
        try {
          await this.deps.afterCommit(record.event);
        } catch (err) {
          this.deps.log?.error(
            { seq: record.seq, err: String(err) },
            'lote cerrado y encolado, pero el testigo local (archivo) ha fallado',
          );
        }
      }
      this.deps.log?.info(
        { seq: record.seq, count: record.count, root: record.root },
        'lote cerrado',
      );
      summary.closed++;
      summary.receipts += record.count;
      if (record.count === 0) summary.empty++;
      closed.push(record);
      head = record;
      start = window.end;
    }
    // Anclajes fuera de la transacción y del bucle: una TSA lenta no retrasa el cierre.
    for (const r of closed) await this.anchor(r);
    return summary;
  }

  /**
   * Primera ventana: la que contiene el primer recibo. Sin recibos, la anterior a la actual: así
   * el primer `batch close` ya produce un latido y la cadena de lotes arranca con el servicio
   * (afirmar "0 recibos en esa ventana" es cierto).
   */
  private async firstWindowStart(now: number, size: number): Promise<number> {
    const firstTs = await this.deps.evidence.receipts.firstTs();
    return firstTs !== null ? windowOf(firstTs, size).start : windowOf(now, size).start - size;
  }

  /** Lotes que existen sin entrada en la outbox (un proceso murió a mitad, antes de esta versión). */
  private async reconcileOutbox(now: number): Promise<number> {
    const missing = await this.deps.batches.notEnqueued(100);
    for (const b of missing) {
      await this.deps.tx(async ({ outbox }) => {
        await outbox.enqueue(b.event, now);
      });
      this.deps.log?.warn({ seq: b.seq }, 'lote sin entrada en la outbox: encolado');
    }
    return missing.length;
  }

  /** Pide los anclajes de un lote. Los fallos se registran y se reintentan en `anchorPending`. */
  private async anchor(record: BatchRecord): Promise<void> {
    const digest = hexToBytes(record.eventId);
    if (this.deps.tsa && !record.tsaToken) {
      try {
        const { tokenDer, genTime } = await this.deps.tsa.request(digest);
        const at = Math.floor(genTime.getTime() / 1000);
        await this.deps.batches.setTsa(record.seq, tokenDer, at);
        this.deps.log?.info({ seq: record.seq, genTime: at }, 'lote sellado (RFC 3161)');
      } catch (err) {
        this.deps.log?.warn(
          { seq: record.seq, err: String(err) },
          'sello RFC 3161 fallido; se reintentará',
        );
      }
    }
    if (this.deps.ots && !record.ots) {
      try {
        const ots = await this.deps.ots.submit(digest);
        await this.deps.batches.setOts(record.seq, ots, false);
        this.deps.log?.info(
          { seq: record.seq },
          'lote enviado a OpenTimestamps (Bitcoin pendiente)',
        );
      } catch (err) {
        this.deps.log?.warn(
          { seq: record.seq, err: String(err) },
          'envío a OpenTimestamps fallido; se reintentará',
        );
      }
    }
  }

  /**
   * Reintenta los anclajes que faltan (sello RFC 3161 y OTS, cada uno por su lado) y actualiza
   * los .ots pendientes. Devuelve cuántos cambiaron.
   */
  async anchorPending(
    limit = 50,
  ): Promise<{ tsa: number; otsSubmitted: number; otsCompleted: number }> {
    const out = { tsa: 0, otsSubmitted: 0, otsCompleted: 0 };
    for (const b of await this.deps.batches.pendingAnchors(limit)) {
      const digest = hexToBytes(b.eventId);
      if (this.deps.tsa && !b.tsaToken) {
        try {
          const { tokenDer, genTime } = await this.deps.tsa.request(digest);
          const at = Math.floor(genTime.getTime() / 1000);
          await this.deps.batches.setTsa(b.seq, tokenDer, at);
          this.deps.log?.info({ seq: b.seq, genTime: at }, 'lote sellado (RFC 3161)');
          out.tsa++;
        } catch (err) {
          this.deps.log?.warn({ seq: b.seq, err: String(err) }, 'sello RFC 3161 fallido');
        }
      }
      if (!this.deps.ots || b.otsComplete) continue;
      try {
        if (!b.ots) {
          await this.deps.batches.setOts(b.seq, await this.deps.ots.submit(digest), false);
          this.deps.log?.info({ seq: b.seq }, 'lote enviado a OpenTimestamps (Bitcoin pendiente)');
          out.otsSubmitted++;
        } else {
          const { ots, complete } = await this.deps.ots.upgrade(b.ots);
          if (complete) {
            await this.deps.batches.setOts(b.seq, ots, true);
            this.deps.log?.info(
              { seq: b.seq },
              'lote anclado en Bitcoin (OpenTimestamps completo)',
            );
            out.otsCompleted++;
          }
        }
      } catch (err) {
        this.deps.log?.warn({ seq: b.seq, err: String(err) }, 'OpenTimestamps fallido');
      }
    }
    return out;
  }

  /** Prueba de inclusión de un recibo en su lote, recalculada desde los recibos de la ventana. */
  async proofFor(receiptSeq: number): Promise<{ batch: BatchRecord; proof: ReceiptProof } | null> {
    const batch = await this.deps.batches.containingReceipt(receiptSeq);
    if (!batch) return null;
    const receipts = await this.deps.evidence.receipts.inWindow(batch.windowStart, batch.windowEnd);
    return { batch, proof: proveReceipt(batch.seq, receipts, receiptSeq) };
  }
}
