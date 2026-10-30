/**
 * Tests — media pipeline publish route
 *
 * This suite drives the action-only route that publishes one ready
 * volume, `/admin/media/volumes/:volumeId/publish`, through its `action`
 * and `loader` with a router context built as the auth middleware
 * would, and drives `publishVolumeAction` directly where a test needs
 * the test locator. It pins:
 *
 *   - the gate: a bare 404 when the tenant's capability is off, a bare
 *     403 for the home admin of a member tenant; GET answers 405;
 *   - the request body: malformed JSON, a body without `run_id` and a
 *     body with any other key are answered 400 before anything is read;
 *   - the shipping configuration: with `PIPELINE_PUBLISH_ENABLED` unset
 *     the route refuses with `publish_disabled`, and with it set a
 *     tenant without a storage destination, or with one of its secrets
 *     missing, is refused with `tenant_destination_unset`; nothing is
 *     written and no canonical object appears;
 *   - deps built from an environment whose B2 reader settings are
 *     missing: building them does not throw, and the first read is
 *     answered `publish_unconfigured`, not a server error;
 *   - deps built from an environment read the spec and keep previous
 *     copies through the `SPEC_BUCKET` binding, not `BUCKET`;
 *   - deps built for a tenant publish into its federation's manifest
 *     bucket with the federation's manifest key, at the tenant's key
 *     under its slug, under the federation's manifest host, and read its
 *     page text from the federation's tiles bucket: tenants of two
 *     federations with different destinations each publish into their
 *     own federation's bucket, and neither touches the other's;
 *   - a spec that names a tiles bucket other than the federation's is
 *     refused with `spec_mismatch` before anything is written.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  seedReadyVolume,
  seedTenantDestination,
  snapshotPipelineTables,
  testSecrets,
  TEST_DESTINATION,
  TEST_MANIFEST_BUCKET,
  type ReadyVolume,
} from "../helpers/media-pipeline";
import { fakeS3 } from "../helpers/fake-s3";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import { AHR_TENANT_ID, NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import { publishVolumeAction, publishDepsFromEnv } from "../../app/lib/pipeline/publish.server";
import { action, loader } from "../../app/routes/_auth.admin.media.volumes.$volumeId.publish";

const E = env as any;

function buildContext(user: User, tenant: Tenant, envOver: Record<string, unknown> = {}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env: { ...E, ...envOver }, ctx: { waitUntil: () => {} } };
  return ctx;
}

function post(volumeId: string, body: string): Request {
  return new Request(`http://neogranadina.fisqua.test/admin/media/volumes/${volumeId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function settle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return (await fn()) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function leadAdmin(): Promise<User> {
  const user = await createTestUser({ isAdmin: true });
  return makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
}

function leadTenant(mediaPipelineEnabled: boolean): Tenant {
  return makeTenantContext({
    id: DEFAULT_TEST_TENANT_ID,
    federationId: NEOGRANADINA_FEDERATION_ID,
    mediaPipelineEnabled,
  });
}

const SECOND_DESTINATION = {
  pipelineDeliveryEndpoint: "https://s3.eu-central-003.backblazeb2.com",
  pipelineTilesBucket: "second-iiif-tiles",
  pipelineMastersBucket: "second-masters",
  pipelineImageBaseUrl: "https://iiif.second.example.test",
  manifestEndpoint: "https://second-account.r2.cloudflarestorage.com",
  manifestBucket: "second-manifests",
  manifestBaseUrl: "https://manifests.second.example.test",
  storageSecretPrefix: "SECOND",
};

function secondTenant(): Tenant {
  return makeTenantContext({
    id: SECOND_TEST_TENANT_ID,
    slug: "second-tenant",
    federationId: SECOND_TEST_FEDERATION_ID,
    mediaPipelineEnabled: true,
  });
}

async function snapshot(): Promise<unknown> {
  const out: Record<string, unknown> = { ...(await snapshotPipelineTables()) };
  for (const t of ["descriptions", "ocr_pages", "changelog", "pipeline_publications"]) {
    out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).results;
  }
  out.manifests = (await E.MANIFESTS_BUCKET.list()).objects.map((o: any) => o.key);
  return out;
}

function callAction(seed: ReadyVolume, user: User, tenant: Tenant, body: string, envOver = {}) {
  return settle(() =>
    action({
      request: post(seed.volumeId, body),
      context: buildContext(user, tenant, envOver),
      params: { volumeId: seed.volumeId },
    } as any),
  );
}

describe("publish route", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("gates, refuses GET, and refuses malformed bodies, writing nothing", async () => {
    const seed = await seedReadyVolume();
    const user = await leadAdmin();
    const before = await snapshot();
    const body = JSON.stringify({ run_id: seed.runId });

    const off = await callAction(seed, user, leadTenant(false), body);
    expect(off.status).toBe(404);
    expect(off.body).toBeNull();

    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
        "federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(AHR_TENANT_ID, "ahr", "Member", "tenant", "isadg", "active", NEOGRANADINA_FEDERATION_ID, now, now)
      .run();
    const memberAdmin = await createTestUser({ tenantId: AHR_TENANT_ID, isAdmin: true });
    const member = await callAction(
      seed,
      makeUserContext({ id: memberAdmin.id, tenantId: AHR_TENANT_ID, isAdmin: true }),
      makeTenantContext({ id: AHR_TENANT_ID, slug: "ahr", federationId: NEOGRANADINA_FEDERATION_ID, mediaPipelineEnabled: true }),
      body,
    );
    expect(member.status).toBe(403);
    expect(member.body).toBeNull();

    const get = await loader();
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");

    for (const bad of ["{not json", JSON.stringify({}), JSON.stringify({ run_id: seed.runId, extra: 1 }), JSON.stringify({ run_id: 5 })]) {
      const res = await callAction(seed, user, leadTenant(true), bad, { PIPELINE_PUBLISH_ENABLED: "true" });
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_request");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses as shipped: switched off, then a tenant without a destination", async () => {
    const seed = await seedReadyVolume();
    const user = await leadAdmin();
    const before = await snapshot();
    const body = JSON.stringify({ run_id: seed.runId });

    const unset = await callAction(seed, user, leadTenant(true), body);
    expect(unset.status).toBe(400);
    expect(await unset.json()).toEqual({ error: "publish_disabled" });

    const other = await callAction(seed, user, leadTenant(true), body, { PIPELINE_PUBLISH_ENABLED: "yes" });
    expect(await other.json()).toEqual({ error: "publish_disabled" });

    const enabled = await callAction(seed, user, leadTenant(true), body, { PIPELINE_PUBLISH_ENABLED: "true" });
    expect(enabled.status).toBe(400);
    expect(await enabled.json()).toEqual({ error: "tenant_destination_unset" });

    await seedTenantDestination();
    const beforeSecret = await snapshot();
    const noSecret = await callAction(seed, user, leadTenant(true), body, {
      PIPELINE_PUBLISH_ENABLED: "true",
      TEST_TENANT_DELIVERY_READ_KEY_ID: undefined,
    });
    expect(noSecret.status).toBe(400);
    expect(await noSecret.json()).toEqual({ error: "tenant_destination_unset" });

    expect(await snapshot()).toEqual(beforeSecret);
    expect((await E.MANIFESTS_BUCKET.list()).objects).toEqual([]);
  });

  it("builds its deps without reading settings, and answers a missing reader setting at the first read", async () => {
    const seed = await seedReadyVolume();
    const user = await leadAdmin();
    const b2Env = {
      ...E,
      PIPELINE_READER_BACKEND: "b2",
      PIPELINE_WORKING_READ_KEY_ID: undefined,
      PIPELINE_WORKING_READ_SECRET_KEY: undefined,
      PIPELINE_PUBLISH_ENABLED: "true",
    };
    await seedTenantDestination();
    const deps = await publishDepsFromEnv(b2Env, leadTenant(true), fakeS3().fetch);
    const before = await snapshot();
    const body = JSON.stringify({ run_id: seed.runId });

    const off = await settle(() =>
      publishVolumeAction(deps, post(seed.volumeId, body), seed.volumeId, leadTenant(false), user),
    );
    expect(off.status).toBe(404);
    expect(off.body).toBeNull();

    const res = await settle(() =>
      publishVolumeAction(deps, post(seed.volumeId, body), seed.volumeId, leadTenant(true), user),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "publish_unconfigured" });
    expect(await snapshot()).toEqual(before);
  });

  it("reads specs and keeps copies through the spec binding", async () => {
    await seedTenantDestination();
    const deps = await publishDepsFromEnv(E, leadTenant(true));
    expect(deps.specBucket).toBe(E.SPEC_BUCKET);
    expect(deps.specBucket).not.toBe(E.BUCKET);
  });

  it("publishes into the tenant's manifest bucket and answers with the publication", async () => {
    const seed = await seedReadyVolume();
    const user = await leadAdmin();
    await seedTenantDestination();
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const tenant = leadTenant(true);
    const deps = await publishDepsFromEnv({ ...E, PIPELINE_PUBLISH_ENABLED: "true" }, tenant, s3.fetch);
    const res = await publishVolumeAction(
      deps,
      post(seed.volumeId, JSON.stringify({ run_id: seed.runId })),
      seed.volumeId,
      tenant,
      user,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      publication_id: expect.any(String),
      canonical_url: seed.canonicalUrl,
      ocr_pages_written: 3,
      retirement_status: "none",
    });
    const pub = await env.DB.prepare("SELECT status, user_id FROM pipeline_publications WHERE id = ?")
      .bind(body.publication_id)
      .first();
    expect(pub).toEqual({ status: "published", user_id: user.id });
    expect(s3.text(TEST_MANIFEST_BUCKET, seed.canonicalKey)).not.toBeNull();
    const puts = s3.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => [r.host, r.bucket, r.key, r.keyId])).toEqual([
      ["test-account.r2.cloudflarestorage.com", TEST_MANIFEST_BUCKET, seed.canonicalKey, "test_tenant-manifest-key-id"],
    ]);
    expect(puts[0].headers["if-none-match"]).toBe("*");
    expect((await E.MANIFESTS_BUCKET.list()).objects).toEqual([]);
  });

  it("publishes two tenants' volumes into their own buckets, each under its own host and key", async () => {
    const user = await leadAdmin();
    const secondAdmin = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
    const secondUser = makeUserContext({ id: secondAdmin.id, tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
    const a = await seedReadyVolume();
    const b = await seedReadyVolume({
      tenantId: SECOND_TEST_TENANT_ID,
      codePrefix: "co-second",
      tilesBucket: SECOND_DESTINATION.pipelineTilesBucket,
      imageBase: SECOND_DESTINATION.pipelineImageBaseUrl,
      manifestBase: SECOND_DESTINATION.manifestBaseUrl,
    });
    await seedTenantDestination();
    await seedTenantDestination(SECOND_TEST_TENANT_ID, SECOND_DESTINATION);
    const s3 = fakeS3([TEST_MANIFEST_BUCKET, SECOND_DESTINATION.manifestBucket]);
    const envBoth = { ...E, ...testSecrets("SECOND"), PIPELINE_PUBLISH_ENABLED: "true" };
    const reads: string[] = [];
    const recording = (deps: Awaited<ReturnType<typeof publishDepsFromEnv>>) => ({
      ...deps,
      reader: {
        getText: (bucket: string, key: string) => {
          reads.push(bucket);
          return deps.reader.getText(bucket, key);
        },
      },
    });

    const resA = await publishVolumeAction(
      recording(await publishDepsFromEnv(envBoth, leadTenant(true), s3.fetch)),
      post(a.volumeId, JSON.stringify({ run_id: a.runId })),
      a.volumeId,
      leadTenant(true),
      user,
    );
    expect(resA.status).toBe(200);
    const readsA = reads.splice(0);
    const resB = await publishVolumeAction(
      recording(await publishDepsFromEnv(envBoth, secondTenant(), s3.fetch)),
      post(b.volumeId, JSON.stringify({ run_id: b.runId })),
      b.volumeId,
      secondTenant(),
      secondUser,
    );
    expect(resB.status).toBe(200);
    expect(((await resB.json()) as Record<string, unknown>).canonical_url).toBe(
      `${SECOND_DESTINATION.manifestBaseUrl}/${b.canonicalKey}`,
    );

    const puts = s3.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => [r.host, r.bucket, r.key, r.keyId])).toEqual([
      ["test-account.r2.cloudflarestorage.com", TEST_MANIFEST_BUCKET, a.canonicalKey, "test_tenant-manifest-key-id"],
      ["second-account.r2.cloudflarestorage.com", "second-manifests", b.canonicalKey, "second-manifest-key-id"],
    ]);
    expect(s3.text("second-manifests", a.canonicalKey)).toBeNull();
    expect(s3.text(TEST_MANIFEST_BUCKET, b.canonicalKey)).toBeNull();
    // Page text came from each tenant's own tiles bucket.
    expect(readsA).toContain(TEST_DESTINATION.pipelineTilesBucket);
    expect(readsA).not.toContain(SECOND_DESTINATION.pipelineTilesBucket);
    expect(reads).toContain(SECOND_DESTINATION.pipelineTilesBucket);
    expect(reads).not.toContain(TEST_DESTINATION.pipelineTilesBucket);
    const url = await env.DB.prepare("SELECT iiif_manifest_url FROM descriptions WHERE id = ?")
      .bind(b.descriptionId)
      .first<{ iiif_manifest_url: string }>();
    expect(url?.iiif_manifest_url).toBe(`${SECOND_DESTINATION.manifestBaseUrl}/${b.canonicalKey}`);
  });

  it("refuses a spec that names a tiles bucket other than the tenant's, writing nothing", async () => {
    const seed = await seedReadyVolume({ tilesBucket: "someone-elses-tiles" });
    await seedTenantDestination();
    const user = await leadAdmin();
    const s3 = fakeS3([TEST_MANIFEST_BUCKET]);
    const before = await snapshot();
    const res = await publishVolumeAction(
      await publishDepsFromEnv({ ...E, PIPELINE_PUBLISH_ENABLED: "true" }, leadTenant(true), s3.fetch),
      post(seed.volumeId, JSON.stringify({ run_id: seed.runId })),
      seed.volumeId,
      leadTenant(true),
      user,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "spec_mismatch" });
    expect(s3.requests.filter((r) => r.method === "PUT")).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});
