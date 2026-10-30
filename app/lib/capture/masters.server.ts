/**
 * Capture Link — Listing the Masters Bucket
 *
 * This module deals with how the Worker sees which master objects are
 * in a federation's masters bucket when a capture manifest arrives
 * over the Captua link: every object the manifest names for
 * the pipeline must be there before its volume is registered. It lists
 * names and sizes and reads no content.
 *
 * The bucket is the federation's `pipeline_masters_bucket`, at the S3
 * endpoint its row records (`pipeline_delivery_endpoint`, the account's
 * S3 endpoint, as the registration command uses for the masters). The
 * key is one Fisqua holds for that bucket alone and that can list and
 * nothing else (`listBuckets`, `listFiles`). It is a pair of Worker
 * secrets named from the federation's `storage_secret_prefix`,
 * `{prefix}_MASTERS_LIST_KEY_ID` and `{prefix}_MASTERS_LIST_SECRET_KEY`
 * (`mastersListSecretNames`), which the operator's federation storage
 * command issues and sets. D1 never holds a key.
 *
 * `mastersListTarget(federation, env)` gives the endpoint, bucket and
 * key, or throws `MastersListError` (`config`) naming what is missing
 * (the federation, a column, the prefix's form, a secret by its suffix,
 * or an endpoint whose signing region is unknown), never a value.
 * `scanMasters(target, prefix, named, fetchImpl)` lists the prefix a page
 * at a time against the keys a manifest names, keeping the sizes of the
 * named objects and only the first `MAX_UNLISTED_NOTES` others (the rest
 * counted), so memory does not grow with what else the prefix holds. A request that fails, or an answer that
 * is not a listing, throws `MastersListError` (`list_failed`); the
 * delivery endpoint answers that with a 503, so the unit tries again.
 *
 * The listing is parsed from its XML with patterns rather than a DOM,
 * which the Workers runtime does not have: each `<Contents>` element's
 * `<Key>` and `<Size>`, with the five predefined XML entities and
 * numeric character references decoded in keys.
 *
 * @version v0.8.0
 */

import { AwsClient } from "aws4fetch";
import {
  readSecret,
  s3Region,
  SECRET_PREFIX_PATTERN,
  type FederationDestinationColumns,
} from "../pipeline/tenant-destination.server";

export const MASTERS_LIST_SECRET_SUFFIXES = ["MASTERS_LIST_KEY_ID", "MASTERS_LIST_SECRET_KEY"] as const;

/** The two secret names that hold a federation's masters list key. */
export function mastersListSecretNames(prefix: string): { keyId: string; secretKey: string } {
  return { keyId: `${prefix}_MASTERS_LIST_KEY_ID`, secretKey: `${prefix}_MASTERS_LIST_SECRET_KEY` };
}

export interface MastersListTarget {
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  secretKey: string;
}

export type MastersListErrorCode = "config" | "list_failed";

export class MastersListError extends Error {
  readonly code: MastersListErrorCode;
  readonly missing: string[];
  constructor(code: MastersListErrorCode, message: string, missing: string[] = []) {
    super(message);
    this.name = "MastersListError";
    this.code = code;
    this.missing = missing;
  }
}

function set(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function mastersListTarget(
  federation: Pick<
    FederationDestinationColumns,
    "pipelineDeliveryEndpoint" | "pipelineMastersBucket" | "storageSecretPrefix"
  > | null,
  env: object,
): MastersListTarget {
  if (federation === null) throw new MastersListError("config", "The tenant has no federation", ["federation"]);
  const missing: string[] = [];
  if (!set(federation.pipelineDeliveryEndpoint)) missing.push("pipeline_delivery_endpoint");
  if (!set(federation.pipelineMastersBucket)) missing.push("pipeline_masters_bucket");
  const prefix = federation.storageSecretPrefix;
  let keyId: string | undefined;
  let secretKey: string | undefined;
  if (!set(prefix) || !SECRET_PREFIX_PATTERN.test(prefix)) {
    missing.push("storage_secret_prefix");
  } else {
    const names = mastersListSecretNames(prefix);
    keyId = readSecret(env, names.keyId);
    secretKey = readSecret(env, names.secretKey);
    if (keyId === undefined) missing.push("secret:MASTERS_LIST_KEY_ID");
    if (secretKey === undefined) missing.push("secret:MASTERS_LIST_SECRET_KEY");
  }
  if (missing.length > 0) {
    throw new MastersListError("config", "The federation's masters bucket cannot be listed", missing);
  }
  const endpoint = (federation.pipelineDeliveryEndpoint as string).replace(/\/+$/, "");
  let region: string;
  try {
    region = s3Region(endpoint);
  } catch {
    throw new MastersListError("config", "The masters endpoint has no known signing region", [
      "pipeline_delivery_endpoint",
    ]);
  }
  return {
    endpoint,
    region,
    bucket: federation.pipelineMastersBucket as string,
    keyId: keyId as string,
    secretKey: secretKey as string,
  };
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] as string;
  });
}

