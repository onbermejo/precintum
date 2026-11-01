import type { Identity } from '../../domain/identity/keys.ts';
import type { Logger } from '../../shared/logger.ts';
import { RelayClient, type RelayClientOptions } from './relay-client.ts';

/** Un cliente por URL, con las mismas opciones. Cierra todos con `closeAll`. */
export function createRelayClients(
  urls: readonly string[],
  opts: RelayClientOptions & { identity?: Identity; logger?: Logger } = {},
): RelayClient[] {
  return urls.map((url) => new RelayClient(url, opts));
}

export function closeAll(clients: readonly RelayClient[]): void {
  for (const c of clients) c.close();
}
