/**
 * Tests — the manifest attribution refresh route
 *
 * This suite pins the superadmin route that starts and polls a refresh
 * of one federation's published manifests:
 *
 *   - a user who is not a superadmin is redirected and nothing starts;
 *   - a malformed body, an unknown mode or an unknown federation is
 *     refused, and a federation without a manifest bucket, address or
 *     write key is refused naming what is missing, never a value;
 *   - a valid request names the federation by id or slug, defaults to a
 *     dry run, starts one workflow instance with the federation's id and
 *     the mode, and answers 202 with the instance id and the report key;
 *   - `limit` (a whole number from 1 to 1500) is required in both modes;
 *     `repository` (a code of one of the federation's repositories) and
 *     `after` (a reference code and id) are passed to the run when
 *     given; any other value is refused;
 *   - one apply at a time per federation: a second apply is refused with
 *     the holder's instance id while the first runs; a lock is taken
 *     over only when released or when its instance is complete, errored
 *     or terminated, and refused as unverified when the instance is
 *     unknown or its status cannot be read; a failed create leaves the
 *     lock in place; a dry run takes no lock and is never refused for one;
 *   - polling answers the instance's status, and with `report=1` the
 *     stored report.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { tenantContext, userContext } from "../../app/context";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { seedTenantDestination } from "../helpers/media-pipeline";
import { action, loader } from "../../app/routes/api.manifest-refresh";
import { refreshLockKey, refreshReportKey } from "../../app/lib/pipeline/manifest-refresh-run.server";

interface Created {
  id: string;
  params: Record<string, unknown>;
}

function context(
  opts: {
    superadmin?: boolean;
    envOverrides?: Record<string, unknown>;
    created?: Created[];
    /** Status of instances not started by this test; one started here is running. */
    statuses?: Record<string, string>;
  } = {},
) {
  const created = opts.created ?? [];
  const ctx = new RouterContextProvider();
  ctx.set(
    userContext,
    makeUserContext({
      id: "user-1",
      tenantId: DEFAULT_TEST_TENANT_ID,
      isSuperAdmin: opts.superadmin ?? true,
      isAdmin: true,
    }),
  );
  ctx.set(tenantContext, makeTenantContext({ id: DEFAULT_TEST_TENANT_ID }));
  (ctx as any).cloudflare = {
    env: {
      ...env,
      MANIFEST_REFRESH: {
        create: async (o: Created) => {
          created.push(o);
          return { id: o.id };
        },
        get: async (id: string) => {
          const status = opts.statuses?.[id] ?? (created.some((c) => c.id === id) ? "running" : undefined);
          if (status === "throw") {
            return {
              id,
              status: async () => {
                throw new Error("status unavailable");
              },
            };
          }
          if (status !== undefined) return { id, status: async () => ({ status }) };
          if (id !== "known") throw new Error("instance.not_found");
          return {
            id,
            status: async () => ({
              status: "complete",
              output: { report_key: refreshReportKey("neogranadina", "known"), counts: { unchanged: 3 } },
            }),
          };
        },
      },
      ...opts.envOverrides,
    },
    ctx: { waitUntil: () => {} },
  };
  return { ctx, created };
}

async function post(body: unknown, opts: Parameters<typeof context>[0] = {}) {
  return postWith(context(opts), body);
}

async function postWith({ ctx, created }: ReturnType<typeof context>, body: unknown) {
  const request = new Request("https://fisqua.test/api/manifest-refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  try {
    const response = await action({ request, context: ctx, params: {} } as any);
    return { response, created };
  } catch (thrown) {
    if (thrown instanceof Response) return { response: thrown, created };
    throw thrown;
  }
}

