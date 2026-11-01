# Changelog

## 0.1.0 · 2026-11-01 · public prototype

Initial public prototype. The repository and browser demos are available. The prototype contains:

- Hash-chained receipts of eight fields without personal identifiers (`docs/FORMATO-v1.md` §1).
- Ingest endpoint `POST /receipts` with a closed-schema quarantine, version-style labels only,
  idempotency by transaction (HMAC with a 24-hour TTL) and 409 when a transaction comes back with
  another result.
- Hourly batches with heartbeats, RFC 6962 Merkle roots and salted count commitments, signed as
  Nostr events (`kind 7676`). The key-directory format and domain helpers (`kind 37676`) exist;
  operational publication and its integration into package verification are still planned.
- Witnesses: transactional outbox, quorum over public relays, presence checks with three outcomes,
  detection of deletion requests (NIP-09), append-only local archive.
- RFC 3161 and OpenTimestamps clients, with timestamp-imprint and anchoring-window checks. CMS trust
  validation and checking the proof against a Bitcoin block require external tools.
- Export of an evidence package by date range and an independent verifier (server and a
  single-file browser page with its own cryptography).
- Read-only operations panel, `precintum run` as a single process, `pnpm demo`, example packages.
- Format specification with test vectors and a threat model with the status of each mitigation.
- Stability and validation fixes for malformed HTTP requests, startup health, time evidence, relay
  quorum, configured identity and export ranges, plus a security update to the validation dependency.
- Failed `run` and `serve` startup now releases acquired resources. Concurrent batch closure does not
  extend an export already being read. URLs shown by the CLI, panel and diagnostics redact credentials.
- Calendar URLs are checked before requests and parsed consistently in both verifiers. Standalone
  panel demos use embedded data directly, and the page-hash manifest can be checked from `web/`.
- Automated tests without external services, plus opt-in integration tests against real relays, a TSA
  and a calendar.
