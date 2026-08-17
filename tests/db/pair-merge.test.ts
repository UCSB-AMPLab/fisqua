/**
 * Tests — pair merge (the decisions surface's "same record" ruling)
 *
 * Covers `app/lib/pair-merge.server.ts`: the unselective merge the
 * duplicates worklist performs when a pair is judged one record. What
 * is pinned here is everything the workbench leaves to the cataloguer
 * and this surface decides on its own — every link travels, names
 * always fold — plus the two 409s that are this surface's whole
 * concurrency story (a record already merged away, a pair already
 * ruled), the ledger row's detail shape, and the decision row the
 * ruling lands on, whether it was filed by this call or already open.
 *
 * FIXTURES mirror `tests/db/pending-decisions.test.ts`: a lead tenant
 * (Neogranadina, federation steward via the lead-tenant-admin rule) and
 * two sibling member tenants (Alpha, Beta) inside one federation, with
 * sharing (`shared_authorities_enabled`) OFF so a plain tenant admin
 * may act on its own records without every test standing up a steward.
 * Alpha is the request tenant throughout; Beta owns the records Alpha
 * must never touch.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { rulePairMerge } from "../../app/lib/pair-merge.server";
import {
  getOrCreatePairDecision,
  rulePairKeepBoth,
  pairKey,
} from "../../app/lib/pending-decisions.server";
import type { Tenant, User } from "../../app/context";

const ALPHA_TENANT_ID = "2a2a0000-0000-4000-8000-00000000000a";
const BETA_TENANT_ID = "2b2b0000-0000-4000-8000-00000000000b";

const LEAD_ADMIN_ID = "2c000000-0000-4000-8000-000000000001";
const ALPHA_ADMIN_ID = "2c000000-0000-4000-8000-000000000002";
const BETA_ADMIN_ID = "2c000000-0000-4000-8000-000000000003";

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
  await seedTenant(ALPHA_TENANT_ID, "pm-alpha-tenant");
  await seedTenant(BETA_TENANT_ID, "pm-beta-tenant");

  await env.DB.prepare(
    "UPDATE federations SET shared_authorities_enabled = 0 WHERE id = ?",
  )
    .bind(NEOGRANADINA_FEDERATION_ID)
    .run();

  const users: Array<[string, string, boolean]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID, true],
    [ALPHA_ADMIN_ID, ALPHA_TENANT_ID, true],
    [BETA_ADMIN_ID, BETA_TENANT_ID, true],
  ];
  for (const [id, tenantId, isAdmin] of users) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, now, now)
      .run();
  }
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

async function seedEntity(
  id: string,
  tenantId: string | null,
  opts: { displayName?: string; nameVariants?: string[]; sources?: string } = {},
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(schema.entities).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId,
    entityCode: `ne-${id.slice(-8)}`,
    displayName: opts.displayName ?? `Entity ${id.slice(-4)}`,
    sortName: (opts.displayName ?? `Entity ${id.slice(-4)}`).toLowerCase(),
    entityType: "person",
    nameVariants: JSON.stringify(opts.nameVariants ?? []),
    sources: opts.sources ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlace(
  id: string,
  tenantId: string | null,
  opts: { displayName?: string; nameVariants?: string[] } = {},
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const name = opts.displayName ?? `Place ${id.slice(-4)}`;
  await db.insert(schema.places).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId,
    placeCode: `nl-${id.slice(-8)}`,
    label: name,
    displayName: name,
    nameVariants: JSON.stringify(opts.nameVariants ?? []),
    createdAt: now,
    updatedAt: now,
  });
}

/** A description Alpha owns, for the junction rows a merge repoints. */
async function seedDescription(): Promise<string> {
  const repoId = crypto.randomUUID();
  await createTestRepository({
    id: repoId,
    tenantId: ALPHA_TENANT_ID,
    code: `PM-${repoId.slice(0, 4)}`,
  });
  const descId = crypto.randomUUID();
  await createTestDescription({
    id: descId,
    tenantId: ALPHA_TENANT_ID,
    repositoryId: repoId,
  });
  return descId;
}

