/**
 * Media Pipeline — A Tenant's Storage Destination
 *
 * This module deals with where a tenant's pipeline output goes: the
 * bucket the runner writes tiles and page text to, the public address
 * those tiles are served from, the bucket canonical manifests are
 * written to and the address they are served from, and the keys Fisqua
 * uses to read the one and write the other.
 *
 * The buckets belong to the tenant's federation, and each tenant's
 * output sits under its own slug inside them. The federation's row
 * holds the names and addresses (the destination record); the keys are
 * Worker secrets named from the row's `storage_secret_prefix`:
 * `{prefix}_DELIVERY_READ_KEY_ID`, `{prefix}_DELIVERY_READ_SECRET_KEY`,
 * `{prefix}_MANIFEST_WRITE_KEY_ID` and `{prefix}_MANIFEST_WRITE_SECRET_KEY`
 * (`destinationSecretNames`). D1 never holds a key. The prefix must be
 * upper-case letters, digits and underscores, starting with a letter,
 * so it can only name a secret and never reaches into another setting
 * by accident.
 *
 * A tenant's destination is its federation's record with the tenant's
 * slug added: tiles go under `{slug}/` in the tiles bucket, page text
 * under `{slug}/ocr/`, image ids under `{image_base_url}/{slug}`,
 * canonical manifests under `{slug}/` in the manifest bucket, and
 * manifest ids under `{manifest_base_url}/{slug}`. The runner composes
 * every key and id from these values, so it needs nothing about tenants.
 *
 * The federation's review-tiles bucket (`pipeline_review_tiles_bucket`)
 * is optional and is not part of that check: a destination without it
 * is complete, `reviewTilesBucket` is null, and the tenant's volumes
 * skip the review run. Review tiles go under `{slug}/` in it. Fisqua's
 * key on it, which can list, read and share (issue download
 * authorisations), is held in `{prefix}_REVIEW_SHARE_KEY_ID` and
 * `{prefix}_REVIEW_SHARE_SECRET_KEY` (`reviewShareSecretNames`).
 *
 * `missingDestinationParts(federation, env)` lists what is missing: a
 * tenant without a federation as `federation`, each unset column by its
 * column name, a prefix of the wrong form as `storage_secret_prefix`,
 * and each missing secret as `secret:` and its suffix. It never lists a
 * value. `isTenantDestinationComplete(db, tenant, env)` is true when
 * that list is empty for the tenant's federation; the operator page uses
 * it to refuse the pipeline switch. `resolveTenantDestination(db,
 * tenant, env)` reads the tenant's federation and returns the tenant's
 * destination with its keys, or throws `TenantDestinationError`
 * (`tenant_destination_unset`) carrying the list; dispatch, publishing
 * and promotion call it and turn the error into their own refusal.
 * `destinationFor(tenant, federation, env)` does the same from rows
 * already read. Trailing slashes are removed from the two public
 * addresses, since every caller adds its own.
 *
 * `tenants.federation_id` is declared NOT NULL in the schema but is a
 * nullable column in D1 (migration 0044); a tenant without one has no
 * storage.
 *
 * The Worker's `Env` declares its fixed settings and not the
 * federations' secrets, whose names are only known at run time;
 * `readSecret` reads one by name from any environment object, so no
 * caller needs an index signature on `Env`.
 *
 * `manifestHostOf(baseUrl)` gives the host name of a manifest address,
 * or null for one that is not an https URL. Fisqua fetches manifests
 * from the deployment's allowlist and from every federation's manifest
 * host; `tenantManifestHosts(db)` reads those hosts from every
 * federation row. The read is across federations on purpose: a manifest
 * address is public, and a volume may be added from another tenant's
 * published manifest as it can from the deployment's list.
 *
 * `s3Region(endpoint)` gives the SigV4 region for a storage endpoint:
 * the region in a B2 S3 host (`s3.{region}.backblazeb2.com`), and
 * `auto` for an R2 S3 host (`*.r2.cloudflarestorage.com`). Any other
 * host is refused, so a key is never signed for a place this module
 * does not recognise.
 *
 * @version v0.8.0
 */

