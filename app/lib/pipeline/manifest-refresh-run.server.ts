/**
 * Media Pipeline — Manifest Attribution Refresh, the Run
 *
 * This module deals with refreshing the attribution of every published
 * manifest of one federation: for each description of the federation's
 * tenants that has a manifest URL, it reads the manifest from the
 * federation's manifest bucket, works out the `requiredStatement`,
 * `provider` and `rights` that `resolveManifestInputs` builds now from
 * the description's repository, its tenant and the federation's
 * hosting statement, and, in an apply run, writes the manifest back
 * with those three fields replaced and nothing else changed
 * (`manifest-refresh.ts` does the text). A dry run reads and reports
 * and writes nothing. The workflow (`app/workflows/manifest-refresh.ts`)
 * drives it a batch at a time.
 *
 * `manifestWriteMissing(federation, env)` lists what the federation
 * lacks for the run: its `manifest_endpoint`, `manifest_bucket`,
 * `manifest_base_url` and a well-formed `storage_secret_prefix`, and the
 * two manifest write secrets named from the prefix
 * (`{prefix}_MANIFEST_WRITE_KEY_ID`, `{prefix}_MANIFEST_WRITE_SECRET_KEY`).
 * It names columns and secrets, never values. The run needs nothing
 * else of the media pipeline's destination. `findFederation(db, ref)`
 * reads a federation by id or slug. `loadRefreshConfig` reads the
 * federation and its hosting statement and returns what every batch
 * needs, without any key: a workflow keeps step results, so the keys
 * are read from the environment inside each step (`refreshTargetOf`).
 *
 * `s3ManifestObjectStore(target, fetchImpl)` reads and writes the
 * manifest bucket over the S3 API with the federation's manifest write
 * key, signed as the canonical store signs (`canonical.server.ts`). A
 * read returns the bytes as stored, the etag without quotes, the HTTP
 * metadata (content type, cache control, disposition, encoding,
 * language, expiry) and the custom `x-amz-meta-*` metadata. A write
 * sends the bytes with that metadata again, since an S3 PUT replaces an
 * object's metadata, and only on `If-Match` with the etag read; a 412
 * answer returns null and writes nothing. Any other answer that is not
 * a success throws `RefreshStoreError` with its status (null when the
 * request did not complete).
 *
 * `refreshBatch(deps, config, cursor, size)` reads the next `size`
 * descriptions after `cursor`, in reference-code order (then id), with
 * their repository and tenant, and handles up to `REFRESH_CONCURRENCY`
 * manifests at a time. A run may be narrowed to one repository, by
 * code, and to the first `limit` descriptions in that order; the cursor
 * carries how many have been read, so the limit holds across batches
 * (`loadRefreshConfig` takes both as options;
 * `federationHasRepository` checks a code against the federation), and
 * to the descriptions after a given one (`after`, its reference code and
 * id, so equal reference codes in two tenants are neither skipped nor
 * taken twice). The report gives `next_after`, where the next instance
 * starts, so instances of at most `REFRESH_MAX_LIMIT` can be chained over
 * a whole federation.
 * Each manifest gets one outcome:
 *
 *   - `skipped`, with the reason, when its URL is not under the
 *     federation's manifest address or names a key outside `iiif/`
 *     (`manifestKeyOf`), when the object is content-encoded, is not
 *     UTF-8 or not JSON, when its `id` is not the description's URL, or
 *     when its text is one the splice refuses. Nothing is written;
 *   - `refused` when the repository has no manifest rights
 *     (`repository_rights_unset`), or when the tenant has no provider
 *     and the manifest names one (`provider_unset`): a provider is never
 *     replaced with an empty list. A manifest with no provider, or an
 *     empty one, keeps it as it is;
 *   - `missing` when there is no object at the key;
 *   - `unchanged` when the three fields already hold the computed
 *     values and the run has no record for the manifest (see below).
 *     Nothing is written, so an apply run repeated after a partial
 *     failure touches only what still differs;
 *   - `would_change` in a dry run, with the fields that differ;
 *   - `written` in an apply run when the write succeeded and the object
 *     read back is, byte for byte, the text written. A recorded
 *     `sha256` custom value is replaced with the digest of the new
 *     bytes; every other metadata value is written as read;
 *   - `conflict` when the write's condition failed: someone else wrote
 *     the object after it was read. It is not retried;
 *   - `failed` for any other error, with its reason.
 *
 * A read or write answered with a status of 500 or above, 429, or no
 * answer at all is retried after `RETRY_DELAYS_MS`; a write retried that
 * way and then refused by its condition is read back, and counts as
 * written when the object holds the bytes it sent. Before any write the
 * new text is checked (`checkSplice`): a text that would change
 * anything but the three fields fails the manifest instead.
 *
 * The write's condition is the etag read, and an object's etag follows
 * its body: an update that changed only an object's metadata between
 * the read and the write would not fail the condition, and the write
 * would put back the metadata read. Nothing else makes metadata-only
 * updates to these objects; publishing changes the body.
 *
 * An apply run keeps a record of every write in `BUCKET`, at
 * `reports/manifest-refresh/{slug}/{instance}/items/{SHA-256 of the
 * key}.json` (`refreshRecords`). It is written once, only when none is
 * there (`If-None-Match: *`), before the write, with status `pending`:
 * the key, the description and repository, the three fields as read,
 * the object's etag and the SHA-256 of its bytes (`before_etag`,
 * `before_sha256`), the three fields to be written and the SHA-256 of
 * the exact bytes to be put (`after_sha256`). Afterwards only its status,
 * the outcome's reason and its time change, on the record's own etag.
 * A dry run writes no record. Each batch lists the run's records once.
 *
 * In an apply run, each manifest's outcome is decided by this table,
 * from the record and the object, never from the fields the rows give
 * when a later attempt runs:
 *
 *   record   | object read now                    | outcome
 *   ---------|------------------------------------|-------------------------
 *   none     | fields current                     | `unchanged`, no record
 *   none     | fields differ                      | claim, write on
 *            |                                    | `before_etag`, read back:
 *            |                                    | written/conflict/failed
 *   written, | not read                           | as recorded, no write
 *   conflict,|                                    |
 *   failed   |                                    |
 *   pending  | unreadable                         | `failed` now, record left
 *            |                                    | pending
 *   pending  | SHA-256 = `after_sha256`           | `written` (it landed)
 *   pending  | etag = `before_etag`               | write the record's bytes
 *            |                                    | (spliced from the object
 *            |                                    | with the record's after-
 *            |                                    | values, checked against
 *            |                                    | `after_sha256`, else
 *            |                                    | `failed`
 *            |                                    | `replay_digest_mismatch`)
 *   pending  | absent, or any other etag          | `conflict`
 *            |                                    | (`changed_by_other_writer`),
 *            |                                    | no write
 *
 * The table rests on two preconditions, both checked by the batch that
 * writes, at its start, so that each object is decided by one
 * description of one apply instance:
 *
 *   - the instance holds its federation's lock (`refreshLockKey`,
 *     `reports/manifest-refresh/{slug}/apply.lock`): present, naming
 *     this instance, not released (`refreshLockHeld`). The route takes
 *     the lock with `If-None-Match: *`, or over a released lock or one
 *     whose instance is definitely stopped, on that lock's etag
 *     (`claimRefreshLock`); the workflow releases only its own lock,
 *     when its report is written (`releaseRefreshLock`). A batch whose
 *     instance does not hold the lock, as after a restart or a takeover,
 *     fails with `lock_not_held` before it reads anything;
 *   - each URL the batch is about to touch names one description of the
 *     federation as the rows stand when the batch runs (one query over
 *     the batch's URLs); otherwise the batch fails with
 *     `duplicate_manifest_url` before any write. The workflow's
 *     `check-urls` step checks the whole federation first, to fail fast.
 *
 * Both failures are not retried. Without the first, a second instance
 * could write over an object between this instance's write and its
 * replay; without the second, two descriptions could decide one object.
 *
 * No other case exists. A key has a record or none; a record's status
 * is one of the four; a pending record's object is unreadable, absent,
 * or read. A read object either holds exactly the bytes this run meant
 * to put, or does not; if it does not, its etag either is the one first
 * read or is not. The rows do not overlap: the intended bytes differ
 * from the first-read bytes (a manifest is only written when a field
 * differs), and an object's etag follows its body, so an object holding
 * the intended bytes cannot carry `before_etag`. A claim lost to an
 * attempt that claimed the key in between goes to the record rows. A
 * `failed` record is not retried within the instance; a later instance
 * has records of its own and reads the object afresh. Every outcome of
 * a write is reported from its record, with its before-values.
 *
 * Subrequests: a manifest that is written takes five (read, claim the
 * record, write, read back, set the outcome), a current one in an apply
 * run one, and a dry run one per manifest; each batch of an apply run
 * adds one listing of the records per 1,000, and a manifest with a
 * record one read of it; each batch of an apply run also reads the lock
 * once. An instance, held to `REFRESH_MAX_LIMIT` (1,500) descriptions in
 * batches of `REFRESH_BATCH_SIZE` (8 batches), takes at most about 7,500
 * + 8 listings + 8 lock reads, some 7,520, without retries, plus two D1
 * queries per batch (the descriptions and their shared URLs).
 *
 * The batch result lists every manifest's outcome and, per repository,
 * a sample of the three fields before and after: the first manifest
 * whose fields differ, and the first that is already current.
 * `newRefreshReport` and `addRefreshBatch` build the run's report from
 * batch results alone, so a workflow replayed from its stored step
 * results builds the same report: counts per outcome, counts and one
 * sample per repository (one whose fields differ when there is one),
 * the limit and repository the run was narrowed to,
 * and every outcome other than `unchanged`. `writeRefreshReport` puts it
 * as JSON in the deployment's `BUCKET` at `refreshReportKey(slug,
 * instance)`, `reports/manifest-refresh/{federation slug}/{instance}.json`.
 *
 * The catalogue publish (`app/lib/export/own-manifests.server.ts`)
 * reads and writes a description's own manifest with the same store,
 * retries (`withRetry`), byte comparison (`sameBytes`), failure
 * reasons (`storeReason`) and shared-URL check (`sharedUrlsAmong`).
 *
 * Nothing here names an archive, a site or a federation; every value
 * comes from rows.
 *
 * @version v0.9.0
 */

