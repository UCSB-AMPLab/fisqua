/**
 * Tests — what a federation staff grant opens outside Digitization
 *
 * This suite pins what a federation staff grant opens outside
 * Digitization. A federation `staff` grant lets its holder do the work of
 * every area of a member workspace without administering it
 * (`canWorkInArea`). The Digitization screens are pinned in
 * `tests/capture/`; this suite calls the loaders of the other working
 * areas, and of the administration surfaces, with the effective user the
 * auth middleware hands over under a staff grant (`createGrantUser`). It
 * pins:
 *
 *   - the working areas: Descriptions and the vocabulary hub (records),
 *     Entities and Places (authorities), and Imports open to a staff
 *     grant as they do to a workspace admin;
 *   - the administration surfaces stay shut: the users area and a
 *     person's page (users and roles), New project, and the publish
 *     screen, which shows a staff grant nothing it may act on;
 *   - a member of the workspace with no area flag is not let into any
 *     working area by this change.
 *
 * Every value here is a test value: no real tenant or person.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, seedFederations } from "../helpers/db";
import { createGrantUser, createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type GrantState,
  type Tenant,
  type User,
} from "../../app/context";
import { DEFAULT_TEST_FEDERATION_ID, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { loader as descriptionsLoader } from "../../app/routes/_auth.admin.descriptions";
import { loader as vocabulariesLoader } from "../../app/routes/_auth.admin.vocabularies";
import { loader as entitiesLoader } from "../../app/routes/_auth.admin.entities";
import { loader as placesLoader } from "../../app/routes/_auth.admin.places";
import { loader as importsLoader } from "../../app/routes/_auth.admin.imports";
import { loader as usersLoader } from "../../app/routes/_auth.admin.users";
import { loader as userLoader } from "../../app/routes/_auth.admin.users.$id";
import { loader as newProjectLoader } from "../../app/routes/_auth.projects.new";
import { loader as publishLoader } from "../../app/routes/_auth.admin.publish";

const HOST = "https://neogranadina.fisqua.test";

const STAFF_GRANT: GrantState = {
  role: "staff",
  federationId: DEFAULT_TEST_FEDERATION_ID,
  homeTenantId: SECOND_TEST_TENANT_ID,
};

function context(user: User, tenant: Tenant, grant: GrantState | null = null): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  ctx.set(grantContext, grant);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function status(p: Promise<unknown> | unknown): Promise<number> {
  try {
    const value: any = await p;
    return value instanceof Response ? value.status : 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

const tenant = () => makeTenantContext({ importsEnabled: true });

function call(loader: (args: any) => unknown, path: string, user: User, grant: GrantState | null, params: Record<string, string> = {}) {
  return loader({ request: new Request(`${HOST}${path}`), context: context(user, tenant(), grant), params });
}

const WORKING: Array<[string, (args: any) => unknown, string]> = [
  ["Descriptions", descriptionsLoader, "/admin/descriptions"],
  ["the vocabulary hub", vocabulariesLoader, "/admin/vocabularies"],
  ["Entities", entitiesLoader, "/admin/entities"],
  ["Places", placesLoader, "/admin/places"],
  ["Imports", importsLoader, "/admin/imports"],
];

let staff: User;
let admin: User;
let member: User;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  staff = await createGrantUser("staff", { name: "Test Staff" });
  const adminRow = await createTestUser({ isAdmin: true, name: "Test Admin" });
  admin = makeUserContext({ id: adminRow.id, email: adminRow.email, name: adminRow.name, isAdmin: true });
  const memberRow = await createTestUser({ name: "Test Member" });
  member = makeUserContext({ id: memberRow.id, email: memberRow.email, name: memberRow.name, isCataloguer: true });
});

describe("a federation staff grant in the working areas", () => {
  for (const [name, loader, path] of WORKING) {
    it(`opens ${name}, as it does for a workspace admin`, async () => {
      expect(await status(call(loader, path, admin, null))).toBe(200);
      expect(await status(call(loader, path, staff, STAFF_GRANT))).toBe(200);
    });

    it(`keeps ${name} shut to a member with no area flag`, async () => {
      expect(await status(call(loader, path, member, null))).toBe(403);
    });
  }
});

describe("a federation staff grant on the administration surfaces", () => {
  it("does not reach the users area or a person's page", async () => {
    expect(await status(call(usersLoader, "/admin/users", staff, STAFF_GRANT))).toBe(403);
    expect(await status(call(userLoader, `/admin/users/${admin.id}`, staff, STAFF_GRANT, { id: admin.id }))).toBe(403);
  });

  it("cannot start a project", async () => {
    expect(await status(call(newProjectLoader, "/projects/new", staff, STAFF_GRANT))).toBe(403);
  });

  it("is shown nothing to act on in publication", async () => {
    const data: any = await call(publishLoader, "/admin/publish", staff, STAFF_GRANT);
    expect(data.authorized).toBe(false);
  });
});

// @version v0.9.0
