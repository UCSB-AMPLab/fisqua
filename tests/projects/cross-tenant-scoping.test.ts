/**
 * Tests — cross-tenant scoping on the crowdsourcing surface
 *
 * This suite pins the request-tenant boundary behind the auth
 * middleware for the member-facing `/projects/*` tree and the
 * crowdsourcing API endpoints. Everything here is a NEGATIVE case
 * built from the same two-tenant fixture: a project, a volume and an
 * entry in each of two tenants, and a caller whose session is served
 * on one host while the identifiers they submit name resources in the
 * other.
 *
 * Two invariants are under test, and they fail differently on purpose:
 *
 * 1. SCOPE. A project id that resolves to another tenant's row must
 *    404, never 403 — a 403 would confirm the id names a real project
 *    somewhere on the platform. The scope check runs ahead of the
 *    `isAdmin` bypass, because role flags arrive from the request
 *    tenant's effective grant and mean nothing outside it.
 * 2. LINKAGE. A role held on the project in the URL authorises writes
 *    to THAT project's resources only. Every action that takes a
 *    volume or entry id from the request body must re-derive its owner
 *    and refuse the mismatch, in the action itself — a linkage check
 *    that lives only in the loader protects nothing, since loaders and
 *    actions are separately reachable.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { tenantContext, userContext, type User } from "../../app/context";
import { requireProjectRole } from "../../app/lib/permissions.server";
import { getProject, getUserProjects } from "../../app/lib/projects.server";
import { i18nextMiddleware } from "../../app/middleware/i18next";
// Warm the route-module graph at file load so the in-test dynamic
// imports resolve from cache rather than paying a cold module-runner
// cost inside a timed test body.
import "../../app/routes/_auth.projects.$id.overview";
import "../../app/routes/_auth.projects.$id.members";
import "../../app/routes/_auth.projects.$id.volumes";
import "../../app/routes/api.workflow";

const PROJECT_A = "projAAAA1";
const PROJECT_B = "projBBBB1";

/**
 * Build a request context whose TENANT is the host being served,
 * independent of the caller's home tenant. The i18next middleware is
 * run for real because the member and volume actions translate their
 * own error strings through `getInstance(context)`.
 */
async function buildContext(user: User, requestTenantId: string) {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: requestTenantId }));
  (ctx as any).cloudflare = { env };
  await i18nextMiddleware(
    {
      request: new Request("http://neogranadina.fisqua.test/"),
      context: ctx,
      params: {},
    } as any,
    async () => new Response(null),
  );
  return ctx;
}

function formRequest(fields: Record<string, string>) {
  return new Request("http://neogranadina.fisqua.test/", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

/** Status of a thrown-or-returned Response, whichever the route used. */
async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    const result = await fn();
    if (result instanceof Response) return result.status;
    return 200;
  } catch (err) {
    if (err instanceof Response) return err.status;
    throw err;
  }
}

type Fixture = Awaited<ReturnType<typeof seedTwoTenants>>;

/**
 * Two tenants, one project each, with a volume and an unassigned entry
 * under every project. `leadA` leads project A; `cataloguerA` is a
 * member of it; `strangerA` shares tenant A but holds no membership.
 */