import { and, asc, eq, gt, isNotNull, ne, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, federations, repositories, tenants } from "../../db/schema";
import type { FederationHosting } from "../export/attribution";
import { readFederationHosting } from "./dispatch.server";
import { resolveManifestInputs } from "./manifest-inputs";
import {
  ManifestSpliceError,
  REFRESH_FIELDS,
  checkSplice,
  currentValuesOf,
  differingFields,
  manifestKeyOf,
  refreshValuesOf,
  spliceRefreshFields,
  type RefreshField,
  type RefreshValues,
} from "./manifest-refresh";
import { ManifestInputsError } from "./run-spec";
import { s3Client, s3ObjectUrl, s3Send, unquote, type S3BucketTarget } from "./canonical.server";
import { destinationSecretNames, readSecret, SECRET_PREFIX_PATTERN } from "./tenant-destination.server";
import { sha256Hex } from "./publish.server";

export type RefreshMode = "dry_run" | "apply";

export type RefreshOutcome =
  | "would_change"
  | "written"
  | "unchanged"
  | "refused"
  | "skipped"
  | "missing"
  | "conflict"
  | "failed";

/**
 * The most descriptions one instance may take. A Workflow instance has
 * 10,000 subrequests by default. A written manifest takes five, so 1,500
 * take at most 7,500 in an apply run, and 1,500 in a dry run; the rest,
 * 2,500, is room for retries, the record listings, the D1 reads and the
 * report. A federation larger than this is refreshed by instances
 * chained on `after`.
 */
export const REFRESH_MAX_LIMIT = 1500;

/** Descriptions read per batch, and so per workflow step. */
export const REFRESH_BATCH_SIZE = 200;
/** Manifests handled at once within a batch. */
export const REFRESH_CONCURRENCY = 6;
/** The waits before each retry of a transient storage answer. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 2000, 8000];

// ---------------------------------------------------------------------------
// The federation
// ---------------------------------------------------------------------------

export type RefreshFederationRow = Pick<
  typeof federations.$inferSelect,
  "id" | "slug" | "manifestEndpoint" | "manifestBucket" | "manifestBaseUrl" | "storageSecretPrefix"
>;

function set(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const WRITE_SECRETS = ["MANIFEST_WRITE_KEY_ID", "MANIFEST_WRITE_SECRET_KEY"] as const;

/** What the federation lacks for a refresh, by column and secret suffix. */
export function manifestWriteMissing(federation: RefreshFederationRow, env: object): string[] {
  const missing: string[] = [];
  if (!set(federation.manifestEndpoint)) missing.push("manifest_endpoint");
  if (!set(federation.manifestBucket)) missing.push("manifest_bucket");
  if (!set(federation.manifestBaseUrl)) missing.push("manifest_base_url");
  const prefix = federation.storageSecretPrefix;
  const valid = set(prefix) && SECRET_PREFIX_PATTERN.test(prefix);
  if (!valid) missing.push("storage_secret_prefix");
  const names = valid ? destinationSecretNames(prefix) : null;
  for (const suffix of WRITE_SECRETS) {
    if (names === null || readSecret(env, names[suffix]) === undefined) missing.push(`secret:${suffix}`);
  }
  return missing;
}

