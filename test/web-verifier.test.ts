/**
 * Contraste del verificador del navegador contra la implementación del servidor.
 *
 * El verificador web (`../web/verify/src/*.js`) reimplementa desde cero SHA-256, Schnorr
 * BIP-340, los hashes con dominio, Merkle RFC 6962 y las comprobaciones del paquete, para que un
 * auditor no dependa del software del operador. Ese valor solo existe si las dos implementaciones
 * coinciden, y eso es lo que comprueba este test: mismos hashes, misma verificación de firma y
 * mismos veredictos ante los mismos sabotajes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { BatchService } from '../src/application/batch-service.ts';
import {
  type EvidencePackage,
  ExportService,
  verifyPackage as serverVerify,
} from '../src/application/export-service.ts';
import { commitCount } from '../src/domain/evidence/batch-event.ts';
import { nextReceipt } from '../src/domain/evidence/chain.ts';
import { merkleRoot } from '../src/domain/evidence/merkle.ts';
import { type Receipt, receiptHash } from '../src/domain/evidence/receipt.ts';
import { computeEventId } from '../src/domain/nostr/event.ts';
import { migrate } from '../src/infra/db/migrations.ts';
import { PgliteSqlClient } from '../src/infra/db/pglite-client.ts';
import { SqlBatchStore } from '../src/infra/db/sql-batch-store.ts';
import { SqlEvidenceStore } from '../src/infra/db/sql-evidence-store.ts';
import { evidenceUnitOfWork } from '../src/infra/db/unit-of-work.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';
import { fakeOts, fakeToken, fakeTsa } from './support/fake-anchors.ts';
import { newIdentity } from './support/fixtures.ts';

const H = 'ab'.repeat(32);
const W = 600;
const T0 = 1_700_000_400;
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'verify', 'src');

interface WebCrypto {
  sha256(b: Uint8Array): Uint8Array;
  hex(b: Uint8Array): string;
  utf8(s: string): Uint8Array;
  schnorrVerify(sig: string, msg: string, pub: string): boolean;
}
interface WebFinding {
  level: 'problem' | 'warning' | 'note';
  key: string;
  params: Record<string, unknown>;
  check?: string;
}
interface WebResult {
  ok: boolean;
  problems: WebFinding[];
  warnings: WebFinding[];
  notes: WebFinding[];
  checks: Array<{ id: string; status: string }>;
  totals: { batches: number; receipts: number; empty: number };
  fatal?: string;
}
interface WebChecks {
  verifyPackage(
    pkg: unknown,
    opts?: { verifySignatures?: boolean; expectedPubkey?: string },
  ): WebResult;
  decodePubkey(input: string): string | null;
  receiptHash(r: Receipt): string;
  merkleRoot(hashes: string[]): string;
  commitCount(count: number, salt: string): string;
  computeEventId(e: unknown): string;
  receiptProblem(r: unknown): string | null;
}

let web: WebChecks;
let webCrypto: WebCrypto;

/** Carga los ficheros del verificador tal cual, como haría el navegador. */
function loadWebVerifier(): void {
  for (const file of ['10-crypto.js', '11-checks.js']) {
    const src = readFileSync(join(WEB, file), 'utf8');
    new Function(src)();
  }
  const g = globalThis as unknown as { PrecintumCrypto: WebCrypto; PrecintumChecks: WebChecks };
  webCrypto = g.PrecintumCrypto;
  web = g.PrecintumChecks;
}

