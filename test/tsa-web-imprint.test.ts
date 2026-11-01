import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContentInfo, EncapsulatedContent, SignedData } from '@peculiar/asn1-cms';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { TSTInfo } from '@peculiar/asn1-tsp';
import { describe, expect, it } from 'vitest';
import { type EvidencePackage, verifyPackage } from '../src/application/export-service.ts';
import { parseToken } from '../src/infra/tsa/rfc3161.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';
import { fakeToken } from './support/fake-anchors.ts';

interface WebChecks {
  parseTsaToken(bytes: Uint8Array): { imprintHex: string; genTime: number };
  verifyPackage(pkg: unknown): { ok: boolean; problems: Array<{ key: string }> };
}

const WEB = join(import.meta.dirname, '..', 'web', 'verify', 'src');
const DIGEST = hexToBytes('12'.repeat(32));
const TIME = new Date('2026-09-03T15:00:07Z');
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
const OID_SHA1 = '1.3.14.3.2.26';

/** Cambia solo el algoritmo del imprint, no digestAlgorithms del CMS ni sus otros campos. */
function withImprintAlgorithm(bytes: Uint8Array, algorithm: string): Uint8Array {
  const token = AsnConvert.parse(bytes, ContentInfo);
  const signed = AsnConvert.parse(token.content, SignedData);
  const content = signed.encapContentInfo.eContent?.single;
  if (!content) throw new Error('el token de prueba no contiene TSTInfo');
  const info = AsnConvert.parse(content.buffer, TSTInfo);
  info.messageImprint.hashAlgorithm.algorithm = algorithm;
  signed.encapContentInfo.eContent = new EncapsulatedContent({
    single: new OctetString(AsnConvert.serialize(info)),
  });
  token.content = AsnConvert.serialize(signed);
  return new Uint8Array(AsnConvert.serialize(token));
}

describe('sello TSA web: algoritmo y longitud del imprint', () => {
  for (const file of ['10-crypto.js', '11-checks.js', '13-example.js']) {
    new Function(readFileSync(join(WEB, file), 'utf8'))();
  }
  const g = globalThis as unknown as {
    PrecintumChecks: WebChecks;
    PRECINTUM_EXAMPLE: EvidencePackage;
  };
  const web = g.PrecintumChecks;

  it('extrae el imprint SHA-256 de 32 bytes y la misma hora que el servidor', () => {
    const token = fakeToken(DIGEST, TIME);
    const server = parseToken(token, { digest: DIGEST });
    expect(web.parseTsaToken(token)).toEqual({
      imprintHex: server.hashedMessage,
      genTime: server.genTime.getTime() / 1000,
    });
  });

  it.each([
    { name: 'SHA-384', oid: OID_SHA384 },
    { name: 'SHA-1', oid: OID_SHA1 },
  ])('rechaza un imprint marcado como $name aunque conserve los 32 bytes', ({ oid }) => {
    const token = withImprintAlgorithm(fakeToken(DIGEST, TIME), oid);
    expect(() => parseToken(token, { digest: DIGEST })).toThrow(/algoritmo inesperado/);
    expect(() => web.parseTsaToken(token)).toThrow();
  });

  it.each([0, 31, 33])('rechaza SHA-256 con %i bytes en vez de los 32 esperados', (length) => {
    const token = fakeToken(new Uint8Array(length).fill(0x12), TIME);
    expect(() => parseToken(token, { digest: DIGEST })).toThrow(/imprint/);
    expect(() => web.parseTsaToken(token)).toThrow();
  });

  it('marca como problema el paquete si solo cambia el algoritmo del imprint a SHA-384', () => {
    expect(verifyPackage(g.PRECINTUM_EXAMPLE).ok).toBe(true);
    expect(web.verifyPackage(g.PRECINTUM_EXAMPLE).ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(g.PRECINTUM_EXAMPLE)) as EvidencePackage;
    const batch = bad.batches[0];
    if (!batch?.tsaTokenDer) throw new Error('el ejemplo no contiene sello TSA');
    const token = withImprintAlgorithm(hexToBytes(batch.tsaTokenDer), OID_SHA384);
    batch.tsaTokenDer = bytesToHex(token);

    expect(() => parseToken(token, { digest: hexToBytes(batch.eventId) })).toThrow(
      /algoritmo inesperado/,
    );
    expect(verifyPackage(bad).ok).toBe(false);
    const result = web.verifyPackage(bad);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.key)).toContain('tsaUnparseable');
  });
});
