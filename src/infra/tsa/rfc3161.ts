/**
 * Cliente RFC 3161 (Time-Stamp Protocol) sobre HTTP, con las clases ASN.1 de @peculiar.
 *
 * Por qué hace falta: RFC 4998 (Evidence Record Syntax) exige en cada ArchiveTimeStamp "a
 * cryptographically secure confirmation from the TSA". Una atestación OpenTimestamps es una
 * prueba de inclusión en Bitcoin, no una TSA. Así que cada lote lleva las dos cosas: el sello
 * de una TSA (para el Evidence Record) y el anclaje en Bitcoin (para no depender de la TSA).
 *
 * Alcance del MVP: construir la petición, obtener el token y extraer el TSTInfo (hora,
 * política, serie, imprint). La verificación criptográfica del CMS (firma y cadena de la TSA)
 * queda fuera de este cliente; puede realizarse con DSS, herramienta de referencia europea.
 */
import { randomBytes } from '@noble/hashes/utils.js';
import { ContentInfo, type EncapsulatedContent, SignedData } from '@peculiar/asn1-cms';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import {
  MessageImprint,
  PKIStatus,
  TimeStampReq,
  TimeStampResp,
  TSTInfo,
} from '@peculiar/asn1-tsp';
import { AlgorithmIdentifier } from '@peculiar/asn1-x509';
import { bytesToHex } from '../../shared/hex.ts';
import { type FetchLike, fetchWithTimeout } from '../../shared/http.ts';
import { redactUrl } from '../../shared/redact.ts';

export const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
export const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
export const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';

/** TSA pública gratuita usada en desarrollo. Un cliente usará la suya o la de un QTSP. */
export const DEFAULT_TSA_URL = 'https://freetsa.org/tsr';

export interface TimeStampRequest {
  der: Uint8Array;
  nonce: Uint8Array;
}

/** Construye un TimeStampReq (v1, sha256, nonce aleatorio, certReq=true) para un digest. */
export function buildRequest(
  digest: Uint8Array,
  nonce: Uint8Array = randomNonce(),
): TimeStampRequest {
  if (digest.length !== 32) throw new Error('RFC 3161: el digest debe ser sha256 (32 bytes)');
  const req = new TimeStampReq({
    version: 1,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithm: OID_SHA256 }),
      hashedMessage: new OctetString(digest),
    }),
    nonce: toArrayBuffer(nonce),
    certReq: true,
  });
  return { der: new Uint8Array(AsnConvert.serialize(req)), nonce };
}

/** Nonce de 16 bytes con el bit alto a cero: un INTEGER ASN.1 positivo. */
export function randomNonce(): Uint8Array {
  const n = randomBytes(16);
  n[0] = (n[0] as number) & 0x7f;
  return n;
}

export interface TimeStampTokenInfo {
  /** DER del TimeStampToken (ContentInfo/SignedData): lo que va al Evidence Record. */
  tokenDer: Uint8Array;
  genTime: Date;
  policy: string;
  serialNumber: string;
  /** Digest sellado, hex. */
  hashedMessage: string;
  hashAlgorithm: string;
  nonce: string | null;
}

/** Extrae y valida la parte legible de un TimeStampResp DER. Lanza si la TSA rechazó. */
export function parseResponse(
  responseDer: Uint8Array,
  expected: { digest: Uint8Array; nonce?: Uint8Array },
): TimeStampTokenInfo {
  const resp = AsnConvert.parse(responseDer, TimeStampResp);
  const status = resp.status.status;
  if (status !== PKIStatus.granted && status !== PKIStatus.grantedWithMods) {
    const text = resp.status.statusString?.join('; ') ?? '';
    throw new Error(
      `RFC 3161: la TSA rechazó la petición (status ${status}${text ? `: ${text}` : ''})`,
    );
  }
  if (!resp.timeStampToken) throw new Error('RFC 3161: respuesta concedida sin token');
  return parseToken(new Uint8Array(AsnConvert.serialize(resp.timeStampToken)), expected);
}

