/**
 * Exportación de evidencia por rango de fechas: lo que se entrega cuando un auditor o un
 * regulador pide "las verificaciones del 1 al 30 de septiembre".
 *
 * Dos decisiones de diseño que se ven aquí:
 *
 *  1. **La unidad es la ventana, no el recibo.** El rango pedido se expande a ventanas completas.
 *     Entregar media ventana obligaría a entregar menos recibos de los que dice su compromiso de
 *     recuento, y eso es indistinguible de haber borrado recibos. Se expande y se dice.
 *
 *  2. **La sal del recuento es por lote.** Revelar el recuento de las horas del rango no revela
 *     el de ninguna otra hora. Con una sal global, responder por un día habría revelado el
 *     volumen de todo el histórico.
 *
 * El paquete es autocontenido: quien lo recibe puede recalcular hashes, cadena, raíces y pruebas
 * de inclusión sin acceso a la base de datos del operador, y comprobar los sellos y las anclas.
 * El contenedor ASiC-E con Evidence Record RFC 4998 queda fuera de este export en JSON.
 *
 * Regla del verificador: **no se cree nada que haya escrito el operador**.
 * Los huecos, la continuidad de lotes, el `genTime` del sello y el estado del `.ots` se recalculan
 * desde los recibos, los eventos firmados, el token DER y el fichero .ots. Lo que el paquete
 * declara (`gaps`, `batchChainOk`, `tsaGenTime`, `otsComplete`, `agentPubkey`) se contrasta con
 * lo recalculado y cualquier discrepancia es un problema. Lo que no se puede recalcular sin
 * salir del paquete (que la clave firmante sea la del operador, que un sello lo firme una TSA
 * real, que la atestación Bitcoin esté en un bloque) se dice en `notes`, no se da por bueno.
 */

import {
  checkAnchorWindow,
  proveReceipt,
  type ReceiptProof,
  verifyReceiptProof,
  windowOf,
} from '../domain/evidence/batch.ts';
import { commitCount, parseBatchEvent } from '../domain/evidence/batch-event.ts';
import type { BatchRecord, BatchStore } from '../domain/evidence/batch-store.ts';
import type { EvidenceStore } from '../domain/evidence/evidence-store.ts';
import { EMPTY_ROOT, merkleRoot } from '../domain/evidence/merkle.ts';
import { type Receipt, receiptHash, receiptSchema } from '../domain/evidence/receipt.ts';
import { type NostrEvent, verifyEvent } from '../domain/nostr/event.ts';
import { deserializeDetached, isComplete } from '../infra/ots/ots.ts';
import { parseToken } from '../infra/tsa/rfc3161.ts';
import { bytesToHex, hexToBytes, isHex64 } from '../shared/hex.ts';

export interface ExportedBatch {
  seq: number;
  root: string;
  prevRoot: string;
  window: [number, number];
  policy: string;
  /** Recuento revelado, y la sal con la que se comprueba el compromiso publicado. */
  count: number;
  countSalt: string;
  eventId: string;
  /** El evento firmado tal cual se publicó en los relays: el auditor verifica id y firma. */
  event: NostrEvent;
  /** Sello RFC 3161 en hex (DER) y su genTime declarado, o null si el lote aún no está sellado. */
  tsaTokenDer: string | null;
  tsaGenTime: number | null;
  /** Fichero .ots en hex, y si el operador declara que ya tiene atestación Bitcoin. */
  ots: string | null;
  otsComplete: boolean;
  receipts: Receipt[];
  proofs: ReceiptProof[];
}

export interface ExportGap {
  /** Ventana que debería existir y no está en la base de datos. */
  window: [number, number];
}

