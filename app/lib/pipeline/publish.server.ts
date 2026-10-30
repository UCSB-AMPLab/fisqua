/**
 * Media Pipeline — Publishing a Ready Volume
 *
 * This module deals with the publish action: taking one volume that the
 * pipeline has prepared and a person has passed as ready, and making it
 * public. Tiles and OCR text are already in delivery storage when a
 * volume is ready; what holds it back is its manifest, which the runner
 * wrote to the working space instead of its canonical URL. Publishing
 * copies that held manifest to the canonical URL, and that copy is the
 * publication boundary: a volume is reached through the catalogue row
 * that points at its manifest.
 *
 * Each tenant publishes into its federation's storage, under its slug:
 * the canonical manifest goes to the federation's manifest bucket at
 * `{slug}/iiif/{reference_code}/manifest.json`, under the manifest
 * address dispatch built its id on, and page text is read from the
 * federation's tiles bucket with its read key, both from the tenant's
 * storage destination (`publishDepsFromEnv(env, tenant)`). A tenant
 * without a complete destination is refused with
 * `tenant_destination_unset` before anything is read.
 *
 * `publishVolume` runs the steps in a fixed order. Step 0,
 * `loadPublishContext`, only reads: publishing must be switched on for
 * the environment and the tenant's destination set up; the volume must be ready in the request tenant with
 * the requested run as its current run, nothing in flight, no open
 * review and a gate pass; the run must be closed (or its token expired)
 * and its spec URL expired, so no job of it can still write; the
 * volume must not be flagged restricted (its own `restricted` flag; the
 * description's access conditions are not read for this) and its
 * description must be found; the spec must still hash to the
 * digest on the run row and name the federation's tiles bucket; the held
 * manifest must be, as a JSON value,
 * exactly the document Fisqua builds from the spec, with only the
 * canvas dimensions taken from the runner (`expectedHeldManifest` ports
 * the runner's builder, and `checkHeldMaterial` names the first failing
 * check), and its text may not name a key twice in one object, since
 * the text is what is published and the parse keeps only the last of
 * duplicate keys (`hasDuplicateKey`); the report must list the spec's pages with OCR keys of the
 * expected form; and no other tenant may hold the canonical key, whose
 * current object must be this volume's to replace. Step 1 claims the
 * volume with one in-flight publication row. Step 2 ingests the run's
 * OCR pages. When the description still holds the page-1 transcript
 * migrated from the old `ocr_text` column (no run id, no source or ALTO
 * key), the run's pages replace it, and its text is kept first: written
 * to the spec bucket (the `SPEC_BUCKET` binding) under
 * `{tenantId}/pipeline-publications/{publicationId}/previous-ocr.txt`,
 * with that key and the SHA-256 of the bytes recorded on the claimed
 * row, before the ingest is called and told which row it may replace. A
 * failed write fails the claim with nothing written to the page table;
 * a retry after the row was replaced finds no migrated text and keeps
 * nothing a second time, and the first row keeps its record. Any other
 * row without a run id is refused by the ingest as before. Step 3 copies any previous object at the canonical key,
 * byte for byte, into the spec bucket. Step 4 records the previous
 * chain and the description as it stands, and marks the row `copying`.
 * Step 5 puts the held manifest at the canonical key, conditional on
 * the object step 0 read (its etag, or its absence). Step 6 commits the
 * publication, the volume and the catalogue change in one batch.
 *
 * The canonical copy comes last among the writes that matter because it
 * is the one that cannot be undone. Every failure before it leaves the
 * volume ready and nothing at the canonical key: the claim moves to
 * `failed` and frees the volume, and OCR rows already written are the
 * run's own pages, which a retry rewrites unchanged. A put refused by
 * its condition means another writer got there first and fails the
 * claim. A put that throws is resolved by reading the key back. A final
 * batch that fails after the put leaves the row `copying`, the manifest
 * at its URL and the catalogue unchanged, so nothing points at the
 * manifest until `resolveStalledPublication`, called by a later request
 * or the scheduled sweep, finishes the batch or fails the row. A request
 * that loses its claim between steps 4 and 5 can still make its put
 * after a newer request has failed its row as `copy_not_made`; the
 * sweep also looks at such failed rows and finishes the publish from
 * one whose bytes are at the key.
 *
 * The final batch asserts its own preconditions: the publication and
 * the volume are moved with `CASE ... ELSE NULL END` into NOT NULL
 * columns, so a lost claim or a moved volume rolls the whole batch
 * back, journal entry included. The description change is journaled
 * like a hand edit, and left out when nothing on it changes.
 *
 * The previous chain (a manifest that predates the pipeline at the
 * canonical key, or another URL on the description) is recorded with
 * the image roots it names, and nothing is deleted. A claim expires
 * after `PUBLISH_CLAIM_TTL_MS`; an expired `claimed` row is abandoned,
 * and an expired `copying` row is resolved by looking at the key.
 *
 * The spec object holds the run's callback token in plaintext. Only the
 * volume's entry and the destination block are kept from it, and
 * nothing from it is logged or returned except the canonical URL.
 *
 * @version v0.8.0
 */

import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import * as schema from "../../db/schema";
import {
  descriptions,
  ocrPages,
  pipelineGatePasses,
  pipelinePublications,
  pipelineRunVolumes,
  pipelineRuns,
  pipelineVolumes,
} from "../../db/schema";
import { parseManifestPages, ManifestError, type ParsedManifest } from "../iiif.server";
import {
  ingestOcrPages,
  OcrIngestError,
  type MediaObjectReader,
  type OcrPageInput,
  type ReplaceMigrated,
} from "../ocr/ingest.server";
import { composeJournalEntry, computeDiff } from "../stewardship.server";
import { isRestricted } from "./restriction";
import { validateRunSpec, type RunSpec, type RunSpecVolume } from "./run-spec";
import {
  getMediaObjectReader,
  pipelineKey,
  PipelineStoreError,
  type PipelineStoreEnv,
} from "./store.server";
import { requireMediaPipelineAccess } from "./access.server";
import { rawBatchItem } from "./callback.server";
import {
  CanonicalLocatorError,
  defaultCanonicalManifestLocator,
  prefixLocator,
  s3CanonicalManifestStore,
  type CanonicalManifestLocator,
  type CanonicalManifestStore,
} from "./canonical.server";
import {
  destinationFor,
  readTenantFederation,
  resolveTenantDestination,
  TenantDestinationError,
  type TenantDestination,
  type TenantStorageRef,
} from "./tenant-destination.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublishRefusalCode =
  | "invalid_request"
  | "publish_disabled"
  | "publish_unconfigured"
  | "tenant_destination_unset"
  | "volume_not_found"
  | "volume_state"
  | "already_published"
  | "stale_run"
  | "publish_in_progress"
  | "review_open"
  | "gate_missing"
  | "run_open"
  | "run_spec_live"
  | "restricted_material"
  | "spec_mismatch"
  | "manifest_inputs_unavailable"
  | "held_material_invalid"
  | "held_manifest_missing"
  | "held_manifest_invalid"
  | "held_manifest_mismatch"
  | "held_material_unreadable"
  | "report_missing"
  | "report_invalid"
  | "canonical_not_owned"
  | "canonical_unreadable"
  | "ocr_backfilled_text"
  | "ocr_missing_object"
  | "ocr_failed"
  | "publish_failed"
  | "canonical_conflict"
  | "canonical_write_failed"
  | "publish_incomplete";

export type PublishRefusalStatus = 400 | 404 | 409 | 503;

