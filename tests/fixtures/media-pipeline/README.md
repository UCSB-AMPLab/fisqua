# Media pipeline fixtures

JSON documents for the media pipeline tests. They hold test values only:
no real tenant, bucket, endpoint, digest or credential. The run spec and
the callback bodies are closed objects, so these files cannot carry a
header of their own; this note stands in for one.

## Run specs

Validated by `tests/media-pipeline/run-spec.test.ts`. In the Node pool,
`tests/media-pipeline-node/run-spec-schema.test.ts` checks that the JSON
Schema (through Ajv) and the Zod schema give each of them the same
verdict.

- `spec-valid.json`: a volume run of one 734-page volume, with every page
  listed.
- `spec-valid-item-pdf.json`: one item PDF of two pages, with the fixed
  item-PDF recipe (tonal output, OCR from the PDF's text layer).
- `spec-valid-small.json`: the same volume run cut to three pages. Every
  `spec-invalid-*.json` file is this document with one property changed.
- `spec-invalid-<name>.json`: schema violations (a tag instead of a
  digest, an unknown key, a bad page key, and so on).
- `spec-invalid-cross-<name>.json`: documents the schema accepts but the
  cross-field checks refuse (page count, `seq` order, repeated page keys,
  overrides naming unlisted pages, job membership, master keys outside
  the source prefix, the wrong page or source shape for the run kind).
  `cross-item-pdf-master-key` is derived from the item-PDF fixture.
- `spec-valid-review-run.json`: a review run of the small fixture's
  volume, its pages with digests, under one review prefix, with the
  review bucket and its download address.
- `spec-valid-review-purge.json`: a purge run naming two review
  prefixes. Fisqua does not start purge runs; the fixture checks that
  the validator and the schema agree on the kind.
- `spec-valid-volume-review-purge.json`: the small volume run with a
  review block and two review prefixes to purge.
- `spec-invalid-review-<name>.json`: review documents with one schema
  violation (no download address, a page without a digest, a bad
  prefix, a purge without a review block, an endpoint or bucket the
  rules for review fields refuse, an R2 review bucket).
- `spec-invalid-cross-review-<name>.json`: review documents the schema
  accepts and the cross-field checks refuse (a review bucket that is
  also another bucket of the run, a prefix named twice, a purge on an
  item PDF).

Every endpoint in the review fixtures is on `s3.test-000.backblazeb2.com`,
which has the form of a B2 host and names no real region.

## Callback bodies

Validated by `tests/media-pipeline/callback-body.test.ts`, which makes
each rejecting case as a named change to one of these.

- `callback-prepared.json`: the documented per-volume report for a
  volume that reached Prepared with no flags.
- `callback-review-pending.json`: the same with one open flag.
- `callback-refused.json`: the body the runner sends for a volume it
  refused before any work (class `spec`, every stage `not_reached`,
  `qc`, `verification` null and an empty `runner`).
- `callback-chunk-complete.json`: the documented chunk-complete report.

Version: v0.8.0
