/**
 * Tests — notification fan-out
 *
 * Covers `app/lib/notifications.server.ts` and the four call sites that
 * feed it: ruling a proposal, ruling a pair (kept_both and merged),
 * commenting on a decision thread, and filing proposals on a person's
 * behalf. What is under test is the recipient set — who gets an outbox
 * row for a given event, and who deliberately does not.
 *
 * FIXTURES are the pending-decisions suite's, extended where the
 * recipient rules need distinctions that surface has no use for: two
 * admins in the same tenant (so subtracting the actor still leaves
 * someone to notify), a non-admin in that tenant and an admin in a
 * sibling one (so `proposal_filed`'s tenant scoping is falsifiable),
 * a user whose digest preference is `off`, and a federation membership
 * pair — one steward, one staff — so the shared-space recipient set is
 * tested against a near miss rather than an empty table. Sharing is
 * turned OFF for the federation, exactly as the pending-decisions
 * suite does it, so a plain tenant admin can rule a pair of
 * tenant-owned records without a steward fixture in every test.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { enqueueDecisionNotifications } from "../../app/lib/notifications.server";
import {
  addDecisionComment,
  fileAuthorityProposals,
  getOrCreatePairDecision,
  ruleAuthorityProposal,
  rulePairKeepBoth,
} from "../../app/lib/pending-decisions.server";
import { rulePairMerge } from "../../app/lib/pair-merge.server";
import type { AuthorityProposalPayload } from "../../app/lib/pending-decisions.server";
import type { Tenant, User } from "../../app/context";

const ALPHA_TENANT_ID = "2a2a0000-0000-4000-8000-00000000000a";
const BETA_TENANT_ID = "2b2b0000-0000-4000-8000-00000000000b";

const LEAD_ADMIN_ID = "2c000000-0000-4000-8000-000000000001";
const ALPHA_ADMIN_ID = "2c000000-0000-4000-8000-000000000002";
const ALPHA_ADMIN2_ID = "2c000000-0000-4000-8000-000000000003";
const ALPHA_STAFF_ID = "2c000000-0000-4000-8000-000000000004";
const BETA_ADMIN_ID = "2c000000-0000-4000-8000-000000000005";
/** Alpha member, not an admin, digest preference `off`. */
const OFF_USER_ID = "2c000000-0000-4000-8000-000000000006";

function makeUser(
  overrides: Partial<User> & Pick<User, "id" | "tenantId">,
): User {
  return {
    email: `${overrides.id}@test.local`,
    name: null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

async function seedTenant(id: string, slug: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id, slug, slug, "tenant", "isadg", "active",
      0, 1, 0, 0, null, NEOGRANADINA_FEDERATION_ID, now, now,
    )
    .run();
}

async function seedFixtures(): Promise<void> {
  const now = Date.now();
  await seedTenant(ALPHA_TENANT_ID, "nf-alpha-tenant");
  await seedTenant(BETA_TENANT_ID, "nf-beta-tenant");

  await env.DB.prepare(
    "UPDATE federations SET shared_authorities_enabled = 0 WHERE id = ?",
  )
    .bind(NEOGRANADINA_FEDERATION_ID)
    .run();

  // [id, tenantId, isAdmin, digestFrequency]
  const people: Array<[string, string, boolean, string]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID, true, "hourly"],
    [ALPHA_ADMIN_ID, ALPHA_TENANT_ID, true, "hourly"],
    [ALPHA_ADMIN2_ID, ALPHA_TENANT_ID, true, "hourly"],
    [ALPHA_STAFF_ID, ALPHA_TENANT_ID, false, "daily"],
    [BETA_ADMIN_ID, BETA_TENANT_ID, true, "hourly"],
    [OFF_USER_ID, ALPHA_TENANT_ID, false, "off"],
  ];
  for (const [id, tenantId, isAdmin, digest] of people) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, digest_frequency, created_at, updated_at) " +
        "VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, digest, now, now)
      .run();
  }
}

/** A federation grant, so the shared-space recipient set has stewards. */
async function seedMembership(
  userId: string,
  role: "steward" | "staff",
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_memberships (id, user_id, federation_id, role, created_at) VALUES (?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), userId, NEOGRANADINA_FEDERATION_ID, role, Date.now())
    .run();
}