const FEDERATION_COLUMNS = {
  id: federations.id,
  slug: federations.slug,
  manifestEndpoint: federations.manifestEndpoint,
  manifestBucket: federations.manifestBucket,
  manifestBaseUrl: federations.manifestBaseUrl,
  storageSecretPrefix: federations.storageSecretPrefix,
};

/** A federation by its id or its slug, or null. */
export async function findFederation(
  db: DrizzleD1Database<any>,
  ref: string,
): Promise<RefreshFederationRow | null> {
  const row = await db
    .select(FEDERATION_COLUMNS)
    .from(federations)
    .where(or(eq(federations.id, ref), eq(federations.slug, ref)))
    .get();
  return row ?? null;
}

export class RefreshConfigError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "RefreshConfigError";
    this.missing = missing;
  }
}

/** What every batch needs; no key. */
export interface RefreshConfig {
  federationId: string;
  federationSlug: string;
  manifestEndpoint: string;
  manifestBucket: string;
  manifestBaseUrl: string;
  storageSecretPrefix: string;
  hosting: FederationHosting | null;
  mode: RefreshMode;
  /** At most this many descriptions, the first by reference code; null for all. */
  limit: number | null;
  /** Only this repository's descriptions, by code; null for every repository. */
  repositoryCode: string | null;
  /** Only descriptions that sort after this one (reference code, then id); null from the start. */
  after: RefreshPosition | null;
}

/** A description's place in the order a run reads in. */
export interface RefreshPosition {
  reference_code: string;
  id: string;
}

export interface RefreshOptions {
  limit?: number;
  repository?: string;
  after?: RefreshPosition;
}

export async function loadRefreshConfig(
  db: DrizzleD1Database<any>,
  env: object,
  federationId: string,
  mode: RefreshMode,
  options: RefreshOptions = {},
): Promise<RefreshConfig> {
  const federation = await db
    .select(FEDERATION_COLUMNS)
    .from(federations)
    .where(eq(federations.id, federationId))
    .get();
  if (!federation) throw new RefreshConfigError(`Federation ${federationId} not found`);
  const missing = manifestWriteMissing(federation, env);
  if (missing.length > 0) {
    throw new RefreshConfigError(`Federation ${federation.slug} has no complete manifest destination`, missing);
  }
  return {
    federationId: federation.id,
    federationSlug: federation.slug,
    manifestEndpoint: federation.manifestEndpoint as string,
    manifestBucket: federation.manifestBucket as string,
    manifestBaseUrl: (federation.manifestBaseUrl as string).replace(/\/+$/, ""),
    storageSecretPrefix: federation.storageSecretPrefix as string,
    hosting: await readFederationHosting(db, federation.id),
    mode,
    limit: options.limit ?? null,
    repositoryCode: options.repository ?? null,
    after: options.after ?? null,
  };
}

/** Whether one of the federation's tenants holds a repository with this code. */
export async function federationHasRepository(
  db: DrizzleD1Database<any>,
  federationId: string,
  code: string,
): Promise<boolean> {
  const row = await db
    .select({ id: repositories.id })
    .from(repositories)
    .innerJoin(tenants, eq(tenants.id, repositories.tenantId))
    .where(and(eq(tenants.federationId, federationId), eq(repositories.code, code)))
    .get();
  return row !== undefined;
}

/** The manifest bucket with the federation's write key, read from the environment. */
export function refreshTargetOf(config: RefreshConfig, env: object): S3BucketTarget {
  const names = destinationSecretNames(config.storageSecretPrefix);
  const keyId = readSecret(env, names.MANIFEST_WRITE_KEY_ID);
  const secretKey = readSecret(env, names.MANIFEST_WRITE_SECRET_KEY);
  if (keyId === undefined || secretKey === undefined) {
    throw new RefreshConfigError("The federation's manifest write key is not set", [
      ...(keyId === undefined ? ["secret:MANIFEST_WRITE_KEY_ID"] : []),
      ...(secretKey === undefined ? ["secret:MANIFEST_WRITE_SECRET_KEY"] : []),
    ]);
  }
  return { endpoint: config.manifestEndpoint, bucket: config.manifestBucket, keyId, secretKey };
}

// ---------------------------------------------------------------------------
// The manifest bucket
// ---------------------------------------------------------------------------

export interface StoredManifest {
  etag: string;
  bytes: Uint8Array;
  /** HTTP metadata by lower-case header name. */
  httpMetadata: Record<string, string>;
  /** Custom metadata, without the `x-amz-meta-` prefix. */
  customMetadata: Record<string, string>;
}

export interface ManifestObjectStore {
  get(key: string): Promise<StoredManifest | null>;
  /** null when the object's etag is not `ifMatch`. */
  put(
    key: string,
    bytes: Uint8Array,
    ifMatch: string,
    httpMetadata: Record<string, string>,
    customMetadata: Record<string, string>,
  ): Promise<{ etag: string } | null>;
}

/** A precondition of writing that failed in a batch; the batch is not retried. */
export class RefreshPreconditionError extends Error {
  readonly code: "lock_not_held" | "duplicate_manifest_url";
  readonly detail: string[];
  constructor(code: RefreshPreconditionError["code"], detail: string[] = []) {
    super(detail.length > 0 ? `${code}: ${detail.join(" ")}` : code);
    this.name = "RefreshPreconditionError";
    this.code = code;
    this.detail = detail;
  }
}

export class RefreshStoreError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "RefreshStoreError";
    this.status = status;
  }
}

const HTTP_METADATA = [
  "content-type",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "expires",
] as const;
const META_PREFIX = "x-amz-meta-";

export function s3ManifestObjectStore(
  target: S3BucketTarget,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): ManifestObjectStore {
  const client = s3Client(target);
  const send = async (key: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }) => {
    const url = s3ObjectUrl(target, key);
    try {
      return await s3Send(client, fetchImpl, url, init);
    } catch (err) {
      throw new RefreshStoreError(`${init.method} ${key} did not complete: ${err instanceof Error ? err.name : "error"}`, null);
    }
  };
  return {
    async get(key) {
      const res = await send(key, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new RefreshStoreError(`GET ${key} answered ${res.status}`, res.status);
      const etag = unquote(res.headers.get("ETag"));
      if (etag === null) throw new RefreshStoreError(`GET ${key} gave no etag`, res.status);
      const httpMetadata: Record<string, string> = {};
      for (const name of HTTP_METADATA) {
        const value = res.headers.get(name);
        if (value !== null) httpMetadata[name] = value;
      }
      const customMetadata: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        if (name.toLowerCase().startsWith(META_PREFIX)) customMetadata[name.toLowerCase().slice(META_PREFIX.length)] = value;
      });
      return { etag, bytes: new Uint8Array(await res.arrayBuffer()), httpMetadata, customMetadata };
    },

    async put(key, bytes, ifMatch, httpMetadata, customMetadata) {
      const headers: Record<string, string> = { ...httpMetadata, "If-Match": `"${ifMatch}"` };
      for (const [name, value] of Object.entries(customMetadata)) headers[`${META_PREFIX}${name}`] = value;
      const res = await send(key, { method: "PUT", headers, body: bytes as unknown as BodyInit });
      if (res.status === 412) return null;
      if (!res.ok) throw new RefreshStoreError(`PUT ${key} answered ${res.status}`, res.status);
      const etag = unquote(res.headers.get("ETag"));
      if (etag === null) throw new RefreshStoreError(`PUT ${key} gave no etag`, res.status);
      return { etag };
    },
  };
}

