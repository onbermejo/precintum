/**
 * Identidad del agente para la CLI. Los comandos que firman (run, batch close, witness run,
 * ping…) necesitan la clave privada. Los de solo lectura (serve, whoami) se conforman con
 * el npub: así el panel puede correr en una máquina que no guarda el nsec.
 */
import {
  type Identity,
  identityFromSecretKey,
  npubDecode,
  npubEncode,
  nsecDecode,
} from '../domain/identity/keys.ts';
import type { Config } from '../shared/config.ts';

export interface PublicIdentity {
  pubkey: string;
  npub: string;
  /** true cuando el proceso tiene la clave privada (puede firmar). */
  canSign: boolean;
}

/** Clave privada obligatoria. */
export function requireSigner(cfg: Config): Identity {
  if (!cfg.PRECINTUM_NSEC) throw new Error('falta PRECINTUM_NSEC (usa: pnpm precintum keygen)');
  const id = identityFromSecretKey(nsecDecode(cfg.PRECINTUM_NSEC));
  checkNpubMatches(cfg, id.pubkey);
  return id;
}

/** Con PRECINTUM_NSEC o, para solo lectura, con PRECINTUM_NPUB. */
export function resolvePublicIdentity(cfg: Config): PublicIdentity {
  if (cfg.PRECINTUM_NSEC) {
    const id = identityFromSecretKey(nsecDecode(cfg.PRECINTUM_NSEC));
    checkNpubMatches(cfg, id.pubkey);
    return { pubkey: id.pubkey, npub: npubEncode(id.pubkey), canSign: true };
  }
  if (cfg.PRECINTUM_NPUB) {
    const pubkey = npubDecode(cfg.PRECINTUM_NPUB);
    return { pubkey, npub: cfg.PRECINTUM_NPUB, canSign: false };
  }
  throw new Error(
    'falta PRECINTUM_NSEC (usa: pnpm precintum keygen); para solo lectura basta PRECINTUM_NPUB',
  );
}

function checkNpubMatches(cfg: Config, pubkey: string): void {
  if (cfg.PRECINTUM_NPUB && npubDecode(cfg.PRECINTUM_NPUB) !== pubkey) {
    throw new Error('PRECINTUM_NPUB no corresponde a PRECINTUM_NSEC: revisa el .env');
  }
}