async function loadTenant(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  const row = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, id))
    .get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function seedEntity(id: string, tenantId: string | null): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(schema.entities).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId,
    entityCode: `ne-${id.slice(-8)}`,
    displayName: `Entity ${id.slice(-4)}`,
    sortName: `entity ${id.slice(-4)}`,
    entityType: "person",
    createdAt: now,
    updatedAt: now,
  });
}

function topicPayload(
  overrides: Partial<AuthorityProposalPayload> = {},
): AuthorityProposalPayload {
  return {
    heading: "Testamentos",
    proposedType: "topic",
    proposedName: "Testamentos",
    action: "mint",
    ...overrides,
  };
}

/** A pending_decisions row with a controllable filer stamp. */
async function seedProposal(opts: {
  id: string;
  tenantId: string | null;
  filedByUserId?: string | null;
  payload?: AuthorityProposalPayload;
}): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.pendingDecisions).values({
    id: opts.id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId: opts.tenantId,
    kind: "authority-proposal",
    payload: JSON.stringify(opts.payload ?? topicPayload()),
    sourceModule: "test-fixture",
    status: "open",
    filedByUserId: opts.filedByUserId ?? null,
    createdAt: Date.now(),
  });
}

/** A comment row written straight to storage, so seeding a thread does
 * not itself fan out notifications. */
async function seedComment(
  decisionId: string,
  tenantId: string | null,
  author: { userId: string } | { label: string },
  text: string,
  createdAt: number,
  deletedAt: number | null = null,
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.comments).values({
    id: crypto.randomUUID(),
    tenantId,
    decisionId,
    authorId: "userId" in author ? author.userId : null,
    authorLabel: "label" in author ? author.label : null,
    text,
    createdAt,
    updatedAt: createdAt,
    deletedAt,
  });
}

async function outboxRows() {
  const db = drizzle(env.DB, { schema });
  return db.select().from(schema.notificationOutbox).all();
}

async function recipientIds(): Promise<string[]> {
  return (await outboxRows()).map((r) => r.userId).sort();
}