export interface EvidencePackage {
  format: 'precintum/export/v1';
  /** Rango pedido y rango realmente entregado (expandido a ventanas completas). */
  requested: [number, number];
  covered: [number, number];
  windowSeconds: number;
  /**
   * Gap máximo admisible entre el fin de una ventana y su sello (regla de ventana de anclaje) con
   * el que operaba el agente. El verificador lo usa salvo que el auditor imponga otro.
   */
  anchorMaxGapSeconds: number;
  /**
   * Clave pública del agente según el operador. Es una declaración: el auditor debe contrastarla
   * con la que conozca por un canal fiable (contrato, registro) y con los relays.
   */
  agentPubkey: string | null;
  /**
   * Hash del recibo anterior al primero entregado, tal y como lo declara ese primero en `prev`.
   * El auditor no puede recalcularlo (ese recibo queda fuera del rango), pero no le hace falta:
   * viaja dentro de un recibo cuya inclusión en una raíz publicada, sellada y anclada sí prueba.
   */
  precedingReceiptHash: string | null;
  /**
   * Periodo en el que el registro existe: ventana del primer lote cerrado y fin del último.
   * Sin esto, pedir un rango anterior al arranque del servicio parecería un registro incompleto,
   * cuando lo cierto es que no había registro. Null si nunca se ha cerrado un lote.
   */
  serviceStart: number | null;
  serviceEnd: number | null;
  batches: ExportedBatch[];
  /**
   * Ventanas del rango que deberían tener lote y no lo tienen. Solo cuentan las que caen dentro
   * del periodo de servicio: cada una es un fallo de completitud que hay que explicar.
   */
  gaps: ExportGap[];
  totals: {
    batches: number;
    receipts: number;
    empty: number;
    withoutTsa: number;
    withoutOts: number;
    /** Ventanas del rango anteriores al arranque del servicio: no son huecos. */
    windowsBeforeService: number;
    /** Ventanas del rango que aún no se han cerrado (la hora en curso, o `batch close` pendiente). */
    windowsNotClosed: number;
  };
  /** Continuidad de la cadena de lotes dentro del rango (seq consecutivo y prevRoot encadenado). */
  batchChainOk: boolean;
  /** Lo que este paquete NO contiene, dicho explícitamente para quien lo recibe. */
  notice: string;
}

const NOTICE =
  'Este paquete no contiene identificadores de persona, dispositivo, sesión ni transacción. ' +
  'Otros registros pueden permitir correlacionar hora y resultado. Permite comprobar la integridad ' +
  'y coherencia de la evidencia entregada; no acredita por sí solo que los hechos registrados ' +
  'ocurrieran ni que se registraran todos. La firma CMS del sello y su cadena hasta la lista de ' +
  'confianza de la UE se validan con DSS; contrastar el anclaje Bitcoin requiere un nodo o un ' +
  'explorador. Esas validaciones son externas a esta herramienta.';

/** Gap máximo por defecto si el paquete no lo trae (mismo que la configuración por defecto). */
export const DEFAULT_ANCHOR_MAX_GAP_SECONDS = 86_400;
/** Un sello unos segundos anterior al cierre es desfase de reloj, no manipulación: se avisa. */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

export interface ExportServiceDeps {
  evidence: EvidenceStore;
  batches: BatchStore;
  windowSeconds: number;
  anchorMaxGapSeconds?: number | undefined;
  /** Pubkey hex del agente, si el proceso la conoce; viaja en el paquete como declaración. */
  agentPubkey?: string | undefined;
}

export class ExportService {
  private readonly deps: ExportServiceDeps;

  constructor(deps: ExportServiceDeps) {
    this.deps = deps;
  }

  /** Expande [from, to] a ventanas completas: el rango entregado nunca corta una ventana. */
  alignRange(from: number, to: number): [number, number] {
    if (!isInstant(from) || !isInstant(to)) {
      throw new Error('el rango debe usar fechas válidas en segundos enteros');
    }
    if (!(to > from)) throw new Error('el rango debe terminar después de empezar');
    const size = this.deps.windowSeconds;
    if (!isInt(size) || size < 60) throw new Error('tamaño de ventana inválido');
    const range: [number, number] = [windowOf(from, size).start, windowOf(to - 1, size).end];
    if (!isRange(range)) throw new Error('el rango alineado queda fuera de las fechas válidas');
    return range;
  }

