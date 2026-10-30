/**
 * Scripts — pipeline storage: names, shared steps, provider clients, and
 * the tenant step
 *
 * This module deals with setting up the storage the media pipeline
 * writes to. The buckets belong to a federation, and each tenant's
 * output sits under its own slug inside them, so storage is set up in
 * two steps, each with its own operator command:
 *
 *   - the federation step (`scripts/lib/federation-storage.ts`, run by
 *     `scripts/commands/provision-federation-storage.ts`) creates or
 *     adopts the federation's buckets and hosts, issues Fisqua's keys
 *     as Worker secrets, and writes the federation's destination record;
 *   - the tenant step (`provisionTenantStorage` here, run by
 *     `scripts/commands/provision-tenant-storage.ts`) gives one tenant's
 *     runs their keys, limited to the tenant's part of the federation's
 *     buckets.
 *
 * Everything here takes its provider clients as arguments, so the tests
 * run every step against fakes.
 *
 * Names. Keys are named `fisqua-{slug}[-staging]-…`: a federation's keys
 * from the federation's slug (`nameBase`), a tenant's from the tenant's
 * (`tenantKeyNames`). A tenant's runner keys sit in its own GitHub
 * Environment in the runner repository, `fisqua-pipeline-{tenantId}` in
 * production and `fisqua-pipeline-staging-{tenantId}` on staging
 * (`runnerEnvironmentFor`), the name dispatch puts in a spec's
 * `credentials_ref` for the same environment. The secret prefix of a
 * federation's Worker secrets is `FEDERATION_` and its slug in upper case,
 * hyphens as underscores (`secretPrefixFor`). The shared working bucket is
 * `fisqua-pipeline-working`, staging `fisqua-pipeline-working-staging`
 * (`workingBucketFor`); `scripts/commands/provision-working-bucket.ts`
 * creates it.
 *
 * The record. A federation's destination is eight columns on its row
 * (`DESTINATION_COLUMNS`): the tiles bucket and its S3 endpoint, the
 * masters bucket, the image address, the manifest bucket, its S3
 * endpoint and address, and the secret prefix. `isRecordComplete` says
 * whether every one is set. A ninth column, the review-tiles bucket
 * (`REVIEW_TILES_COLUMN`), is optional: a federation without it is a
 * complete destination whose volumes skip the review run.
 * `RECORD_COLUMNS` is the nine, the columns the federation step reads,
 * compares and writes.
 *
 * The tenant step, `provisionTenantStorage(options, providers, log)`,
 * refuses a tenant whose federation has no complete record, and
 * otherwise walks three steps, each reading what exists before it
 * writes, so a run that stopped part way finishes the job when run again
 * without making anything twice:
 *
 *   0. The working bucket named must not be one of the federation's
 *      buckets or another federation's bucket of any role
 *      (`refuseBucketAliases`, shared with the federation step); the
 *      step stops before reading or issuing anything if it is.
 *   1. The buckets: the federation's tiles and masters buckets, its
 *      review-tiles bucket when the record names one, and the working
 *      bucket must be in the B2 account; nothing is created.
 *   2. The runner's keys, issued into the tenant's Environment
 *      (created if missing) under the names the runner reads
 *      (`RUNNER_SECRETS`): tiles write and read, limited to the
 *      federation's tiles bucket and the prefix `{slug}/`; masters read,
 *      limited to the federation's masters bucket and `{slug}/`; working
 *      write and read, limited to `{tenantId}/` in the working bucket;
 *      and, when the federation records a review-tiles bucket, review
 *      write (`listBuckets`, `listFiles`, `readFiles`, `writeFiles`), for
 *      the review run, and review delete (`listBuckets`, `readBuckets`,
 *      `listFiles`, `deleteFiles`), for the processing run's purge of
 *      review prefixes,
 *      both limited to that bucket and `{slug}/`. Without that bucket
 *      the two are not issued. A tenant that holds the other five keys
 *      is given only the two, since a key is issued only when one of the
 *      secrets that hold it
 *      is missing, since a key's secret can be read only when it is made.
 *      A key whose secrets are set is issued again (`[reissue]`, with the
 *      reason) when the keys of its name in the B2 account are not
 *      limited to the bucket and prefix it should be, as after the
 *      federation's bucket changed, or do not have exactly its role's
 *      capabilities; the key it replaces is reported for
 *      deletion by hand and never deleted. When keys of its name are
 *      limited to different buckets or prefixes, as after a reissue whose
 *      old key was not yet deleted, the step stops before anything is
 *      written and lists them by id and limit: the secrets cannot be read
 *      back, so it cannot tell which key they hold, and the operator
 *      deletes the stale ones by hand. A reissue is refused while the
 *      tenant has an open run or a volume prepared or ready, since a job
 *      of that work could read the new key against the old destination.
 *   3. The runner's repository variables: the Environment is added to
 *      `PIPELINE_ENVIRONMENTS`, and the host of the federation's storage
 *      endpoint to `PIPELINE_STORAGE_HOSTS`.
 *
 * Shared with the federation step and the working-bucket command:
 * `ensureB2Bucket` (find a B2 bucket of the wanted type and CORS rules,
 * or create it), `issueKeys` with its `KeyPlan`s, `bucketChange`,
 * `heldKeys`, `refuseWhilePending`, `findWorkingBucket`, the record
 * helpers, `execCommand` and `b2FromEnv`. The appliance key command
 * (`scripts/lib/appliance-key.ts`) uses `resolveTenantStorage` (the
 * tenant, its federation and the complete record) and `findRecordBucket`
 * as the tenant step does, and reads each key's capabilities from
 * `b2_list_keys` to check the key it issues. The capture registration
 * command (`scripts/lib/capture-registration.ts`) uses the same two to
 * find the masters bucket, `listFiles` (`b2_list_file_names`, names and
 * sizes only) to take the inventory of each volume's prefix,
 * `listFolders` (`b2_list_file_names` with the delimiter `/`) to find
 * the volume folders under the tenant's prefix, and `d1Args` to read and write the target's database. The rename-copy
 * command (`scripts/lib/rename-copy.ts`) uses `resolveTenantStorage` to
 * find the masters bucket, `listFileDetails` (`b2_list_file_names` with
 * each file's id and SHA1) to read what the source bucket holds,
 * `listFileVersions` (`b2_list_file_versions`, hide markers and unfinished large files included) to
 * read every version at the destination, and `copyFile` (`b2_copy_file`,
 * server side) to write the copies.
 *
 * Bucket role tags. Before any key is issued, the tenant step reads the
 * B2 bucket-info tags (`BUCKET_TAG_KEYS`) of the federation's tiles,
 * masters and review-tiles buckets and of the working bucket, and stops
 * when one names another role, environment or federation, or when the
 * review-tiles bucket is untagged and holds files. A masters bucket's
 * tag is its role and federation only: it serves both environments of
 * its federation, so its environment is neither checked nor written
 * (`roleCarriesEnv`). `ensureB2Bucket`
 * creates a bucket with its tag and adds a missing tag to an existing
 * one, merging it with the bucket info the bucket has; `tagBucket` does
 * the same for a bucket found rather than ensured. Every such update is
 * made at the revision just read (`ifRevisionIs`); when B2 refuses it
 * because the bucket changed, the bucket is read and checked again from
 * scratch, never written again blindly. After a tag write, and again
 * immediately before any key is issued over a bucket, `confirmTag`
 * reads the bucket and stops unless its tag is exactly the role,
 * environment (but on a masters bucket) and federation of the run; so the tenant step issues no
 * key over an untagged bucket, which the federation step (or
 * provision-working-bucket) tags first. Nothing removes or changes a
 * tag.
 *
 * The provisioning lock. An applied run of either step holds a lock on
 * its destination for the whole run (`withProvisioningLock`, a row in
 * `provisioning_locks` keyed `federation:{id}` or `tenant:{id}`, taken
 * with one atomic insert and released when the run ends), because a
 * key's id and secret are two secrets written one after the other and
 * two runs interleaved could pair one run's id with the other's secret.
 * A second applied run stops, naming the holder and when it started; a
 * lock expires after `LOCK_TTL_MS`, for a run that crashed. The lock row
 * carries a random token per run, which fences every write: the run
 * renews the lock with that token before and after each secret write
 * (`PairJournal.guard`), stops at once when it has lost it, marks the
 * pair again when a write landed after the loss, and clears only its own
 * mark (each mark carries its writer's token), in a statement that also
 * checks the lock; a mark another writer replaced is left for the next
 * run, and the run stops naming the pair. Every D1 write a run makes
 * under the lock is fenced the same way, in its own statement
 * (`fenceCondition`): the destination record (`fencedDestinationStatement`,
 * which also compares every record column with the value the run read)
 * and the initial mark of a pair; a fenced write that changes nothing
 * stops the run. Only the re-mark of a run that lost its lock is written
 * unfenced, since it flags exactly that case. A dry run takes none. The secrets cannot be read back, so a held pair is checked
 * only as far as the accounts allow: a live B2 key of its name limited to
 * its bucket (and prefix) with exactly its capabilities, or, for the R2
 * token, a token of its name; otherwise the key is issued again under
 * the reissue rules. Whether the id and secret in the secrets belong to
 * the same key cannot be checked by reading them, so each pair's write is
 * journalled instead (`issueKeys` with a `PairJournal`, rows in
 * `provisioning_pending_pairs`): marked before the key is issued,
 * cleared once both secrets are written. A pair still marked when a run
 * reads it is issued again from scratch, whatever the live-key check
 * says. When the second secret cannot be written, the new key is
 * deleted; if that fails too, the stop names the key left in the
 * account, to be deleted by hand.
 *
 * In a dry run, which is the default, every step reads and prints what
 * it would do, and nothing is written. Without a provider's credentials
 * a dry run prints that step's names as unchecked. No secret value is
 * ever printed: the log carries names and the word "set".
 *
 * The provider clients (`b2Client`, `cloudflareClient`, `githubClient`)
 * speak the providers' HTTP APIs through an injected `fetch`;
 * `wranglerSecrets` and `wranglerD1` run the CLIs through an injected
 * runner, and the GitHub client sets secrets through `gh` the same way.
 * The request shapes follow the providers' public API documentation;
 * they are exercised here only against fakes.
 *
 * @version v0.8.0
 */

import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { escapeSql } from "./sql";
import { runnerKeyStoreName } from "../../app/lib/pipeline/key-store";

export type Target = "local" | "staging" | "production";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;
export const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const SECRET_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;
export const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The names of the runner's seven keys for a tenant on one target. */
export interface TenantKeyNames {
  runnerWrite: string;
  runnerRead: string;
  mastersRead: string;
  workingWrite: string;
  workingRead: string;
  reviewWrite: string;
  reviewDelete: string;
}

/**
 * The B2 working bucket every tenant shares on one target. The runner
 * writes held manifests and reports there, each tenant under its own
 * `{tenantId}/` prefix; `scripts/commands/provision-working-bucket.ts`
 * creates it once per environment.
 */
export function workingBucketFor(target: Target): string {
  if (target === "local") throw new ProvisionStop("The working bucket is for staging or production");
  return target === "staging" ? "fisqua-pipeline-working-staging" : "fisqua-pipeline-working";
}

/**
 * The runner's GitHub Environment for a tenant on one target: the name
 * the Worker of that environment puts in a spec's `credentials_ref`.
 * Local development reads the top-level wrangler variables, which name
 * production.
 */
export function runnerEnvironmentFor(tenantId: string, target: Target): string {
  return runnerKeyStoreName(tenantId, target === "staging" ? "staging" : "production");
}

/** The default prefix of a federation's Worker secrets. */
export function secretPrefixFor(federationSlug: string): string {
  return `FEDERATION_${federationSlug.toUpperCase().replace(/-/g, "_")}`;
}

/** A slug as bucket and key names carry it: staging adds `-staging`. */
export function nameBase(slug: string, target: Target): string {
  return target === "staging" ? `${slug}-staging` : slug;
}

/** The runner's key names for a tenant, from the tenant's slug. */
export function tenantKeyNames(tenantSlug: string, target: Target): TenantKeyNames {
  const base = nameBase(tenantSlug, target);
  return {
    runnerWrite: `fisqua-${base}-tiles-runner-write`,
    runnerRead: `fisqua-${base}-tiles-runner-read`,
    mastersRead: `fisqua-${base}-masters-runner-read`,
    workingWrite: `fisqua-${base}-working-runner-write`,
    workingRead: `fisqua-${base}-working-runner-read`,
    reviewWrite: `fisqua-${base}-review-tiles-runner-write`,
    reviewDelete: `fisqua-${base}-review-tiles-runner-delete`,
  };
}

export interface TenantStorageNames {
  environment: string;
  /** The tenant's part of the federation's tiles and masters buckets. */
  slugPrefix: string;
  /** The tenant's part of the shared working bucket. */
  workingPrefix: string;
  keys: TenantKeyNames;
}

export function tenantStorageNames(tenantSlug: string, tenantId: string, target: Target): TenantStorageNames {
  if (!SLUG_PATTERN.test(tenantSlug)) throw new ProvisionStop(`Not a tenant slug: ${tenantSlug}`);
  return {
    environment: runnerEnvironmentFor(tenantId, target),
    slugPrefix: `${tenantSlug}/`,
    workingPrefix: `${tenantId}/`,
    keys: tenantKeyNames(tenantSlug, target),
  };
}

