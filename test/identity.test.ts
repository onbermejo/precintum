import { describe, expect, it } from 'vitest';
import { requireSigner, resolvePublicIdentity } from '../src/cli/identity.ts';
import { identityFromSecretKey, npubEncode, nsecDecode } from '../src/domain/identity/keys.ts';
import { loadConfig } from '../src/shared/config.ts';

const NSEC = 'nsec14xp65duezqmrrecsmkp9almsy0ueautah0hjt3rnuul4r8e8qgjshadpen';
const NPUB = npubEncode(identityFromSecretKey(nsecDecode(NSEC)).pubkey);
const OTRO_NPUB = npubEncode(
  identityFromSecretKey(
    nsecDecode('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5'),
  ).pubkey,
);

describe('identidad del agente en la CLI', () => {
  it('con PRECINTUM_NSEC puede firmar y deriva el npub', () => {
    const id = resolvePublicIdentity(loadConfig({ PRECINTUM_NSEC: NSEC }));
    expect(id).toEqual({
      pubkey: identityFromSecretKey(nsecDecode(NSEC)).pubkey,
      npub: NPUB,
      canSign: true,
    });
  });

  it('solo con PRECINTUM_NPUB vale para leer, no para firmar', () => {
    const cfg = loadConfig({ PRECINTUM_NPUB: NPUB });
    expect(resolvePublicIdentity(cfg)).toMatchObject({ npub: NPUB, canSign: false });
    expect(() => requireSigner(cfg)).toThrow(/falta PRECINTUM_NSEC/);
  });

  it('sin ninguna de las dos explica las dos opciones', () => {
    expect(() => resolvePublicIdentity(loadConfig({}))).toThrow(/PRECINTUM_NSEC.*PRECINTUM_NPUB/);
  });

  it('si el npub no corresponde al nsec, para en vez de operar con dos identidades', () => {
    const cfg = loadConfig({ PRECINTUM_NSEC: NSEC, PRECINTUM_NPUB: OTRO_NPUB });
    expect(() => resolvePublicIdentity(cfg)).toThrow(/no corresponde/);
    expect(() => requireSigner(cfg)).toThrow(/no corresponde/);
    expect(requireSigner(loadConfig({ PRECINTUM_NSEC: NSEC, PRECINTUM_NPUB: NPUB })).pubkey).toBe(
      identityFromSecretKey(nsecDecode(NSEC)).pubkey,
    );
  });
});
