/**
 * Tests — media pipeline object stores
 *
 * This suite pins the two stores the media pipeline uses, which hold
 * separate credentials so no key Fisqua holds both writes and reads the
 * same place.
 *
 *   - The spec store writes a run's spec through the `SPEC_BUCKET`
 *     binding, never `BUCKET`, under a tenant-first key and returns the SHA-256 of the bytes written; it
 *     signs the runner's GET URL offline, path-style, with the R2 region
 *     `auto`, an expiry equal to the requested lifetime, and no secret in
 *     the URL; it refuses a lifetime over seven days and refuses to build
 *     without all four of its settings.
 *   - The object reader reads run artefacts and OCR text. With the B2
 *     backing it signs the working bucket with the working key and the
 *     tenant's tiles bucket, which it is given, with the tenant's read
 *     key, returns the body on 200 and null on 404, throws on other
 *     statuses and on a bucket it does not know (the tiles bucket too,
 *     when it was built without one), and refuses to build without its
 *     working-bucket settings. With the selector
 *     unset it reads the R2 binding and makes no network request, even
 *     when B2 credentials are present.
 *   - Neither store signs a key holding `%`, a backslash, `?`, `#` or a
 *     `..` segment: each is refused with `invalid_key` before signing,
 *     and the B2 reader makes no request for it.
 *
 * No test makes a network call: the B2 backing takes a stub fetch, and
 * signing needs none.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  pipelineKey,
  getPipelineSpecStore,
  publishRunSpec,
  getMediaObjectReader,
  PipelineStoreError,
  type PipelineStoreEnv,
} from "../../app/lib/pipeline/store.server";

const NOW = Date.UTC(2026, 10, 2, 14, 0, 0);

const SPEC_ENV = {
  PIPELINE_SPEC_S3_ENDPOINT: "https://test-account.r2.test.example",
  PIPELINE_SPEC_BUCKET: "fisqua-bucket",
  PIPELINE_SPEC_KEY_ID: "spec-key-id",
  PIPELINE_SPEC_SECRET_KEY: "spec-secret-key-value",
};

const READER_ENV = {
  PIPELINE_WORKING_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
  PIPELINE_WORKING_BUCKET: "test-working-bucket",
  PIPELINE_WORKING_READ_KEY_ID: "working-key-id",
  PIPELINE_WORKING_READ_SECRET_KEY: "working-secret",
};

const TILES = {
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  bucket: "tenant-iiif-tiles",
  keyId: "delivery-key-id",
  secretKey: "delivery-secret",
};

function makeEnv(extra: Partial<PipelineStoreEnv> = {}): PipelineStoreEnv {
  return { BUCKET: env.BUCKET, SPEC_BUCKET: env.SPEC_BUCKET, ...SPEC_ENV, ...READER_ENV, ...extra };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function stubFetch(responder: (req: Request) => Response) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    requests.push(req);
    return responder(req);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof PipelineStoreError) return err.code;
    throw err;
  }
  return undefined;
}

describe("pipeline keys", () => {
  it("puts the tenant first", () => {
    expect(pipelineKey.spec("t1", "r1")).toBe("t1/pipeline-runs/r1/spec.json");
    expect(pipelineKey.workingPrefix("t1", "r1")).toBe("t1/pipeline-runs/r1/");
  });
});

describe("spec store", () => {
  it("writes the spec through the spec binding and returns the SHA-256 of the bytes", async () => {
    const store = getPipelineSpecStore(makeEnv());
    const key = pipelineKey.spec("store-tenant", crypto.randomUUID());
    const json = JSON.stringify({ spec_version: 1, note: "café" });
    const { sha256 } = await store.putSpec(key, json);

    expect(await env.BUCKET.get(key)).toBeNull();
    const object = await env.SPEC_BUCKET.get(key);
    expect(object).not.toBeNull();
    expect(object!.httpMetadata?.contentType).toBe("application/json");
    const bytes = await object!.arrayBuffer();
    expect(new TextDecoder().decode(bytes)).toBe(json);
    expect(sha256).toBe(await sha256Hex(bytes));
  });

  it("signs a path-style GET with the computed lifetime and no secret", async () => {
    const store = getPipelineSpecStore(makeEnv());
    const key = "t1/pipeline-runs/r1/spec.json";
    const expiresAt = NOW + 3_600_500;
    const url = new URL(await store.presignGet(key, expiresAt, NOW));
    expect(url.origin).toBe(SPEC_ENV.PIPELINE_SPEC_S3_ENDPOINT);
    expect(url.pathname).toBe(`/fisqua-bucket/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3601");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("X-Amz-Credential")).toContain("spec-key-id/");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/");
    expect(url.toString()).not.toContain(SPEC_ENV.PIPELINE_SPEC_SECRET_KEY);
  });

  it("refuses a lifetime over seven days", async () => {
    const store = getPipelineSpecStore(makeEnv());
    expect(await code(store.presignGet("k", NOW + 604_801_000, NOW))).toBe("presign_too_long");
    expect(await code(store.presignGet("k", NOW + 604_800_000, NOW))).toBeUndefined();
  });

  it.each(Object.keys(SPEC_ENV))("refuses to build without %s", async (name) => {
    expect(await code(() => getPipelineSpecStore(makeEnv({ [name]: undefined })))).toBe(
      "config",
    );
  });

  it("publishes a run spec: key, URL and digest", async () => {
    const store = getPipelineSpecStore(makeEnv());
    const runId = crypto.randomUUID();
    const json = '{"spec_version":1}';
    const out = await publishRunSpec(store, "pub-tenant", runId, json, NOW + 60_000, NOW);
    expect(out.key).toBe(`pub-tenant/pipeline-runs/${runId}/spec.json`);
    expect(new URL(out.url).pathname).toBe(`/fisqua-bucket/${out.key}`);
    const object = await env.SPEC_BUCKET.get(out.key);
    expect(out.sha256).toBe(await sha256Hex(await object!.arrayBuffer()));
  });

  it("writes nothing when the URL lifetime is refused", async () => {
    const store = getPipelineSpecStore(makeEnv());
    const runId = crypto.randomUUID();
    expect(
      await code(publishRunSpec(store, "pub-tenant", runId, "{}", NOW + 700_000_000, NOW)),
    ).toBe("presign_too_long");
    expect(await env.SPEC_BUCKET.get(pipelineKey.spec("pub-tenant", runId))).toBeNull();
  });
});

describe("object reader, B2 backing", () => {
  const b2 = (extra: Partial<PipelineStoreEnv> = {}) =>
    makeEnv({ PIPELINE_READER_BACKEND: "b2", ...extra });

  it("returns the body on 200, null on 404, and throws on 500", async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/present.txt")) return new Response("página uno", { status: 200 });
      if (path.endsWith("/missing.txt")) return new Response("", { status: 404 });
      return new Response("boom", { status: 500 });
    });
    const reader = getMediaObjectReader(b2(), fetchImpl, TILES);
    expect(await reader.getText(TILES.bucket, "ocr/x/txt/present.txt")).toBe("página uno");
    expect(await reader.getText(TILES.bucket, "ocr/x/txt/missing.txt")).toBeNull();
    expect(await code(reader.getText(TILES.bucket, "ocr/x/txt/broken.txt"))).toBe(
      "read_failed",
    );
    expect(new URL(requests[0].url).pathname).toBe(`/${TILES.bucket}/ocr/x/txt/present.txt`);
  });

  it("throws read_failed when the request itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    const reader = getMediaObjectReader(b2(), fetchImpl, TILES);
    expect(await code(reader.getText("test-working-bucket", "k"))).toBe("read_failed");
  });

  it("refuses a bucket it was not configured with, before any request", async () => {
    const { fetchImpl, requests } = stubFetch(() => new Response("x"));
    const reader = getMediaObjectReader(b2(), fetchImpl, TILES);
    expect(await code(reader.getText("fisqua-bucket", "t1/pipeline-runs/r1/spec.json"))).toBe(
      "unknown_bucket",
    );
    expect(requests).toHaveLength(0);
  });

  it("knows only the working bucket when built without a tiles bucket", async () => {
    const { fetchImpl, requests } = stubFetch(() => new Response("x"));
    const reader = getMediaObjectReader(b2(), fetchImpl);
    expect(await code(reader.getText(TILES.bucket, "ocr/x/txt/p1.txt"))).toBe("unknown_bucket");
    expect(requests).toHaveLength(0);
    expect(await reader.getText("test-working-bucket", "k")).toBe("x");
  });

  it("refuses a tiles bucket that is the working bucket", async () => {
    expect(await code(() => getMediaObjectReader(b2(), fetch, { ...TILES, bucket: "test-working-bucket" }))).toBe(
      "config",
    );
  });

  it("signs each bucket with its own read key", async () => {
    const { fetchImpl, requests } = stubFetch(() => new Response("ok"));
    const reader = getMediaObjectReader(b2(), fetchImpl, TILES);
    await reader.getText("test-working-bucket", "t1/pipeline-runs/r1/volumes/pv_01/report.json");
    await reader.getText(TILES.bucket, "ocr/co-ahrb-aht-008/txt/p0001.txt");
    const working = requests[0].headers.get("authorization") ?? "";
    const tiles = requests[1].headers.get("authorization") ?? "";
    expect(working).toContain("Credential=working-key-id/");
    expect(working).toContain("/us-west-004/s3/");
    expect(tiles).toContain("Credential=delivery-key-id/");
    expect(new URL(requests[0].url).pathname).toBe(
      "/test-working-bucket/t1/pipeline-runs/r1/volumes/pv_01/report.json",
    );
  });

  it.each(Object.keys(READER_ENV))("refuses to build without %s", async (name) => {
    expect(await code(() => getMediaObjectReader(b2({ [name]: undefined })))).toBe("config");
  });
});

describe("object keys", () => {
  const BAD_KEYS = [
    "t1/pipeline-runs/r1/spec%2Ejson",
    "t1\\pipeline-runs\\r1\\spec.json",
    "t1/pipeline-runs/r1/spec.json?x-id=PutObject",
    "t1/pipeline-runs/r1/spec.json#frag",
    "t1/pipeline-runs/../r2/spec.json",
    "../other-bucket/spec.json",
    "t1/pipeline-runs/r1/..",
  ];

  it.each(BAD_KEYS)("refuses to presign %s", async (key) => {
    const store = getPipelineSpecStore(makeEnv());
    expect(await code(store.presignGet(key, NOW + 60_000, NOW))).toBe("invalid_key");
  });

  it.each(BAD_KEYS)("refuses to read %s from B2, before any request", async (key) => {
    const { fetchImpl, requests } = stubFetch(() => new Response("x"));
    const reader = getMediaObjectReader(
      makeEnv({ PIPELINE_READER_BACKEND: "b2" }),
      fetchImpl,
    );
    expect(await code(reader.getText("test-working-bucket", key))).toBe("invalid_key");
    expect(requests).toHaveLength(0);
  });

  it("accepts keys with dots that are not a parent segment", async () => {
    const store = getPipelineSpecStore(makeEnv());
    for (const key of ["t1/pipeline-runs/r1/spec.json", "t1/a..b/.hidden/x...y"]) {
      const url = new URL(await store.presignGet(key, NOW + 60_000, NOW));
      expect(url.pathname).toBe(`/fisqua-bucket/${key}`);
    }
  });
});

describe("object reader, R2 binding (selector unset)", () => {
  it("reads through the binding and makes no request, even with B2 credentials set", async () => {
    const { fetchImpl, requests } = stubFetch(() => new Response("from b2"));
    const reader = getMediaObjectReader(makeEnv(), fetchImpl, TILES);
    const key = `ocr/r2-test-${crypto.randomUUID()}/txt/p0001.txt`;
    await env.BUCKET.put(key, "texto de prueba");
    expect(await reader.getText(TILES.bucket, key)).toBe("texto de prueba");
    expect(await reader.getText("test-working-bucket", key)).toBe("texto de prueba");
    expect(await reader.getText(TILES.bucket, `${key}.absent`)).toBeNull();
    expect(await code(reader.getText("fisqua-bucket", key))).toBe("unknown_bucket");
    expect(requests).toHaveLength(0);
  });

  it("treats any value other than b2 as the binding", async () => {
    const { fetchImpl, requests } = stubFetch(() => new Response("from b2"));
    const reader = getMediaObjectReader(makeEnv({ PIPELINE_READER_BACKEND: "r2" }), fetchImpl, TILES);
    const key = `ocr/r2-explicit-${crypto.randomUUID()}.txt`;
    await env.BUCKET.put(key, "x");
    expect(await reader.getText(TILES.bucket, key)).toBe("x");
    expect(requests).toHaveLength(0);
  });
});

// @version v0.8.0
