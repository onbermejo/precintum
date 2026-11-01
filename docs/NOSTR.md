# What other Nostr applications can reuse from Precintum, and how

> Status: 2026-09-23. Precintum is a privacy-preserving evidence layer; Nostr relays are its witness
> transport. Along the way we built a set of Nostr pieces that are independent of the evidence use case
> and that any application which publishes events that must **survive their author** (registries,
> transparency logs, attestations, audit trails) can reuse. This document lists them, says what is
> different about each one, where the code and tests live, and how to reuse them today. Nothing here is
> packaged on npm yet; see "Roadmap".

## The problem these pieces solve

Nostr gives you signed events and relays that store and serve them. It does **not** give you:

- a guarantee that a relay keeps what it accepted (no retention policy is part of the protocol);
- a way to prove to a third party that an event was published when you say it was (the relay's `OK`
  is not signed and `created_at` is chosen by the author; relays accept timestamps years in the past);
- protection against the author's own deletion requests (NIP-09 `kind 5`), which for an evidence use
  case is an attack, not a feature;
- a small verifier that a third party can run without trusting the application.

Precintum treats every one of these as a design constraint and the code below is the result.

## Reusable pieces

### 1. Relay client that keeps per-relay receipts

`src/infra/relay/relay-client.ts` (+ `relay-pool.ts`), on Node's global WebSocket (Node >= 24.12, see `engines` in `package.json`).

- Returns the `["OK", id, accepted, message]` of **each** relay with our local receive time, as
  telemetry per witness. It is deliberately typed as telemetry, not evidence.
