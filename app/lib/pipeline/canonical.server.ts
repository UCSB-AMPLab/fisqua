/**
 * Media Pipeline — Canonical Manifest Store and Locator
 *
 * This module deals with the place a published volume's manifest lives:
 * its canonical URL, and the object behind that URL. Publishing copies
 * the manifest the runner held back to this place, and the copy is the
 * moment a volume becomes reachable, so the write here is the one
 * irreversible step of a publish.
 *
 * Each tenant writes its manifests to its federation's manifest bucket,
 * under its slug, named on the federation's storage destination, through
 * the S3 API with a key that can write only that bucket:
 * `s3CanonicalManifestStore(target, fetchImpl)`. A Worker's
 * R2 binding is fixed at deploy and reaches one account's buckets, so a
 * federation set up after a deploy could not be reached through one. The
 * requests are signed with `aws4fetch` (path-style,
 * `{endpoint}/{bucket}/{key}`, in the endpoint's region), and every one
 * goes through the injected `fetch`. `r2CanonicalManifestStore` wraps an
 * R2 binding with the same behaviour; the tests run publishing over it
 * against the local R2 of the test pool.
 *
 * Both stores answer the same way. `head` returns the object's etag and the SHA-256
 * recorded in its custom metadata (null when the object carries none,
 * as a manifest written before the pipeline does). `get` returns the
 * object's raw bytes as R2 holds them, never decoded and re-encoded, so
 * a digest or a preserved copy made from them matches what was stored.
 * `put` writes with the IIIF JSON-LD content type and the SHA-256 in
 * custom metadata, and only under a condition: on absence when the key
 * was empty when it was read, on the etag that was read otherwise. A
 * condition that fails returns `null` and writes nothing; any other
 * failure throws. Absence is expressed as an `If-None-Match: *`
 * condition, which the local R2 of the test pool honours; the same
 * check against a real bucket belongs before the first real publish.
 * Over S3 the conditions are the `If-None-Match: *` and `If-Match`
 * request headers; a 412 answer is a failed condition and returns
 * `null`, and any other answer that is not a success throws. The S3
 * store reads the SHA-256 from the `x-amz-meta-sha256` header, writes it
 * the same way, and gives etags without the quotes S3 puts around them,
 * as the binding does, so a condition recorded by one store is read the
 * same by the other.
 *
 * Promotion writes a manifest unconditionally, as it always has;
 * `s3ManifestWriter(target, fetchImpl, keyPrefix)` gives it the one
 * `put` it uses, in the shape of an R2 binding's, over the same signed
 * requests, with every key it is given put under `keyPrefix` (the
 * tenant's `{slug}/`).
 *
 * The locator maps a canonical URL to an object key. Publishing uses
 * `prefixLocator(base, keyPrefix)` with the federation's manifest address
 * (`manifest_base_url`, the bucket's root) and the tenant's `{slug}/`,
 * so it accepts exactly the ids dispatch builds under
 * `{base}/{slug}/`. It accepts a URL under `base`, refuses a key that
 * holds `%`, a backslash, `?`, `#` or a `..` segment (the same keys the
 * pipeline's object stores refuse), and refuses any key other than
 * `{keyPrefix}iiif/{referenceCode}/manifest.json`, the form promotion
 * writes. Two tenants of one federation therefore never share a key;
 * the publish action still refuses a key another tenant holds rather
 * than relying on the locator alone.
 * `defaultCanonicalManifestLocator` refuses every URL with
 * `CanonicalLocatorError` (`manifest_inputs_unavailable`), for a caller
 * that has no manifests host to name.
 *
 * @version v0.8.0
 */

import { AwsClient } from "aws4fetch";
import { manifestObjectPath } from "../promote/manifest-builder";
import { s3Region } from "./tenant-destination.server";

export type CanonicalExpect = { absent: true } | { etag: string };

export interface CanonicalManifestStore {
  head(key: string): Promise<{ etag: string; sha256: string | null } | null>;
  /** The object's raw bytes (`R2ObjectBody.arrayBuffer()`), never decoded and re-encoded. */
  get(key: string): Promise<{ etag: string; bytes: Uint8Array } | null>;
  /** null when the condition failed; throws on any other failure. */
  put(
    key: string,
    bytes: Uint8Array,
    sha256: string,
    expect: CanonicalExpect,
  ): Promise<{ etag: string } | null>;
}

export const MANIFEST_CONTENT_TYPE = "application/ld+json";

export function r2CanonicalManifestStore(bucket: R2Bucket): CanonicalManifestStore {
  return {
    async head(key) {
      const obj = await bucket.head(key);
      if (obj === null) return null;
      return { etag: obj.etag, sha256: obj.customMetadata?.sha256 ?? null };
    },

    async get(key) {
      const obj = await bucket.get(key);
      if (obj === null) return null;
      return { etag: obj.etag, bytes: new Uint8Array(await obj.arrayBuffer()) };
    },

    async put(key, bytes, sha256, expect) {
      const onlyIf: R2Conditional | Headers =
        "absent" in expect
          ? new Headers({ "If-None-Match": "*" })
          : { etagMatches: expect.etag };
      const written = await bucket.put(key, bytes, {
        onlyIf,
        httpMetadata: { contentType: MANIFEST_CONTENT_TYPE },
        customMetadata: { sha256 },
      });
      return written === null ? null : { etag: written.etag };
    },
  };
}