describe('verificador web: contraste con el servidor', () => {
  let db: PgliteSqlClient;
  let evidence: SqlEvidenceStore;
  let batches: SqlBatchStore;
  let pkg: EvidencePackage;
  const agent = newIdentity();

  const tsa = fakeTsa({ genTime: () => new Date((T0 + 4 * W) * 1000) });
  const ots = fakeOts({ completeOnUpgrade: () => true });

  beforeAll(async () => {
    loadWebVerifier();
    db = await PgliteSqlClient.open();
    await migrate(db);
    evidence = new SqlEvidenceStore(db);
    batches = new SqlBatchStore(db);
    let prev: Receipt | null = null;
    for (const at of [T0 + 60, T0 + 120, T0 + 180, T0 + 2 * W + 60, T0 + 2 * W + 120]) {
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
      tsa,
      ots,
      now: () => now,
    });
    await service.closeDueWindows(now);
    await service.anchorPending();
    pkg = await new ExportService({ evidence, batches, windowSeconds: W }).exportRange(
      T0,
      T0 + 3 * W,
    );
  }, 60_000);

  /** El paquete pasa por JSON, como cuando el auditor abre el fichero en el navegador. */
  const roundTrip = (p: EvidencePackage): unknown => JSON.parse(JSON.stringify(p));

  it('calcula los mismos hashes que el servidor: recibo, Merkle, recuento e id de evento', () => {
    const b0 = pkg.batches[0];
    if (!b0) throw new Error('sin lotes');
    const r = b0.receipts[0] as Receipt;
    expect(web.receiptHash(r)).toBe(receiptHash(r));
    const hashes = b0.receipts.map(receiptHash);
    expect(web.merkleRoot(hashes)).toBe(merkleRoot(hashes));
    expect(web.merkleRoot(hashes)).toBe(b0.root);
    expect(web.commitCount(b0.count, b0.countSalt)).toBe(commitCount(b0.count, b0.countSalt));
    expect(web.computeEventId(b0.event)).toBe(computeEventId(b0.event));
    expect(web.computeEventId(b0.event)).toBe(b0.event.id);
    // El árbol vacío también: es la raíz de los latidos.
    expect(web.merkleRoot([])).toBe(bytesToHex(sha256(new Uint8Array())));
  });

  it('verifica la firma Schnorr real del evento de lote, y rechaza un bit cambiado', () => {
    const ev = pkg.batches[0]?.event;
    if (!ev) throw new Error('sin evento');
    expect(webCrypto.schnorrVerify(ev.sig, ev.id, ev.pubkey)).toBe(true);
    const flipped = `${ev.sig.slice(0, 20)}${ev.sig[20] === 'a' ? 'b' : 'a'}${ev.sig.slice(21)}`;
    expect(webCrypto.schnorrVerify(flipped, ev.id, ev.pubkey)).toBe(false);
    // Y una firma válida sobre otro mensaje no vale para este.
    const other = bytesToHex(sha256(utf8ToBytes('otro mensaje')));
    expect(webCrypto.schnorrVerify(ev.sig, other, ev.pubkey)).toBe(false);
    // Contraste con la implementación de referencia sobre una firma nueva.
    const msg = sha256(utf8ToBytes('precintum'));
    const sig = schnorr.sign(msg, agent.secretKey);
    expect(webCrypto.schnorrVerify(bytesToHex(sig), bytesToHex(msg), agent.pubkey)).toBe(true);
  });

  it('acepta el paquete honesto, con el mismo veredicto que el servidor', () => {
    const server = serverVerify(pkg);
    const client = web.verifyPackage(roundTrip(pkg));
    expect(server.ok).toBe(true);
    expect(client.ok).toBe(true);
    expect(client.problems).toEqual([]);
    expect(client.warnings).toEqual([]);
    expect(client.totals).toEqual({ batches: 3, receipts: 5, empty: 1 });
    expect(client.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('rechaza lo que no es un paquete', () => {
    expect(web.verifyPackage(null).fatal).toBe('notJson');
    expect(web.verifyPackage({ format: 'otra/cosa' }).fatal).toBe('notPackage');
    expect(web.verifyPackage({ format: 'precintum/export/v1' }).fatal).toBe('notPackage');
  });

  it('detecta un recibo editado, igual que el servidor', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const target = bad.batches[0]?.receipts[1];
    if (!target) throw new Error('sin recibo');
    target.result = 'under_18';
    const client = web.verifyPackage(bad);
    const server = serverVerify(bad);
    expect(client.ok).toBe(false);
    expect(server.ok).toBe(false);
    const keys = client.problems.map((p) => p.key);
    expect(keys).toContain('rootMismatch');
    expect(keys).toContain('prevMismatch');
    // Con la raíz ya distinta no se acusa a cada prueba de inclusión: sería ruido.
    expect(keys).not.toContain('proofFails');
  });

  it('detecta un recibo borrado del paquete', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const b = bad.batches[0];
    if (!b) throw new Error('sin lote');
    b.receipts.splice(1, 1);
    b.proofs.splice(1, 1);
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(false);
    const keys = client.problems.map((p) => p.key);
    expect(keys).toContain('countMismatch');
    expect(keys).toContain('rootMismatch');
    expect(keys).toContain('receiptSeqJump');
    expect(serverVerify(bad).ok).toBe(false);
  });

  it('detecta una sal de recuento cambiada para tapar un borrado', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const b = bad.batches[0];
    if (!b) throw new Error('sin lote');
    b.receipts.pop();
    b.proofs.pop();
    b.count = b.receipts.length; // el operador ajusta el recuento…
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(false);
    // …pero el compromiso publicado en el evento firmado ya no se abre a ese número.
    expect(client.problems.map((p) => p.key)).toContain('countCommit');
  });

  it('detecta un evento de lote reescrito con otra raíz', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const b = bad.batches[0];
    if (!b) throw new Error('sin lote');
    // La raíz del lote va en el `content` del evento: reescribirla es el ataque directo.
    b.event.content = 'cd'.repeat(32);
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(false);
    const keys = client.problems.map((p) => p.key);
    // Tocar el contenido rompe el id y con él la firma: no hace falta mirar más.
    expect(keys).toContain('eventId');
    expect(keys).toContain('signature');
    expect(keys).toContain('eventRoot');
  });

  it('detecta una etiqueta del evento cambiada (ventana, seq, prev o política)', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const b = bad.batches[0];
    if (!b) throw new Error('sin lote');
    b.event.tags = b.event.tags.map((t) => (t[0] === 'window' ? ['window', '0', '60'] : t));
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(false);
    const keys = client.problems.map((p) => p.key);
    expect(keys).toContain('eventWindow');
    expect(keys).toContain('eventId');
  });

  it('detecta un hueco de ventana y el salto en la cadena de lotes', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    bad.batches.splice(1, 1);
    bad.gaps = [{ window: [T0 + W, T0 + 2 * W] }];
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(false);
    const keys = client.problems.map((p) => p.key);
    expect(keys).toContain('gaps');
    expect(keys).toContain('batchSeqJump');
  });

  it('avisa sin fallar de un lote sin sellar o sin ancla completa', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const b = bad.batches[0];
    if (!b) throw new Error('sin lote');
    b.tsaTokenDer = null;
    b.otsComplete = false; // el .ots trae atestación: el paquete declara menos de lo que tiene
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(true);
    expect(client.warnings.map((w) => w.key)).toContain('noTsa');
    expect(client.warnings.map((w) => w.key)).toContain('otsDeclaredPending');
    expect(client.checks.find((c) => c.id === 'tsa')?.status).toBe('warn');
  });

  it('rechaza un sello anterior al cierre de su ventana', () => {
    const bad = roundTrip(pkg) as EvidencePackage;
    const b = bad.batches[0];
    if (!b) throw new Error('sin lote');
    // Un token de verdad con hora anterior al cierre: el verificador la lee del DER, no del JSON.
    b.tsaTokenDer = bytesToHex(fakeToken(hexToBytes(b.eventId), new Date((T0 + 10) * 1000)));
    b.tsaGenTime = T0 + 10;
    const client = web.verifyPackage(bad);
    expect(client.ok).toBe(false);
    expect(client.problems.map((p) => p.key)).toContain('tsaBeforeClose');
  });

  it('rechaza recibos con campos de más: el esquema es estricto', () => {
    expect(web.receiptProblem(pkg.batches[0]?.receipts[0])).toBeNull();
    const withExtra = { ...(pkg.batches[0]?.receipts[0] as Receipt), account: 'nora@example.com' };
    expect(web.receiptProblem(withExtra)).toMatch(/campos/);
    const badTs = { ...(pkg.batches[0]?.receipts[0] as Receipt), ts: T0 + 61 };
    expect(web.receiptProblem(badTs)).toBe('ts');
  });

  it('puede saltarse la verificación de firmas, y lo dice', () => {
    const client = web.verifyPackage(roundTrip(pkg), { verifySignatures: false });
    expect(client.ok).toBe(true);
    expect((client as unknown as { signaturesChecked: boolean }).signaturesChecked).toBe(false);
  });
});
