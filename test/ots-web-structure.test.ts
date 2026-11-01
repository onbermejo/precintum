import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type EvidencePackage, verifyPackage } from '../src/application/export-service.ts';
import {
  allAttestations,
  deserializeDetached,
  isComplete,
  OTS_MAGIC,
} from '../src/infra/ots/ots.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';

interface WebChecks {
  inspectOts(bytes: Uint8Array): {
    digestHex: string;
    hasBitcoin: boolean;
    hasPending: boolean;
  };
  verifyPackage(pkg: unknown): { ok: boolean; problems: Array<{ key: string }> };
}

const WEB = join(import.meta.dirname, '..', 'web', 'verify', 'src');
const DIGEST = '12'.repeat(32);
const BITCOIN_TAG = '0588960d73d71901';
const PENDING_TAG = '83dfe30d2ef90c8e';
// 0x00 introduce una atestación; el payload Bitcoin contiene una única altura varuint.
const BITCOIN = `00${BITCOIN_TAG}03a0f736`;
const UNKNOWN_TAG = '1122334455667788';

function pending(uri: string): string {
  const bytes = Buffer.from(uri, 'utf8');
  // Estos fixtures usan longitudes de un byte: payload = varbytes(uri).
  const byteHex = (n: number) => n.toString(16).padStart(2, '0');
  return `00${PENDING_TAG}${byteHex(bytes.length + 1)}${byteHex(bytes.length)}${bytes.toString('hex')}`;
}

const PENDING = pending('https://calendar.example');

function detached(body: string, version = '01', digest = DIGEST): Uint8Array {
  return hexToBytes(`${bytesToHex(OTS_MAGIC)}${version}08${digest}${body}`);
}

describe('OpenTimestamps web: estructura y contraste con el servidor', () => {
  for (const file of ['10-crypto.js', '11-checks.js', '13-example.js']) {
    new Function(readFileSync(join(WEB, file), 'utf8'))();
  }
  const g = globalThis as unknown as {
    PrecintumChecks: WebChecks;
    PRECINTUM_EXAMPLE: EvidencePackage;
  };
  const web = g.PrecintumChecks;

  const valid = [
    { name: 'Bitcoin', bytes: detached(BITCOIN), bitcoin: true, pending: false },
    { name: 'pending', bytes: detached(PENDING), bitcoin: false, pending: true },
    {
      name: 'ramas mixtas y versión varuint',
      bytes: detached(`ff${BITCOIN}${PENDING}`, '8100'),
      bitcoin: true,
      pending: true,
    },
    {
      name: 'tag Bitcoin dentro de un argumento append',
      bytes: detached(`f008${BITCOIN_TAG}${PENDING}`),
      bitcoin: false,
      pending: true,
    },
    {
      name: 'tags dentro del payload de una atestación desconocida',
      bytes: detached(`00${UNKNOWN_TAG}10${BITCOIN_TAG}${PENDING_TAG}`),
      bitcoin: false,
      pending: false,
    },
  ];

  it.each(valid)('interpreta $name sin confundir bytes con atestaciones', (fixture) => {
    const ts = deserializeDetached(fixture.bytes);
    expect(isComplete(ts)).toBe(fixture.bitcoin);
    expect(allAttestations(ts).some(({ attestation }) => attestation.type === 'pending')).toBe(
      fixture.pending,
    );
    expect(web.inspectOts(fixture.bytes)).toEqual({
      digestHex: DIGEST,
      hasBitcoin: fixture.bitcoin,
      hasPending: fixture.pending,
    });
  });

  const malformed = [
    { name: 'cabecera truncada', bytes: detached(BITCOIN).subarray(1) },
    {
      name: 'digest truncado',
      bytes: detached(BITCOIN).subarray(0, OTS_MAGIC.length + 2 + 31),
    },
    { name: 'tag Bitcoin sin marcador de atestación', bytes: detached(`${BITCOIN_TAG}03a0f736`) },
    { name: 'payload Bitcoin truncado', bytes: detached(`00${BITCOIN_TAG}03a0f7`) },
    { name: 'payload Bitcoin vacío', bytes: detached(`00${BITCOIN_TAG}00`) },
    { name: 'payload Bitcoin con bytes sobrantes', bytes: detached(`00${BITCOIN_TAG}020100`) },
    { name: 'operación desconocida', bytes: detached(`04${BITCOIN}`) },
    { name: 'bytes después del árbol', bytes: detached(`${BITCOIN}00`) },
    { name: 'rama final ausente', bytes: detached(`ff${BITCOIN}`) },
    { name: 'separador de rama sin contenido', bytes: detached('ff') },
    { name: 'profundidad 257', bytes: detached(`${'08'.repeat(257)}${BITCOIN}`) },
    { name: 'URI pending inválida', bytes: detached(pending('not-a-calendar')) },
    {
      name: 'URI pending con puerto fuera de rango',
      bytes: detached(pending('http://calendar.example:99999')),
    },
    { name: 'URI pending sin host', bytes: detached(pending('http://')) },
    {
      name: 'URI pending IPv6 fuera de la gramática',
      bytes: detached(pending('https://[::1]:1234')),
    },
    {
      name: 'URI pending con ruta codificada fuera de la gramática',
      bytes: detached(pending('https://calendar.example/path%20encoded')),
    },
    {
      name: 'argumento de más de 4096 bytes',
      bytes: detached(`f08120${'00'.repeat(4097)}${BITCOIN}`),
    },
  ];

  it.each(malformed)('rechaza $name igual que el servidor', ({ bytes }) => {
    expect(() => deserializeDetached(bytes)).toThrow();
    expect(() => web.inspectOts(bytes)).toThrow();
  });

  it('admite el límite de profundidad 256 como el servidor', () => {
    const bytes = detached(`${'08'.repeat(256)}${BITCOIN}`);
    expect(isComplete(deserializeDetached(bytes))).toBe(true);
    expect(web.inspectOts(bytes)).toEqual({
      digestHex: DIGEST,
      hasBitcoin: true,
      hasPending: false,
    });
  });

  it('marca como problema un paquete con un tag Bitcoin aislado en vez de una prueba', () => {
    expect(web.verifyPackage(g.PRECINTUM_EXAMPLE).ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(g.PRECINTUM_EXAMPLE)) as EvidencePackage;
    const batch = bad.batches[0];
    if (!batch) throw new Error('el ejemplo no tiene lotes');
    batch.ots = bytesToHex(detached(BITCOIN_TAG, '01', batch.eventId));
    batch.otsComplete = true;

    expect(verifyPackage(bad).ok).toBe(false);
    const result = web.verifyPackage(bad);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.key)).toContain('otsUnparseable');
  });
});
