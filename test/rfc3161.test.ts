import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { AsnConvert } from '@peculiar/asn1-schema';
import { PKIStatus, PKIStatusInfo, TimeStampReq, TimeStampResp } from '@peculiar/asn1-tsp';
import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  OID_SHA256,
  parseResponse,
  randomNonce,
  requestTimestamp,
} from '../src/infra/tsa/rfc3161.ts';
import { bytesToHex } from '../src/shared/hex.ts';

const digest = sha256(utf8ToBytes('raíz'));

describe('RFC 3161: petición', () => {
  it('construye un TimeStampReq v1 con sha256, nonce y certReq', () => {
    const { der, nonce } = buildRequest(digest);
    const req = AsnConvert.parse(der, TimeStampReq);
    expect(req.version).toBe(1);
    expect(req.messageImprint.hashAlgorithm.algorithm).toBe(OID_SHA256);
    expect(bytesToHex(new Uint8Array(req.messageImprint.hashedMessage.buffer))).toBe(
      bytesToHex(digest),
    );
    expect(req.certReq).toBe(true);
    expect(bytesToHex(new Uint8Array(req.nonce as ArrayBuffer))).toBe(bytesToHex(nonce));
    expect(der[0]).toBe(0x30); // SEQUENCE
  });

  it('el nonce es un entero positivo de 16 bytes y no se repite', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).toHaveLength(16);
    expect((a[0] as number) & 0x80).toBe(0);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('rechaza digests que no sean sha256', () => {
    expect(() => buildRequest(new Uint8Array(20))).toThrow(/32 bytes/);
  });
});

describe('RFC 3161: autenticación ante la TSA', () => {
  it('envía Authorization: Basic cuando hay credenciales, y no cuando no las hay', async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fake = async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return new Response(new Uint8Array([1, 2, 3]), { status: 500 });
    };
    await requestTimestamp(digest, 'https://tsa.example/tsr', fake).catch(() => {});
    await requestTimestamp(digest, 'https://tsa.example/tsr', fake, {
      user: 'precintum',
      password: 's3cr3t',
    }).catch(() => {});
    expect(seen[0]?.Authorization).toBeUndefined();
    expect(seen[1]?.Authorization).toBe(
      `Basic ${Buffer.from('precintum:s3cr3t').toString('base64')}`,
    );
    expect(seen[1]?.['Content-Type']).toBe('application/timestamp-query');
  });

  it('un 401 explica qué variables configurar', async () => {
    const fake = async () => new Response(null, { status: 401 });
    await expect(requestTimestamp(digest, 'https://tsa.example/tsr', fake)).rejects.toThrow(
      /PRECINTUM_TSA_USER y PRECINTUM_TSA_PASSWORD/,
    );
  });
});

describe('RFC 3161: respuesta', () => {
  it('una respuesta de rechazo lanza con el estado y el texto de la TSA', () => {
    const resp = new TimeStampResp({
      status: new PKIStatusInfo({ status: PKIStatus.rejection }),
    });
    const der = new Uint8Array(AsnConvert.serialize(resp));
    expect(() => parseResponse(der, { digest })).toThrow(/rechazó/);
  });

  it('una respuesta concedida sin token es un error', () => {
    const resp = new TimeStampResp({ status: new PKIStatusInfo({ status: PKIStatus.granted }) });
    const der = new Uint8Array(AsnConvert.serialize(resp));
    expect(() => parseResponse(der, { digest })).toThrow(/sin token/);
  });

  it('basura no es una respuesta', () => {
    expect(() => parseResponse(new Uint8Array([1, 2, 3]), { digest })).toThrow();
  });
});
