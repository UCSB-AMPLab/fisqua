/**
 * Tests — the users area by area: the list and one person
 *
 * This suite pins what `/admin/users` and `/admin/users/:id` read, by
 * driving the two routes' loaders over seeded rows and the pure helpers
 * of `app/lib/users-area.server.ts` beside them. Five parts:
 *
 *   1. The badge mapping, one case per area and kind: what makes a
 *      person administer an area and what makes them work in it, and
 *      that an area the workspace does not have carries no badge.
 *   2. The list: badges from flags, federation memberships, project
 *      memberships and reviewer assignments; the search by name or
 *      email; the area filter; and nothing of another tenant's people.
 *   3. The federation table: people of other workspaces holding a
 *      membership in this workspace's federation, with their home
 *      workspace and their access here, and no one whose membership is
 *      in another federation. Their profiles stay read-only here: the
 *      detail loader 404s on them.
 *   4. The detail page's sections: each viewer gets exactly the
 *      sections they may see, and nothing is read for the others; the
 *      reviewed volumes and the access history are this tenant's only.
 *      The reviewed volumes' states match the Volumes screen's, and
 *      reading them takes the same statements however much other
 *      capture work the workspace holds. Without the Digitization area
 *      the list reads no reviewer assignments.
 *   5. The gate: a person who is not a workspace admin, user manager or
 *      super admin gets a 403 from both loaders, area admins included.
 *   6. The two pages rendered from their loaders' data: the legend, the
 *      badges and "No access yet"; the federation table without links;
 *      and on the detail page, every role flag in the roles form with
 *      the value shown beside it, and the federation pair posting one
 *      value. The grant and revoke cases are in
 *      `users-granting.test.ts`.
 *
 * Rendered cases use `renderToStaticMarkup` with an isolated i18next
 * instance over the real locale bundles, inside `createRoutesStub`, as
 * `tests/admin/users-reach.test.tsx` does.
 *
 * Every value here is a test value: no real tenant, volume or person.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { createRoutesStub, RouterContextProvider } from "react-router";
import resources from "../../app/locales";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { insertRow, seedReceivedVolumes, wrapD1 } from "../helpers/media-pipeline";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type Tenant,
  type User,
} from "../../app/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { applyGrantEffectiveRole } from "../../app/lib/federation.server";
import {
  accessBadges,
  workspaceAreas,
  type BadgeFacts,
  type UsersArea,
} from "../../app/lib/users-area.server";
import { loadCaptureVolumes, loadVolumeScreenStates } from "../../app/lib/capture/screens.server";
import UsersListPage, { loader as listLoader } from "../../app/routes/_auth.admin.users";
import UserDetailPage, { loader as detailLoader } from "../../app/routes/_auth.admin.users.$id";

type Db = ReturnType<typeof drizzle>;

const T0 = 1_800_000_000_000;

/** Every area on: the workspace has all seven. */
const allOn = (overrides: Partial<Tenant> = {}) =>
  makeTenantContext({
    crowdsourcingEnabled: true,
    authoritiesEnabled: true,
    digitizationEnabled: true,
    importsEnabled: true,
    ...overrides,
  });

function context(user: User, tenant: Tenant, db?: D1Database): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  ctx.set(impersonationContext, null);
  ctx.set(grantContext, null);
  (ctx as any).cloudflare = { env: db ? { ...env, DB: db } : env };
  return ctx;
}

async function list(user: User, tenant: Tenant, search = "") {
  return listLoader({
    request: new Request(`http://localhost/admin/users${search}`),
    context: context(user, tenant),
    params: {},
  } as any);
}

async function detail(user: User, tenant: Tenant, id: string, db?: D1Database) {
  return detailLoader({
    request: new Request(`http://localhost/admin/users/${id}`),
    context: context(user, tenant, db),
    params: { id },
  } as any);
}

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

async function seedUser(
  db: Db,
  name: string,
  flags: Partial<typeof schema.users.$inferInsert> = {},
  tenantId: string = DEFAULT_TEST_TENANT_ID,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.users).values({
    id,
    tenantId,
    email: `${name.toLowerCase().replace(/\s+/g, "-")}-${id.slice(0, 6)}@example.test`,
    name,
    createdAt: T0,
    updatedAt: T0,
    ...flags,
  });
  return id;
}