function element(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? match[1] : null;
}

/** The objects of one ListObjectsV2 page, and the token of the next. */
export function parseListing(xml: string): { objects: Array<[string, number]>; next: string | null } {
  if (!/<ListBucketResult[\s>]/.test(xml)) {
    throw new MastersListError("list_failed", "The masters bucket did not answer with a listing");
  }
  const objects: Array<[string, number]> = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = element(match[1], "Key");
    const size = element(match[1], "Size");
    if (key === null || size === null || !/^\d+$/.test(size.trim())) {
      throw new MastersListError("list_failed", "The masters bucket's listing holds an entry without a key or size");
    }
    objects.push([decodeXml(key), Number(size.trim())]);
  }
  const truncated = element(xml, "IsTruncated")?.trim() === "true";
  const token = element(xml, "NextContinuationToken");
  if (truncated && token === null) {
    throw new MastersListError("list_failed", "The masters bucket's listing is truncated without a continuation token");
  }
  return { objects, next: truncated ? decodeXml(token as string) : null };
}

/** Unlisted objects a scan keeps by name; the rest are only counted. */
export const MAX_UNLISTED_NOTES = 1000;

export interface MastersScan {
  /** The size of every object of `named` the bucket holds. */
  present: Map<string, number>;
  /** The first objects under the prefix that `named` does not hold, at most `maxUnlisted`. */
  unlisted: Array<{ key: string; size: number }>;
  /** How many more unlisted objects there were. */
  unlistedOmitted: number;
  /** Listing pages read. */
  pages: number;
}

/**
 * Lists a prefix of the masters bucket against the keys a manifest
 * names, a page at a time: S3 ListObjectsV2 requests
 * (`GET {endpoint}/{bucket}?list-type=2&prefix=...`, path style), signed
 * with SigV4 for the endpoint's region by `aws4fetch`, following
 * `NextContinuationToken` until the listing ends. Only one page (at most
 * 1,000 keys) is held at a time: a named object's size is kept, the first
 * `maxUnlisted` objects the manifest does not name are kept, and the rest
 * are counted, so a prefix holding any number of stray objects costs the
 * same memory. A request that fails, or an answer that is not a listing,
 * throws `MastersListError` (`list_failed`).
 */
export async function scanMasters(
  target: MastersListTarget,
  prefix: string,
  named: ReadonlySet<string>,
  fetchImpl: typeof fetch,
  maxUnlisted: number = MAX_UNLISTED_NOTES,
): Promise<MastersScan> {
  const client = new AwsClient({
    accessKeyId: target.keyId,
    secretAccessKey: target.secretKey,
    service: "s3",
    region: target.region,
  });
  const scan: MastersScan = { present: new Map(), unlisted: [], unlistedOmitted: 0, pages: 0 };
  let continuation: string | null = null;
  // A page holds up to 1,000 keys; 10,000 pages is far past any volume.
  for (let page = 0; page < 10_000; page++) {
    const url = new URL(`${target.endpoint}/${target.bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuation !== null) url.searchParams.set("continuation-token", continuation);
    let res: Response;
    try {
      res = await fetchImpl(await client.sign(url.toString(), { method: "GET" }));
    } catch {
      throw new MastersListError("list_failed", "The masters bucket could not be reached");
    }
    if (!res.ok) {
      throw new MastersListError("list_failed", `Listing the masters bucket failed with status ${res.status}`);
    }
    const { objects, next } = parseListing(await res.text());
    scan.pages++;
    for (const [key, size] of objects) {
      if (named.has(key)) scan.present.set(key, size);
      else if (scan.unlisted.length < maxUnlisted) scan.unlisted.push({ key, size });
      else scan.unlistedOmitted++;
    }
    if (next === null) return scan;
    continuation = next;
  }
  throw new MastersListError("list_failed", "The masters bucket's listing did not end");
}

// @version v0.8.0