- Typed errors per relay (`RelayError` with a code and the relay's literal message in `detail`), so
  the caller can classify failures and decide whether to retry.
- Explicit timeouts, reconnection, and tolerance to garbage: every incoming message is validated with
  zod (`src/domain/nostr/protocol.ts`), and every event received is re-verified (id and signature)
  before it is trusted. A relay is treated as an untrusted third party.
- NIP-42 authentication built in: on an `AUTH` challenge or an `auth-required:` rejection the client
  signs the ephemeral `kind 22242` event with the configured identity and retries once.
- Recognises `AUTH`, `COUNT` (NIP-45), `CLOSED`, `NOTICE` and NIP-67 `EOSE` hints instead of dropping
  them as unknown messages.
- Why not `SimplePool` from nostr-tools: it hides exactly the per-relay detail we need. nostr-tools is
  used only as an oracle in tests (cross-check of ids and signatures), never in production code.

Tests: `test/relay-client.test.ts`, `test/relay-auth.test.ts`, `test/protocol.test.ts`,
`test/relay-public.it.test.ts` (integration against public relays).

### 2. Event and protocol domain

`src/domain/nostr/event.ts`, `src/domain/nostr/protocol.ts`, `src/domain/identity/keys.ts`.

NIP-01 canonical serialisation, id computation, Schnorr BIP-340 signing and full verification (shape
+ recomputed id + signature) on `@noble/curves` and `@noble/hashes`; filter type and matching; zod
schemas for every relay message. Small, dependency-light, and checked against nostr-tools and the
official BIP-340 vectors in `test/event.test.ts`, `test/identity.test.ts`, `test/keys.test.ts`.

### 3. Multi-relay witness layer: outbox, quorum, backoff, telemetry

`src/application/witness-service.ts`, `src/domain/witness/policy.ts`,
`src/domain/witness/witness-store.ts`, `src/infra/db/sql-witness-store.ts`,
`src/infra/witness/append-only-file.ts`.

- **Persistent outbox**: `enqueue(event)` archives the event locally and queues it; `runOnce(now)`
  publishes only to the relays that have not accepted it yet.
- **N-of-M quorum** (`quorumMet`), **failure classification** by the standardised `OK` prefixes
  (`classifyFailure`: retry vs final), **exponential backoff with jitter** (`backoffSeconds`).
- **Per-relay publication log** (accepted / rejected / timed out, with the relay's message) and
  **alerts** when an entry fails for good.
- **Append-only local archive** with a hash chain and a `verify()` that reports the first altered
  line: a witness the operator controls, next to the ones it does not.
- Storage is behind small ports (`OutboxStore`, `PublicationLog`, `CheckLog`, `AlertLog`,
  `WitnessRelay`), so the SQL adapter can be swapped for anything.

The whole layer is agnostic to what the event means: any app can put its events through it.

Tests: `test/witness-service.test.ts` (three in-memory relays: well-behaved, flaky, hostile),
`test/witness-policy.test.ts`, `test/append-only-file.test.ts`.

### 4. Deferred verification: "accepted" is not "still serves it"

`src/application/witness-verifier.ts`.

- `checkPresence`: one `REQ` by id per relay, later, with three outcomes: **present**, **absent** (the
  relay answered and does not have it) and **unreachable** (no answer: says nothing about retention).
  An alert is raised only when a relay that accepted the event now says it does not have it.
- `detectDeletions`: searches `kind 5` events signed by the agent key, by an optional root key, and
  those addressing a parameterised-replaceable event through the `#a` tag. For an evidence use case a
  self-signed deletion request is treated as an incident (stolen key or dishonest operator), never as
  a legitimate order. The operator's private relay is configured to refuse `kind 5` altogether
  (`precintum relay init` writes a hardened nostr-rs-relay config).

Tests: `test/witness-service.test.ts`, `test/relay-init.test.ts`, `test/relay-local.it.test.ts`.

### 5. An in-memory relay for deterministic and hostile tests

`test/support/mini-relay.ts`.

Implements the NIP-01 subset a client needs (`EVENT`/`REQ`/`CLOSE` → `OK`/`EVENT`/`EOSE`/`CLOSED`/
`NOTICE`) and optionally NIP-42 `AUTH`, and lets a test **misbehave on purpose**: reject events, require
authentication, block kinds, send garbage frames, drop the connection. It makes the whole suite run
without network and lets you test the paths that only happen when a relay is hostile. Depends on `ws`.

### 6. Two open event kinds and their format

`docs/FORMATO-v1.md` §3-4; `src/domain/evidence/batch-event.ts`, `key-directory.ts`.

- `kind 7676` (regular): a **batch event** whose `content` is a Merkle root and whose tags carry a
  sequence number, the previous root, a time window, a policy hash and a salted count commitment. One
  event per fixed window, also when empty (heartbeat). Strict parser: duplicate format tags,
  malformed `window` or a `created_at` earlier than the window end are rejected.
- `kind 37676` (addressable, `d = "precintum/keys"`): a **key directory** signed by an offline root key
  with validity windows per agent key; a verifier accepts an event only if its key was valid at its
  `created_at`.

Both kinds were free on the default relays and in `registry-of-kinds` on 2026-09-05 (the earlier
`4646` collided with a test project and was dropped). The format is specified with test vectors fixed
by `test/format-vectors.test.ts` and regenerated with `pnpm vectors`. A NIP will be proposed only if
a second independent implementation appears; until then the specification and the kind registration
are the deliverable.

### 7. OpenTimestamps client implemented from the format

`src/infra/ots/ots.ts`, `src/infra/ots/ots-client.ts`.

Operations, attestations, `.ots` serialisation and deserialisation, calendar submit and `upgrade`,
merging of timestamps, `verifyBitcoin` (walks the proof to the block's Merkle root). No dependency on
the `opentimestamps` npm package (it drags a deprecated HTTP client and a full Bitcoin library).

Why a Nostr app cares: NIP-03 (`kind 1040`) is marked *unrecommended* in the NIPs index. This client
lets you anchor a Nostr event **id** in Bitcoin and keep the proof with your own data, without
`kind 1040`. Tests: `test/ots.test.ts`, `test/anchors.it.test.ts` (against a real public calendar).

### 8. Browser-side verification of signed events without dependencies

`web/verify/src/10-crypto.js` and `11-checks.js`, assembled into `web/verificador.html` (the `web/`
folder lives at the product repository root, next to `src/`).

SHA-256 and Schnorr BIP-340 in plain JavaScript, no libraries, no network (`connect-src 'none'`),
Content-Security-Policy by script hashes. The server cross-checks the browser crypto against
`@noble` on every run (`test/web-verifier.test.ts`, `test/web-example.test.ts`). Reusable by any page
that needs to verify a Nostr event offline in front of a non-technical user.

### 9. Empirical findings about relays (a small census)

Verified during development (September 2026):

- Relays accept `created_at` far in the past (strfry up to about three years; nostr-rs-relay without
  a lower limit by default). Consequence: an event's date proves nothing; Precintum needs an external
  time proof and a rule that ties the proof to the event's declared window.
- The relay `OK` is not signed and carries no relay time: it is telemetry for the operator, not
  evidence for a third party.
- NIP-42 identifies the connection; it does not authorise writes by itself. nostr-rs-relay's
  allow-list authorises by the **event's** pubkey and does not require `AUTH` to write.
- `relay.damus.io` was unreliable from a Node 24 client (2026-09-04) and was moved out of first
  position; the default set is now `nos.lol`, `relay.primal.net`, `relay.damus.io`,
  `nostr-pub.wellorder.net`, chosen for four different operators and two different relay
  implementations (strfry and nostr-rs-relay) to avoid a software monoculture among witnesses.
- Kind collisions happen even in "free" ranges: check the live relays and `registry-of-kinds`
  before picking one.

## How to reuse today

There is no npm package yet. Two options:

1. **Copy the files.** The pieces above have few internal dependencies: `shared/hex.ts`,
   `shared/http.ts` (fetch with timeout), `shared/logger.ts` (pino) and the domain files they import.
   Runtime dependencies: `@noble/curves`, `@noble/hashes`, `@scure/base`, `zod`, `pino`; `ws` only for
   the in-memory relay in tests. Node >= 24.12 with native TypeScript type stripping (`.ts` imports).
2. **Vendor the repository** (`git subtree` or a submodule) and import from `src/`.

Licence: Apache-2.0 for code, CC BY 4.0 for documents. The architecture decision
records (`docs/adr/`) explain the main design decisions.

## Roadmap for reuse

1. Extract the **witness layer** (client, outbox, quorum, presence and deletion checks, in-memory
   relay) as a standalone package with English documentation and its own test suite.
2. Extract the **OpenTimestamps client** as a standalone package.
3. Publish the **relay census** as a repeatable script: software and operator per relay, NIP-11
   limits, empirical retention at +1 h / +24 h / +7 d, behaviour on `kind 5`.
4. Register `7676` and `37676` in `registry-of-kinds`; publish the format; propose a NIP only if a
   second implementation appears.
5. Ship the **independent verifier** as a CLI with the same core as the browser page.

## What Precintum does not do (so nobody looks for it here)

No NIP-65 outbox model (our outbox is transactional, not a relay-hint list), no DMs (NIP-17/44/59), no
NIP-05, no zaps, no NIP-46 signer, no media (NIP-96/Blossom): none of them is needed to record or verify
evidence.
