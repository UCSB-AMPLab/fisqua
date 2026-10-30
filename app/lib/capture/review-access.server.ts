/**
 * Capture QC — Download Authorisation for the Review Tiles
 *
 * This module deals with letting the capture QC viewer read a volume's
 * review tiles. The review run writes those tiles to the federation's
 * private review-tiles bucket on Backblaze B2, under
 * `{tenant slug}/{deliveryId}/`, and nothing in that bucket is public.
 * The viewer runs in the reviewer's browser, so Fisqua hands it
 * short-lived B2 download authorisation tokens, each limited to one
 * delivery's prefix, and the browser fetches the tiles from B2 directly.
 *
 * `reviewAccessLoader` is the body of the signed-in resource route
 * `GET /admin/capture/volumes/:volumeId/review-access`. Its checks, in
 * order: the tenant has the digitization capability (a bare 404
 * otherwise); the volume belongs to the tenant (404
 * `volume_not_found`); the caller is the volume's assigned reviewer or a
 * QC manager, an admin of the tenant or a steward of its federation, as
 * for recording decisions (a bare 403 otherwise); the federation has a
 * review-tiles bucket, a valid secret prefix and both secrets of
 * Fisqua's share key on it, named by `reviewShareSecretNames` (409
 * `no_review_bucket` otherwise); and the volume has at least one
 * delivery whose tiles can be read (404 `no_review_tiles`). The answer
 * is `{downloadUrl, bucket, expires, deliveries: [{deliveryId, prefix,
 * authorizationToken, current}]}`, with `Cache-Control: no-store`.
 *
 * Every prefix is `{tenant slug}/{deliveryId}/` built from D1 alone:
 * the tenant row and the volume's deliveries. Nothing in the request
 * names a prefix or a delivery. The share key covers the whole bucket,
 * which holds every tenant of the federation, so a prefix taken from the
 * client would let it read any of them. The trailing slash keeps one
 * delivery's prefix from matching another id that begins with it.
 *
 * `readableReviewDeliveries` chooses the deliveries: the volume's
 * current `registered` one and its earlier `superseded` ones, each only
 * while its tiles can be read: one of its review runs reported
 * `review_ready`, and no purge of its prefix has been recorded on any of
 * them (`purge_status` null). A purge that failed may still have
 * deleted some tiles, so it counts as one that finished.
 *
 * Two B2 calls do the work, over plain `fetch` (B2's native API, not
 * its S3 API, which the masters check signs with aws4fetch).
 * `b2AuthorizeShareKey` calls `b2_authorize_account` (API v4) with the
 * share key as HTTP Basic credentials and keeps the account token, the
 * API and download URLs and `allowed.buckets` from
 * `apiInfo.storageApi`
 * (https://www.backblaze.com/apidocs/b2-authorize-account). The
 * recorded bucket must be named in `allowed.buckets`, which also gives
 * its id; otherwise the answer is 503 `review_storage_unavailable`.
 * `b2DownloadAuthorization` then calls `b2_get_download_authorization`
 * once per prefix, with `bucketId`, `fileNamePrefix` and
 * `validDurationInSeconds` = `REVIEW_ACCESS_SECONDS`
 * (https://www.backblaze.com/apidocs/b2-get-download-authorization).
 * Any other B2 failure is also 503 `review_storage_unavailable`,
 * including a fetch that fails before B2 answers (a DNS, connection or
 * TLS failure), whose error is dropped unread. `expires` counts from the
 * moment before the first download authorisation was asked for, so it
 * never overstates the earliest token's lifetime.
 *
 * The viewer passes each token as the `?Authorization=` query parameter
 * on every tile request, never as a header. B2's CORS rules require
 * this: browsers strip the Authorization header from cross-origin
 * requests and their preflights, so a download from a private bucket
 * must carry a download authorisation token in the URL, spelled
 * `Authorization` with only the first letter capitalised
 * (https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules).
 *
 * The account token lives at most 24 hours on B2's side. It is cached
 * here in isolate memory only, per federation, for
 * `ACCOUNT_TOKEN_TTL_MS` (six hours), and never in KV or D1. A 401 from
 * B2 drops the cached token, and the request authorises again and
 * retries once. Download tokens are never cached: each request gets new
 * ones. `clearReviewAccountCache` empties the cache for tests.
 *
 * Logs carry only the federation id, the number of prefixes and B2's
 * status codes, with `transport` for a call that got no answer: never a
 * token, a key id, a response body or an error message.
 *
 * @version v0.8.0
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { captureDeliveries, pipelineVolumes } from "../../db/schema";
import type { Tenant, User } from "../../context";
import { requireCapability } from "../tenant";
import {
  readSecret,
  readTenantFederation,
  reviewShareSecretNames,
  SECRET_PREFIX_PATTERN,
} from "../pipeline/tenant-destination.server";
import { isQcManager, readReviewerId } from "./qc.server";

/** How long a download authorisation token lasts, in seconds. */
export const REVIEW_ACCESS_SECONDS = 3600;
/** How long an account token stays cached; B2 issues it for at most 24 hours. */
export const ACCOUNT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