  async exportRange(from: number, to: number): Promise<EvidencePackage> {
    const size = this.deps.windowSeconds;
    const [start, end] = this.alignRange(from, to);
    // Fija el límite antes de leer las filas: un cierre concurrente no debe convertir una
    // ventana que aún no se había leído en un hueco aparente ni ampliar este mismo paquete.
    const headBatch = await this.deps.batches.head();
    const firstBatch = headBatch ? await this.deps.batches.get(1) : null;
    const serviceStart = firstBatch?.windowStart ?? null;
    const serviceEnd = headBatch?.windowEnd ?? null;
    const records =
      serviceEnd !== null && serviceEnd > start
        ? await this.deps.batches.inTimeRange(start, Math.min(end, serviceEnd))
        : [];

    const batches: ExportedBatch[] = [];
    let receiptTotal = 0;
    for (const b of records) {
      const receipts = await this.deps.evidence.receipts.inWindow(b.windowStart, b.windowEnd);
      batches.push({
        seq: b.seq,
        root: b.root,
        prevRoot: b.prevRoot,
        window: [b.windowStart, b.windowEnd],
        policy: b.policy,
        count: b.count,
        countSalt: b.countSalt,
        eventId: b.eventId,
        event: b.event,
        tsaTokenDer: b.tsaToken ? bytesToHex(b.tsaToken) : null,
        tsaGenTime: b.tsaGenTime,
        ots: b.ots ? bytesToHex(b.ots) : null,
        otsComplete: b.otsComplete,
        receipts,
        proofs: receipts.map((r) => proveReceipt(b.seq, receipts, r.seq)),
      });
      receiptTotal += receipts.length;
    }

    // Dentro del periodo de servicio, toda ventana debe tener lote, incluidas las vacías
    // (latidos): su ausencia es un fallo de completitud. Fuera del periodo no hay nada que
    // reprochar, y se cuenta aparte para que el auditor no lo confunda con un borrado.
    const present = new Set(records.map((b) => b.windowStart));
    const gaps: ExportGap[] = [];
    let windowsBeforeService = 0;
    let windowsNotClosed = 0;
    for (let w = start; w + size <= end; w += size) {
      if (present.has(w)) continue;
      if (serviceStart === null || w < serviceStart) windowsBeforeService++;
      else if (serviceEnd === null || w >= serviceEnd) windowsNotClosed++;
      else gaps.push({ window: [w, w + size] });
    }

    const firstReceipt = batches.find((b) => b.receipts.length > 0)?.receipts[0];
    return {
      format: 'precintum/export/v1',
      requested: [from, to],
      covered: [start, end],
      windowSeconds: size,
      anchorMaxGapSeconds: this.deps.anchorMaxGapSeconds ?? DEFAULT_ANCHOR_MAX_GAP_SECONDS,
      agentPubkey: this.deps.agentPubkey ?? records[0]?.event.pubkey ?? null,
      precedingReceiptHash: firstReceipt ? firstReceipt.prev : null,
      serviceStart,
      serviceEnd,
      batches,
      gaps,
      totals: {
        batches: batches.length,
        receipts: receiptTotal,
        empty: batches.filter((b) => b.count === 0).length,
        withoutTsa: batches.filter((b) => b.tsaTokenDer === null).length,
        withoutOts: batches.filter((b) => !b.otsComplete).length,
        windowsBeforeService,
        windowsNotClosed,
      },
      batchChainOk: batchChainOk(records),
      notice: NOTICE,
    };
  }
}

/** Continuidad de los lotes entregados: seq consecutivo y prevRoot = raíz del anterior. */
export function batchChainOk(records: readonly BatchRecord[]): boolean {
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1] as BatchRecord;
    const cur = records[i] as BatchRecord;
    if (cur.seq !== prev.seq + 1 || cur.prevRoot !== prev.root) return false;
  }
  return true;
}

export interface RangeVerdict {
  ok: boolean;
  /** Alteraciones o incoherencias: cualquiera invalida el paquete. */
  problems: string[];
  /** Evidencia incompleta (sin sello, ancla pendiente): no es alteración, pero hay que saberlo. */
  warnings: string[];
  /** Lo que el paquete no permite comprobar por sí solo y el auditor debe contrastar fuera. */
  notes: string[];
}