/** A bucket reached over the S3 API, with a key scoped to it. */
export interface S3BucketTarget {
  endpoint: string;
  bucket: string;
  keyId: string;
  secretKey: string;
}

export class CanonicalStoreError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CanonicalStoreError";
    this.status = status;
  }
}

// The key goes into the URL path as it is, so a key that would sign a
// different object from the one named is refused before anything is sent.
function s3ObjectUrl(target: S3BucketTarget, key: string): string {
  if (/[%\\?#]/.test(key) || key.split("/").includes("..")) {
    throw new CanonicalStoreError(`Object key ${JSON.stringify(key)} is not allowed`);
  }
  return `${target.endpoint.replace(/\/+$/, "")}/${target.bucket}/${key}`;
}

function unquote(etag: string | null): string | null {
  if (etag === null) return null;
  return etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

function s3Client(target: S3BucketTarget): AwsClient {
  return new AwsClient({
    accessKeyId: target.keyId,
    secretAccessKey: target.secretKey,
    service: "s3",
    region: s3Region(target.endpoint),
  });
}

async function s3Send(
  client: AwsClient,
  fetchImpl: typeof fetch,
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: BodyInit },
): Promise<Response> {
  const signed = await client.sign(url, init);
  return fetchImpl(signed);
}

export function s3CanonicalManifestStore(
  target: S3BucketTarget,
  fetchImpl: typeof fetch = fetch,
): CanonicalManifestStore {
  const client = s3Client(target);
  return {
    async head(key) {
      const res = await s3Send(client, fetchImpl, s3ObjectUrl(target, key), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new CanonicalStoreError(`HEAD ${key} answered ${res.status}`, res.status);
      const etag = unquote(res.headers.get("ETag"));
      if (etag === null) throw new CanonicalStoreError(`HEAD ${key} gave no etag`, res.status);
      return { etag, sha256: res.headers.get("x-amz-meta-sha256") };
    },

    async get(key) {
      const res = await s3Send(client, fetchImpl, s3ObjectUrl(target, key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new CanonicalStoreError(`GET ${key} answered ${res.status}`, res.status);
      const etag = unquote(res.headers.get("ETag"));
      if (etag === null) throw new CanonicalStoreError(`GET ${key} gave no etag`, res.status);
      return { etag, bytes: new Uint8Array(await res.arrayBuffer()) };
    },

    async put(key, bytes, sha256, expect) {
      const headers: Record<string, string> = {
        "Content-Type": MANIFEST_CONTENT_TYPE,
        "x-amz-meta-sha256": sha256,
      };
      if ("absent" in expect) headers["If-None-Match"] = "*";
      else headers["If-Match"] = `"${expect.etag}"`;
      const res = await s3Send(client, fetchImpl, s3ObjectUrl(target, key), {
        method: "PUT",
        headers,
        body: bytes as unknown as BodyInit,
      });
      if (res.status === 412) return null;
      if (!res.ok) throw new CanonicalStoreError(`PUT ${key} answered ${res.status}`, res.status);
      const etag = unquote(res.headers.get("ETag"));
      if (etag === null) throw new CanonicalStoreError(`PUT ${key} gave no etag`, res.status);
      return { etag };
    },
  };
}

/** The one call promotion makes on its manifest bucket. An R2 binding has this shape. */
export interface ManifestWriter {
  put(key: string, body: string, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
}

export function s3ManifestWriter(
  target: S3BucketTarget,
  fetchImpl: typeof fetch = fetch,
  keyPrefix = "",
): ManifestWriter {
  const client = s3Client(target);
  return {
    async put(relativeKey, body, options) {
      const key = `${keyPrefix}${relativeKey}`;
      const res = await s3Send(client, fetchImpl, s3ObjectUrl(target, key), {
        method: "PUT",
        headers: { "Content-Type": options.httpMetadata.contentType },
        body,
      });
      if (!res.ok) throw new CanonicalStoreError(`PUT ${key} answered ${res.status}`, res.status);
      return null;
    },
  };
}

export type CanonicalManifestLocator = (canonicalUrl: string, referenceCode: string) => string;

export class CanonicalLocatorError extends Error {
  readonly code = "manifest_inputs_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "CanonicalLocatorError";
  }
}

export const defaultCanonicalManifestLocator: CanonicalManifestLocator = () => {
  throw new CanonicalLocatorError("The canonical manifest location is not configured");
};

export function prefixLocator(baseUrl: string, keyPrefix = ""): CanonicalManifestLocator {
  const base = baseUrl.replace(/\/+$/, "");
  return (canonicalUrl, referenceCode) => {
    if (!canonicalUrl.startsWith(base + "/")) {
      throw new CanonicalLocatorError("The canonical URL is not under the configured base");
    }
    const key = canonicalUrl.slice(base.length + 1);
    if (/[%\\?#]/.test(key) || key.split("/").includes("..")) {
      throw new CanonicalLocatorError("The canonical URL names a key that is not allowed");
    }
    if (key !== `${keyPrefix}${manifestObjectPath(referenceCode)}`) {
      throw new CanonicalLocatorError("The canonical URL does not name the volume's manifest key");
    }
    return key;
  };
}
