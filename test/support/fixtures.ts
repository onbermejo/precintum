import {
  generateSecretKey,
  type Identity,
  identityFromSecretKey,
} from '../../src/domain/identity/keys.ts';
import {
  type EventTemplate,
  type NostrEvent,
  nowSeconds,
  signEvent,
} from '../../src/domain/nostr/event.ts';

export function newIdentity(): Identity {
  return identityFromSecretKey(generateSecretKey());
}

export function note(
  identity: Identity,
  content: string,
  extra: Partial<EventTemplate> = {},
): NostrEvent {
  return signEvent({ kind: 1, created_at: nowSeconds(), tags: [], content, ...extra }, identity);
}