export function workerSecretNames(prefix: string) {
  return {
    deliveryReadKeyId: `${prefix}_DELIVERY_READ_KEY_ID`,
    deliveryReadSecret: `${prefix}_DELIVERY_READ_SECRET_KEY`,
    manifestWriteKeyId: `${prefix}_MANIFEST_WRITE_KEY_ID`,
    manifestWriteSecret: `${prefix}_MANIFEST_WRITE_SECRET_KEY`,
  };
}

/**
 * The runner Environment's secrets, by the names the runner's workflow
 * passes to its storage module: one key id and key per role.
 */
export const RUNNER_SECRETS = {
  writeKeyId: "DELIVERY_WRITE_KEY_ID",
  writeKey: "DELIVERY_WRITE_KEY",
  readKeyId: "DELIVERY_READ_KEY_ID",
  readKey: "DELIVERY_READ_KEY",
  sourceReadKeyId: "SOURCE_READ_KEY_ID",
  sourceReadKey: "SOURCE_READ_KEY",
  workingWriteKeyId: "WORKING_WRITE_KEY_ID",
  workingWriteKey: "WORKING_WRITE_KEY",
  workingReadKeyId: "WORKING_READ_KEY_ID",
  workingReadKey: "WORKING_READ_KEY",
  reviewWriteKeyId: "REVIEW_WRITE_KEY_ID",
  reviewWriteKey: "REVIEW_WRITE_KEY",
  reviewDeleteKeyId: "REVIEW_DELETE_KEY_ID",
  reviewDeleteKey: "REVIEW_DELETE_KEY",
} as const;

/** GET and HEAD from any origin: IIIF viewers fetch tiles and manifests cross-origin. */
export const B2_CORS_RULES = [
  {
    corsRuleName: "iiif-read",
    allowedOrigins: ["*"],
    allowedOperations: ["b2_download_file_by_name", "s3_get", "s3_head"],
    allowedHeaders: ["*"],
    exposeHeaders: [],
    maxAgeSeconds: 86400,
  },
];

export const R2_CORS_RULES = [
  { allowed: { origins: ["*"], methods: ["GET", "HEAD"], headers: ["*"] }, maxAgeSeconds: 86400 },
];

export const B2_READ_CAPABILITIES = ["listBuckets", "listFiles", "readFiles"];
export const B2_WRITE_CAPABILITIES = ["listBuckets", "listFiles", "readFiles", "writeFiles"];
/**
 * List and delete, without reading files: the processing run purges
 * review prefixes it does not read. `readBuckets` lets it read the
 * bucket's versioning (S3 GetBucketVersioning), which B2 authorises with
 * that capability alone.
 */
export const B2_DELETE_CAPABILITIES = ["listBuckets", "readBuckets", "listFiles", "deleteFiles"];

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

export interface IssuedKey {
  keyId: string;
  secret: string;
}

export type B2BucketType = "allPublic" | "allPrivate";

export interface B2Bucket {
  bucketId: string;
  bucketName: string;
  bucketType: string;
  corsRules: unknown[];
  /**
   * As `b2_list_buckets` reports them. `b2_update_bucket` keeps them when
   * an update leaves them out, so setting a bucket's CORS rules never
   * clears them.
   */
  lifecycleRules?: unknown[];
  /** The bucket's info, string keys and values, as B2 reports it. */
  bucketInfo?: Record<string, string>;
  /** The bucket's revision, which B2 raises on every update. */
  revision?: number;
}

/** A key in the B2 account: its id, its name and what it is limited to. Never its secret. */
export interface B2KeyInfo {
  keyId: string;
  keyName: string;
  bucketId: string | null;
  namePrefix: string | null;
  /** What the key may do, as `b2_list_keys` reports it. */
  capabilities: string[];
}

export interface B2Api {
  account(): Promise<{ s3ApiUrl: string; downloadUrl: string }>;
  findBucket(name: string): Promise<B2Bucket | null>;
  /** Throws `BucketNameTakenError` when the name is held elsewhere. */
  createBucket(
    name: string,
    bucketType: B2BucketType,
    corsRules: unknown[],
    bucketInfo?: Record<string, string>,
  ): Promise<B2Bucket>;
  /**
   * Changes a bucket's type and, when given, its CORS rules and its
   * bucket info. B2 replaces a field that is sent and keeps one that is
   * left out, so `bucketInfo` must carry every key the bucket keeps.
   */
  updateBucket(
    bucketId: string,
    bucketType: B2BucketType,
    corsRules?: unknown[],
    bucketInfo?: Record<string, string>,
    /**
     * With it, B2 refuses the update when the bucket's revision is not
     * this one; the client throws `BucketRevisionConflictError`.
     */
    ifRevisionIs?: number,
  ): Promise<void>;
  keyNames(): Promise<string[]>;
  keys(): Promise<B2KeyInfo[]>;
  /** Deletes a key by its id (`b2_delete_key`). */
  deleteKey(keyId: string): Promise<void>;
  /** A key limited to one bucket and, when `namePrefix` is given, to names under it. */
  createKey(name: string, capabilities: string[], bucketId: string, namePrefix?: string): Promise<IssuedKey>;
  /**
   * The current files under a prefix of a bucket, by name and size in
   * bytes, every page of the listing; reads names only, never content.
   */
  listFiles(bucketId: string, prefix: string): Promise<B2FileInfo[]>;
  /**
   * The same listing with each file's id and SHA1 (`sha1Of`); reads
   * names and metadata only, never content.
   */
  listFileDetails(bucketId: string, prefix: string): Promise<B2FileDetail[]>;
  /**
   * Every version under a prefix of a bucket, uploads and hide markers,
   * each name's newest first, every page of the listing; reads names and
   * metadata only, never content.
   */
  listFileVersions(bucketId: string, prefix: string): Promise<B2FileVersion[]>;
  /**
   * The folders directly under a prefix of a bucket, each as its full
   * name ending in `/`, every page of the listing (`b2_list_file_names`
   * with the delimiter `/`); reads names only, never the files inside.
   */
  listFolders(bucketId: string, prefix: string): Promise<string[]>;
  /**
   * Copies a file server side to a name in a bucket, with its content
   * type and file info (`metadataDirective: "COPY"`); B2 copies up to
   * 5 GB this way. Returns the new file's id.
   */
  copyFile(sourceFileId: string, fileName: string, destinationBucketId: string): Promise<{ fileId: string }>;
  /**
   * Whether a bucket holds any file version at all: uploads, hide
   * markers, old versions and unfinished large files alike
   * (`b2_list_file_versions` with `maxFileCount` 1). Reads one entry's
   * name and metadata at most, never content.
   */
  hasFileVersions(bucketId: string): Promise<boolean>;
}

/** A file in a bucket listing: its full name and its size in bytes. */
export interface B2FileInfo {
  fileName: string;
  contentLength: number;
}

/** A file in a bucket listing with its id and SHA1 (null when B2 does not know it). */
export interface B2FileDetail extends B2FileInfo {
  fileId: string;
  sha1: string | null;
}

/**
 * One version of a file, as `b2_list_file_versions` reports it: an
 * upload, a hide marker (size 0, no SHA1) that makes the name absent
 * from `b2_list_file_names`, or a large file whose upload was started
 * and not finished. Each occupies the name.
 */
export interface B2FileVersion extends B2FileDetail {
  action: "upload" | "hide" | "start";
}

/**
 * A file's SHA1 from its `b2_list_file_names` entry. B2 reports
 * `contentSha1` as `none` for a large file uploaded in parts; then the
 * uploader's `large_file_sha1` in the file info is used if it set one.
 * A value B2 marks `unverified:` (the SHA1 sent after the content) is
 * read without the mark. Anything else is unknown: null.
 */
export function sha1Of(file: { contentSha1?: unknown; fileInfo?: unknown }): string | null {
  const hex = /^[0-9a-f]{40}$/;
  const raw = typeof file.contentSha1 === "string" ? file.contentSha1.toLowerCase().replace(/^unverified:/, "") : "";
  if (hex.test(raw)) return raw;
  const info = (file.fileInfo ?? {}) as Record<string, unknown>;
  const large = typeof info.large_file_sha1 === "string" ? info.large_file_sha1.toLowerCase() : "";
  return hex.test(large) ? large : null;
}

export interface TransformRule {
  id?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: unknown;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface CloudflareApi {
  /** The account's R2 S3 endpoint. */
  s3Endpoint: string;
  findZone(domain: string): Promise<string | null>;
  r2BucketExists(name: string): Promise<boolean>;
  createR2Bucket(name: string): Promise<void>;
  r2Cors(name: string): Promise<unknown[] | null>;
  putR2Cors(name: string, rules: unknown[]): Promise<void>;
  r2CustomDomains(name: string): Promise<string[]>;
  addR2CustomDomain(name: string, domain: string, zoneId: string): Promise<void>;
  findCname(zoneId: string, name: string): Promise<{ content: string; proxied: boolean } | null>;
  createCname(zoneId: string, name: string, content: string): Promise<void>;
  transformRules(zoneId: string): Promise<TransformRule[]>;
  putTransformRules(zoneId: string, rules: TransformRule[]): Promise<void>;
  tokenNames(): Promise<string[]>;
  createR2WriteToken(name: string, bucket: string): Promise<IssuedKey>;
}

export interface GitHubApi {
  environmentExists(name: string): Promise<boolean>;
  createEnvironment(name: string): Promise<void>;
  environmentSecretNames(name: string): Promise<string[]>;
  setEnvironmentSecret(environment: string, name: string, value: string): Promise<void>;
  variable(name: string): Promise<string | null>;
  setVariable(name: string, value: string): Promise<void>;
}

export interface WorkerSecretsApi {
  names(): Promise<string[]>;
  put(name: string, value: string): Promise<void>;
}

/** A federation's row: its id, slug and destination columns. */
export interface FederationRow {
  id: string;
  slug: string;
  pipeline_delivery_endpoint: string | null;
  pipeline_tiles_bucket: string | null;
  pipeline_masters_bucket: string | null;
  pipeline_image_base_url: string | null;
  manifest_endpoint: string | null;
  manifest_bucket: string | null;
  manifest_base_url: string | null;
  storage_secret_prefix: string | null;
  /** Optional: a federation without it is complete and its volumes skip the review run. */
  pipeline_review_tiles_bucket: string | null;
}

export interface TenantRow {
  id: string;
  slug: string;
  /** Nullable in D1 (migration 0044); a tenant without one has no storage. */
  federation_id: string | null;
}

/** Pipeline work a destination is part of. */
export interface PendingWork {
  /** Runs whose token is neither revoked nor expired. */
  openRuns: number;
  /** Volumes in state `prepared` or `ready`: output made, not yet published. */
  unpublishedVolumes: number;
}

/** Whose pending work: one tenant's, or every tenant's of one federation. */
export type PendingScope = { tenantId: string } | { federationId: string };

export interface D1Api {
  tenant(slug: string): Promise<TenantRow | null>;
  federation(slug: string): Promise<FederationRow | null>;
  federationById(id: string): Promise<FederationRow | null>;
  /** The slugs of the federation's tenants. */
  tenantsOf(federationId: string): Promise<string[]>;
  /** Every other federation row with a destination column set. */
  otherDestinations(federationId: string): Promise<FederationRow[]>;
  pendingWork(scope: PendingScope, now: number): Promise<PendingWork>;
  /**
   * Writes a federation's destination only if the run still holds its
   * unexpired lock (`fence`) and every record column still has the value
   * the run read (`expected`), in one statement; false when it wrote
   * nothing.
   */
  writeDestination(federationId: string, values: DestinationValues, expected: FederationRow, fence: Fence): Promise<boolean>;
  /**
   * Takes the provisioning lock of a scope (`provisioning_locks`) with
   * one atomic insert, after clearing an expired one. Returns the lock as
   * it stands afterwards, whoever holds it.
   */
  takeLock(scope: string, holder: string, token: string, now: number, expiresAt: number): Promise<ProvisioningLock>;
  /**
   * Extends a scope's lock to `expiresAt` only if this token still holds
   * it and it has not expired, in one statement; false when it is lost.
   */
  renewLock(scope: string, token: string, now: number, expiresAt: number): Promise<boolean>;
  /** Releases a scope's lock if this token still holds it. */
  releaseLock(scope: string, token: string): Promise<void>;
  /** The pairs of a scope whose secrets a run began writing and did not finish (`provisioning_pending_pairs`). */
  pendingPairs(scope: string): Promise<string[]>;
  /** The token of the run that marked a pair, or null when it is not marked. */
  markOf(scope: string, pair: string): Promise<string | null>;
  /** Records that a run is about to write a pair's two secrets. */
  /**
   * Marks a pair with this run's token. With `fenced`, only while the
   * token holds the scope's unexpired lock, in the same statement; false
   * when it wrote nothing. Unfenced, it always writes: the re-mark of a
   * run that has lost its lock (`PairJournal.guard`).
   */
  markPair(scope: string, pair: string, holder: string, token: string, now: number, fenced: boolean): Promise<boolean>;
  /**
   * Records that both secrets of a pair are written: clears its mark only
   * if the mark is this token's own and this token still holds the
   * scope's unexpired lock, in one statement. False when nothing was
   * cleared: another writer marked the pair since, or the lock is lost.
   */
  clearPair(scope: string, pair: string, token: string, now: number): Promise<boolean>;
}

/** A provisioning lock: who holds it, since when, and its fencing token. */
export interface ProvisioningLock {
  holder: string;
  startedAt: number;
  token: string;
}

/** The lock an applied run holds: its scope and the token that fences its writes. */
export interface Lease {
  scope: string;
  token: string;
}

/** A lease at a moment: a D1 write fenced by it applies only while the lock is still this run's and unexpired. */
export interface Fence {
  scope: string;
  token: string;
  now: number;
}

/** The condition that fences a D1 write by a lease: the lock is this token's and has not expired. */
export function fenceCondition(fence: Fence): string {
  return (
    `EXISTS (SELECT 1 FROM provisioning_locks WHERE scope = ${escapeSql(fence.scope)} ` +
    `AND token = ${escapeSql(fence.token)} AND expires_at > ${fence.now})`
  );
}

export interface Providers {
  b2: B2Api | null;
  cloudflare: CloudflareApi | null;
  github: GitHubApi | null;
  worker: WorkerSecretsApi | null;
  d1: D1Api;
  now: () => number;
  /**
   * Who is running, for the provisioning lock (user, host and process);
   * named when another run refuses while this one holds the lock.
   */
  holder?: string;
  /** The lock this run holds, set by `withProvisioningLock` on apply. */
  lease?: Lease | null;
}

/** B2 refused an update made `ifRevisionIs` a revision the bucket no longer has. */
export class BucketRevisionConflictError extends Error {
  constructor(bucketId: string) {
    super(`The B2 bucket ${bucketId} changed since it was read`);
    this.name = "BucketRevisionConflictError";
  }
}

export class BucketNameTakenError extends Error {
  constructor(name: string) {
    super(`The B2 bucket name ${name} is held by another account`);
    this.name = "BucketNameTakenError";
  }
}

export class ProvisionStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionStop";
  }
}