function isTransient(err: unknown): boolean {
  return err instanceof RefreshStoreError && (err.status === null || err.status >= 500 || err.status === 429);
}

export interface RefreshDeps {
  db: DrizzleD1Database<any>;
  store: ManifestObjectStore;
  sleep: (ms: number) => Promise<void>;
  /** The run's write records; required to apply, null in a dry run. */
  records: RefreshRecords | null;
  /** Whether this instance holds its federation's lock; required to apply, null in a dry run. */
  lock: (() => Promise<boolean>) | null;
}

/** `fn`, retried after each of `RETRY_DELAYS_MS` while it fails transiently. */
export async function withRetry<T>(deps: Pick<RefreshDeps, "sleep">, fn: () => Promise<T>, onRetry?: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      onRetry?.();
      await deps.sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function has(doc: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(doc, key);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// One manifest
// ---------------------------------------------------------------------------

export interface RefreshItem {
  description_id: string;
  reference_code: string;
  repository_code: string;
  key: string | null;
  outcome: RefreshOutcome;
  reason?: string;
  fields?: RefreshField[];
  /** For an outcome of a write: the three fields, etag and SHA-256 of the object as read before it. */
  before?: RefreshValues;
  before_etag?: string;
  before_sha256?: string;
}

// ---------------------------------------------------------------------------
// The write records
// ---------------------------------------------------------------------------

export type RefreshRecordStatus = "pending" | "written" | "conflict" | "failed";

/**
 * What an apply run keeps for one manifest it writes. It is written once,
 * before the write, with status `pending`; afterwards only its status,
 * the outcome's reason and its time change, conditional on the record's
 * own etag. The before- and after-values are never replaced.
 */
export interface RefreshRecord {
  key: string;
  description_id: string;
  reference_code: string;
  repository_id: string;
  repository_code: string;
  repository_name: string;
  status: RefreshRecordStatus;
  reason?: string;
  fields: RefreshField[];
  before: RefreshValues;
  before_etag: string;
  before_sha256: string;
  after: RefreshValues;
  /** The SHA-256 of the exact bytes the write puts. */
  after_sha256: string;
  updated_at: number;
}

/** A record with the etag it was read or written with. */
export interface HeldRecord {
  record: RefreshRecord;
  etag: string;
}

export interface RefreshRecords {
  /** Writes the record when there is none for its key; otherwise returns the one there. */
  claim(record: RefreshRecord): Promise<{ claimed: true; held: HeldRecord } | { claimed: false; held: HeldRecord | null }>;
  get(key: string): Promise<HeldRecord | null>;
  /** Sets the status and reason, if the record is still `held`; false when it is not. */
  settle(held: HeldRecord, status: RefreshRecordStatus, reason?: string): Promise<boolean>;
  /** The name a key's record has, or would have. */
  nameOf(key: string): Promise<string>;
  /** The names of every record of the run. */
  list(): Promise<string[]>;
  read(name: string): Promise<RefreshRecord | null>;
}

export function refreshRecordPrefix(federationSlug: string, instanceId: string): string {
  return `${REFRESH_REPORT_PREFIX}${federationSlug}/${instanceId}/items/`;
}

/** The record of one object key: its SHA-256, so any key names one record. */
export async function refreshRecordKey(federationSlug: string, instanceId: string, objectKey: string): Promise<string> {
  return `${refreshRecordPrefix(federationSlug, instanceId)}${await sha256Hex(new TextEncoder().encode(objectKey))}.json`;
}

export function refreshRecords(bucket: R2Bucket, federationSlug: string, instanceId: string): RefreshRecords {
  const at = (key: string) => refreshRecordKey(federationSlug, instanceId, key);
  const options = { httpMetadata: { contentType: "application/json" } };
  const readAt = async (name: string): Promise<HeldRecord | null> => {
    const obj = await bucket.get(name);
    return obj === null ? null : { record: (await obj.json()) as RefreshRecord, etag: obj.etag };
  };
  return {
    async claim(record) {
      const name = await at(record.key);
      const put = await bucket.put(name, JSON.stringify(record), {
        ...options,
        onlyIf: new Headers({ "If-None-Match": "*" }),
      });
      if (put !== null) return { claimed: true, held: { record, etag: put.etag } };
      return { claimed: false, held: await readAt(name) };
    },
    async get(key) {
      return readAt(await at(key));
    },
    nameOf: at,
    async settle(held, status, reason) {
      const { reason: _previous, ...rest } = held.record;
      const record: RefreshRecord = { ...rest, status, ...(reason ? { reason } : {}), updated_at: Date.now() };
      const put = await bucket.put(await at(record.key), JSON.stringify(record), {
        ...options,
        onlyIf: { etagMatches: held.etag },
      });
      return put !== null;
    },
    async list() {
      const prefix = refreshRecordPrefix(federationSlug, instanceId);
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        names.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return names;
    },
    async read(name) {
      return (await readAt(name))?.record ?? null;
    },
  };
}

export interface RefreshSample {
  repository_code: string;
  reference_code: string;
  /** Whether the fields differ from the computed ones. */
  changed: boolean;
  before: RefreshValues;
  after: RefreshValues;
}

interface RefreshRow {
  descriptionId: string;
  referenceCode: string;
  title: string;
  dateExpression: string | null;
  extent: string | null;
  language: string | null;
  accessConditions: string | null;
  scopeContent: string | null;
  manifestUrl: string | null;
  tenantSlug: string;
  publicSiteUrl: string | null;
  publicSiteName: string | null;
  providerName: string | null;
  providerUrl: string | null;
  metsBaseUrl: string | null;
  repositoryId: string;
  repositoryCode: string;
  repositoryName: string;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  manifestRights: string | null;
  creditStatementEs: string | null;
  creditStatementEn: string | null;
  attributionEn: string | null;
  attributionEs: string | null;
}

function beforeOf(record: RefreshRecord): Pick<RefreshItem, "before" | "before_etag" | "before_sha256"> {
  return { before: record.before, before_etag: record.before_etag, before_sha256: record.before_sha256 };
}

/** A report item from a record, with the outcome it ends in. */
function itemOfRecord(record: RefreshRecord, outcome: RefreshOutcome, reason?: string): RefreshItem {
  return {
    description_id: record.description_id,
    reference_code: record.reference_code,
    repository_code: record.repository_code,
    key: record.key,
    outcome,
    ...(reason ? { reason } : {}),
    fields: record.fields,
    ...beforeOf(record),
  };
}

function sampleOfRecord(record: RefreshRecord): RefreshSample {
  return {
    repository_code: record.repository_code,
    reference_code: record.reference_code,
    changed: true,
    before: record.before,
    after: record.after,
  };
}

/** Sets a record's outcome; a record left as it was is read again by a later attempt. */
async function settle(
  records: RefreshRecords,
  held: HeldRecord,
  status: Exclude<RefreshRecordStatus, "pending">,
  reason?: string,
): Promise<{ item: RefreshItem; sample: RefreshSample }> {
  try {
    if (!(await records.settle(held, status, reason))) {
      console.error("manifest refresh: record changed before its outcome was set");
    }
  } catch (err) {
    console.error(`manifest refresh: record not updated: ${err instanceof Error ? err.name : "error"}`);
  }
  return { item: itemOfRecord(held.record, status, reason), sample: sampleOfRecord(held.record) };
}

export function storeReason(err: unknown): string {
  if (err instanceof RefreshStoreError) return err.status === null ? "store_unreachable" : `store_${err.status}`;
  return err instanceof Error ? err.name : "error";
}

/**
 * Puts the record's intended bytes over `current` (the object as first
 * read, whose etag is the record's `before_etag`), on that etag, reads
 * the object back and sets the record's outcome.
 */
async function writeRecorded(
  deps: RefreshDeps,
  records: RefreshRecords,
  held: HeldRecord,
  current: StoredManifest,
  bytes: Uint8Array,
): Promise<{ item: RefreshItem; sample: RefreshSample }> {
  const { key } = held.record;
  const customMetadata = { ...current.customMetadata };
  if (customMetadata.sha256 !== undefined) customMetadata.sha256 = held.record.after_sha256;
  let uncertain = false;
  let written: { etag: string } | null;
  try {
    written = await withRetry(
      deps,
      () => deps.store.put(key, bytes, held.record.before_etag, current.httpMetadata, customMetadata),
      () => {
        uncertain = true;
      },
    );
  } catch (err) {
    return settle(records, held, "failed", storeReason(err));
  }
  let back: StoredManifest | null;
  try {
    back = await withRetry(deps, () => deps.store.get(key));
  } catch (err) {
    return settle(records, held, "failed", `verify_${storeReason(err)}`);
  }
  if (written === null) {
    // A write retried after an unanswered attempt finds its own bytes.
    if (uncertain && back !== null && sameBytes(back.bytes, bytes)) return settle(records, held, "written");
    return settle(records, held, "conflict");
  }
  if (back === null) return settle(records, held, "failed", "verify_missing");
  if (!sameBytes(back.bytes, bytes)) return settle(records, held, "failed", "verify_mismatch");
  return settle(records, held, "written");
}

/**
 * The outcome of a manifest that already has a record in this run,
 * decided from the record and the object alone, never from the fields
 * the rows give now. See the decision table in the module header.
 */
async function fromRecord(
  deps: RefreshDeps,
  records: RefreshRecords,
  held: HeldRecord,
): Promise<{ item: RefreshItem; sample: RefreshSample }> {
  const { record } = held;
  if (record.status !== "pending") {
    return { item: itemOfRecord(record, record.status, record.reason), sample: sampleOfRecord(record) };
  }
  let current: StoredManifest | null;
  try {
    current = await withRetry(deps, () => deps.store.get(record.key));
  } catch (err) {
    // Left pending: a later attempt reads the object again.
    return { item: itemOfRecord(record, "failed", storeReason(err)), sample: sampleOfRecord(record) };
  }
  if (current !== null && (await sha256Hex(current.bytes)) === record.after_sha256) {
    return settle(records, held, "written");
  }
  if (current === null || current.etag !== record.before_etag) {
    return settle(records, held, "conflict", "changed_by_other_writer");
  }
  // The object is the one first read: the write never landed. Make it now,
  // with the bytes the record names.
  let bytes: Uint8Array;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current.bytes);
    bytes = new TextEncoder().encode(spliceRefreshFields(text, record.after));
  } catch {
    return settle(records, held, "failed", "replay_digest_mismatch");
  }
  if ((await sha256Hex(bytes)) !== record.after_sha256) {
    return settle(records, held, "failed", "replay_digest_mismatch");
  }
  return writeRecorded(deps, records, held, current, bytes);
}

