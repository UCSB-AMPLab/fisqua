/**
 * Tests — an in-memory S3 server behind a fetch function
 *
 * This helper module deals with standing in for an S3 bucket service in
 * the tests, so the code that writes canonical manifests and promotion
 * manifests over S3 can be exercised without a network or an account.
 * `fakeS3()` returns a `fetch` to inject and the state behind it.
 *
 * It answers path-style requests (`{endpoint}/{bucket}/{key}`) for the
 * buckets it was told about: HEAD and GET return 404 for an absent key,
 * and otherwise the object's quoted etag, its content type and any
 * `x-amz-meta-*` headers it was written with; GET also returns the bytes
 * exactly as stored. PUT stores the body and its metadata under a fresh
 * etag, honouring `If-None-Match: *` (412 when the key exists) and
 * `If-Match` (412 when the etag differs or the key is absent). A request
 * for a bucket it does not hold answers 404 NoSuchBucket, and any
 * request without a SigV4 `Authorization` header answers 403, so a test
 * sees an unsigned request fail. A GET of the bucket itself with
 * `list-type=2` answers a ListObjectsV2 listing of the keys under
 * `prefix`, `listPageSize` keys a page (1000 unless given), with
 * `NextContinuationToken` while more remain. Every request is recorded with its
 * method, host, bucket, key, the access key id it was signed with, and
 * its headers.
 *
 * Every value here is a test value: no real endpoint, bucket or key.
 *
 * @version v0.8.0
 */

export interface FakeObject {
  bytes: Uint8Array;
  etag: string;
  contentType: string | null;
  meta: Record<string, string>;
}

export interface FakeS3Request {
  method: string;
  host: string;
  bucket: string;
  key: string;
  keyId: string | null;
  headers: Record<string, string>;
}

export interface FakeS3 {
  fetch: typeof fetch;
  /** Objects by `bucket/key`. */
  objects: Map<string, FakeObject>;
  requests: FakeS3Request[];
  /** Makes a bucket exist; buckets not added answer 404. */
  addBucket(bucket: string): void;
  text(bucket: string, key: string): string | null;
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function fakeS3(buckets: string[] = [], options: { listPageSize?: number } = {}): FakeS3 {
  const known = new Set(buckets);
  const objects = new Map<string, FakeObject>();
  const requests: FakeS3Request[] = [];
  let counter = 0;
  const pageSize = options.listPageSize ?? 1000;

  // ListObjectsV2: keys under the prefix in order, a page at a time; the
  // continuation token is the last key of the previous page.
  const listing = (bucket: string, prefix: string, after: string | null): Response => {
    const keys = [...objects.keys()]
      .filter((id) => id.startsWith(`${bucket}/`))
      .map((id) => id.slice(bucket.length + 1))
      .filter((k) => k.startsWith(prefix) && (after === null || k > after))
      .sort();
    const page = keys.slice(0, pageSize);
    const truncated = keys.length > page.length;
    const contents = page
      .map((k) => `<Contents><Key>${escapeXml(k)}</Key><Size>${objects.get(`${bucket}/${k}`)!.bytes.byteLength}</Size></Contents>`)
      .join("");
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
      `<KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${contents}` +
      (truncated ? `<NextContinuationToken>${escapeXml(page[page.length - 1])}</NextContinuationToken>` : "") +
      `</ListBucketResult>`;
    return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const [bucket, ...rest] = url.pathname.replace(/^\//, "").split("/");
    const key = decodeURIComponent(rest.join("/"));
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const auth = request.headers.get("authorization");
    const keyId = auth?.match(/Credential=([^/]+)\//)?.[1] ?? null;
    requests.push({ method: request.method, host: url.hostname, bucket, key, keyId, headers });

    if (!auth || !auth.startsWith("AWS4-HMAC-SHA256")) return new Response("AccessDenied", { status: 403 });
    if (!known.has(bucket)) return new Response("NoSuchBucket", { status: 404 });
    const id = `${bucket}/${key}`;
    const current = objects.get(id);

    if (request.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      return listing(bucket, url.searchParams.get("prefix") ?? "", url.searchParams.get("continuation-token"));
    }

    if (request.method === "HEAD" || request.method === "GET") {
      if (!current) return new Response(null, { status: 404 });
      const out = new Headers({ ETag: `"${current.etag}"` });
      if (current.contentType) out.set("Content-Type", current.contentType);
      for (const [k, v] of Object.entries(current.meta)) out.set(`x-amz-meta-${k}`, v);
      const body = request.method === "GET" ? (current.bytes as unknown as BodyInit) : null;
      return new Response(body, { status: 200, headers: out });
    }

    if (request.method === "PUT") {
      const ifNoneMatch = request.headers.get("if-none-match");
      const ifMatch = request.headers.get("if-match");
      if (ifNoneMatch === "*" && current) return new Response("PreconditionFailed", { status: 412 });
      if (ifMatch !== null && (!current || ifMatch.replace(/"/g, "") !== current.etag)) {
        return new Response("PreconditionFailed", { status: 412 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const meta: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        if (k.startsWith("x-amz-meta-")) meta[k.slice("x-amz-meta-".length)] = v;
      });
      const etag = `etag-${++counter}`;
      objects.set(id, { bytes, etag, contentType: request.headers.get("content-type"), meta });
      return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }

    return new Response("MethodNotAllowed", { status: 405 });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    objects,
    requests,
    addBucket: (b) => known.add(b),
    text: (b, k) => {
      const o = objects.get(`${b}/${k}`);
      return o ? new TextDecoder().decode(o.bytes) : null;
    },
  };
}

// @version v0.8.0