// ---------------------------------------------------------------------------
// The federation's destination record
// ---------------------------------------------------------------------------

export interface DestinationValues {
  pipeline_delivery_endpoint: string;
  pipeline_tiles_bucket: string;
  pipeline_masters_bucket: string;
  pipeline_image_base_url: string;
  manifest_endpoint: string;
  manifest_bucket: string;
  manifest_base_url: string;
  storage_secret_prefix: string;
  /** The private review-tiles bucket; absent or null when the federation has none. */
  pipeline_review_tiles_bucket?: string | null;
}

export const DESTINATION_COLUMNS = [
  "pipeline_delivery_endpoint",
  "pipeline_tiles_bucket",
  "pipeline_masters_bucket",
  "pipeline_image_base_url",
  "manifest_endpoint",
  "manifest_bucket",
  "manifest_base_url",
  "storage_secret_prefix",
] as const satisfies ReadonlyArray<keyof DestinationValues>;

/** The optional column: a record without it is still complete. */
export const REVIEW_TILES_COLUMN = "pipeline_review_tiles_bucket" as const;

/** Every column of the destination record, the required eight and the optional one. */
export const RECORD_COLUMNS = [...DESTINATION_COLUMNS, REVIEW_TILES_COLUMN] as const;

export type RecordColumn = (typeof RECORD_COLUMNS)[number];

/** A record value as written: an absent optional column is null. */
export function recordValue(values: DestinationValues, column: RecordColumn): string | null {
  return values[column] ?? null;
}

/** The columns no two federations may share. */
export const UNIQUE_COLUMNS = [
  "pipeline_tiles_bucket",
  "pipeline_masters_bucket",
  "manifest_bucket",
  "manifest_base_url",
  "storage_secret_prefix",
  REVIEW_TILES_COLUMN,
] as const satisfies ReadonlyArray<keyof DestinationValues>;

/** The unset columns of a federation's record; empty when it is complete. */
export function missingRecordColumns(row: FederationRow): string[] {
  return DESTINATION_COLUMNS.filter((c) => row[c] === null || row[c].trim() === "");
}

export function isRecordComplete(row: FederationRow): row is FederationRow & DestinationValues {
  return missingRecordColumns(row).length === 0;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.replace(/\/+$/, "") === "" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Refuses values of the wrong form before anything is written. */
export function checkDestinationValues(values: DestinationValues): void {
  for (const column of ["pipeline_delivery_endpoint", "manifest_endpoint", "pipeline_image_base_url", "manifest_base_url"] as const) {
    if (!isHttpsUrl(values[column])) {
      throw new ProvisionStop(`${column} must be an https URL with no path: ${values[column]}`);
    }
  }
  for (const column of ["pipeline_tiles_bucket", "pipeline_masters_bucket", "manifest_bucket"] as const) {
    if (!BUCKET_PATTERN.test(values[column])) {
      throw new ProvisionStop(`${column} is not a bucket name: ${values[column]}`);
    }
  }
  const review = recordValue(values, REVIEW_TILES_COLUMN);
  if (review !== null && !BUCKET_PATTERN.test(review)) {
    throw new ProvisionStop(`${REVIEW_TILES_COLUMN} is not a bucket name: ${review}`);
  }
  if (!SECRET_PREFIX_PATTERN.test(values.storage_secret_prefix)) {
    throw new ProvisionStop(
      `storage_secret_prefix must be upper-case letters, digits and underscores: ${values.storage_secret_prefix}`,
    );
  }
}

/** The record's bucket columns and the role each names. */
export const BUCKET_ROLES = [
  ["pipeline_tiles_bucket", "tiles bucket"],
  ["pipeline_masters_bucket", "masters bucket"],
  [REVIEW_TILES_COLUMN, "review-tiles bucket"],
  ["manifest_bucket", "manifest bucket"],
] as const;

export type BucketColumn = (typeof BUCKET_ROLES)[number][0];

/**
 * Stops when one bucket name would serve two roles: two of a
 * federation's buckets, one of them and the shared working bucket, one
 * of them or the working bucket and a bucket the federation's own record
 * holds in another role (`recorded`, every bucket it names, those the
 * run would replace included), or one of them or the working bucket and
 * a bucket another federation records in another role. Each key Fisqua and the runner hold is
 * limited to one bucket by its role, so a shared name would give a key
 * of one role access to another role's objects (the Worker's share key
 * reading masters, the runner's review delete key deleting them, its
 * working write key writing into masters). The federation step runs it
 * with the buckets it plans and the target's working bucket; the tenant
 * step with the federation's recorded buckets and the working bucket it
 * was given. Both run it before anything is created, issued or set, dry
 * run included. Reads D1 only.
 */
export async function refuseBucketAliases(
  federationId: string,
  values: Partial<Record<BucketColumn, string | null>>,
  workingBucket: string | null,
  providers: Providers,
  recorded: (Partial<Record<BucketColumn, string | null>> & { slug: string }) | null = null,
): Promise<void> {
  const planned: Array<{ name: string; role: string; column: BucketColumn | null }> = BUCKET_ROLES.flatMap(
    ([column, role]) => {
      const name = values[column];
      return name ? [{ name, role, column }] : [];
    },
  );
  if (workingBucket !== null) planned.push({ name: workingBucket, role: "shared working bucket", column: null });
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      if (planned[i].name === planned[j].name) {
        throw new ProvisionStop(
          `The ${planned[i].role} and the ${planned[j].role} would both be ${planned[i].name}; each role needs its own bucket`,
        );
      }
    }
  }
  if (recorded !== null) {
    for (const [column, role] of BUCKET_ROLES) {
      const name = recorded[column] ?? null;
      const clash = name === null ? undefined : planned.find((p) => p.column !== column && p.name === name);
      if (clash) {
        throw new ProvisionStop(
          `Federation ${recorded.slug} records ${name} as its ${role}; it cannot also be its ${clash.role}`,
        );
      }
    }
  }
  for (const other of await providers.d1.otherDestinations(federationId)) {
    for (const [column, role] of BUCKET_ROLES) {
      const name = other[column] ?? null;
      const clash = name === null ? undefined : planned.find((p) => p.column !== column && p.name === name);
      if (clash) {
        throw new ProvisionStop(
          `Federation ${other.slug} records ${name} as its ${role}; it cannot also be this federation's ${clash.role}`,
        );
      }
    }
  }
}

/**
 * The UPDATE that writes a federation's destination. The review-tiles
 * column is written only when the values carry it (null clears it), so
 * values without it leave what the row holds.
 */