async function seedProject(db: Db, tenantId: string, ownerId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.projects).values({
    id,
    tenantId,
    name: `Project ${id.slice(0, 4)}`,
    createdBy: ownerId,
    createdAt: T0,
    updatedAt: T0,
  });
  return id;
}

async function membership(userId: string, federationId: string, role: "steward" | "staff") {
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: userId,
    federation_id: federationId,
    role,
    created_at: T0,
  });
}

async function review(tenantId: string, volumeId: string, reviewerId: string, by: string) {
  await insertRow("capture_qc_reviewers", {
    tenant_id: tenantId,
    pipeline_volume_id: volumeId,
    reviewer_id: reviewerId,
    assigned_by: by,
    assigned_at: T0,
  });
}

let seq = 0;

/** A delivery row as the registration writes it, by the file route. */
async function handover(
  tenantId: string,
  ref: string,
  volumeId: string | null,
  state: "registered" | "refused" = "registered",
): Promise<string> {
  const id = crypto.randomUUID();
  seq += 1;
  await insertRow("capture_deliveries", {
    tenant_id: tenantId,
    id,
    route: "file",
    scanner_id: null,
    reference_code: ref,
    pipeline_volume_id: volumeId,
    body_sha256: "a".repeat(64),
    state,
    problems: "[]",
    answer_status: state === "refused" ? 422 : 200,
    answer_body:
      state === "refused" ? JSON.stringify({ problems: [{ rule: "test", message: "Refused for a test" }] }) : "{}",
    records: state === "refused" ? null : "[]",
    openings: 4,
    received_at: T0,
    superseded_by: null,
    superseded_at: null,
    seq,
    write_id: null,
  });
  return id;
}

/** The decision set of a holding delivery, in the state its counts give. */
async function decisionSet(
  tenantId: string,
  deliveryId: string,
  volumeId: string,
  counts: { approved: number; rejected: number },
) {
  const state = counts.rejected > 0 ? "retakes_requested" : counts.approved === 4 ? "approved" : "in_capture_qc";
  await insertRow("capture_qc_sets", {
    tenant_id: tenantId,
    delivery_id: deliveryId,
    pipeline_volume_id: volumeId,
    decisions_id: crypto.randomUUID(),
    decided_at: T0,
    revision: 1,
    opening_count: 4,
    decided_count: counts.approved + counts.rejected,
    approved_count: counts.approved,
    rejected_count: counts.rejected,
    notes_bytes: 0,
    state,
    state_entered_at: T0,
    write_id: crypto.randomUUID(),
  });
}

/** A registered delivery holding the volume, with a decision set in capture QC. */
async function inCaptureQc(tenantId: string, volumeId: string, ref: string) {
  const id = await handover(tenantId, ref, volumeId);
  await decisionSet(tenantId, id, volumeId, { approved: 1, rejected: 0 });
}

const noFacts: BadgeFacts = {
  isAdmin: false,
  isSuperAdmin: false,
  isUserManager: false,
  isCollabAdmin: false,
  isCataloguer: false,
  isArchiveUser: false,
  isRecordsAdmin: false,
  isAuthoritiesAdmin: false,
  isImportsAdmin: false,
  isDigitizationAdmin: false,
  federationRole: null,
  projectCount: 0,
  reviewedVolumeCount: 0,
};

// ---------------------------------------------------------------------------
// 1. The badge mapping
// ---------------------------------------------------------------------------

/** The five workspace areas, administered: what a workspace admin or super admin passes. */
const EVERY_AREA: Array<[UsersArea, "administers"]> = [
  ["records", "administers"],
  ["authorities", "administers"],
  ["cataloguing", "administers"],
  ["digitization", "administers"],
  ["imports", "administers"],
];
const EVERY_AREA_BADGES = EVERY_AREA.map(([area, kind]) => `${area}:${kind}`);

