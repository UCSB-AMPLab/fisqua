/**
 * Descriptions Index Writer
 *
 * This module deals with writing the per-fonds descriptions JSON
 * that the static frontend loads. Each fonds gets its own object
 * under `fonds/{code}/descriptions.json`;
 * if the serialized payload would overflow the safe R2 body limit, the
 * writer throws `FondsBodyTooLargeError` so the orchestrator can bail
 * out early rather than corrupt the published site.
 *
 * The index writer takes an `ExportTenant` so the index key
 * (`descriptions-index.json`) and the per-fonds entry keys it
 * enumerates both carry the active tenant's slug prefix. The index
 * file describes only the per-fonds JSON artefacts the pipeline
 * writes; it does not itself query D1.
 *
 * zasqua.org builds only the fonds the index lists, so the index lists
 * every published fonds of the publishing tenant that has a per-fonds
 * file, whichever fonds the run selected. The caller passes the
 * tenant's published fonds. A fonds the run selected takes the entry
 * and count the run computed; any other keeps the entry and count of
 * the stored index, as long as its per-fonds file is still in the
 * bucket. A fonds that is not published, or has no file, is left out.
 * When some published fonds were not selected and the stored index is
 * missing or cannot be parsed, the writer throws
 * `DescriptionsIndexUnreadableError`; when the stored index leaves out
 * an unselected published fonds whose file is in the bucket, it throws
 * `DescriptionsIndexMissingFondsError`, naming the fonds. Either way it
 * writes nothing, so a run cannot replace a full index with a partial
 * one. A run that selects
 * every published fonds builds the index without reading the stored
 * one.
 *
 * @version v0.9.0
 */

import type { ExportStorage } from "./r2-client.server";
import type { ExportTenant } from "./types";

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
 * their record counts. zasqua concatenates the per-fonds files at
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
 * The stored `descriptions-index.json` could not be read, so the entries
 * of the fonds the run did not select are unknown. The run fails rather
 * than write an index without them; a publish of every fonds rebuilds
 * the index.
 */
export class DescriptionsIndexUnreadableError extends Error {
  constructor(public key: string, public reason: string) {
    super(
      `The stored descriptions index ${key} ${reason}, so the entries of the fonds this publish did not select are unknown. ` +
        "The index was not written. Publish every fonds to rebuild it."
    );
    this.name = "DescriptionsIndexUnreadableError";
  }
}

/**
 * The stored `descriptions-index.json` leaves out published fonds whose
 * per-fonds files are in the bucket, so their record counts are
 * unknown. The run fails rather than leave them out of the index; a
 * full publish rebuilds it.
 */
export class DescriptionsIndexMissingFondsError extends Error {
  constructor(public key: string, public fondsCodes: string[]) {
    super(
      `The stored descriptions index ${key} does not list the published fonds ${fondsCodes.join(", ")}, ` +
        "whose files are in storage, so their record counts are unknown. " +
        "The index was not written. Run a full publish, of every fonds, to rebuild it."
    );
    this.name = "DescriptionsIndexMissingFondsError";
  }
}

/** The record count of each fonds the stored index lists, or the reason it cannot be read. */
async function readStoredCounts(
  storage: ExportStorage,
  key: string
): Promise<Map<string, number>> {
  const bytes = await storage.getObjectBytes(key);
  if (!bytes) throw new DescriptionsIndexUnreadableError(key, "is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DescriptionsIndexUnreadableError(key, "is not valid JSON");
  }
  const fonds = (parsed as { fonds?: unknown } | null)?.fonds;
  if (!Array.isArray(fonds)) {
    throw new DescriptionsIndexUnreadableError(key, "has no list of fonds");
  }
  const counts = new Map<string, number>();
  for (const entry of fonds) {
    const e = entry as Partial<DescriptionsIndexFondsEntry> | null;
    if (
      typeof e?.fonds_code !== "string" ||
      typeof e.record_count !== "number" ||
      !Number.isFinite(e.record_count)
    ) {
      throw new DescriptionsIndexUnreadableError(
        key,
        "has a fonds entry without a reference code or a record count"
      );
    }
    counts.set(e.fonds_code, e.record_count);
  }
  return counts;
}

/**
 * Write `descriptions-index.json` enumerating the per-fonds description
 * files of every published fonds of the tenant. Consumers (the frontend
 * static site build) read this index and stream each per-fonds file
 * into their own combined view.
 *
 * `fondsCodes` and `recordCountsByFondsCode` are the fonds this run
 * selected and the counts it computed; `publishedFonds` is every
 * published fonds of the tenant, in the order the index lists them.
 * Throws `DescriptionsIndexUnreadableError`, before writing anything,
 * when a published fonds was not selected and the stored index cannot
 * be read.
 *
 * Memory bound: O(fondsCount) — only metadata is held. Storage reads:
 * the stored index and one HEAD per published fonds the run did not
 * select, none when it selected them all.
 */
export async function writeDescriptionsIndex(
  storage: ExportStorage,
  fondsCodes: string[],
  recordCountsByFondsCode: Record<string, number>,
  tenant: ExportTenant,
  publishedFonds: string[]
): Promise<WriteIndexResult> {
  const indexKey = `${tenant.slug}/descriptions-index.json`;
  // Per-fonds entry keys are slug-prefixed to match the actual R2
  // layout that `exportFondsDescriptions` writes.
  // Consumers (the frontend static site build) join the prefix when
  // streaming each per-fonds file.
  const fileKey = (code: string) => `${tenant.slug}/descriptions-${code}.json`;
  const selected = new Set(fondsCodes);
  const unselected = publishedFonds.filter((code) => !selected.has(code));
  const stored =
    unselected.length > 0 ? await readStoredCounts(storage, indexKey) : new Map<string, number>();

  const entries: DescriptionsIndexFondsEntry[] = [];
  // Unselected published fonds with a file but no stored entry.
  const unlisted: string[] = [];
  for (const code of publishedFonds) {
    if (selected.has(code)) {
      entries.push({ fonds_code: code, key: fileKey(code), record_count: recordCountsByFondsCode[code] ?? 0 });
      continue;
    }
    if (!(await storage.getObjectHead(fileKey(code)))) continue;
    const count = stored.get(code);
    if (count === undefined) {
      unlisted.push(code);
      continue;
    }
    entries.push({ fonds_code: code, key: fileKey(code), record_count: count });
  }
  if (unlisted.length > 0) throw new DescriptionsIndexMissingFondsError(indexKey, unlisted);

  const totalRecordCount = entries.reduce((n, e) => n + e.record_count, 0);

  const index: DescriptionsIndex = {
    version: 1,
    generated_at: new Date().toISOString(),
    total_record_count: totalRecordCount,
    fonds: entries,
  };

  await storage.putObject(indexKey, JSON.stringify(index, null, 2));

  return { totalRecordCount, fondsCount: entries.length };
}

// @version v0.9.0
