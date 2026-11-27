/**
 * Tests — a publish run belongs to the workspace it was started in
 *
 * This suite pins that a publish run belongs to the workspace it was
 * started in, when a platform admin stored in another workspace starts it.
 * A platform admin's row is stored in one workspace and they publish from
 * another. `export_runs.tenant_id` (migration 0115) records the request
 * workspace at insert, and every reader scopes on it rather than on the
 * triggering user's stored workspace. The suite has a platform admin
 * stored in the second test tenant start a publish on the default tenant,
 * as the auth middleware hands them to the route
 * (`platformAdminEffectiveUser`), and pins:
 *
 *   - the run row carries the default tenant;
 *   - the workflow's `load-config` (`loadPublishConfig`) resolves the
 *     default tenant as the publish tenant;
 *   - GET /api/publish finds the run by id and lists it;
 *   - the in-flight guard sees it: a second POST is refused with 409;
 *   - the publish page's active run and history, the run detail page,
 *     and the counts' last completed export (repositories changed
 *     before it count as unmodified) read it;
 *   - the same for a home super admin of the default tenant.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { tenantContext, userContext, type User } from "../../app/context";
import {
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { action as publishAction, loader as publishLoader } from "../../app/routes/api.publish";
import { loader as publishPageLoader } from "../../app/routes/_auth.admin.publish";
import { loader as runDetailLoader } from "../../app/routes/_auth.admin.publish.runs.$exportId";
import { loadPublishConfig } from "../../app/workflows/publish-export";
import { getPublishChangelog } from "../../app/lib/export/publish-changelog.server";
import { platformAdminEffectiveUser } from "../../app/lib/platform-admin.server";

const PA_USER = "u-pa-00000-0000-0000-000000000001";
const HOME_USER = "u-home-000-0000-0000-000000000002";
const tenant = makeTenantContext({ id: DEFAULT_TEST_TENANT_ID });

function context(user: User) {
  const pending: Promise<unknown>[] = [];
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = {
    env: { DB: env.DB, PUBLISH_EXPORT: { create: async () => ({}) } },
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  };
  return { ctx, pending };
}

async function post(user: User) {
  const { ctx, pending } = context(user);
  const response = await publishAction({
    request: new Request("https://neogranadina.fisqua.test/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedFonds: ["co-neo-fonds"], selectedTypes: ["descriptions"] }),
    }),
    context: ctx,
    params: {},
  } as any);
  await Promise.all(pending);
  return response;
}

async function get(user: User, query = "") {
  const { ctx } = context(user);
  return (await publishLoader({
    request: new Request(`https://neogranadina.fisqua.test/api/publish${query}`),
    context: ctx,
    params: {},
  } as any)) as Response;
}

describe("a publish run belongs to the request workspace", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let pa: User;
  let home: User;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    const now = Date.now();
    await db.insert(schema.users).values([
      { id: PA_USER, tenantId: SECOND_TEST_TENANT_ID, email: "pa@example.test", createdAt: now, updatedAt: now },
      {
        id: HOME_USER,
        tenantId: DEFAULT_TEST_TENANT_ID,
        email: "home@example.test",
        isAdmin: true,
        isSuperAdmin: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await env.DB.prepare("UPDATE users SET is_platform_admin = 1 WHERE id = ?").bind(PA_USER).run();
    const repoId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: repoId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      code: "neo-repo",
      name: "Neogranadina Repo",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: repoId,
      parentId: null,
      rootDescriptionId: descId,
      descriptionLevel: "fonds",
      referenceCode: "co-neo-fonds",
      localIdentifier: "NEO-001",
      title: "Neogranadina Fonds",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    });
    pa = platformAdminEffectiveUser(
      makeUserContext({ id: PA_USER, tenantId: SECOND_TEST_TENANT_ID, email: "pa@example.test" }),
      tenant,
    );
    home = makeUserContext({ id: HOME_USER, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true, isSuperAdmin: true });
  });

  for (const who of ["platform admin", "home super admin"] as const) {
    it(`${who}: the run, load-config, polling, the guard and the readers all use the request workspace`, async () => {
      const user = who === "platform admin" ? pa : home;
      const response = await post(user);
      expect(response.status).toBe(202);
      const { exportId } = (await response.json()) as { exportId: string };

      const row = await db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, exportId)).get();
      expect(row?.tenantId).toBe(DEFAULT_TEST_TENANT_ID);
      expect(row?.triggeredBy).toBe(user.id);

      const config = await loadPublishConfig(db, exportId, "instance-1");
      expect(config.publishTenant.id).toBe(DEFAULT_TEST_TENANT_ID);

      const polled = await get(user, `?exportId=${exportId}`);
      expect(polled.status).toBe(200);
      expect(((await polled.json()) as { id: string }).id).toBe(exportId);
      const listed = (await (await get(user)).json()) as Array<{ id: string }>;
      expect(listed.map((r) => r.id)).toEqual([exportId]);

      // The run is now running; a second publish is refused.
      const second = await post(user);
      expect(second.status).toBe(409);

      const { ctx } = context(user);
      const page = (await publishPageLoader({ context: ctx, params: {}, request: new Request("https://x/admin/publish") } as any)) as any;
      expect(page.activeExport?.id).toBe(exportId);
      expect(page.history.map((h: { id: string }) => h.id)).toEqual([exportId]);
      const detail = (await runDetailLoader({ context: ctx, params: { exportId } } as any)) as any;
      expect(detail.run?.id).toBe(exportId);

      await db
        .update(schema.exportRuns)
        .set({ status: "complete", completedAt: 1_900_000_000_000 })
        .where(eq(schema.exportRuns.id, exportId));
      const changelog = await getPublishChangelog(db, {
        publishTenantId: DEFAULT_TEST_TENANT_ID,
        memberTenantIds: [DEFAULT_TEST_TENANT_ID],
        federationId: tenant.federationId,
        authoritiesEnabled: false,
      });
      // The repository was last changed before the run completed, so
      // it counts as modified only if the run is not found.
      expect(changelog.repositories.modified).toBe(0);
    });
  }

  it("a run of the second tenant does not appear on the default tenant", async () => {
    const now = Date.now();
    await db.insert(schema.exportRuns).values({
      id: "run-other",
      triggeredBy: PA_USER,
      tenantId: SECOND_TEST_TENANT_ID,
      status: "running",
      selectedFonds: "[]",
      selectedTypes: "[]",
      createdAt: now,
      startedAt: now,
      lastHeartbeatAt: now,
    });
    expect((await get(home, "?exportId=run-other")).status).toBe(404);
    expect((await post(home)).status).toBe(202);
  });
});

// @version v0.9.0
