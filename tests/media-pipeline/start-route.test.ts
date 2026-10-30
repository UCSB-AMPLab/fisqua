/**
 * Tests — media pipeline start-run route
 *
 * This suite drives the action-only route that starts a pipeline run,
 * `/admin/media/runs/start`, through its `action` and `loader` with a
 * router context built as the auth middleware would, and drives
 * `startRunAction` directly where a test needs stub dependencies. It
 * pins:
 *
 *   - the gate: a bare 404 when the tenant's capability is off, a bare
 *     403 for the home admin of a member tenant;
 *   - the request body: malformed JSON and a body that does not match
 *     the schema are answered 400 before anything is read;
 *   - a valid request with stub dependencies (GitHub's App token
 *     exchange and dispatch endpoint, and a generated App key) answers
 *     with the run id and chunk count and leaves a dispatched run, its
 *     manifest ids built under the tenant's own manifest base;
 *   - a tenant without a storage destination is answered
 *     `tenant_destination_unset`, naming what is missing, and nothing is
 *     dispatched;
 *   - GET answers 405.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  seedReceivedVolumes,
  seedTenantDestination,
  githubAppEnv,
  withTokenExchange,
  TEST_MANIFEST_BASE,
} from "../helpers/media-pipeline";
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import { AHR_TENANT_ID, NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import { startRunAction, type PipelineRunConfig } from "../../app/lib/pipeline/dispatch.server";
import { getPipelineSpecStore } from "../../app/lib/pipeline/store.server";
import { TONAL_DEFAULT_PRESET } from "../../app/lib/pipeline/recipe";
import type { ManifestResolver } from "../../app/lib/pipeline/run-spec";
import { action, loader } from "../../app/routes/_auth.admin.media.runs.start";

const CONFIG: PipelineRunConfig = {
  maxRunVolumes: 100,
  maxRunPages: 10_000,
  maxSampleVolumes: 100,
  targetImagesPerJob: 734,
  lifetime: {
    secondsPerImage: 0.95,
    perJobOverheadSeconds: 120,
    lanes: 16,
    chunkSpacingSeconds: 60,
    queueAllowanceSeconds: 600,
    marginFactor: 1.5,
    tokenFloorSeconds: 3600,
    urlFloorSeconds: 1800,
    callbackTailSeconds: 600,
  },
  presets: {
    byOutputClass: { tonal: TONAL_DEFAULT_PRESET },
    acceptedKeys: { preprocess: [], render: [] },
  },
};

const manifest: ManifestResolver = (v) => ({
  id: `https://iiif.example.test/${v.referenceCode}/manifest.json`,
  label: { es: [v.referenceCode] },
  homepage: [{ id: `https://catalogue.example.test/${v.referenceCode}`, type: "Text" }],
  rights: null,
  required_statement: null,
  provider: [],
});

function buildContext(user: User, tenant: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env, ctx: { waitUntil: () => {} } };
  return ctx;
}

function post(body: string): Request {
  return new Request("http://neogranadina.fisqua.test/admin/media/runs/start", {
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

function validBody(ids: string[]): string {
  return JSON.stringify({ pipelineVolumeIds: ids, kind: "volume_run", purpose: "sample", maxReviewFrac: 0.1 });
}

describe("start-run route", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  it("answers a bare 404 when the capability is off", async () => {
    const user = await leadAdmin();
    const res = await settle(() =>
      action({ request: post(validBody(["x"])), context: buildContext(user, leadTenant(false)), params: {} } as any),
    );
    expect(res.status).toBe(404);
    expect(res.body).toBeNull();
  });

  it("answers a bare 403 to the home admin of a member tenant", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
        "federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(AHR_TENANT_ID, "ahr", "Member", "tenant", "isadg", "active", NEOGRANADINA_FEDERATION_ID, now, now)
      .run();
    const admin = await createTestUser({ tenantId: AHR_TENANT_ID, isAdmin: true });
    const user = makeUserContext({ id: admin.id, tenantId: AHR_TENANT_ID, isAdmin: true });
    const tenant = makeTenantContext({
      id: AHR_TENANT_ID,
      slug: "ahr",
      federationId: NEOGRANADINA_FEDERATION_ID,
      mediaPipelineEnabled: true,
    });
    const res = await settle(() =>
      action({ request: post(validBody(["x"])), context: buildContext(user, tenant), params: {} } as any),
    );
    expect(res.status).toBe(403);
    expect(res.body).toBeNull();
  });

  it("answers 400 to a malformed body", async () => {
    const user = await leadAdmin();
    const ctx = buildContext(user, leadTenant(true));
    for (const body of [
      "{not json",
      JSON.stringify({ pipelineVolumeIds: [], kind: "volume_run", purpose: "sample", maxReviewFrac: 0.1 }),
      JSON.stringify({ pipelineVolumeIds: ["a"], kind: "other", purpose: "sample", maxReviewFrac: 0.1 }),
      JSON.stringify({ pipelineVolumeIds: ["a"], kind: "volume_run", purpose: "sample", maxReviewFrac: 2 }),
      JSON.stringify({ pipelineVolumeIds: ["a"], kind: "volume_run", purpose: "sample", maxReviewFrac: 0.1, extra: 1 }),
    ]) {
      const res = await settle(() => action({ request: post(body), context: ctx, params: {} } as any));
      expect(res.status, body).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: "invalid_request" });
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pipeline_runs").first<{ n: number }>())?.n).toBe(0);
  });

  it("answers tenant_destination_unset for a tenant without a storage destination", async () => {
    const user = await leadAdmin();
    const seeded = await seedReceivedVolumes({ userId: user.id, count: 1 });
    const sent: string[] = [];
    const appEnv = { ...env, ...(await githubAppEnv()) } as any;
    const res = await startRunAction(
      {
        db: drizzle(env.DB),
        env: appEnv,
        specStore: getPipelineSpecStore(appEnv),
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          sent.push(String(init?.body));
          return new Response(null, { status: 204 });
        }) as typeof fetch,
        manifestResolverFor: () => manifest,
        config: CONFIG,
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      post(validBody(seeded.volumes.map((v) => v.id))),
      leadTenant(true),
      user,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; missing: string[] };
    expect(body.error).toBe("tenant_destination_unset");
    expect(body.missing).toContain("manifest_base_url");
    expect(body.missing).toContain("secret:DELIVERY_READ_KEY_ID");
    expect(sent).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pipeline_runs").first<{ n: number }>())?.n).toBe(0);
  });

  it("starts a run with stub dependencies and answers with its id", async () => {
    await seedTenantDestination();
    const user = await leadAdmin();
    const seeded = await seedReceivedVolumes({ userId: user.id, count: 2 });
    const sent: string[] = [];
    const bases: string[] = [];
    const appEnv = { ...env, ...(await githubAppEnv()) } as any;
    const res = await startRunAction(
      {
        db: drizzle(env.DB),
        env: appEnv,
        specStore: getPipelineSpecStore(appEnv),
        fetchImpl: withTokenExchange((async (_url: RequestInfo | URL, init?: RequestInit) => {
          sent.push(String(init?.body));
          return new Response(null, { status: 204 });
        }) as typeof fetch),
        manifestResolverFor: (base) => {
          bases.push(base);
          return manifest;
        },
        config: CONFIG,
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      post(validBody(seeded.volumes.map((v) => v.id))),
      leadTenant(true),
      user,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; chunkCount: number };
    expect(body.chunkCount).toBe(1);
    const run = await env.DB.prepare("SELECT status FROM pipeline_runs WHERE id = ?")
      .bind(body.runId)
      .first<{ status: string }>();
    expect(run?.status).toBe("dispatched");
    expect(sent).toHaveLength(1);
    expect(bases).toEqual([`${TEST_MANIFEST_BASE}/neogranadina`]);
  });

  it("answers GET with 405", async () => {
    const res = await settle(() => loader());
    expect(res.status).toBe(405);
  });
});

// @version v0.8.0
