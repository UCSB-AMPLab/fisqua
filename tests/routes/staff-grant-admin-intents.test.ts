/**
 * Tests — the administrative intents inside the working areas
 *
 * This suite pins that the administrative intents inside the working areas
 * stay with the areas' admins. A federation `staff` grant opens the
 * actions of the records, authorities and imports areas
 * (`requireAreaWork`), but some intents of those actions publish, delete
 * or undo material, and those stay with the area's admins (`requireArea`).
 * The suite posts each such intent as a staff grant and as a workspace
 * admin, and pins:
 *
 *   - publishing or unpublishing a description (`toggle_publish`):
 *     refused to staff with the record unchanged, flipped for an admin;
 *   - deleting a description from its page and from the Descriptions
 *     screen, an entity, a place and a repository: refused to staff with
 *     the record still there, let past the gate for an admin; deleting
 *     a vocabulary term, which only a super admin may, refused to staff;
 *   - reverting an import run: refused to staff, let past the gate for
 *     an admin.
 *
 * Every value here is a test value: no real tenant, record or person.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createGrantUser, createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type GrantState,
  type User,
} from "../../app/context";
import { action as descriptionAction } from "../../app/routes/_auth.admin.descriptions.$id";
import { action as descriptionsAction } from "../../app/routes/_auth.admin.descriptions";
import { action as entityAction } from "../../app/routes/_auth.admin.entities.$id";
import { action as placeAction } from "../../app/routes/_auth.admin.places.$id";
import { action as repositoryAction } from "../../app/routes/_auth.admin.repositories.$id";
import { action as enumsAction } from "../../app/routes/_auth.admin.vocabularies.enums";
import { action as runAction } from "../../app/routes/_auth.admin.imports.runs.$runId";

const HOST = "https://neogranadina.fisqua.test";
const STAFF_GRANT: GrantState = {
  role: "staff",
  federationId: DEFAULT_TEST_FEDERATION_ID,
  homeTenantId: SECOND_TEST_TENANT_ID,
};

let staff: User;
let admin: User;
let repositoryId: string;

function context(user: User, grant: GrantState | null): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ importsEnabled: true }));
  ctx.set(grantContext, grant);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env };
  return ctx;
}

function post(
  run: (args: any) => unknown,
  path: string,
  form: Record<string, string>,
  user: User,
  grant: GrantState | null,
  params: Record<string, string> = {},
) {
  const body = new URLSearchParams(form);
  return run({
    request: new Request(`${HOST}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }),
    context: context(user, grant),
    params,
  });
}

async function status(p: unknown): Promise<number> {
  try {
    const value: any = await p;
    return value instanceof Response ? value.status : 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

const asStaff = (run: (args: any) => unknown, path: string, form: Record<string, string>, params?: Record<string, string>) =>
  status(post(run, path, form, staff, STAFF_GRANT, params));
const asAdmin = (run: (args: any) => unknown, path: string, form: Record<string, string>, params?: Record<string, string>) =>
  status(post(run, path, form, admin, null, params));

async function exists(table: string, id: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 AS one FROM ${table} WHERE id = ?`).bind(id).first()) !== null;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  staff = await createGrantUser("staff", { name: "Test Staff" });
  const row = await createTestUser({ isAdmin: true, name: "Test Admin" });
  admin = makeUserContext({ id: row.id, email: row.email, name: row.name, isAdmin: true });
  repositoryId = (await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: "repo-intents" })).id;
});

describe("publishing a description", () => {
  it("is refused to a staff grant, leaving the record unpublished, and flips it for an admin", async () => {
    const desc = await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId, isPublished: false });
    const path = `/admin/descriptions/${desc.id}`;
    expect(await asStaff(descriptionAction, path, { _action: "toggle_publish" }, { id: desc.id })).toBe(403);
    const before = await env.DB.prepare("SELECT is_published FROM descriptions WHERE id = ?").bind(desc.id).first<{ is_published: number }>();
    expect(before!.is_published).toBe(0);
    expect(await asAdmin(descriptionAction, path, { _action: "toggle_publish" }, { id: desc.id })).toBe(200);
    const after = await env.DB.prepare("SELECT is_published FROM descriptions WHERE id = ?").bind(desc.id).first<{ is_published: number }>();
    expect(after!.is_published).toBe(1);
  });
});

describe("deleting material", () => {
  it("refuses a staff grant the delete of a description from its page and from the Descriptions screen", async () => {
    const desc = await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId });
    expect(await asStaff(descriptionAction, `/admin/descriptions/${desc.id}`, { _action: "delete" }, { id: desc.id })).toBe(403);
    expect(await asStaff(descriptionsAction, "/admin/descriptions", { _action: "delete", descriptionId: desc.id })).toBe(403);
    expect(await exists("descriptions", desc.id)).toBe(true);
    expect(await asAdmin(descriptionsAction, "/admin/descriptions", { _action: "delete", descriptionId: desc.id })).not.toBe(403);
  });

  it("refuses a staff grant the delete of an entity and a place, and lets an admin past the gate", async () => {
    const entity = await createTestEntity({ federationId: DEFAULT_TEST_FEDERATION_ID });
    const place = await createTestPlace({ federationId: DEFAULT_TEST_FEDERATION_ID });
    expect(await asStaff(entityAction, `/admin/entities/${entity.id}`, { _action: "delete" }, { id: entity.id })).toBe(403);
    expect(await asStaff(placeAction, `/admin/places/${place.id}`, { _action: "delete" }, { id: place.id })).toBe(403);
    expect(await exists("entities", entity.id)).toBe(true);
    expect(await exists("places", place.id)).toBe(true);
    expect(await asAdmin(entityAction, `/admin/entities/${entity.id}`, { _action: "delete" }, { id: entity.id })).not.toBe(403);
    expect(await asAdmin(placeAction, `/admin/places/${place.id}`, { _action: "delete" }, { id: place.id })).not.toBe(403);
  });

  it("refuses a staff grant the delete of a repository and of a vocabulary term", async () => {
    const extra = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: "repo-extra" });
    expect(await asStaff(repositoryAction, `/admin/repositories/${extra.id}`, { _action: "delete" }, { id: extra.id })).toBe(403);
    expect(await exists("repositories", extra.id)).toBe(true);
    expect(await asAdmin(repositoryAction, `/admin/repositories/${extra.id}`, { _action: "delete" }, { id: extra.id })).not.toBe(403);
    // Every vocabulary-term change is a super admin's already.
    const term = { _action: "delete-term", vocabKey: "resource_type", value: "test-term", count: "0" };
    expect(await asStaff(enumsAction, "/admin/vocabularies/enums", term)).toBe(403);
  });
});

describe("undoing an import", () => {
  it("refuses a staff grant the revert of a run, and lets an admin past the gate", async () => {
    const params = { runId: "no-such-run" };
    expect(await asStaff(runAction, "/admin/imports/runs/no-such-run", { intent: "revert" }, params)).toBe(403);
    expect(await asAdmin(runAction, "/admin/imports/runs/no-such-run", { intent: "revert" }, params)).toBe(404);
  });
});

// @version v0.9.0