async function linkEntity(
  descriptionId: string,
  entityId: string,
  role: (typeof schema.descriptionEntities.$inferInsert)["role"],
): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  await db.insert(schema.descriptionEntities).values({
    id,
    descriptionId,
    entityId,
    role,
    createdAt: Date.now(),
  });
  return id;
}

async function linkPlace(
  descriptionId: string,
  placeId: string,
  role: (typeof schema.descriptionPlaces.$inferInsert)["role"],
): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  await db.insert(schema.descriptionPlaces).values({
    id,
    descriptionId,
    placeId,
    role,
    createdAt: Date.now(),
  });
  return id;
}

function db() {
  return drizzle(env.DB, { schema });
}

async function pairRows() {
  return db()
    .select()
    .from(schema.pendingDecisions)
    .where(eq(schema.pendingDecisions.kind, "duplicate-pair"))
    .all();
}

async function mergeLedgerRows() {
  return db()
    .select()
    .from(schema.authorityOperations)
    .where(eq(schema.authorityOperations.operation, "merge"))
    .all();
}

/**
 * The merge's journal rows, diffs parsed. Deliberately unordered: every
 * row in one merge shares the batch's single `now`, so `created_at`
 * cannot sequence them and tests select by `kind` instead.
 */
async function journalRows() {
  const rows = await db().select().from(schema.changelog).all();
  return rows.map((r) => ({ ...r, diff: JSON.parse(r.diff) as any }));
}

function alphaAdmin(): User {
  return makeUser({
    id: ALPHA_ADMIN_ID,
    tenantId: ALPHA_TENANT_ID,
    isAdmin: true,
  });
}

