/**
 * Publish — a Description's Own Manifest
 *
 * This module deals with keeping the fields a description's own IIIF
 * manifest carries from its record in step with the record, as part of
 * the catalogue publish. A description's own manifest is the one at its
 * own reference code under the federation's manifest address,
 * `{manifest_base_url}/iiif/{reference_code}/manifest.json`, or the same
 * under its tenant's slug, as `resolveManifestInputs` names it
 * (`app/lib/pipeline/manifest-inputs.ts`). It carries three values from
 * the record, built by `manifestRecordFields`:
 *
 *   - `label`: the title;
 *   - `summary`: the scope and content, left out when it is not set;
 *   - the label of the homepage entry whose `id` is the description's
 *     page on the tenant's public site.
 *
 * `refreshOwnManifests` reads the stored manifest, compares those three
 * with the values built from the row as it stands, and, when one
 * differs, writes the manifest back with those values replaced and every
 * other byte as it was, the way the attribution refresh rewrites
 * `requiredStatement`, `provider` and `rights`
 * (`app/lib/pipeline/manifest-refresh-run.server.ts`): the same S3
 * store, the same retries, a write only on the etag read, the stored
 * HTTP and custom metadata written again (a recorded `sha256` replaced
 * with the digest of the new bytes), and the object read back and
 * compared byte for byte. Values are written in the text's style
 * (`textStyleOf`, `serializeInStyle` in `manifest-refresh.ts`). A
 * homepage value whose text is not what that style writes is not
 * rewritten (`format_unsupported`), so nothing in it but its label can
 * change. A field the manifest lacks is inserted where the held-manifest
 * order puts it; a summary whose scope was cleared is removed. A
 * manifest with no homepage, or none at the description's page, keeps
 * its homepage as it is.
 *
 * Which descriptions are read. Only the published descriptions of the
 * fonds that have their own manifest, and of those only the ones whose
 * record changed since the fonds' descriptions file was last written: a
 * record's version (`updated_at`) moves whenever a field it publishes
 * changes (`record-version.server.ts`), and the fonds' fingerprint
 * marker (`fingerprint.server.ts`) names the publish that last wrote
 * the file. The records read are those whose version is at or after the
 * time that publish was created (`export_runs.created_at`). The workflow
 * runs this before the fonds' descriptions step, so a publish whose
 * refresh fails records no fingerprint, and the next publish reads from
 * the same time again. A fonds with no marker, and a forced publish,
 * read every own manifest of the fonds.
 *
 * The work is done a batch at a time (`OWN_MANIFEST_BATCH_SIZE`
 * descriptions, in id order, `OWN_MANIFEST_CONCURRENCY` manifests at
 * once); each call takes the state the last one returned and returns
 * the next, `done` when the descriptions ran out. A batch takes two D1
 * reads (the fonds' root and its descriptions) and, when it has rows, a
 * third (manifest URLs shared with another description). A manifest
 * already current takes one read of the bucket; one rewritten takes
 * three (read, write, read back), without retries. The first call also
 * reads the marker and the run it names.
 *
 * Each manifest gets one outcome, counted in the state:
 *
 *   - `unchanged`: the three already hold the built values;
 *   - `written`: rewritten and read back as written;
 *   - `missing`: no object at the key;
 *   - `skipped`: the URL names a key the attribution refresh would not
 *     touch (`manifestKeyOf`), another description names the same URL,
 *     the object is content-encoded, not UTF-8, not a JSON object, or its
 *     `id` is not the description's URL, or the splice refuses its text;
 *   - `unavailable`: the federation has no manifest bucket, so no
 *     destination to refresh; nothing is read and a warning is logged.
 *     A federation with neither a bucket nor a manifest address logs the
 *     same warning before anything is read.
 *
 * Every destination field is read trimmed, and the trimmed values are
 * the ones checked (`manifestWriteMissing`) and used: a value of
 * whitespace alone counts as missing, and a padded one counts as its
 * trimmed self.
 *
 * A federation with a manifest bucket whose destination lacks anything
 * else the write needs (`manifestWriteMissing`: endpoint, address,
 * secret prefix, either write secret) fails the step with
 * `OwnManifestDestinationError`, naming what is missing, when the fonds
 * has a manifest to refresh: the run fails, the fonds' fingerprint is
 * not recorded, and the next publish reads the same records again. A
 * federation with a bucket but no manifest address fails the same way
 * before anything is read, since its own manifests cannot be named. A
 * URL another description also names is checked over every URL of the
 * batch (`sharedUrlsAmong`, asked for as many as the batch has rows).
 *
 * A write refused by its condition (someone wrote the object after it
 * was read), a read-back that does not hold the bytes written, and a
 * storage failure that outlasts the retries throw, so the step is tried
 * again and reads the object afresh.
 *
 * The counts are informational and can under-report writes: when a write
 * lands but its read-back fails past its retries, the step's next attempt
 * finds the manifest current and counts it `unchanged`. The manifest
 * holds the right values either way.
 *
 * @version v0.9.0
 */