export function destinationStatement(federationId: string, values: DestinationValues): string {
  const columns = RECORD_COLUMNS.filter((c) => c !== REVIEW_TILES_COLUMN || values[c] !== undefined);
  const sets = columns.map((c) => {
    const value = recordValue(values, c);
    return `${c} = ${value === null ? "NULL" : escapeSql(value)}`;
  }).join(", ");
  return `UPDATE federations SET ${sets} WHERE id = ${escapeSql(federationId)};`;
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

export type Log = (line: string) => void;

export function hostOf(url: string): string {
  return new URL(url).hostname;
}

function listOf(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Stops while there is pipeline work a destination is part of: an open
 * run (its token neither revoked nor expired), whose stored spec carries
 * the destination, or a volume that is prepared or ready but not yet
 * published, whose output sits in the current destination waiting to be
 * published from it. For a federation the work of every tenant in it
 * counts.
 */
export async function refuseWhilePending(scope: PendingScope, providers: Providers, what: string): Promise<void> {
  const { openRuns, unpublishedVolumes } = await providers.d1.pendingWork(scope, providers.now());
  if (openRuns === 0 && unpublishedVolumes === 0) return;
  const whose = "federationId" in scope ? "The federation's tenants have" : "The tenant has";
  const parts = [
    openRuns > 0 && `${openRuns} open run(s)`,
    unpublishedVolumes > 0 && `${unpublishedVolumes} volume(s) prepared or ready but not published`,
  ].filter(Boolean);
  throw new ProvisionStop(`${whose} ${parts.join(" and ")}; ${what} until that work is published or closed`);
}

export interface KeyPlan {
  label: string;
  name: string;
  /** Every secret that holds the key is already set. */
  held: boolean;
  /** A key of this name already exists in the account. */
  older: boolean;
  /**
   * Why a held key must be issued again: what it is limited to is no
   * longer what it should be. Null or absent when the held key still fits.
   */
  reissue?: string | null;
  issue: () => Promise<IssuedKey>;
  /**
   * Writes the key's two secrets, each through `guard`, which checks the
   * run still holds its lock before the write and again after it.
   */
  store: (key: IssuedKey, guard: SecretGuard) => Promise<void>;
  /** The bucket the key is limited to and the tag it must carry before the key is issued. */
  limit?: { bucket: string; tag: BucketTag | null };
  /** The names of the two secrets that hold the key, for the report of what is set or replaced. */
  secretNames?: string[];
  /**
   * Deletes a key just issued whose secrets could not both be written,
   * so no key with live capabilities is left that no secret holds.
   */
  discard?: (key: IssuedKey) => Promise<void>;
}

/** Runs one secret write between the lock checks of `PairJournal.guard`. */
export type SecretGuard = (write: () => Promise<void>) => Promise<void>;

/** Runs a secret write as it is: for a run that holds no lock (the working-bucket command). */
export const unguarded: SecretGuard = (write) => write();

/** The run lost its provisioning lock: it stops at once and writes nothing more. */
export class LockLostError extends ProvisionStop {
  constructor(scope: string) {
    super(
      `The provisioning lock on ${scope} was lost (it expired, and another run may hold it now), so this run stops ` +
        "without writing anything more",
    );
    this.name = "LockLostError";
  }
}

/**
 * Where an applied run records that it is writing a pair's two secrets
 * (`provisioning_pending_pairs`), fenced by its lock:
 *
 *   - `mark` renews the lock (`renewLock`) and marks the pair;
 *   - `guard` runs each secret write between two renewals: before it,
 *     so a run that has lost its lock writes nothing; after it, on every
 *     outcome, success or error, since a write that threw may have been
 *     applied with its response lost. When the lock is lost or the write
 *     threw, the pair is marked again with this run's token (`markPair`,
 *     insert or replace) before anything else, so the next run issues it
 *     again from scratch even if the run that took the lock over cleared
 *     it;
 *   - `clear` clears the mark only when it is this run's own (the mark
 *     carries the token of the run that wrote it, a re-mark included)
 *     and the run still holds the lock, in one statement (`clearPair`);
 *     when nothing is cleared, another writer touched the pair, and the
 *     run stops with the pair left marked for the next run to reissue;
 *   - `describe` reads the pair's mark back from D1 for every stop
 *     message, which never assumes it.
 *
 * A run that loses its lock stops at once (`LockLostError`) and never
 * clears a mark. One case remains: a process frozen after its check and
 * before its write, past the lock's expiry and through another run's
 * whole write of the pair, that then writes and cannot mark the pair
 * again because its own D1 call fails as well. The window is the time
 * between one `renewLock` statement and the secret write that follows it
 * (a single `wrangler secret put` or `gh secret set`); in every other
 * case, the post-write check marks the pair again and the next run
 * repairs it.
 */
export interface PairJournal {
  mark(pair: string): Promise<void>;
  guard(pair: string): SecretGuard;
  clear(pair: string): Promise<void>;
  /** The pair's mark as D1 holds it now, in words, for a stop message; never assumed. */
  describe(pair: string): Promise<string>;
}

/** The journal of one destination's pairs, kept in D1 and fenced by the run's lease. */
export function pairJournal(providers: Providers, lease: Lease): PairJournal {
  const holder = providers.holder ?? "an unnamed run";
  const renew = async () => {
    const now = providers.now();
    return providers.d1.renewLock(lease.scope, lease.token, now, now + LOCK_TTL_MS);
  };
  const renewed = async () => {
    try {
      return await renew();
    } catch {
      // A renewal that fails is a lock this run cannot show it holds.
      return false;
    }
  };
  // The re-mark is written whether or not the lock is still held: it is
  // what flags a pair a run may have written after losing its lock. Every
  // other D1 write of the run is fenced by the lock in its own statement.
  const remark = (pair: string) => providers.d1.markPair(lease.scope, pair, holder, lease.token, providers.now(), false);
  const journal: PairJournal = {
    async mark(pair) {
      if (!(await renewed())) throw new LockLostError(lease.scope);
      const marked = await providers.d1.markPair(lease.scope, pair, holder, lease.token, providers.now(), true);
      if (!marked) throw new LockLostError(lease.scope);
    },
    guard(pair) {
      return async (write) => {
        if (!(await renewed())) throw new LockLostError(lease.scope);
        // The post-write step runs on every outcome: a write that threw may
        // have been applied remotely (its response lost), so it is treated
        // as possibly applied.
        let failure: unknown = undefined;
        let failed = false;
        try {
          await write();
        } catch (err) {
          failed = true;
          failure = err;
        }
        const held = await renewed();
        if (!held || failed) {
          // Marked with this run's token before anything else, replacing the
          // mark of a run that took over, so that run cannot clear it and
          // the next run issues the pair again.
          await remark(pair);
        }
        if (!held) throw new LockLostError(lease.scope);
        if (failed) throw failure;
      };
    },
    async clear(pair) {
      if (!(await providers.d1.clearPair(lease.scope, pair, lease.token, providers.now()))) {
        throw new ProvisionStop(
          `Another writer touched ${pair} while this run wrote it (its mark is no longer this run's, or the lock is lost), ` +
            `so the pair is not taken as complete: its secrets may hold two different keys. ${await journal.describe(pair)}`,
        );
      }
    },
    async describe(pair) {
      let token: string | null;
      try {
        token = await providers.d1.markOf(lease.scope, pair);
      } catch (err) {
        return (
          `Whether ${pair} is marked as half written could not be read back from D1 (${(err as Error).message}); ` +
          "check its two secrets before the next run"
        );
      }
      if (token === lease.token) {
        return `${pair} is marked as half written (by this run, read back from D1), and the next run issues it again from scratch`;
      }
      if (token !== null) {
        return `${pair} is marked as half written (by another run, read back from D1), and the next run issues it again from scratch`;
      }
      return (
        `${pair} is not marked as half written (read back from D1), so the next run will not issue it again by itself: ` +
        "its secrets may hold two different keys; delete one of them so the next run issues the pair again"
      );
    },
  };
  return journal;
}

/** The reason a pair left half written is issued again. */
export const PENDING_PAIR_REASON =
  "an earlier run began writing its two secrets and did not finish, so they may hold two different keys";

/**
 * The secret names of the plans that would be issued again: the
 * replacements a run makes, for its report of the secrets.
 */
export function replacedSecretNames(plans: KeyPlan[], present: string[] | null): string[] {
  return plans.flatMap((p) => {
    const names = p.secretNames ?? [];
    if (p.held) return p.reissue ? names : [];
    // A pair with one secret set is issued whole: the one set is replaced.
    return names.filter((n) => present?.includes(n));
  });
}

/**
 * Issues each key whose secrets are not all set, or which must be issued
 * again, and writes the secrets that hold it. A key issued again
 * replaces the secrets; the key they held is left in the account for the
 * operator to delete by hand.
 */
export async function issueKeys(plans: KeyPlan[], apply: boolean, log: Log, journal: PairJournal | null = null): Promise<void> {
  /**
   * Issues one key and writes the two secrets that hold it, marked in
   * the journal from before the key is issued until both are written. If
   * a secret cannot be written, the new key is deleted (`discard`) and
   * the mark stays, so the next run issues the pair again from scratch.
   */
  const issueAndStore = async (plan: KeyPlan): Promise<void> => {
    await journal?.mark(plan.name);
    let key: IssuedKey | null = null;
    try {
      key = await plan.issue();
      await plan.store(key, journal ? journal.guard(plan.name) : unguarded);
    } catch (err) {
      const lost = err instanceof LockLostError;
      let what: string;
      if (key === null) {
        what = `Issuing ${plan.name} failed (${(err as Error).message}); no key was issued and no secret was written`;
      } else if (lost) {
        // A run that lost its lock writes nothing more, not even a key deletion.
        what = `${(err as Error).message}; the new key ${plan.name} (${key.keyId}) is left in the account; delete it by hand`;
      } else {
        let left: string;
        if (plan.discard) {
          try {
            await plan.discard(key);
            left = `the new key ${plan.name} (${key.keyId}) was deleted`;
          } catch {
            left = `the new key ${plan.name} (${key.keyId}) could not be deleted and is left in the account; delete it by hand`;
          }
        } else {
          left = `the new key ${plan.name} (${key.keyId}) is left in the account; delete it by hand`;
        }
        what = `Writing the secrets of ${plan.name} failed (${(err as Error).message}); ${left}`;
      }
      // The mark's state is read back from D1, never assumed.
      const state = journal ? ` ${await journal.describe(plan.name)}` : "";
      throw new ProvisionStop(`${what}.${state}`);
    }
    await journal?.clear(plan.name);
  };
  for (const plan of plans) {
    if (plan.held && plan.reissue) {
      const older = plan.older
        ? `; the older key ${plan.name} is left in place, to be deleted by hand once the new one is in use`
        : "; the key the secrets held is left in place, to be deleted by hand once the new one is in use";
      if (!apply) {
        log(`  [reissue] would issue ${plan.name} again: ${plan.label}, and replace the secrets that hold it, because ${plan.reissue}${older}`);
        continue;
      }
      await issueAndStore(plan);
      log(`  [reissue] issued ${plan.name} again: ${plan.label}; its secrets are replaced, because ${plan.reissue}${older}`);
      continue;
    }
    if (plan.held) {
      log(`  [exists] ${plan.name}: ${plan.label}; its secrets are set`);
      continue;
    }
    const older = plan.older ? " (an older key of this name exists and is left in place)" : "";
    if (!apply) {
      log(`  [create] would issue ${plan.name}: ${plan.label}, and set the secrets that hold it${older}`);
      continue;
    }
    await issueAndStore(plan);
    log(`  [create] issued ${plan.name}: ${plan.label}; its secrets are set${older}`);
  }
}

/**
 * Why a held key limited to the recorded bucket must be issued again: the
 * record names another bucket than the one wanted. Null when the record
 * names none yet or the same one.
 */
export function bucketChange(what: string, recorded: string | null, wanted: string): string | null {
  if (recorded === null || recorded === wanted) return null;
  return `the ${what} changes from ${recorded} to ${wanted} and the key held is limited to ${recorded}`;
}

export function has(list: string[] | null, ...wanted: string[]): boolean {
  return list !== null && wanted.every((w) => list.includes(w));
}

/** The B2 bucket's id, or a stop naming it when it is not known yet. */
export function idOf(id: string | null, name: string): string {
  if (!id) throw new ProvisionStop(`The B2 bucket ${name} has no id`);
  return id;
}

const B2_CORS_LIST_FIELDS = ["allowedOrigins", "allowedOperations", "allowedHeaders", "exposeHeaders"];

/**
 * One CORS rule in a form that does not depend on how it was written: the
 * list fields sorted (an absent or null list counts as empty, since B2
 * may return a list sent empty as null), `maxAgeSeconds` as a number, and
 * the keys in a fixed order.
 */
function normalizeB2CorsRule(rule: unknown): string {
  const r = (rule ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { corsRuleName: r.corsRuleName ?? null };
  for (const field of B2_CORS_LIST_FIELDS) {
    const list = r[field];
    out[field] = Array.isArray(list) ? [...list].map(String).sort() : [];
  }
  out.maxAgeSeconds = r.maxAgeSeconds == null ? null : Number(r.maxAgeSeconds);
  return JSON.stringify(out);
}

/**
 * Whether the CORS rules a B2 bucket reports are the rules wanted. B2 does
 * not return a rule as it was sent (key order and empty lists can differ),
 * so each rule is compared by content, not as text. The rules themselves
 * are compared in order, because B2 applies the first rule that matches a
 * request, so a different order can behave differently.
 */
export function b2CorsRulesMatch(actual: unknown[] | null | undefined, wanted: unknown[]): boolean {
  const a = (actual ?? []).map(normalizeB2CorsRule);
  const w = wanted.map(normalizeB2CorsRule);
  return a.length === w.length && a.every((x, i) => x === w[i]);
}

// ---------------------------------------------------------------------------
// Bucket role tags
// ---------------------------------------------------------------------------

/**
 * The bucket-info keys that record a bucket's role in B2 itself.
 * Staging and production share one B2 account but not one database, so
 * a role recorded only in D1 is invisible to the other environment;
 * a tag on the bucket is seen by both.
 */
export const BUCKET_TAG_KEYS = {
  role: "fisqua-role",
  env: "fisqua-env",
  federation: "fisqua-federation",
} as const;

export type BucketRole = "tiles" | "masters" | "review-tiles" | "manifests" | "working";

/**
 * A bucket's role, the environment of the run and, except for the
 * shared working bucket, federation (its slug). The environment is part
 * of the tag only for a role whose buckets belong to one environment
 * (`roleCarriesEnv`).
 */
export interface BucketTag {
  role: BucketRole;
  env: "staging" | "production";
  /** Null for the working bucket, which every federation shares. */
  federation: string | null;
}

/**
 * Whether a role's tag records the environment. A masters bucket serves
 * both environments of its federation (staging and production may name
 * the same one, the tenants' prefixes keeping test and real material
 * apart), so its tag is the role and the federation only: `fisqua-env`
 * is never written on it, compared on it or required of it, and a
 * `fisqua-env` it already carries, of either value, is left as it is.
 */
export function roleCarriesEnv(role: BucketRole): boolean {
  return role !== "masters";
}

/** The bucket-info entries of a tag: the ones written, compared and confirmed. */
export function tagInfo(tag: BucketTag): Record<string, string> {
  return {
    [BUCKET_TAG_KEYS.role]: tag.role,
    ...(roleCarriesEnv(tag.role) ? { [BUCKET_TAG_KEYS.env]: tag.env } : {}),
    ...(tag.federation === null ? {} : { [BUCKET_TAG_KEYS.federation]: tag.federation }),
  };
}

function describeTag(info: Record<string, string>): string {
  const role = info[BUCKET_TAG_KEYS.role] ?? "(no role)";
  const shared = info[BUCKET_TAG_KEYS.env] === undefined && role === "masters";
  const env = shared ? "" : `${info[BUCKET_TAG_KEYS.env] ?? "(no environment)"} `;
  const federation = info[BUCKET_TAG_KEYS.federation];
  return `the ${env}${role} bucket${federation ? ` of federation ${federation}` : ""}`;
}

/**
 * Stops when a bucket carries a tag that names another role,
 * environment or federation than the one wanted, naming both. On a
 * masters bucket the environment is not compared (`roleCarriesEnv`). A
 * tag the bucket lacks is not a conflict; `ensureB2Bucket` and `tagBucket` add
 * it. The command never removes or changes a tag.
 */
export function refuseTagConflict(bucket: B2Bucket, name: string, wanted: BucketTag): void {
  const info = bucket.bucketInfo ?? {};
  const want = tagInfo(wanted);
  const differs = Object.entries(want).some(([k, v]) => info[k] !== undefined && info[k] !== v);
  if (!differs) return;
  const tags = Object.values(BUCKET_TAG_KEYS)
    .filter((k) => info[k] !== undefined)
    .map((k) => `${k}=${info[k]}`)
    .join(", ");
  throw new ProvisionStop(
    `The B2 bucket ${name} is tagged as ${describeTag(info)} (${tags}); it cannot be ${describeTag(want)}. ` +
      "The command never changes a bucket's tags: a bucket changes role only by an operator's action outside it",
  );
}

/** Whether a bucket lacks any entry of the tag wanted. */
export function lacksTag(bucket: B2Bucket, wanted: BucketTag): boolean {
  const info = bucket.bucketInfo ?? {};
  return Object.keys(tagInfo(wanted)).some((k) => info[k] === undefined);
}

/**
 * Stops unless the bucket, read from B2 now, carries exactly this tag:
 * its role, its environment (except on a masters bucket, which serves
 * both) and its federation (none for the working bucket). Called after every tag write and immediately before any key
 * is issued over the bucket, so a key is issued only over a bucket whose
 * tag is confirmed in B2, whatever another run did in between.
 */
export async function confirmTag(b2: B2Api, name: string, wanted: BucketTag): Promise<B2Bucket> {
  const bucket = await b2.findBucket(name);
  if (!bucket) throw new ProvisionStop(`The B2 bucket ${name} is no longer in the B2 account`);
  const mismatch = tagMismatch(bucket, name, wanted);
  if (mismatch) {
    throw new ProvisionStop(
      `${mismatch}; no key is issued over it. ${taggingStepFor(wanted)} tags it; ` +
        "the command never changes a tag another run set",
    );
  }
  return bucket;
}

/** The command that tags a bucket of this role. */
export function taggingStepFor(tag: BucketTag): string {
  return tag.role === "working" ? "provision-working-bucket" : "provision-federation-storage";
}

/**
 * Why a bucket's tag is not exactly the one wanted (role, environment
 * except on a masters bucket, and federation, and no federation on the
 * working bucket), or null when it is.
 */
export function tagMismatch(bucket: B2Bucket, name: string, wanted: BucketTag): string | null {
  const info = bucket.bucketInfo ?? {};
  const want = tagInfo(wanted);
  const exact =
    Object.entries(want).every(([k, v]) => info[k] === v) &&
    (wanted.federation !== null || info[BUCKET_TAG_KEYS.federation] === undefined);
  if (exact) return null;
  const tags = Object.values(BUCKET_TAG_KEYS)
    .filter((k) => info[k] !== undefined)
    .map((k) => `${k}=${info[k]}`)
    .join(", ");
  return `The B2 bucket ${name} is not tagged as ${describeTag(want)} (its tags: ${tags || "none"})`;
}

// ---------------------------------------------------------------------------
// The provisioning lock
// ---------------------------------------------------------------------------

/** How long a lock holds before another run may take it, for a run that crashed. */
export const LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Runs `fn` holding the provisioning lock of one destination (`scope`,
 * `federation:{id}` or `tenant:{id}`), so two applied runs never issue
 * keys or set secrets for it at once: a key's id and secret are two
 * secrets, written one after the other, and two runs interleaved could
 * leave one run's id beside the other's secret. A dry run writes nothing
 * and takes no lock. Another run's live lock stops the command, naming
 * the holder and when it started; an expired one is taken over. The lock
 * is released when `fn` ends, whether it succeeded or stopped.
 */
export async function withProvisioningLock<T>(
  providers: Providers,
  scope: string,
  apply: boolean,
  fn: (providers: Providers) => Promise<T>,
): Promise<T> {
  if (!apply) return fn({ ...providers, lease: null });
  const holder = providers.holder ?? "an unnamed run";
  // A token per run: the lock's fencing token, which every write checks.
  const token = randomUUID();
  const now = providers.now();
  const lock = await providers.d1.takeLock(scope, holder, token, now, now + LOCK_TTL_MS);
  if (lock.token !== token) {
    throw new ProvisionStop(
      `Another provisioning run holds the lock on ${scope}: ${lock.holder}, since ${new Date(lock.startedAt).toISOString()}. ` +
        `Run the command again once it has finished; a lock left by a run that crashed expires ${LOCK_TTL_MS / 60000} minutes after it was taken`,
    );
  }
  try {
    return await fn({ ...providers, lease: { scope, token } });
  } finally {
    await providers.d1.releaseLock(scope, token);
  }
}

/** Who this run is, for the provisioning lock: the operator, the machine and the process. */
export function runHolder(): string {
  let user = "unknown user";
  try {
    user = userInfo().username;
  } catch {
    // Some environments give no user; the host and process still name the run.
  }
  return `${user}@${hostname()} (pid ${process.pid})`;
}

/** The SQL that takes a scope's lock: clear an expired one, insert if free, read it back. */
export function takeLockStatements(scope: string, holder: string, token: string, now: number, expiresAt: number): string {
  const s = escapeSql(scope);
  return (
    `DELETE FROM provisioning_locks WHERE scope = ${s} AND expires_at <= ${now}; ` +
    `INSERT OR IGNORE INTO provisioning_locks (scope, holder, token, started_at, expires_at) ` +
    `VALUES (${s}, ${escapeSql(holder)}, ${escapeSql(token)}, ${now}, ${expiresAt}); ` +
    `SELECT holder, token, started_at FROM provisioning_locks WHERE scope = ${s}`
  );
}

/**
 * The SQL that renews a lock this token holds and has not expired, then
 * reads back a row only if the renewal took: one row means the lock is
 * still this run's.
 */
export function renewLockStatements(scope: string, token: string, now: number, expiresAt: number): string {
  const s = escapeSql(scope);
  const t = escapeSql(token);
  return (
    `UPDATE provisioning_locks SET expires_at = ${expiresAt} WHERE scope = ${s} AND token = ${t} AND expires_at > ${now}; ` +
    `SELECT 1 AS held FROM provisioning_locks WHERE scope = ${s} AND token = ${t} AND expires_at = ${expiresAt}`
  );
}

/** The SQL that marks a pair as being written; a mark left by an earlier run is replaced. */
export function markPairStatement(scope: string, pair: string, holder: string, token: string, now: number, fenced = false): string {
  const row = `${escapeSql(scope)}, ${escapeSql(pair)}, ${escapeSql(holder)}, ${escapeSql(token)}, ${now}`;
  return (
    `INSERT OR REPLACE INTO provisioning_pending_pairs (scope, pair, holder, token, started_at) ` +
    (fenced ? `SELECT ${row} WHERE ${fenceCondition({ scope, token, now })}` : `VALUES (${row})`) +
    " RETURNING pair"
  );
}

/**
 * The SQL that clears a pair's mark once both its secrets are written,
 * only when the mark is this token's and this token holds the scope's
 * unexpired lock: one statement, returning the row it deleted, if any.
 */
export function clearPairStatement(scope: string, pair: string, token: string, now: number): string {
  const s = escapeSql(scope);
  const t = escapeSql(token);
  return (
    `DELETE FROM provisioning_pending_pairs WHERE scope = ${s} AND pair = ${escapeSql(pair)} AND token = ${t} ` +
    `AND EXISTS (SELECT 1 FROM provisioning_locks WHERE scope = ${s} AND token = ${t} AND expires_at > ${now}) ` +
    `RETURNING pair`
  );
}

/**
 * The fenced, compare-and-set UPDATE of a federation's destination: it
 * changes the row only while the run holds its lock and every record
 * column still has the value the run read, and returns the row's id if
 * it did. A run whose snapshot is stale, or whose lock is lost, writes
 * nothing.
 */
export function fencedDestinationStatement(
  federationId: string,
  values: DestinationValues,
  expected: FederationRow,
  fence: Fence,
): string {
  const set = destinationStatement(federationId, values).replace(/ WHERE id = .*;$/, "");
  const same = RECORD_COLUMNS.map((c) => {
    const v = expected[c] ?? null;
    return `${c} IS ${v === null ? "NULL" : escapeSql(v)}`;
  }).join(" AND ");
  return `${set} WHERE id = ${escapeSql(federationId)} AND ${same} AND ${fenceCondition(fence)} RETURNING id`;
}

/** The SQL that releases a scope's lock held by this token. */
export function releaseLockStatement(scope: string, token: string): string {
  return `DELETE FROM provisioning_locks WHERE scope = ${escapeSql(scope)} AND token = ${escapeSql(token)}`;
}

/** How many times a write refused for a changed revision is checked and tried again. */
const REVISION_ATTEMPTS = 3;

/**
 * Updates a bucket read just before, only if B2 still holds that
 * revision (`ifRevisionIs`). Returns false when B2 refused it because
 * the bucket changed in between, so the caller reads the bucket again
 * and repeats its checks from scratch; it never writes again blindly.
 */
async function updateAtRevision(
  b2: B2Api,
  bucket: B2Bucket,
  bucketType: B2BucketType,
  corsRules: unknown[] | undefined,
  bucketInfo: Record<string, string> | undefined,
): Promise<boolean> {
  try {
    await b2.updateBucket(bucket.bucketId, bucketType, corsRules, bucketInfo, bucket.revision);
    return true;
  } catch (err) {
    if (err instanceof BucketRevisionConflictError) return false;
    throw err;
  }
}

function revisionConflictStop(name: string): ProvisionStop {
  return new ProvisionStop(
    `The B2 bucket ${name} changed while it was being tagged, ${REVISION_ATTEMPTS} times; ` +
      "another run may be setting it up. Nothing more was written to it; run the command again once that run is done",
  );
}

/**
 * Adds a tag's missing entries to an existing bucket, keeping every
 * other bucket-info key it has (B2 replaces the whole map on update).
 * The bucket is read, checked (`refuseTagConflict`) and written at the
 * revision it was read at; when B2 refuses the write because the bucket
 * changed, it is read and checked again from scratch. After the write
 * the tag is confirmed in B2 (`confirmTag`). Returns the bucket, or null
 * when it is not in the account.
 */
export async function tagBucket(
  b2: B2Api,
  name: string,
  wanted: BucketTag,
  apply: boolean,
  log: Log,
): Promise<B2Bucket | null> {
  for (let attempt = 0; attempt < REVISION_ATTEMPTS; attempt++) {
    const bucket = await b2.findBucket(name);
    if (!bucket) return null;
    refuseTagConflict(bucket, name, wanted);
    if (!lacksTag(bucket, wanted)) return bucket;
    if (!apply) {
      log(`  [update] B2 bucket ${name}: would be tagged as ${describeTag(tagInfo(wanted))}`);
      return bucket;
    }
    const merged = { ...(bucket.bucketInfo ?? {}), ...tagInfo(wanted) };
    if (!(await updateAtRevision(b2, bucket, bucket.bucketType as B2BucketType, undefined, merged))) continue;
    const confirmed = await confirmTag(b2, name, wanted);
    log(`  [update] B2 bucket ${name}: tagged as ${describeTag(tagInfo(wanted))}`);
    return confirmed;
  }
  throw revisionConflictStop(name);
}

/**
 * Finds or creates a B2 bucket with the type, CORS rules and, when
 * given, role tag wanted, and returns its id (null in a dry run that
 * would create it). An existing bucket's other bucket-info keys are
 * kept when its CORS rules or tag are set; a tag naming another role,
 * environment or federation stops the command. Every update is made at
 * the revision just read; a refused one is read and checked again from
 * scratch. A tag written or created is confirmed in B2 afterwards.
 */
export async function ensureB2Bucket(
  b2: B2Api,
  name: string,
  bucketType: B2BucketType,
  corsRules: unknown[],
  description: string,
  apply: boolean,
  log: Log,
  tag: BucketTag | null = null,
): Promise<string | null> {
  for (let attempt = 0; attempt < REVISION_ATTEMPTS; attempt++) {
    const existing = await b2.findBucket(name);
    if (existing) {
      if (existing.bucketType !== bucketType) {
        throw new ProvisionStop(`The B2 bucket ${name} exists but is ${existing.bucketType}, not ${bucketType}`);
      }
      if (tag) refuseTagConflict(existing, name, tag);
      const untagged = tag !== null && lacksTag(existing, tag);
      const corsDiffer = !b2CorsRulesMatch(existing.corsRules, corsRules);
      if (!corsDiffer && !untagged) {
        log(`  [exists] B2 bucket ${name}, ${description}`);
        return existing.bucketId;
      }
      const what =
        [corsDiffer && `CORS rules ${apply ? "set" : "would be set"}`, untagged && `${apply ? "tagged" : "would be tagged"} as ${describeTag(tagInfo(tag!))}`]
          .filter(Boolean)
          .join(" and ");
      if (apply) {
        const info = untagged ? { ...(existing.bucketInfo ?? {}), ...tagInfo(tag!) } : undefined;
        if (!(await updateAtRevision(b2, existing, bucketType, corsDiffer ? corsRules : undefined, info))) continue;
        if (tag) await confirmTag(b2, name, tag);
      }
      log(`  [update] B2 bucket ${name}: ${what} (${description})`);
      return existing.bucketId;
    }
    if (!apply) {
      log(`  [create] would create B2 bucket ${name}, ${description}`);
      return null;
    }
    let created: B2Bucket;
    try {
      created = await b2.createBucket(name, bucketType, corsRules, tag ? tagInfo(tag) : undefined);
    } catch (err) {
      if (err instanceof BucketNameTakenError) {
        throw new ProvisionStop(`The B2 bucket name ${name} is taken; the command does not choose another`);
      }
      throw err;
    }
    if (tag) await confirmTag(b2, name, tag);
    log(`  [create] B2 bucket ${name}, ${description}`);
    return created.bucketId;
  }
  throw revisionConflictStop(name);
}

/**
 * Finds the shared working bucket, which the command never creates, and
 * returns its id. With `tag`, a tag naming another role or environment
 * stops the command.
 */
export async function findWorkingBucket(b2: B2Api, name: string, log: Log, tag: BucketTag | null = null): Promise<string> {
  const working = await b2.findBucket(name);
  if (!working) {
    throw new ProvisionStop(`The working bucket ${name} is not in the B2 account; the command does not create it`);
  }
  if (tag) refuseTagConflict(working, name, tag);
  log(`  [exists] B2 working bucket ${name}`);
  return working.bucketId;
}

/** The names the accounts already hold, which the key plans are checked against. */
export interface HeldKeys {
  /** The Worker's secret names; null without a Worker to ask. */
  workerNames: string[] | null;
  envExists: boolean;
  envSecrets: string[];
  b2Keys: B2KeyInfo[];
  tokenNames: string[];
}

/**
 * What the accounts hold. The runner Environment is read only when one is
 * named, and Cloudflare's tokens only when R2 tokens are part of the
 * step.
 */
export async function heldKeys(
  providers: Providers,
  environment: string | null,
  withTokens = true,
): Promise<HeldKeys> {
  const { b2, github, worker } = providers;
  const cloudflare = withTokens ? providers.cloudflare : null;
  const envExists = github && environment ? await github.environmentExists(environment) : false;
  return {
    workerNames: worker ? await worker.names() : null,
    envExists,
    envSecrets: github && environment && envExists ? await github.environmentSecretNames(environment) : [],
    b2Keys: b2 ? await b2.keys() : [],
    tokenNames: cloudflare ? await cloudflare.tokenNames() : [],
  };
}

// ---------------------------------------------------------------------------
// The tenant step
// ---------------------------------------------------------------------------

export interface TenantStepOptions {
  /** The tenant's slug. */
  slug: string;
  target: Target;
  apply: boolean;
  /** The shared B2 working bucket, which must already exist. */
  workingBucket: string;
}

/** A bucket a runner key is limited to, and the prefix inside it. */
interface KeyLimit {
  bucket: string;
  /** Null in a dry run where the bucket's id was not read. */
  bucketId: string | null;
  prefix: string;
  /** The tag the bucket must carry, confirmed in B2 just before a key is issued over it. */
  tag?: BucketTag | null;
}

/** A capability list in a form that does not depend on its order. */
function capabilitySet(capabilities: readonly string[]): string {
  return [...capabilities].sort().join(",");
}

function limitOf(k: B2KeyInfo): string {
  return `bucket ${k.bucketId ?? "(any)"}, prefix ${k.namePrefix || "(none)"}, capabilities ${capabilitySet(k.capabilities) || "(none)"}`;
}

/**
 * The keys of one name in the B2 account when they are not all limited
 * to the same bucket and prefix; empty otherwise. A key is reissued under
 * the same name and the key it replaces is left in the account, and the
 * secrets that hold a key cannot be read back, so with keys of one name
 * limited differently the command cannot tell which one the secrets hold.
 */
export function ambiguousKeys(name: string, keys: B2KeyInfo[]): B2KeyInfo[] {
  const named = keys.filter((k) => k.keyName === name);
  return new Set(named.map(limitOf)).size > 1 ? named : [];
}

/**
 * Stops when the B2 account holds keys of any of these names limited
 * differently, listing each such key by id and limit (never a secret),
 * so the operator deletes the stale ones by hand. Called with the names
 * of keys whose secrets are set.
 */
export function refuseAmbiguousKeys(names: string[], keys: B2KeyInfo[]): void {
  const lines = names.flatMap((name) => {
    const found = ambiguousKeys(name, keys);
    return found.length === 0
      ? []
      : [`${name}: ${found.map((k) => `key ${k.keyId} (${limitOf(k)})`).join("; ")}`];
  });
  if (lines.length === 0) return;
  throw new ProvisionStop(
    "The B2 account holds keys of one name limited to different buckets or prefixes, so the command cannot " +
      `tell which one the secrets hold: ${lines.join(" | ")}. Delete the stale key(s) by hand, keeping the one ` +
      "in use, and run the command again",
  );
}

/**
 * Why a held B2 key must be issued again: the keys of its name in the
 * account are not limited to the bucket and prefix it should be, or do
 * not have exactly its role's capabilities (one with more, such as a
 * delete key that can also read and write, does not fit). Null when they
 * fit, or when the bucket's id is not known (nothing to compare with).
 * Stops when keys of its name are limited differently
 * (`refuseAmbiguousKeys`).
 */
export function limitChange(
  name: string,
  limit: KeyLimit,
  keys: B2KeyInfo[],
  capabilities: readonly string[],
): string | null {
  refuseAmbiguousKeys([name], keys);
  if (limit.bucketId === null) return null;
  const named = keys.filter((k) => k.keyName === name);
  const placed = named.filter((k) => k.bucketId === limit.bucketId && (k.namePrefix ?? "") === limit.prefix);
  if (placed.length === 0) {
    return `no key named ${name} in the B2 account is limited to ${limit.bucket}/${limit.prefix}`;
  }
  const wanted = capabilitySet(capabilities);
  if (placed.some((k) => capabilitySet(k.capabilities) === wanted)) return null;
  return (
    `the key named ${name} in the B2 account has the capabilities ${capabilitySet(placed[0].capabilities) || "(none)"}, ` +
    `not ${wanted}`
  );
}

const RUNNER_CAPABILITIES = {
  read: B2_READ_CAPABILITIES,
  write: B2_WRITE_CAPABILITIES,
  delete: B2_DELETE_CAPABILITIES,
} as const;

/**
 * The runner's keys, each held in the tenant's Environment under one
 * id/key pair of names: tiles write and read and masters read, limited to
 * the tenant's slug in the federation's buckets; working write and read,
 * limited to the tenant's id in the working bucket; and, when `review` is
 * given, review write and delete, limited to the tenant's slug in the
 * federation's review-tiles bucket.
 */
export function runnerKeyPlans(
  environment: string,
  keys: TenantKeyNames,
  limits: { tiles: KeyLimit; masters: KeyLimit; working: KeyLimit; review: KeyLimit | null },
  held: HeldKeys,
  providers: Providers,
  pending: string[] = [],
): KeyPlan[] {
  type Access = keyof typeof RUNNER_CAPABILITIES;
  const roles: Array<[Access, string, KeyLimit, string, string]> = [
    ["write", keys.runnerWrite, limits.tiles, RUNNER_SECRETS.writeKeyId, RUNNER_SECRETS.writeKey],
    ["read", keys.runnerRead, limits.tiles, RUNNER_SECRETS.readKeyId, RUNNER_SECRETS.readKey],
    ["read", keys.mastersRead, limits.masters, RUNNER_SECRETS.sourceReadKeyId, RUNNER_SECRETS.sourceReadKey],
    ["write", keys.workingWrite, limits.working, RUNNER_SECRETS.workingWriteKeyId, RUNNER_SECRETS.workingWriteKey],
    ["read", keys.workingRead, limits.working, RUNNER_SECRETS.workingReadKeyId, RUNNER_SECRETS.workingReadKey],
    ...(limits.review
      ? ([
          ["write", keys.reviewWrite, limits.review, RUNNER_SECRETS.reviewWriteKeyId, RUNNER_SECRETS.reviewWriteKey],
          ["delete", keys.reviewDelete, limits.review, RUNNER_SECRETS.reviewDeleteKeyId, RUNNER_SECRETS.reviewDeleteKey],
        ] as Array<[Access, string, KeyLimit, string, string]>)
      : []),
  ];
  // Every held key's name at once, so one stop lists every stale key.
  const heldNames = roles
    .filter(([, , , idName, keyName]) => has(held.envSecrets, idName, keyName))
    .map(([, name]) => name);
  refuseAmbiguousKeys(heldNames, held.b2Keys);
  const plan = (access: Access, name: string, limit: KeyLimit, idName: string, keyName: string): KeyPlan => {
    const isHeld = has(held.envSecrets, idName, keyName);
    return {
      label: `B2 key, ${access}, limited to ${limit.bucket}/${limit.prefix} (runner)`,
      name,
      held: isHeld,
      older: held.b2Keys.some((k) => k.keyName === name),
      // A pair left half written is issued again whatever its live key looks like.
      reissue: !isHeld
        ? null
        : pending.includes(name)
          ? PENDING_PAIR_REASON
          : limitChange(name, limit, held.b2Keys, RUNNER_CAPABILITIES[access]),
      secretNames: [idName, keyName],
      discard: (k) => providers.b2!.deleteKey(k.keyId),
      issue: async () => {
        if (limit.tag) await confirmTag(providers.b2!, limit.bucket, limit.tag);
        return providers.b2!.createKey(name, RUNNER_CAPABILITIES[access], idOf(limit.bucketId, limit.bucket), limit.prefix);
      },
      store: async (k, guard) => {
        await guard(() => providers.github!.setEnvironmentSecret(environment, idName, k.keyId));
        await guard(() => providers.github!.setEnvironmentSecret(environment, keyName, k.secret));
      },
    };
  };
  return roles.map((role) => ({ ...plan(...role), limit: { bucket: role[2].bucket, tag: role[2].tag ?? null } }));
}

/**
 * Stops when a key would be issued (not held, or issued again) over a
 * bucket whose tag is not exactly the one its plan needs, listing each
 * such bucket and the command that tags it. Reads B2 only.
 */
export async function refuseUntaggedForKeys(b2: B2Api, plans: KeyPlan[]): Promise<void> {
  const needed = new Map<string, BucketTag>();
  for (const p of plans) {
    if (p.held && !p.reissue) continue;
    if (p.limit?.tag) needed.set(p.limit.bucket, p.limit.tag);
  }
  const problems: string[] = [];
  for (const [name, tag] of needed) {
    const bucket = await b2.findBucket(name);
    const mismatch = bucket ? tagMismatch(bucket, name, tag) : `The B2 bucket ${name} is not in the B2 account`;
    if (mismatch) problems.push(`${mismatch}; run ${taggingStepFor(tag)} first`);
  }
  if (problems.length > 0) {
    throw new ProvisionStop(`No runner key can be issued yet. ${problems.join(". ")}`);
  }
}

/** Creates the runner's Environment when GitHub is at hand and it is missing. */
async function ensureRunnerEnvironment(
  github: GitHubApi | null,
  environment: string,
  exists: boolean,
  apply: boolean,
  log: Log,
): Promise<void> {
  if (!github || exists) return;
  if (apply) await github.createEnvironment(environment);
  log(`  [create] ${apply ? "" : "would create "}runner Environment ${environment}`);
}

/**
 * Adds the Environment to `PIPELINE_ENVIRONMENTS` and the storage host to
 * `PIPELINE_STORAGE_HOSTS`, keeping what each already lists.
 */
async function ensureRunnerVariables(
  github: GitHubApi | null,
  environment: string,
  storageHost: string,
  apply: boolean,
  log: Log,
): Promise<void> {
  if (!github) {
    log(`  [unchecked] PIPELINE_ENVIRONMENTS and PIPELINE_STORAGE_HOSTS (no GitHub credentials)`);
    return;
  }
  const environments = listOf(await github.variable("PIPELINE_ENVIRONMENTS"));
  if (environments.includes(environment)) {
    log(`  [exists] PIPELINE_ENVIRONMENTS lists ${environment}`);
  } else {
    if (apply) await github.setVariable("PIPELINE_ENVIRONMENTS", [...environments, environment].join(","));
    log(`  [update] ${apply ? "added" : "would add"} ${environment} to PIPELINE_ENVIRONMENTS`);
  }
  const hosts = listOf(await github.variable("PIPELINE_STORAGE_HOSTS"));
  if (hosts.includes(storageHost)) {
    log(`  [exists] PIPELINE_STORAGE_HOSTS lists ${storageHost}`);
  } else {
    if (apply) await github.setVariable("PIPELINE_STORAGE_HOSTS", [...hosts, storageHost].join(","));
    log(`  [update] ${apply ? "added" : "would add"} ${storageHost} to PIPELINE_STORAGE_HOSTS`);
  }
}

/** Finds a bucket of the federation's record in the B2 account, never creating it. */
export async function findRecordBucket(
  b2: B2Api,
  name: string,
  what: string,
  log: Log,
  tag: BucketTag | null = null,
): Promise<string> {
  const bucket = await b2.findBucket(name);
  if (!bucket) {
    throw new ProvisionStop(
      `The federation's ${what} ${name} is not in the B2 account; run provision-federation-storage first`,
    );
  }
  if (tag) {
    // A tag naming another role, environment or federation stops the
    // command; a review-tiles bucket must also carry its own tag or be
    // empty, since only then can its review keys reach nothing else.
    refuseTagConflict(bucket, name, tag);
    if (tag.role === "review-tiles" && lacksTag(bucket, tag) && (await b2.hasFileVersions(bucket.bucketId))) {
      throw new ProvisionStop(
        `The federation's review-tiles bucket ${name} holds files and is not tagged as ${describeTag(tagInfo(tag))}; ` +
          "run provision-federation-storage, which tags it only when it is empty",
      );
    }
  }
  log(`  [exists] B2 ${what} ${name}`);
  return bucket.bucketId;
}

/**
 * The tenant of a slug and its federation, whose storage record must be
 * complete. Stops for an unknown slug, a tenant without a federation and
 * a federation without a complete record. Reads D1 only.
 */
export async function resolveTenantStorage(
  slug: string,
  d1: D1Api,
): Promise<{ tenant: TenantRow; federation: FederationRow & DestinationValues }> {
  const tenant = await d1.tenant(slug);
  if (!tenant) throw new ProvisionStop(`No tenant has the slug ${slug}`);
  const federation = tenant.federation_id ? await d1.federationById(tenant.federation_id) : null;
  if (!federation) throw new ProvisionStop(`The tenant ${slug} has no federation, so it has no storage`);
  const missing = missingRecordColumns(federation);
  if (missing.length > 0 || !isRecordComplete(federation)) {
    throw new ProvisionStop(
      `The federation ${federation.slug} has no complete storage record (unset: ${missing.join(", ")}); ` +
        "run provision-federation-storage first",
    );
  }
  return { tenant, federation };
}

/**
 * Gives one tenant's runs their keys in its federation's storage: the
 * runner's Environment and its keys (five, or seven with the
 * federation's review-tiles bucket), and the runner's repository
 * variables. Writes nothing to D1.
 */
export async function provisionTenantStorage(
  options: TenantStepOptions,
  providers: Providers,
  log: Log,
): Promise<void> {
  const { apply, target } = options;
  if (target === "local") {
    throw new ProvisionStop("The tenant step issues keys in the accounts; use --target staging or production");
  }
  if (!BUCKET_PATTERN.test(options.workingBucket)) {
    throw new ProvisionStop(`Not a bucket name: ${options.workingBucket}`);
  }
  const { tenant, federation } = await resolveTenantStorage(options.slug, providers.d1);
  // One applied run at a time per tenant: see `withProvisioningLock`.
  return withProvisioningLock(providers, `tenant:${tenant.id}`, apply, (locked) =>
    tenantStep(options, locked, log, tenant, federation),
  );
}

async function tenantStep(
  options: TenantStepOptions,
  providers: Providers,
  log: Log,
  tenant: TenantRow,
  federation: FederationRow & DestinationValues,
): Promise<void> {
  const { apply } = options;
  const target = options.target as "staging" | "production";
  const names = tenantStorageNames(tenant.slug, tenant.id, target);
  const { b2, github, worker } = providers;
  // Before anything is read from or issued in the accounts: a working
  // bucket that is one of the federation's buckets, or another
  // federation's, would put the working keys' write access there.
  await refuseBucketAliases(federation.id, federation, options.workingBucket, providers, federation);

  log(
    `Runner keys for tenant ${tenant.slug} (${tenant.id}) in federation ${federation.slug}, ` +
      `target ${target}${apply ? "" : ", dry run"}`,
  );
  log("");
  log("Names");
  log(`  tiles (B2, federation's):     ${federation.pipeline_tiles_bucket}/${names.slugPrefix}`);
  log(`  masters (B2, federation's):   ${federation.pipeline_masters_bucket}/${names.slugPrefix}`);
  const reviewBucket = federation.pipeline_review_tiles_bucket ?? null;
  log(`  working space (B2, shared):   ${options.workingBucket}/${names.workingPrefix}`);
  log(`  review tiles (B2, federation's): ${reviewBucket ? `${reviewBucket}/${names.slugPrefix}` : "(none recorded)"}`);
  log(`  runner Environment:           ${names.environment}`);
  if (apply) {
    const absent = [!b2 && "B2", !github && "GitHub"].filter(Boolean);
    if (absent.length > 0) throw new ProvisionStop(`--apply needs credentials for: ${absent.join(", ")}`);
  }
  if (worker) {
    const secrets = Object.values(workerSecretNames(federation.storage_secret_prefix));
    const workerNames = await worker.names();
    const unset = secrets.filter((s) => !workerNames.includes(s));
    if (unset.length > 0) {
      throw new ProvisionStop(
        `The federation ${federation.slug}'s Worker secrets are not set (${unset.join(", ")}); ` +
          "run provision-federation-storage first",
      );
    }
  }

  // The tags each bucket must carry: checked in step 1 and confirmed in
  // B2 again just before any key is issued over it.
  const tagFor = (role: BucketRole): BucketTag => ({ role, env: target, federation: federation.slug });
  const workingTag: BucketTag = { role: "working", env: target, federation: null };

  log("");
  log("1. Buckets");
  let tilesId: string | null = null;
  let mastersId: string | null = null;
  let workingId: string | null = null;
  let reviewId: string | null = null;
  if (!b2) {
    log(
      `  [unchecked] B2 buckets ${federation.pipeline_tiles_bucket}, ${federation.pipeline_masters_bucket}` +
        `${reviewBucket ? `, ${reviewBucket}` : ""} and ${options.workingBucket} (no B2 credentials)`,
    );
  } else {
    // Every bucket's tag is checked here, before any key is issued.
    tilesId = await findRecordBucket(b2, federation.pipeline_tiles_bucket, "tiles bucket", log, tagFor("tiles"));
    mastersId = await findRecordBucket(b2, federation.pipeline_masters_bucket, "masters bucket", log, tagFor("masters"));
    if (reviewBucket) reviewId = await findRecordBucket(b2, reviewBucket, "review-tiles bucket", log, tagFor("review-tiles"));
    workingId = await findWorkingBucket(b2, options.workingBucket, log, workingTag);
  }

  log("");
  log("2. Runner keys");
  const held = await heldKeys(providers, names.environment, false);
  const plans = runnerKeyPlans(
    names.environment,
    names.keys,
    {
      tiles: { bucket: federation.pipeline_tiles_bucket, bucketId: tilesId, prefix: names.slugPrefix, tag: tagFor("tiles") },
      masters: { bucket: federation.pipeline_masters_bucket, bucketId: mastersId, prefix: names.slugPrefix, tag: tagFor("masters") },
      working: { bucket: options.workingBucket, bucketId: workingId, prefix: names.workingPrefix, tag: workingTag },
      review: reviewBucket
        ? { bucket: reviewBucket, bucketId: reviewId, prefix: names.slugPrefix, tag: tagFor("review-tiles") }
        : null,
    },
    held,
    providers,
    await providers.d1.pendingPairs(`tenant:${tenant.id}`),
  );
  if (!reviewBucket) {
    log(
      `  [note] the federation records no review-tiles bucket, so ${names.keys.reviewWrite} and ` +
        `${names.keys.reviewDelete} are not issued and its volumes skip the review run`,
    );
  }
  if (plans.some((p) => p.held && p.reissue)) {
    // Before any key is issued again, so no job of open work reads a key
    // limited to a destination its spec does not name.
    await refuseWhilePending({ tenantId: tenant.id }, providers, "its runner keys cannot be issued again");
  }
  if (b2 && github) {
    // In the dry run as on apply: a key is issued only over a bucket
    // tagged exactly for its role, so the plan stops here, naming the
    // step that tags each bucket, rather than promising keys it would
    // refuse to issue.
    await refuseUntaggedForKeys(b2, plans);
  }
  await ensureRunnerEnvironment(github, names.environment, held.envExists, apply, log);
  if (!b2 || !github) {
    for (const p of plans) log(`  [unchecked] ${p.name}: ${p.label} (no ${!b2 ? "B2" : "GitHub"} credentials)`);
  } else {
    await issueKeys(plans, apply, log, providers.lease ? pairJournal(providers, providers.lease) : null);
  }

  log("");
  log("3. Runner repository variables");
  await ensureRunnerVariables(github, names.environment, hostOf(federation.pipeline_delivery_endpoint), apply, log);
}

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

async function json(res: Response, what: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.code ?? body?.errors?.[0]?.message ?? body?.message ?? res.statusText;
    const err = new Error(`${what} failed with ${res.status}: ${detail}`) as Error & { status: number; body: any };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Backblaze B2 native API, version 2. */
export function b2Client(keyId: string, applicationKey: string, fetchImpl: typeof fetch): B2Api {
  let session: Promise<{ accountId: string; apiUrl: string; s3ApiUrl: string; downloadUrl: string; token: string }> | null =
    null;
  const authorize = () => {
    session ??= (async () => {
      const res = await fetchImpl("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
        headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${applicationKey}`).toString("base64")}` },
      });
      const body = await json(res, "b2_authorize_account");
      return {
        accountId: body.accountId,
        apiUrl: body.apiUrl,
        s3ApiUrl: body.s3ApiUrl,
        downloadUrl: body.downloadUrl,
        token: body.authorizationToken,
      };
    })();
    return session;
  };
  // The account and bucket operations take `accountId`; the file
  // operations (`b2_list_file_names`, `b2_copy_file`) take only their own
  // parameters, so it is sent only where the operation names it.
  const ACCOUNT_OPS = new Set(["b2_list_keys", "b2_list_buckets", "b2_create_bucket", "b2_update_bucket", "b2_create_key"]);
  const call = async (op: string, payload: Record<string, unknown>) => {
    const s = await authorize();
    const res = await fetchImpl(`${s.apiUrl}/b2api/v2/${op}`, {
      method: "POST",
      headers: { Authorization: s.token, "Content-Type": "application/json" },
      body: JSON.stringify(ACCOUNT_OPS.has(op) ? { accountId: s.accountId, ...payload } : payload),
    });
    return json(res, op);
  };
  // Every key's name and limits; b2_list_keys never returns a key's secret.
  const listKeys = async (): Promise<B2KeyInfo[]> => {
    const out: B2KeyInfo[] = [];
    let start: string | null = null;
    do {
      const body: any = await call("b2_list_keys", { maxKeyCount: 1000, ...(start ? { startApplicationKeyId: start } : {}) });
      for (const k of body.keys ?? []) {
        out.push({
          keyId: k.applicationKeyId,
          keyName: k.keyName,
          bucketId: k.bucketId ?? null,
          namePrefix: k.namePrefix ?? null,
          capabilities: k.capabilities ?? [],
        });
      }
      start = body.nextApplicationKeyId ?? null;
    } while (start);
    return out;
  };
  return {
    async account() {
      const s = await authorize();
      return { s3ApiUrl: s.s3ApiUrl, downloadUrl: s.downloadUrl };
    },
    async findBucket(name) {
      const body = await call("b2_list_buckets", { bucketName: name });
      return (body.buckets ?? []).find((b: B2Bucket) => b.bucketName === name) ?? null;
    },
    async createBucket(name, bucketType, corsRules, bucketInfo) {
      try {
        return await call("b2_create_bucket", {
          bucketName: name,
          bucketType,
          corsRules,
          ...(bucketInfo ? { bucketInfo } : {}),
        });
      } catch (err) {
        if ((err as any).body?.code === "duplicate_bucket_name") throw new BucketNameTakenError(name);
        throw err;
      }
    },
    async updateBucket(bucketId, bucketType, corsRules, bucketInfo, ifRevisionIs) {
      try {
        await call("b2_update_bucket", {
          bucketId,
          bucketType,
          ...(corsRules ? { corsRules } : {}),
          ...(bucketInfo ? { bucketInfo } : {}),
          ...(ifRevisionIs !== undefined ? { ifRevisionIs } : {}),
        });
      } catch (err) {
        // B2 answers a revision that no longer matches with 409 `conflict`.
        if ((err as any).status === 409 || (err as any).body?.code === "conflict") {
          throw new BucketRevisionConflictError(bucketId);
        }
        throw err;
      }
    },
    async keyNames() {
      return (await listKeys()).map((k) => k.keyName);
    },
    async keys() {
      return listKeys();
    },
    async deleteKey(keyId) {
      await call("b2_delete_key", { applicationKeyId: keyId });
    },
    async createKey(name, capabilities, bucketId, namePrefix) {
      const body = await call("b2_create_key", {
        keyName: name,
        capabilities,
        bucketId,
        ...(namePrefix ? { namePrefix } : {}),
      });
      return { keyId: body.applicationKeyId, secret: body.applicationKey };
    },
    async listFiles(bucketId, prefix) {
      // b2_list_file_names lists the current version of each file,
      // 1000 a page; `nextFileName` carries the listing on.
      const out: B2FileInfo[] = [];
      let start: string | null = null;
      do {
        const body: any = await call("b2_list_file_names", {
          bucketId,
          prefix,
          maxFileCount: 1000,
          ...(start ? { startFileName: start } : {}),
        });
        for (const f of body.files ?? []) {
          if (f.action === "upload") out.push({ fileName: f.fileName, contentLength: f.contentLength });
        }
        start = body.nextFileName ?? null;
      } while (start);
      return out;
    },
    async listFileDetails(bucketId, prefix) {
      const out: B2FileDetail[] = [];
      let start: string | null = null;
      do {
        const body: any = await call("b2_list_file_names", {
          bucketId,
          prefix,
          maxFileCount: 1000,
          ...(start ? { startFileName: start } : {}),
        });
        for (const f of body.files ?? []) {
          if (f.action !== "upload") continue;
          out.push({ fileName: f.fileName, contentLength: f.contentLength, fileId: f.fileId, sha1: sha1Of(f) });
        }
        start = body.nextFileName ?? null;
      } while (start);
      return out;
    },
    async listFileVersions(bucketId, prefix) {
      // b2_list_file_versions lists every version, each name's newest
      // first; a page ends inside a name's versions, so the listing goes
      // on from `nextFileName` and `nextFileId` together.
      const out: B2FileVersion[] = [];
      let start: { name: string; id: string | null } | null = null;
      do {
        const body: any = await call("b2_list_file_versions", {
          bucketId,
          prefix,
          maxFileCount: 1000,
          ...(start ? { startFileName: start.name, ...(start.id ? { startFileId: start.id } : {}) } : {}),
        });
        for (const f of body.files ?? []) {
          if (f.action !== "upload" && f.action !== "hide" && f.action !== "start") continue;
          out.push({
            fileName: f.fileName,
            fileId: f.fileId,
            action: f.action,
            contentLength: f.contentLength ?? 0,
            sha1: sha1Of(f),
          });
        }
        start = body.nextFileName ? { name: body.nextFileName, id: body.nextFileId ?? null } : null;
      } while (start);
      return out;
    },
    async listFolders(bucketId, prefix) {
      // With a delimiter, B2 returns one "folder" entry per name segment
      // under the prefix instead of the files inside it.
      const out: string[] = [];
      let start: string | null = null;
      do {
        const body: any = await call("b2_list_file_names", {
          bucketId,
          prefix,
          delimiter: "/",
          maxFileCount: 1000,
          ...(start ? { startFileName: start } : {}),
        });
        for (const f of body.files ?? []) {
          if (f.action === "folder") out.push(f.fileName);
        }
        start = body.nextFileName ?? null;
      } while (start);
      return out;
    },
    async hasFileVersions(bucketId) {
      const body = await call("b2_list_file_versions", { bucketId, maxFileCount: 1 });
      return (body.files ?? []).length > 0;
    },
    async copyFile(sourceFileId, fileName, destinationBucketId) {
      const body = await call("b2_copy_file", { sourceFileId, fileName, destinationBucketId, metadataDirective: "COPY" });
      return { fileId: body.fileId };
    },
  };
}

/** The name of the account-level permission an R2 object-write token is given. */
export const R2_WRITE_PERMISSION = "Workers R2 Storage Bucket Item Write";

/** Cloudflare API v4, with an API token and an account id. */
export function cloudflareClient(
  token: string,
  accountId: string,
  fetchImpl: typeof fetch,
): CloudflareApi {
  const base = "https://api.cloudflare.com/client/v4";
  const req = async (method: string, path: string, body?: unknown, allow404 = false) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    return json(res, `${method} ${path}`);
  };
  const acct = `/accounts/${accountId}`;
  return {
    s3Endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    async findZone(domain) {
      const body = await req("GET", `/zones?name=${encodeURIComponent(domain)}`);
      return body.result?.[0]?.id ?? null;
    },
    async r2BucketExists(name) {
      return (await req("GET", `${acct}/r2/buckets/${name}`, undefined, true)) !== null;
    },
    async createR2Bucket(name) {
      await req("POST", `${acct}/r2/buckets`, { name });
    },
    async r2Cors(name) {
      const body = await req("GET", `${acct}/r2/buckets/${name}/cors`, undefined, true);
      return body?.result?.rules ?? null;
    },
    async putR2Cors(name, rules) {
      await req("PUT", `${acct}/r2/buckets/${name}/cors`, { rules });
    },
    async r2CustomDomains(name) {
      const body = await req("GET", `${acct}/r2/buckets/${name}/domains/custom`);
      return (body.result?.domains ?? []).map((d: { domain: string }) => d.domain);
    },
    async addR2CustomDomain(name, domain, zoneId) {
      await req("POST", `${acct}/r2/buckets/${name}/domains/custom`, { domain, zoneId, enabled: true });
    },
    async findCname(zoneId, name) {
      const body = await req("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`);
      const r = body.result?.[0];
      return r ? { content: r.content, proxied: Boolean(r.proxied) } : null;
    },
    async createCname(zoneId, name, content) {
      await req("POST", `/zones/${zoneId}/dns_records`, { type: "CNAME", name, content, proxied: true, ttl: 1 });
    },
    async transformRules(zoneId) {
      const body = await req("GET", `/zones/${zoneId}/rulesets/phases/http_request_transform/entrypoint`, undefined, true);
      return body?.result?.rules ?? [];
    },
    async putTransformRules(zoneId, rules) {
      await req("PUT", `/zones/${zoneId}/rulesets/phases/http_request_transform/entrypoint`, { rules });
    },
    async tokenNames() {
      const body = await req("GET", `${acct}/tokens`);
      return (body.result ?? []).map((t: { name: string }) => t.name);
    },
    async createR2WriteToken(name, bucket) {
      const groups = await req("GET", `${acct}/tokens/permission_groups`);
      const group = (groups.result ?? []).find((g: { name: string }) => g.name === R2_WRITE_PERMISSION);
      if (!group) throw new ProvisionStop(`The permission group "${R2_WRITE_PERMISSION}" was not found`);
      const body = await req("POST", `${acct}/tokens`, {
        name,
        policies: [
          {
            effect: "allow",
            resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: "*" },
            permission_groups: [{ id: group.id }],
          },
        ],
      });
      // R2's S3 credentials for a token: the token id, and the SHA-256 of its value.
      return {
        keyId: body.result.id,
        secret: createHash("sha256").update(body.result.value).digest("hex"),
      };
    },
  };
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> },
) => string;

