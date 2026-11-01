# Security policy

Precintum is an evidence layer: its whole value is that a third party can detect tampering. A
vulnerability that lets an operator, an attacker with the agent key, or a hostile package defeat
the verifier is the most serious kind of bug this project can have. Please report it.

## Reporting a vulnerability

- Use **GitHub's private vulnerability reporting** ("Report a vulnerability" under the Security tab
  of this repository).
- Include what you found, how to reproduce it, and which promise it breaks (integrity,
  completeness, time, signer identity, privacy of the receipts, or the verifier itself).
- Do not open a public issue for a vulnerability that could let evidence be forged or altered
  without detection.

This is a single-maintainer project without a bug bounty. You will get an acknowledgement within
seven days and an estimate of the fix time. Credit is given in the changelog unless you
prefer otherwise.

## Scope

- The agent (receipts, chain, batches, witnesses, RFC 3161 and OpenTimestamps clients, export), its
  CLI and the read-only operations panel.
- `web/verificador.html` and its sources in `web/verify/src/`: the browser verifier, including its
  own SHA-256 and BIP-340 implementations.
- The evidence package format (`precintum/export/v1`) and the Nostr event formats (kinds `7676` and
  `37676`).

Out of scope: the third-party services the agent talks to (relays, time-stamping authorities,
OpenTimestamps calendars, the EUDI verifier).

## What is already known

The project publishes its own limits. Before reporting, check the threat model with the status of
each mitigation in `docs/AMENAZAS.md` (in Spanish for now): integrity and completeness of what was
recorded are proven; coverage (that everything was recorded) is not.

## Supported versions

There is no stable release yet. Security fixes land on `main`.
