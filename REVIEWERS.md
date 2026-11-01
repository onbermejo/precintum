# Reviewer's guide

Precintum is a **prototype**: working code and tests, no deployments or users yet. This page offers a
short browser walkthrough and local checks, and tells you where each idea lives in the code. The
local checks take longer on machines with limited resources.

Publication is pending. The walkthrough below uses the files in the local copy.

## Browser walkthrough, nothing to install

1. From the local copy, open **[web/verificador.html](web/verificador.html)** in a browser.
   It is a single HTML file with its own cryptography; nothing leaves your browser.
2. Click **Load example package**. All eight integrity checks pass, including reading the time-stamp
   token and the Bitcoin anchor file. **What this tool cannot verify** explains that authenticating
   the time-stamp signature and the Bitcoin anchor requires external tools such as DSS and a Bitcoin
   node.
3. Download **[examples/package-tampered.json](examples/package-tampered.json)**, the same package with
   one receipt changed from `under_18` to `over_18`, and drop it on the page: **Verification failed**,
   pointing at the batch whose Merkle root no longer matches the root that was published.

## Local checks, with Node 24 and pnpm

Open a terminal in the product directory and run:

```bash
pnpm install
pnpm check      # typecheck, lint and the whole test suite, without external services
pnpm demo       # narrated run of the whole cycle, offline
pnpm vectors    # the test vectors of the format specification, printed from the code
```

`pnpm demo` shows, in order: two verifications recorded (201), one with personal data rejected (400,
nothing stored or logged), the same transaction with another result rejected (409); the hour closed as
a batch with a Merkle root, a signed Nostr event, a time-stamp and a Bitcoin anchor (simulated, because
the demo is offline); two relays in memory accepting the event and serving it back; the evidence package
verified from scratch; and the same package, with one receipt edited, failing. It leaves both files in
the current folder for the browser verifier.

With network, `pnpm test:it` runs the integration tests against real relays, a time-stamping authority
and an OpenTimestamps calendar.

On Windows, `pnpm check` automatically uses one test worker and a 90-second per-test timeout to allow
for cold PGlite and CLI startup. Other platforms keep the normal worker count and 15-second timeout;
the Linux CI workflow uses those defaults.

`web/HASHES.txt` lists SHA-256 hashes with paths relative to `web/`. With `sha256sum` available:

```bash
cd web
sha256sum -c HASHES.txt
```

## Where things are

| Idea | Code | Tests | Specification (`docs/FORMATO-v1.md`) |
|---|---|---|---|
| Receipt: eight fields, no personal identifiers | `src/domain/evidence/receipt.ts` | `test/evidence-receipt.test.ts` | §1 |
| Hash chain | `src/domain/evidence/chain.ts` | `test/evidence-chain.test.ts` | §1.1 |
| Ingest and personal-data quarantine | `src/application/ingest.ts`, `src/infra/http/ingest-server.ts` | `test/ingest-server.test.ts` | Annex A |
| Hourly batches, heartbeats, salted count | `src/domain/evidence/batch.ts`, `src/application/batch-service.ts` | `test/batch.test.ts`, `test/batch-service.test.ts` | §2 |
| Merkle tree (RFC 6962) | `src/domain/evidence/merkle.ts` | `test/merkle.test.ts` | §2.2 |
| Batch event (`kind 7676`), key directory (`kind 37676`) | `src/domain/evidence/batch-event.ts`, `key-directory.ts` | `test/evidence-events.test.ts` | §3, §4 |
| Witnesses: outbox, quorum, presence, deletion requests | `src/application/witness-service.ts`, `witness-verifier.ts` | `test/witness-service.test.ts`, `test/witness-policy.test.ts` | — |
| Nostr client and protocol | `src/infra/relay/relay-client.ts`, `src/domain/nostr/` | `test/relay-client.test.ts`, `test/protocol.test.ts`, `test/event.test.ts` | — |
| RFC 3161 time-stamp | `src/infra/tsa/rfc3161.ts` | `test/rfc3161.test.ts` | §6 |
| OpenTimestamps (written from the format) | `src/infra/ots/ots.ts` | `test/ots.test.ts` | §6 |
| Evidence package and verifier | `src/application/export-service.ts`, `web/verify/src/11-checks.js` | `test/export-service.test.ts`, `test/verify-hardening.test.ts`, `test/web-verifier.test.ts` | §7 |
| Append-only local archive | `src/infra/witness/append-only-file.ts` | `test/append-only-file.test.ts` | §5 |

Documents: `docs/FORMATO-v1.md` (format and vectors) and `docs/AMENAZAS.md` (threat model with the status
of each mitigation) are in Spanish for now; `docs/NOSTR.md` (how Precintum uses Nostr) is in English;
`docs/adr/` records the design decisions.

## What exists and what is still to do

Exists today: receipts and chain, ingest with quarantine, hourly batches with heartbeats, four public
relays as witnesses with quorum and deletion detection, RFC 3161 and OpenTimestamps clients, export by
date range, the browser verifier, a read-only operations panel, the format specification with vectors
and the threat model.

Not yet, and planned: the adapter for the EU reference verifier, the command-line verifier and the
English specification, validation of the time-stamp's CMS signature with DSS, the operational key
directory, time proofs published on relays, RFC 4998 evidence records, packaging, a transparency-log
witness, accessibility work and pilots.

The test suite cross-checks the cryptographic implementations against reference libraries and
official test vectors.

## Notes that save you time

- A metadata-fetch error such as `ERR_PNPM_META_FETCH_FAIL` can prevent installation. Resolve the
  reported fetch failure and check that installation succeeded before running the local checks.
- The first `pnpm precintum keygen --to-env .env` prints `.env not found. Continuing without it.`: that
  is Node saying the file did not exist yet, and it is the file being created. A second run refuses to
  overwrite it, and pnpm adds `ELIFECYCLE … exit code 1`: the refusal is intended.
- Windows PowerShell 5.1: run `chcp 65001` first, or accented characters in the log look garbled.
- `pnpm precintum run` keeps the local database open: stop it (Ctrl+C) before other commands that use
  it (`chain verify`, `batch status`, `export`).
- `export --from 2026-10-17 --to 2026-10-18` reads dates in local time; the package records the range
  in UTC.
- Most command-line and log messages are still in Spanish; the help (`pnpm precintum help`), the README,
  this guide and the demo are in English.
