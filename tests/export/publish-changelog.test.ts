/**
 * Tests — publish pre-flight counts
 *
 * This suite pins `getPublishChangelog` (app/lib/export/
 * publish-changelog.server.ts), the counts the publish page shows before
 * a run: per-fonds added / modified / unpublished descriptions, and the
 * repositories, entities and places modified since the last completed
 * export. The publish page renders without them and fetches them from
 * the `/admin/publish/counts` resource route, which calls this
 * function. The numbers asserted are worked out by hand from the
 * fixture, so they check the queries rather than restate them.
 *
 * The fixture is the two-tenant federation of the export suites
 * (`tests/helpers/federation-fixture.ts`): the lead owns `co-ahrb-gob`,
 * the member `ahr` owns `co-ahr-gob`, and one entity and one place are
 * linked only to the member's fonds. The cases cover a federation that
 * has never been exported, deltas since a completed export (with a run
 * from a tenant outside the federation that must not move the
 * reference point), an authorities-off tenant, and a lead-only scope.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { AHR_TENANT_ID } from "../../app/lib/tenant";
import {
  seedFederationFixture,
  AHR_CHILD_ID,
  NEO_CHILD_ID,
  AHR_ONLY_ENTITY_ID,
  type Db,
} from "../helpers/federation-fixture";
import { getPublishChangelog } from "../../app/lib/export/publish-changelog.server";

const MEMBERS = [DEFAULT_TEST_TENANT_ID, AHR_TENANT_ID];

describe("getPublishChangelog", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    await seedFederationFixture(db);
  });

  it("counts everything published across the federation when nothing has been exported", async () => {
    const changelog = await getPublishChangelog(db, {
      publishTenantId: DEFAULT_TEST_TENANT_ID,
      memberTenantIds: MEMBERS,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      authoritiesEnabled: true,
    });

    expect(changelog.descriptions).toEqual([
      { fonds: "co-ahr-gob", fondsLabel: "Gobierno (AHR)", added: 2, modified: 2, unpublished: 0 },
      { fonds: "co-ahrb-gob", fondsLabel: "Gobierno (AHRB)", added: 2, modified: 2, unpublished: 0 },
    ]);
    expect(changelog.repositories.modified).toBe(2);
    expect(changelog.entities.modified).toBe(1);
    expect(changelog.places.modified).toBe(1);
  });

  it("counts only what changed since the federation's last completed export", async () => {
    const base = Date.now();
    const exportedAt = base + 1_000;
    const later = base + 5_000;

    const neoUser = "u-neo-0000-0000-0000-000000000001";
    const outsideUser = "u-sec-0000-0000-0000-000000000002";
    await db.insert(schema.users).values([
      { id: neoUser, tenantId: DEFAULT_TEST_TENANT_ID, email: "neo@example.com", isSuperAdmin: true, createdAt: base, updatedAt: base },
      { id: outsideUser, tenantId: SECOND_TEST_TENANT_ID, email: "sec@example.com", isSuperAdmin: true, createdAt: base, updatedAt: base },
    ]);
    await db.insert(schema.exportRuns).values([
      {
        id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
        triggeredBy: neoUser,
        tenantId: DEFAULT_TEST_TENANT_ID,
        status: "complete",
        selectedFonds: "[]",
        selectedTypes: "[]",
        stepsCompleted: 1,
        totalSteps: 1,
        startedAt: base,
        completedAt: exportedAt,
        createdAt: base,
      },
      // A tenant outside the federation exported after every change
      // below; its run must not become this federation's reference.
      {
        id: "22222222-2222-4222-8222-bbbbbbbbbbbb",
        triggeredBy: outsideUser,
        tenantId: SECOND_TEST_TENANT_ID,
        status: "complete",
        selectedFonds: "[]",
        selectedTypes: "[]",
        stepsCompleted: 1,
        totalSteps: 1,
        startedAt: base,
        completedAt: later + 10_000,
        createdAt: base,
      },
    ]);

    await db.update(schema.descriptions).set({ updatedAt: later }).where(eq(schema.descriptions.id, AHR_CHILD_ID));
    await db
      .update(schema.descriptions)
      .set({ isPublished: false, updatedAt: later })
      .where(eq(schema.descriptions.id, NEO_CHILD_ID));
    await db.update(schema.entities).set({ updatedAt: later }).where(eq(schema.entities.id, AHR_ONLY_ENTITY_ID));
    await db.update(schema.repositories).set({ updatedAt: later }).where(eq(schema.repositories.code, "co-ahr"));

    const changelog = await getPublishChangelog(db, {
      publishTenantId: DEFAULT_TEST_TENANT_ID,
      memberTenantIds: MEMBERS,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      authoritiesEnabled: true,
    });

    expect(changelog).toEqual({
      descriptions: [
        { fonds: "co-ahr-gob", fondsLabel: "Gobierno (AHR)", added: 0, modified: 1, unpublished: 0 },
        { fonds: "co-ahrb-gob", fondsLabel: "Gobierno (AHRB)", added: 0, modified: 0, unpublished: 1 },
      ],
      repositories: { modified: 1 },
      entities: { modified: 1 },
      places: { modified: 0 },
    });
  });

  it("reports no authority counts for a tenant with authorities off", async () => {
    const changelog = await getPublishChangelog(db, {
      publishTenantId: DEFAULT_TEST_TENANT_ID,
      memberTenantIds: MEMBERS,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      authoritiesEnabled: false,
    });
    expect(changelog.entities.modified).toBe(0);
    expect(changelog.places.modified).toBe(0);
    expect(changelog.descriptions).toHaveLength(2);
  });

  it("leaves out the member's fonds and authorities under a lead-only scope", async () => {
    const changelog = await getPublishChangelog(db, {
      publishTenantId: DEFAULT_TEST_TENANT_ID,
      memberTenantIds: [DEFAULT_TEST_TENANT_ID],
      federationId: DEFAULT_TEST_FEDERATION_ID,
      authoritiesEnabled: true,
    });
    expect(changelog.descriptions.map((d) => d.fonds)).toEqual(["co-ahrb-gob"]);
    expect(changelog.repositories.modified).toBe(1);
    expect(changelog.entities.modified).toBe(0);
    expect(changelog.places.modified).toBe(0);
  });
});

// @version v0.9.0