describe("notification fan-out", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFixtures();
  });

  // ---------------------------------------------------------------------
  // decision_ruled
  // ---------------------------------------------------------------------

  describe("decision_ruled", () => {
    it("a pair ruled kept_both writes exactly one row, for the human who filed it", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const filer = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const ruler = makeUser({
        id: ALPHA_ADMIN2_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      await seedEntity(idA, ALPHA_TENANT_ID);
      await seedEntity(idB, ALPHA_TENANT_ID);

      const pair = await getOrCreatePairDecision(
        db,
        filer,
        alpha,
        "entity",
        idA,
        idB,
      );
      expect(pair.filedByUserId).toBe(ALPHA_ADMIN_ID);

      await rulePairKeepBoth(
        db,
        ruler,
        alpha,
        "entity",
        idA,
        idB,
        "Different scribes",
        7_000,
      );

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(ALPHA_ADMIN_ID);
      expect(rows[0].kind).toBe("decision_ruled");
      expect(rows[0].decisionId).toBe(pair.id);
      expect(rows[0].actorUserId).toBe(ALPHA_ADMIN2_ID);
      expect(rows[0].createdAt).toBe(7_000);
      expect(rows[0].sentAt).toBeNull();
    });

    it("a pair ruled merged notifies the filer too", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const filer = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const ruler = makeUser({
        id: ALPHA_ADMIN2_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const survivorId = crypto.randomUUID();
      const loserId = crypto.randomUUID();
      await seedEntity(survivorId, ALPHA_TENANT_ID);
      await seedEntity(loserId, ALPHA_TENANT_ID);

      const pair = await getOrCreatePairDecision(
        db,
        filer,
        alpha,
        "entity",
        survivorId,
        loserId,
      );

      const result = await rulePairMerge(
        db,
        ruler,
        alpha,
        "entity",
        survivorId,
        loserId,
        "Same person",
        9_000,
      );
      expect(result.decisionId).toBe(pair.id);

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(ALPHA_ADMIN_ID);
      expect(rows[0].kind).toBe("decision_ruled");
      expect(rows[0].decisionId).toBe(pair.id);
      expect(rows[0].actorUserId).toBe(ALPHA_ADMIN2_ID);
      expect(rows[0].createdAt).toBe(9_000);
    });

    it("the ruler answering their own question notifies nobody", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const idA = crypto.randomUUID();
      const idB = crypto.randomUUID();
      await seedEntity(idA, ALPHA_TENANT_ID);
      await seedEntity(idB, ALPHA_TENANT_ID);

      await getOrCreatePairDecision(db, admin, alpha, "entity", idA, idB);
      await rulePairKeepBoth(db, admin, alpha, "entity", idA, idB, null);

      expect(await outboxRows()).toHaveLength(0);
    });

    it("ruling a pipeline-filed proposal notifies nobody — there is no asker", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, filedByUserId: null });

      await ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" });

      expect(await outboxRows()).toHaveLength(0);
    });

    it("ruling a human-filed proposal notifies the filer", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const ruler = makeUser({
        id: ALPHA_ADMIN2_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        filedByUserId: ALPHA_STAFF_ID,
      });

      await ruleAuthorityProposal(
        db,
        ruler,
        alpha,
        id,
        { ruling: "rejected" },
        4_200,
      );

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(ALPHA_STAFF_ID);
      expect(rows[0].decisionId).toBe(id);
      expect(rows[0].createdAt).toBe(4_200);
    });

    it("a filer whose digest preference is off gets no row at all", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        filedByUserId: OFF_USER_ID,
      });

      await ruleAuthorityProposal(db, admin, alpha, id, { ruling: "rejected" });

      expect(await outboxRows()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // decision_comment
  // ---------------------------------------------------------------------

  describe("decision_comment", () => {
    it("reaches the filer and prior human commenters, minus the actor; label comments contribute nobody", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        filedByUserId: ALPHA_ADMIN_ID,
      });
      await seedComment(id, ALPHA_TENANT_ID, { userId: ALPHA_STAFF_ID }, "prior", 1_000);
      await seedComment(id, ALPHA_TENANT_ID, { label: "Fisqua" }, "pipeline", 1_500);

      await addDecisionComment(
        db,
        id,
        { userId: ALPHA_ADMIN2_ID, role: "admin" },
        "Agreed.",
        {},
        2_000,
      );

      const rows = await outboxRows();
      expect(rows).toHaveLength(2);
      expect(await recipientIds()).toEqual(
        [ALPHA_ADMIN_ID, ALPHA_STAFF_ID].sort(),
      );
      for (const row of rows) {
        expect(row.kind).toBe("decision_comment");
        expect(row.decisionId).toBe(id);
        expect(row.actorUserId).toBe(ALPHA_ADMIN2_ID);
        expect(row.createdAt).toBe(2_000);
      }
    });

    it("a commenter whose comment was since deleted is no longer a participant", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        filedByUserId: ALPHA_ADMIN_ID,
      });
      // The staff member spoke once, then the comment was tombstoned:
      // deleted speech no longer subscribes them to the thread.
      await seedComment(
        id,
        ALPHA_TENANT_ID,
        { userId: ALPHA_STAFF_ID },
        "retracted",
        1_000,
        1_500,
      );

      await addDecisionComment(
        db,
        id,
        { userId: ALPHA_ADMIN2_ID, role: "admin" },
        "Agreed.",
        {},
        2_000,
      );

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(ALPHA_ADMIN_ID);
    });

    it("a label-authored comment enqueues nothing — pipelines are silent", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        filedByUserId: ALPHA_ADMIN_ID,
      });
      await seedComment(id, ALPHA_TENANT_ID, { userId: ALPHA_STAFF_ID }, "prior", 1_000);

      await addDecisionComment(db, id, { label: "Fisqua" }, "Suggested.", {}, 2_000);

      expect(await outboxRows()).toHaveLength(0);
    });

    it("a filer who has also commented gets one row, not two", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        filedByUserId: ALPHA_ADMIN_ID,
      });
      await seedComment(id, ALPHA_TENANT_ID, { userId: ALPHA_ADMIN_ID }, "mine", 1_000);

      await addDecisionComment(
        db,
        id,
        { userId: ALPHA_ADMIN2_ID },
        "Replying.",
        {},
        2_000,
      );

      const rows = await outboxRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(ALPHA_ADMIN_ID);
    });
  });

  // ---------------------------------------------------------------------
  // proposal_filed
  // ---------------------------------------------------------------------

  describe("proposal_filed", () => {
    it("a tenant-stamped question reaches all and only that tenant's admins", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID });

      const written = await enqueueDecisionNotifications(db, {
        kind: "proposal_filed",
        decisionId: id,
        actorUserId: null,
        now: 3_000,
      });
      expect(written).toBe(2);
      expect(await recipientIds()).toEqual(
        [ALPHA_ADMIN_ID, ALPHA_ADMIN2_ID].sort(),
      );
      const ids = await recipientIds();
      // The tenant's non-admin and the sibling tenant's admin are out.
      expect(ids).not.toContain(ALPHA_STAFF_ID);
      expect(ids).not.toContain(BETA_ADMIN_ID);
    });

    it("a shared-space question reaches the lead tenant's admins and the federation's stewards", async () => {
      const db = drizzle(env.DB, { schema });
      await seedMembership(BETA_ADMIN_ID, "steward");
      await seedMembership(ALPHA_STAFF_ID, "staff");
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: null });

      const written = await enqueueDecisionNotifications(db, {
        kind: "proposal_filed",
        decisionId: id,
        actorUserId: null,
        now: 3_000,
      });
      expect(written).toBe(2);
      expect(await recipientIds()).toEqual([LEAD_ADMIN_ID, BETA_ADMIN_ID].sort());
      const ids = await recipientIds();
      // A member tenant's admin is not a ruler of the shared space, and
      // a `staff` grant is not a steward.
      expect(ids).not.toContain(ALPHA_ADMIN_ID);
      expect(ids).not.toContain(ALPHA_STAFF_ID);
    });

    it("fileAuthorityProposals stamps the filer and notifies once per proposal", async () => {
      const db = drizzle(env.DB, { schema });
      const filed = await fileAuthorityProposals(
        db,
        NEOGRANADINA_FEDERATION_ID,
        [
          { tenantId: ALPHA_TENANT_ID, payload: topicPayload(), sourceModule: "nf-test" },
          { tenantId: ALPHA_TENANT_ID, payload: topicPayload(), sourceModule: "nf-test" },
        ],
        5_000,
        ALPHA_ADMIN_ID,
      );
      expect(filed).toBe(2);

      const decisions = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.sourceModule, "nf-test"))
        .all();
      expect(decisions).toHaveLength(2);
      for (const d of decisions) {
        expect(d.filedByUserId).toBe(ALPHA_ADMIN_ID);
      }

      // One row per proposal, for the other admin: the filer never
      // hears about their own filing.
      const rows = await outboxRows();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.userId))).toEqual(
        new Set([ALPHA_ADMIN2_ID]),
      );
      expect(new Set(rows.map((r) => r.decisionId))).toEqual(
        new Set(decisions.map((d) => d.id)),
      );
      for (const row of rows) {
        expect(row.kind).toBe("proposal_filed");
        expect(row.actorUserId).toBe(ALPHA_ADMIN_ID);
        expect(row.createdAt).toBe(5_000);
      }
    });

    it("fileAuthorityProposals without a filer stamps nothing and notifies nobody", async () => {
      const db = drizzle(env.DB, { schema });
      const filed = await fileAuthorityProposals(
        db,
        NEOGRANADINA_FEDERATION_ID,
        [
          { tenantId: ALPHA_TENANT_ID, payload: topicPayload(), sourceModule: "nf-test" },
        ],
        5_000,
      );
      expect(filed).toBe(1);

      const decisions = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.sourceModule, "nf-test"))
        .all();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].filedByUserId).toBeNull();
      expect(await outboxRows()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // Failure is silent
  // ---------------------------------------------------------------------

  it("a missing decision returns 0 and does not throw", async () => {
    const db = drizzle(env.DB, { schema });
    await expect(
      enqueueDecisionNotifications(db, {
        kind: "decision_ruled",
        decisionId: crypto.randomUUID(),
        actorUserId: ALPHA_ADMIN_ID,
      }),
    ).resolves.toBe(0);
    expect(await outboxRows()).toHaveLength(0);
  });
});
