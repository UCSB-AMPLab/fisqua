/**
 * Media Pipeline — Object Stores
 *
 * This module deals with the two object stores the media pipeline uses.
 * They hold separate credentials, so no key Fisqua holds can both write
 * and read the same place.
 *
 * The spec store is an R2 bucket of Fisqua's: `fisqua-bucket` in
 * production, a bucket of its own in staging. `putSpec` writes a run's
 * spec through the `SPEC_BUCKET` binding and returns the SHA-256 of the
 * bytes written, which the run row records. `presignGet` signs the
 * runner's GET URL for `PIPELINE_SPEC_BUCKET`, which names the bucket the
 * binding is bound to (wrangler.jsonc pairs them per environment),
 * offline with an R2 API key that can only read that bucket: a
 * path-style URL (`{endpoint}/{bucket}/{key}`) signed with `aws4fetch`
 * for the S3 service in R2's region, `auto`, with `X-Amz-Expires` set to
 * the requested lifetime. Signing makes no network request. A presigned
 * URL cannot live longer than seven days, so a longer lifetime is
 * refused (`presign_too_long`) rather than shortened. Keys are
 * tenant-first, `{tenantId}/pipeline-runs/{runId}/spec.json`, so
 * per-tenant scoping is part of the key and not a filter a bug could
 * drop. `publishRunSpec` signs first and writes second, so a refused
 * lifetime leaves nothing behind, and returns the URL, the key and the
 * digest. The working prefix in the B2 working bucket repeats the same
 * tenant-first form.
 *
 * The object reader reads what the runner leaves behind: run reports and
 * held manifests in the B2 working bucket, and OCR text in the tenant's
 * tiles bucket. It implements `MediaObjectReader`, the interface the OCR ingest
 * module declares and reads page text through. Fisqua only reads these, each bucket with its own read-only
 * key; the runner's write key is never held here. `getText(bucket, key)`
 * refuses a bucket that is neither the configured working bucket nor the
 * tiles bucket it was given (`unknown_bucket`), returns the UTF-8 body when
 * the object exists and `null` when it does not, and throws `read_failed`
 * for anything else.
 *
 * The working bucket and its read key are the deployment's settings. The
 * tiles bucket belongs to a federation: `getMediaObjectReader(env,
 * fetchImpl, tiles)` takes it, with its endpoint and the federation's
 * read key, from the tenant's storage destination, and a reader built
 * without one (the
 * scheduled sweep, which reads only reports) knows only the working
 * bucket.
 *
 * The reader's backing is chosen EXPLICITLY by `PIPELINE_READER_BACKEND`,
 * following the import staging store: `"b2"` signs requests to the
 * buckets and requires every working-bucket setting; anything else,
 * including unset, reads keys verbatim from the `BUCKET` binding, which
 * serves local development and the tests. Selection never keys off
 * whether credentials are present, because a developer's local settings
 * can hold real credentials that local work must not use. Deployed
 * environments set `"b2"`.
 *
 * Both the presigned URL and the B2 reader's requests put the key in the
 * URL path verbatim. A key holding `%`, a backslash, `?`, `#` or a `..`
 * segment would sign a different object from the one named, so it is
 * refused with `invalid_key` before anything is signed or sent.
 *
 * Settings missing for the store being built fail with `config`.
 *
 * @version v0.8.0
 */

import { AwsClient } from "aws4fetch";
import { resolveB2Region } from "../import/staging.server";
import { PRESIGN_MAX_SECONDS } from "./token.server";
import type { MediaObjectReader } from "../ocr/ingest.server";

// The reader interface belongs to the OCR ingest module, which reads
// page text through it; re-exported so the pipeline's importers keep
// naming it from here.
export type { MediaObjectReader };

/** The settings this module reads. Every member but the two bindings may be unset. */
export interface PipelineStoreEnv {
  BUCKET: R2Bucket;
  SPEC_BUCKET: R2Bucket;
  PIPELINE_SPEC_S3_ENDPOINT?: string;
  PIPELINE_SPEC_BUCKET?: string;
  PIPELINE_SPEC_KEY_ID?: string;
  PIPELINE_SPEC_SECRET_KEY?: string;
  PIPELINE_READER_BACKEND?: string;
  PIPELINE_WORKING_S3_ENDPOINT?: string;
  PIPELINE_WORKING_BUCKET?: string;
  PIPELINE_WORKING_READ_KEY_ID?: string;
  PIPELINE_WORKING_READ_SECRET_KEY?: string;
}