describe("badge mapping", () => {
  const areas = workspaceAreas(allOn());
  const cases: Array<[string, Partial<BadgeFacts>, Array<[UsersArea, "administers" | "works"]>]> = [
    ["super admin", { isSuperAdmin: true }, [["platform", "administers"], ...EVERY_AREA]],
    ["user manager", { isUserManager: true }, [["platform", "administers"]]],
    ["steward", { federationRole: "steward" }, [["federation", "administers"]]],
    ["staff", { federationRole: "staff" }, [["federation", "works"]]],
    ["workspace admin", { isAdmin: true }, EVERY_AREA],
    ["records admin", { isRecordsAdmin: true }, [["records", "administers"]]],
    ["Reader", { isArchiveUser: true }, [["records", "works"]]],
    ["authorities admin", { isAuthoritiesAdmin: true }, [["authorities", "administers"]]],
    ["cataloguing admin", { isCollabAdmin: true }, [["cataloguing", "administers"]]],
    ["cataloguer", { isCataloguer: true }, [["cataloguing", "works"]]],
    ["project member", { projectCount: 2 }, [["cataloguing", "works"]]],
    ["digitization admin", { isDigitizationAdmin: true }, [["digitization", "administers"]]],
    ["capture reviewer", { reviewedVolumeCount: 1 }, [["digitization", "works"]]],
    ["imports admin", { isImportsAdmin: true }, [["imports", "administers"]]],
    ["no one", {}, []],
  ];
  for (const [label, facts, expected] of cases) {
    it(`${label}`, () => {
      const badges = accessBadges({ ...noFacts, ...facts }, areas);
      expect(badges.map((b) => [b.area, b.kind])).toEqual(expected);
    });
  }

  it("shows administers when a person qualifies both ways", () => {
    const badges = accessBadges({ ...noFacts, isCollabAdmin: true, isCataloguer: true, projectCount: 1 }, areas);
    expect(badges).toEqual([{ area: "cataloguing", kind: "administers" }]);
  });

  it("badges no area the workspace does not have", () => {
    const off = workspaceAreas(
      allOn({ crowdsourcingEnabled: false, digitizationEnabled: false, importsEnabled: false, authoritiesEnabled: false }),
    );
    expect(off).toEqual(["platform", "federation", "records"]);
    const badges = accessBadges(
      { ...noFacts, isCataloguer: true, isDigitizationAdmin: true, isImportsAdmin: true, isAuthoritiesAdmin: true },
      off,
    );
    expect(badges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2–3. The list and the federation table
// ---------------------------------------------------------------------------

describe("users list", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  let ids: Record<string, string>;
  let viewer: User;

  beforeEach(async () => {
    await cleanDatabase();
    const db = drizzle(env.DB);
    ids = {
      admin: await seedUser(db, "Ana Admin", { isAdmin: true }),
      records: await seedUser(db, "Rita Records", { isRecordsAdmin: true }),
      reader: await seedUser(db, "Rafa Reader", { isArchiveUser: true }),
      collab: await seedUser(db, "Carla Collab", { isCollabAdmin: true }),
      member: await seedUser(db, "Mateo Member"),
      digit: await seedUser(db, "Dora Digit", { isDigitizationAdmin: true }),
      reviewer: await seedUser(db, "Raul Reviewer"),
      imports: await seedUser(db, "Ines Imports", { isImportsAdmin: true }),
      superAdmin: await seedUser(db, "Sara Super", { isSuperAdmin: true }),
      steward: await seedUser(db, "Esteban Steward"),
      nobody: await seedUser(db, "Nadia Nobody"),
      // Other workspaces.
      foreignLocal: await seedUser(db, "Fabio Foreign", { isAdmin: true }, SECOND_TEST_TENANT_ID),
      fedStaff: await seedUser(db, "Fede Staff", { isAdmin: true }, SECOND_TEST_TENANT_ID),
      otherFed: await seedUser(db, "Olga Other", {}, SECOND_TEST_TENANT_ID),
    };
    viewer = makeUserContext({ id: ids.admin, isAdmin: true });

    const project = await seedProject(db, DEFAULT_TEST_TENANT_ID, ids.admin);
    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId: project,
      userId: ids.member,
      role: "cataloguer",
      createdAt: Math.floor(T0 / 1000),
    });
    // A membership in another tenant's project ties no one to this one.
    const foreignProject = await seedProject(db, SECOND_TEST_TENANT_ID, ids.foreignLocal);
    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId: foreignProject,
      userId: ids.nobody,
      role: "lead",
      createdAt: Math.floor(T0 / 1000),
    });

    const seeded = await seedReceivedVolumes({ tenantId: DEFAULT_TEST_TENANT_ID, count: 2, userId: ids.admin });
    await review(DEFAULT_TEST_TENANT_ID, seeded.volumes[0].id, ids.reviewer, ids.admin);
    await review(DEFAULT_TEST_TENANT_ID, seeded.volumes[1].id, ids.fedStaff, ids.admin);

    await membership(ids.steward, DEFAULT_TEST_FEDERATION_ID, "steward");
    await membership(ids.fedStaff, DEFAULT_TEST_FEDERATION_ID, "staff");
    await membership(ids.otherFed, SECOND_TEST_FEDERATION_ID, "steward");
  });

  it("badges each person of the workspace by area", async () => {
    const data = await list(viewer, allOn());
    const byId = new Map(data.people.map((p) => [p.id, p.badges.map((b) => `${b.area}:${b.kind}`)]));
    expect(byId.get(ids.admin)).toEqual(EVERY_AREA_BADGES);
    expect(byId.get(ids.records)).toEqual(["records:administers"]);
    expect(byId.get(ids.reader)).toEqual(["records:works"]);
    expect(byId.get(ids.collab)).toEqual(["cataloguing:administers"]);
    expect(byId.get(ids.member)).toEqual(["cataloguing:works"]);
    expect(byId.get(ids.digit)).toEqual(["digitization:administers"]);
    expect(byId.get(ids.reviewer)).toEqual(["digitization:works"]);
    expect(byId.get(ids.imports)).toEqual(["imports:administers"]);
    expect(byId.get(ids.superAdmin)).toEqual(["platform:administers", ...EVERY_AREA_BADGES]);
    expect(byId.get(ids.steward)).toEqual(["federation:administers"]);
    expect(byId.get(ids.nobody)).toEqual([]);
    expect(data.peopleCount).toBe(11);
    expect(data.workspaceName).toBe("Neogranadina");
  });

  it("lists no one from another tenant among the workspace's people", async () => {
    const data = await list(viewer, allOn());
    const listed = new Set(data.people.map((p) => p.id));
    for (const id of [ids.foreignLocal, ids.fedStaff, ids.otherFed]) expect(listed.has(id)).toBe(false);
  });

  it("searches by name and by email", async () => {
    const byName = await list(viewer, allOn(), "?q=rita");
    expect(byName.people.map((p) => p.id)).toEqual([ids.records]);
    const byEmail = await list(viewer, allOn(), "?q=dora-digit");
    expect(byEmail.people.map((p) => p.id)).toEqual([ids.digit]);
    expect(byEmail.peopleCount).toBe(11);
  });

  it("filters by area, both kinds of badge", async () => {
    const data = await list(viewer, allOn(), "?area=digitization");
    expect(new Set(data.people.map((p) => p.id))).toEqual(
      new Set([ids.digit, ids.reviewer, ids.admin, ids.superAdmin]),
    );
    expect(data.area).toBe("digitization");
    const unknown = await list(viewer, allOn(), "?area=nonsense");
    expect(unknown.area).toBeNull();
    expect(unknown.people).toHaveLength(11);
  });

  it("offers only the areas the workspace has", async () => {
    const data = await list(viewer, allOn({ digitizationEnabled: false, importsEnabled: false }));
    expect(data.areas).toEqual(["platform", "federation", "records", "authorities", "cataloguing"]);
    const byId = new Map(data.people.map((p) => [p.id, p.badges]));
    expect(byId.get(ids.digit)).toEqual([]);
    expect(byId.get(ids.reviewer)).toEqual([]);
  });

  it("lists the federation's people from other workspaces, and no one from another federation", async () => {
    const data = await list(viewer, allOn());
    expect(data.federationPeopleCount).toBe(1);
    expect(data.federationPeople).toEqual([
      {
        id: ids.fedStaff,
        name: "Fede Staff",
        homeWorkspace: "Second Test Tenant",
        federationRole: "staff",
        reviewedVolumeCount: 1,
        badges: [
          { area: "federation", kind: "works" },
          { area: "digitization", kind: "works" },
        ],
      },
    ]);
    // Their home workspace admin flag says nothing about this one.
    expect(data.federationPeople[0].badges.some((b) => b.area === "records")).toBe(false);
    // The search and the filter apply to the federation table too.
    expect((await list(viewer, allOn(), "?q=nadia")).federationPeople).toEqual([]);
    expect((await list(viewer, allOn(), "?area=imports")).federationPeople).toEqual([]);
  });

  it("reads no reviewer assignments when the workspace has no Digitization area", async () => {
    const data = await list(viewer, allOn({ digitizationEnabled: false }));
    expect(data.federationPeople).toEqual([
      {
        id: ids.fedStaff,
        name: "Fede Staff",
        homeWorkspace: "Second Test Tenant",
        federationRole: "staff",
        reviewedVolumeCount: 0,
        badges: [{ area: "federation", kind: "works" }],
      },
    ]);
  });

  it("keeps a federation member's profile read-only here: the detail page 404s", async () => {
    expect(await status(detail(viewer, allOn(), ids.fedStaff))).toBe(404);
  });

  it("serves the second tenant's own people on its host, and none of the first's", async () => {
    const second = makeTenantContext({
      id: SECOND_TEST_TENANT_ID,
      slug: "second-tenant",
      name: "Second Test Tenant",
      federationId: SECOND_TEST_FEDERATION_ID,
      // As seeded: crowdsourcing off.
      crowdsourcingEnabled: false,
    });
    const data = await list(makeUserContext({ id: ids.foreignLocal, isAdmin: true, tenantId: SECOND_TEST_TENANT_ID }), second);
    expect(new Set(data.people.map((p) => p.id))).toEqual(new Set([ids.foreignLocal, ids.fedStaff, ids.otherFed]));
    // Olga's steward membership is in this federation, but she is at home here.
    expect(data.federationPeople).toEqual([]);
    // At home Fede is the workspace admin of a tenant with only the
    // Records and Authorities areas (crowdsourcing, digitization and
    // imports off), so those two; the volume Fede reviews is the first
    // tenant's.
    expect(data.people.find((p) => p.id === ids.fedStaff)!.badges).toEqual([
      { area: "records", kind: "administers" },
      { area: "authorities", kind: "administers" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The detail page's sections
// ---------------------------------------------------------------------------

describe("user detail sections", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  let targetId: string;
  let targetEmail: string;
  let adminId: string;
  let volumeRef: string;

  beforeEach(async () => {
    await cleanDatabase();
    const db = drizzle(env.DB);
    adminId = await seedUser(db, "Ana Admin", { isAdmin: true });
    targetId = await seedUser(db, "Tomas Target", {
      isRecordsAdmin: true,
      isCataloguer: true,
      isDigitizationAdmin: true,
    });
    targetEmail = (await db.select().from(schema.users).all()).find((u) => u.id === targetId)!.email;
    await membership(targetId, DEFAULT_TEST_FEDERATION_ID, "staff");

    const seeded = await seedReceivedVolumes({ tenantId: DEFAULT_TEST_TENANT_ID, count: 1, userId: adminId });
    volumeRef = seeded.volumes[0].referenceCode;
    await review(DEFAULT_TEST_TENANT_ID, seeded.volumes[0].id, targetId, adminId);
    await inCaptureQc(DEFAULT_TEST_TENANT_ID, seeded.volumes[0].id, volumeRef);
    // A volume of another tenant the same person reviews stays there.
    const foreign = await seedReceivedVolumes({ tenantId: SECOND_TEST_TENANT_ID, count: 1 });
    await review(SECOND_TEST_TENANT_ID, foreign.volumes[0].id, targetId, foreign.userId);

    // The workspace's creation, with this person as its first admin,
    // and another workspace's creation with the same email.
    for (const [tenantId, email] of [
      [DEFAULT_TEST_TENANT_ID, targetEmail],
      [SECOND_TEST_TENANT_ID, targetEmail],
      [DEFAULT_TEST_TENANT_ID, "someone-else@example.test"],
    ]) {
      await insertRow("audit_log", {
        id: crypto.randomUUID(),
        created_at: T0,
        actor_user_id: null,
        actor_user_id_text: "operator@example.test",
        actor_tenant_id: PLATFORM_TENANT_ID,
        action: "create_tenant",
        target_tenant_id: tenantId,
        target_object_kind: "tenant",
        target_object_id: tenantId,
        impersonation_session_id: null,
        details: JSON.stringify({ slug: "x", bootstrap_email: email }),
      });
    }
  });

  it("shows a super admin every section, with the person's state in each", async () => {
    const data = await detail(makeUserContext({ isSuperAdmin: true }), allOn(), targetId);
    expect(data.sections).toEqual([
      "platform",
      "federation",
      "records",
      "authorities",
      "cataloguing",
      "digitization",
      "imports",
    ]);
    const checked = (area: UsersArea) =>
      (data.roles[area] ?? []).filter((r) => r.checked).map((r) => r.key);
    expect(checked("platform")).toEqual([]);
    expect(checked("federation")).toEqual(["staff"]);
    expect(checked("records")).toEqual(["records_admin"]);
    expect(checked("cataloguing")).toEqual(["cataloguer"]);
    expect(checked("digitization")).toEqual(["digitization_admin"]);
    // Every role flag carries its field; the federation pair posts one
    // value of its own.
    expect(data.roles.federation!.every((r) => r.field === null)).toBe(true);
    expect(data.roles.records!.map((r) => r.field)).toEqual(["isAdmin", "isRecordsAdmin", "isArchiveUser"]);
    expect(data.roles.authorities!.map((r) => r.field)).toEqual(["isAuthoritiesAdmin"]);
    expect(data.roles.digitization!.map((r) => r.field)).toEqual(["isDigitizationAdmin"]);
    expect(data.roles.imports!.map((r) => r.field)).toEqual(["isImportsAdmin"]);
  });

  it("shows a workspace admin of a member workspace the areas but not Platform or Federation", async () => {
    // The tenant's federation is led by another tenant, so a workspace
    // admin here is no steward of it.
    const member = allOn({ federationId: SECOND_TEST_FEDERATION_ID });
    const data = await detail(makeUserContext({ id: adminId, isAdmin: true }), member, targetId);
    expect(data.sections).toEqual(["records", "authorities", "cataloguing", "digitization", "imports"]);
    expect(data.roles.platform).toBeUndefined();
    expect(data.federation).toBeNull();
  });

  it("shows a steward through a grant the Federation section", async () => {
    const db = drizzle(env.DB);
    const stewardId = await seedUser(db, "Sofia Steward", {}, SECOND_TEST_TENANT_ID);
    await membership(stewardId, DEFAULT_TEST_FEDERATION_ID, "steward");
    const viewer = applyGrantEffectiveRole(
      makeUserContext({ id: stewardId, tenantId: SECOND_TEST_TENANT_ID }),
      { role: "steward", federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID },
    );
    const data = await detail(viewer, allOn(), targetId);
    expect(data.sections).toContain("federation");
    expect(data.federation).toEqual({ name: expect.any(String), role: "staff" });
  });

  it("shows a user manager Platform and Cataloguing and reads nothing for the rest", async () => {
    const data = await detail(makeUserContext({ isUserManager: true }), allOn(), targetId);
    expect(data.sections).toEqual(["platform", "cataloguing"]);
    expect(Object.keys(data.roles).sort()).toEqual(["cataloguing", "platform"]);
    expect(data.federation).toBeNull();
    expect(data.reviewedVolumes).toBeNull();
    expect((data.targetUser as Record<string, unknown>).isRecordsAdmin).toBeUndefined();
  });

  it("leaves out the sections of areas the workspace does not have", async () => {
    const data = await detail(
      makeUserContext({ isSuperAdmin: true }),
      allOn({ crowdsourcingEnabled: false, digitizationEnabled: false }),
      targetId,
    );
    expect(data.sections).not.toContain("cataloguing");
    expect(data.sections).not.toContain("digitization");
    expect(data.memberships).toEqual([]);
    expect(data.reviewedVolumes).toBeNull();
  });

  it("lists the volumes the person reviews here, with their state, and none of another tenant's", async () => {
    const data = await detail(makeUserContext({ isSuperAdmin: true }), allOn(), targetId);
    expect(data.reviewedVolumes).toEqual([
      { volumeId: expect.any(String), referenceCode: volumeRef, state: "in_capture_qc" },
    ]);
  });

  it("reads the reviewed volumes' states without reading the rest of the workspace's capture work", async () => {
    // Statements the detail loader runs, with a few other handovers in
    // the workspace and then with many more, refused ones among them
    // (each of which the Volumes screen reads a problem for).
    const statements = async () => {
      const seen: string[] = [];
      const db = wrapD1(env.DB, { before: (q) => seen.push(q) });
      const data = await detail(makeUserContext({ isSuperAdmin: true }), allOn(), targetId, db);
      expect(data.reviewedVolumes).toEqual([
        { volumeId: expect.any(String), referenceCode: volumeRef, state: "in_capture_qc" },
      ]);
      return seen;
    };
    const others = async (n: number) => {
      const seeded = await seedReceivedVolumes({ tenantId: DEFAULT_TEST_TENANT_ID, count: n, userId: adminId });
      for (const v of seeded.volumes) {
        await inCaptureQc(DEFAULT_TEST_TENANT_ID, v.id, v.referenceCode);
        await handover(DEFAULT_TEST_TENANT_ID, `${v.referenceCode}-refused`, null, "refused");
      }
    };
    await others(2);
    const few = await statements();
    await others(20);
    const many = await statements();
    expect(many.length).toBe(few.length);
    // No problem details and no reviewer names are read.
    for (const q of many) {
      expect(q).not.toMatch(/"problems"|"answer_body"|from "capture_qc_reviewers" inner join "users"/);
    }
  });

  it("gives the same state for a volume as the Volumes screen does", async () => {
    const db = drizzle(env.DB);
    const seeded = await seedReceivedVolumes({ tenantId: DEFAULT_TEST_TENANT_ID, count: 4, userId: adminId });
    const [undecided, qc, retakes, approved] = seeded.volumes;
    await handover(DEFAULT_TEST_TENANT_ID, undecided.referenceCode, undecided.id);
    for (const [v, counts] of [
      [qc, { approved: 2, rejected: 0 }],
      [retakes, { approved: 2, rejected: 1 }],
      [approved, { approved: 4, rejected: 0 }],
    ] as const) {
      const id = await handover(DEFAULT_TEST_TENANT_ID, v.referenceCode, v.id);
      await decisionSet(DEFAULT_TEST_TENANT_ID, id, v.id, counts);
    }
    const ids = seeded.volumes.map((v) => v.id);
    const scoped = await loadVolumeScreenStates(db, DEFAULT_TEST_TENANT_ID, ids, T0);
    const screen = await loadCaptureVolumes(db, DEFAULT_TEST_TENANT_ID, T0);
    const fromScreen = new Map(
      screen.filter((r) => r.volumeId && ids.includes(r.volumeId)).map((r) => [r.volumeId, r.state]),
    );
    expect(new Map(scoped)).toEqual(fromScreen);
    // A registered handover with no decisions yet is in capture QC too.
    expect([...scoped.values()].sort()).toEqual(["approved", "in_capture_qc", "in_capture_qc", "retakes_requested"]);
  });

  it("reads the access history from this workspace's audit entries about this person", async () => {
    const data = await detail(makeUserContext({ isSuperAdmin: true }), allOn(), targetId);
    // The creation's two grants, by the operator who created it.
    expect(data.history).toEqual([
      { kind: "role_granted", at: T0, role: "workspace_admin", actor: "operator@example.test" },
      { kind: "role_granted", at: T0, role: "super_admin", actor: "operator@example.test" },
    ]);
    // A workspace admin of a member workspace sees no Platform section,
    // so not the super admin grant.
    const member = allOn({ federationId: SECOND_TEST_FEDERATION_ID });
    const seen = await detail(makeUserContext({ id: adminId, isAdmin: true }), member, targetId);
    expect(seen.history).toEqual([
      { kind: "role_granted", at: T0, role: "workspace_admin", actor: "operator@example.test" },
    ]);
  });

  it("404s a person of another tenant", async () => {
    const db = drizzle(env.DB);
    const foreign = await seedUser(db, "Fabio Foreign", {}, SECOND_TEST_TENANT_ID);
    expect(await status(detail(makeUserContext({ isSuperAdmin: true }), allOn(), foreign))).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5. The gate
// ---------------------------------------------------------------------------

describe("users area gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  const refused: Array<[string, Partial<User>]> = [
    ["a plain member", {}],
    ["a Reader", { isArchiveUser: true }],
    ["a cataloguing admin", { isCollabAdmin: true }],
    ["a records admin", { isRecordsAdmin: true }],
    ["an authorities admin", { isAuthoritiesAdmin: true }],
    ["an imports admin", { isImportsAdmin: true }],
    ["a digitization admin", { isDigitizationAdmin: true }],
  ];

  for (const [label, flags] of refused) {
    it(`refuses ${label} on the list and the detail page`, async () => {
      const db = drizzle(env.DB);
      const target = await seedUser(db, "Tomas Target");
      const viewer = makeUserContext(flags);
      expect(await status(list(viewer, allOn()))).toBe(403);
      expect(await status(detail(viewer, allOn(), target))).toBe(403);
    });
  }

  it("refuses a federation staff grant", async () => {
    const db = drizzle(env.DB);
    const target = await seedUser(db, "Tomas Target");
    const viewer = applyGrantEffectiveRole(makeUserContext({ tenantId: SECOND_TEST_TENANT_ID }), {
      role: "staff",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      homeTenantId: SECOND_TEST_TENANT_ID,
    });
    expect(await status(list(viewer, allOn()))).toBe(403);
    expect(await status(detail(viewer, allOn(), target))).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 6. The pages as rendered
// ---------------------------------------------------------------------------

async function render(path: string, element: () => React.ReactElement): Promise<string> {
  const inst = i18next.createInstance();
  await (inst.init as (opts: unknown) => Promise<unknown>)({
    lng: "en",
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  const Stub = createRoutesStub([{ path, Component: element }]);
  return renderToStaticMarkup(
    React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(Stub, { initialEntries: [path] }),
    ),
  );
}

describe("users area pages as rendered", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("renders the list with its legend, badges and the federation table", async () => {
    const db = drizzle(env.DB);
    const adminId = await seedUser(db, "Ana Admin", { isAdmin: true });
    await seedUser(db, "Rafa Reader", { isArchiveUser: true });
    await seedUser(db, "Nadia Nobody");
    const staffId = await seedUser(db, "Fede Staff", {}, SECOND_TEST_TENANT_ID);
    await membership(staffId, DEFAULT_TEST_FEDERATION_ID, "staff");
    const loaderData = await list(makeUserContext({ id: adminId, isAdmin: true }), allOn());

    const html = await render("/admin/users", () =>
      React.createElement(UsersListPage as React.ComponentType<any>, { loaderData, params: {}, matches: [] }),
    );
    expect(html).toContain("Neogranadina · 3 people in this workspace, 1 from");
    expect(html).toContain("administers the area");
    expect(html).toContain("works in the area");
    expect(html).toContain("Records management");
    expect(html).toContain(">Reader<");
    expect(html).toContain("No access yet");
    expect(html).toContain(`href="/admin/users/${adminId}"`);
    expect(html).toContain("Second Test Tenant");
    expect(html).toContain("Federation staff");
    expect(html).not.toContain(`href="/admin/users/${staffId}"`);
    // The badge's kind is in its text, not only in its colour.
    expect(html).toMatch(
      /title="administers the area">Records management<span class="sr-only">, administers the area<\/span><\/span>/,
    );
    expect(html).toMatch(/title="works in the area">Reader<span class="sr-only">, works in the area<\/span><\/span>/);
    expect(html).toMatch(
      /title="works in the area">Federation staff<span class="sr-only">, works in the area<\/span><\/span>/,
    );
    expect(html).toContain('<label for="users-q"');
    expect(html).toContain('<label for="users-area"');
  });

  it("renders the detail page with every role flag in the roles form", async () => {
    const db = drizzle(env.DB);
    const targetId = await seedUser(db, "Tomas Target", { isRecordsAdmin: true, isAdmin: true });
    const loaderData = await detail(makeUserContext({ isSuperAdmin: true }), allOn(), targetId);

    const html = await render(`/admin/users/${targetId}`, () =>
      React.createElement(UserDetailPage as React.ComponentType<any>, {
        loaderData,
        params: { id: targetId },
        matches: [],
      }),
    );
    for (const heading of ["Profile", "Platform", "Federation", "Records management", "Authorities", "Cataloguing", "Digitization", "Imports and exports", "Access history"]) {
      expect(html).toContain(`>${heading}</h2>`);
    }
    expect(html).toContain("Reviewers are assigned on the Capture QC screen.");
    expect(html).toContain('id="user-roles"');
    const inputs = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    // The ten role flags: named, in the roles form, live for a super
    // admin, each with the value the page showed beside it.
    const named = inputs.filter((i) => i.includes("name="));
    expect(named).toHaveLength(10);
    for (const i of named) {
      expect(i).toContain('form="user-roles"');
      expect(i).not.toContain("disabled");
    }
    expect(named.find((i) => i.includes('name="isRecordsAdmin"'))).toContain('checked=""');
    expect(html).toContain('form="user-roles" name="shown_isRecordsAdmin" value="1"');
    expect(html).toContain('form="user-roles" name="shown_isImportsAdmin" value="0"');
    // The federation pair joins no form; it posts one value, with the
    // value shown, from the roles form. A super admin at home on the
    // lead workspace may change both.
    const unnamed = inputs.filter((i) => !i.includes("name="));
    expect(unnamed).toHaveLength(2);
    for (const i of unnamed) {
      expect(i).not.toContain("form=");
      expect(i).not.toContain("disabled");
    }
    expect(html).toContain('name="federationRole" value="none"');
    expect(html).toContain('name="federationRoleShown" value="none"');
  });
});

// @version v0.8.0
