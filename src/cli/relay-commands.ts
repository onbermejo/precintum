/**
 * Relay privado del operador (nostr-rs-relay en Docker).
 *
 * `relay init` escribe deploy/relay/config.toml con la pubkey del agente en la allowlist,
 * NIP-42 activado y el kind 5 (borrados NIP-09) bloqueado. Después:
 *   docker compose -f deploy/relay/docker-compose.yml up -d
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { npubEncode } from '../domain/identity/keys.ts';
import type { Config } from '../shared/config.ts';
import { requireSigner } from './identity.ts';

export const RELAY_DIR = join('deploy', 'relay');
export const RELAY_LOCAL_URL = 'ws://127.0.0.1:7000';

export function renderRelayConfig(agentPubkeyHex: string, relayUrl = RELAY_LOCAL_URL): string {
  return `# Generado por \`pnpm precintum relay init\`. Relay privado de Precintum (nostr-rs-relay).
# Solo acepta eventos del agente, exige NIP-42 y rechaza borrados (kind 5).

[info]
relay_url = "${relayUrl}/"
name = "precintum-relay-privado"
description = "Relay privado del Evidence Agent de Precintum. Solo escribe el agente; nunca borra."
pubkey = "${agentPubkeyHex}"

[database]
engine = "sqlite"
data_directory = "/usr/src/app/db"

[network]
address = "0.0.0.0"
port = 8080

[options]
# Rechaza eventos con created_at más de 15 minutos en el futuro.
reject_future_seconds = 900

[limits]
messages_per_sec = 20
max_event_bytes = 65536
# NIP-09: un relay testigo no debe borrar. Un kind 5 del propio agente es un ataque, no una orden.
event_kind_blacklist = [5]
limit_scrapers = false

[authorization]
# Solo la clave del agente puede escribir.
pubkey_whitelist = ["${agentPubkeyHex}"]
# NIP-42: el relay envía un challenge y exige AUTH antes de aceptar eventos.
nip42_auth = true
`;
}

export function renderCompose(): string {
  return `# Relay privado de Precintum: nostr-rs-relay con la configuración generada por \`pnpm precintum relay init\`.
# Uso: docker compose -f deploy/relay/docker-compose.yml up -d
services:
  relay:
    image: scsibug/nostr-rs-relay:latest
    container_name: precintum-relay
    restart: unless-stopped
    ports:
      - "127.0.0.1:7000:8080"
    volumes:
      - ./config.toml:/usr/src/app/config.toml:ro
      - relay-data:/usr/src/app/db
    environment:
      RUST_LOG: warn,nostr_rs_relay=info

volumes:
  relay-data:
`;
}

export async function cmdRelayInit(
  cfg: Config,
  root = process.cwd(),
  opts: { force?: boolean } = {},
): Promise<string> {
  const id = requireSigner(cfg);
  const dir = join(root, RELAY_DIR);
  await mkdir(dir, { recursive: true });
  // Sin --force no se pisa una configuración existente: puede llevar ajustes a mano del operador.
  const flag = opts.force ? 'w' : 'wx';
  try {
    await writeFile(join(dir, 'config.toml'), renderRelayConfig(id.pubkey), {
      encoding: 'utf8',
      flag,
    });
    await writeFile(join(dir, 'docker-compose.yml'), renderCompose(), { encoding: 'utf8', flag });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${RELAY_DIR}/ ya tiene configuración; usa --force para regenerarla`);
    }
    throw err;
  }
  console.log(`configuración escrita en ${RELAY_DIR}/`);
  console.log(`agente autorizado: ${npubEncode(id.pubkey)}`);
  console.log(`arranque: docker compose -f ${RELAY_DIR}/docker-compose.yml up -d`);
  console.log(`prueba:   pnpm precintum ping ${RELAY_LOCAL_URL}`);
  return dir;
}
