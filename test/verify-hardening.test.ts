/**
 * El verificador no se cree nada que haya escrito el operador: huecos y continuidad
 * recalculados, token RFC 3161 y fichero .ots leídos, clave firmante
 * única y contrastada con la esperada, tipos validados. Servidor y navegador deben coincidir.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nip19 } from 'nostr-tools';
import { beforeAll, describe, expect, it } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import {
  type EvidencePackage,
  ExportService,
  verifyPackage,
} from '../src/application/export-service.ts';
import { buildBatchEvent, parseBatchEvent } from '../src/domain/evidence/batch-event.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import type { Receipt } from '../src/domain/evidence/receipt.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';
import { completeOts, fakeOts, fakeToken, fakeTsa, pendingOts } from './support/fake-anchors.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const W = 600;
const T0 = 1_700_000_400;
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'verify', 'src');

interface WebFinding {
  level: string;
  key: string;
}
interface WebResult {
  ok: boolean;
  problems: WebFinding[];
  warnings: WebFinding[];
  notes: WebFinding[];
  checks: Array<{ id: string; status: string }>;
}
interface WebChecks {
  verifyPackage(pkg: unknown, opts?: { expectedPubkey?: string }): WebResult;
  decodePubkey(input: string): string | null;
  parseTsaToken(bytes: Uint8Array): { imprintHex: string; genTime: number };
  inspectOts(bytes: Uint8Array): { digestHex: string; hasBitcoin: boolean; hasPending: boolean };
}

let web: WebChecks;
const roundTrip = (p: EvidencePackage): EvidencePackage => JSON.parse(JSON.stringify(p));
const keys = (r: WebResult) => r.problems.map((p) => p.key);
const text = (v: { problems: string[] }) => v.problems.join(' | ');

describe('verificador endurecido: nada autodeclarado se da por bueno', () => {
  let db: PgliteSqlClient;
  let evidence: SqlEvidenceStore;
  let batches: SqlBatchStore;
  let pkg: EvidencePackage;
  const agent = newIdentity();
  const intruder = newIdentity();
  const GEN = T0 + 4 * W; // sello 10 minutos después del cierre de la última ventana

  beforeAll(async () => {
    for (const file of ['10-crypto.js', '11-checks.js']) {
      new Function(readFileSync(join(WEB, file), 'utf8'))();
    }
    web = (globalThis as unknown as { PrecintumChecks: WebChecks }).PrecintumChecks;
    db = await PgliteSqlClient.open();
    await migrate(db);
    evidence = new SqlEvidenceStore(db);
    batches = new SqlBatchStore(db);
    let prev: Receipt | null = null;
    for (const at of [T0 + 60, T0 + 120, T0 + 2 * W + 60]) {
      prev = nextReceipt(prev, { policy: H, verifier: H, result: 'over_18', at });
      await evidence.receipts.append(prev);
    }
    const now = T0 + 3 * W + 10;
    const service = new BatchService({
      evidence,
      batches,
      tx: evidenceUnitOfWork(db),
      identity: agent,
      policy: H,
      windowSeconds: W,
      tsa: fakeTsa({ genTime: () => new Date(GEN * 1000) }),
      ots: fakeOts({ completeOnUpgrade: () => true }),
      now: () => now,
    });
    await service.closeDueWindows(now);
    await service.anchorPending();
    pkg = await new ExportService({
      evidence,
      batches,
      windowSeconds: W,
      agentPubkey: agent.pubkey,
    }).exportRange(T0, T0 + 3 * W);
  }, 60_000);

  it('el paquete honesto pasa en los dos motores, con notas sobre lo que no se puede contrastar', () => {
    const server = verifyPackage(pkg, { expectedPubkey: agent.pubkey });
    expect(server.ok).toBe(true);
    expect(server.problems).toEqual([]);
    expect(server.warnings).toEqual([]);
    expect(server.notes.join(' | ')).toMatch(/firma CMS/);
    const client = web.verifyPackage(roundTrip(pkg), {
      expectedPubkey: nip19.npubEncode(agent.pubkey),
    });
    expect(client.ok).toBe(true);
    expect(client.notes.map((n) => n.key)).toContain('pubkeyMatches');
    expect(client.notes.map((n) => n.key)).toContain('tsaCmsNotChecked');
    // Sin clave esperada, se dice que no se ha contrastado (nota, no aviso).
    const noKey = web.verifyPackage(roundTrip(pkg));
    expect(noKey.ok).toBe(true);
    expect(noKey.warnings).toEqual([]);
    expect(noKey.notes.map((n) => n.key)).toContain('pubkeyNotChecked');
    expect(verifyPackage(pkg).notes.join(' | ')).toMatch(/no se ha contrastado/);
  });

  it('decodifica npub como la implementación de referencia y rechaza basura', () => {
    expect(web.decodePubkey(nip19.npubEncode(agent.pubkey))).toBe(agent.pubkey);
    expect(web.decodePubkey(agent.pubkey.toUpperCase())).toBe(agent.pubkey);
    expect(web.decodePubkey('npub1notvalid')).toBeNull();
    expect(web.decodePubkey('hola')).toBeNull();
  });

  it('lee del token RFC 3161 lo mismo que el servidor: imprint y hora', () => {
    const b0 = pkg.batches[0];
    if (!b0?.tsaTokenDer) throw new Error('sin sello');
    const parsed = web.parseTsaToken(hexToBytes(b0.tsaTokenDer));
    expect(parsed.imprintHex).toBe(b0.eventId);
    expect(parsed.genTime).toBe(GEN);
    const ots = web.inspectOts(hexToBytes(b0.ots ?? ''));
    expect(ots.digestHex).toBe(b0.eventId);
    expect(ots.hasBitcoin).toBe(true);
  });

  it('un lote refirmado con otra clave se detecta, con o sin clave esperada', () => {
    const bad = roundTrip(pkg);
    const b1 = bad.batches[1];
    if (!b1) throw new Error('sin lote');
    const parsed = parseBatchEvent(b1.event);
    if (!parsed.ok) throw new Error(parsed.reason);
    b1.event = buildBatchEvent(parsed.data, intruder, b1.event.created_at);
    b1.eventId = b1.event.id;
    const server = verifyPackage(bad);
    expect(server.ok).toBe(false);
    expect(text(server)).toMatch(/claves distintas/);
    expect(keys(web.verifyPackage(roundTrip(bad)))).toContain('mixedPubkeys');
    // Todos los lotes refirmados por el intruso: coherente consigo mismo, pero no es el operador.
    const all = roundTrip(pkg);
    for (const b of all.batches) {
      const p = parseBatchEvent(b.event);
      if (!p.ok) throw new Error(p.reason);
      b.event = buildBatchEvent(p.data, intruder, b.event.created_at);
      b.eventId = b.event.id;
      b.tsaTokenDer = bytesToHex(fakeToken(hexToBytes(b.eventId), new Date(GEN * 1000)));
      b.ots = bytesToHex(completeOts(hexToBytes(b.eventId)));
    }
    all.agentPubkey = intruder.pubkey;
    expect(verifyPackage(all).ok).toBe(true); // sin clave esperada solo se puede anotar
    expect(verifyPackage(all, { expectedPubkey: agent.pubkey }).problems.join(' | ')).toMatch(
      /no es la del operador/,
    );
    expect(keys(web.verifyPackage(roundTrip(all), { expectedPubkey: agent.pubkey }))).toContain(
      'pubkeyMismatch',
    );
  });

  it('una etiqueta de formato repetida o un evento fechado antes del fin fallan en los dos motores', () => {
    const dup = roundTrip(pkg);
    const b1 = dup.batches[1];
    if (!b1) throw new Error('sin lote');
    b1.event = { ...b1.event, tags: [...b1.event.tags, ['seq', '99']] };
    expect(text(verifyPackage(dup))).toMatch(/repetida/);
    expect(keys(web.verifyPackage(roundTrip(dup)))).toContain('eventDupTag');
    const early = roundTrip(pkg);
    const b2 = early.batches[1];
    if (!b2) throw new Error('sin lote');
    b2.event = { ...b2.event, created_at: b2.event.created_at - W };
    expect(text(verifyPackage(early))).toMatch(/created_at/);
    expect(keys(web.verifyPackage(roundTrip(early)))).toContain('eventCreatedAt');
  });

  it('un token cuyo imprint no es el id del evento, o con hora distinta de la declarada, falla', () => {
    const bad = roundTrip(pkg);
    const b0 = bad.batches[0];
    if (!b0) throw new Error('sin lote');
    b0.tsaTokenDer = bytesToHex(fakeToken(hexToBytes('11'.repeat(32)), new Date(GEN * 1000)));
    expect(text(verifyPackage(bad))).toMatch(/imprint/);
    expect(keys(web.verifyPackage(roundTrip(bad)))).toContain('tsaImprint');

    const lied = roundTrip(pkg);
    const c0 = lied.batches[0];
    if (!c0) throw new Error('sin lote');
    c0.tsaGenTime = T0 + W + 1; // el JSON dice una hora; el token dice otra
    expect(text(verifyPackage(lied))).toMatch(/genTime declarado/);
    expect(keys(web.verifyPackage(roundTrip(lied)))).toContain('tsaGenTimeMismatch');
  });

  it('un sello demasiado tarde (fuera de la ventana de anclaje) es posible antedatado', () => {
    const bad = roundTrip(pkg);
    const b0 = bad.batches[0];
    if (!b0) throw new Error('sin lote');
    const late = b0.window[1] + 3 * 86_400;
    b0.tsaTokenDer = bytesToHex(fakeToken(hexToBytes(b0.eventId), new Date(late * 1000)));
    b0.tsaGenTime = late;
    expect(text(verifyPackage(bad))).toMatch(/antedatado/);
    expect(keys(web.verifyPackage(roundTrip(bad)))).toContain('tsaLate');
    // Con un gap máximo mayor, impuesto por el auditor, pasa.
    expect(verifyPackage(bad, { anchorMaxGapSeconds: 4 * 86_400 }).ok).toBe(true);
  });

  it('un hueco escondido (lote quitado, gaps vacío y cadena declarada continua) se recalcula', () => {
    const bad = roundTrip(pkg);
    bad.batches.splice(1, 1);
    bad.gaps = [];
    bad.batchChainOk = true;
    const server = verifyPackage(bad);
    expect(server.ok).toBe(false);
    expect(text(server)).toMatch(/faltan 1 ventanas/);
    expect(text(server)).toMatch(/declara 0 huecos/);
    expect(text(server)).toMatch(/declara la cadena de lotes continua/);
    const k = keys(web.verifyPackage(roundTrip(bad)));
    expect(k).toContain('gaps');
    expect(k).toContain('gapsDeclaredMismatch');
    expect(k).toContain('chainDeclaredMismatch');
  });

  it('quitar el último lote del rango no pasa en silencio: se anota como borde sin lote', () => {
    const trimmed = roundTrip(pkg);
    trimmed.batches.pop();
    const server = verifyPackage(trimmed);
    expect(server.ok).toBe(true); // no se puede probar borrado sin los relays…
    expect(server.notes.join(' | ')).toMatch(/1 ventanas del rango, en sus bordes/); // …pero se dice
    const client = web.verifyPackage(roundTrip(trimmed));
    expect(client.notes.map((n) => n.key)).toContain('edgeWindows');
  });

  it('un anclaje declarado completo cuyo .ots sigue pendiente falla; y al revés se avisa', () => {
    const bad = roundTrip(pkg);
    const b0 = bad.batches[0];
    if (!b0) throw new Error('sin lote');
    b0.ots = bytesToHex(pendingOts(hexToBytes(b0.eventId)));
    expect(text(verifyPackage(bad))).toMatch(/no tiene atestación Bitcoin/);
    expect(keys(web.verifyPackage(roundTrip(bad)))).toContain('otsNotComplete');
    const stale = roundTrip(pkg);
    const c0 = stale.batches[0];
    if (!c0) throw new Error('sin lote');
    c0.otsComplete = false;
    const v = verifyPackage(stale);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' | ')).toMatch(/anclaje en Bitcoin/);
    expect(web.verifyPackage(roundTrip(stale)).warnings.map((w) => w.key)).toContain(
      'otsDeclaredPending',
    );
  });

  it('un paquete con números disfrazados de texto se rechaza antes de operar con ellos', () => {
    const bad = roundTrip(pkg) as unknown as { batches: Array<Record<string, unknown>> };
    const b0 = bad.batches[0];
    if (!b0) throw new Error('sin lote');
    b0.seq = '<img src=x onerror=alert(1)>';
    b0.count = '2';
    expect(verifyPackage(bad as unknown as EvidencePackage).problems.join(' | ')).toMatch(
      /tipos inválidos/,
    );
    expect(keys(web.verifyPackage(bad))).toContain('badTypes');
  });

  it('una prueba de inclusión con un tamaño de árbol distinto del recuento falla', () => {
    const bad = roundTrip(pkg);
    const p = bad.batches[0]?.proofs[0];
    if (!p) throw new Error('sin prueba');
    p.proof.size = 5;
    expect(text(verifyPackage(bad))).toMatch(/árbol de 5 hojas/);
    expect(keys(web.verifyPackage(roundTrip(bad)))).toContain('proofSize');
  });
});