/** Runs a CLI with its input on stdin, so no secret value is ever an argument. */
export const execCommand: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

/** The B2 client from the operator's shell, or null without its two variables. */
export function b2FromEnv(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): B2Api | null {
  return env.B2_APPLICATION_KEY_ID && env.B2_APPLICATION_KEY
    ? b2Client(env.B2_APPLICATION_KEY_ID, env.B2_APPLICATION_KEY, fetchImpl)
    : null;
}

/** GitHub REST API for the runner repository; secrets go through `gh`, which encrypts them. */
export function githubClient(
  token: string,
  repository: string,
  fetchImpl: typeof fetch,
  run: CommandRunner,
): GitHubApi {
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const req = async (method: string, path: string, body?: unknown, allow404 = false) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    if (res.status === 204) return {};
    return json(res, `${method} ${path}`);
  };
  return {
    async environmentExists(name) {
      return (await req("GET", `/environments/${encodeURIComponent(name)}`, undefined, true)) !== null;
    },
    async createEnvironment(name) {
      await req("PUT", `/environments/${encodeURIComponent(name)}`, {});
    },
    async environmentSecretNames(name) {
      const body = await req("GET", `/environments/${encodeURIComponent(name)}/secrets?per_page=100`);
      return (body.secrets ?? []).map((s: { name: string }) => s.name);
    },
    async setEnvironmentSecret(environment, name, value) {
      run("gh", ["secret", "set", name, "--env", environment, "--repo", repository], {
        input: value,
        env: { GH_TOKEN: token },
      });
    },
    async variable(name) {
      const body = await req("GET", `/actions/variables/${name}`, undefined, true);
      return body === null ? null : (body.value ?? null);
    },
    async setVariable(name, value) {
      const current = await req("GET", `/actions/variables/${name}`, undefined, true);
      if (current === null) await req("POST", `/actions/variables`, { name, value });
      else await req("PATCH", `/actions/variables/${name}`, { name, value });
    },
  };
}