async function refreshOne(
  deps: RefreshDeps,
  config: RefreshConfig,
  row: RefreshRow,
  existing: ReadonlySet<string> | null,
): Promise<{ item: RefreshItem; sample: RefreshSample | null }> {
  const url = row.manifestUrl as string;
  const base = {
    description_id: row.descriptionId,
    reference_code: row.referenceCode,
    repository_code: row.repositoryCode,
  };
  const done = (item: Omit<RefreshItem, keyof typeof base>, sample: RefreshSample | null = null) => ({
    item: { ...base, ...item },
    sample,
  });

  const located = manifestKeyOf(url, config.manifestBaseUrl, row.tenantSlug);
  if ("refusal" in located) return done({ key: null, outcome: "skipped", reason: located.refusal });
  const { key } = located;

  const records = config.mode === "apply" ? deps.records : null;
  if (config.mode === "apply" && records === null) {
    return done({ key, outcome: "failed", reason: "records_unavailable" });
  }
  // Looked up only when the batch's listing names it, so a manifest
  // without a record costs no read of one.
  if (records !== null && existing !== null && existing.has(await records.nameOf(key))) {
    let held: HeldRecord | null;
    try {
      held = await records.get(key);
    } catch (err) {
      return done({ key, outcome: "failed", reason: `record_unreadable:${err instanceof Error ? err.name : "error"}` });
    }
    if (held !== null) return fromRecord(deps, records, held);
  }

  let values: RefreshValues;
  try {
    values = refreshValuesOf(
      resolveManifestInputs(
        config.manifestBaseUrl,
        row.referenceCode,
        row,
        {
          id: row.repositoryId,
          code: row.repositoryCode,
          name: row.repositoryName,
          city: row.city,
          region: row.region,
          country: row.country,
          countryCode: row.countryCode,
          manifestRights: row.manifestRights,
          creditStatementEs: row.creditStatementEs,
          creditStatementEn: row.creditStatementEn,
          attributionEn: row.attributionEn,
          attributionEs: row.attributionEs,
        },
        row,
        config.hosting,
      ),
    );
  } catch (err) {
    if (err instanceof ManifestInputsError && err.code === "repository_rights_unset") {
      return done({ key, outcome: "refused", reason: err.code });
    }
    if (err instanceof ManifestInputsError) return done({ key, outcome: "failed", reason: err.code });
    throw err;
  }

  let stored: StoredManifest | null;
  try {
    stored = await withRetry(deps, () => deps.store.get(key));
  } catch (err) {
    return done({ key, outcome: "failed", reason: storeReason(err) });
  }
  if (stored === null) return done({ key, outcome: "missing" });
  if (stored.httpMetadata["content-encoding"] !== undefined) {
    return done({ key, outcome: "skipped", reason: "content_encoded" });
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stored.bytes);
  } catch {
    return done({ key, outcome: "skipped", reason: "not_utf8" });
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return done({ key, outcome: "skipped", reason: "not_json" });
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return done({ key, outcome: "skipped", reason: "not_json_object" });
  }
  const manifest = doc as Record<string, unknown>;
  if (manifest.id !== url) return done({ key, outcome: "skipped", reason: "id_mismatch" });

  // A tenant without a provider never empties a manifest's provider: a
  // non-empty one is refused, and an absent or empty one is left as it is.
  if (Array.isArray(values.provider) && values.provider.length === 0) {
    const held = has(manifest, "provider") ? manifest.provider : undefined;
    if (held !== undefined && !(Array.isArray(held) && held.length === 0)) {
      return done({ key, outcome: "refused", reason: "provider_unset" });
    }
    values = { ...values, provider: held === undefined ? null : held };
  }

  const fields = differingFields(manifest, values);
  const sample: RefreshSample = {
    repository_code: row.repositoryCode,
    reference_code: row.referenceCode,
    changed: fields.length > 0,
    before: currentValuesOf(manifest),
    after: values,
  };
  if (fields.length === 0) return done({ key, outcome: "unchanged" }, sample);

  let next: string;
  try {
    next = spliceRefreshFields(text, values);
  } catch (err) {
    if (err instanceof ManifestSpliceError) return done({ key, outcome: "skipped", reason: err.code, fields }, sample);
    throw err;
  }
  const wrong = checkSplice(text, next, values);
  if (wrong !== null) return done({ key, outcome: "failed", reason: `splice_check:${wrong}`, fields }, sample);

  if (config.mode === "dry_run") return done({ key, outcome: "would_change", fields }, sample);

  if (records === null) return done({ key, outcome: "failed", reason: "records_unavailable", fields }, sample);
  const bytes = new TextEncoder().encode(next);
  const record: RefreshRecord = {
    key,
    description_id: row.descriptionId,
    reference_code: row.referenceCode,
    repository_id: row.repositoryId,
    repository_code: row.repositoryCode,
    repository_name: row.repositoryName,
    status: "pending",
    fields,
    before: currentValuesOf(manifest),
    before_etag: stored.etag,
    before_sha256: await sha256Hex(stored.bytes),
    after: values,
    after_sha256: await sha256Hex(bytes),
    updated_at: Date.now(),
  };
  let claim: Awaited<ReturnType<RefreshRecords["claim"]>>;
  try {
    claim = await records.claim(record);
  } catch (err) {
    return done({ key, outcome: "failed", reason: `record_unwritten:${err instanceof Error ? err.name : "error"}`, fields }, sample);
  }
  if (!claim.claimed) {
    // Another attempt claimed it between the lookup and now.
    if (claim.held === null) return done({ key, outcome: "failed", reason: "record_unreadable", fields }, sample);
    return fromRecord(deps, records, claim.held);
  }
  return writeRecorded(deps, records, claim.held, stored, bytes);
}