/** A tenant's tiles bucket and the key that reads it. */
export interface TilesReadTarget {
  endpoint: string;
  bucket: string;
  keyId: string;
  secretKey: string;
}

export type PipelineStoreErrorCode =
  | "config"
  | "presign_too_long"
  | "invalid_key"
  | "unknown_bucket"
  | "read_failed";

export class PipelineStoreError extends Error {
  readonly code: PipelineStoreErrorCode;
  constructor(code: PipelineStoreErrorCode, message: string) {
    super(message);
    this.name = "PipelineStoreError";
    this.code = code;
  }
}

export const pipelineKey = {
  spec: (tenantId: string, runId: string) => `${tenantId}/pipeline-runs/${runId}/spec.json`,
  workingPrefix: (tenantId: string, runId: string) => `${tenantId}/pipeline-runs/${runId}/`,
};

function required<K extends keyof PipelineStoreEnv>(
  env: PipelineStoreEnv,
  names: K[],
  what: string,
): Record<K, string> {
  const missing = names.filter((n) => {
    const v = env[n];
    return typeof v !== "string" || v.trim() === "";
  });
  if (missing.length > 0) {
    throw new PipelineStoreError("config", `${what} requires ${missing.join(", ")}`);
  }
  return Object.fromEntries(names.map((n) => [n, env[n] as string])) as Record<K, string>;
}

