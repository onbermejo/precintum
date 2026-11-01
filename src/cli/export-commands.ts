/**
 * Exportación por rango: `precintum export --desde <fecha> --hasta <fecha>`.
 *
 * Es la respuesta a "deme las verificaciones del 1 al 30 de septiembre". El rango se expande a
 * ventanas completas (ver `ExportService`), y el comando dice tanto lo que entrega como lo que
 * no cuadra: ventanas sin lote, lotes sin sellar, anclas pendientes.
 */
import { writeFile } from 'node:fs/promises';
import { ExportService, verifyPackage } from '../application/export-service.ts';
import { migrate } from '../infra/db/migrations.ts';
import { openSqlClient } from '../infra/db/open.ts';
import { SqlBatchStore } from '../infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../infra/db/sql-evidence-store.ts';
import type { Config } from '../shared/config.ts';
import { resolvePublicIdentity } from './identity.ts';

/**
 * Acepta una fecha ISO (`2026-09-03`, `2026-09-03T14:00`, con o sin zona) o segundos unix.
 * Una fecha sin hora es el comienzo de ese día en la zona local del operador.
 */
export function parseInstant(input: string, label: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00` : trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `${label}: fecha no reconocida ("${input}"); usa 2026-09-03, 2026-09-03T14:00 o segundos unix`,
    );
  }
  return Math.floor(ms / 1000);
}

const fmt = (t: number): string => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

/**
 * De las ventanas que el paquete declara "aún sin cerrar" (después del último lote), cuántas ya
 * terminaron (más la gracia) y se pueden cerrar con `batch close`, y cuántas no han terminado.
 */
export function splitNotClosed(
  pkg: {
    covered: [number, number];
    windowSeconds: number;
    serviceEnd: number | null;
    batches: { window: [number, number] }[];
    totals: { windowsNotClosed: number };
  },
  now: number,
  graceSeconds: number,
): { closable: number; notEnded: number } {
  const present = new Set(pkg.batches.map((b) => b.window[0]));
  let closable = 0;
  const from = pkg.serviceEnd ?? pkg.covered[1];
  for (let w = from; w + pkg.windowSeconds <= pkg.covered[1]; w += pkg.windowSeconds) {
    if (!present.has(w) && w + pkg.windowSeconds + graceSeconds <= now) closable++;
  }
  return { closable, notEnded: Math.max(0, pkg.totals.windowsNotClosed - closable) };
}

export async function cmdExport(
  cfg: Config,
  desde: string | undefined,
  hasta: string | undefined,
  salida: string | undefined,
): Promise<void> {
  if (!desde || !hasta) {
    throw new Error(
      'usage: pnpm precintum export --from <date> --to <date> [--out file.json] (also --desde/--hasta/--salida)',
    );
  }
  const from = parseInstant(desde, '--desde');
  const to = parseInstant(hasta, '--hasta');
  // La pubkey del agente viaja en el paquete como declaración y sirve aquí de clave esperada:
  // el operador comprueba que lo que exporta lo firmó su propia clave.
  const pubkey =
    cfg.PRECINTUM_NSEC || cfg.PRECINTUM_NPUB ? resolvePublicIdentity(cfg).pubkey : undefined;
  const db = await openSqlClient(cfg.PRECINTUM_DATABASE_URL);
  await migrate(db);
  try {
    const service = new ExportService({
      evidence: new SqlEvidenceStore(db),
      batches: new SqlBatchStore(db),
      windowSeconds: cfg.PRECINTUM_BATCH_WINDOW_SECONDS,
      anchorMaxGapSeconds: cfg.PRECINTUM_ANCHOR_MAX_GAP_SECONDS,
      agentPubkey: pubkey,
    });
    const pkg = await service.exportRange(from, to);
    const v = verifyPackage(pkg, { expectedPubkey: pubkey });

    console.error(`rango pedido:    ${fmt(pkg.requested[0])} → ${fmt(pkg.requested[1])}`);
    console.error(
      `rango entregado: ${fmt(pkg.covered[0])} → ${fmt(pkg.covered[1])} (ventanas completas de ${pkg.windowSeconds}s)`,
    );
    console.error(
      `periodo con registro: ${pkg.serviceStart === null ? 'ninguno (no hay lotes cerrados)' : `${fmt(pkg.serviceStart)} → ${fmt(pkg.serviceEnd as number)}`}`,
    );
    console.error(
      `lotes: ${pkg.totals.batches} (${pkg.totals.empty} vacíos) · recibos: ${pkg.totals.receipts}`,
    );
    if (pkg.totals.windowsBeforeService) {
      console.error(
        `ventanas anteriores al arranque del servicio: ${pkg.totals.windowsBeforeService} (no son huecos: no había registro)`,
      );
    }
    if (pkg.totals.windowsNotClosed) {
      const { closable, notEnded } = splitNotClosed(
        pkg,
        Math.floor(Date.now() / 1000),
        cfg.PRECINTUM_BATCH_GRACE_SECONDS,
      );
      if (closable) {
        console.error(
          `ventanas terminadas sin lote: ${closable} (ejecuta \`pnpm precintum batch close\`)`,
        );
      }
      if (notEnded) console.error(`ventanas que aún no han terminado: ${notEnded}`);
    }
    if (pkg.totals.withoutTsa) console.error(`lotes sin sello RFC 3161: ${pkg.totals.withoutTsa}`);
    if (pkg.totals.withoutOts)
      console.error(`lotes sin anclaje Bitcoin completo: ${pkg.totals.withoutOts}`);
    for (const g of pkg.gaps.slice(0, 20))
      console.error(`HUECO: ventana ${fmt(g.window[0])} → ${fmt(g.window[1])} sin lote`);
    if (pkg.gaps.length > 20) console.error(`HUECO: … y ${pkg.gaps.length - 20} ventanas más`);
    for (const w of v.warnings.slice(0, 10)) console.error(`aviso: ${w}`);
    if (v.warnings.length > 10) console.error(`aviso: … y ${v.warnings.length - 10} más`);
    for (const n of v.notes) console.error(`nota: ${n}`);
    for (const p of v.problems) console.error(`PROBLEMA: ${p}`);
    console.error(v.ok ? 'verificación del paquete: correcta' : 'verificación del paquete: FALLA');

    const json = JSON.stringify(pkg, null, 2);
    if (salida) {
      await writeFile(salida, json, 'utf8');
      console.error(`escrito en ${salida} (${json.length} bytes)`);
    } else {
      console.log(json);
    }
    if (!v.ok) process.exitCode = 1;
  } finally {
    await db.close();
  }
}
