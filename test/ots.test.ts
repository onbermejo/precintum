import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  addOp,
  allAttestations,
  applyOp,
  deserializeDetached,
  deserializeTimestamp,
  displayHashToInternal,
  isComplete,
  mergeTimestamp,
  newTimestamp,
  OTS_MAGIC,
  serializeDetached,
  serializeTimestamp,
  type Timestamp,
  upgrade,
  verifyBitcoin,
} from '../src/infra/ots/ots.ts';
import { bytesToHex, hexToBytes } from '../src/shared/hex.ts';

const digest = sha256(utf8ToBytes('raíz de lote de prueba'));

/** Un timestamp como los que devuelve un calendario: digest → append(nonce) → sha256 → pending. */
function pendingStamp(uri = 'https://a.pool.opentimestamps.org'): Timestamp {
  const ts = newTimestamp(digest);
  const s1 = addOp(ts, { type: 'append', arg: hexToBytes('a1b2c3d4') });
  const s2 = addOp(s1, { type: 'sha256' });
  s2.attestations.push({ type: 'pending', uri });
  return ts;
}

/** Un timestamp ya anclado: … → prepend → sha256 → bitcoin(altura). */
function bitcoinStamp(): { ts: Timestamp; merkleRootInternal: Uint8Array } {
  const ts = newTimestamp(digest);
  const s1 = addOp(ts, { type: 'append', arg: hexToBytes('a1b2c3d4') });
  const s2 = addOp(s1, { type: 'sha256' });
  const s3 = addOp(s2, { type: 'prepend', arg: hexToBytes('00ff') });
  const s4 = addOp(s3, { type: 'sha256' });
  s4.attestations.push({ type: 'bitcoin', height: 800_000 });
  return { ts, merkleRootInternal: s4.msg };
}

describe('OpenTimestamps: ops', () => {
  it('aplica cada op como manda el formato', () => {
    const m = utf8ToBytes('ab');
    expect(bytesToHex(applyOp({ type: 'sha256' }, m))).toBe(bytesToHex(sha256(m)));
    expect(bytesToHex(applyOp({ type: 'append', arg: utf8ToBytes('c') }, m))).toBe('616263');
    expect(bytesToHex(applyOp({ type: 'prepend', arg: utf8ToBytes('c') }, m))).toBe('636162');
    expect(bytesToHex(applyOp({ type: 'reverse' }, m))).toBe('6261');
    expect(new TextDecoder().decode(applyOp({ type: 'hexlify' }, m))).toBe('6162');
    expect(applyOp({ type: 'ripemd160' }, m)).toHaveLength(20);
    expect(applyOp({ type: 'sha1' }, m)).toHaveLength(20);
    expect(applyOp({ type: 'keccak256' }, m)).toHaveLength(32);
  });

  it('addOp reutiliza la rama si la op ya existía', () => {
    const ts = newTimestamp(digest);
    const a = addOp(ts, { type: 'sha256' });
    const b = addOp(ts, { type: 'sha256' });
    expect(a).toBe(b);
    expect(ts.ops).toHaveLength(1);
  });
});

