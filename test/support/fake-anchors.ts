/**
 * Anclajes de mentira con formato de verdad, para los tests.
 *
 * El verificador ya no se cree el `genTime` que escribe el operador: parsea el token RFC 3161 y el
 * fichero .ots. Por eso los tests no pueden usar bytes de juguete: fabrican un TimeStampToken CMS
 * con su TSTInfo (sin firma, que es lo que DSS validará) y un .ots detached con atestación
 * pendiente o Bitcoin, con las mismas librerías que el código de producción.
 */
import {
  CMSVersion,
  ContentInfo,
  DigestAlgorithmIdentifiers,
  EncapsulatedContent,
  EncapsulatedContentInfo,
  SignedData,
  SignerInfos,
} from '@peculiar/asn1-cms';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { MessageImprint, TSTInfo } from '@peculiar/asn1-tsp';
import { AlgorithmIdentifier } from '@peculiar/asn1-x509';
import type { OtsClient, TsaClient } from '../../src/application/batch-service.ts';
import {
  addOp,
  deserializeDetached,
  newTimestamp,
  serializeDetached,
  type Timestamp,
} from '../../src/infra/ots/ots.ts';
import { OID_SHA256, OID_SIGNED_DATA, OID_TST_INFO } from '../../src/infra/tsa/rfc3161.ts';

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** TimeStampToken (ContentInfo/SignedData/TSTInfo) DER para `digest` con `genTime`. Sin firma. */
export function fakeToken(digest: Uint8Array, genTime: Date, serial = 7): Uint8Array {
  const info = new TSTInfo({
    version: 1,
    policy: '1.3.6.1.4.1.99999.1.1',
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithm: OID_SHA256 }),
      hashedMessage: new OctetString(toArrayBuffer(digest)),
    }),
    serialNumber: toArrayBuffer(new Uint8Array([serial])),
    genTime,
  });
  const signed = new SignedData({
    version: CMSVersion.v3,
    digestAlgorithms: new DigestAlgorithmIdentifiers([
      new AlgorithmIdentifier({ algorithm: OID_SHA256 }),
    ]),
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: OID_TST_INFO,
      eContent: new EncapsulatedContent({
        single: new OctetString(AsnConvert.serialize(info)),
      }),
    }),
    signerInfos: new SignerInfos([]),
  });
  const token = new ContentInfo({
    contentType: OID_SIGNED_DATA,
    content: AsnConvert.serialize(signed),
  });
  return new Uint8Array(AsnConvert.serialize(token));
}

export interface FakeTsaOptions {
  /** genTime que devuelve la TSA para cada petición. */
  genTime: (digest: Uint8Array) => Date;
  /** Se ejecuta antes de contestar: para contar llamadas o simular caídas (lanzando). */
  before?: () => void;
}

export function fakeTsa(opts: FakeTsaOptions): TsaClient {
  return {
    async request(digest) {
      opts.before?.();
      const genTime = opts.genTime(digest);
      return { tokenDer: fakeToken(digest, genTime), genTime };
    },
  };
}

/** .ots detached con una atestación pendiente en un calendario ficticio. */
export function pendingOts(digest: Uint8Array): Uint8Array {
  const ts = newTimestamp(digest);
  ts.attestations.push({ type: 'pending', uri: 'https://calendar.fake.test' });
  return serializeDetached(ts);
}

/** .ots detached con una rama que termina en una atestación Bitcoin (altura ficticia). */
export function completeOts(digest: Uint8Array, height = 900_000): Uint8Array {
  const ts: Timestamp = newTimestamp(digest);
  const next = addOp(ts, { type: 'sha256' });
  next.attestations.push({ type: 'bitcoin', height });
  return serializeDetached(ts);
}

export interface FakeOtsOptions {
  /** Si `upgrade` debe completar la atestación Bitcoin. Se consulta en cada llamada. */
  completeOnUpgrade: () => boolean;
}

export function fakeOts(opts: FakeOtsOptions): OtsClient {
  return {
    async submit(digest) {
      return pendingOts(digest);
    },
    async upgrade(bytes) {
      const ts = deserializeDetached(bytes);
      if (opts.completeOnUpgrade()) return { ots: completeOts(ts.msg), complete: true };
      return { ots: bytes, complete: false };
    },
  };
}