describe("the manifest refresh route", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    await seedTenantDestination();
    await env.BUCKET.delete(refreshLockKey("neogranadina"));
  });

  it("redirects a user who is not a superadmin and starts nothing", async () => {
    const { response, created } = await post({ federation: "neogranadina", limit: 10 }, { superadmin: false });
    expect(response.status).toBe(302);
    expect(created).toEqual([]);
  });

  it("refuses a malformed body, an unknown mode and an unknown federation", async () => {
    expect((await post("{")).response.status).toBe(400);
    expect((await post({ federation: "neogranadina", mode: "force" })).response.status).toBe(400);
    expect((await post({ federation: "neogranadina", extra: 1 })).response.status).toBe(400);
    const unknown = await post({ federation: "nowhere", limit: 10 });
    expect(unknown.response.status).toBe(404);
    expect(await unknown.response.json()).toEqual({ error: "federation_not_found" });
    expect(unknown.created).toEqual([]);
  });

  it("refuses a federation whose manifest destination is incomplete, naming what is missing", async () => {
    const { response, created } = await post(
      { federation: "neogranadina", limit: 10 },
      { envOverrides: { TEST_TENANT_MANIFEST_WRITE_SECRET_KEY: undefined } },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "manifest_destination_unset",
      missing: ["secret:MANIFEST_WRITE_SECRET_KEY"],
    });
    expect(created).toEqual([]);
  });

  it("starts a dry run by default, by slug or by id", async () => {
    const bySlug = await post({ federation: "neogranadina", limit: 10 });
    expect(bySlug.response.status).toBe(202);
    const body = (await bySlug.response.json()) as Record<string, unknown>;
    expect(bySlug.created).toHaveLength(1);
    const [instance] = bySlug.created;
    expect(instance.params).toEqual({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      federationSlug: "neogranadina",
      mode: "dry_run",
      requestedBy: "user-1",
      limit: 10,
    });
    expect(body).toEqual({
      instance_id: instance.id,
      federation: { id: DEFAULT_TEST_FEDERATION_ID, slug: "neogranadina" },
      mode: "dry_run",
      report_key: refreshReportKey("neogranadina", instance.id),
    });

    const byId = await post({ federation: DEFAULT_TEST_FEDERATION_ID, mode: "apply", limit: 10 });
    expect(byId.response.status).toBe(202);
    expect(byId.created[0].params).toMatchObject({ federationId: DEFAULT_TEST_FEDERATION_ID, mode: "apply" });
  });

  it("requires a limit from 1 to 1500 in either mode and refuses any other", async () => {
    const ok = await post({ federation: "neogranadina", mode: "apply", limit: 20 });
    expect(ok.response.status).toBe(202);
    expect(ok.created[0].params).toEqual({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      federationSlug: "neogranadina",
      mode: "apply",
      requestedBy: "user-1",
      limit: 20,
    });
    expect((await post({ federation: "neogranadina", limit: 1500 })).response.status).toBe(202);
    for (const mode of ["dry_run", "apply"]) {
      const missing = await post({ federation: "neogranadina", mode });
      expect(missing.response.status).toBe(400);
      expect(await missing.response.json()).toMatchObject({ error: "invalid_request", detail: "limit" });
      expect(missing.created).toEqual([]);
    }
    for (const limit of [0, -1, 1501, 1.5, "20", null]) {
      const refused = await post({ federation: "neogranadina", limit });
      expect(refused.response.status).toBe(400);
      expect(refused.created).toEqual([]);
    }
  });

  it("passes a repository of the federation and refuses an unknown one", async () => {
    await createTestRepository({ id: "repo-route-1", code: "co-route", tenantId: DEFAULT_TEST_TENANT_ID });
    await createTestRepository({ id: "repo-route-2", code: "co-other", tenantId: SECOND_TEST_TENANT_ID });
    const ok = await post({ federation: "neogranadina", repository: "co-route", limit: 10 });
    expect(ok.response.status).toBe(202);
    expect(ok.created[0].params).toEqual({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      federationSlug: "neogranadina",
      mode: "dry_run",
      requestedBy: "user-1",
      limit: 10,
      repository: "co-route",
    });
    const elsewhere = await post({ federation: "neogranadina", repository: "co-other", limit: 10 });
    expect(elsewhere.response.status).toBe(404);
    expect(await elsewhere.response.json()).toEqual({ error: "repository_not_found" });
    expect((await post({ federation: "neogranadina", repository: "", limit: 10 })).response.status).toBe(400);
    expect((await post({ federation: "neogranadina", repository: 5, limit: 10 })).response.status).toBe(400);
  });

  it("passes a starting point of reference code and id, and refuses any other shape", async () => {
    const after = { reference_code: "co-a-002", id: "00000000-0000-4000-8000-000000000002" };
    const ok = await post({ federation: "neogranadina", limit: 10, after });
    expect(ok.response.status).toBe(202);
    expect(ok.created[0].params).toEqual({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      federationSlug: "neogranadina",
      mode: "dry_run",
      requestedBy: "user-1",
      limit: 10,
      after,
    });
    for (const bad of [
      "co-a-002",
      { reference_code: "co-a-002" },
      { id: after.id },
      { reference_code: "", id: after.id },
      { reference_code: "co-a-002", id: "" },
      { ...after, extra: 1 },
      null,
    ]) {
      const refused = await post({ federation: "neogranadina", limit: 10, after: bad });
      expect(refused.response.status, JSON.stringify(bad)).toBe(400);
      expect(refused.created).toEqual([]);
    }
  });

  describe("one apply at a time", () => {
    const lockKey = refreshLockKey("neogranadina");

    it("refuses a second apply while the first runs, and lets a dry run start", async () => {
      const shared = context();
      const first = await postWith(shared, { federation: "neogranadina", mode: "apply", limit: 10 });
      expect(first.response.status).toBe(202);
      const holder = shared.created[0].id;
      const lock = JSON.parse(await (await env.BUCKET.get(lockKey))!.text());
      expect(lock).toMatchObject({ instance_id: holder });
      expect(typeof lock.started_at).toBe("number");

      const second = await postWith(shared, { federation: "neogranadina", mode: "apply", limit: 10 });
      expect(second.response.status).toBe(409);
      expect(await second.response.json()).toEqual({ error: "refresh_in_progress", instance_id: holder });
      expect(shared.created).toHaveLength(1);

      const dry = await postWith(shared, { federation: "neogranadina", limit: 10 });
      expect(dry.response.status).toBe(202);
      expect(shared.created).toHaveLength(2);
      expect(JSON.parse(await (await env.BUCKET.get(lockKey))!.text()).instance_id).toBe(holder);
    });

    it("takes over a lock only when its instance has definitely stopped", async () => {
      for (const [holder, statuses] of [
        ["stopped-1", { "stopped-1": "complete" }],
        ["stopped-2", { "stopped-2": "errored" }],
        ["stopped-3", { "stopped-3": "terminated" }],
      ] as const) {
        await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: holder, started_at: 1 }));
        const shared = context({ statuses });
        const taken = await postWith(shared, { federation: "neogranadina", mode: "apply", limit: 10 });
        expect(taken.response.status, holder).toBe(202);
        const lock = JSON.parse(await (await env.BUCKET.get(lockKey))!.text());
        expect(lock.instance_id).toBe(shared.created[0].id);
      }
    });

    it("refuses to take over a lock whose instance cannot be verified", async () => {
      for (const [holder, statuses] of [
        ["gone", {}],
        ["broken", { broken: "throw" }],
        ["odd", { odd: "unknown" }],
      ] as const) {
        await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: holder, started_at: 1 }));
        const shared = context({ statuses });
        const refused = await postWith(shared, { federation: "neogranadina", mode: "apply", limit: 10 });
        expect(refused.response.status, holder).toBe(409);
        expect(await refused.response.json()).toEqual({ error: "refresh_lock_unverified", instance_id: holder });
        expect(shared.created).toEqual([]);
        expect(JSON.parse(await (await env.BUCKET.get(lockKey))!.text()).instance_id).toBe(holder);
      }
    });

    it("leaves the lock in place when the instance cannot be created", async () => {
      const shared = context({
        envOverrides: {
          MANIFEST_REFRESH: {
            create: async () => {
              throw new Error("create failed");
            },
            get: async () => {
              throw new Error("instance.not_found");
            },
          },
        },
      });
      await expect(postWith(shared, { federation: "neogranadina", mode: "apply", limit: 10 })).rejects.toThrow(
        "create failed",
      );
      const lock = JSON.parse(await (await env.BUCKET.get(lockKey))!.text());
      expect(lock.released_at).toBeUndefined();
      expect(typeof lock.instance_id).toBe("string");
    });

    it("takes a released lock", async () => {
      await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: "done", started_at: 1, released_at: 2 }));
      const shared = context({ statuses: { done: "running" } });
      const taken = await postWith(shared, { federation: "neogranadina", mode: "apply", limit: 10 });
      expect(taken.response.status).toBe(202);
    });
  });

  it("answers an instance's status, and its stored report", async () => {
    const { ctx } = context();
    const key = refreshReportKey("neogranadina", "known");
    await env.BUCKET.put(key, JSON.stringify({ counts: { unchanged: 3 } }));
    const status = await loader({
      request: new Request("https://fisqua.test/api/manifest-refresh?instance=known"),
      context: ctx,
      params: {},
    } as any);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      instance_id: "known",
      status: "complete",
      error: null,
      output: { report_key: key, counts: { unchanged: 3 } },
    });

    const report = await loader({
      request: new Request("https://fisqua.test/api/manifest-refresh?instance=known&report=1"),
      context: ctx,
      params: {},
    } as any);
    expect(await report.json()).toEqual({ counts: { unchanged: 3 } });

    const missing = await loader({
      request: new Request("https://fisqua.test/api/manifest-refresh?instance=gone"),
      context: ctx,
      params: {},
    } as any);
    expect(missing.status).toBe(404);
    expect((await loader({ request: new Request("https://fisqua.test/api/manifest-refresh"), context: ctx, params: {} } as any)).status).toBe(400);
    await env.BUCKET.delete(key);
  });
});