const B2_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";

export interface ReviewAccessDeps {
  db: DrizzleD1Database<any>;
  /** The Worker's environment, where the share key's secrets are read by name. */
  env: object;
  fetch: typeof fetch;
  now: () => number;
}

export interface ReviewDelivery {
  deliveryId: string;
  prefix: string;
  authorizationToken: string;
  current: boolean;
}

export interface ReviewAccessAnswer {
  downloadUrl: string;
  bucket: string;
  expires: string;
  deliveries: ReviewDelivery[];
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const refusal = (status: number, error: string) => json(status, { error });

/** The status recorded for a B2 call whose fetch failed before any answer. */
const TRANSPORT = 0;

function log(federationId: string, prefixes: number, statuses: number[]): void {
  const shown = statuses.map((s) => (s === TRANSPORT ? "transport" : String(s))).join(" ") || "-";
  console.log(`capture review access: federation ${federationId}, ${prefixes} prefixes, B2 ${shown}`);
}

// ---------------------------------------------------------------------------
// B2
// ---------------------------------------------------------------------------

export interface B2Account {
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  buckets: Array<{ id: string; name: string | null }>;
}

type B2Result<T> = { ok: true; value: T; status: number } | { ok: false; status: number };

/**
 * One B2 call, with a fetch that rejects (DNS, connection, TLS) turned
 * into null. The rejection is dropped unread: its message may carry the
 * request's URL, and nothing of it is logged.
 */
async function b2Fetch(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetchFn(url, init);
  } catch {
    return null;
  }
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * `b2_authorize_account` (v4) with the share key. The response's
 * `apiInfo.storageApi` carries `apiUrl`, `downloadUrl` and
 * `allowed.buckets` (`[{id, name}]`); v4 dropped the top-level bucket
 * fields. https://www.backblaze.com/apidocs/b2-authorize-account
 */
export async function b2AuthorizeShareKey(
  fetchFn: typeof fetch,
  key: { keyId: string; secretKey: string },
): Promise<B2Result<B2Account>> {
  const res = await b2Fetch(fetchFn, B2_AUTHORIZE_URL, {
    method: "GET",
    headers: { Authorization: `Basic ${btoa(`${key.keyId}:${key.secretKey}`)}` },
  });
  if (res === null) return { ok: false, status: TRANSPORT };
  if (!res.ok) {
    await discard(res);
    return { ok: false, status: res.status };
  }
  const body = (await res.json().catch(() => null)) as any;
  const storage = body?.apiInfo?.storageApi;
  const buckets = storage?.allowed?.buckets;
  if (
    typeof body?.authorizationToken !== "string" ||
    typeof storage?.apiUrl !== "string" ||
    typeof storage?.downloadUrl !== "string" ||
    !Array.isArray(buckets)
  ) {
    return { ok: false, status: res.status };
  }
  return {
    ok: true,
    status: res.status,
    value: {
      authorizationToken: body.authorizationToken,
      apiUrl: storage.apiUrl,
      downloadUrl: storage.downloadUrl,
      buckets: buckets
        .filter((b: any) => typeof b?.id === "string")
        .map((b: any) => ({ id: b.id, name: typeof b.name === "string" ? b.name : null })),
    },
  };
}

/**
 * `b2_get_download_authorization` (v4): a token for the files under one
 * prefix of one bucket, sent with the account token in the
 * Authorization header. The response is `{bucketId, fileNamePrefix,
 * authorizationToken}`.
 * https://www.backblaze.com/apidocs/b2-get-download-authorization
 */
export async function b2DownloadAuthorization(
  fetchFn: typeof fetch,
  account: Pick<B2Account, "authorizationToken" | "apiUrl">,
  bucketId: string,
  fileNamePrefix: string,
  validDurationInSeconds: number,
): Promise<B2Result<string>> {
  const res = await b2Fetch(fetchFn, `${account.apiUrl.replace(/\/+$/, "")}/b2api/v4/b2_get_download_authorization`, {
    method: "POST",
    headers: { Authorization: account.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId, fileNamePrefix, validDurationInSeconds }),
  });
  if (res === null) return { ok: false, status: TRANSPORT };
  if (!res.ok) {
    await discard(res);
    return { ok: false, status: res.status };
  }
  const body = (await res.json().catch(() => null)) as any;
  if (typeof body?.authorizationToken !== "string") return { ok: false, status: res.status };
  return { ok: true, status: res.status, value: body.authorizationToken };
}

