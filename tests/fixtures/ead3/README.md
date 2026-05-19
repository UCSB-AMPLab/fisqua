# EAD3 RelaxNG Schema (Vendored)

Compiled, single-file RelaxNG grammar for **Encoded Archival Description 3**
used by the EAD3 emission tests — the schema-load smoke guard plus the
per-fonds RNG validation suite both consume this fixture.

## Source

- **Upstream repo:** [`SAA-SDT/EAD3`](https://github.com/SAA-SDT/EAD3) — the
  Society of American Archivists' Standards Development Team is the
  canonical maintainer of EAD3 since the 2015 LoC handover.
- **Source URL:** `https://raw.githubusercontent.com/SAA-SDT/EAD3/master/ead3.rng`
- **Last upstream commit touching `ead3.rng`:** `78998dff` (2019-12-13;
  "bump the date for next week"). EAD3 is a stable, slowly evolving standard
  — that commit predates the v1.1.1 GA tag and matches the grammar shipped
  with the v1.1.2-beta line. There is no v1.1.x compiled-grammar drift
  between the master HEAD and the most recent tagged release.
- **Vendored on:** 2026-05-04
- **SHA-256:** `35a2ef1488a5adc9f16fc037c0d0cb5d440f7ca1c5af2d5c09fd733e0e070d74`
- **Size:** 88,353 bytes
- **License:** Creative Commons (see `SAA-SDT/EAD3/LICENSE`).

## Why a single compiled file

`xmllint-wasm` does not resolve transitive RelaxNG `<include>` directives
through a bundle host that the test harness can intercept. A self-contained
compiled grammar avoids the failure mode where validation silently
succeeds because a referenced sub-grammar failed to load (a known
xmllint-wasm silent-failure mode).
The smoke guard in `tests/export/ead/schema-load-guard.test.ts` asserts
that `<not-ead/>` is rejected; if that test ever goes green for the wrong
reasons (e.g. the schema string was empty), the assertion in the second
`it()` block — minimum size and the literal `<grammar` substring — is the
canary.

`grep -c "<include" tests/fixtures/ead3/ead3.rng` returns 0; if a future
upstream refactor splits the grammar into modules, refresh by re-fetching
the canonical compiled output (or, if upstream stops publishing one,
flatten via `trang` locally before vendoring).

## Refresh procedure

```bash
curl -sSL https://raw.githubusercontent.com/SAA-SDT/EAD3/master/ead3.rng \
  -o tests/fixtures/ead3/ead3.rng

# Sanity checks (must all pass):
test "$(wc -c < tests/fixtures/ead3/ead3.rng)" -gt 80000
grep -c "<include" tests/fixtures/ead3/ead3.rng | grep -qx 0
grep -c "<grammar" tests/fixtures/ead3/ead3.rng | awk '$1 > 0 {exit 0} {exit 1}'

# Update the SHA-256 + commit ref above, then run the schema-load smoke guard:
npx vitest run tests/export/ead/schema-load-guard.test.ts
```

If the canonical SAA-SDT URL changes (e.g. the repo is renamed back to
LoC), update the source URL in this file and in the smoke-guard test's
header. Do not vendor the `.rnc` (compact) source — `xmllint` only
consumes the XML form.