// A key is placed in the URL path as it is. `%` would be read as an
// escape, a backslash may be normalised to `/`, `?` and `#` would end the
// path, and a `..` segment would be resolved away by URL parsing, so the
// object signed would not be the object named. Such a key is refused
// before anything is signed.
function objectUrl(endpoint: string, bucket: string, key: string): string {
  if (/[%\\?#]/.test(key) || key.split("/").includes("..")) {
    throw new PipelineStoreError("invalid_key", `Object key ${JSON.stringify(key)} is not allowed`);
  }
  return `${endpoint.replace(/\/+$/, "")}/${bucket}/${key}`;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Spec store
// ---------------------------------------------------------------------------

export interface PipelineSpecStore {
  putSpec(key: string, json: string): Promise<{ sha256: string }>;
  presignGet(key: string, expiresAt: number, now: number): Promise<string>;
}

export function getPipelineSpecStore(env: PipelineStoreEnv): PipelineSpecStore {
  const cfg = required(
    env,
    [
      "PIPELINE_SPEC_S3_ENDPOINT",
      "PIPELINE_SPEC_BUCKET",
      "PIPELINE_SPEC_KEY_ID",
      "PIPELINE_SPEC_SECRET_KEY",
    ],
    "The pipeline spec store",
  );
  const client = new AwsClient({
    accessKeyId: cfg.PIPELINE_SPEC_KEY_ID,
    secretAccessKey: cfg.PIPELINE_SPEC_SECRET_KEY,
    service: "s3",
    region: "auto",
  });
  const bucket = env.SPEC_BUCKET;

  return {
    async putSpec(key, json) {
      const bytes = new TextEncoder().encode(json);
      await bucket.put(key, bytes, { httpMetadata: { contentType: "application/json" } });
      return { sha256: await sha256Hex(bytes) };
    },

    async presignGet(key, expiresAt, now) {
      const seconds = Math.ceil((expiresAt - now) / 1000);
      if (seconds > PRESIGN_MAX_SECONDS) {
        throw new PipelineStoreError(
          "presign_too_long",
          `A presigned URL lasts at most ${PRESIGN_MAX_SECONDS} seconds; ${seconds} were asked for`,
        );
      }
      if (seconds < 1) {
        throw new RangeError("A presigned URL must expire in the future");
      }
      const url = new URL(
        objectUrl(cfg.PIPELINE_SPEC_S3_ENDPOINT, cfg.PIPELINE_SPEC_BUCKET, key),
      );
      url.searchParams.set("X-Amz-Expires", String(seconds));
      const signed = await client.sign(url.toString(), {
        method: "GET",
        aws: { signQuery: true, datetime: isoDatetime(now) },
      });
      return signed.url;
    },
  };
}

// SigV4's `X-Amz-Date` form, from the caller's clock, so the signature's
// start time and its lifetime are computed from the same `now`.
function isoDatetime(now: number): string {
  return new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export async function publishRunSpec(
  store: PipelineSpecStore,
  tenantId: string,
  runId: string,
  specJson: string,
  urlExpiresAt: number,
  now: number,
): Promise<{ url: string; key: string; sha256: string }> {
  const key = pipelineKey.spec(tenantId, runId);
  const url = await store.presignGet(key, urlExpiresAt, now);
  const { sha256 } = await store.putSpec(key, specJson);
  return { url, key, sha256 };
}

// ---------------------------------------------------------------------------
// Object reader
// ---------------------------------------------------------------------------

function unknownBucket(bucket: string): PipelineStoreError {
  return new PipelineStoreError(
    "unknown_bucket",
    `The pipeline reader is not configured for bucket "${bucket}"`,
  );
}

class R2MediaObjectReader implements MediaObjectReader {
  constructor(
    private readonly binding: R2Bucket,
    private readonly buckets: Set<string>,
  ) {}

  async getText(bucket: string, key: string): Promise<string | null> {
    if (!this.buckets.has(bucket)) throw unknownBucket(bucket);
    let object: R2ObjectBody | null;
    try {
      object = await this.binding.get(key);
    } catch (err) {
      throw new PipelineStoreError("read_failed", `Reading ${key} failed: ${String(err)}`);
    }
    return object === null ? null : await object.text();
  }
}

interface B2Target {
  endpoint: string;
  client: AwsClient;
}

class B2MediaObjectReader implements MediaObjectReader {
  constructor(
    private readonly targets: Map<string, B2Target>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async getText(bucket: string, key: string): Promise<string | null> {
    const target = this.targets.get(bucket);
    if (!target) throw unknownBucket(bucket);
    const url = objectUrl(target.endpoint, bucket, key);
    let res: Response;
    try {
      const signed = await target.client.sign(url, { method: "GET" });
      res = await this.fetchImpl(signed);
    } catch (err) {
      throw new PipelineStoreError("read_failed", `Reading ${bucket}/${key} failed: ${String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new PipelineStoreError(
        "read_failed",
        `Reading ${bucket}/${key} failed with status ${res.status}`,
      );
    }
    return await res.text();
  }
}

function b2Client(endpoint: string, keyId: string, secretKey: string): AwsClient {
  let region: string;
  try {
    region = resolveB2Region({ endpoint });
  } catch (err) {
    throw new PipelineStoreError("config", (err as Error).message);
  }
  return new AwsClient({ accessKeyId: keyId, secretAccessKey: secretKey, service: "s3", region });
}

export function getMediaObjectReader(
  env: PipelineStoreEnv,
  fetchImpl: typeof fetch = fetch,
  tiles: TilesReadTarget | null = null,
): MediaObjectReader {
  if (env.PIPELINE_READER_BACKEND === "b2") {
    const cfg = required(
      env,
      [
        "PIPELINE_WORKING_S3_ENDPOINT",
        "PIPELINE_WORKING_BUCKET",
        "PIPELINE_WORKING_READ_KEY_ID",
        "PIPELINE_WORKING_READ_SECRET_KEY",
      ],
      "PIPELINE_READER_BACKEND=b2",
    );
    if (tiles !== null && cfg.PIPELINE_WORKING_BUCKET === tiles.bucket) {
      throw new PipelineStoreError(
        "config",
        "The working bucket and the tiles bucket must be different buckets",
      );
    }
    const targets = new Map<string, B2Target>([
      [
        cfg.PIPELINE_WORKING_BUCKET,
        {
          endpoint: cfg.PIPELINE_WORKING_S3_ENDPOINT,
          client: b2Client(
            cfg.PIPELINE_WORKING_S3_ENDPOINT,
            cfg.PIPELINE_WORKING_READ_KEY_ID,
            cfg.PIPELINE_WORKING_READ_SECRET_KEY,
          ),
        },
      ],
    ]);
    if (tiles !== null) {
      targets.set(tiles.bucket, {
        endpoint: tiles.endpoint,
        client: b2Client(tiles.endpoint, tiles.keyId, tiles.secretKey),
      });
    }
    return new B2MediaObjectReader(targets, fetchImpl);
  }

  const names = [env.PIPELINE_WORKING_BUCKET, tiles?.bucket].filter(
    (n): n is string => typeof n === "string" && n.trim() !== "",
  );
  return new R2MediaObjectReader(env.BUCKET, new Set(names));
}

// @version v0.8.0