/** A publish refused or failed, with the HTTP status it answers. */
export class PublishRefusal extends Error {
  readonly code: PublishRefusalCode;
  readonly detail: Record<string, unknown>;
  readonly status: PublishRefusalStatus;
  constructor(
    code: PublishRefusalCode,
    detail: Record<string, unknown> = {},
    status: PublishRefusalStatus = 400,
  ) {
    super(`Publish refused: ${code}`);
    this.name = "PublishRefusal";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export type PublishDb = DrizzleD1Database<typeof schema>;

export interface PublishDeps {
  db: PublishDb;
  /** Reads the held manifest, the report and the OCR text. */
  reader: MediaObjectReader;
  canonical: CanonicalManifestStore;
  locator: CanonicalManifestLocator;
  /** The spec bucket: run specs, preserved previous manifests and kept OCR text. */
  specBucket: R2Bucket;
  workingBucket: string;
  /** The tenant's tiles bucket; the spec must name it. */
  tilesBucket: string;
  /** Set when the tenant's storage destination is incomplete: every publish is refused. */
  destinationUnset?: boolean;
  /** Injectable for failure tests; defaults to the OCR module's ingest. */
  ingest?: typeof ingestOcrPages;
  publishEnabled: boolean;
  now: () => number;
  newId: () => string;
}

export type PipelineVolumeRow = typeof pipelineVolumes.$inferSelect;
export type PipelineRunRow = typeof pipelineRuns.$inferSelect;
export type PipelineRunVolumeRow = typeof pipelineRunVolumes.$inferSelect;
export type PipelinePublicationRow = typeof pipelinePublications.$inferSelect;

export interface PublishContext {
  tenantId: string;
  userId: string;
  volume: PipelineVolumeRow;
  run: PipelineRunRow;
  runVolume: PipelineRunVolumeRow;
  description: {
    id: string;
    iiifManifestUrl: string | null;
    hasDigital: boolean | null;
  };
  canonicalUrl: string;
  canonicalKey: string;
  manifestText: string;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  /** null when the recipe did not run OCR. */
  ocrPages: OcrPageInput[] | null;
  ocrBucket: string;
  /** The image root the new manifest's services sit under. */
  newImageRoot: string;
  /** What the canonical key holds now, raw. */
  current: { etag: string; bytes: Uint8Array; sha256: string } | null;
}

/** How long a claim may stay in flight before another request may resolve it. */
export const PUBLISH_CLAIM_TTL_MS = 30 * 60 * 1000;

const IN_FLIGHT = ["claimed", "copying"] as const;
const HELD = ["claimed", "copying", "published"] as const;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasBadSegment(key: string): boolean {
  return key.split("/").includes("..");
}

/**
 * The JSON path of the first place two JSON values differ, or null when
 * they are equal: the same keys at every level, arrays in the same order
 * and length, scalars strictly equal. Key order does not matter. Keys
 * are walked in the expected value's order, so the path is stable.
 */
export function firstDifference(actual: unknown, expected: unknown, path = "$"): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return path;
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(actual[i], expected[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return path;
    const extra = Object.keys(actual)
      .filter((k) => !Object.prototype.hasOwnProperty.call(expected, k))
      .sort();
    if (extra.length > 0) return `${path}.${extra[0]}`;
    for (const k of Object.keys(expected)) {
      if (!Object.prototype.hasOwnProperty.call(actual, k)) return `${path}.${k}`;
      const d = firstDifference(actual[k], expected[k], `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return actual === expected ? null : path;
}

/**
 * Whether JSON text names the same key twice in one object, at any
 * depth. `JSON.parse` keeps the last of duplicate keys, so a value check
 * cannot see an earlier one; the text that is published would still
 * carry it. Keys are compared after their escapes are decoded. The text
 * must already have parsed: this scanner does not validate it.
 */
export function hasDuplicateKey(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      stack.push(new Set());
      expectKey = true;
      i++;
    } else if (c === "[") {
      stack.push(null);
      expectKey = false;
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
      i++;
    } else if (c === ",") {
      expectKey = stack.length > 0 && stack[stack.length - 1] !== null;
      i++;
    } else if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      if (expectKey) {
        const keys = stack[stack.length - 1] as Set<string>;
        const key = JSON.parse(text.slice(start, i)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
    } else {
      i++;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The manifest Fisqua would build
// ---------------------------------------------------------------------------

export const IIIF_PRESENTATION_CONTEXT = "http://iiif.io/api/presentation/3/context.json";

/** Python's `round()` on a float: halves go to the even neighbour. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function thumbnail(base: string, name: string, width: number, height: number, widths: number[]) {
  const baked = widths.filter((w) => w < width);
  if (baked.length === 0) {
    return {
      id: `${base}/${name}/full/max/0/default.jpg`,
      type: "Image",
      format: "image/jpeg",
      width,
      height,
    };
  }
  const small = baked.filter((w) => w <= 200);
  const tw = small.length > 0 ? Math.max(...small) : Math.min(...baked);
  const th = pyRound((height * tw) / width);
  return {
    id: `${base}/${name}/full/${tw},${th}/0/default.jpg`,
    type: "Image",
    format: "image/jpeg",
    width: tw,
    height: th,
  };
}

/**
 * The IIIF Presentation 3 manifest the runner builds for one volume,
 * from the spec's manifest inputs, its pages in canvas order, the image
 * base URL, the tile root, the thumbnail widths baked at tiling, and
 * each canvas's dimensions. Null rights and required statement are
 * left out, as the runner leaves them out, and so are a homepage,
 * metadata, summary and METS link (`see_also`, written `seeAlso`) the
 * inputs do not carry.
 */
export function expectedHeldManifest(
  inputs: RunSpecVolume["manifest"],
  pages: ReadonlyArray<{ seq?: number; page_key: string }>,
  imageBaseUrl: string,
  tileRoot: string,
  thumbnailWidths: readonly number[],
  dims: ReadonlyArray<{ width: number; height: number }>,
): Record<string, unknown> {
  const base = `${imageBaseUrl.replace(/\/+$/, "")}/${tileRoot}`;
  const m: Record<string, unknown> = {
    "@context": IIIF_PRESENTATION_CONTEXT,
    id: inputs.id,
    type: "Manifest",
    label: inputs.label,
    behavior: ["paged"],
    provider: inputs.provider,
    items: [] as unknown[],
  };
  if (inputs.rights !== null && inputs.rights !== undefined) m.rights = inputs.rights;
  if (inputs.required_statement !== null && inputs.required_statement !== undefined) {
    m.requiredStatement = inputs.required_statement;
  }
  if (inputs.homepage !== undefined) m.homepage = inputs.homepage;
  if (inputs.metadata !== undefined) m.metadata = inputs.metadata;
  if (inputs.summary !== undefined) m.summary = inputs.summary;
  if (inputs.see_also !== undefined) m.seeAlso = inputs.see_also;
  const items = m.items as unknown[];
  pages.forEach((page, idx) => {
    const i = idx + 1;
    const name = page.page_key;
    const { width: w, height: h } = dims[idx];
    const cid = `${base}/canvas/${i}`;
    items.push({
      id: cid,
      type: "Canvas",
      label: { none: [`img ${i}`] },
      height: h,
      width: w,
      thumbnail: [thumbnail(base, name, w, h, [...thumbnailWidths])],
      items: [
        {
          id: `${cid}/page`,
          type: "AnnotationPage",
          items: [
            {
              id: `${cid}/annotation`,
              type: "Annotation",
              motivation: "painting",
              target: cid,
              body: {
                id: `${base}/${name}/full/max/0/default.jpg`,
                type: "Image",
                format: "image/jpeg",
                height: h,
                width: w,
                service: [{ id: `${base}/${name}`, type: "ImageService3", profile: "level0" }],
              },
            },
          ],
        },
      ],
    });
  });
  return m;
}

export type HeldManifestCheck =
  | { check: "id" }
  | { check: "homepage" }
  | { check: "page_count" }
  | { check: "image_root" }
  | { check: "dimensions" }
  | { check: "document"; path: string };

function thumbnailWidthsOf(entry: RunSpecVolume): number[] {
  const tile = entry.recipe.stages.tile;
  const widths = tile.run ? (tile.params as Record<string, unknown>).thumbnail_widths : undefined;
  return Array.isArray(widths) && widths.every((w) => Number.isInteger(w) && w > 0)
    ? (widths as number[])
    : [];
}

function isPositiveInteger(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x > 0;
}

/**
 * Compares a held manifest (already parsed, with its canvases read into
 * `pages`) with the document Fisqua builds from the spec entry. Returns
 * the first failing check, or null when the held manifest is exactly
 * that document.
 */
export function checkHeldMaterial(
  doc: Record<string, any>,
  pages: ParsedManifest["pages"],
  entry: RunSpecVolume,
  destination: RunSpec["destination"],
  expectedCount: number,
): HeldManifestCheck | null {
  if (doc.id !== entry.manifest.id) return { check: "id" };
  if (firstDifference(doc.homepage, entry.manifest.homepage) !== null) return { check: "homepage" };
  if (pages.length !== expectedCount || pages.length !== entry.pages.length) {
    return { check: "page_count" };
  }
  const base = `${destination.image_base_url.replace(/\/+$/, "")}/${entry.tile_root}`;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].imageUrl !== `${base}/${entry.pages[i].page_key}`) return { check: "image_root" };
  }
  const canvases = doc.items as Array<Record<string, any>>;
  const dims: Array<{ width: number; height: number }> = [];
  for (const canvas of canvases) {
    const { width, height } = canvas;
    if (!isPositiveInteger(width) || !isPositiveInteger(height)) return { check: "dimensions" };
    const body = canvas.items?.[0]?.items?.[0]?.body;
    if (isPlainObject(body) && (body.width !== width || body.height !== height)) {
      return { check: "dimensions" };
    }
    dims.push({ width, height });
  }
  const expected = expectedHeldManifest(
    entry.manifest,
    entry.pages,
    destination.image_base_url,
    entry.tile_root,
    thumbnailWidthsOf(entry),
    dims,
  );
  const path = firstDifference(doc, expected);
  return path === null ? null : { check: "document", path };
}

// ---------------------------------------------------------------------------
// Step 0: reads and checks
// ---------------------------------------------------------------------------

async function readHeld(
  deps: PublishDeps,
  key: string,
): Promise<string | null> {
  try {
    return await deps.reader.getText(deps.workingBucket, key);
  } catch (err) {
    if (err instanceof PipelineStoreError) {
      if (err.code === "config") throw new PublishRefusal("publish_unconfigured", {}, 400);
      throw new PublishRefusal("held_material_unreadable", {}, 503);
    }
    throw err;
  }
}

/** The published publication of a volume, if it has one. */
async function publishedPublicationId(
  db: PublishDb,
  tenantId: string,
  volumeId: string,
): Promise<string | null> {
  const row = await db
    .select({ id: pipelinePublications.id })
    .from(pipelinePublications)
    .where(
      and(
        eq(pipelinePublications.tenantId, tenantId),
        eq(pipelinePublications.pipelineVolumeId, volumeId),
        eq(pipelinePublications.status, "published"),
      ),
    )
    .get();
  return row?.id ?? null;
}

/** The volume's in-flight publication, if one exists. */
export async function inFlightPublication(
  db: PublishDb,
  tenantId: string,
  volumeId: string,
): Promise<PipelinePublicationRow | null> {
  const row = await db
    .select()
    .from(pipelinePublications)
    .where(
      and(
        eq(pipelinePublications.tenantId, tenantId),
        eq(pipelinePublications.pipelineVolumeId, volumeId),
        inArray(pipelinePublications.status, [...IN_FLIGHT]),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Whether another tenant holds a canonical key or URL. These two reads
 * are cross-tenant on purpose: the canonical key space is shared, and a
 * publish must not overwrite another tenant's manifest. Each reads only
 * whether a row exists, never its content.
 */
export async function canonicalHeldElsewhere(
  db: PublishDb,
  tenantId: string,
  canonicalKey: string,
  canonicalUrl: string,
): Promise<boolean> {
  const pub = await db
    .select({ id: pipelinePublications.id })
    .from(pipelinePublications)
    .where(
      and(
        ne(pipelinePublications.tenantId, tenantId),
        eq(pipelinePublications.canonicalKey, canonicalKey),
        inArray(pipelinePublications.status, [...HELD]),
      ),
    )
    .limit(1)
    .get();
  if (pub) return true;
  const desc = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(and(ne(descriptions.tenantId, tenantId), eq(descriptions.iiifManifestUrl, canonicalUrl)))
    .limit(1)
    .get();
  return Boolean(desc);
}

function reportPages(
  report: unknown,
  run: PipelineRunRow,
  volume: PipelineVolumeRow,
  runVolume: PipelineRunVolumeRow,
  entry: RunSpecVolume,
): Array<Record<string, unknown>> {
  const invalid = () => new PublishRefusal("report_invalid", {}, 400);
  if (!isPlainObject(report)) throw invalid();
  if (report.run_id !== run.id || report.volume_id !== volume.id || report.tile_root !== runVolume.tileRoot) {
    throw invalid();
  }
  const pages = report.pages;
  if (!Array.isArray(pages) || pages.length !== runVolume.expectedCount || pages.length !== entry.pages.length) {
    throw invalid();
  }
  pages.forEach((p, i) => {
    if (!isPlainObject(p) || p.seq !== i + 1 || p.page_key !== entry.pages[i].page_key) throw invalid();
  });
  return pages as Array<Record<string, unknown>>;
}

function ocrInput(
  pages: Array<Record<string, unknown>>,
  entry: RunSpecVolume,
  destination: RunSpec["destination"],
  tilesBucket: string,
): OcrPageInput[] | null {
  const invalid = () => new PublishRefusal("report_invalid", {}, 400);
  const ocr = entry.recipe.stages.ocr;
  if (!ocr.run) {
    for (const p of pages) if (p.text_key !== null || p.alto_key !== null) throw invalid();
    return null;
  }
  if (destination.ocr_bucket !== tilesBucket) throw new PublishRefusal("spec_mismatch", {}, 400);
  const pdfText = (ocr.params as Record<string, unknown>).engine === "pdf_text_layer";
  const root = `${destination.ocr_prefix}${entry.tile_root}`;
  return pages.map((p, i) => {
    const key = entry.pages[i].page_key;
    if (p.text_key !== `${root}/txt/${key}.txt`) throw invalid();
    const alto = pdfText ? null : `${root}/alto/${key}.xml`;
    if (p.alto_key !== alto) throw invalid();
    return { seq: i + 1, textKey: p.text_key as string, altoKey: alto };
  });
}

/**
 * Step 0 of a publish: every read and check, and no write. Returns the
 * context the later steps use, or throws a `PublishRefusal`.
 */
export async function loadPublishContext(
  deps: PublishDeps,
  tenant: { id: string },
  user: { id: string },
  volumeId: string,
  runId: string,
  resolvedOnce = false,
): Promise<PublishContext> {
  // 0. Publishing must be switched on for this environment.
  if (!deps.publishEnabled) throw new PublishRefusal("publish_disabled", {}, 400);
  if (deps.destinationUnset) throw new PublishRefusal("tenant_destination_unset", {}, 400);
  const { db } = deps;
  const tenantId = tenant.id;
  const now = deps.now();

  // 1-3. The volume, its state and its current run.
  const volume = await db
    .select()
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.id, volumeId), eq(pipelineVolumes.tenantId, tenantId)))
    .get();
  if (!volume) throw new PublishRefusal("volume_not_found", {}, 404);
  if (volume.state === "published") {
    throw new PublishRefusal(
      "already_published",
      { publication_id: await publishedPublicationId(db, tenantId, volume.id) },
      409,
    );
  }
  if (volume.state !== "ready") throw new PublishRefusal("volume_state", { state: volume.state }, 409);
  if (runId !== volume.lastRunId) {
    throw new PublishRefusal("stale_run", { run_id: volume.lastRunId }, 409);
  }

  // 4. Nothing in flight. A row past its expiry is resolved, once, and
  // the checks start again from the volume.
  const inFlight = await inFlightPublication(db, tenantId, volume.id);
  if (inFlight) {
    if (resolvedOnce || inFlight.needsPerson || !isStale(inFlight, now)) {
      throw new PublishRefusal("publish_in_progress", {}, 409);
    }
    await resolveStalledPublication({ db, canonical: deps.canonical }, inFlight, now);
    return loadPublishContext(deps, tenant, user, volumeId, runId, true);
  }

  // 5. The run and its row for this volume.
  const run = await db
    .select()
    .from(pipelineRuns)
    .where(and(eq(pipelineRuns.id, runId), eq(pipelineRuns.tenantId, tenantId)))
    .get();
  const runVolume = run
    ? await db
        .select()
        .from(pipelineRunVolumes)
        .where(
          and(
            eq(pipelineRunVolumes.runId, run.id),
            eq(pipelineRunVolumes.pipelineVolumeId, volume.id),
            eq(pipelineRunVolumes.tenantId, tenantId),
          ),
        )
        .get()
    : undefined;
  if (!run || !runVolume) throw new PublishRefusal("volume_state", { state: volume.state }, 409);
  if (runVolume.status !== "prepared" && runVolume.status !== "review_pending") {
    throw new PublishRefusal("volume_state", { state: volume.state }, 409);
  }
  if (volume.currentTileRoot !== runVolume.tileRoot) {
    throw new PublishRefusal("volume_state", { state: volume.state }, 409);
  }

  // 6. Review closed, and a gate pass for the recipe the run applied.
  if (volume.openReviewCount !== 0) throw new PublishRefusal("review_open", {}, 409);
  const gate = await db
    .select({ id: pipelineGatePasses.id })
    .from(pipelineGatePasses)
    .where(
      and(
        eq(pipelineGatePasses.tenantId, tenantId),
        eq(pipelineGatePasses.declarationId, runVolume.declarationId),
        eq(pipelineGatePasses.scriptVersion, run.scriptVersion),
      ),
    )
    .get();
  if (!gate) throw new PublishRefusal("gate_missing", {}, 409);

  // 7. Nothing of the run can still write: it is closed or its token has expired, and
  // its spec URL expired, so no re-run can fetch the spec.
  if (run.tokenRevokedAt === null && run.tokenExpiresAt > now) {
    throw new PublishRefusal("run_open", {}, 409);
  }
  if (now < run.specUrlExpiresAt) {
    throw new PublishRefusal("run_spec_live", { spec_url_expires_at: run.specUrlExpiresAt }, 409);
  }

  // 8. The volume must not have been flagged restricted, and its
  // description must be found; a description that cannot be found
  // fails closed.
  const description = await db
    .select({
      id: descriptions.id,
      iiifManifestUrl: descriptions.iiifManifestUrl,
      hasDigital: descriptions.hasDigital,
    })
    .from(descriptions)
    .where(and(eq(descriptions.id, volume.descriptionId), eq(descriptions.tenantId, tenantId)))
    .get();
  if (isRestricted(volume) || !description) {
    throw new PublishRefusal("restricted_material", {}, 400);
  }

  // 9. The spec, unchanged since dispatch. Only the volume's entry and
  // the destination are kept: the object also holds the run's token.
  const specObject = await deps.specBucket.get(run.specKey);
  if (!specObject) throw new PublishRefusal("spec_mismatch", {}, 400);
  const specBytes = new Uint8Array(await specObject.arrayBuffer());
  if ((await sha256Hex(specBytes)) !== run.specSha256) {
    throw new PublishRefusal("spec_mismatch", {}, 400);
  }
  let entry: RunSpecVolume | undefined;
  let destination: RunSpec["destination"];
  try {
    const spec = validateRunSpec(JSON.parse(new TextDecoder().decode(specBytes)));
    if (spec.run_id !== run.id || spec.tenant_id !== tenantId) {
      throw new PublishRefusal("spec_mismatch", {}, 400);
    }
    entry = spec.volumes.find((v) => v.volume_id === volume.id);
    destination = spec.destination;
  } catch {
    throw new PublishRefusal("spec_mismatch", {}, 400);
  }
  if (
    !entry ||
    destination.tiles_bucket !== deps.tilesBucket ||
    entry.reference_code !== volume.referenceCode ||
    entry.description_id !== volume.descriptionId ||
    entry.tile_root !== runVolume.tileRoot ||
    entry.expected_count !== runVolume.expectedCount
  ) {
    throw new PublishRefusal("spec_mismatch", {}, 400);
  }

  // 10. The canonical URL and its key.
  const canonicalUrl = entry.manifest.id;
  let canonicalKey: string;
  try {
    canonicalKey = deps.locator(canonicalUrl, volume.referenceCode);
  } catch (err) {
    if (err instanceof CanonicalLocatorError) {
      throw new PublishRefusal("manifest_inputs_unavailable", {}, 400);
    }
    throw err;
  }

  // 11. The held keys sit under this run's working prefix.
  const heldPrefix = `${pipelineKey.workingPrefix(tenantId, run.id)}volumes/${volume.id}/`;
  for (const key of [runVolume.manifestKey, runVolume.reportKey]) {
    if (key === null || !key.startsWith(heldPrefix) || hasBadSegment(key)) {
      throw new PublishRefusal("held_material_invalid", {}, 400);
    }
  }
  const manifestKey = runVolume.manifestKey as string;
  const reportKey = runVolume.reportKey as string;

  // 12. The held manifest, compared with the document Fisqua builds.
  const manifestText = await readHeld(deps, manifestKey);
  if (manifestText === null) throw new PublishRefusal("held_manifest_missing", {}, 400);
  let doc: unknown;
  try {
    doc = JSON.parse(manifestText);
  } catch {
    throw new PublishRefusal("held_manifest_invalid", { token: "manifest_json" }, 400);
  }
  if (!isPlainObject(doc)) {
    throw new PublishRefusal("held_manifest_invalid", { token: "manifest_json" }, 400);
  }
  // The text itself is what is published, so a key named twice, whose
  // earlier value the parse dropped, is refused rather than carried.
  if (hasDuplicateKey(manifestText)) {
    throw new PublishRefusal("held_manifest_invalid", { token: "manifest_duplicate_key" }, 400);
  }
  let pages: ParsedManifest["pages"];
  try {
    pages = parseManifestPages(doc);
  } catch (err) {
    const token = err instanceof ManifestError ? err.message : "manifest_shape";
    throw new PublishRefusal("held_manifest_invalid", { token }, 400);
  }
  const mismatch = checkHeldMaterial(doc, pages, entry, destination, runVolume.expectedCount);
  if (mismatch !== null) throw new PublishRefusal("held_manifest_mismatch", { ...mismatch }, 400);

  // 13. The report lists the spec's pages.
  const reportText = await readHeld(deps, reportKey);
  if (reportText === null) throw new PublishRefusal("report_missing", {}, 400);
  let report: unknown;
  try {
    report = JSON.parse(reportText);
  } catch {
    throw new PublishRefusal("report_invalid", {}, 400);
  }
  const rPages = reportPages(report, run, volume, runVolume, entry);

  // 14. The OCR pages, with keys of the form the spec implies.
  const ocrPages = ocrInput(rPages, entry, destination, deps.tilesBucket);

  // 15. The canonical key is this volume's to write.
  if (await canonicalHeldElsewhere(db, tenantId, canonicalKey, canonicalUrl)) {
    throw new PublishRefusal("canonical_not_owned", {}, 409);
  }
  const manifestBytes = new TextEncoder().encode(manifestText);
  const manifestSha256 = await sha256Hex(manifestBytes);
  let got: { etag: string; bytes: Uint8Array } | null;
  try {
    got = await deps.canonical.get(canonicalKey);
  } catch {
    throw new PublishRefusal("canonical_unreadable", {}, 503);
  }
  let current: PublishContext["current"] = null;
  if (got !== null) {
    current = { etag: got.etag, bytes: got.bytes, sha256: await sha256Hex(got.bytes) };
    let ownEarlierCopy = false;
    if (current.sha256 === manifestSha256) {
      const earlier = await db
        .select({ id: pipelinePublications.id })
        .from(pipelinePublications)
        .where(
          and(
            eq(pipelinePublications.tenantId, tenantId),
            eq(pipelinePublications.pipelineVolumeId, volume.id),
            eq(pipelinePublications.canonicalKey, canonicalKey),
            eq(pipelinePublications.manifestSha256, manifestSha256),
          ),
        )
        .limit(1)
        .get();
      ownEarlierCopy = Boolean(earlier);
    }
    if (!ownEarlierCopy && description.iiifManifestUrl !== canonicalUrl) {
      throw new PublishRefusal("canonical_not_owned", {}, 409);
    }
  }

  return {
    tenantId,
    userId: user.id,
    volume,
    run,
    runVolume,
    description,
    canonicalUrl,
    canonicalKey,
    manifestText,
    manifestBytes,
    manifestSha256,
    ocrPages,
    ocrBucket: destination.ocr_bucket,
    newImageRoot: `${destination.image_base_url.replace(/\/+$/, "")}/${entry.tile_root}`,
    current,
  };
}

// ---------------------------------------------------------------------------
// Steps 1 and 4: the claim and the record
// ---------------------------------------------------------------------------

export interface ClaimIds {
  publicationId: string;
  claimId: string;
}

/** The condition the canonical put will be made under. */
export function canonicalExpectOf(ctx: Pick<PublishContext, "current">): { absent: true } | { etag: string } {
  return ctx.current === null ? { absent: true } : { etag: ctx.current.etag };
}

/**
 * Step 1, as two statements for one batch: (a) abandon this volume's
 * `claimed` row whose claim has expired (a `copying` row may hold a
 * canonical write and is left for `resolveStalledPublication`); (b)
 * insert the new `claimed` row, only while the volume is still ready
 * with the same run and nothing of it is in flight or published. The
 * partial unique indexes back (b) against a concurrent request and
 * against another tenant's claim on the same canonical key.
 */
export function buildClaimStatements(
  db: PublishDb,
  ctx: PublishContext,
  ids: ClaimIds,
  now: number,
): BatchItem<"sqlite">[] {
  const t = ctx.tenantId;
  const v = ctx.volume.id;
  const abandon = db
    .update(pipelinePublications)
    .set({ status: "abandoned", finishedAt: now, error: JSON.stringify({ class: "claim_expired" }) })
    .where(
      and(
        eq(pipelinePublications.tenantId, t),
        eq(pipelinePublications.pipelineVolumeId, v),
        eq(pipelinePublications.status, "claimed"),
        lte(pipelinePublications.claimedAt, now - PUBLISH_CLAIM_TTL_MS),
      ),
    );
  const insert = rawBatchItem(
    db,
    sql`INSERT INTO pipeline_publications
      (id, tenant_id, pipeline_volume_id, run_id, run_volume_id, user_id, status, claim_id,
       canonical_url, canonical_key, manifest_sha256, canonical_expect, claimed_at)
      SELECT ${ids.publicationId}, ${t}, ${v}, ${ctx.run.id}, ${ctx.runVolume.id}, ${ctx.userId},
             'claimed', ${ids.claimId}, ${ctx.canonicalUrl}, ${ctx.canonicalKey},
             ${ctx.manifestSha256}, ${JSON.stringify(canonicalExpectOf(ctx))}, ${now}
      WHERE EXISTS (SELECT 1 FROM pipeline_volumes
                    WHERE id = ${v} AND tenant_id = ${t} AND state = 'ready' AND last_run_id = ${ctx.run.id})
        AND NOT EXISTS (SELECT 1 FROM pipeline_publications
                        WHERE pipeline_volume_id = ${v} AND tenant_id = ${t}
                          AND status IN ('claimed','copying','published'))`,
  );
  return [abandon, insert];
}

function isUniqueViolation(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
  return /UNIQUE constraint failed/i.test(text);
}

/**
 * Runs the claim batch and reads the row back. When no row was
 * inserted (the volume moved, another request claimed first, or
 * another tenant holds the key), the volume and its publications are
 * read again and the refusal that now holds is thrown.
 */
export async function claimPublication(
  deps: PublishDeps,
  ctx: PublishContext,
  now: number,
): Promise<ClaimIds> {
  const { db } = deps;
  const ids = { publicationId: deps.newId(), claimId: deps.newId() };
  try {
    await db.batch(buildClaimStatements(db, ctx, ids, now) as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const row = await db
    .select({ id: pipelinePublications.id })
    .from(pipelinePublications)
    .where(
      and(
        eq(pipelinePublications.tenantId, ctx.tenantId),
        eq(pipelinePublications.claimId, ids.claimId),
      ),
    )
    .get();
  if (row) return ids;

  const volume = await db
    .select({ state: pipelineVolumes.state, lastRunId: pipelineVolumes.lastRunId })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.id, ctx.volume.id), eq(pipelineVolumes.tenantId, ctx.tenantId)))
    .get();
  if (volume?.state === "published") {
    throw new PublishRefusal(
      "already_published",
      { publication_id: await publishedPublicationId(db, ctx.tenantId, ctx.volume.id) },
      409,
    );
  }
  if (!volume || volume.state !== "ready") {
    throw new PublishRefusal("volume_state", { state: volume?.state ?? null }, 409);
  }
  if (volume.lastRunId !== ctx.run.id) {
    throw new PublishRefusal("stale_run", { run_id: volume.lastRunId }, 409);
  }
  if (await inFlightPublication(db, ctx.tenantId, ctx.volume.id)) {
    throw new PublishRefusal("publish_in_progress", {}, 409);
  }
  if (await canonicalHeldElsewhere(db, ctx.tenantId, ctx.canonicalKey, ctx.canonicalUrl)) {
    throw new PublishRefusal("canonical_not_owned", {}, 409);
  }
  throw new PublishRefusal("publish_in_progress", {}, 409);
}

/** What step 4 records on the publication row. */
export interface PublicationRecord {
  descriptionBefore: { iiifManifestUrl: string | null; hasDigital: boolean | null };
  previousCatalogueUrl: string | null;
  previousManifestSha256: string | null;
  previousManifestEtag: string | null;
  previousManifestCopyKey: string | null;
  previousImageRoots: string[] | null;
  ocrPagesWritten: number | null;
  ocrBytesRead: number | null;
}

/** Whether a record names a previous chain to retire. */
export function retirementOf(record: PublicationRecord): "none" | "pending" {
  return record.previousCatalogueUrl !== null ||
    record.previousManifestSha256 !== null ||
    record.previousManifestCopyKey !== null
    ? "pending"
    : "none";
}

/**
 * Step 4: one guarded update that records the previous chain, the OCR
 * counts and the description as it stands, and moves the row from
 * `claimed` to `copying`. From here on a canonical put may have
 * happened. It changes nothing when the claim was lost.
 */
export function buildRecordStatement(
  db: PublishDb,
  ctx: Pick<PublishContext, "tenantId">,
  pub: { id: string; claimId: string },
  record: PublicationRecord,
  now: number,
) {
  return db
    .update(pipelinePublications)
    .set({
      status: "copying",
      copyingAt: now,
      descriptionBefore: JSON.stringify(record.descriptionBefore),
      previousCatalogueUrl: record.previousCatalogueUrl,
      previousManifestSha256: record.previousManifestSha256,
      previousManifestEtag: record.previousManifestEtag,
      previousManifestCopyKey: record.previousManifestCopyKey,
      previousImageRoots:
        record.previousImageRoots === null ? null : JSON.stringify(record.previousImageRoots),
      retirementStatus: retirementOf(record),
      ocrPagesWritten: record.ocrPagesWritten,
      ocrBytesRead: record.ocrBytesRead,
    })
    .where(
      and(
        eq(pipelinePublications.id, pub.id),
        eq(pipelinePublications.tenantId, ctx.tenantId),
        eq(pipelinePublications.claimId, pub.claimId),
        eq(pipelinePublications.status, "claimed"),
      ),
    );
}

export interface ClaimRef {
  id: string;
  tenantId: string;
  claimId: string;
}

/**
 * Moves this claim's row to `failed`, from `claimed` or `copying`. It is
 * used only before this request's canonical put, so a `copying` row it
 * moves holds no write of this request.
 */
export function buildFailClaimStatement(
  db: PublishDb,
  pub: ClaimRef,
  error: Record<string, unknown>,
  now: number,
) {
  return db
    .update(pipelinePublications)
    .set({ status: "failed", error: JSON.stringify(error), finishedAt: now })
    .where(
      and(
        eq(pipelinePublications.id, pub.id),
        eq(pipelinePublications.tenantId, pub.tenantId),
        eq(pipelinePublications.claimId, pub.claimId),
        inArray(pipelinePublications.status, [...IN_FLIGHT]),
      ),
    );
}

export async function failClaim(
  db: PublishDb,
  pub: ClaimRef,
  error: Record<string, unknown>,
  now: number,
): Promise<void> {
  await buildFailClaimStatement(db, pub, error, now);
}

// ---------------------------------------------------------------------------
// The previous chain
// ---------------------------------------------------------------------------

const ROOTS_MAX_DEPTH = 32;
const ROOTS_MAX_NODES = 100_000;

/**
 * The image roots a previous manifest names: every `id` or `@id` string
 * of an object that sits in a `service` property, as an `https:` URL cut
 * at its last `/`, sorted and distinct, without `excludeRoot`. Covers
 * IIIF Presentation 2 and 3. Returns null, and never throws, when the
 * bytes are not UTF-8 JSON, the walk passes its depth or size limit, or
 * no service is found.
 */
export function extractImageRoots(bytes: Uint8Array, excludeRoot: string | null = null): string[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const found = new Set<string>();
  let nodes = 0;
  let exceeded = false;
  const visit = (value: unknown, depth: number, inService: boolean): void => {
    if (exceeded) return;
    nodes += 1;
    if (nodes > ROOTS_MAX_NODES || depth > ROOTS_MAX_DEPTH) {
      exceeded = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1, inService);
      return;
    }
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (inService && (k === "id" || k === "@id") && typeof v === "string") found.add(v);
        visit(v, depth + 1, k === "service");
      }
    }
  };
  visit(doc, 0, false);
  if (exceeded || found.size === 0) return null;
  const roots = new Set<string>();
  for (const id of found) {
    let url: URL;
    try {
      url = new URL(id);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.pathname.split("/").filter(Boolean).length < 1) continue;
    roots.add(id.slice(0, id.lastIndexOf("/")));
  }
  if (excludeRoot !== null) roots.delete(excludeRoot);
  return [...roots].sort();
}

/** Where a previous canonical object is preserved, in the spec bucket. */
export function previousManifestCopyKey(tenantId: string, publicationId: string): string {
  return `${tenantId}/pipeline-publications/${publicationId}/previous-manifest.json`;
}

/** Where migrated OCR text replaced by a publication is kept, in the spec bucket. */
export function previousOcrCopyKey(tenantId: string, publicationId: string): string {
  return `${tenantId}/pipeline-publications/${publicationId}/previous-ocr.txt`;
}

/**
 * Step 2, before the ingest: when the description's only row without a
 * run id is a bare page 1 (the transcript migrated from the old column),
 * writes its text to Fisqua's bucket and records the key and digest on
 * this claim's row, and returns the row for the ingest to replace.
 * Returns null when there is no such row, or when the rows without a run
 * id are anything else, which the ingest then refuses. A write that
 * throws propagates; a lost claim is answered as one.
 */
async function keepMigratedText(
  deps: PublishDeps,
  ctx: Pick<PublishContext, "tenantId" | "volume">,
  ref: ClaimRef,
): Promise<ReplaceMigrated | null> {
  const found = await deps.db
    .select({
      id: ocrPages.id,
      pageSeq: ocrPages.pageSeq,
      sourceKey: ocrPages.sourceKey,
      altoKey: ocrPages.altoKey,
      text: ocrPages.text,
    })
    .from(ocrPages)
    .where(
      and(
        eq(ocrPages.tenantId, ctx.tenantId),
        eq(ocrPages.descriptionId, ctx.volume.descriptionId),
        isNull(ocrPages.runId),
      ),
    )
    .all();
  if (found.length !== 1) return null;
  const [row] = found;
  if (row.pageSeq !== 1 || row.sourceKey !== null || row.altoKey !== null) return null;

  const bytes = new TextEncoder().encode(row.text);
  const key = previousOcrCopyKey(ctx.tenantId, ref.id);
  await deps.specBucket.put(key, bytes, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  const result = await deps.db
    .update(pipelinePublications)
    .set({ previousOcrCopyKey: key, previousOcrSha256: await sha256Hex(bytes) })
    .where(
      and(
        eq(pipelinePublications.id, ref.id),
        eq(pipelinePublications.tenantId, ref.tenantId),
        eq(pipelinePublications.claimId, ref.claimId),
        eq(pipelinePublications.status, "claimed"),
      ),
    );
  if ((result as unknown as D1Result).meta?.changes === 0) {
    throw new PublishRefusal("publish_in_progress", { lost_claim: true }, 409);
  }
  return { pageId: row.id };
}

// ---------------------------------------------------------------------------
// Step 6: the final batch
// ---------------------------------------------------------------------------

/** What step 6 needs. Built from step 0's context in a request, or from the row. */
export interface FinalInput {
  tenantId: string;
  publicationId: string;
  claimId: string;
  userId: string;
  runId: string;
  pipelineVolumeId: string;
  canonicalUrl: string;
  descriptionId: string;
  descriptionBefore: { iiifManifestUrl: string | null; hasDigital: boolean | null };
}

export function finalInputFromContext(
  ctx: PublishContext,
  pub: {
    id: string;
    claimId: string;
    descriptionBefore: FinalInput["descriptionBefore"];
  },
): FinalInput {
  return {
    tenantId: ctx.tenantId,
    publicationId: pub.id,
    claimId: pub.claimId,
    userId: ctx.userId,
    runId: ctx.run.id,
    pipelineVolumeId: ctx.volume.id,
    canonicalUrl: ctx.canonicalUrl,
    descriptionId: ctx.volume.descriptionId,
    descriptionBefore: pub.descriptionBefore,
  };
}

/**
 * The final input for a stalled row. Reads only the volume, for its
 * description id; returns null when the volume is gone or the row never
 * recorded the description (a row that never reached step 4).
 */
export async function finalInputFromRow(
  db: DrizzleD1Database<any>,
  row: PipelinePublicationRow,
): Promise<FinalInput | null> {
  if (row.descriptionBefore === null) return null;
  const volume = await db
    .select({ descriptionId: pipelineVolumes.descriptionId })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.id, row.pipelineVolumeId), eq(pipelineVolumes.tenantId, row.tenantId)))
    .get();
  if (!volume) return null;
  const before = JSON.parse(row.descriptionBefore) as FinalInput["descriptionBefore"];
  return {
    tenantId: row.tenantId,
    publicationId: row.id,
    claimId: row.claimId,
    userId: row.userId,
    runId: row.runId,
    pipelineVolumeId: row.pipelineVolumeId,
    canonicalUrl: row.canonicalUrl,
    descriptionId: volume.descriptionId,
    descriptionBefore: {
      iiifManifestUrl: before.iiifManifestUrl ?? null,
      hasDigital: before.hasDigital ?? null,
    },
  };
}

/**
 * Step 6, one batch that D1 runs as one transaction: (a) the
 * publication from `copying` to `published` (or, for the sweep, from
 * `failed` with class `copy_not_made`, see `resolveStalledPublication`,
 * clearing the error) and (b) the volume from
 * `ready`, and not flagged restricted, to `published`, each written so
 * that a failed precondition sets a NOT NULL column to NULL and rolls
 * the whole batch back; then (c) the description's manifest URL and
 * digital flag and (d) its journal entry, both left out when nothing on
 * the description changes.
 */
export function buildFinalStatements(
  db: DrizzleD1Database<any>,
  input: FinalInput,
  now: number,
  from: "copying" | "copy_not_made" = "copying",
): BatchItem<"sqlite">[] {
  const publishedIf =
    from === "copying"
      ? sql`claim_id = ${input.claimId} AND status = 'copying'`
      : sql`claim_id = ${input.claimId} AND status = 'failed' AND json_extract(error, '$.class') = ${COPY_NOT_MADE}`;
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(pipelinePublications)
      .set({
        status: sql`CASE WHEN ${publishedIf} THEN 'published' ELSE NULL END`,
        publishedAt: now,
        finishedAt: now,
        ...(from === "copying" ? {} : { error: null }),
      })
      .where(
        and(
          eq(pipelinePublications.id, input.publicationId),
          eq(pipelinePublications.tenantId, input.tenantId),
        ),
      ),
    db
      .update(pipelineVolumes)
      .set({
        state: sql`CASE WHEN state = 'ready' AND last_run_id = ${input.runId} AND restricted = 0 THEN 'published' ELSE NULL END`,
        updatedAt: now,
      })
      .where(
        and(eq(pipelineVolumes.id, input.pipelineVolumeId), eq(pipelineVolumes.tenantId, input.tenantId)),
      ),
  ];
  const after = { iiifManifestUrl: input.canonicalUrl, hasDigital: true };
  const diff = computeDiff(input.descriptionBefore, after);
  if (diff !== null) {
    statements.push(
      db
        .update(descriptions)
        .set({ ...after, updatedAt: now, updatedBy: input.userId })
        .where(and(eq(descriptions.id, input.descriptionId), eq(descriptions.tenantId, input.tenantId))),
      composeJournalEntry(db, {
        recordId: input.descriptionId,
        recordType: "description",
        userId: input.userId,
        kind: "update",
        diff,
        note: null,
        runId: null,
        now,
      }),
    );
  }
  return statements;
}

function isNotNullViolation(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
  return /NOT NULL constraint failed/i.test(text);
}

async function runFinalBatch(db: PublishDb, input: FinalInput, now: number): Promise<void> {
  const statements = buildFinalStatements(db, input, now);
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

// ---------------------------------------------------------------------------
// The publish
// ---------------------------------------------------------------------------

export interface PublishResult {
  publicationId: string;
  canonicalUrl: string;
  ocrPagesWritten: number;
  retirementStatus: "none" | "pending";
}

function logClass(what: string, err: unknown): void {
  console.error(`publish: ${what}`, (err as Error)?.name ?? typeof err);
}

function ocrRefusal(err: unknown): PublishRefusal {
  if (err instanceof OcrIngestError) {
    if (err.code === "backfilled_text") return new PublishRefusal("ocr_backfilled_text", {}, 400);
    if (err.code === "missing_object") return new PublishRefusal("ocr_missing_object", {}, 400);
    return new PublishRefusal("ocr_failed", {}, 503);
  }
  if (err instanceof PipelineStoreError) return new PublishRefusal("ocr_failed", {}, 503);
  return new PublishRefusal("publish_failed", {}, 503);
}

function ocrErrorRecord(err: unknown): Record<string, unknown> {
  if (err instanceof OcrIngestError) return { class: "ocr", code: err.code };
  if (err instanceof PipelineStoreError) return { class: "ocr", code: err.code };
  return { class: "publish_failed", name: (err as Error)?.name ?? "unknown" };
}

/** Moves this claim's `copying` row to `failed`: its put wrote nothing. */
async function failCopying(
  db: PublishDb,
  ref: ClaimRef,
  error: Record<string, unknown>,
  now: number,
): Promise<void> {
  await db
    .update(pipelinePublications)
    .set({ status: "failed", error: JSON.stringify(error), finishedAt: now })
    .where(
      and(
        eq(pipelinePublications.id, ref.id),
        eq(pipelinePublications.tenantId, ref.tenantId),
        eq(pipelinePublications.claimId, ref.claimId),
        eq(pipelinePublications.status, "copying"),
      ),
    );
}

/** The refusal a lost claim answers, from the volume as it stands now. */
async function lostClaimRefusal(db: PublishDb, tenantId: string, volumeId: string): Promise<PublishRefusal> {
  const volume = await db
    .select({ state: pipelineVolumes.state })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.id, volumeId), eq(pipelineVolumes.tenantId, tenantId)))
    .get();
  if (volume?.state === "published") {
    return new PublishRefusal(
      "already_published",
      { publication_id: await publishedPublicationId(db, tenantId, volumeId) },
      409,
    );
  }
  return new PublishRefusal("publish_in_progress", {}, 409);
}

/**
 * Publishes one ready volume from the run the request names. The order:
 * read and check everything (step 0); claim the volume (1); keep any
 * migrated page-1 text and ingest the run's OCR pages (2); preserve any previous object at the canonical
 * key (3); record the previous chain and the description as it stands,
 * and mark the row copying (4); put the held manifest at the canonical
 * key on the condition read in step 0 (5); and commit the volume, the
 * publication and the catalogue change in one batch (6).
 */
export async function publishVolume(
  deps: PublishDeps,
  tenant: { id: string },
  user: { id: string },
  input: { volumeId: string; runId: string },
): Promise<PublishResult> {
  const { db } = deps;
  const ctx = await loadPublishContext(deps, tenant, user, input.volumeId, input.runId);
  const now = deps.now();

  // 1. The claim.
  let ids: ClaimIds;
  try {
    ids = await claimPublication(deps, ctx, now);
  } catch (err) {
    if (err instanceof PublishRefusal) throw err;
    logClass("claim failed", err);
    throw new PublishRefusal("publish_failed", {}, 503);
  }
  const ref: ClaimRef = { id: ids.publicationId, tenantId: ctx.tenantId, claimId: ids.claimId };

  // 2-4. OCR, preservation and the record. Any failure here fails the
  // claim: this request has not put anything at the canonical key.
  let record: PublicationRecord;
  try {
    let ocr: { pagesWritten: number; bytesRead: number } | null = null;
    if (ctx.ocrPages !== null) {
      // Migrated text the run's pages replace is kept before the ingest.
      const replaceMigrated = await keepMigratedText(deps, ctx, ref);
      try {
        ocr = await (deps.ingest ?? ingestOcrPages)(db, deps.reader, {
          tenantId: ctx.tenantId,
          descriptionId: ctx.volume.descriptionId,
          runId: ctx.run.id,
          bucket: ctx.ocrBucket,
          pages: ctx.ocrPages,
          ...(replaceMigrated === null ? {} : { replaceMigrated }),
        });
      } catch (err) {
        await failClaimQuietly(db, ref, ocrErrorRecord(err), now);
        throw ocrRefusal(err);
      }
    }

    let previous = {
      previousManifestSha256: null as string | null,
      previousManifestEtag: null as string | null,
      previousManifestCopyKey: null as string | null,
      previousImageRoots: null as string[] | null,
    };
    if (ctx.current !== null && ctx.current.sha256 !== ctx.manifestSha256) {
      const copyKey = previousManifestCopyKey(ctx.tenantId, ref.id);
      await deps.specBucket.put(copyKey, ctx.current.bytes);
      previous = {
        previousManifestSha256: ctx.current.sha256,
        previousManifestEtag: ctx.current.etag,
        previousManifestCopyKey: copyKey,
        previousImageRoots: extractImageRoots(ctx.current.bytes, ctx.newImageRoot),
      };
    }

    const desc = await db
      .select({ iiifManifestUrl: descriptions.iiifManifestUrl, hasDigital: descriptions.hasDigital })
      .from(descriptions)
      .where(and(eq(descriptions.id, ctx.volume.descriptionId), eq(descriptions.tenantId, ctx.tenantId)))
      .get();
    const descriptionBefore = {
      iiifManifestUrl: desc?.iiifManifestUrl ?? null,
      hasDigital: desc?.hasDigital ?? null,
    };
    record = {
      descriptionBefore,
      previousCatalogueUrl:
        descriptionBefore.iiifManifestUrl !== null && descriptionBefore.iiifManifestUrl !== ctx.canonicalUrl
          ? descriptionBefore.iiifManifestUrl
          : null,
      ...previous,
      ocrPagesWritten: ocr?.pagesWritten ?? null,
      ocrBytesRead: ocr?.bytesRead ?? null,
    };
    const result = await buildRecordStatement(db, ctx, { id: ref.id, claimId: ref.claimId }, record, now);
    if ((result as unknown as D1Result).meta?.changes === 0) {
      throw new PublishRefusal("publish_in_progress", { lost_claim: true }, 409);
    }
  } catch (err) {
    if (err instanceof PublishRefusal) {
      if (err.detail.lost_claim === true) throw new PublishRefusal("publish_in_progress", {}, 409);
      throw err;
    }
    await failClaimQuietly(db, ref, { class: "publish_failed", name: (err as Error)?.name ?? "unknown" }, now);
    logClass("failed before the canonical copy", err);
    throw new PublishRefusal("publish_failed", {}, 503);
  }

  // 5. The canonical copy, the last irreversible write.
  const expect = canonicalExpectOf(ctx);
  let put: { etag: string } | null;
  try {
    put = await deps.canonical.put(ctx.canonicalKey, ctx.manifestBytes, ctx.manifestSha256, expect);
  } catch (err) {
    logClass("canonical put failed", err);
    let head: { etag: string; sha256: string | null } | null;
    try {
      head = await deps.canonical.head(ctx.canonicalKey);
    } catch {
      throw new PublishRefusal("publish_incomplete", {}, 503);
    }
    if (head !== null && head.sha256 === ctx.manifestSha256) {
      put = { etag: head.etag };
    } else if (
      (head === null && "absent" in expect) ||
      (head !== null && "etag" in expect && head.etag === expect.etag)
    ) {
      await failCopying(db, ref, { class: "canonical_write_failed" }, now).catch((e) =>
        logClass("marking the failed copy failed", e),
      );
      throw new PublishRefusal("canonical_write_failed", {}, 503);
    } else {
      throw new PublishRefusal("publish_incomplete", {}, 503);
    }
  }
  if (put === null) {
    await failCopying(db, ref, { class: "canonical_conflict" }, now).catch((e) =>
      logClass("marking the conflict failed", e),
    );
    throw new PublishRefusal("canonical_conflict", {}, 409);
  }

  // 6. The final batch.
  try {
    await runFinalBatch(
      db,
      finalInputFromContext(ctx, {
        id: ref.id,
        claimId: ref.claimId,
        descriptionBefore: record.descriptionBefore,
      }),
      now,
    );
  } catch (err) {
    if (isNotNullViolation(err)) throw await lostClaimRefusal(db, ctx.tenantId, ctx.volume.id);
    logClass("final batch failed", err);
    throw new PublishRefusal("publish_incomplete", {}, 503);
  }

  return {
    publicationId: ref.id,
    canonicalUrl: ctx.canonicalUrl,
    ocrPagesWritten: record.ocrPagesWritten ?? 0,
    retirementStatus: retirementOf(record),
  };
}

async function failClaimQuietly(
  db: PublishDb,
  ref: ClaimRef,
  error: Record<string, unknown>,
  now: number,
): Promise<void> {
  try {
    await failClaim(db, ref, error, now);
  } catch (err) {
    logClass("failing the claim failed", err);
  }
}

// ---------------------------------------------------------------------------
// Stalled publications
// ---------------------------------------------------------------------------

/** What resolving a stalled row needs; the sweep can supply all of it. */
export interface StalledDeps {
  db: DrizzleD1Database<any>;
  canonical: CanonicalManifestStore;
}

/** Rows one sweep resolves, across tenants. */
export const SWEEP_PUBLICATIONS = 20;
/** Undecided visits after which a row is no longer selected. */
export const SWEEP_PUBLICATION_MAX_ATTEMPTS = 8;
/** The error class of a `copying` row failed because its key was untouched. */
const COPY_NOT_MADE = "copy_not_made";

/** Whether an in-flight row's claim has expired: from its claim, or from its copy. */
export function isStale(row: Pick<PipelinePublicationRow, "status" | "claimedAt" | "copyingAt">, now: number): boolean {
  const cutoff = now - PUBLISH_CLAIM_TTL_MS;
  if (row.status === "claimed") return row.claimedAt <= cutoff;
  if (row.status === "copying") return row.copyingAt !== null && row.copyingAt <= cutoff;
  return false;
}

/** The row's own id, claim and expected status; callers add its tenant. */
function guardOf(row: PipelinePublicationRow, status: "claimed" | "copying" | "failed") {
  return and(
    eq(pipelinePublications.id, row.id),
    eq(pipelinePublications.claimId, row.claimId),
    eq(pipelinePublications.status, status),
  );
}

async function holdForPerson(
  db: DrizzleD1Database<any>,
  row: PipelinePublicationRow,
  errorClass: string,
  status: "copying" | "failed" = "copying",
): Promise<void> {
  await db
    .update(pipelinePublications)
    .set({ needsPerson: true, error: JSON.stringify({ class: errorClass }) })
    .where(and(eq(pipelinePublications.tenantId, row.tenantId), guardOf(row, status)));
}

async function countAttempt(
  db: DrizzleD1Database<any>,
  row: PipelinePublicationRow,
  status: "copying" | "failed",
): Promise<void> {
  await db
    .update(pipelinePublications)
    .set({ resolveAttempts: sql`${pipelinePublications.resolveAttempts} + 1` })
    .where(and(eq(pipelinePublications.tenantId, row.tenantId), guardOf(row, status)));
}

/** Whether a row is a `failed` copy the sweep should look at again. */
function isUnmadeCopy(row: Pick<PipelinePublicationRow, "status" | "error">): boolean {
  if (row.status !== "failed" || row.error === null) return false;
  try {
    return (JSON.parse(row.error) as { class?: unknown }).class === COPY_NOT_MADE;
  } catch {
    return false;
  }
}

/**
 * Looks again at a `failed` row whose copy was judged not made. That
 * judgement can be overtaken: a request that stalled past its expiry
 * after recording its copy can still make its put after a newer request
 * failed its row, and the newer request's own put is then refused, so
 * the manifest sits at the canonical key with the volume ready and no
 * row in flight. When the volume is still ready from this row's run and
 * the publication's own bytes are at the key, the publish is finished
 * from this row, under the same restriction check as a `copying` row.
 * Every other outcome counts an attempt, so the row stops being
 * selected after `SWEEP_PUBLICATION_MAX_ATTEMPTS` visits.
 */
async function resolveUnmadeCopy(
  deps: StalledDeps,
  row: PipelinePublicationRow,
  now: number,
): Promise<"resolved" | "unresolved"> {
  const { db } = deps;
  const volume = await db
    .select({
      restricted: pipelineVolumes.restricted,
      state: pipelineVolumes.state,
      lastRunId: pipelineVolumes.lastRunId,
    })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.id, row.pipelineVolumeId), eq(pipelineVolumes.tenantId, row.tenantId)))
    .get();
  if (!volume || volume.state !== "ready" || volume.lastRunId !== row.runId) {
    await countAttempt(db, row, "failed");
    return "unresolved";
  }
  let head: { etag: string; sha256: string | null } | null;
  try {
    head = await deps.canonical.head(row.canonicalKey);
  } catch {
    await countAttempt(db, row, "failed");
    return "unresolved";
  }
  if (head === null || head.sha256 !== row.manifestSha256) {
    await countAttempt(db, row, "failed");
    return "unresolved";
  }
  if (isRestricted(volume)) {
    await holdForPerson(db, row, "restricted_after_copy", "failed");
    return "unresolved";
  }
  const input = await finalInputFromRow(db, row);
  if (input === null) {
    await countAttempt(db, row, "failed");
    return "unresolved";
  }
  try {
    await db.batch(
      buildFinalStatements(db, input, now, COPY_NOT_MADE) as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
    );
  } catch (err) {
    logClass("finishing a failed copy failed", err);
    await countAttempt(db, row, "failed").catch((e) => logClass("counting an attempt failed", e));
    return "unresolved";
  }
  return "resolved";
}

/**
 * Finishes or fails one publication left in flight past its expiry. A
 * `claimed` row is abandoned: no put can have happened from it. A
 * `copying` row is decided by reading the canonical key: the
 * publication's own bytes there run the final batch, unless the
 * volume has been flagged restricted since (or its row cannot be read),
 * which holds the row for a person instead; a key untouched since the claim fails the row; a
 * failed read counts an attempt; anything else holds the row for a
 * person. A `failed` row whose copy was judged not made is looked at
 * again by `resolveUnmadeCopy`. Every write is guarded by the row's id,
 * tenant, claim and expected status. A row that is not stale, or that
 * waits for a person, is left alone.
 */
export async function resolveStalledPublication(
  deps: StalledDeps,
  row: PipelinePublicationRow,
  now: number,
): Promise<"resolved" | "unresolved" | "not_stale"> {
  const { db } = deps;
  if (row.needsPerson) return "not_stale";
  if (isUnmadeCopy(row)) return resolveUnmadeCopy(deps, row, now);
  if (!isStale(row, now)) return "not_stale";

  if (row.status === "claimed") {
    await db
      .update(pipelinePublications)
      .set({ status: "abandoned", finishedAt: now, error: JSON.stringify({ class: "claim_expired" }) })
      .where(and(eq(pipelinePublications.tenantId, row.tenantId), guardOf(row, "claimed")));
    return "resolved";
  }

  let head: { etag: string; sha256: string | null } | null;
  try {
    head = await deps.canonical.head(row.canonicalKey);
  } catch {
    await db
      .update(pipelinePublications)
      .set({ resolveAttempts: sql`${pipelinePublications.resolveAttempts} + 1` })
      .where(and(eq(pipelinePublications.tenantId, row.tenantId), guardOf(row, "copying")));
    return "unresolved";
  }

  if (head !== null && head.sha256 === row.manifestSha256) {
    const input = await finalInputFromRow(db, row);
    if (input === null) return "unresolved";
    const volume = await db
      .select({ restricted: pipelineVolumes.restricted })
      .from(pipelineVolumes)
      .where(and(eq(pipelineVolumes.id, row.pipelineVolumeId), eq(pipelineVolumes.tenantId, row.tenantId)))
      .get();
    if (isRestricted(volume)) {
      await holdForPerson(db, row, "restricted_after_copy");
      return "unresolved";
    }
    try {
      await db.batch(buildFinalStatements(db, input, now) as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    } catch (err) {
      logClass("finishing a stalled publication failed", err);
      return "unresolved";
    }
    return "resolved";
  }

  const expect = JSON.parse(row.canonicalExpect) as { absent?: true; etag?: string };
  if ((head === null && expect.absent === true) || (head !== null && head.etag === expect.etag)) {
    await db
      .update(pipelinePublications)
      .set({ status: "failed", finishedAt: now, error: JSON.stringify({ class: COPY_NOT_MADE }) })
      .where(and(eq(pipelinePublications.tenantId, row.tenantId), guardOf(row, "copying")));
    return "resolved";
  }

  await holdForPerson(db, row, "canonical_changed");
  return "unresolved";
}

/**
 * The stalled rows one sweep visits, across tenants: claims and copies
 * past their expiry, and failed rows whose copy was judged not made,
 * that no person has been asked to decide and whose attempts are not
 * spent, fewest attempts first, then oldest. This read
 * runs with no tenant, like the sweep's token expiry; every write that
 * follows names the row's own tenant.
 */
export async function selectStalledPublications(
  db: DrizzleD1Database<any>,
  now: number,
): Promise<PipelinePublicationRow[]> {
  const cutoff = now - PUBLISH_CLAIM_TTL_MS;
  return db
    .select()
    .from(pipelinePublications)
    .where(
      and(
        eq(pipelinePublications.needsPerson, false),
        lt(pipelinePublications.resolveAttempts, SWEEP_PUBLICATION_MAX_ATTEMPTS),
        or(
          and(eq(pipelinePublications.status, "claimed"), lte(pipelinePublications.claimedAt, cutoff)),
          and(eq(pipelinePublications.status, "copying"), lte(pipelinePublications.copyingAt, cutoff)),
          and(
            eq(pipelinePublications.status, "failed"),
            sql`json_extract(${pipelinePublications.error}, '$.class') = ${COPY_NOT_MADE}`,
          ),
        ),
      ),
    )
    .orderBy(
      asc(pipelinePublications.resolveAttempts),
      asc(sql`coalesce(${pipelinePublications.copyingAt}, ${pipelinePublications.claimedAt})`),
      asc(pipelinePublications.id),
    )
    .limit(SWEEP_PUBLICATIONS)
    .all();
}

/**
 * What the sweep needs to resolve rows across tenants: the canonical
 * store of each row's tenant, or null when that tenant's destination is
 * not set up.
 */
export interface SweepStalledDeps {
  db: DrizzleD1Database<any>;
  canonicalFor: (tenantId: string) => Promise<CanonicalManifestStore | null>;
}

/**
 * The sweep's publication step: resolves up to `SWEEP_PUBLICATIONS`
 * stalled rows, each against its own tenant's canonical store. A row
 * whose tenant has no destination is left as it is and counts an
 * attempt, so it sinks below rows the sweep can decide.
 */
export async function resolveStalledPublications(
  deps: SweepStalledDeps,
  now: number,
): Promise<{ resolved: number; unresolved: number }> {
  let resolved = 0;
  let unresolved = 0;
  const stores = new Map<string, CanonicalManifestStore | null>();
  for (const row of await selectStalledPublications(deps.db, now)) {
    if (!stores.has(row.tenantId)) stores.set(row.tenantId, await deps.canonicalFor(row.tenantId));
    const canonical = stores.get(row.tenantId) ?? null;
    if (canonical === null) {
      await deps.db
        .update(pipelinePublications)
        .set({ resolveAttempts: sql`${pipelinePublications.resolveAttempts} + 1` })
        .where(and(eq(pipelinePublications.tenantId, row.tenantId), eq(pipelinePublications.id, row.id)));
      unresolved++;
      continue;
    }
    const outcome = await resolveStalledPublication({ db: deps.db, canonical }, row, now);
    if (outcome === "resolved") resolved++;
    else if (outcome === "unresolved") unresolved++;
  }
  return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The settings the publish route reads; the tenant's secrets are read by name. */
export interface PublishEnv extends PipelineStoreEnv {
  DB: D1Database;
  PIPELINE_PUBLISH_ENABLED?: string;
}

const destinationUnsetStore: CanonicalManifestStore = {
  head: () => Promise.reject(new TenantDestinationError([])),
  get: () => Promise.reject(new TenantDestinationError([])),
  put: () => Promise.reject(new TenantDestinationError([])),
};

function manifestTarget(destination: TenantDestination) {
  return {
    endpoint: destination.manifestEndpoint,
    bucket: destination.manifestBucket,
    keyId: destination.manifestWrite.keyId,
    secretKey: destination.manifestWrite.secretKey,
  };
}

/**
 * The deps the route builds from its environment and the request's
 * tenant. Nothing here reads a setting that may be missing: the object
 * reader is built at its first read, so missing reader settings answer
 * `publish_unconfigured` after the gate rather than an error before it.
 * Publishing is on only where `PIPELINE_PUBLISH_ENABLED` is exactly
 * `"true"`. The tenant's federation row is read here. The canonical store
 * writes to the federation's manifest bucket with its manifest key; the
 * reader reads page text from the federation's tiles bucket with its
 * read key; the locator accepts `{slug}/iiif/{reference_code}/manifest.json`
 * under the federation's `manifest_base_url`, the key behind the id
 * dispatch builds under `{manifest_base_url}/{slug}`. A tenant whose
 * destination is incomplete gets deps that refuse every publish with
 * `tenant_destination_unset`.
 */
export async function publishDepsFromEnv(
  env: PublishEnv,
  tenant: TenantStorageRef,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<PublishDeps> {
  const db = drizzle(env.DB, { schema });
  const base = {
    db,
    specBucket: env.SPEC_BUCKET,
    workingBucket: env.PIPELINE_WORKING_BUCKET ?? "",
    publishEnabled: env.PIPELINE_PUBLISH_ENABLED === "true",
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };
  let destination: TenantDestination;
  try {
    destination = await resolveTenantDestination(db, tenant, env);
  } catch (err) {
    if (!(err instanceof TenantDestinationError)) throw err;
    return {
      ...base,
      reader: { getText: () => Promise.reject(err) },
      canonical: destinationUnsetStore,
      locator: defaultCanonicalManifestLocator,
      tilesBucket: "",
      destinationUnset: true,
    };
  }
  const tiles = {
    endpoint: destination.deliveryEndpoint,
    bucket: destination.tilesBucket,
    keyId: destination.deliveryRead.keyId,
    secretKey: destination.deliveryRead.secretKey,
  };
  return {
    ...base,
    reader: { getText: (bucket, key) => getMediaObjectReader(env, fetchImpl, tiles).getText(bucket, key) },
    canonical: s3CanonicalManifestStore(manifestTarget(destination), fetchImpl),
    locator: prefixLocator(destination.federationManifestBaseUrl, destination.manifestKeyPrefix),
    tilesBucket: destination.tilesBucket,
  };
}

/**
 * The canonical store of a tenant, for the sweep, which has no request:
 * the tenant's row and its federation's are read here. Null when the
 * tenant has no complete destination. The store takes full keys, as the
 * publication rows record them.
 */
export async function canonicalStoreForTenant(
  env: PublishEnv,
  tenantId: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<CanonicalManifestStore | null> {
  const db = drizzle(env.DB, { schema });
  const row = await db
    .select({ id: schema.tenants.id, slug: schema.tenants.slug, federationId: schema.tenants.federationId })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .get();
  if (!row) return null;
  try {
    const destination = destinationFor(row, await readTenantFederation(db, row), env);
    return s3CanonicalManifestStore(manifestTarget(destination), fetchImpl);
  } catch (err) {
    if (err instanceof TenantDestinationError) return null;
    throw err;
  }
}

const publishBodySchema = z.object({ run_id: z.string().min(1) }).strict();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The publish request: the capability and federation-lead gate first
 * (a bare 404 or 403), then the JSON body `{ "run_id": ... }`, then the
 * publish. Answers 200 with the publication, or the refusal's status
 * with its code; a 503 carries the code alone.
 */
export async function publishVolumeAction(
  deps: PublishDeps,
  request: Request,
  volumeId: string,
  tenant: Parameters<typeof requireMediaPipelineAccess>[1],
  user: Parameters<typeof requireMediaPipelineAccess>[2],
): Promise<Response> {
  await requireMediaPipelineAccess(deps.db, tenant, user);
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_request", detail: "malformed_json" });
  }
  const body = publishBodySchema.safeParse(parsed);
  if (!body.success) {
    return jsonResponse(400, {
      error: "invalid_request",
      detail: [...new Set(body.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", "),
    });
  }
  try {
    const result = await publishVolume(deps, tenant, user, { volumeId, runId: body.data.run_id });
    return jsonResponse(200, {
      publication_id: result.publicationId,
      canonical_url: result.canonicalUrl,
      ocr_pages_written: result.ocrPagesWritten,
      retirement_status: result.retirementStatus,
    });
  } catch (err) {
    if (err instanceof PublishRefusal) {
      return jsonResponse(
        err.status,
        err.status === 503 ? { error: err.code } : { error: err.code, ...err.detail },
      );
    }
    throw err;
  }
}

// @version v0.8.0