export interface VerifyOptions {
  /** Pubkey hex del operador conocida por un canal fiable. Sin ella, la firma solo prueba coherencia. */
  expectedPubkey?: string | undefined;
  /** Sustituye al gap máximo que declara el paquete. */
  anchorMaxGapSeconds?: number | undefined;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isInstant = (v: unknown): v is number =>
  isInt(v) && Number.isFinite(new Date(v * 1000).getTime());
const isRange = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && isInstant(v[0]) && isInstant(v[1]) && v[1] > v[0];

/**
 * Las comprobaciones que un auditor hace sobre el paquete, recalculadas desde cero. Vive aquí
 * para que `precintum export` pueda decir si lo que entrega se verifica; el verificador web hace
 * las mismas en el navegador y un test cruza los dos motores en cada ejecución.
 */
export function verifyPackage(pkg: EvidencePackage, opts: VerifyOptions = {}): RangeVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    pkg.format !== 'precintum/export/v1' ||
    !Array.isArray(pkg.batches)
  ) {
    return { ok: false, problems: ['paquete de evidencia inválido'], warnings, notes };
  }
  const size = pkg.windowSeconds;
  const maxGap =
    opts.anchorMaxGapSeconds ??
    (isInt(pkg.anchorMaxGapSeconds) ? pkg.anchorMaxGapSeconds : DEFAULT_ANCHOR_MAX_GAP_SECONDS);

  // --- tipos: nada de lo que se opera puede ser texto disfrazado de número ---
  if (!isInt(size) || size < 60) problems.push('windowSeconds no es un entero válido');
  if (!isRange(pkg.requested)) problems.push('el rango solicitado no es válido');
  if (!isRange(pkg.covered)) problems.push('el rango entregado no es válido');
  for (const b of pkg.batches) {
    const okTypes =
      b !== null &&
      typeof b === 'object' &&
      isInt(b.seq) &&
      isInt(b.count) &&
      isRange(b.window) &&
      (b.tsaGenTime === null || isInt(b.tsaGenTime)) &&
      isHex64(b.root) &&
      isHex64(b.prevRoot) &&
      isHex64(b.eventId) &&
      Array.isArray(b.receipts) &&
      Array.isArray(b.proofs);
    if (!okTypes) problems.push(`lote ${String(b?.seq)}: campos con tipos inválidos`);
  }
  if (problems.length) return { ok: false, problems, warnings, notes };

  if (pkg.covered[0] > pkg.requested[0] || pkg.covered[1] < pkg.requested[1]) {
    problems.push('el rango entregado no cubre el solicitado');
  }
  if (pkg.covered[0] % size !== 0 || pkg.covered[1] % size !== 0) {
    problems.push('el rango entregado no está alineado a ventanas completas');
  }

  // --- continuidad y huecos, recalculados; lo declarado se contrasta ---
  let interiorGaps = 0;
  let chainContinuous = true;
  for (let i = 0; i < pkg.batches.length; i++) {
    const cur = pkg.batches[i] as ExportedBatch;
    if (cur.window[0] < pkg.covered[0] || cur.window[1] > pkg.covered[1]) {
      problems.push(`lote ${cur.seq}: su ventana queda fuera del rango entregado`);
    }
    if (cur.window[1] - cur.window[0] !== size) {
      problems.push(`lote ${cur.seq}: su ventana no mide ${size} s`);
    }
    if (i === 0) continue;
    const prev = pkg.batches[i - 1] as ExportedBatch;
    if (cur.seq !== prev.seq + 1 || cur.prevRoot !== prev.root) chainContinuous = false;
    if (cur.window[0] > prev.window[1]) {
      interiorGaps += Math.round((cur.window[0] - prev.window[1]) / size);
    } else if (cur.window[0] < prev.window[1]) {
      problems.push(`lote ${cur.seq}: su ventana se solapa con la del lote ${prev.seq}`);
    }
  }
  const declaredGaps = Array.isArray(pkg.gaps) ? pkg.gaps.length : 0;
  const totalGaps = Math.max(interiorGaps, declaredGaps);
  if (totalGaps > 0) {
    problems.push(
      `faltan ${totalGaps} ventanas del rango (sin lote, ni siquiera vacío): completitud rota`,
    );
  }
  if (declaredGaps < interiorGaps) {
    problems.push(
      `el paquete declara ${declaredGaps} huecos y se recalculan ${interiorGaps} entre los lotes entregados`,
    );
  }
  if (!chainContinuous) {
    problems.push('la cadena de lotes del rango no es continua (seq o prevRoot)');
    if (pkg.batchChainOk)
      problems.push('el paquete declara la cadena de lotes continua y no lo es');
  }
  // Ventanas del rango sin lote en los bordes: el paquete dice si son anteriores al servicio o
  // están sin cerrar. Eso no se puede recalcular sin salir del paquete.
  const first = pkg.batches[0];
  const last = pkg.batches.at(-1);
  const edgeWindows =
    pkg.batches.length === 0
      ? Math.round((pkg.covered[1] - pkg.covered[0]) / size)
      : Math.round(((first as ExportedBatch).window[0] - pkg.covered[0]) / size) +
        Math.round((pkg.covered[1] - (last as ExportedBatch).window[1]) / size);
  if (edgeWindows > 0) {
    notes.push(
      `${edgeWindows} ventanas del rango, en sus bordes, no tienen lote: el paquete las declara anteriores al servicio o aún sin cerrar (${pkg.totals.windowsBeforeService} y ${pkg.totals.windowsNotClosed}); contrastar con los relays`,
    );
  }

  // --- quién firma ---
  const pubkeys = new Set(pkg.batches.map((b) => b.event?.pubkey).filter(Boolean));
  if (pubkeys.size > 1) {
    problems.push(
      `los lotes están firmados por ${pubkeys.size} claves distintas; sin directorio de claves, un solo agente firma con una`,
    );
  }
  const signer = pubkeys.size === 1 ? ([...pubkeys][0] as string) : null;
  if (opts.expectedPubkey) {
    if (signer && signer !== opts.expectedPubkey) {
      problems.push('la clave que firma los lotes no es la del operador indicada por el auditor');
    }
  } else if (signer) {
    notes.push(
      'la clave firmante no se ha contrastado con ninguna fuente externa: la firma prueba coherencia interna, no quién firmó',
    );
  }
  if (signer && pkg.agentPubkey && pkg.agentPubkey !== signer) {
    problems.push('la clave que declara el paquete no es la que firma los lotes');
  }

  // --- por lote ---
  let expectedPrev = pkg.precedingReceiptHash;
  let lastSeq: number | null = null;
  for (const b of pkg.batches) {
    // El evento firmado es la pieza que estuvo en los relays: id y firma deben cuadrar, y sus
    // etiquetas deben coincidir con lo que se entrega aquí.
    const sig = verifyEvent(b.event);
    if (!sig.ok) problems.push(`lote ${b.seq}: el evento firmado no valida (${sig.reason})`);
    if (b.event.id !== b.eventId) {
      problems.push(`lote ${b.seq}: el id de evento declarado no es el del evento entregado`);
    }
    const parsed = parseBatchEvent(b.event);
    if (!parsed.ok)
      problems.push(`lote ${b.seq}: el evento no es un lote válido (${parsed.reason})`);
    else {
      const d = parsed.data;
      if (d.root !== b.root) problems.push(`lote ${b.seq}: la raíz del evento no es la entregada`);
      if (d.seq !== b.seq) problems.push(`lote ${b.seq}: el seq del evento no es el entregado`);
      if (d.prevRoot !== b.prevRoot)
        problems.push(`lote ${b.seq}: el prevRoot del evento no es el entregado`);
      if (d.policy !== b.policy)
        problems.push(`lote ${b.seq}: la política del evento no es la entregada`);
      if (d.windowStart !== b.window[0] || d.windowEnd !== b.window[1]) {
        problems.push(`lote ${b.seq}: la ventana del evento no es la entregada`);
      }
      // Aquí se abre el compromiso del recuento: es lo que la sal permite comprobar.
      if (!isHex64(b.countSalt) || d.countCommitment !== commitCount(b.count, b.countSalt)) {
        problems.push(
          `lote ${b.seq}: el compromiso de recuento publicado no se abre a ${b.count} con la sal entregada`,
        );
      }
    }

    // Recuento: el compromiso publicado debe abrirse al número de recibos realmente entregados.
    if (b.receipts.length !== b.count) {
      problems.push(
        `lote ${b.seq}: se entregan ${b.receipts.length} recibos y el compromiso dice ${b.count}`,
      );
    }

    // Esquema estricto de cada recibo: un recibo malformado no entra en ningún hash.
    const wellFormed: Receipt[] = [];
    for (const r of b.receipts) {
      const check = receiptSchema.safeParse(r);
      if (check.success) wellFormed.push(check.data);
      else problems.push(`recibo ${String((r as { seq?: unknown })?.seq)}: no cumple el esquema`);
    }

    // Raíz Merkle recalculada desde los recibos entregados.
    const leaves = wellFormed.map(receiptHash);
    const recomputed = leaves.length ? merkleRoot(leaves) : EMPTY_ROOT;
    if (wellFormed.length !== b.receipts.length || recomputed !== b.root) {
      // Con la raíz ya distinta, las pruebas de inclusión no añaden nada: se recalculan sobre
      // las mismas hojas alteradas y fallarían todas. Quién cambió lo dice la cadena de recibos.
      problems.push(
        `lote ${b.seq}: la raíz recalculada no coincide con la publicada; algún recibo de la ventana se cambió, se borró o se añadió`,
      );
    } else {
      // La raíz cuadra: aquí sí tiene sentido comprobar cada prueba (detecta una prueba mal
      // construida o forjada para un recibo que no estaba).
      for (const p of b.proofs) {
        if (p.proof.size !== b.count) {
          problems.push(
            `lote ${b.seq}: la prueba de inclusión del recibo ${p.receiptSeq} declara un árbol de ${p.proof.size} hojas y el lote tiene ${b.count}`,
          );
        } else if (!verifyReceiptProof(p, b.root)) {
          problems.push(
            `lote ${b.seq}: la prueba de inclusión del recibo ${p.receiptSeq} no verifica`,
          );
        }
      }
    }

    for (const r of wellFormed) {
      if (r.ts < b.window[0] || r.ts >= b.window[1]) {
        problems.push(`recibo ${r.seq}: su ts está fuera de la ventana del lote ${b.seq}`);
      }
      if (lastSeq !== null && r.seq !== lastSeq + 1) {
        problems.push(`salto en la cadena de recibos: del ${lastSeq} al ${r.seq}`);
      }
      if (expectedPrev !== null && r.prev !== expectedPrev) {
        problems.push(`recibo ${r.seq}: su prev no es el hash del recibo anterior`);
      }
      expectedPrev = receiptHash(r);
      lastSeq = r.seq;
    }

    // Sello RFC 3161: se lee del token, no del JSON. Imprint = id del evento; genTime dentro de la
    // ventana de anclaje. La firma CMS y la cadena de la TSA quedan para DSS (nota).
    if (b.tsaTokenDer === null) warnings.push(`lote ${b.seq}: sin sello RFC 3161`);
    else {
      let genTime: number | null = null;
      try {
        const info = parseToken(hexToBytes(b.tsaTokenDer), { digest: hexToBytes(b.eventId) });
        genTime = Math.floor(info.genTime.getTime() / 1000);
      } catch (err) {
        problems.push(
          `lote ${b.seq}: el token RFC 3161 no se puede leer o su imprint no es el id del evento (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (genTime !== null) {
        if (b.tsaGenTime !== null && b.tsaGenTime !== genTime) {
          problems.push(
            `lote ${b.seq}: el genTime declarado (${b.tsaGenTime}) no es el del token (${genTime})`,
          );
        }
        const anchor = checkAnchorWindow(b.window[1], genTime, maxGap);
        if (anchor.gapSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) {
          problems.push(
            `lote ${b.seq}: el sello es anterior al cierre de la ventana (imposible: ${-anchor.gapSeconds} s antes)`,
          );
        } else if (anchor.gapSeconds < 0) {
          warnings.push(
            `lote ${b.seq}: el sello es ${-anchor.gapSeconds} s anterior al cierre; desfase de reloj tolerado`,
          );
        } else if (!anchor.ok) {
          problems.push(
            `lote ${b.seq}: el sello llega ${anchor.gapSeconds} s después del cierre, por encima del máximo de ${maxGap} s: posible antedatado`,
          );
        }
      }
    }

    // OpenTimestamps: el fichero se lee; "completo" significa que hay una atestación Bitcoin en
    // el fichero, no que se haya seguido hasta la cabecera del bloque (nota).
    if (b.ots === null) warnings.push(`lote ${b.seq}: anclaje en Bitcoin sin enviar`);
    else {
      try {
        const ts = deserializeDetached(hexToBytes(b.ots));
        if (bytesToHex(ts.msg) !== b.eventId) {
          problems.push(`lote ${b.seq}: el fichero .ots no es del id de este evento`);
        }
        const complete = isComplete(ts);
        if (b.otsComplete && !complete) {
          problems.push(
            `lote ${b.seq}: el paquete declara el anclaje en Bitcoin completo y el .ots no tiene atestación Bitcoin`,
          );
        } else if (!complete) {
          warnings.push(`lote ${b.seq}: anclaje en Bitcoin pendiente en el calendario`);
        } else if (!b.otsComplete) {
          warnings.push(
            `lote ${b.seq}: anclaje en Bitcoin declarado pendiente aunque el .ots ya trae atestación Bitcoin`,
          );
        }
      } catch (err) {
        problems.push(
          `lote ${b.seq}: el fichero .ots no se puede leer (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }
  if (pkg.batches.some((b) => b.tsaTokenDer !== null)) {
    notes.push(
      'los sellos RFC 3161 se han leído y cuadran con los eventos y con la ventana de anclaje; su firma CMS y la cadena de la TSA se validan con DSS',
    );
  }
  if (pkg.batches.some((b) => b.otsComplete)) {
    notes.push(
      'las atestaciones Bitcoin están en los ficheros .ots; seguirlas hasta la cabecera del bloque exige un nodo',
    );
  }
  return { ok: problems.length === 0, problems, warnings, notes };
}