describe("pair merge — the decisions surface's merge ruling", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFixtures();
  });

  it("merges an even pair: every link repointed, names folded, loser pointed at the survivor, ledger and decision written", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID, {
      displayName: "Juana de Padilla",
      nameVariants: ["Padilla, Juana de"],
    });
    await seedEntity(loserId, ALPHA_TENANT_ID, {
      displayName: "Juana Padilla",
      nameVariants: ["Juana de Padilla y Ayala"],
      sources: "AGN, Notaría 1, f. 12r",
    });

    const descOne = await seedDescription();
    const descTwo = await seedDescription();
    const linkOne = await linkEntity(descOne, loserId, "scribe");
    const linkTwo = await linkEntity(descTwo, loserId, "witness");

    const now = Date.UTC(2026, 7, 13, 12, 0, 0);
    const result = await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "One hand, two spellings",
      now,
    );
    expect(result).toMatchObject({ movedLinks: 2, droppedLinks: 0 });

    // Both links now belong to the survivor, keeping their ids.
    const links = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.entityId, survivorId))
      .all();
    expect(links.map((l) => l.id).sort()).toEqual([linkOne, linkTwo].sort());
    const leftBehind = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.entityId, loserId))
      .all();
    expect(leftBehind).toHaveLength(0);

    const survivor = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, survivorId))
      .get();
    expect(JSON.parse(survivor!.nameVariants!)).toEqual([
      "Padilla, Juana de",
      "Juana Padilla",
      "Juana de Padilla y Ayala",
    ]);
    // The survivor keeps its own identity: name and code untouched.
    expect(survivor!.displayName).toBe("Juana de Padilla");
    expect(survivor!.entityCode).toBe(`ne-${survivorId.slice(-8)}`);
    expect(survivor!.mergedInto).toBeNull();

    const loser = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, loserId))
      .get();
    expect(loser!.mergedInto).toBe(survivorId);
    expect(loser!.sources).toBe(
      `AGN, Notaría 1, f. 12r\nMerged into Juana de Padilla (ne-${survivorId.slice(-8)}) on 2026-08-13`,
    );
    expect(loser!.updatedAt).toBe(now);

    const ledger = await mergeLedgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].recordType).toBe("entity");
    expect(ledger[0].sourceId).toBe(loserId);
    expect(ledger[0].targetId).toBe(survivorId);
    expect(ledger[0].userId).toBe(ALPHA_ADMIN_ID);
    const detail = JSON.parse(ledger[0].detail!);
    expect(Object.keys(detail).sort()).toEqual([
      "addVariants",
      "droppedLinks",
      "leftBehind",
      "movedLinks",
      "reason",
    ]);
    expect(detail).toMatchObject({
      reason: "One hand, two spellings",
      movedLinks: 2,
      droppedLinks: [],
      addVariants: true,
      leftBehind: 0,
    });

    const rows = await pairRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.decisionId);
    expect(rows[0].status).toBe("ruled");
    expect(rows[0].ruling).toBe("merged");
    expect(rows[0].resultId).toBe(survivorId);
    expect(rows[0].rulingNote).toBe("One hand, two spellings");
    expect(rows[0].ruledBy).toBe(ALPHA_ADMIN_ID);
    expect(rows[0].ruledAt).toBe(now);
    expect(rows[0].sourceRef).toBe(pairKey(survivorId, loserId));
  });

  it("a link colliding with the survivor's own (description, role) is dropped and captured; the same description under another role moves", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID);
    await seedEntity(loserId, ALPHA_TENANT_ID);

    const descId = await seedDescription();
    await linkEntity(descId, survivorId, "scribe");
    const collidingLink = await linkEntity(descId, loserId, "scribe");
    const movingLink = await linkEntity(descId, loserId, "witness");

    const result = await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "Same notary",
    );
    expect(result).toMatchObject({ movedLinks: 1, droppedLinks: 1 });

    const surviving = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.entityId, survivorId))
      .all();
    expect(surviving.map((l) => l.role).sort()).toEqual(["scribe", "witness"]);
    expect(surviving.some((l) => l.id === movingLink)).toBe(true);
    expect(surviving.some((l) => l.id === collidingLink)).toBe(false);

    const dropped = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, collidingLink))
      .get();
    expect(dropped).toBeUndefined();

    const ledger = await mergeLedgerRows();
    const detail = JSON.parse(ledger[0].detail!);
    expect(detail.movedLinks).toBe(1);
    expect(detail.droppedLinks).toHaveLength(1);
    // The full junction row is captured, not just its id.
    expect(detail.droppedLinks[0]).toMatchObject({
      id: collidingLink,
      descriptionId: descId,
      entityId: loserId,
      role: "scribe",
    });
    expect(detail.leftBehind).toBe(0);
  });

  it("the merge journals every mutation it makes: both records, the dropped link, and the repointed one as unlink+link", async () => {
    // The ledger says a merge happened; the journal says what it undid.
    // This pins the second trail — one row per mutation in the batch,
    // each carrying the before-image a revert would need.
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID, {
      displayName: "Juana de Padilla",
      nameVariants: ["Padilla, Juana de"],
    });
    await seedEntity(loserId, ALPHA_TENANT_ID, {
      displayName: "Juana Padilla",
      sources: "AGN, Notaría 1, f. 12r",
    });

    const descId = await seedDescription();
    await linkEntity(descId, survivorId, "scribe");
    const collidingLink = await linkEntity(descId, loserId, "scribe");
    const movingLink = await linkEntity(descId, loserId, "witness");

    const now = Date.parse("2026-08-13T00:00:00Z");
    await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "One hand, two spellings",
      now,
    );

    const journal = await journalRows();
    // 2 record updates + 1 dropped link + 1 repointed link (2 rows).
    expect(journal).toHaveLength(5);
    // Every row is the hand-edit kind: a decision ruling is not a run.
    expect(journal.every((r) => r.runId === null)).toBe(true);
    expect(journal.every((r) => r.userId === ALPHA_ADMIN_ID)).toBe(true);
    expect(journal.every((r) => r.createdAt === now)).toBe(true);

    // The loser's before-image: what mergedInto and sources said before.
    // The ruling note rides on the record rows — it is the reason the
    // pair was called one record, which is a fact about the records.
    const loserRow = journal.find(
      (r) => r.kind === "update" && r.recordId === loserId,
    )!;
    expect(loserRow.recordType).toBe("entity");
    expect(loserRow.note).toBe("One hand, two spellings");
    expect(loserRow.diff).toEqual({
      mergedInto: { old: null, new: survivorId },
      sources: {
        old: "AGN, Notaría 1, f. 12r",
        new: `AGN, Notaría 1, f. 12r\nMerged into Juana de Padilla (ne-${survivorId.slice(-8)}) on 2026-08-13`,
      },
    });

    // The survivor's before-image: the name list before the fold. The
    // clock stamp is NOT in the diff — it is not editorial content.
    const survivorRow = journal.find(
      (r) => r.kind === "update" && r.recordId === survivorId,
    )!;
    expect(Object.keys(survivorRow.diff)).toEqual(["nameVariants"]);
    expect(JSON.parse(survivorRow.diff.nameVariants.old)).toEqual([
      "Padilla, Juana de",
    ]);
    expect(JSON.parse(survivorRow.diff.nameVariants.new)).toEqual([
      "Padilla, Juana de",
      "Juana Padilla",
    ]);

    // Junction rows journal against the DESCRIPTION, never against the
    // junction's own id — record_id is what a history reader resolves to
    // a page, and the junction id travels inside the diff instead.
    const junction = journal.filter((r) => r.recordType === "description");
    expect(junction).toHaveLength(3);
    expect(junction.every((r) => r.recordId === descId)).toBe(true);

    // The dropped link: one unlink carrying the whole deleted row.
    const dropped = junction.filter(
      (r) => r.kind === "unlink" && r.diff.id === collidingLink,
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0].diff).toMatchObject({
      id: collidingLink,
      descriptionId: descId,
      entityId: loserId,
      role: "scribe",
    });

    // The repointed link: the row id never changes, but the fact it
    // asserts does — so it journals as unlink(old) + link(new).
    const movedOut = junction.find(
      (r) => r.kind === "unlink" && r.diff.id === movingLink,
    )!;
    expect(movedOut.diff.entityId).toBe(loserId);
    const movedIn = junction.find((r) => r.kind === "link")!;
    expect(movedIn.diff).toMatchObject({
      id: movingLink,
      descriptionId: descId,
      entityId: survivorId,
      role: "witness",
    });
  });

  it("re-merging a ruled pair rejects with 409 and changes nothing", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID);
    await seedEntity(loserId, ALPHA_TENANT_ID);
    const descId = await seedDescription();
    await linkEntity(descId, loserId, "scribe");

    await rulePairMerge(db(), admin, alpha, "entity", survivorId, loserId, "First");
    const decisionBefore = (await pairRows())[0];
    const ledgerBefore = await mergeLedgerRows();

    // This path 409s at the merged-record guard, before the ruled-row
    // guard — assert the body so the two guards stay distinguishable.
    const error = await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "Again",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Response);
    expect(error.status).toBe(409);
    expect(await error.text()).toBe("Already merged");

    expect(await pairRows()).toEqual([decisionBefore]);
    expect(await mergeLedgerRows()).toEqual(ledgerBefore);
  });

  it("merging a record into itself rejects with 400 and touches nothing", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const recordId = crypto.randomUUID();
    await seedEntity(recordId, ALPHA_TENANT_ID);
    const descId = await seedDescription();
    await linkEntity(descId, recordId, "scribe");

    await expect(
      rulePairMerge(db(), admin, alpha, "entity", recordId, recordId, null),
    ).rejects.toMatchObject({ status: 400 });

    // The record's links are intact — the self-collision path that
    // would have deleted them was never reached.
    const links = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.entityId, recordId))
      .all();
    expect(links).toHaveLength(1);
    expect(await pairRows()).toHaveLength(0);
    expect(await mergeLedgerRows()).toHaveLength(0);
  });

  it("a pair already ruled kept_both cannot then be merged", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID);
    await seedEntity(loserId, ALPHA_TENANT_ID);

    await rulePairKeepBoth(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "Two different scribes",
    );

    const error = await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "On reflection",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Response);
    expect(error.status).toBe(409);
    expect(await error.text()).toBe("Already ruled");

    const rows = await pairRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].ruling).toBe("kept_both");
    expect(await mergeLedgerRows()).toHaveLength(0);
  });

  it("a loser already merged away by the workbench rejects with 409 before any decision row is filed", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    const earlierSurvivorId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID);
    await seedEntity(loserId, ALPHA_TENANT_ID);
    await seedEntity(earlierSurvivorId, ALPHA_TENANT_ID);
    await db()
      .update(schema.entities)
      .set({ mergedInto: earlierSurvivorId })
      .where(eq(schema.entities.id, loserId));

    const error = await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      "Same person",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Response);
    expect(error.status).toBe(409);
    expect(await error.text()).toBe("Already merged");

    expect(await pairRows()).toHaveLength(0);
    expect(await mergeLedgerRows()).toHaveLength(0);
    const loser = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, loserId))
      .get();
    expect(loser!.mergedInto).toBe(earlierSurvivorId);
  });

  it("an open pair decision row is ruled in place — no second row", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedEntity(survivorId, ALPHA_TENANT_ID);
    await seedEntity(loserId, ALPHA_TENANT_ID);

    // The pair was made durable earlier — a comment, say — so its row
    // already exists, open, keyed on the sorted pairKey.
    const opened = await getOrCreatePairDecision(
      db(),
      admin,
      alpha,
      "entity",
      loserId,
      survivorId,
    );
    expect(opened.status).toBe("open");

    const result = await rulePairMerge(
      db(),
      admin,
      alpha,
      "entity",
      survivorId,
      loserId,
      null,
    );
    expect(result.decisionId).toBe(opened.id);

    const rows = await pairRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(opened.id);
    expect(rows[0].status).toBe("ruled");
    expect(rows[0].ruling).toBe("merged");
    expect(rows[0].resultId).toBe(survivorId);
    expect(rows[0].rulingNote).toBeNull();
  });

  it("a pair spanning two tenants 404s and writes nothing", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const ownId = crypto.randomUUID();
    const foreignId = crypto.randomUUID();
    await seedEntity(ownId, ALPHA_TENANT_ID);
    await seedEntity(foreignId, BETA_TENANT_ID);
    const descId = await seedDescription();
    const linkId = await linkEntity(descId, foreignId, "scribe");

    await expect(
      rulePairMerge(db(), admin, alpha, "entity", ownId, foreignId, "Same person"),
    ).rejects.toMatchObject({ status: 404 });

    expect(await pairRows()).toHaveLength(0);
    expect(await mergeLedgerRows()).toHaveLength(0);
    const link = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    expect(link!.entityId).toBe(foreignId);
    const foreign = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, foreignId))
      .get();
    expect(foreign!.mergedInto).toBeNull();
  });

  it("places merge through the same path: links repointed, names folded, ledger typed place", async () => {
    const alpha = await loadTenant(ALPHA_TENANT_ID);
    const admin = alphaAdmin();
    const survivorId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await seedPlace(survivorId, ALPHA_TENANT_ID, {
      displayName: "Vélez",
      nameVariants: ["Velez"],
    });
    await seedPlace(loserId, ALPHA_TENANT_ID, {
      displayName: "Villa de Vélez",
      nameVariants: ["Velez, Villa de"],
    });

    const descOne = await seedDescription();
    const descTwo = await seedDescription();
    await linkPlace(descOne, loserId, "mentioned");
    await linkPlace(descTwo, loserId, "created");

    const result = await rulePairMerge(
      db(),
      admin,
      alpha,
      "place",
      survivorId,
      loserId,
      "One villa",
    );
    expect(result).toMatchObject({ movedLinks: 2, droppedLinks: 0 });

    const moved = await db()
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.placeId, survivorId))
      .all();
    expect(moved).toHaveLength(2);

    const survivor = await db()
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, survivorId))
      .get();
    expect(JSON.parse(survivor!.nameVariants!)).toEqual([
      "Velez",
      "Villa de Vélez",
      "Velez, Villa de",
    ]);
    expect(survivor!.placeCode).toBe(`nl-${survivorId.slice(-8)}`);

    const loser = await db()
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, loserId))
      .get();
    expect(loser!.mergedInto).toBe(survivorId);

    const ledger = await mergeLedgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].recordType).toBe("place");
    expect(ledger[0].sourceId).toBe(loserId);
    expect(ledger[0].targetId).toBe(survivorId);

    const rows = await pairRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].ruling).toBe("merged");
    expect(rows[0].resultId).toBe(survivorId);
    expect(JSON.parse(rows[0].payload).recordType).toBe("place");
  });
});
