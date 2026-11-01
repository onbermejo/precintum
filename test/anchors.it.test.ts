/**
 * Integración con servicios de tiempo reales (solo con PRECINTUM_IT=1):
 *  - TSA pública freetsa.org: pide un sello RFC 3161 para un digest y extrae el TSTInfo.
 *  - Calendario OpenTimestamps: envía un digest y recibe una atestación "pending".
 * Ninguno publica datos: solo un hash aleatorio.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  allAttestations,
  calendarSubmit,
  deserializeDetached,
  isComplete,
  PUBLIC_CALENDARS,
  serializeDetached,
} from '../src/infra/ots/ots.ts';
import { DEFAULT_TSA_URL, requestTimestamp } from '../src/infra/tsa/rfc3161.ts';
import { bytesToHex } from '../src/shared/hex.ts';

const digest = sha256(randomBytes(32));

describe('anclajes reales', () => {
  it(`TSA ${DEFAULT_TSA_URL} concede un sello para el digest`, async () => {
    const info = await requestTimestamp(digest, DEFAULT_TSA_URL);
    expect(info.hashedMessage).toBe(bytesToHex(digest));
    expect(info.genTime.getTime()).toBeGreaterThan(Date.now() - 10 * 60_000);
    expect(info.genTime.getTime()).toBeLessThan(Date.now() + 10 * 60_000);
    expect(info.tokenDer[0]).toBe(0x30);
    expect(info.policy).toMatch(/^\d+(\.\d+)+$/);
  }, 30_000);

  it(`calendario ${PUBLIC_CALENDARS[0]} devuelve una atestación pending para el digest`, async () => {
    const ts = await calendarSubmit(PUBLIC_CALENDARS[0], digest);
    const atts = allAttestations(ts);
    expect(atts.length).toBeGreaterThan(0);
    expect(atts.every((a) => a.attestation.type === 'pending')).toBe(true);
    expect(isComplete(ts)).toBe(false);
    const file = serializeDetached(ts);
    expect(bytesToHex(deserializeDetached(file).msg)).toBe(bytesToHex(digest));
  }, 30_000);
});
