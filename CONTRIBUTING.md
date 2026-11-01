# Contributing

Thanks for looking. Precintum is developed in the open by a single maintainer, so the most useful
contributions are small, verifiable and well explained. Start with `REVIEWERS.md` for a tour.

## Running it

```bash
pnpm install
pnpm check          # typecheck + lint + tests, PGlite in memory, no network
pnpm demo           # narrated run of the whole cycle, offline
pnpm test:it        # integration tests against real relays, a TSA and an OpenTimestamps calendar
```

Node 24.12 or newer (native TypeScript type stripping, no build step) and pnpm 11. Docker is needed
only for the private relay test (`test/relay-local.it.test.ts`).

On Windows, the test configuration automatically uses one worker and a 90-second per-test timeout
for cold PGlite and CLI startup. The normal worker count and 15-second timeout apply elsewhere,
including Linux CI.

## Rules that matter here

- **A change to the evidence format is a design decision, not a patch.** Receipt fields, hash
  domains, the batch event, the key directory and the export package are specified in
  `docs/FORMATO-v1.md` and `docs/adr/`. Add an ADR before changing any of them, and bump the format
  version; never mutate an existing receipt or reinterpret an old package.
- **Nothing derived from the person goes into a receipt.** The tests on the receipt and on the ingest
  quarantine are the specification. If your change needs a new field, say in the ADR why it is not
  personal data for anyone.
- **The verifier believes nothing the operator wrote.** `verifyPackage` and the browser verifier
  recompute; they do not read verdicts from the package. Keep it that way.
- **Tests are the contract.** Every fix comes with the test that would have caught it. The browser
  verifier is cross-checked against the server on every run (`test/web-verifier.test.ts`); if you
  touch one side, the other must still agree.
- **The web pages are generated.** Edit the sources in `web/*/src/` and run `node web/build.mjs`;
  the CI checks that the generated pages match.
- **No operational secrets.** `.env` is ignored; operational keys, tokens and passwords must never
  enter the repository or its logs. Use clearly identified synthetic keys and credentials in tests.

## Languages

The README, `REVIEWERS.md`, command-line help and narrated terminal demo are in English. The
specification, threat model, ADRs, Nora walkthrough and most code comments are currently in Spanish;
English versions are planned. Either language is welcome in issues and pull requests.

## Commits

One change per commit, in the present tense, saying what changed and why it matters.

## Licences

Code is Apache-2.0 (`LICENSE`). Documents are CC BY 4.0 (`LICENSE-DOCS.md`). By contributing you
agree that your contribution is licensed the same way.
