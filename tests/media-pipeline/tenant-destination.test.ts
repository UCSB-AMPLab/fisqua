/**
 * Tests — a tenant's storage destination
 *
 * This suite pins where a tenant's pipeline output goes and how Fisqua
 * reaches it:
 *
 *   - the resolver returns the tenant's destination from its
 *     federation's record: the federation's buckets and endpoints, the
 *     tenant's slug as the tiles and manifest key prefix and under
 *     `ocr/` as the OCR prefix, the federation's two public addresses
 *     with trailing slashes taken off and the slug added, and the
 *     federation's four keys, read by name from the secret prefix; it
 *     lists every unset column, a prefix of the wrong form and every
 *     missing secret, never a value, lists `federation` for a tenant
 *     without one, and refuses with `tenant_destination_unset`; two
 *     tenants of one federation get the same buckets and keys under
 *     their own prefixes; the federation's review-tiles bucket is
 *     optional, given as null when unset and as its name when set, and
 *     Fisqua's key on it is named from the prefix;
 *   - the S3 canonical store keeps the conditions publishing relies on:
 *     a put on absence writes once and is refused the second time, a put
 *     on an etag writes only over that etag, `get` returns the bytes
 *     exactly as stored (a byte-order mark followed by `0xFF` included),
 *     `head` returns the etag and the SHA-256 from the object's
 *     metadata, a failure other than a failed condition throws, and a
 *     key that would sign another object is refused before any request;
 *   - promotion's writer puts a manifest with its content type, under
 *     the key prefix it is given, and throws on a refused write;
 *   - the publish locator accepts only the tenant's own key under its
 *     federation's manifest address;
 *   - the sweep's store lookup gives a tenant with a destination a store
 *     signed with its federation's manifest key on its federation's
 *     bucket, and null to a tenant without one;
 *   - the manifest host allowlist adds every federation's manifest host
 *     to the deployment's list, and two federations cannot name the same
 *     bucket, address or secret prefix;
 *   - a tenant's slug cannot change once it has a volume in any run,
 *     and can before; writing the same slug is not a change;
 *   - the signing region is the B2 region in a B2 host, `auto` for an
 *     R2 host, and refused for any other host.
 *
 * Every provider request goes through an injected fake; no test makes a
 * network call.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { fakeS3 } from "../helpers/fake-s3";
import {
  seedPipelineRun,
  seedTenantDestination,
  testSecrets,
  TEST_DESTINATION,
  TEST_MANIFEST_BUCKET,
} from "../helpers/media-pipeline";
import {
  destinationFor,
  missingDestinationParts,
  resolveTenantDestination,
  reviewShareSecretNames,
  s3Region,
  tenantManifestHosts,
  TenantDestinationError,
  type FederationDestinationColumns,
} from "../../app/lib/pipeline/tenant-destination.server";
import {
  CanonicalLocatorError,
  CanonicalStoreError,
  prefixLocator,
  s3CanonicalManifestStore,
  s3ManifestWriter,
} from "../../app/lib/pipeline/canonical.server";
import { canonicalStoreForTenant } from "../../app/lib/pipeline/publish.server";
import { getAllowedManifestHosts, validateManifestUrl } from "../../app/lib/iiif.server";

const SECRETS = testSecrets("TEST_TENANT");

const TENANT = { id: DEFAULT_TEST_TENANT_ID, slug: "neogranadina", federationId: DEFAULT_TEST_FEDERATION_ID };

function federation(over: Partial<FederationDestinationColumns> = {}): FederationDestinationColumns {
  return { id: DEFAULT_TEST_FEDERATION_ID, ...TEST_DESTINATION, ...over };
}

const EMPTY_FEDERATION: FederationDestinationColumns = {
  id: DEFAULT_TEST_FEDERATION_ID,
  pipelineDeliveryEndpoint: null,
  pipelineTilesBucket: null,
  pipelineMastersBucket: null,
  pipelineImageBaseUrl: null,
  manifestEndpoint: null,
  manifestBucket: null,
  manifestBaseUrl: null,
  storageSecretPrefix: null,
  pipelineReviewTilesBucket: null,
};

const TARGET = {
  endpoint: "https://test-account.r2.cloudflarestorage.com",
  bucket: TEST_MANIFEST_BUCKET,
  keyId: "manifest-key-id",
  secretKey: "manifest-secret",
};

describe("resolving a tenant's destination", () => {
  it("returns the federation's storage with the tenant's prefixes and the federation's keys", () => {
    const d = destinationFor(
      TENANT,
      federation({ pipelineImageBaseUrl: "https://iiif.example.test/", manifestBaseUrl: "https://manifests.example.test//" }),
      SECRETS,
    );
    expect(d).toEqual({
      tenantId: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      deliveryEndpoint: TEST_DESTINATION.pipelineDeliveryEndpoint,
      tilesBucket: TEST_DESTINATION.pipelineTilesBucket,
      tilesPrefix: "neogranadina/",
      ocrPrefix: "neogranadina/ocr/",
      imageBaseUrl: "https://iiif.example.test/neogranadina",
      manifestEndpoint: TEST_DESTINATION.manifestEndpoint,
      manifestBucket: TEST_DESTINATION.manifestBucket,
      manifestKeyPrefix: "neogranadina/",
      federationManifestBaseUrl: "https://manifests.example.test",
      manifestBaseUrl: "https://manifests.example.test/neogranadina",
      secretPrefix: "TEST_TENANT",
      deliveryRead: { keyId: SECRETS.TEST_TENANT_DELIVERY_READ_KEY_ID, secretKey: SECRETS.TEST_TENANT_DELIVERY_READ_SECRET_KEY },
      manifestWrite: { keyId: SECRETS.TEST_TENANT_MANIFEST_WRITE_KEY_ID, secretKey: SECRETS.TEST_TENANT_MANIFEST_WRITE_SECRET_KEY },
      reviewTilesBucket: null,
    });
  });

  it("is complete without a review-tiles bucket, and gives the bucket when the federation records one", () => {
    expect(missingDestinationParts(federation({ pipelineReviewTilesBucket: null }), SECRETS)).toEqual([]);
    expect(destinationFor(TENANT, federation({ pipelineReviewTilesBucket: "  " }), SECRETS).reviewTilesBucket).toBeNull();
    expect(destinationFor(TENANT, federation({ pipelineReviewTilesBucket: "test-review-tiles" }), SECRETS).reviewTilesBucket).toBe(
      "test-review-tiles",
    );
  });

  it("names Fisqua's review-tiles key secrets from the prefix", () => {
    expect(reviewShareSecretNames("FEDERATION_ACME")).toEqual({
      keyId: "FEDERATION_ACME_REVIEW_SHARE_KEY_ID",
      secretKey: "FEDERATION_ACME_REVIEW_SHARE_SECRET_KEY",
    });
  });

  it("gives two tenants of one federation the same buckets and keys under their own prefixes", () => {
    const a = destinationFor(TENANT, federation(), SECRETS);
    const b = destinationFor({ id: "t2", slug: "sbmal" }, federation(), SECRETS);
    expect(b.tilesBucket).toBe(a.tilesBucket);
    expect(b.manifestBucket).toBe(a.manifestBucket);
    expect(b.deliveryRead).toEqual(a.deliveryRead);
    expect([b.tilesPrefix, b.ocrPrefix, b.manifestKeyPrefix]).toEqual(["sbmal/", "sbmal/ocr/", "sbmal/"]);
    expect(b.imageBaseUrl).toBe(`${TEST_DESTINATION.pipelineImageBaseUrl}/sbmal`);
    expect(b.manifestBaseUrl).toBe(`${TEST_DESTINATION.manifestBaseUrl}/sbmal`);
  });

  it("lists every unset column and every missing secret, and no value", () => {
    expect(missingDestinationParts(EMPTY_FEDERATION, SECRETS)).toEqual([
      "pipeline_delivery_endpoint",
      "pipeline_tiles_bucket",
      "pipeline_masters_bucket",
      "pipeline_image_base_url",
      "manifest_endpoint",
      "manifest_bucket",
      "manifest_base_url",
      "storage_secret_prefix",
      "secret:DELIVERY_READ_KEY_ID",
      "secret:DELIVERY_READ_SECRET_KEY",
      "secret:MANIFEST_WRITE_KEY_ID",
      "secret:MANIFEST_WRITE_SECRET_KEY",
    ]);
    expect(
      missingDestinationParts(federation({ manifestBucket: "  " }), { ...SECRETS, TEST_TENANT_DELIVERY_READ_SECRET_KEY: "" }),
    ).toEqual(["manifest_bucket", "secret:DELIVERY_READ_SECRET_KEY"]);
  });

  it("lists the federation as missing for a tenant without one", () => {
    expect(missingDestinationParts(null, SECRETS)).toEqual(["federation"]);
  });

  it("refuses a prefix that is not upper-case letters, digits and underscores", () => {
    for (const prefix of ["test_tenant", "TEST-TENANT", "_TEST", "TEST_", "1TEST", "TEST TENANT"]) {
      expect(missingDestinationParts(federation({ storageSecretPrefix: prefix }), SECRETS), prefix).toContain(
        "storage_secret_prefix",
      );
    }
  });

  it("throws tenant_destination_unset with the list", () => {
    try {
      destinationFor(TENANT, federation(), {});
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(TenantDestinationError);
      expect((err as TenantDestinationError).code).toBe("tenant_destination_unset");
      expect((err as TenantDestinationError).missing).toHaveLength(4);
    }
  });
});

describe("the publish locator", () => {
  it("accepts only the tenant's key under the federation's manifest address", () => {
    const locate = prefixLocator("https://manifests.example.test", "neogranadina/");
    expect(locate("https://manifests.example.test/neogranadina/iiif/co-x-001/manifest.json", "co-x-001")).toBe(
      "neogranadina/iiif/co-x-001/manifest.json",
    );
    for (const url of [
      "https://manifests.example.test/iiif/co-x-001/manifest.json",
      "https://manifests.example.test/sbmal/iiif/co-x-001/manifest.json",
      "https://elsewhere.example.test/neogranadina/iiif/co-x-001/manifest.json",
    ]) {
      expect(() => locate(url, "co-x-001"), url).toThrow(CanonicalLocatorError);
    }
  });
});

describe("the S3 canonical store", () => {
  it("writes on absence once, then refuses, and head reads the etag and SHA-256", async () => {
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const store = s3CanonicalManifestStore(TARGET, s3.fetch);
    const key = "iiif/co-x-001/manifest.json";
    expect(await store.head(key)).toBeNull();
    const first = await store.put(key, new TextEncoder().encode("{}"), "a".repeat(64), { absent: true });
    expect(first).not.toBeNull();
    expect(await store.head(key)).toEqual({ etag: first!.etag, sha256: "a".repeat(64) });
    const second = await store.put(key, new TextEncoder().encode("{\"x\":1}"), "b".repeat(64), { absent: true });
    expect(second).toBeNull();
    expect(s3.text(TEST_MANIFEST_BUCKET, key)).toBe("{}");
    const put = s3.requests.find((r) => r.method === "PUT")!;
    expect(put.headers["content-type"]).toBe("application/ld+json");
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.keyId).toBe("manifest-key-id");
    expect(put.host).toBe("test-account.r2.cloudflarestorage.com");
  });

  it("writes over a matching etag only", async () => {
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const store = s3CanonicalManifestStore(TARGET, s3.fetch);
    const key = "iiif/co-x-002/manifest.json";
    const first = await store.put(key, new TextEncoder().encode("1"), "1".repeat(64), { absent: true });
    const second = await store.put(key, new TextEncoder().encode("2"), "2".repeat(64), { etag: first!.etag });
    expect(second).not.toBeNull();
    expect(await store.put(key, new TextEncoder().encode("3"), "3".repeat(64), { etag: first!.etag })).toBeNull();
    expect(s3.text(TEST_MANIFEST_BUCKET, key)).toBe("2");
  });

  it("returns the stored bytes unchanged", async () => {
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const store = s3CanonicalManifestStore(TARGET, s3.fetch);
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0x7b, 0x7d]);
    const written = await store.put("iiif/co-x-003/manifest.json", bytes, "c".repeat(64), { absent: true });
    const got = await store.get("iiif/co-x-003/manifest.json");
    expect(got?.etag).toBe(written!.etag);
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes));
    expect(await store.get("iiif/absent/manifest.json")).toBeNull();
  });

  it("throws on a failure that is not a failed condition", async () => {
    const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const store = s3CanonicalManifestStore(TARGET, failing);
    await expect(store.head("k")).rejects.toBeInstanceOf(CanonicalStoreError);
    await expect(store.get("k")).rejects.toBeInstanceOf(CanonicalStoreError);
    await expect(store.put("k", new Uint8Array(), "0".repeat(64), { absent: true })).rejects.toBeInstanceOf(
      CanonicalStoreError,
    );
    const denied = s3CanonicalManifestStore(TARGET, fakeS3([]).fetch);
    await expect(denied.put("k", new Uint8Array(), "0".repeat(64), { absent: true })).rejects.toBeInstanceOf(
      CanonicalStoreError,
    );
  });

  it("refuses a key that would sign another object, before any request", async () => {
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const store = s3CanonicalManifestStore(TARGET, s3.fetch);
    for (const key of ["iiif/a%2F/manifest.json", "iiif/../x", "iiif/a?b", "iiif/a#b", "iiif\\a"]) {
      await expect(store.head(key), key).rejects.toBeInstanceOf(CanonicalStoreError);
    }
    expect(s3.requests).toEqual([]);
  });
});

describe("promotion's manifest writer", () => {
  it("puts the manifest with its content type under its key prefix, and throws on a refused write", async () => {
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const writer = s3ManifestWriter(TARGET, s3.fetch);
    await writer.put("iiif/co-x-004/manifest.json", "{\"a\":1}", { httpMetadata: { contentType: "application/ld+json" } });
    expect(s3.text(TEST_MANIFEST_BUCKET, "iiif/co-x-004/manifest.json")).toBe("{\"a\":1}");
    expect(s3.objects.get(`${TEST_MANIFEST_BUCKET}/iiif/co-x-004/manifest.json`)?.contentType).toBe(
      "application/ld+json",
    );
    const prefixed = s3ManifestWriter(TARGET, s3.fetch, "sbmal/");
    await prefixed.put("iiif/co-x-004/manifest.json", "{}", { httpMetadata: { contentType: "application/ld+json" } });
    expect(s3.text(TEST_MANIFEST_BUCKET, "sbmal/iiif/co-x-004/manifest.json")).toBe("{}");
    const other = s3ManifestWriter({ ...TARGET, bucket: "not-there" }, s3.fetch);
    await expect(
      other.put("k", "{}", { httpMetadata: { contentType: "application/ld+json" } }),
    ).rejects.toBeInstanceOf(CanonicalStoreError);
  });
});

describe("the sweep's store lookup and the manifest hosts", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("gives a tenant its federation's store, and null to one without", async () => {
    await seedTenantDestination();
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const store = await canonicalStoreForTenant(env as any, DEFAULT_TEST_TENANT_ID, s3.fetch);
    expect(store).not.toBeNull();
    await store!.head("iiif/co-x-005/manifest.json");
    expect(s3.requests.map((r) => [r.bucket, r.keyId])).toEqual([
      [TEST_MANIFEST_BUCKET, "test_tenant-manifest-key-id"],
    ]);
    expect(await canonicalStoreForTenant(env as any, SECOND_TEST_TENANT_ID, s3.fetch)).toBeNull();
    expect(await canonicalStoreForTenant(env as any, "no-such-tenant", s3.fetch)).toBeNull();
  });

  it("resolves a tenant through its federation's row", async () => {
    await seedTenantDestination();
    const d = await resolveTenantDestination(drizzle(env.DB), TENANT, SECRETS);
    expect([d.federationId, d.tilesPrefix]).toEqual([DEFAULT_TEST_FEDERATION_ID, "neogranadina/"]);
    await expect(
      resolveTenantDestination(drizzle(env.DB), { ...TENANT, federationId: null }, SECRETS),
    ).rejects.toMatchObject({ code: "tenant_destination_unset", missing: ["federation"] });
  });

  it("reads the review-tiles bucket from the federation's row: null until it is recorded", async () => {
    await seedTenantDestination();
    const db = drizzle(env.DB);
    expect((await resolveTenantDestination(db, TENANT, SECRETS)).reviewTilesBucket).toBeNull();
    await seedTenantDestination(DEFAULT_TEST_TENANT_ID, { pipelineReviewTilesBucket: "test-review-tiles" });
    expect((await resolveTenantDestination(db, TENANT, SECRETS)).reviewTilesBucket).toBe("test-review-tiles");
  });

  it("adds every federation's manifest host to the deployment's list", async () => {
    await seedTenantDestination();
    await seedTenantDestination(SECOND_TEST_TENANT_ID, {
      pipelineTilesBucket: "second-iiif-tiles",
      pipelineMastersBucket: "second-masters",
      manifestBucket: "second-manifests",
      manifestBaseUrl: "https://manifests.second.example.test",
      storageSecretPrefix: "SECOND",
    });
    const hosts = await tenantManifestHosts(drizzle(env.DB));
    expect(hosts.sort()).toEqual(["manifests.second.example.test", "manifests.test.example"]);
    const deployment = { ALLOWED_MANIFEST_HOSTS: "manifests.zasqua.org" };
    expect(getAllowedManifestHosts(deployment, hosts)).toEqual([
      "manifests.zasqua.org",
      ...hosts,
    ]);
    expect(validateManifestUrl("https://manifests.second.example.test/iiif/x/manifest.json", deployment, hosts)).toEqual({
      valid: true,
    });
    expect(validateManifestUrl("https://manifests.zasqua.org/iiif/x/manifest.json", deployment, hosts).valid).toBe(true);
    expect(validateManifestUrl("https://elsewhere.example.test/iiif/x/manifest.json", deployment, hosts).error).toBe(
      "manifest_host",
    );
  });

  it("refuses two federations naming the same bucket or secret prefix", async () => {
    await seedTenantDestination();
    const other = {
      pipelineTilesBucket: "other-tiles",
      pipelineMastersBucket: "other-masters",
      manifestBucket: "other-manifests",
      manifestBaseUrl: "https://other.example.test",
      storageSecretPrefix: "SECOND",
    };
    for (const shared of [
      { manifestBucket: TEST_DESTINATION.manifestBucket },
      { storageSecretPrefix: TEST_DESTINATION.storageSecretPrefix },
      { pipelineMastersBucket: TEST_DESTINATION.pipelineMastersBucket },
    ]) {
      await expect(seedTenantDestination(SECOND_TEST_TENANT_ID, { ...other, ...shared })).rejects.toThrow(/UNIQUE/);
    }
    await seedTenantDestination(SECOND_TEST_TENANT_ID, other);
  });
});

describe("the slug freeze", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  const rename = (id: string, slug: string) =>
    env.DB.prepare("UPDATE tenants SET slug = ? WHERE id = ?").bind(slug, id).run();
  const slugOf = async (id: string) =>
    (await env.DB.prepare("SELECT slug FROM tenants WHERE id = ?").bind(id).first<{ slug: string }>())?.slug;

  it("refuses a new slug once the tenant has a volume in a run, whatever became of the run", async () => {
    await seedPipelineRun({ status: "error", tokenRevokedAt: Date.now() });
    await expect(rename(DEFAULT_TEST_TENANT_ID, "renamed")).rejects.toThrow(/tenant_slug_frozen/);
    expect(await slugOf(DEFAULT_TEST_TENANT_ID)).toBe("neogranadina");
    await rename(DEFAULT_TEST_TENANT_ID, "neogranadina");
    await env.DB.prepare("UPDATE tenants SET name = 'Renamed' WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
  });

  it("lets a tenant without pipeline output change its slug", async () => {
    await seedPipelineRun();
    await rename(SECOND_TEST_TENANT_ID, "second-renamed");
    expect(await slugOf(SECOND_TEST_TENANT_ID)).toBe("second-renamed");
  });
});

describe("signing regions", () => {
  it("reads the B2 region, gives R2 auto, and refuses any other host", () => {
    expect(s3Region("https://s3.us-west-004.backblazeb2.com")).toBe("us-west-004");
    expect(s3Region("https://0123abcd.r2.cloudflarestorage.com")).toBe("auto");
    expect(s3Region("https://0123abcd.eu.r2.cloudflarestorage.com")).toBe("auto");
    expect(() => s3Region("https://s3.amazonaws.com")).toThrow();
    expect(() => s3Region("not a url")).toThrow();
  });
});

// @version v0.8.0