function wranglerEnvArgs(target: Target): string[] {
  return target === "staging" ? ["--env", "staging"] : [];
}

/** Worker secrets through `wrangler secret list` and `wrangler secret put`. */
export function wranglerSecrets(target: Target, run: CommandRunner): WorkerSecretsApi {
  if (target === "local") {
    throw new ProvisionStop("Worker secrets for local development go in .dev.vars, by hand");
  }
  return {
    async names() {
      const out = run("npx", ["wrangler", "secret", "list", ...wranglerEnvArgs(target)], {});
      const parsed = JSON.parse(out) as Array<{ name: string }>;
      return parsed.map((s) => s.name);
    },
    async put(name, value) {
      run("npx", ["wrangler", "secret", "put", name, ...wranglerEnvArgs(target)], { input: value });
    },
  };
}

/** The `wrangler d1 execute` arguments for a target's database. */
export function d1Args(target: Target): string[] {
  if (target === "local") return ["wrangler", "d1", "execute", "fisqua-db", "--local"];
  if (target === "staging") return ["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote"];
  return ["wrangler", "d1", "execute", "fisqua-db", "--remote"];
}

const FEDERATION_COLUMNS = ["id", "slug", ...RECORD_COLUMNS];
const TENANT_COLUMNS = ["id", "slug", "federation_id"];