// ---------------------------------------------------------------------------
// A batch
// ---------------------------------------------------------------------------

/** Where the next batch starts: after this description, with `seen` read so far. */
export interface RefreshCursor {
  reference_code: string;
  id: string;
  seen: number;
}

export interface RefreshBatchResult {
  cursor: RefreshCursor | null;
  /** True when the descriptions ran out before the limit. */
  exhausted: boolean;
  /** True when this batch read fewer descriptions than it asked for, or reached the limit. */
  done: boolean;
  items: RefreshItem[];
  /** Per repository: the first sample whose fields differ and the first that is current. */
  samples: RefreshSample[];
  repositories: Record<string, { repository_id: string; name: string }>;
}

async function readBatch(
  db: DrizzleD1Database<any>,
  config: RefreshConfig,
  cursor: RefreshCursor | null,
  size: number,
): Promise<RefreshRow[]> {
  const conditions = [
    eq(tenants.federationId, config.federationId),
    isNotNull(descriptions.iiifManifestUrl),
    ne(descriptions.iiifManifestUrl, ""),
  ];
  if (config.repositoryCode !== null) conditions.push(eq(repositories.code, config.repositoryCode));
  const from = cursor ?? config.after;
  if (from !== null) {
    conditions.push(
      or(
        gt(descriptions.referenceCode, from.reference_code),
        and(eq(descriptions.referenceCode, from.reference_code), gt(descriptions.id, from.id)),
      )!,
    );
  }
  return db
    .select({
      descriptionId: descriptions.id,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      dateExpression: descriptions.dateExpression,
      extent: descriptions.extent,
      language: descriptions.language,
      accessConditions: descriptions.accessConditions,
      scopeContent: descriptions.scopeContent,
      manifestUrl: descriptions.iiifManifestUrl,
      tenantSlug: tenants.slug,
      publicSiteUrl: tenants.publicSiteUrl,
      publicSiteName: tenants.publicSiteName,
      providerName: tenants.providerName,
      providerUrl: tenants.providerUrl,
      metsBaseUrl: tenants.metsBaseUrl,
      repositoryId: repositories.id,
      repositoryCode: repositories.code,
      repositoryName: repositories.name,
      city: repositories.city,
      region: repositories.region,
      country: repositories.country,
      countryCode: repositories.countryCode,
      manifestRights: repositories.manifestRights,
      creditStatementEs: repositories.creditStatementEs,
      creditStatementEn: repositories.creditStatementEn,
      attributionEn: repositories.attributionEn,
      attributionEs: repositories.attributionEs,
    })
    .from(descriptions)
    .innerJoin(tenants, eq(tenants.id, descriptions.tenantId))
    .innerJoin(repositories, eq(repositories.id, descriptions.repositoryId))
    .where(and(...conditions))
    .orderBy(asc(descriptions.referenceCode), asc(descriptions.id))
    .limit(size)
    .all() as Promise<RefreshRow[]>;
}