async function seedTwoTenants() {
  const db = drizzle(env.DB, { schema });
  const now = Date.now();

  const leadA = await createTestUser({
    tenantId: DEFAULT_TEST_TENANT_ID,
    email: "lead-a@example.test",
  });
  const cataloguerA = await createTestUser({
    tenantId: DEFAULT_TEST_TENANT_ID,
    email: "cataloguer-a@example.test",
  });
  const strangerA = await createTestUser({
    tenantId: DEFAULT_TEST_TENANT_ID,
    email: "stranger-a@example.test",
  });
  const userB = await createTestUser({
    tenantId: SECOND_TEST_TENANT_ID,
    email: "user-b@example.test",
  });

  await db.insert(schema.projects).values([
    {
      id: PROJECT_A,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Project A",
      createdBy: leadA.id,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: PROJECT_B,
      tenantId: SECOND_TEST_TENANT_ID,
      name: "Project B",
      createdBy: userB.id,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: "pm-lead-a",
      projectId: PROJECT_A,
      userId: leadA.id,
      role: "lead",
      createdAt: now,
    },
    {
      id: "pm-cat-a",
      projectId: PROJECT_A,
      userId: cataloguerA.id,
      role: "cataloguer",
      createdAt: now,
    },
    {
      id: "pm-lead-b",
      projectId: PROJECT_B,
      userId: userB.id,
      role: "lead",
      createdAt: now,
    },
  ]);

  await db.insert(schema.volumes).values([
    {
      id: "vol-a",
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId: PROJECT_A,
      name: "Volume A",
      referenceCode: "A-1",
      manifestUrl: "https://iiif.example.test/a.json",
      pageCount: 2,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "vol-b",
      tenantId: SECOND_TEST_TENANT_ID,
      projectId: PROJECT_B,
      name: "Volume B",
      referenceCode: "B-1",
      manifestUrl: "https://iiif.example.test/b.json",
      pageCount: 2,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.entries).values([
    {
      id: "entry-a",
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId: "vol-a",
      position: 0,
      startPage: 1,
      descriptionStatus: "unassigned",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "entry-b",
      tenantId: SECOND_TEST_TENANT_ID,
      volumeId: "vol-b",
      position: 0,
      startPage: 1,
      descriptionStatus: "unassigned",
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return { db, leadA, cataloguerA, strangerA, userB };
}

describe("cross-tenant scoping — crowdsourcing surface", () => {
  let fx: Fixture;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    fx = await seedTwoTenants();
  });

  describe("requireProjectRole tenant assert", () => {
    it("404s on a foreign-tenant project even when isAdmin is true", async () => {
      const status = await statusOf(() =>
        requireProjectRole(
          fx.db,
          DEFAULT_TEST_TENANT_ID,
          fx.leadA.id,
          PROJECT_B,
          ["lead"],
          true,
        ),
      );
      expect(status).toBe(404);
    });

    it("404s on a foreign-tenant project for a member of it", async () => {
      // userB genuinely leads project B — but the request is being
      // served on tenant A's host, so project B does not exist here.
      const status = await statusOf(() =>
        requireProjectRole(
          fx.db,
          DEFAULT_TEST_TENANT_ID,
          fx.userB.id,
          PROJECT_B,
          ["lead"],
          false,
        ),
      );
      expect(status).toBe(404);
    });

    it("404s on a project id that does not exist at all", async () => {
      const status = await statusOf(() =>
        requireProjectRole(
          fx.db,
          DEFAULT_TEST_TENANT_ID,
          fx.leadA.id,
          "nosuchid",
          ["lead"],
          true,
        ),
      );
      expect(status).toBe(404);
    });

    it("403s — not 404s — when the project is ours and the role is missing", async () => {
      const status = await statusOf(() =>
        requireProjectRole(
          fx.db,
          DEFAULT_TEST_TENANT_ID,
          fx.cataloguerA.id,
          PROJECT_A,
          ["lead"],
          false,
        ),
      );
      expect(status).toBe(403);
    });

    it("still admits a genuine lead of an own-tenant project", async () => {
      const memberships = await requireProjectRole(
        fx.db,
        DEFAULT_TEST_TENANT_ID,
        fx.leadA.id,
        PROJECT_A,
        ["lead"],
        false,
      );
      expect(memberships).toHaveLength(1);
      expect(memberships[0].role).toBe("lead");
    });
  });

  describe("projects.server reads", () => {
    it("getProject returns null for a foreign-tenant project", async () => {
      expect(await getProject(fx.db, DEFAULT_TEST_TENANT_ID, PROJECT_B)).toBeNull();
      expect(await getProject(fx.db, DEFAULT_TEST_TENANT_ID, PROJECT_A)).not.toBeNull();
    });

    it("getUserProjects admin branch is capped at the request tenant", async () => {
      const projects = await getUserProjects(
        fx.db,
        DEFAULT_TEST_TENANT_ID,
        fx.leadA.id,
        true,
      );
      expect(projects.map((p) => p.id)).toEqual([PROJECT_A]);
    });
  });

  describe("/projects/:id/overview action", () => {
    async function runOverview(
      user: User,
      projectId: string,
      fields: Record<string, string>,
    ) {
      const { action } = await import(
        "../../app/routes/_auth.projects.$id.overview"
      );
      return (await action({
        request: formRequest(fields),
        context: await buildContext(user, DEFAULT_TEST_TENANT_ID),
        params: { id: projectId },
      } as any)) as any;
    }

    it("403s for an own-tenant user with no membership", async () => {
      const status = await statusOf(() =>
        runOverview(makeUserContext({ id: fx.strangerA.id }), PROJECT_A, {
          intent: "assignDescriber",
          entryId: "entry-a",
          describerId: fx.cataloguerA.id,
        }),
      );
      expect(status).toBe(403);
    });

    it("404s on a foreign-tenant project id", async () => {
      const status = await statusOf(() =>
        runOverview(makeUserContext({ id: fx.leadA.id }), PROJECT_B, {
          intent: "assignDescriber",
          entryId: "entry-b",
          describerId: fx.userB.id,
        }),
      );
      expect(status).toBe(404);
    });

    it("404s when the entry belongs to another project", async () => {
      const status = await statusOf(() =>
        runOverview(makeUserContext({ id: fx.leadA.id }), PROJECT_A, {
          intent: "assignDescriber",
          entryId: "entry-b",
          describerId: fx.cataloguerA.id,
        }),
      );
      expect(status).toBe(404);

      const entryB = await fx.db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.id, "entry-b"))
        .get();
      expect(entryB!.assignedDescriber).toBeNull();
      expect(entryB!.descriptionStatus).toBe("unassigned");
    });

    it("400s when the describer is not a member of the project", async () => {
      const result = await runOverview(
        makeUserContext({ id: fx.leadA.id }),
        PROJECT_A,
        {
          intent: "assignDescriber",
          entryId: "entry-a",
          describerId: fx.strangerA.id,
        },
      );
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);

      const entryA = await fx.db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.id, "entry-a"))
        .get();
      expect(entryA!.assignedDescriber).toBeNull();
    });

    it("still assigns a project member to an in-scope entry", async () => {
      const result = await runOverview(
        makeUserContext({ id: fx.leadA.id }),
        PROJECT_A,
        {
          intent: "assignDescriber",
          entryId: "entry-a",
          describerId: fx.cataloguerA.id,
        },
      );
      expect(result.success).toBe(true);

      const entryA = await fx.db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.id, "entry-a"))
        .get();
      expect(entryA!.assignedDescriber).toBe(fx.cataloguerA.id);
    });
  });

  describe("/projects/:id/members", () => {
    async function runMembersLoader(user: User, projectId: string) {
      const { loader } = await import(
        "../../app/routes/_auth.projects.$id.members"
      );
      return (await loader({
        request: new Request("http://neogranadina.fisqua.test/"),
        context: await buildContext(user, DEFAULT_TEST_TENANT_ID),
        params: { id: projectId },
      } as any)) as any;
    }

    async function runMembersAction(
      user: User,
      projectId: string,
      fields: Record<string, string>,
    ) {
      const { action } = await import(
        "../../app/routes/_auth.projects.$id.members"
      );
      return (await action({
        request: formRequest(fields),
        context: await buildContext(user, DEFAULT_TEST_TENANT_ID),
        params: { id: projectId },
      } as any)) as any;
    }

    it("the add-member picker lists only this tenant's users", async () => {
      const data = await runMembersLoader(
        makeUserContext({ id: fx.leadA.id }),
        PROJECT_A,
      );
      const ids = data.allUsers.map((u: { id: string }) => u.id);
      expect(ids).toContain(fx.leadA.id);
      expect(ids).toContain(fx.cataloguerA.id);
      expect(ids).toContain(fx.strangerA.id);
      expect(ids).not.toContain(fx.userB.id);
    });

    it("addMember rejects a foreign-tenant user", async () => {
      const result = await runMembersAction(
        makeUserContext({ id: fx.leadA.id }),
        PROJECT_A,
        { _action: "addMember", userId: fx.userB.id, role: "cataloguer" },
      );
      expect(result.ok).toBe(false);

      const rows = await fx.db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.userId, fx.userB.id))
        .all();
      // Only their own project-B lead row survives; no row was created
      // binding them into project A.
      expect(rows.map((r) => r.projectId)).toEqual([PROJECT_B]);
    });

    it("changeMemberRole is a no-op on a membership from another project", async () => {
      await runMembersAction(makeUserContext({ id: fx.leadA.id }), PROJECT_A, {
        _action: "changeMemberRole",
        membershipId: "pm-lead-b",
        role: "cataloguer",
      });

      const row = await fx.db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.id, "pm-lead-b"))
        .get();
      expect(row!.role).toBe("lead");
    });

    it("removeMember is a no-op on a membership from another project", async () => {
      await runMembersAction(makeUserContext({ id: fx.leadA.id }), PROJECT_A, {
        _action: "removeMember",
        membershipId: "pm-lead-b",
      });

      const row = await fx.db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.id, "pm-lead-b"))
        .get();
      expect(row).toBeTruthy();
    });

    it("still changes a role on a membership of this project", async () => {
      await runMembersAction(makeUserContext({ id: fx.leadA.id }), PROJECT_A, {
        _action: "changeMemberRole",
        membershipId: "pm-cat-a",
        role: "reviewer",
      });

      const row = await fx.db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.id, "pm-cat-a"))
        .get();
      expect(row!.role).toBe("reviewer");
    });
  });

  describe("api.workflow linkage", () => {
    async function runWorkflow(user: User, fields: Record<string, string>) {
      const { action } = await import("../../app/routes/api.workflow");
      return (await action({
        request: formRequest(fields),
        context: await buildContext(user, DEFAULT_TEST_TENANT_ID),
        params: {},
      } as any)) as any;
    }

    it("404s on a foreign volumeId sent with an own projectId", async () => {
      const response = await runWorkflow(makeUserContext({ id: fx.leadA.id }), {
        volumeId: "vol-b",
        projectId: PROJECT_A,
        targetStatus: "in_progress",
      });
      expect(response.status).toBe(404);

      const volB = await fx.db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.id, "vol-b"))
        .get();
      expect(volB!.status).toBe("unstarted");
    });

    it("404s on a foreign projectId before it reaches the volume", async () => {
      const status = await statusOf(() =>
        runWorkflow(makeUserContext({ id: fx.leadA.id }), {
          volumeId: "vol-b",
          projectId: PROJECT_B,
          targetStatus: "in_progress",
        }),
      );
      expect(status).toBe(404);
    });
  });

  describe("/projects/:id/volumes delete-volume linkage", () => {
    async function runVolumes(
      user: User,
      projectId: string,
      fields: Record<string, string>,
    ) {
      const { action } = await import(
        "../../app/routes/_auth.projects.$id.volumes"
      );
      return (await action({
        request: formRequest(fields),
        context: await buildContext(user, DEFAULT_TEST_TENANT_ID),
        params: { id: projectId },
      } as any)) as any;
    }

    it("404s when the volume belongs to another project, and deletes nothing", async () => {
      const status = await statusOf(() =>
        runVolumes(makeUserContext({ id: fx.leadA.id }), PROJECT_A, {
          _action: "delete-volume",
          volumeId: "vol-b",
        }),
      );
      expect(status).toBe(404);

      const volB = await fx.db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.id, "vol-b"))
        .get();
      expect(volB).toBeTruthy();
    });

    it("still deletes an unstarted volume of this project", async () => {
      const result = await runVolumes(
        makeUserContext({ id: fx.leadA.id }),
        PROJECT_A,
        { _action: "delete-volume", volumeId: "vol-a" },
      );
      expect(result.deleted).toBe(true);

      const volA = await fx.db
        .select()
        .from(schema.volumes)
        .where(eq(schema.volumes.id, "vol-a"))
        .get();
      expect(volA).toBeUndefined();
    });
  });
});
