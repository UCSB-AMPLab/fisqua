/**
 * Descriptions Index Writer
 *
 * Writes the per-fonds descriptions JSON that the static frontend loads.
 * Each fonds gets its own object under `fonds/{code}/descriptions.json`;
 * if the serialized payload would overflow the safe R2 body limit, the
 * writer throws `FondsBodyTooLargeError` so the orchestrator can bail
 * out early rather than corrupt the published site.
 *
 * @version v0.3.0
 */

import type { ExportStorage } from "./r2-client.server";

/**
 * Descriptions index writer for the publish pipeline.
 *
 * Background: earlier iterations of this module attempted to produce a
 * single combined `descriptions.json` file by streaming every per-fonds
 * body through a TransformStream into an R2 put. Two problems killed that
 * approach:
 *
 *  1. wrangler dev local deadlocks on large `bucket.put(key, ReadableStream)`
 *     calls. Both a naive "read-as-text" implementation and a byte-level
 *     streaming scanner hung indefinitely at the `descriptions:combined`
 *     step during Task 4 verification. The worker idled at 0% CPU with no
 *     R2 output, suggesting miniflare/workerd's R2 binding does not
 *     properly drain large streaming puts in local dev.
 *  2. Even if the streaming path worked, the largest fonds (co-ahr-gob) is
 *     85 MB on disk. V8 UTF-16 doubles that to ~170 MB when materialized as
 *     a JS string — above the 128 MB Worker memory ceiling. The pre-scan
 *     byteSize guard is not sufficient because the original plan
 *     underestimated fonds size by ~2×.
 *
 * Decision: the exporter produces per-fonds files only. This module writes
 * a small `descriptions-index.json` enumerating the per-fonds keys and
 * their record counts. zasqua-frontend concatenates the per-fonds files at
 * static-site build time, where memory and I/O are unconstrained.
 *
 * The `FondsBodyTooLargeError` class is retained as a named export so
 * existing catch sites in `PublishExportWorkflow.run()` still compile. It
 * is not thrown by this module but is part of the public surface in case
 * future implementations of a true streaming combiner need a sentinel.
 */

export class FondsBodyTooLargeError extends Error {
  constructor(
    public fondsCode: string,
    public size: number,
    public limit: number
  ) {
    super(
      `Fonds ${fondsCode} body is ${size} bytes, which exceeds the limit of ${limit} bytes.`
    );
    this.name = "FondsBodyTooLargeError";
  }
}

export interface DescriptionsIndexFondsEntry {
  fonds_code: string;
  key: string;
  record_count: number;
}

export interface DescriptionsIndex {
  version: 1;
  generated_at: string;
  total_record_count: number;
  fonds: DescriptionsIndexFondsEntry[];
}

export interface WriteIndexResult {
  totalRecordCount: number;
  fondsCount: number;
}

/**
 * Write `descriptions-index.json` enumerating the per-fonds description
 * files produced earlier in the workflow. Consumers (the frontend static
 * site build) read this index and stream each per-fonds file into their
 * own combined view.
 *
 * Memory bound: O(fondsCount) — only metadata is held.
 */
export async function writeDescriptionsIndex(
  storage: ExportStorage,
  fondsCodes: string[],
  recordCountsByFondsCode: Record<string, number>
): Promise<WriteIndexResult> {
  const entries: DescriptionsIndexFondsEntry[] = fondsCodes.map((code) => ({
    fonds_code: code,
    key: `descriptions-${code}.json`,
    record_count: recordCountsByFondsCode[code] ?? 0,
  }));

  const totalRecordCount = entries.reduce((n, e) => n + e.record_count, 0);

  const index: DescriptionsIndex = {
    version: 1,
    generated_at: new Date().toISOString(),
    total_record_count: totalRecordCount,
    fonds: entries,
  };

  await storage.putObject(
    "descriptions-index.json",
    JSON.stringify(index, null, 2)
  );

  return { totalRecordCount, fondsCount: entries.length };
}