/** Extrae el TSTInfo de un TimeStampToken DER y comprueba imprint y nonce. */
export function parseToken(
  tokenDer: Uint8Array,
  expected: { digest: Uint8Array; nonce?: Uint8Array },
): TimeStampTokenInfo {
  const token = AsnConvert.parse(tokenDer, ContentInfo);
  if (token.contentType !== OID_SIGNED_DATA) {
    throw new Error(`RFC 3161: el token no es SignedData (${token.contentType})`);
  }
  const signed = AsnConvert.parse(token.content, SignedData);
  if (signed.encapContentInfo.eContentType !== OID_TST_INFO) {
    throw new Error(`RFC 3161: contenido inesperado ${signed.encapContentInfo.eContentType}`);
  }
  const eContent = signed.encapContentInfo.eContent;
  const tstDer = encapsulatedBytes(eContent);
  const info = AsnConvert.parse(tstDer, TSTInfo);
  const hashed = new Uint8Array(info.messageImprint.hashedMessage.buffer);
  if (bytesToHex(hashed) !== bytesToHex(expected.digest)) {
    throw new Error('RFC 3161: el imprint del token no coincide con el digest pedido');
  }
  if (info.messageImprint.hashAlgorithm.algorithm !== OID_SHA256) {
    throw new Error(
      `RFC 3161: algoritmo inesperado ${info.messageImprint.hashAlgorithm.algorithm}`,
    );
  }
  const nonce = info.nonce ? bytesToHex(stripLeadingZeros(new Uint8Array(info.nonce))) : null;
  if (expected.nonce && nonce !== bytesToHex(stripLeadingZeros(expected.nonce))) {
    throw new Error('RFC 3161: el nonce del token no coincide (posible respuesta reutilizada)');
  }
  return {
    tokenDer,
    genTime: info.genTime,
    policy: info.policy,
    serialNumber: bytesToHex(new Uint8Array(info.serialNumber)),
    hashedMessage: bytesToHex(hashed),
    hashAlgorithm: info.messageImprint.hashAlgorithm.algorithm,
    nonce,
  };
}

export type { FetchLike } from '../../shared/http.ts';

/**
 * Credenciales para la TSA. Las TSA de los prestadores cualificados suelen exigir autenticación
 * HTTP básica (usuario y contraseña) o certificado de cliente. Aquí la básica; el certificado de
 * cliente se añadirá cuando se conozca el método del prestador elegido.
 */
export interface TsaAuth {
  user: string;
  password: string;
}

/** Pide un sello de tiempo para `digest` a la TSA. Devuelve el token y su TSTInfo. */
export async function requestTimestamp(
  digest: Uint8Array,
  tsaUrl: string = DEFAULT_TSA_URL,
  fetchImpl: FetchLike = fetch,
  auth?: TsaAuth,
): Promise<TimeStampTokenInfo> {
  const req = buildRequest(digest);
  const headers: Record<string, string> = {
    'Content-Type': 'application/timestamp-query',
    Accept: 'application/timestamp-reply',
  };
  if (auth) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64')}`;
  }
  const res = await fetchWithTimeout(fetchImpl, tsaUrl, {
    method: 'POST',
    headers,
    body: req.der,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `TSA ${redactUrl(tsaUrl)}: HTTP ${res.status}. La TSA exige credenciales: configura PRECINTUM_TSA_USER y PRECINTUM_TSA_PASSWORD (o pide al prestador su método de autenticación)`,
    );
  }
  if (!res.ok) throw new Error(`TSA ${redactUrl(tsaUrl)}: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  return parseResponse(body, { digest, nonce: req.nonce });
}

function encapsulatedBytes(e: EncapsulatedContent | undefined): Uint8Array {
  if (!e) throw new Error('RFC 3161: token sin eContent');
  if (e.single) return new Uint8Array(e.single.buffer);
  if (e.any) return new Uint8Array(e.any);
  throw new Error('RFC 3161: eContent vacío');
}

function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.slice(i);
}

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