import { eq, isNotNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { federations } from "../../db/schema";

export type FederationDestinationColumns = Pick<
  typeof federations.$inferSelect,
  | "id"
  | "pipelineDeliveryEndpoint"
  | "pipelineTilesBucket"
  | "pipelineMastersBucket"
  | "pipelineImageBaseUrl"
  | "manifestEndpoint"
  | "manifestBucket"
  | "manifestBaseUrl"
  | "storageSecretPrefix"
  | "pipelineReviewTilesBucket"
>;

/** What the destination needs of the tenant. */
export interface TenantStorageRef {
  id: string;
  slug: string;
  federationId: string | null;
}

/** The destination columns, by property and by column name. */
export const DESTINATION_COLUMNS = [
  ["pipelineDeliveryEndpoint", "pipeline_delivery_endpoint"],
  ["pipelineTilesBucket", "pipeline_tiles_bucket"],
  ["pipelineMastersBucket", "pipeline_masters_bucket"],
  ["pipelineImageBaseUrl", "pipeline_image_base_url"],
  ["manifestEndpoint", "manifest_endpoint"],
  ["manifestBucket", "manifest_bucket"],
  ["manifestBaseUrl", "manifest_base_url"],
  ["storageSecretPrefix", "storage_secret_prefix"],
] as const satisfies ReadonlyArray<readonly [keyof FederationDestinationColumns, string]>;

export const DESTINATION_SECRET_SUFFIXES = [
  "DELIVERY_READ_KEY_ID",
  "DELIVERY_READ_SECRET_KEY",
  "MANIFEST_WRITE_KEY_ID",
  "MANIFEST_WRITE_SECRET_KEY",
] as const;

export type DestinationSecretSuffix = (typeof DESTINATION_SECRET_SUFFIXES)[number];

export const SECRET_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;

export interface S3Key {
  keyId: string;
  secretKey: string;
}

export interface TenantDestination {
  tenantId: string;
  federationId: string;
  deliveryEndpoint: string;
  tilesBucket: string;
  /** `{slug}/`: where the tenant's tile roots sit in the tiles bucket. */
  tilesPrefix: string;
  /** `{slug}/ocr/`: where the tenant's page text sits in the tiles bucket. */
  ocrPrefix: string;
  /** `{federation image address}/{slug}`: the base of the tenant's image ids. */
  imageBaseUrl: string;
  manifestEndpoint: string;
  manifestBucket: string;
  /** `{slug}/`: where the tenant's canonical manifests sit in the manifest bucket. */
  manifestKeyPrefix: string;
  /** The federation's manifest address, the manifest bucket's root. */
  federationManifestBaseUrl: string;
  /** `{federation manifest address}/{slug}`: the base of the tenant's manifest ids. */
  manifestBaseUrl: string;
  secretPrefix: string;
  /** Reads page text from the tiles bucket. */
  deliveryRead: S3Key;
  /** Writes canonical manifests to the manifest bucket. */
  manifestWrite: S3Key;
  /** The federation's private review-tiles bucket, or null when it has none. */
  reviewTilesBucket: string | null;
}

export class TenantDestinationError extends Error {
  readonly code = "tenant_destination_unset" as const;
  readonly missing: string[];
  constructor(missing: string[]) {
    super("The tenant's storage destination is not set up");
    this.name = "TenantDestinationError";
    this.missing = missing;
  }
}

/** The four secret names for a prefix. */
export function destinationSecretNames(prefix: string): Record<DestinationSecretSuffix, string> {
  return Object.fromEntries(
    DESTINATION_SECRET_SUFFIXES.map((suffix) => [suffix, `${prefix}_${suffix}`]),
  ) as Record<DestinationSecretSuffix, string>;
}

/** The two secret names of Fisqua's key on the review-tiles bucket. */
export function reviewShareSecretNames(prefix: string): { keyId: string; secretKey: string } {
  return { keyId: `${prefix}_REVIEW_SHARE_KEY_ID`, secretKey: `${prefix}_REVIEW_SHARE_SECRET_KEY` };
}

/** A string setting by name, or undefined when it is unset or blank. */
export function readSecret(env: object, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function set(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function missingDestinationParts(
  federation: FederationDestinationColumns | null,
  env: object,
): string[] {
  if (federation === null) return ["federation"];
  const missing: string[] = [];
  for (const [property, column] of DESTINATION_COLUMNS) {
    if (!set(federation[property])) missing.push(column);
  }
  const prefix = federation.storageSecretPrefix;
  if (set(prefix) && !SECRET_PREFIX_PATTERN.test(prefix)) missing.push("storage_secret_prefix");
  if (set(prefix) && SECRET_PREFIX_PATTERN.test(prefix)) {
    const names = destinationSecretNames(prefix);
    for (const suffix of DESTINATION_SECRET_SUFFIXES) {
      if (readSecret(env, names[suffix]) === undefined) missing.push(`secret:${suffix}`);
    }
  } else {
    for (const suffix of DESTINATION_SECRET_SUFFIXES) missing.push(`secret:${suffix}`);
  }
  return missing;
}

/** The tenant's federation row, or null when the tenant has none. */
export async function readTenantFederation(
  db: DrizzleD1Database<any>,
  tenant: Pick<TenantStorageRef, "federationId">,
): Promise<FederationDestinationColumns | null> {
  if (!set(tenant.federationId)) return null;
  const row = await db
    .select({
      id: federations.id,
      pipelineDeliveryEndpoint: federations.pipelineDeliveryEndpoint,
      pipelineTilesBucket: federations.pipelineTilesBucket,
      pipelineMastersBucket: federations.pipelineMastersBucket,
      pipelineImageBaseUrl: federations.pipelineImageBaseUrl,
      manifestEndpoint: federations.manifestEndpoint,
      manifestBucket: federations.manifestBucket,
      manifestBaseUrl: federations.manifestBaseUrl,
      storageSecretPrefix: federations.storageSecretPrefix,
      pipelineReviewTilesBucket: federations.pipelineReviewTilesBucket,
    })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  return row ?? null;
}

export async function isTenantDestinationComplete(
  db: DrizzleD1Database<any>,
  tenant: Pick<TenantStorageRef, "federationId">,
  env: object,
): Promise<boolean> {
  return missingDestinationParts(await readTenantFederation(db, tenant), env).length === 0;
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The tenant's destination from its federation's row, or `TenantDestinationError`. */
export function destinationFor(
  tenant: Pick<TenantStorageRef, "id" | "slug">,
  federation: FederationDestinationColumns | null,
  env: object,
): TenantDestination {
  const missing = missingDestinationParts(federation, env);
  if (missing.length > 0 || federation === null) throw new TenantDestinationError(missing);
  const prefix = federation.storageSecretPrefix as string;
  const names = destinationSecretNames(prefix);
  const secret = (suffix: DestinationSecretSuffix) => readSecret(env, names[suffix]) as string;
  const slug = tenant.slug;
  const federationManifestBaseUrl = trimSlashes(federation.manifestBaseUrl as string);
  return {
    tenantId: tenant.id,
    federationId: federation.id,
    deliveryEndpoint: federation.pipelineDeliveryEndpoint as string,
    tilesBucket: federation.pipelineTilesBucket as string,
    tilesPrefix: `${slug}/`,
    ocrPrefix: `${slug}/ocr/`,
    imageBaseUrl: `${trimSlashes(federation.pipelineImageBaseUrl as string)}/${slug}`,
    manifestEndpoint: federation.manifestEndpoint as string,
    manifestBucket: federation.manifestBucket as string,
    manifestKeyPrefix: `${slug}/`,
    federationManifestBaseUrl,
    manifestBaseUrl: `${federationManifestBaseUrl}/${slug}`,
    secretPrefix: prefix,
    deliveryRead: {
      keyId: secret("DELIVERY_READ_KEY_ID"),
      secretKey: secret("DELIVERY_READ_SECRET_KEY"),
    },
    manifestWrite: {
      keyId: secret("MANIFEST_WRITE_KEY_ID"),
      secretKey: secret("MANIFEST_WRITE_SECRET_KEY"),
    },
    reviewTilesBucket: set(federation.pipelineReviewTilesBucket) ? federation.pipelineReviewTilesBucket : null,
  };
}

export async function resolveTenantDestination(
  db: DrizzleD1Database<any>,
  tenant: TenantStorageRef,
  env: object,
): Promise<TenantDestination> {
  return destinationFor(tenant, await readTenantFederation(db, tenant), env);
}

export function manifestHostOf(baseUrl: string | null | undefined): string | null {
  if (!set(baseUrl)) return null;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

export async function tenantManifestHosts(db: DrizzleD1Database<any>): Promise<string[]> {
  const rows = await db
    .select({ manifestBaseUrl: federations.manifestBaseUrl })
    .from(federations)
    .where(isNotNull(federations.manifestBaseUrl))
    .all();
  const hosts = rows.map((r) => manifestHostOf(r.manifestBaseUrl)).filter((h): h is string => h !== null);
  return [...new Set(hosts)];
}

export class StorageEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageEndpointError";
  }
}

export function s3Region(endpoint: string): string {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new StorageEndpointError(`The storage endpoint is not a URL: ${endpoint}`);
  }
  const b2 = host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);
  if (b2) return b2[1];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.r2\.cloudflarestorage\.com$/.test(host)) return "auto";
  throw new StorageEndpointError(`No signing region is known for the storage host ${host}`);
}

// @version v0.8.0