/** The tenants whose work a pending-work count covers. */
function scopeCondition(scope: PendingScope): string {
  return "federationId" in scope
    ? `tenant_id IN (SELECT id FROM tenants WHERE federation_id = ${escapeSql(scope.federationId)})`
    : `tenant_id = ${escapeSql(scope.tenantId)}`;
}

/**
 * The open runs, and the volumes whose output is made but not yet
 * published (`prepared` or `ready`) whatever became of their run, of one
 * tenant or of every tenant in one federation.
 */
export function pendingWorkStatement(scope: PendingScope, now: number): string {
  const where = scopeCondition(scope);
  return (
    `SELECT (SELECT COUNT(*) FROM pipeline_runs WHERE ${where} ` +
    `AND token_revoked_at IS NULL AND token_expires_at > ${now}) AS open_runs, ` +
    `(SELECT COUNT(*) FROM pipeline_volumes WHERE ${where} ` +
    `AND state IN ('prepared', 'ready')) AS unpublished_volumes`
  );
}

/** The tenant and federation rows through `wrangler d1 execute`. */
export function wranglerD1(target: Target, run: CommandRunner): D1Api {
  const query = <T>(sql: string): T[] => {
    const out = run("npx", [...d1Args(target), "--json", "--command", sql], {});
    const parsed = JSON.parse(out) as Array<{ results: T[] }>;
    return parsed[0]?.results ?? [];
  };
  // NULL is selected as '' and read back as null: the local database's
  // JSON output gives a NULL as the string "null".
  const select = (columns: string[]) => columns.map((c) => `IFNULL(${c}, '') AS ${c}`).join(", ");
  const toRow = <T>(columns: string[]) => (r: Record<string, string>): T =>
    Object.fromEntries(columns.map((c) => [c, r[c] === "" ? null : r[c]])) as unknown as T;
  const federations = (where: string) =>
    query<Record<string, string>>(`SELECT ${select(FEDERATION_COLUMNS)} FROM federations WHERE ${where}`).map(
      toRow<FederationRow>(FEDERATION_COLUMNS),
    );
  return {
    async tenant(slug) {
      const rows = query<Record<string, string>>(
        `SELECT ${select(TENANT_COLUMNS)} FROM tenants WHERE slug = ${escapeSql(slug)}`,
      );
      return rows[0] ? toRow<TenantRow>(TENANT_COLUMNS)(rows[0]) : null;
    },
    async federation(slug) {
      return federations(`slug = ${escapeSql(slug)}`)[0] ?? null;
    },
    async federationById(id) {
      return federations(`id = ${escapeSql(id)}`)[0] ?? null;
    },
    async tenantsOf(federationId) {
      return query<{ slug: string }>(
        `SELECT slug FROM tenants WHERE federation_id = ${escapeSql(federationId)} ORDER BY slug`,
      ).map((r) => r.slug);
    },
    async otherDestinations(federationId) {
      const any = RECORD_COLUMNS.map((c) => `${c} IS NOT NULL`).join(" OR ");
      return federations(`id <> ${escapeSql(federationId)} AND (${any})`);
    },
    async pendingWork(scope, now) {
      const rows = query<{ open_runs: number; unpublished_volumes: number }>(pendingWorkStatement(scope, now));
      return {
        openRuns: Number(rows[0]?.open_runs ?? 0),
        unpublishedVolumes: Number(rows[0]?.unpublished_volumes ?? 0),
      };
    },
    async writeDestination(federationId, values, expected, fence) {
      return query<{ id: string }>(fencedDestinationStatement(federationId, values, expected, fence)).length > 0;
    },
    async takeLock(scope, holder, token, now, expiresAt) {
      // One command, three statements; the last one's rows are the lock.
      const out = run("npx", [...d1Args(target), "--json", "--command", takeLockStatements(scope, holder, token, now, expiresAt)], {});
      const parsed = JSON.parse(out) as Array<{ results: Array<{ holder: string; token: string; started_at: number }> }>;
      const row = parsed.at(-1)?.results?.[0];
      if (!row) throw new ProvisionStop(`The provisioning lock on ${scope} could not be read back`);
      return { holder: row.holder, token: row.token, startedAt: Number(row.started_at) };
    },
    async renewLock(scope, token, now, expiresAt) {
      const out = run("npx", [...d1Args(target), "--json", "--command", renewLockStatements(scope, token, now, expiresAt)], {});
      const parsed = JSON.parse(out) as Array<{ results: unknown[] }>;
      return (parsed.at(-1)?.results?.length ?? 0) > 0;
    },
    async releaseLock(scope, token) {
      run("npx", [...d1Args(target), "--command", releaseLockStatement(scope, token)], {});
    },
    async pendingPairs(scope) {
      return query<{ pair: string }>(`SELECT pair FROM provisioning_pending_pairs WHERE scope = ${escapeSql(scope)} ORDER BY pair`).map(
        (r) => r.pair,
      );
    },
    async markOf(scope, pair) {
      const rows = query<{ token: string }>(
        `SELECT token FROM provisioning_pending_pairs WHERE scope = ${escapeSql(scope)} AND pair = ${escapeSql(pair)}`,
      );
      return rows[0]?.token ?? null;
    },
    async markPair(scope, pair, holder, token, now, fenced) {
      return query<{ pair: string }>(markPairStatement(scope, pair, holder, token, now, fenced)).length > 0;
    },
    async clearPair(scope, pair, token, now) {
      return query<{ pair: string }>(clearPairStatement(scope, pair, token, now)).length > 0;
    },
  };
}

// @version v0.8.0
