/**
 * `precintum keygen [--to-env <ruta>]`: identidad nueva (nsec + npub), clave de deduplicación y
 * token de ingesta. Sin `--to-env` los imprime; con él los escribe en el fichero indicado (a partir
 * de .env.example si existe), con permisos 0600 y sin sacarlos por pantalla. Nunca sobrescribe.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  generateSecretKey,
  identityFromSecretKey,
  npubEncode,
  nsecEncode,
} from '../domain/identity/keys.ts';
import { bytesToHex } from '../shared/hex.ts';

export interface GeneratedSecrets {
  nsec: string;
  npub: string;
  pubkey: string;
  dedupKey: string;
  ingestToken: string;
}

export function generateSecrets(): GeneratedSecrets {
  const id = identityFromSecretKey(generateSecretKey());
  return {
    nsec: nsecEncode(id.secretKey),
    npub: npubEncode(id.pubkey),
    pubkey: id.pubkey,
    dedupKey: bytesToHex(randomBytes(32)),
    ingestToken: bytesToHex(randomBytes(24)),
  };
}

const MINIMAL_TEMPLATE = `# Generado por \`pnpm precintum keygen --to-env\`. Copia el resto de opciones de .env.example.
PRECINTUM_NSEC=
PRECINTUM_DEDUP_KEY=
PRECINTUM_INGEST_TOKEN=
`;

/** Rellena (o añade) las tres variables secretas en una plantilla .env. */
export function fillEnv(template: string, s: GeneratedSecrets): string {
  let out = template;
  for (const [name, value] of [
    ['PRECINTUM_NSEC', s.nsec],
    ['PRECINTUM_DEDUP_KEY', s.dedupKey],
    ['PRECINTUM_INGEST_TOKEN', s.ingestToken],
  ] as const) {
    const re = new RegExp(`^${name}=.*$`, 'm');
    out = re.test(out)
      ? out.replace(re, `${name}=${value}`)
      : `${out.replace(/\n?$/, '\n')}${name}=${value}\n`;
  }
  return out;
}

export async function cmdKeygen(toEnv: string | undefined): Promise<void> {
  const s = generateSecrets();
  if (toEnv === undefined) {
    console.log(`nsec: ${s.nsec}`);
    console.log(`npub: ${s.npub}`);
    console.log(`hex : ${s.pubkey}`);
    console.log(`\nPRECINTUM_DEDUP_KEY sugerida: ${s.dedupKey}`);
    console.log(`PRECINTUM_INGEST_TOKEN sugerido: ${s.ingestToken}`);
    console.log(
      'Guarda el nsec, la clave y el token en .env (o usa: keygen --to-env .env). No los compartas.',
    );
    return;
  }
  let template = MINIMAL_TEMPLATE;
  try {
    template = await readFile(join(dirname(toEnv), '.env.example'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    // 'wx': falla si el fichero existe. Un .env con una identidad en uso no se pisa nunca.
    await writeFile(toEnv, fillEnv(template, s), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `${toEnv} ya existe: no se sobrescribe. Bórralo o edítalo a mano si de verdad quieres otra identidad`,
      );
    }
    throw err;
  }
  console.log(`npub: ${s.npub}`);
  console.log(`hex : ${s.pubkey}`);
  console.log(
    `secretos escritos en ${toEnv} (nsec, PRECINTUM_DEDUP_KEY, PRECINTUM_INGEST_TOKEN); no se muestran por pantalla.`,
  );
}
