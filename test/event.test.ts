import { finalizeEvent, verifyEvent as ntVerifyEvent } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  computeEventId,
  serializeEvent,
  signEvent,
  verifyEvent,
} from '../src/domain/nostr/event.ts';
import { newIdentity, note } from './support/fixtures.ts';

describe('evento NIP-01: serialización, id y firma', () => {
  const id = newIdentity();
  const template = {
    kind: 1,
    created_at: 1_700_000_000,
    tags: [
      ['t', 'precintum'],
      ['client', 'precintum'],
    ],
    content: 'hola "mundo" \n con saltos y ñ',
  };

  it('serializa exactamente como manda NIP-01', () => {
    const s = serializeEvent({ ...template, pubkey: id.pubkey });
    const expected = `[0,"${id.pubkey}",1700000000,1,[["t","precintum"],["client","precintum"]],"hola \\"mundo\\" \\n con saltos y ñ"]`;
    expect(s).toBe(expected);
  });

  it('el id es determinista: mismo contenido, mismo id', () => {
    const a = computeEventId({ ...template, pubkey: id.pubkey });
    const b = computeEventId({ ...template, pubkey: id.pubkey });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('id y firma coinciden con nostr-tools (oráculo)', () => {
    const ours = signEvent(template, id);
    const theirs = finalizeEvent(structuredClone(template), id.secretKey);
    expect(ours.id).toBe(theirs.id);
    // Schnorr BIP-340 usa un nonce auxiliar aleatorio: las firmas difieren, pero ambas verifican.
    expect(ntVerifyEvent(ours)).toBe(true);
    expect(verifyEvent(theirs)).toEqual({ ok: true });
  });

  it('detecta manipulación del contenido', () => {
    const e = note(id, 'original');
    const tampered = { ...e, content: 'alterado' };
    expect(verifyEvent(tampered)).toEqual({
      ok: false,
      reason: 'el id no coincide con el contenido',
    });
  });

  it('detecta manipulación del id (id recalculado pero firma antigua)', () => {
    const e = note(id, 'original');
    const changed = { ...e, content: 'alterado' };
    const withNewId = { ...changed, id: computeEventId(changed) };
    expect(verifyEvent(withNewId)).toEqual({ ok: false, reason: 'firma inválida' });
  });

  it('detecta suplantación de autor', () => {
    const e = note(id, 'mío');
    const other = newIdentity();
    const forged = { ...e, pubkey: other.pubkey };
    expect(verifyEvent(forged).ok).toBe(false);
  });

  it('rechaza estructuras que no son eventos', () => {
    expect(verifyEvent(null).ok).toBe(false);
    expect(verifyEvent({ id: 'x' }).ok).toBe(false);
    expect(verifyEvent({ ...note(id, 'a'), tags: [[1]] }).ok).toBe(false);
  });
});