// ---------------------------------------------------------------------------
// The account token, cached in isolate memory per federation
// ---------------------------------------------------------------------------

interface CachedAccount {
  keyId: string;
  account: B2Account;
  obtainedAt: number;
}

const accounts = new Map<string, CachedAccount>();

export function clearReviewAccountCache(): void {
  accounts.clear();
}

/**
 * The federation's B2 account for its share key, from the isolate's
 * cache while the token is fresh and the key unchanged, otherwise from
 * `b2_authorize_account`, recording B2's status in `statuses`. The
 * review run reads its download address through this too, so one
 * isolate keeps one account token per federation.
 */
export async function accountFor(
  deps: Pick<ReviewAccessDeps, "fetch" | "now">,
  federationId: string,
  key: { keyId: string; secretKey: string },
  statuses: number[],
): Promise<B2Account | null> {
  const cached = accounts.get(federationId);
  if (cached && cached.keyId === key.keyId && deps.now() - cached.obtainedAt < ACCOUNT_TOKEN_TTL_MS) {
    return cached.account;
  }
  accounts.delete(federationId);
  const result = await b2AuthorizeShareKey(deps.fetch, key);
  statuses.push(result.status);
  if (!result.ok) return null;
  accounts.set(federationId, { keyId: key.keyId, account: result.value, obtainedAt: deps.now() });
  return result.value;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/**
 * The volume's deliveries whose review tiles can be read, oldest first:
 * the current `registered` one and the earlier `superseded` ones, each
 * with a review run that reported `review_ready` and no purge of its
 * prefix recorded.
 */
export async function readableReviewDeliveries(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeId: string,
): Promise<Array<{ id: string; current: boolean }>> {
  const rows = await db
    .select({ id: captureDeliveries.id, state: captureDeliveries.state })
    .from(captureDeliveries)
    .where(
      and(
        eq(captureDeliveries.tenantId, tenantId),
        eq(captureDeliveries.pipelineVolumeId, volumeId),
        sql`EXISTS (SELECT 1 FROM capture_review_runs rr WHERE rr.tenant_id = ${tenantId}
          AND rr.delivery_id = ${captureDeliveries.id} AND rr.status = 'review_ready')`,
        sql`NOT EXISTS (SELECT 1 FROM capture_review_runs pr WHERE pr.tenant_id = ${tenantId}
          AND pr.delivery_id = ${captureDeliveries.id} AND pr.purge_status IS NOT NULL)`,
      ),
    )
    .orderBy(asc(captureDeliveries.seq))
    .all();
  return rows
    .filter((r) => r.state === "registered" || r.state === "superseded")
    .map((r) => ({ id: r.id, current: r.state === "registered" }));
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

export async function reviewAccessLoader(
  deps: ReviewAccessDeps,
  volumeId: string,
  tenant: Tenant,
  user: User,
): Promise<Response> {
  requireCapability(tenant, "digitization");
  const { db } = deps;

  const volume = await db
    .select({ id: pipelineVolumes.id })
    .from(pipelineVolumes)
    .where(and(eq(pipelineVolumes.tenantId, tenant.id), eq(pipelineVolumes.id, volumeId)))
    .get();
  if (!volume) return refusal(404, "volume_not_found");

  const reviewerId = await readReviewerId(db, tenant.id, volumeId);
  if (reviewerId !== user.id && !(await isQcManager(db, tenant, user))) {
    throw new Response(null, { status: 403 });
  }

  const federation = await readTenantFederation(db, tenant);
  const bucket = federation?.pipelineReviewTilesBucket?.trim() || null;
  const secretPrefix = federation?.storageSecretPrefix ?? null;
  if (!federation || !bucket || !secretPrefix || !SECRET_PREFIX_PATTERN.test(secretPrefix)) {
    return refusal(409, "no_review_bucket");
  }
  const names = reviewShareSecretNames(secretPrefix);
  const keyId = readSecret(deps.env, names.keyId);
  const secretKey = readSecret(deps.env, names.secretKey);
  if (keyId === undefined || secretKey === undefined) return refusal(409, "no_review_bucket");

  const readable = await readableReviewDeliveries(db, tenant.id, volumeId);
  if (readable.length === 0) return refusal(404, "no_review_tiles");
  const prefixes = readable.map((d) => ({ ...d, prefix: `${tenant.slug}/${d.id}/` }));

  const statuses: number[] = [];
  const unavailable = () => {
    log(federation.id, prefixes.length, statuses);
    return refusal(503, "review_storage_unavailable");
  };

  // One pass over the prefixes with an account token; a 401 anywhere
  // drops the cached token, and the whole pass runs once more.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const account = await accountFor(deps, federation.id, { keyId, secretKey }, statuses);
    if (!account) return unavailable();
    const bucketId = account.buckets.find((b) => b.name === bucket)?.id;
    if (bucketId === undefined) return unavailable();

    // The tokens' lifetime counts from before the first is asked for,
    // so `expires` never outlasts the earliest of them.
    const issuedFrom = deps.now();
    const deliveries: ReviewDelivery[] = [];
    let unauthorized = false;
    for (const d of prefixes) {
      const result = await b2DownloadAuthorization(deps.fetch, account, bucketId, d.prefix, REVIEW_ACCESS_SECONDS);
      statuses.push(result.status);
      if (!result.ok) {
        if (result.status !== 401) return unavailable();
        unauthorized = true;
        break;
      }
      deliveries.push({ deliveryId: d.id, prefix: d.prefix, authorizationToken: result.value, current: d.current });
    }
    if (unauthorized) {
      accounts.delete(federation.id);
      continue;
    }

    log(federation.id, prefixes.length, statuses);
    const answer: ReviewAccessAnswer = {
      downloadUrl: account.downloadUrl,
      bucket,
      expires: new Date(issuedFrom + REVIEW_ACCESS_SECONDS * 1000).toISOString(),
      deliveries,
    };
    return json(200, answer);
  }
  return unavailable();
}

// @version v0.8.0