export async function refreshBatch(
  deps: RefreshDeps,
  config: RefreshConfig,
  cursor: RefreshCursor | null,
  size: number = REFRESH_BATCH_SIZE,
): Promise<RefreshBatchResult> {
  // Checked here, where the writes are, before anything is read: a
  // restarted instance, or one whose lock was taken over, writes nothing.
  if (config.mode === "apply" && (deps.lock === null || !(await deps.lock()))) {
    throw new RefreshPreconditionError("lock_not_held");
  }
  const seen = cursor?.seen ?? 0;
  const wanted = config.limit === null ? size : Math.max(0, Math.min(size, config.limit - seen));
  const rows = wanted === 0 ? [] : await readBatch(deps.db, config, cursor, wanted);
  // Every URL this batch is about to touch must name one description of
  // the federation, as it is now, not as it was when the run began.
  if (rows.length > 0) {
    const shared = await sharedUrlsAmong(deps.db, config.federationId, rows.map((r) => r.manifestUrl as string));
    if (shared.length > 0) throw new RefreshPreconditionError("duplicate_manifest_url", shared);
  }
  // The run's records, listed once per batch: one listing per 1,000.
  const existing =
    config.mode === "apply" && deps.records !== null && rows.length > 0 ? new Set(await deps.records.list()) : null;
  const results: Array<{ item: RefreshItem; sample: RefreshSample | null }> = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        results[i] = await refreshOne(deps, config, rows[i], existing);
      } catch (err) {
        const row = rows[i];
        results[i] = {
          item: {
            description_id: row.descriptionId,
            reference_code: row.referenceCode,
            repository_code: row.repositoryCode,
            key: null,
            outcome: "failed",
            reason: err instanceof Error ? err.name : "error",
          },
          sample: null,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, rows.length) }, worker));

  const samples: RefreshSample[] = [];
  const repositoriesSeen: RefreshBatchResult["repositories"] = {};
  for (const row of rows) {
    repositoriesSeen[row.repositoryCode] ??= { repository_id: row.repositoryId, name: row.repositoryName };
  }
  for (const { sample } of results) {
    if (sample === null) continue;
    if (!samples.some((s) => s.repository_code === sample.repository_code && s.changed === sample.changed)) {
      samples.push(sample);
    }
  }
  return {
    cursor:
      rows.length > 0
        ? {
            reference_code: rows[rows.length - 1].referenceCode,
            id: rows[rows.length - 1].descriptionId,
            seen: seen + rows.length,
          }
        : cursor,
    exhausted: rows.length < wanted,
    done: rows.length < wanted || wanted === 0 || (config.limit !== null && seen + rows.length >= config.limit),
    items: results.map((r) => r.item),
    samples,
    repositories: repositoriesSeen,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type RefreshCounts = Partial<Record<RefreshOutcome, number>>;

export interface RefreshReport {
  kind: "manifest_refresh";
  instance_id: string;
  federation: { id: string; slug: string };
  manifest_base_url: string;
  mode: RefreshMode;
  limit: number | null;
  repository: string | null;
  after: RefreshPosition | null;
  /**
   * Where the next instance starts: the last description taken when the
   * limit was reached, null when the descriptions ran out.
   */
  next_after: RefreshPosition | null;
  status: "running" | "complete" | "failed";
  error: string | null;
  started_at: number;
  finished_at: number | null;
  fields: readonly RefreshField[];
  counts: RefreshCounts;
  repositories: Record<
    string,
    { repository_id: string; name: string; counts: RefreshCounts; sample: RefreshSample | null }
  >;
  /** Every outcome other than `unchanged`. */
  items: RefreshItem[];
}

export function newRefreshReport(config: RefreshConfig, instanceId: string, startedAt: number): RefreshReport {
  return {
    kind: "manifest_refresh",
    instance_id: instanceId,
    federation: { id: config.federationId, slug: config.federationSlug },
    manifest_base_url: config.manifestBaseUrl,
    mode: config.mode,
    limit: config.limit,
    repository: config.repositoryCode,
    after: config.after,
    next_after: null,
    status: "running",
    error: null,
    started_at: startedAt,
    finished_at: null,
    fields: REFRESH_FIELDS,
    counts: {},
    repositories: {},
    items: [],
  };
}

function bump(counts: RefreshCounts, outcome: RefreshOutcome): void {
  counts[outcome] = (counts[outcome] ?? 0) + 1;
}

export function addRefreshBatch(report: RefreshReport, batch: RefreshBatchResult): RefreshReport {
  const next: RefreshReport = {
    ...report,
    counts: { ...report.counts },
    repositories: Object.fromEntries(
      Object.entries(report.repositories).map(([code, r]) => [code, { ...r, counts: { ...r.counts } }]),
    ),
    items: [...report.items],
  };
  for (const [code, repo] of Object.entries(batch.repositories)) {
    next.repositories[code] ??= { ...repo, counts: {}, sample: null };
  }
  for (const item of batch.items) {
    bump(next.counts, item.outcome);
    bump(next.repositories[item.repository_code].counts, item.outcome);
    if (item.outcome !== "unchanged") next.items.push(item);
  }
  if (batch.done) {
    next.next_after =
      batch.exhausted || batch.cursor === null
        ? null
        : { reference_code: batch.cursor.reference_code, id: batch.cursor.id };
  }
  for (const sample of batch.samples) {
    const repo = next.repositories[sample.repository_code];
    if (repo.sample === null || (!repo.sample.changed && sample.changed)) repo.sample = sample;
  }
  return next;
}

/**
 * The report with every record of the run it does not yet hold: those
 * of a batch whose result was never kept, as when its retries ran out.
 * A record whose key an item of the report already names is in the
 * report already; only the others are read, so the fold reads at most
 * the records of the failed batch, plus one listing per 1,000 records.
 * A record still `pending` is reported `failed` with reason `pending`:
 * its write may or may not have landed.
 */
export async function foldRefreshRecords(report: RefreshReport, records: RefreshRecords): Promise<RefreshReport> {
  const known = new Set(
    await Promise.all(
      report.items
        .filter((i) => i.key !== null)
        .map((i) => refreshRecordKey(report.federation.slug, report.instance_id, i.key as string)),
    ),
  );
  const next: RefreshReport = {
    ...report,
    counts: { ...report.counts },
    repositories: Object.fromEntries(
      Object.entries(report.repositories).map(([code, r]) => [code, { ...r, counts: { ...r.counts } }]),
    ),
    items: [...report.items],
  };
  for (const name of await records.list()) {
    if (known.has(name)) continue;
    const record = await records.read(name);
    if (record === null) continue;
    const item =
      record.status === "pending" ? itemOfRecord(record, "failed", "pending") : itemOfRecord(record, record.status, record.reason);
    next.repositories[record.repository_code] ??= {
      repository_id: record.repository_id,
      name: record.repository_name,
      counts: {},
      sample: null,
    };
    bump(next.counts, item.outcome);
    bump(next.repositories[record.repository_code].counts, item.outcome);
    next.items.push(item);
  }
  return next;
}

export const REFRESH_REPORT_PREFIX = "reports/manifest-refresh/";

/** The lock an apply run of a federation holds while it runs. */
export function refreshLockKey(federationSlug: string): string {
  return `${REFRESH_REPORT_PREFIX}${federationSlug}/apply.lock`;
}

export interface RefreshLock {
  instance_id: string;
  started_at: number;
  /** Set when the holder released it; a released lock is free. */
  released_at?: number;
}

/** What can be said of a lock holder's instance. */
export type LockHolderState = "running" | "terminal" | "unverified";

/**
 * Takes the federation's apply lock for `instanceId`: on absence
 * (`If-None-Match: *`), or over a lock that is released or whose
 * instance `holderState` reports as definitely stopped (`terminal`), on
 * that lock's etag. Anything else is refused with the holder's id: a
 * running holder (`in_progress`), or one whose state cannot be
 * established (`unverified`), which is never taken over.
 */
export async function claimRefreshLock(
  bucket: R2Bucket,
  federationSlug: string,
  instanceId: string,
  holderState: (instanceId: string) => Promise<LockHolderState>,
): Promise<{ claimed: true } | { claimed: false; holder: string; reason: "in_progress" | "unverified" }> {
  const key = refreshLockKey(federationSlug);
  const body = JSON.stringify({ instance_id: instanceId, started_at: Date.now() } satisfies RefreshLock);
  const options = { httpMetadata: { contentType: "application/json" } };
  if ((await bucket.put(key, body, { ...options, onlyIf: new Headers({ "If-None-Match": "*" }) })) !== null) {
    return { claimed: true };
  }
  const held = await bucket.get(key);
  if (held === null) {
    // Released by deletion between the two calls; try once more on absence.
    const again = await bucket.put(key, body, { ...options, onlyIf: new Headers({ "If-None-Match": "*" }) });
    return again !== null ? { claimed: true } : { claimed: false, holder: "unknown", reason: "in_progress" };
  }
  const lock = (await held.json()) as RefreshLock;
  if (lock.released_at === undefined) {
    const state = await holderState(lock.instance_id);
    if (state === "running") return { claimed: false, holder: lock.instance_id, reason: "in_progress" };
    if (state === "unverified") return { claimed: false, holder: lock.instance_id, reason: "unverified" };
  }
  const taken = await bucket.put(key, body, { ...options, onlyIf: { etagMatches: held.etag } });
  if (taken !== null) return { claimed: true };
  const now = await bucket.get(key);
  return {
    claimed: false,
    holder: now === null ? "unknown" : ((await now.json()) as RefreshLock).instance_id,
    reason: "in_progress",
  };
}

/** Whether `instanceId` holds the federation's lock: present, its own, and not released. */
export async function refreshLockHeld(bucket: R2Bucket, federationSlug: string, instanceId: string): Promise<boolean> {
  const held = await bucket.get(refreshLockKey(federationSlug));
  if (held === null) return false;
  const lock = (await held.json()) as RefreshLock;
  return lock.instance_id === instanceId && lock.released_at === undefined;
}

/**
 * Releases the lock if `instanceId` holds it, on the lock's etag. An R2
 * delete takes no condition, so the lock is released by marking it,
 * conditionally, rather than deleting it; a lock another instance holds
 * is left as it is.
 */
export async function releaseRefreshLock(bucket: R2Bucket, federationSlug: string, instanceId: string): Promise<void> {
  const key = refreshLockKey(federationSlug);
  const held = await bucket.get(key);
  if (held === null) return;
  const lock = (await held.json()) as RefreshLock;
  if (lock.instance_id !== instanceId || lock.released_at !== undefined) return;
  await bucket.put(key, JSON.stringify({ ...lock, released_at: Date.now() } satisfies RefreshLock), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: held.etag },
  });
}

