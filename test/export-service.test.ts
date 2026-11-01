import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import { ExportService, verifyPackage } from '../src/application/export-service.ts';
import { parseInstant } from '../src/cli/export-commands.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import type { Receipt } from '../src/domain/evidence/receipt.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { hexToBytes } from '../src/shared/hex.ts';
import { fakeOts, fakeToken, fakeTsa } from './support/fake-anchors.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const W = 600; // ventana de 10 minutos
const T0 = 1_700_000_400; // múltiplo de 600

describe('ExportService: paquete de evidencia por rango de fechas', () => {
  let db: PgliteSqlClient;
  let evidence: SqlEvidenceStore;
  let batches: SqlBatchStore;
  const agent = newIdentity();

  // genTime dentro de la ventana de anclaje: justo después del cierre de la última ventana.
  const tsa = fakeTsa({ genTime: () => new Date((T0 + 4 * W + 30) * 1000) });
  const ots = fakeOts({ completeOnUpgrade: () => true });

  beforeAll(async () => {
    db = await PgliteSqlClient.open();
    await migrate(db);
    evidence = new SqlEvidenceStore(db);
    batches = new SqlBatchStore(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM batches');
    await db.query('DELETE FROM ingest_dedup');
    await db.query('DELETE FROM receipts');
  });

  async function seed(times: number[]): Promise<Receipt[]> {
    const out: Receipt[] = [];
    let prev: Receipt | null = null;
    for (const at of times) {
      prev = nextReceipt(prev, { policy: H, verifier: H, result: 'over_18', at });
      await evidence.receipts.append(prev);
      out.push(prev);
    }
    return out;
  }

  /** Tres ventanas: dos recibos en la 0, ninguno en la 1 (latido), uno en la 2. */
  async function scenario(): Promise<void> {
    await seed([T0 + 60, T0 + 120, T0 + 2 * W + 60]);
    const now = T0 + 3 * W + 10;
    const service = new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      identity: agent,
      policy: H,
      windowSeconds: W,
      tsa,
      ots,
      now: () => now,
    });
    await service.closeDueWindows(now);
    await service.anchorPending();
  }

  const exporter = () => new ExportService({ evidence, batches, windowSeconds: W });

  it('expande el rango pedido a ventanas completas: nunca entrega media ventana', () => {
    const e = exporter();
    // Se pide de la mitad de la ventana 0 a la mitad de la 2: se entregan las tres completas.
    expect(e.alignRange(T0 + 300, T0 + 2 * W + 300)).toEqual([T0, T0 + 3 * W]);
    // Un rango ya alineado no se estira: [T0, T0+W) son exactamente las ventana 0.
    expect(e.alignRange(T0, T0 + W)).toEqual([T0, T0 + W]);
    expect(() => e.alignRange(T0 + W, T0)).toThrow(/termine|termina|después/);
  });

  it('entrega lotes, recibos, pruebas, sal del recuento y anclas, y se verifica', async () => {
    await scenario();
    const pkg = await exporter().exportRange(T0, T0 + 3 * W);

    expect(pkg.format).toBe('precintum/export/v1');
    expect(pkg.covered).toEqual([T0, T0 + 3 * W]);
    expect(pkg.totals).toEqual({
      batches: 3,
      receipts: 3,
      empty: 1,
      withoutTsa: 0,
      withoutOts: 0,
      windowsBeforeService: 0,
      windowsNotClosed: 0,
    });
    expect(pkg.gaps).toEqual([]);
    expect([pkg.serviceStart, pkg.serviceEnd]).toEqual([T0, T0 + 3 * W]);
    expect(pkg.batchChainOk).toBe(true);
    // La sal viaja en el paquete (y solo ahí): es lo que permite abrir el compromiso.
    expect(pkg.batches.map((b) => b.countSalt)).toSatisfy((salts: string[]) =>
      salts.every((s) => /^[0-9a-f]{64}$/.test(s)),
    );
    // Y es distinta por lote: revelar el recuento de una hora no revela el de las demás.
    expect(new Set(pkg.batches.map((b) => b.countSalt)).size).toBe(3);
    expect(pkg.batches[0]?.proofs).toHaveLength(2);
    expect(pkg.precedingReceiptHash).toBe(pkg.batches[0]?.receipts[0]?.prev);

    const v = verifyPackage(pkg);
    expect(v.problems).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('un rango parcial solo entrega sus ventanas, y sigue verificándose', async () => {
    await scenario();
    const pkg = await exporter().exportRange(T0 + 2 * W, T0 + 3 * W);
    expect(pkg.totals.batches).toBe(1);
    expect(pkg.totals.receipts).toBe(1);
    expect(pkg.batches[0]?.seq).toBe(3);
    // El primer recibo del rango declara el hash de uno que no se entrega: se anota aparte.
    expect(pkg.precedingReceiptHash).toBe(pkg.batches[0]?.receipts[0]?.prev);
    expect(verifyPackage(pkg).ok).toBe(true);
  });

  it('no incluye datos personales y lo dice: los recibos solo llevan los 8 campos del esquema', async () => {
    await scenario();
    const pkg = await exporter().exportRange(T0, T0 + 3 * W);
    for (const b of pkg.batches) {
      for (const r of b.receipts) {
        expect(Object.keys(r).sort()).toEqual([
          'nonce',
          'policy',
          'prev',
          'result',
          'seq',
          'ts',
          'v',
          'verifier',
        ]);
      }
    }
    expect(pkg.notice).toMatch(/no contiene identificadores de persona/);
  });

  it('delata un recibo borrado después de publicar el lote', async () => {
    await scenario();
    await db.query('DELETE FROM receipts WHERE seq = 2');
    const pkg = await exporter().exportRange(T0, T0 + 3 * W);
    const v = verifyPackage(pkg);
    expect(v.ok).toBe(false);
    // Tres pistas independientes: recuento comprometido, raíz publicada y cadena de recibos.
    expect(v.problems.join(' | ')).toMatch(/compromiso dice 2/);
    expect(v.problems.join(' | ')).toMatch(/raíz recalculada/);
    expect(v.problems.join(' | ')).toMatch(/prev no es el hash/);
  });

  it('delata un recibo editado tras el cierre', async () => {
    await scenario();
    await db.query("UPDATE receipts SET result = 'under_18' WHERE seq = 1");
    const v = verifyPackage(await exporter().exportRange(T0, T0 + W));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' | ')).toMatch(/raíz recalculada/);
    // Con la raíz ya distinta no se acusa a cada recibo por su prueba de inclusión: sería ruido,
    // porque todas se recalculan sobre las mismas hojas alteradas.
    expect(v.problems.join(' | ')).not.toMatch(/prueba de inclusión/);
    // Quién cambió lo señala la cadena: el recibo siguiente al editado.
    expect(v.problems.join(' | ')).toMatch(/recibo 2: su prev no es el hash/);
  });

  it('marca como hueco una ventana sin lote, aunque estuviera vacía', async () => {
    await scenario();
    await db.query('DELETE FROM batches WHERE seq = 2'); // el latido de la ventana vacía
    const pkg = await exporter().exportRange(T0, T0 + 3 * W);
    expect(pkg.gaps).toEqual([{ window: [T0 + W, T0 + 2 * W] }]);
    const v = verifyPackage(pkg);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' | ')).toMatch(/faltan 1 ventanas/);
    expect(v.problems.join(' | ')).toMatch(/cadena de lotes/); // seq 1 → 3
  });

  it('avisa (sin fallar) de lotes sin sellar o sin ancla completa', async () => {
    await scenario();
    await db.query('UPDATE batches SET tsa_token = NULL, tsa_gen_time = NULL WHERE seq = 1');
    await db.query('UPDATE batches SET ots_complete = false WHERE seq = 3');
    const pkg = await exporter().exportRange(T0, T0 + 3 * W);
    expect(pkg.totals.withoutTsa).toBe(1);
    const v = verifyPackage(pkg);
    expect(v.ok).toBe(true); // no es una alteración: es evidencia incompleta, y se avisa
    expect(v.warnings.join(' | ')).toMatch(/sin sello RFC 3161/);
    expect(v.warnings.join(' | ')).toMatch(/anclaje en Bitcoin/);
  });

  it('rechaza un sello anterior al cierre de su ventana (imposible)', async () => {
    await scenario();
    // El token de verdad, con una hora anterior al cierre: el verificador la lee del DER.
    const b1 = await batches.get(1);
    await batches.setTsa(
      1,
      fakeToken(hexToBytes(b1?.eventId ?? ''), new Date((T0 + 10) * 1000)),
      T0 + 10,
    );
    const v = verifyPackage(await exporter().exportRange(T0, T0 + W));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' | ')).toMatch(/anterior al cierre/);
  });

  it('un rango sin lotes no es un error: es un paquete vacío, y no son huecos', async () => {
    await scenario();
    const pkg = await exporter().exportRange(T0 + 10 * W, T0 + 12 * W);
    expect(pkg.totals.batches).toBe(0);
    expect(pkg.precedingReceiptHash).toBeNull();
    // Posterior al último lote cerrado: son ventanas por cerrar, no evidencia que falte.
    expect(pkg.gaps).toEqual([]);
    expect(pkg.totals.windowsNotClosed).toBe(2);
    expect(verifyPackage(pkg).ok).toBe(true);
  });

  it('un rango anterior al arranque del servicio no se acusa de incompleto', async () => {
    await scenario();
    const pkg = await exporter().exportRange(T0 - 5 * W, T0 - 2 * W);
    expect(pkg.serviceStart).toBe(T0);
    expect(pkg.gaps).toEqual([]);
    expect(pkg.totals.windowsBeforeService).toBe(3);
    // Nada que reprochar: no había registro. Es distinto de haberlo borrado.
    expect(verifyPackage(pkg).ok).toBe(true);
  });

  it('sí acusa el hueco cuando la ventana cae dentro del periodo con registro', async () => {
    await scenario();
    await db.query('DELETE FROM batches WHERE seq = 2');
    const pkg = await exporter().exportRange(T0 - W, T0 + 4 * W);
    expect(pkg.totals.windowsBeforeService).toBe(1);
    expect(pkg.totals.windowsNotClosed).toBe(1);
    expect(pkg.gaps).toEqual([{ window: [T0 + W, T0 + 2 * W] }]);
    expect(verifyPackage(pkg).ok).toBe(false);
  });
});

describe('parseInstant: fechas de la línea de comandos', () => {
  it('acepta segundos unix, día completo y fecha con hora', () => {
    expect(parseInstant('1700000400', '--desde')).toBe(1_700_000_400);
    // Un día sin hora es su comienzo en la zona local; se comprueba con el ISO local.
    const d = parseInstant('2026-09-03', '--desde');
    expect(new Date(d * 1000).getHours()).toBe(0);
    expect(new Date(d * 1000).getDate()).toBe(3);
    const h = parseInstant('2026-09-03T14:00', '--hasta');
    expect(new Date(h * 1000).getHours()).toBe(14);
    expect(parseInstant('2026-09-03T14:00:00Z', '--hasta')).toBe(
      Math.floor(Date.UTC(2026, 8, 3, 14) / 1000),
    );
  });

  it('rechaza lo que no es una fecha, nombrando el argumento', () => {
    expect(() => parseInstant('ayer', '--desde')).toThrow(/--desde/);
  });
});