import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, exportRuns, tenants } from "../../db/schema";
import { manifestRecordFields } from "../pipeline/manifest-inputs";
import {
  HELD_MANIFEST_ORDER,
  ManifestSpliceError,
  manifestKeyOf,
  scanTopLevel,
  serializeInStyle,
  textStyleOf,
} from "../pipeline/manifest-refresh";
import {
  findFederation,
  manifestWriteMissing,
  s3ManifestObjectStore,
  sameBytes,
  sharedUrlsAmong,
  withRetry,
  type ManifestObjectStore,
  type StoredManifest,
} from "../pipeline/manifest-refresh-run.server";
import { firstDifference } from "../pipeline/json-difference";
import { destinationSecretNames, readSecret } from "../pipeline/tenant-destination.server";
import { sha256Hex } from "../pipeline/publish.server";
import { readFingerprints, type FingerprintStorage } from "./fingerprint.server";
import type { ExportTenant } from "./types";

/** Descriptions read per batch, and so per workflow step. */
export const OWN_MANIFEST_BATCH_SIZE = 200;
/** Manifests handled at once within a batch. */
export const OWN_MANIFEST_CONCURRENCY = 6;

export type OwnManifestOutcome = "unchanged" | "written" | "missing" | "skipped" | "unavailable";

/** The fields this module rewrites, in their held-manifest order. */
type RecordField = "label" | "homepage" | "summary";

export interface OwnManifestState {
  /** Records at or after this version are read; null for every record. */
  since: number | null;
  /** The id of the last description read. */
  after: string | null;
  done: boolean;
  counts: Partial<Record<OwnManifestOutcome, number>>;
}

export interface OwnManifestDeps {
  db: DrizzleD1Database<any>;
  env: object;
  storage: FingerprintStorage;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export interface OwnManifestOptions {
  force: boolean;
  /** The state the previous call returned; absent on the first. */
  state?: OwnManifestState;
  batchSize?: number;
}

/** A federation with a manifest bucket whose destination lacks a piece; fails the step. */
export class OwnManifestDestinationError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`The federation's manifest destination is incomplete: it lacks ${missing.join(", ")}`);
    this.name = "OwnManifestDestinationError";
    this.missing = missing;
  }
}

/** A write that did not land as meant; the step is tried again. */
export class OwnManifestWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnManifestWriteError";
  }
}

/**
 * The time from which the fonds' records count as changed: the creation
 * of the publish that last wrote its descriptions file, or null when no
 * such publish is recorded.
 */
export async function ownManifestsSince(
  db: DrizzleD1Database<any>,
  storage: FingerprintStorage,
  slug: string,
  fondsCode: string,
): Promise<number | null> {
  const entry = (await readFingerprints(storage, slug, fondsCode)).descriptions;
  if (!entry || typeof entry.exportId !== "string") return null;
  const run = await db
    .select({ createdAt: exportRuns.createdAt })
    .from(exportRuns)
    .where(eq(exportRuns.id, entry.exportId))
    .get();
  return run?.createdAt ?? null;
}

function has(doc: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(doc, key);
}

