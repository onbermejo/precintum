# Precintum

**A tamper-evident record of age verifications without personal identifiers in the evidence.**

Each verification leaves a receipt of eight fields: a random nonce, the hashes of the policy and of the
verifier configuration, the result and the minute. Receipts are hash-chained. Hourly batches put a
32-byte Merkle root in a signed Nostr event for publication on configured relays. The event id is used
for TSA time-stamping (RFC 3161) and Bitcoin anchoring (OpenTimestamps). Anyone can independently
recompute the delivered evidence's hashes, commitments and signatures. Authenticating its time
evidence requires external validation. It proves the integrity of what the system recorded, not that
the verifications occurred or that everything was recorded.

**Status:** prototype. Working code and tests; no deployments or users yet.

**Maintainer:** [onbermejo](https://github.com/onbermejo).

**Browser demos:** [evidence verifier](https://onbermejo.github.io/precintum/web/verificador.html),
[interactive walkthrough](https://onbermejo.github.io/precintum/web/caso-nora.html),
[operations panel demo](https://onbermejo.github.io/precintum/web/panel-demo.html).

**Start here: [REVIEWERS.md](REVIEWERS.md)** for a short browser walkthrough and local checks with Node.

## Requirements

- Node >= 24.12 (TypeScript runs natively, no build step) and pnpm >= 11.
- Optional: PostgreSQL 18 (without configuration, PGlite stores everything in `./data/`) and Docker
  (for the operator's private relay).

## Quick start

```bash
pnpm install
pnpm demo                              # narrated run of the whole cycle, offline
pnpm precintum help                    # every command, one line each
pnpm precintum keygen --to-env .env    # identity, deduplication key and ingest token, written to .env
pnpm precintum whoami                  # agent npub and configuration, without secrets
pnpm precintum run                     # the agent: ingest (POST /receipts), scheduler, panel and /health
```

To use PostgreSQL instead of PGlite: `createdb precintum` and, in `.env`,
`PRECINTUM_DATABASE_URL=postgres://user:password@localhost:5432/precintum`.

The read-only panel (`pnpm precintum serve`) can run on a machine without the private key:
`PRECINTUM_NPUB` is enough. Commands that sign (`run`, `batch close`, `witness run`, `ping`,
`relay init`) need `PRECINTUM_NSEC`.

## Quality

```bash
pnpm check      # typecheck + lint + tests (PGlite in memory, no external services)
pnpm test:it    # integration tests only: real relays, TSA and OpenTimestamps calendar (needs network)
```

## Prototype limits

The EU reference-verifier adapter and the operational key-directory workflow are still planned.
The package verifiers check the timestamp's imprint and time and the structure of the OpenTimestamps
proof; authenticating the CMS signature and TSA certificate chain, and checking the Bitcoin proof
against a block, require external tools such as DSS and a Bitcoin node. The minute and result can
still be correlated with other records kept by the operator.

OpenTimestamps calendar URLs form part of shareable proofs. This prototype accepts HTTP(S) calendar
URLs without credentials, query parameters or fragments. Calendar URIs use the ASCII syntax of the
pending-proof reader; IPv6 literals, percent-encoded paths and token-bearing calendar URLs are not
supported by this prototype.

The examples use small evidence packages; capacity still needs load testing before a pilot with
real traffic. Pending-anchor counters in the operations panel are computed from at most 1,000 pending
batches, and alert statistics from at most 500 stored alerts: they can undercount larger backlogs.
Evidence-package totals are calculated separately and are not subject to those panel limits. Large
packages are verified synchronously in the browser and can make the tab unresponsive while checking.

## Structure

```
src/domain/        pure rules: identity, Nostr events and protocol, evidence (receipt, chain, batch, keys)
src/application/   use cases: ingest, batches, witnesses, export and package verification
src/infra/         adapters: relays, database (PGlite / PostgreSQL), TSA, OpenTimestamps, HTTP
src/cli/           command line
src/shared/        configuration (zod), logger (pino), utilities
test/              test suite; test/support/ holds an in-memory Nostr relay and fake anchors
scripts/           demo, format vectors, web example, panel demo
examples/          an example evidence package and the same package tampered with
web/               the browser verifier (single file, own cryptography)
docs/              format specification, threat model, Nostr usage, architecture decisions
```

`domain/` does not import from `infra/`. `nostr-tools` is used only in tests, as an oracle.

## Documents

- [`docs/FORMATO-v1.md`](docs/FORMATO-v1.md): format specification with test vectors (in Spanish for
  now).
- [`docs/AMENAZAS.md`](docs/AMENAZAS.md): threat model with the status of each mitigation (in Spanish
  for now).
- [`docs/NOSTR.md`](docs/NOSTR.md): how Precintum uses Nostr.
- [`docs/adr/`](docs/adr/): architecture decision records.

## Licence

Code under Apache-2.0 ([LICENSE](LICENSE)); documents under CC BY 4.0.
