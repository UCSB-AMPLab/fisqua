/**
 * Tests — a publish run belongs to the workspace it ran in, on a federation
 *
 * This suite pins that a publish run belongs to the workspace it ran in,
 * on a federation. The federation fixture has a lead (neogranadina) and a
 * member (ahr). POST /api/publish does not refuse a member: on the member
 * host it starts an own-publish of the member's fonds, which
 * `resolveExportScope` scopes to the member alone. So a member's runs
 * exist next to the lead's, and every reader of the runs scopes on the
 * run's own `tenant_id` against the request tenant, never on the export
 * scope's member list. The suite starts runs through the route on both
 * hosts and pins, on the lead:
 *
 *   - the publish page does not take up a member's active run, which
 *     polling and the run detail page would 404 on;
 *   - the history lists only the lead's runs;
 *   - polling the lead's own run returns its step log
 *     (`export_runs.step_log`), which polling a member's run (404) and
 *     the recent-runs list do not;
 *   - a member's completed run does not move the lead's changelog
 *     baseline, so a change after the lead's last publish still counts,
 *     while the counts still span the member's content.
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
import { tenantContext, userContext, type Tenant, type User } from "../../app/context";
import {
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { makeUserContext } from "../helpers/context";
import { seedFederationFixture, type Db } from "../helpers/federation-fixture";
import { AHR_TENANT_ID } from "../../app/lib/tenant";
import { action as publishAction, loader as publishLoader } from "../../app/routes/api.publish";
import { loader as publishPageLoader } from "../../app/routes/_auth.admin.publish";
import { getPublishChangelog } from "../../app/lib/export/publish-changelog.server";

const LEAD_USER = "u-lead-000-0000-0000-000000000001";
const MEMBER_USER = "u-ahr-0000-0000-0000-000000000002";

async function tenantRow(db: Db, id: string): Promise<Tenant> {
  return (await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get()) as Tenant;
}

function context(user: User, tenant: Tenant) {
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

async function post(user: User, tenant: Tenant, fonds: string): Promise<string> {
  const { ctx, pending } = context(user, tenant);
  const response = await publishAction({
    request: new Request("https://x.fisqua.test/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedFonds: [fonds], selectedTypes: ["descriptions"] }),
    }),
    context: ctx,
    params: {},
  } as any);
  await Promise.all(pending);
  expect(response.status).toBe(202);
  return ((await response.json()) as { exportId: string }).exportId;
}

describe("on a federation, a run belongs to the workspace it ran in", () => {
  let db: Db;
  let lead: Tenant;
  let member: Tenant;
  const leadUser = makeUserContext({ id: LEAD_USER, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true, isSuperAdmin: true });
  const memberUser = makeUserContext({ id: MEMBER_USER, tenantId: AHR_TENANT_ID, isAdmin: true, isSuperAdmin: true });

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    await seedFederationFixture(db);
    const now = Date.now();
    await db.insert(schema.users).values([
      { id: LEAD_USER, tenantId: DEFAULT_TEST_TENANT_ID, email: "lead@example.test", isAdmin: true, isSuperAdmin: true, createdAt: now, updatedAt: now },
      { id: MEMBER_USER, tenantId: AHR_TENANT_ID, email: "ahr@example.test", isAdmin: true, isSuperAdmin: true, createdAt: now, updatedAt: now },
    ]);
    lead = await tenantRow(db, DEFAULT_TEST_TENANT_ID);
    member = await tenantRow(db, AHR_TENANT_ID);
  });

  it("a member host can start a publish of its own fonds", async () => {
    const id = await post(memberUser, member, "co-ahr-gob");
    const row = await db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, id)).get();
    expect(row?.tenantId).toBe(AHR_TENANT_ID);
  });

  it("the lead page does not take up a member's active run, and its history has only the lead's runs", async () => {
    const leadRun = await post(leadUser, lead, "co-ahrb-gob");
    await db
      .update(schema.exportRuns)
      .set({ status: "complete", completedAt: Date.now() })
      .where(eq(schema.exportRuns.id, leadRun));
    const memberRun = await post(memberUser, member, "co-ahr-gob");

    const { ctx } = context(leadUser, lead);
    const page = (await publishPageLoader({ context: ctx, params: {}, request: new Request("https://x/admin/publish") } as any)) as any;
    expect(page.activeExport).toBeNull();
    expect(page.history.map((h: { id: string }) => h.id)).toEqual([leadRun]);
    // The lead cannot poll the member's run, which is why it must not
    // be taken up as the lead's active run.
    const polled = (await publishLoader({
      request: new Request(`https://x/api/publish?exportId=${memberRun}`),
      context: ctx,
      params: {},
    } as any)) as Response;
    expect(polled.status).toBe(404);
  });

  it("polling returns the step log of the caller's own run only", async () => {
    const leadRun = await post(leadUser, lead, "co-ahrb-gob");
    const memberRun = await post(memberUser, member, "co-ahr-gob");
    const log = JSON.stringify({ "descriptions:co-ahrb-gob": { startedAt: 1, completedAt: 2 } });
    await env.DB.prepare("UPDATE export_runs SET step_log = ?").bind(log).run();

    const { ctx } = context(leadUser, lead);
    const poll = (query: string) =>
      publishLoader({ request: new Request(`https://x/api/publish${query}`), context: ctx, params: {} } as any) as Promise<Response>;
    const own = await poll(`?exportId=${leadRun}`);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { stepLog: string | null }).stepLog).toBe(log);
    expect((await poll(`?exportId=${memberRun}`)).status).toBe(404);
    const list = (await (await poll("")).json()) as Array<Record<string, unknown>>;
    expect(list.map((r) => r.id)).toEqual([leadRun]);
    expect(list[0]).not.toHaveProperty("stepLog");
  });

  it("a member's completed run does not move the lead's changelog baseline", async () => {
    const t1 = 1_900_000_000_000;
    const t2 = t1 + 1_000;
    const t3 = t1 + 2_000;
    const leadRun = await post(leadUser, lead, "co-ahrb-gob");
    await db.update(schema.exportRuns).set({ status: "complete", completedAt: t1 }).where(eq(schema.exportRuns.id, leadRun));
    // A lead repository changed after the lead's last publish...
    await db.update(schema.repositories).set({ updatedAt: t2 }).where(eq(schema.repositories.tenantId, DEFAULT_TEST_TENANT_ID));
    // ...and the member then published on its own.
    const memberRun = await post(memberUser, member, "co-ahr-gob");
    await db.update(schema.exportRuns).set({ status: "complete", completedAt: t3 }).where(eq(schema.exportRuns.id, memberRun));

    const changelog = await getPublishChangelog(db, {
      publishTenantId: DEFAULT_TEST_TENANT_ID,
      memberTenantIds: [DEFAULT_TEST_TENANT_ID, AHR_TENANT_ID],
      federationId: DEFAULT_TEST_FEDERATION_ID,
      authoritiesEnabled: false,
    });
    expect(changelog.repositories.modified).toBe(1);
    // The counts still span the member's fonds.
    expect(changelog.descriptions.map((d) => d.fonds).sort()).toEqual(["co-ahr-gob", "co-ahrb-gob"]);
  });
});

// @version v0.9.0