function bump(counts: OwnManifestState["counts"], outcome: OwnManifestOutcome, by = 1): void {
  counts[outcome] = (counts[outcome] ?? 0) + by;
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/**
 * The manifest text with each of `values` set: replaced in place,
 * inserted where the held-manifest order puts it, or removed when null.
 * Everything else is the input's text. Throws `ManifestSpliceError` for
 * text it will not rewrite.
 */
export function spliceRecordFields(text: string, values: Partial<Record<RecordField, unknown | null>>): string {
  const top = scanTopLevel(text);
  const seen = new Set<string>();
  for (const m of top.members) {
    if (seen.has(m.key)) {
      throw new ManifestSpliceError("duplicate_key", `The manifest names ${JSON.stringify(m.key)} twice`);
    }
    seen.add(m.key);
  }
  const style = textStyleOf(text, top);
  const { members } = top;
  const prefix = members.length > 0 ? text.slice(0, members[0].start) : text.slice(0, top.close);
  const suffix = members.length > 0 ? text.slice(members[members.length - 1].end) : text.slice(top.close);
  const parts = members.map((m) => ({ key: m.key, raw: text.slice(m.start, m.end) }));

  for (const field of ["label", "homepage", "summary"] as const) {
    if (!(field in values)) continue;
    const value = values[field] ?? null;
    const at = parts.findIndex((p) => p.key === field);
    if (at >= 0) {
      const m = members.find((mm) => mm.key === field)!;
      if (value === null) parts.splice(at, 1);
      else parts[at] = { key: field, raw: text.slice(m.start, m.valueStart) + serializeInStyle(value, style) };
      continue;
    }
    if (value === null) continue;
    const raw = `${serializeInStyle(field, style)}${style.keySep}${serializeInStyle(value, style)}`;
    const order = HELD_MANIFEST_ORDER.indexOf(field);
    let anchor = -1;
    for (let j = order - 1; j >= 0 && anchor < 0; j--) {
      anchor = parts.findIndex((p) => p.key === HELD_MANIFEST_ORDER[j]);
    }
    parts.splice(anchor + 1, 0, { key: field, raw });
  }
  return prefix + parts.map((p) => p.raw).join(style.itemSep) + suffix;
}

/** Whether the manifest's homepage text is what its style writes, so a rewrite changes only its label. */
function homepageInStyle(text: string): boolean {
  const top = scanTopLevel(text);
  const m = top.members.find((mm) => mm.key === "homepage");
  if (!m) return true;
  return serializeInStyle(JSON.parse(text.slice(m.valueStart, m.end)), textStyleOf(text, top)) === text.slice(m.valueStart, m.end);
}

/** The first way `after` is not `before` with `values` set, or null. */
function checkRecordSplice(
  before: string,
  after: string,
  values: Partial<Record<RecordField, unknown | null>>,
): string | null {
  let old: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    old = JSON.parse(before);
    next = JSON.parse(after);
  } catch {
    return "unparseable";
  }
  const touched = (k: string) => k in values;
  const oldKeys = Object.keys(old).filter((k) => !touched(k));
  const newKeys = Object.keys(next).filter((k) => !touched(k));
  if (oldKeys.join("\u0000") !== newKeys.join("\u0000")) return "key_order";
  for (const k of oldKeys) {
    const d = firstDifference(next[k], old[k], `$.${k}`);
    if (d !== null) return d;
  }
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined) {
      if (has(next, k)) return `$.${k}`;
    } else if (!has(next, k) || firstDifference(next[k], v) !== null) {
      return `$.${k}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One manifest
// ---------------------------------------------------------------------------

interface OwnRow {
  id: string;
  referenceCode: string;
  title: string;
  scopeContent: string | null;
  manifestUrl: string;
  tenantSlug: string;
  publicSiteUrl: string | null;
}

/** The values the manifest should hold for each field it differs in; empty when current. */
function changesFor(doc: Record<string, unknown>, row: OwnRow): Partial<Record<RecordField, unknown | null>> {
  const built = manifestRecordFields(row, row);
  const changes: Partial<Record<RecordField, unknown | null>> = {};
  if (!has(doc, "label") || firstDifference(doc.label, built.label) !== null) changes.label = built.label;
  if (built.summary === null) {
    if (has(doc, "summary")) changes.summary = null;
  } else if (!has(doc, "summary") || firstDifference(doc.summary, built.summary) !== null) {
    changes.summary = built.summary;
  }
  const home = built.homepage;
  if (home !== null && Array.isArray(doc.homepage)) {
    let differs = false;
    const next = doc.homepage.map((entry) => {
      if (typeof entry !== "object" || entry === null || (entry as { id?: unknown }).id !== home.id) return entry;
      if (firstDifference((entry as { label?: unknown }).label, home.label) === null) return entry;
      differs = true;
      return { ...(entry as Record<string, unknown>), label: home.label };
    });
    if (differs) changes.homepage = next;
  }
  return changes;
}

async function refreshOne(
  deps: OwnManifestDeps,
  store: ManifestObjectStore,
  baseUrl: string,
  row: OwnRow,
): Promise<OwnManifestOutcome> {
  const located = manifestKeyOf(row.manifestUrl, baseUrl, row.tenantSlug);
  if ("refusal" in located) return "skipped";
  const { key } = located;

  const stored = await withRetry(deps, () => store.get(key));
  if (stored === null) return "missing";
  if (stored.httpMetadata["content-encoding"] !== undefined) return "skipped";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stored.bytes);
  } catch {
    return "skipped";
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return "skipped";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "skipped";
  const manifest = doc as Record<string, unknown>;
  if (manifest.id !== row.manifestUrl) return "skipped";

  const changes = changesFor(manifest, row);
  if (Object.keys(changes).length === 0) return "unchanged";

  let next: string;
  try {
    if ("homepage" in changes && !homepageInStyle(text)) return "skipped";
    next = spliceRecordFields(text, changes);
  } catch (err) {
    if (err instanceof ManifestSpliceError) return "skipped";
    throw err;
  }
  const wrong = checkRecordSplice(text, next, changes);
  if (wrong !== null) {
    console.warn(`own manifest ${key}: the rewritten text fails its check at ${wrong}`);
    return "skipped";
  }
  await write(deps, store, key, stored, new TextEncoder().encode(next));
  return "written";
}

/** Puts `bytes` over `stored` on its etag and reads them back; throws when they did not land. */
async function write(
  deps: OwnManifestDeps,
  store: ManifestObjectStore,
  key: string,
  stored: StoredManifest,
  bytes: Uint8Array,
): Promise<void> {
  const customMetadata = { ...stored.customMetadata };
  if (customMetadata.sha256 !== undefined) customMetadata.sha256 = await sha256Hex(bytes);
  let uncertain = false;
  const written = await withRetry(
    deps,
    () => store.put(key, bytes, stored.etag, stored.httpMetadata, customMetadata),
    () => {
      uncertain = true;
    },
  );
  const back = await withRetry(deps, () => store.get(key));
  if (written === null) {
    // A write retried after an unanswered attempt finds its own bytes.
    if (uncertain && back !== null && sameBytes(back.bytes, bytes)) return;
    throw new OwnManifestWriteError(`${key} was written by someone else after it was read`);
  }
  if (back === null || !sameBytes(back.bytes, bytes)) {
    throw new OwnManifestWriteError(`${key} does not hold the bytes written`);
  }
}

// ---------------------------------------------------------------------------
// A batch
// ---------------------------------------------------------------------------

/**
 * One batch of the fonds' own manifests (module header): the state
 * after it, `done` when the fonds' changed descriptions ran out.
 */
export async function refreshOwnManifests(
  deps: OwnManifestDeps,
  tenant: ExportTenant,
  fondsCode: string,
  options: OwnManifestOptions,
): Promise<OwnManifestState> {
  const { db } = deps;
  const state: OwnManifestState = options.state
    ? { ...options.state, counts: { ...options.state.counts } }
    : {
        since: options.force ? null : await ownManifestsSince(db, deps.storage, tenant.slug, fondsCode),
        after: null,
        done: false,
        counts: {},
      };
  if (state.done) return state;
  const finish = () => ({ ...state, done: true });

  const federation = await findFederation(db, tenant.federationId);
  if (federation === null) return finish();
  // Every destination field is read trimmed: a value of whitespace alone is missing.
  const trimmed = (v: string | null) => (v ?? "").trim();
  const destination = {
    ...federation,
    manifestEndpoint: trimmed(federation.manifestEndpoint),
    manifestBucket: trimmed(federation.manifestBucket),
    manifestBaseUrl: trimmed(federation.manifestBaseUrl),
    storageSecretPrefix: trimmed(federation.storageSecretPrefix),
  };
  const baseUrl = destination.manifestBaseUrl.replace(/\/+$/, "");
  const bucket = destination.manifestBucket;
  const noBucket = () => {
    console.warn(`publish: ${fondsCode}'s own manifests are not refreshed; the federation has no manifest bucket`);
  };
  if (baseUrl === "") {
    // Without the address no manifest can be named as a description's own.
    if (bucket !== "") throw new OwnManifestDestinationError(["manifest_base_url"]);
    noBucket();
    return finish();
  }

  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(and(eq(descriptions.referenceCode, fondsCode), eq(descriptions.tenantId, tenant.id)))
    .get();
  if (!root) return finish();

  const size = options.batchSize ?? OWN_MANIFEST_BATCH_SIZE;
  const own = sql`${descriptions.iiifManifestUrl} IN (
    ${baseUrl} || '/iiif/' || ${descriptions.referenceCode} || '/manifest.json',
    ${baseUrl} || '/' || ${tenants.slug} || '/iiif/' || ${descriptions.referenceCode} || '/manifest.json')`;
  const rows = (await db
    .select({
      id: descriptions.id,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      scopeContent: descriptions.scopeContent,
      manifestUrl: descriptions.iiifManifestUrl,
      tenantSlug: tenants.slug,
      publicSiteUrl: tenants.publicSiteUrl,
    })
    .from(descriptions)
    .innerJoin(tenants, eq(tenants.id, descriptions.tenantId))
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true),
        own,
        state.since === null ? undefined : gte(descriptions.updatedAt, state.since),
        state.after === null ? undefined : gt(descriptions.id, state.after),
      ),
    )
    .orderBy(asc(descriptions.id))
    .limit(size)
    .all()) as OwnRow[];
  if (rows.length === 0) return finish();
  state.after = rows[rows.length - 1].id;
  if (rows.length < size) state.done = true;

  // A federation with no manifest bucket has no destination to refresh;
  // one with a bucket but an incomplete destination fails the step, so
  // the fonds' fingerprint is not recorded past edits left unrefreshed.
  if (bucket === "") {
    noBucket();
    bump(state.counts, "unavailable", rows.length);
    return finish();
  }
  const missing = manifestWriteMissing(destination, deps.env);
  if (missing.length > 0) {
    throw new OwnManifestDestinationError(missing);
  }
  const names = destinationSecretNames(destination.storageSecretPrefix);
  const store = s3ManifestObjectStore(
    {
      endpoint: destination.manifestEndpoint,
      bucket,
      keyId: readSecret(deps.env, names.MANIFEST_WRITE_KEY_ID) as string,
      secretKey: readSecret(deps.env, names.MANIFEST_WRITE_SECRET_KEY) as string,
    },
    deps.fetchImpl,
  );

  // A URL another description of the federation names is decided by neither.
  // Asked for as many as the batch has rows, so the list is complete.
  const shared = new Set(await sharedUrlsAmong(db, tenant.federationId, rows.map((r) => r.manifestUrl), rows.length));
  const outcomes: OwnManifestOutcome[] = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      outcomes[i] = shared.has(rows[i].manifestUrl) ? "skipped" : await refreshOne(deps, store, baseUrl, rows[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OWN_MANIFEST_CONCURRENCY, rows.length) }, worker));
  for (const outcome of outcomes) bump(state.counts, outcome);
  return state;
}

// @version v0.9.0