describe('OpenTimestamps: serialización', () => {
  it('un timestamp con atestación pending sobrevive a serializar y deserializar', () => {
    const ts = pendingStamp();
    const bytes = serializeTimestamp(ts);
    const back = deserializeTimestamp(bytes, digest);
    expect(bytesToHex(serializeTimestamp(back))).toBe(bytesToHex(bytes));
    const atts = allAttestations(back);
    expect(atts).toHaveLength(1);
    expect(atts[0]?.attestation).toEqual({
      type: 'pending',
      uri: 'https://a.pool.opentimestamps.org',
    });
    // El mensaje de la atestación es sha256(digest || a1b2c3d4)
    expect(bytesToHex(atts[0]?.msg as Uint8Array)).toBe(
      bytesToHex(sha256(new Uint8Array([...digest, 0xa1, 0xb2, 0xc3, 0xd4]))),
    );
  });

  it('los bytes en el cable siguen el formato: op tag, varbytes, 0x00 antes de la atestación, tag de 8 bytes', () => {
    const bytes = serializeTimestamp(pendingStamp());
    // f0 = append, 04 = longitud del argumento, a1b2c3d4, 08 = sha256, 00 = atestación, tag pending
    expect(bytesToHex(bytes.slice(0, 7))).toBe('f004a1b2c3d408');
    expect(bytesToHex(bytes.slice(7, 8))).toBe('00');
    expect(bytesToHex(bytes.slice(8, 16))).toBe('83dfe30d2ef90c8e');
  });

  it('varias ramas se separan con 0xff y se recuperan íntegras', () => {
    const ts = pendingStamp('https://a.pool.opentimestamps.org');
    const other = pendingStamp('https://b.pool.opentimestamps.org');
    // Segunda rama con otra op distinta desde el digest.
    const s = addOp(ts, { type: 'prepend', arg: hexToBytes('ee') });
    addOp(s, { type: 'sha256' }).attestations.push({ type: 'pending', uri: 'https://c.example' });
    mergeTimestamp(ts, other);
    const back = deserializeTimestamp(serializeTimestamp(ts), digest);
    const uris = allAttestations(back)
      .map((a) => (a.attestation.type === 'pending' ? a.attestation.uri : ''))
      .sort();
    expect(uris).toEqual([
      'https://a.pool.opentimestamps.org',
      'https://b.pool.opentimestamps.org',
      'https://c.example',
    ]);
    expect(bytesToHex(serializeTimestamp(back))).toBe(bytesToHex(serializeTimestamp(ts)));
  });

  it('el fichero .ots lleva la cabecera mágica, la versión y el digest', () => {
    const { ts } = bitcoinStamp();
    const file = serializeDetached(ts);
    expect(bytesToHex(file.slice(0, OTS_MAGIC.length))).toBe(bytesToHex(OTS_MAGIC));
    expect(file[OTS_MAGIC.length]).toBe(0x01); // versión
    expect(file[OTS_MAGIC.length + 1]).toBe(0x08); // sha256 del fichero
    expect(bytesToHex(file.slice(OTS_MAGIC.length + 2, OTS_MAGIC.length + 34))).toBe(
      bytesToHex(digest),
    );
    const back = deserializeDetached(file);
    expect(bytesToHex(serializeDetached(back))).toBe(bytesToHex(file));
    expect(isComplete(back)).toBe(true);
  });

  it('rechaza basura: cabecera mala, bytes sobrantes, op desconocida', () => {
    expect(() => deserializeDetached(new Uint8Array([1, 2, 3]))).toThrow(/OTS/);
    const bytes = serializeTimestamp(pendingStamp());
    expect(() => deserializeTimestamp(new Uint8Array([...bytes, 0x00]), digest)).toThrow(/OTS/);
    expect(() => deserializeTimestamp(new Uint8Array([0x99]), digest)).toThrow(/op desconocida/);
  });
});

describe('OpenTimestamps: verificación y actualización', () => {
  it('verifyBitcoin compara el mensaje con la raíz Merkle del bloque (orden interno)', async () => {
    const { ts, merkleRootInternal } = bitcoinStamp();
    const display = bytesToHex(Uint8Array.from(merkleRootInternal).reverse());
    expect(bytesToHex(displayHashToInternal(display))).toBe(bytesToHex(merkleRootInternal));
    const ok = await verifyBitcoin(ts, async (h) => (h === 800_000 ? display : '00'.repeat(32)));
    expect(ok).toEqual([
      { height: 800_000, merkleRootInternal: bytesToHex(merkleRootInternal), ok: true },
    ]);
    const bad = await verifyBitcoin(ts, async () => '11'.repeat(32));
    expect(bad[0]?.ok).toBe(false);
  });

  it('upgrade sustituye la atestación pending por lo que devuelve el calendario', async () => {
    const ts = pendingStamp();
    const pending = allAttestations(ts)[0];
    const commitment = pending?.msg as Uint8Array;
    // El calendario devuelve, para ese compromiso: prepend → sha256 → bitcoin.
    const fresh = newTimestamp(commitment);
    const f1 = addOp(fresh, { type: 'prepend', arg: hexToBytes('beef') });
    addOp(f1, { type: 'sha256' }).attestations.push({ type: 'bitcoin', height: 900_000 });
    const calendarBody = serializeTimestamp(fresh);
    const fetchImpl = async (url: string) => {
      expect(url).toBe(`https://a.pool.opentimestamps.org/timestamp/${bytesToHex(commitment)}`);
      return new Response(calendarBody, { status: 200 });
    };
    expect(isComplete(ts)).toBe(false);
    expect(await upgrade(ts, fetchImpl)).toBe(1);
    expect(isComplete(ts)).toBe(true);
    expect(allAttestations(ts).some((a) => a.attestation.type === 'pending')).toBe(false);
    // Y es idempotente: sin pendientes no hay nada que actualizar.
    expect(await upgrade(ts, fetchImpl)).toBe(0);
  });

  it('upgrade deja el pending si el calendario aún no lo tiene (404)', async () => {
    const ts = pendingStamp();
    expect(await upgrade(ts, async () => new Response(null, { status: 404 }))).toBe(0);
    expect(isComplete(ts)).toBe(false);
  });
});