/** The manifest URLs that more than one of the federation's descriptions name, up to `max`. */
export async function duplicateManifestUrls(
  db: DrizzleD1Database<any>,
  federationId: string,
  max = 50,
): Promise<string[]> {
  const rows = await db
    .select({ url: descriptions.iiifManifestUrl })
    .from(descriptions)
    .innerJoin(tenants, eq(tenants.id, descriptions.tenantId))
    .where(
      and(
        eq(tenants.federationId, federationId),
        isNotNull(descriptions.iiifManifestUrl),
        ne(descriptions.iiifManifestUrl, ""),
      ),
    )
    .groupBy(descriptions.iiifManifestUrl)
    .having(sql`count(*) > 1`)
    .orderBy(asc(descriptions.iiifManifestUrl))
    .limit(max)
    .all();
  return rows.map((r) => r.url as string);
}

/**
 * Those of `urls` that more than one of the federation's descriptions
 * name, in one query, up to `max` (50 unless given). A caller that must
 * know every one passes at least the number of distinct URLs.
 */
export async function sharedUrlsAmong(
  db: DrizzleD1Database<any>,
  federationId: string,
  urls: string[],
  max = 50,
): Promise<string[]> {
  const rows = await db
    .select({ url: descriptions.iiifManifestUrl })
    .from(descriptions)
    .innerJoin(tenants, eq(tenants.id, descriptions.tenantId))
    .where(
      and(
        eq(tenants.federationId, federationId),
        sql`${descriptions.iiifManifestUrl} IN (SELECT value FROM json_each(${JSON.stringify([...new Set(urls)])}))`,
      ),
    )
    .groupBy(descriptions.iiifManifestUrl)
    .having(sql`count(*) > 1`)
    .orderBy(asc(descriptions.iiifManifestUrl))
    .limit(max)
    .all();
  return rows.map((r) => r.url as string);
}

/** The report of a run that failed before its first batch. */
export async function writeRefreshFailure(
  bucket: R2Bucket,
  federation: { id: string; slug: string },
  instanceId: string,
  mode: RefreshMode,
  error: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const key = refreshReportKey(federation.slug, instanceId);
  await bucket.put(
    key,
    JSON.stringify({
      kind: "manifest_refresh",
      instance_id: instanceId,
      federation,
      mode,
      status: "failed",
      error,
      ...extra,
      finished_at: Date.now(),
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return key;
}

export function refreshReportKey(federationSlug: string, instanceId: string): string {
  return `${REFRESH_REPORT_PREFIX}${federationSlug}/${instanceId}.json`;
}

/** Puts the report in `bucket` with its finish time and returns its key. */
export async function writeRefreshReport(
  bucket: R2Bucket,
  report: RefreshReport,
  finishedAt: number,
): Promise<string> {
  const key = refreshReportKey(report.federation.slug, report.instance_id);
  await bucket.put(key, JSON.stringify({ ...report, finished_at: finishedAt }), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}

// @version v0.9.0
