/**
 * Tests — canonical manifest store and locator
 *
 * This suite pins the store the publish action writes canonical
 * manifests through, against the `MANIFESTS_BUCKET` binding of the test
 * pool, and the locator that turns a canonical manifest URL into an
 * object key.
 *
 * The store's put is conditional on what was read: on absence when the
 * key was empty, on the etag when it held an object. A condition that
 * fails returns `null` and leaves the object as it was. `get` returns
 * the object's raw bytes, checked with bytes that would not survive a
 * UTF-8 decode and re-encode. The default locator refuses every URL,
 * because the canonical URL's host and path are not settled; the prefix
 * locator maps a URL under its base to the promotion key form and
 * refuses anything else.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  r2CanonicalManifestStore,
  defaultCanonicalManifestLocator,
  prefixLocator,
  CanonicalLocatorError,
} from "../../app/lib/pipeline/canonical.server";

const KEY = "iiif/co-canonical-test/manifest.json";
const enc = (s: string) => new TextEncoder().encode(s);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function stored(key: string): Promise<Uint8Array | null> {
  const obj = await env.MANIFESTS_BUCKET.get(key);
  return obj === null ? null : new Uint8Array(await obj.arrayBuffer());
}

describe("canonical manifest store", () => {
  const store = r2CanonicalManifestStore(env.MANIFESTS_BUCKET);

  beforeEach(async () => {
    await env.MANIFESTS_BUCKET.delete(KEY);
  });

  it("writes on absence once, and refuses a second write on absence", async () => {
    const one = enc('{"n":1}');
    const sha = await sha256Hex(one);
    const put = await store.put(KEY, one, sha, { absent: true });
    expect(put).not.toBeNull();
    const head = await store.head(KEY);
    expect(head).toEqual({ etag: put!.etag, sha256: sha });
    const obj = await env.MANIFESTS_BUCKET.head(KEY);
    expect(obj!.httpMetadata?.contentType).toBe("application/ld+json");

    const two = enc('{"n":2}');
    expect(await store.put(KEY, two, await sha256Hex(two), { absent: true })).toBeNull();
    expect(await stored(KEY)).toEqual(one);
  });

  it("writes over the etag it was given, and refuses a stale etag", async () => {
    const one = enc("one");
    const first = await store.put(KEY, one, await sha256Hex(one), { absent: true });
    const two = enc("two");
    const second = await store.put(KEY, two, await sha256Hex(two), { etag: first!.etag });
    expect(second).not.toBeNull();
    expect(await stored(KEY)).toEqual(two);

    const three = enc("three");
    expect(await store.put(KEY, three, await sha256Hex(three), { etag: first!.etag })).toBeNull();
    expect(await stored(KEY)).toEqual(two);
  });

  it("returns null for an absent key, and the raw bytes of a present one", async () => {
    expect(await store.head(KEY)).toBeNull();
    expect(await store.get(KEY)).toBeNull();
    // A byte-order mark followed by a byte that is not valid UTF-8.
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x7b, 0x7d]);
    await env.MANIFESTS_BUCKET.put(KEY, raw);
    const got = await store.get(KEY);
    expect(got!.bytes).toEqual(raw);
    expect(got!.etag).toBe((await env.MANIFESTS_BUCKET.head(KEY))!.etag);
    expect(await store.head(KEY)).toEqual({ etag: got!.etag, sha256: null });
  });
});

describe("canonical manifest locator", () => {
  it("refuses every URL by default, and maps only promotion keys under a prefix", () => {
    let caught: unknown;
    try {
      defaultCanonicalManifestLocator("https://manifests.zasqua.org/iiif/co-x-001/manifest.json", "co-x-001");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CanonicalLocatorError);
    expect((caught as CanonicalLocatorError).code).toBe("manifest_inputs_unavailable");

    const locate = prefixLocator("https://manifests.test.example");
    expect(locate("https://manifests.test.example/iiif/co-x-001/manifest.json", "co-x-001")).toBe(
      "iiif/co-x-001/manifest.json",
    );
    for (const [url, ref] of [
      ["https://other.test.example/iiif/co-x-001/manifest.json", "co-x-001"],
      ["https://manifests.test.example/iiif/co-x-002/manifest.json", "co-x-001"],
      ["https://manifests.test.example/iiif/../co-x-001/manifest.json", "co-x-001"],
      ["https://manifests.test.example/iiif%2Fco-x-001/manifest.json", "co-x-001"],
      ["https://manifests.test.example/iiif/co-x-001/manifest.json?v=2", "co-x-001"],
    ]) {
      expect(() => locate(url, ref)).toThrow(CanonicalLocatorError);
    }
  });
});
