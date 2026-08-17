/**
 * Tests — pending decisions (server core)
 *
 * Covers `app/lib/pending-decisions.server.ts`: filing authority
 * proposals, the open-count the dashboard reads, ruling a proposal
 * (accept / amend / reject) across mint, link, and topic shapes, the
 * three-way ownership gate a ruling passes through
 * (`requireRulableDecision`, mirroring `requireAuthorityMutation`'s
 * shape one level up), and the duplicate-pair lifecycle: lazy
 * get-or-create keyed on the sorted pairKey, and ruling a pair
 * kept_both (with its `separate` ledger entry) through the same
 * pair-mutation gate.
 *
 * Two things ride along with an acceptance and are pinned here too.
 * The EVIDENCE LINK: a proposal citing a reference code turns, on
 * acceptance, into one description_entities or description_places row
 * under a role validated against the enum the ruled type owns —
 * best-effort against the reference (absent, unresolvable, or another
 * tenant's code all leave the mint standing with `linkedRef: null`) and
 * strict about the role (a value outside the enum is a 400 with the
 * question still open and nothing minted). The EXTERNAL MATCH: only a
 * candidate the payload already proposed reaches
 * external_authority_links, stamped `reconciled-confirmed` and carrying
 * the decision that confirmed it; anything else is a 400 before the
 * mint, and a topic ruling — which has no record to attach — ignores
 * the field entirely.
 *
 * FIXTURES mirror `tests/admin/authority-ownership.test.ts`: a lead
 * tenant (Neogranadina, federation steward via the lead-tenant-admin
 * rule) and two sibling member tenants (Alpha, Beta) inside the same
 * federation, so the cross-tenant gate paths are real. Sharing
 * (`shared_authorities_enabled`) is turned OFF for the whole suite so
 * a plain tenant admin is enough to mint into their own tenant-owned
 * space — the "owning tenant's admin" framing the scenarios below ask
 * for — without every mint test also standing up a steward. The
 * gate-matrix tests (a-d below) use topic proposals, which mint
 * nothing, so they isolate the DECISION-ownership gate from the
 * mint-owner gate entirely.
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
import {
  fileAuthorityProposals,
  countOpenAuthorityProposals,
  ruleAuthorityProposal,
  getOrCreatePairDecision,
  rulePairKeepBoth,
  ruledPairKeys,
  pairKey,
  addDecisionComment,
  listDecisionComments,
} from "../../app/lib/pending-decisions.server";
import type {
  AuthorityProposalPayload,
  ProposalToFile,
} from "../../app/lib/pending-decisions.server";
import type { Tenant, User } from "../../app/context";

// Two member tenants inside the Neogranadina federation, plus the lead
// tenant itself (already seeded by seedTenants()/seedFederations()).
// ALPHA is the request tenant throughout the ownership tests; BETA is
// the sibling whose records/questions ALPHA must never see or touch.
const ALPHA_TENANT_ID = "1a1a0000-0000-4000-8000-00000000000a";
const BETA_TENANT_ID = "1b1b0000-0000-4000-8000-00000000000b";

/** One repository per tenant, so a cited record has somewhere to live. */
const ALPHA_REPO_ID = "1d000000-0000-4000-8000-00000000000a";
const BETA_REPO_ID = "1d000000-0000-4000-8000-00000000000b";

const LEAD_ADMIN_ID = "1c000000-0000-4000-8000-000000000001";
const ALPHA_ADMIN_ID = "1c000000-0000-4000-8000-000000000002";
const ALPHA_STAFF_ID = "1c000000-0000-4000-8000-000000000003";
const BETA_ADMIN_ID = "1c000000-0000-4000-8000-000000000004";

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
  await seedTenant(ALPHA_TENANT_ID, "pd-alpha-tenant");
  await seedTenant(BETA_TENANT_ID, "pd-beta-tenant");

  // Sharing OFF: a plain tenant admin is enough to mint into their own
  // tenant-owned space, matching the "owning tenant's admin" framing
  // the mint scenarios below ask for. Neither ALPHA nor BETA carries
  // an entity/place code prefix unless a test sets one explicitly —
  // that absence is itself the fixture scenario 10 needs.
  await env.DB.prepare(
    "UPDATE federations SET shared_authorities_enabled = 0 WHERE id = ?",
  )
    .bind(NEOGRANADINA_FEDERATION_ID)
    .run();

  const users: Array<[string, string, boolean]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID, true],
    [ALPHA_ADMIN_ID, ALPHA_TENANT_ID, true],
    [ALPHA_STAFF_ID, ALPHA_TENANT_ID, false],
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

async function setAuthorityCodePrefixes(
  tenantId: string,
  entityPrefix: string | null,
  placePrefix: string | null,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE tenants SET entity_code_prefix = ?, place_code_prefix = ? WHERE id = ?",
  )
    .bind(entityPrefix, placePrefix, tenantId)
    .run();
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

async function seedPlace(id: string, tenantId: string | null): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(schema.places).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId,
    placeCode: `nl-${id.slice(-8)}`,
    label: `Place ${id.slice(-4)}`,
    displayName: `Place ${id.slice(-4)}`,
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * A record an evidenceRef can cite, with the repository it needs. The
 * repository is INSERT OR IGNORE'd on a per-tenant id so a test can
 * seed several records into one tenant without tracking what already
 * exists; reference codes are unique per tenant, not per platform, so
 * the same code may be seeded into two tenants deliberately.
 */
async function seedDescription(
  tenantId: string,
  referenceCode: string,
): Promise<string> {
  const db = drizzle(env.DB, { schema });
  const now = Date.now();
  const repositoryId =
    tenantId === BETA_TENANT_ID ? BETA_REPO_ID : ALPHA_REPO_ID;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO repositories (id, tenant_id, code, name, country_code, enabled, " +
      "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(
      repositoryId, tenantId, `PD-${repositoryId.slice(-1)}`, "Test repository",
      "COL", 1, now, now,
    )
    .run();
  const id = crypto.randomUUID();
  await db.insert(schema.descriptions).values({
    id,
    tenantId,
    repositoryId,
    descriptionLevel: "item",
    referenceCode,
    title: `Expediente ${referenceCode}`,
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Seed a pending_decisions row directly, bypassing fileAuthorityProposals
 * (which is what scenario 1 below tests) so the ruling/gate/dismissal
 * scenarios can control tenant_id and status precisely. */
async function seedProposal(opts: {
  id: string;
  tenantId: string | null;
  payload: AuthorityProposalPayload;
  sourceModule?: string;
  sourceRef?: string | null;
  status?: "open" | "ruled";
}): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const now = Date.now();
  await db.insert(schema.pendingDecisions).values({
    id: opts.id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId: opts.tenantId,
    kind: "authority-proposal",
    payload: JSON.stringify(opts.payload),
    sourceModule: opts.sourceModule ?? "test-fixture",
    sourceRef: opts.sourceRef ?? null,
    status: opts.status ?? "open",
    createdAt: now,
  });
}

function mintPayload(
  overrides: Partial<AuthorityProposalPayload> = {},
): AuthorityProposalPayload {
  return {
    heading: "Don Juan de la Cruz, indio principal",
    proposedType: "person",
    proposedName: "Juan de la Cruz",
    sortName: "cruz, juan de la",
    action: "mint",
    ...overrides,
  };
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

function linkPayload(
  target: { type: "entity" | "place"; id: string },
  overrides: Partial<AuthorityProposalPayload> = {},
): AuthorityProposalPayload {
  return {
    heading: "Cofradía del Rosario",
    proposedType: "corporate",
    proposedName: "Cofradía del Rosario",
    action: "link",
    linkTargetType: target.type,
    linkTargetId: target.id,
    ...overrides,
  };
}

describe("pending decisions — server core", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFixtures();
  });

  // ---------------------------------------------------------------------
  // 1. Filing and counting
  // ---------------------------------------------------------------------

  describe("filing and counting open proposals", () => {
    it("fileAuthorityProposals inserts open rows with stamped federation/tenant/payload", async () => {
      const db = drizzle(env.DB, { schema });
      const now = Date.now();
      const proposals: ProposalToFile[] = [
        {
          tenantId: ALPHA_TENANT_ID,
          payload: mintPayload({ heading: "Alpha's own proposal" }),
          sourceModule: "pd-test-import",
          sourceRef: "upload-alpha-1",
        },
        {
          tenantId: null,
          payload: topicPayload({ heading: "Shared-space proposal" }),
          sourceModule: "pd-test-import",
          sourceRef: "upload-shared-1",
        },
      ];

      const filed = await fileAuthorityProposals(
        db,
        NEOGRANADINA_FEDERATION_ID,
        proposals,
        now,
      );
      expect(filed).toBe(2);

      const rows = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.sourceModule, "pd-test-import"))
        .all();
      expect(rows).toHaveLength(2);

      const alphaRow = rows.find((r) => r.tenantId === ALPHA_TENANT_ID)!;
      expect(alphaRow.federationId).toBe(NEOGRANADINA_FEDERATION_ID);
      expect(alphaRow.kind).toBe("authority-proposal");
      expect(alphaRow.status).toBe("open");
      expect(alphaRow.sourceRef).toBe("upload-alpha-1");
      expect(alphaRow.createdAt).toBe(now);
      expect(JSON.parse(alphaRow.payload)).toMatchObject({
        heading: "Alpha's own proposal",
        proposedType: "person",
        proposedName: "Juan de la Cruz",
      });

      const sharedRow = rows.find((r) => r.tenantId === null)!;
      expect(sharedRow.federationId).toBe(NEOGRANADINA_FEDERATION_ID);
      expect(sharedRow.status).toBe("open");
      expect(JSON.parse(sharedRow.payload)).toMatchObject({
        heading: "Shared-space proposal",
        proposedType: "topic",
      });
    });

    it("countOpenAuthorityProposals counts only open authority-proposals visible to the tenant (own + shared)", async () => {
      const db = drizzle(env.DB, { schema });
      await fileAuthorityProposals(db, NEOGRANADINA_FEDERATION_ID, [
        { tenantId: ALPHA_TENANT_ID, payload: mintPayload(), sourceModule: "t" },
        { tenantId: ALPHA_TENANT_ID, payload: mintPayload(), sourceModule: "t" },
        { tenantId: null, payload: topicPayload(), sourceModule: "t" },
        { tenantId: BETA_TENANT_ID, payload: mintPayload(), sourceModule: "t" },
      ]);
      // A ruled row must not count even though it is Alpha's own.
      await seedProposal({
        id: crypto.randomUUID(),
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload(),
        status: "ruled",
      });

      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const beta = await loadTenant(BETA_TENANT_ID);
      // Alpha: 2 own open + 1 shared open = 3. Beta's open proposal and
      // Alpha's ruled one must not appear.
      expect(await countOpenAuthorityProposals(db, alpha)).toBe(3);
      // Beta: 1 own open + 1 shared open = 2. Alpha's rows must not appear.
      expect(await countOpenAuthorityProposals(db, beta)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // 2-6. Ruling outcomes (mint / link / topic / amend / reject)
  // ---------------------------------------------------------------------

  describe("ruling outcomes", () => {
    it("accept on a mint proposal (person) creates a tenant-owned entities row and rules the decision", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.ruling).toBe("accepted");
      expect(result.resultId).toBeTruthy();

      const entity = await db
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, result.resultId!))
        .get();
      expect(entity).toBeDefined();
      expect(entity!.tenantId).toBe(ALPHA_TENANT_ID);
      expect(entity!.federationId).toBe(NEOGRANADINA_FEDERATION_ID);
      expect(entity!.entityCode?.startsWith("al-e-")).toBe(true);
      expect(entity!.displayName).toBe("Juan de la Cruz");
      expect(entity!.sortName).toBe("cruz, juan de la");
      expect(entity!.entityType).toBe("person");

      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.status).toBe("ruled");
      expect(row?.ruling).toBe("accepted");
      expect(row?.resultId).toBe(result.resultId);
      expect(row?.ruledBy).toBe(ALPHA_ADMIN_ID);
      expect(row?.ruledAt).toBeTypeOf("number");
    });

    it("accept on a place proposal mints into places with the place prefix", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
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
        payload: mintPayload({
          heading: "Pueblo de indios de Turmequé",
          proposedType: "place",
          proposedName: "Turmequé",
          sortName: "turmeque",
        }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.resultId).toBeTruthy();

      const place = await db
        .select()
        .from(schema.places)
        .where(eq(schema.places.id, result.resultId!))
        .get();
      expect(place).toBeDefined();
      expect(place!.tenantId).toBe(ALPHA_TENANT_ID);
      expect(place!.placeCode?.startsWith("al-p-")).toBe(true);
      expect(place!.label).toBe("Turmequé");
      expect(place!.displayName).toBe("Turmequé");

      // No entity was minted for a place proposal.
      const entities = await db.select().from(schema.entities).all();
      expect(entities).toHaveLength(0);
    });

    it("a mint journals a create row carrying the whole new record and why it exists", async () => {
      // An accepted proposal is the only way a record enters the
      // authority files without anyone opening a create form, so the
      // journal is the only place that says where it came from.
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });

      const journal = await db.select().from(schema.changelog).all();
      const created = journal.filter((r) => r.kind === "create");
      expect(created).toHaveLength(1);
      expect(created[0].recordId).toBe(result.resultId);
      expect(created[0].recordType).toBe("entity");
      expect(created[0].userId).toBe(ALPHA_ADMIN_ID);
      // A hand ruling, not a run.
      expect(created[0].runId).toBeNull();
      // The note names the decision that produced the record.
      expect(created[0].note).toContain(`Minted from pending decision ${id}`);

      // A create diff is the full new row with a null before-image, so a
      // revert knows the record's before-image is non-existence.
      const diff = JSON.parse(created[0].diff) as Record<
        string,
        { old: null; new: unknown }
      >;
      expect(Object.values(diff).every((f) => f.old === null)).toBe(true);
      expect(diff.id.new).toBe(result.resultId);
      expect(diff.displayName.new).toBe("Juan de la Cruz");
      expect(diff.entityType.new).toBe("person");
      expect(diff.tenantId.new).toBe(ALPHA_TENANT_ID);
      expect(String(diff.entityCode.new).startsWith("al-e-")).toBe(true);
    });

    it("accept on a topic proposal: status ruled, result_id null, no entities/places row created", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: topicPayload() });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result).toMatchObject({ id, ruling: "accepted", resultId: null });

      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.status).toBe("ruled");
      expect(row?.ruling).toBe("accepted");
      expect(row?.resultId).toBeNull();

      const entities = await db.select().from(schema.entities).all();
      const places = await db.select().from(schema.places).all();
      expect(entities).toHaveLength(0);
      expect(places).toHaveLength(0);
    });

    it("amend overrides the payload; the mint uses the amended values and the stored payload records them", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      const original = mintPayload({
        heading: "Los Ruiz",
        proposedType: "family",
        proposedName: "Familia Ruiz",
        sortName: "ruiz (familia)",
      });
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: original });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "amended",
        amendedType: "corporate",
        amendedName: "Cofradía de Nuestra Señora del Rosario",
        amendedSortName: "cofradia de nuestra senora del rosario",
        note: "Corrected from family to corporate on review",
      });
      expect(result.ruling).toBe("amended");
      expect(result.resultId).toBeTruthy();

      const entity = await db
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, result.resultId!))
        .get();
      expect(entity!.entityType).toBe("corporate");
      expect(entity!.displayName).toBe("Cofradía de Nuestra Señora del Rosario");
      expect(entity!.sortName).toBe("cofradia de nuestra senora del rosario");

      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.rulingNote).toBe("Corrected from family to corporate on review");
      const storedPayload = JSON.parse(row!.payload) as AuthorityProposalPayload;
      expect(storedPayload.proposedType).toBe("corporate");
      expect(storedPayload.proposedName).toBe("Cofradía de Nuestra Señora del Rosario");
      expect(storedPayload.sortName).toBe("cofradia de nuestra senora del rosario");
      // Fields the amendment did not touch survive unchanged.
      expect(storedPayload.heading).toBe(original.heading);
      expect(storedPayload.action).toBe(original.action);
    });

    it("reject creates no record; ruling rejected, note stored", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "rejected",
        note: "Not a real entity — scribal flourish misread as a name",
      });
      expect(result.ruling).toBe("rejected");
      expect(result.resultId).toBeNull();

      const entities = await db.select().from(schema.entities).all();
      expect(entities).toHaveLength(0);

      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.status).toBe("ruled");
      expect(row?.ruling).toBe("rejected");
      expect(row?.rulingNote).toBe(
        "Not a real entity — scribal flourish misread as a name",
      );
    });
  });

  // ---------------------------------------------------------------------
  // 7. Gates
  // ---------------------------------------------------------------------

  describe("gates on ruling", () => {
    it("a non-admin member of the owning tenant is refused", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const staff = makeUser({
        id: ALPHA_STAFF_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: false,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: topicPayload() });

      await expect(
        ruleAuthorityProposal(db, staff, alpha, id, { ruling: "accepted" }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("an admin of a DIFFERENT tenant in the same federation gets a bare 404", async () => {
      const db = drizzle(env.DB, { schema });
      const beta = await loadTenant(BETA_TENANT_ID);
      const betaAdmin = makeUser({
        id: BETA_ADMIN_ID,
        tenantId: BETA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: topicPayload() });

      await expect(
        ruleAuthorityProposal(db, betaAdmin, beta, id, { ruling: "accepted" }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("a shared-space question (tenant_id NULL) rejects a plain tenant admin — the steward gate applies", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: null, payload: topicPayload() });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("a federation steward MAY rule a shared-space question", async () => {
      const db = drizzle(env.DB, { schema });
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: null, payload: topicPayload() });

      await expect(
        ruleAuthorityProposal(db, leadAdmin, lead, id, { ruling: "accepted" }),
      ).resolves.toMatchObject({ ruling: "accepted" });
    });

    it("ruling an already-ruled question returns 409", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: topicPayload() });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).resolves.toMatchObject({ ruling: "accepted" });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  // ---------------------------------------------------------------------
  // 8. Link proposals
  // ---------------------------------------------------------------------

  describe("link proposals", () => {
    it("accept resolves an existing record inside the tenant's visible scope and stamps result_id", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const targetId = crypto.randomUUID();
      await seedEntity(targetId, ALPHA_TENANT_ID);

      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: linkPayload({ type: "entity", id: targetId }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.resultId).toBe(targetId);

      // No new entity was minted — the proposal resolved to the
      // existing one.
      const entities = await db.select().from(schema.entities).all();
      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe(targetId);
    });

    it("a link target belonging to another tenant 404s", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const foreignTargetId = crypto.randomUUID();
      await seedEntity(foreignTargetId, BETA_TENANT_ID);

      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: linkPayload({ type: "entity", id: foreignTargetId }),
      });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).rejects.toMatchObject({ status: 404 });

      // The failed resolution left the question untouched.
      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.status).toBe("open");
    });
  });

  // ---------------------------------------------------------------------
  // 9. Duplicate pairs (0072: a pair is a decision, filed lazily and
  // ruled kept_both / merged from there)
  // ---------------------------------------------------------------------

  describe("duplicate pairs", () => {
    it("getOrCreatePairDecision files one open row with sorted pair, pairKey source_ref, and filed_by; a second call returns the SAME row", async () => {
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

      // pairKey is order-independent.
      expect(pairKey(idA, idB)).toBe(pairKey(idB, idA));

      // Pass the pair in reverse order to prove the stored pair is
      // sorted regardless of call order.
      const first = await getOrCreatePairDecision(db, admin, alpha, "entity", idB, idA);
      expect(first.status).toBe("open");
      expect(first.kind).toBe("duplicate-pair");
      expect(first.sourceModule).toBe("duplicate-scan");
      expect(first.sourceRef).toBe(pairKey(idA, idB));
      expect(first.filedByUserId).toBe(ALPHA_ADMIN_ID);
      const payload = JSON.parse(first.payload) as {
        recordType: string;
        pair: [string, string];
      };
      expect(payload.recordType).toBe("entity");
      expect(payload.pair).toEqual([idA, idB].sort());

      const rows = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.kind, "duplicate-pair"))
        .all();
      expect(rows).toHaveLength(1);

      // Second call, forward order this time — same row, no second insert.
      const second = await getOrCreatePairDecision(db, admin, alpha, "entity", idA, idB);
      expect(second.id).toBe(first.id);
      const rowsAfter = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.kind, "duplicate-pair"))
        .all();
      expect(rowsAfter).toHaveLength(1);
    });

    it("tenant stamping: own/own pair stamps the tenant; a pair touching a shared record stamps NULL and needs a steward", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const ownA = crypto.randomUUID();
      const ownB = crypto.randomUUID();
      await seedEntity(ownA, ALPHA_TENANT_ID);
      await seedEntity(ownB, ALPHA_TENANT_ID);

      const ownPair = await getOrCreatePairDecision(db, admin, alpha, "entity", ownA, ownB);
      expect(ownPair.tenantId).toBe(ALPHA_TENANT_ID);

      // A pair touching a shared record: mirror the steward tests —
      // the caller is the lead tenant's own admin (a federation
      // steward), pairing a lead-owned record with the shared one.
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      const leadOwned = crypto.randomUUID();
      const shared = crypto.randomUUID();
      await seedEntity(leadOwned, NEOGRANADINA_TENANT_ID);
      await seedEntity(shared, null);

      const sharedPair = await getOrCreatePairDecision(
        db,
        leadAdmin,
        lead,
        "entity",
        leadOwned,
        shared,
      );
      expect(sharedPair.tenantId).toBeNull();
    });

    it("rulePairKeepBoth on a virgin pair files and rules the row, and writes the separate ledger row in the same batch", async () => {
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

      await rulePairKeepBoth(db, admin, alpha, "entity", idA, idB, "Different scribes");

      const rows = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.kind, "duplicate-pair"))
        .all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("ruled");
      expect(row.ruling).toBe("kept_both");
      expect(row.tenantId).toBe(ALPHA_TENANT_ID);
      expect(row.sourceRef).toBe(pairKey(idA, idB));
      expect(row.rulingNote).toBe("Different scribes");
      expect(row.ruledBy).toBe(ALPHA_ADMIN_ID);
      expect(row.ruledAt).toBeTypeOf("number");

      const ledgerRows = await db
        .select()
        .from(schema.authorityOperations)
        .where(eq(schema.authorityOperations.operation, "separate"))
        .all();
      expect(ledgerRows).toHaveLength(1);
      const ledgerRow = ledgerRows[0];
      expect(ledgerRow.recordType).toBe("entity");
      expect(ledgerRow.sourceId).toBe(idA);
      expect(ledgerRow.targetId).toBe(idB);
      expect(ledgerRow.userId).toBe(ALPHA_ADMIN_ID);
      expect(JSON.parse(ledgerRow.detail!)).toEqual({ reason: "Different scribes" });
    });

    it("rulePairKeepBoth on an existing OPEN row rules it in place — no second row", async () => {
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

      const opened = await getOrCreatePairDecision(db, admin, alpha, "entity", idA, idB);
      expect(opened.status).toBe("open");

      await rulePairKeepBoth(db, admin, alpha, "entity", idA, idB, "Not the same person");

      const rows = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.kind, "duplicate-pair"))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(opened.id);
      expect(rows[0].status).toBe("ruled");
      expect(rows[0].ruling).toBe("kept_both");
    });

    it("a second rule rejects with 409, and the row is unchanged", async () => {
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

      await rulePairKeepBoth(db, admin, alpha, "entity", idA, idB, "First ruling");
      const before = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.sourceRef, pairKey(idA, idB)))
        .get();

      await expect(
        rulePairKeepBoth(db, admin, alpha, "entity", idA, idB, "Second attempt"),
      ).rejects.toMatchObject({ status: 409 });

      const after = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.sourceRef, pairKey(idA, idB)))
        .get();
      expect(after).toEqual(before);
    });

    it("the pair-gate holds: a pair spanning tenants 404s and creates nothing", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const ownId = crypto.randomUUID();
      const foreignId = crypto.randomUUID();
      await seedEntity(ownId, ALPHA_TENANT_ID);
      await seedEntity(foreignId, BETA_TENANT_ID);

      await expect(
        rulePairKeepBoth(db, admin, alpha, "entity", ownId, foreignId, "Not the same"),
      ).rejects.toMatchObject({ status: 404 });

      const rows = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.kind, "duplicate-pair"))
        .all();
      expect(rows).toHaveLength(0);
    });

    it("ruledPairKeys includes kept_both pairs and excludes a pair whose row is still open", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const ruledA = crypto.randomUUID();
      const ruledB = crypto.randomUUID();
      const openA = crypto.randomUUID();
      const openB = crypto.randomUUID();
      await seedEntity(ruledA, ALPHA_TENANT_ID);
      await seedEntity(ruledB, ALPHA_TENANT_ID);
      await seedEntity(openA, ALPHA_TENANT_ID);
      await seedEntity(openB, ALPHA_TENANT_ID);

      await rulePairKeepBoth(db, admin, alpha, "entity", ruledA, ruledB, "Ruled apart");
      await getOrCreatePairDecision(db, admin, alpha, "entity", openA, openB);

      const keys = await ruledPairKeys(db, alpha, "entity");
      expect(keys.has(pairKey(ruledA, ruledB))).toBe(true);
      expect(keys.has(pairKey(openA, openB))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // 10. Minting with no configured prefix
  // ---------------------------------------------------------------------

  describe("minting with no configured prefix", () => {
    it("refuses to mint rather than issue a code under nobody's mark", async () => {
      const db = drizzle(env.DB, { schema });
      // ALPHA_TENANT_ID carries no entity_code_prefix (seedFixtures
      // never sets one) and sharing is OFF for the whole suite, so this
      // resolves to a tenant-owned mint with nothing configured to
      // stamp it with — exactly the state resolveAuthorityCodePrefix
      // exists to refuse rather than paper over.
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      expect(alpha.entityCodePrefix).toBeNull();
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).rejects.toThrow(/No entity code prefix configured/);

      const entities = await db.select().from(schema.entities).all();
      expect(entities).toHaveLength(0);

      // The failed mint left the question open — no partial commit.
      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.status).toBe("open");
    });
  });

  // ---------------------------------------------------------------------
  // 11. The evidence link an acceptance carries with it
  // ---------------------------------------------------------------------

  describe("the evidence link on acceptance", () => {
    it("an evidenceRef that resolves in-tenant becomes one description_entities row, role 'mentioned'", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const descriptionId = await seedDescription(ALPHA_TENANT_ID, "CMD 2928");
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({ evidenceRef: "CMD 2928" }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.resultId).toBeTruthy();
      expect(result.linkedRef).toBe("CMD 2928");

      const links = await db.select().from(schema.descriptionEntities).all();
      expect(links).toHaveLength(1);
      expect(links[0].descriptionId).toBe(descriptionId);
      expect(links[0].entityId).toBe(result.resultId);
      // Nothing was asserted beyond appearance: the weakest claim the
      // enum can make is the default.
      expect(links[0].role).toBe("mentioned");
      expect(links[0].roleNote).toBeNull();

      // A person mint never touches the place junction.
      const placeLinks = await db.select().from(schema.descriptionPlaces).all();
      expect(placeLinks).toHaveLength(0);
    });

    it("the payload's proposedRole carries when the ruling names none, and an explicit linkRole overrides it", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await seedDescription(ALPHA_TENANT_ID, "CMD 2928");

      const fromPayloadId = crypto.randomUUID();
      await seedProposal({
        id: fromPayloadId,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({ evidenceRef: "CMD 2928", proposedRole: "witness" }),
      });
      const fromPayload = await ruleAuthorityProposal(
        db,
        admin,
        alpha,
        fromPayloadId,
        { ruling: "accepted" },
      );

      const overriddenId = crypto.randomUUID();
      await seedProposal({
        id: overriddenId,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({
          heading: "Ana Ruiz, escribana",
          proposedName: "Ana Ruiz",
          sortName: "ruiz, ana",
          evidenceRef: "CMD 2928",
          proposedRole: "witness",
        }),
      });
      const overridden = await ruleAuthorityProposal(
        db,
        admin,
        alpha,
        overriddenId,
        { ruling: "accepted", linkRole: "scribe" },
      );

      const links = await db.select().from(schema.descriptionEntities).all();
      expect(links).toHaveLength(2);
      const roleByEntity = Object.fromEntries(
        links.map((l) => [l.entityId, l.role]),
      );
      expect(roleByEntity[fromPayload.resultId!]).toBe("witness");
      expect(roleByEntity[overridden.resultId!]).toBe("scribe");
    });

    it("a place mint records the link in description_places under a PLACE_ROLES value", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const descriptionId = await seedDescription(ALPHA_TENANT_ID, "CMD 3001");
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({
          heading: "Pueblo de indios de Turmequé",
          proposedType: "place",
          proposedName: "Turmequé",
          sortName: "turmeque",
          evidenceRef: "CMD 3001",
          proposedRole: "created",
        }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.linkedRef).toBe("CMD 3001");

      const links = await db.select().from(schema.descriptionPlaces).all();
      expect(links).toHaveLength(1);
      expect(links[0].descriptionId).toBe(descriptionId);
      expect(links[0].placeId).toBe(result.resultId);
      expect(links[0].role).toBe("created");

      const entityLinks = await db.select().from(schema.descriptionEntities).all();
      expect(entityLinks).toHaveLength(0);
    });

    it("a link proposal attaches the evidence to the record it resolved to, minting nothing", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      const targetId = crypto.randomUUID();
      await seedPlace(targetId, ALPHA_TENANT_ID);
      const descriptionId = await seedDescription(ALPHA_TENANT_ID, "CMD 3100");

      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: linkPayload(
          { type: "place", id: targetId },
          { evidenceRef: "CMD 3100", proposedRole: "venue" },
        ),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.resultId).toBe(targetId);
      expect(result.linkedRef).toBe("CMD 3100");

      const links = await db.select().from(schema.descriptionPlaces).all();
      expect(links).toHaveLength(1);
      expect(links[0].descriptionId).toBe(descriptionId);
      expect(links[0].placeId).toBe(targetId);
      expect(links[0].role).toBe("venue");

      // The link proposal resolved; it did not mint a second place.
      const places = await db.select().from(schema.places).all();
      expect(places).toHaveLength(1);
    });

    it("a role outside the ruled type's enum is a 400 — the question stays open and nothing is minted", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await seedDescription(ALPHA_TENANT_ID, "CMD 3200");

      // "creator" is an ENTITY_ROLES member; a place link cannot carry it.
      const placeId = crypto.randomUUID();
      await seedProposal({
        id: placeId,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({
          proposedType: "place",
          proposedName: "Turmequé",
          evidenceRef: "CMD 3200",
        }),
      });
      await expect(
        ruleAuthorityProposal(db, admin, alpha, placeId, {
          ruling: "accepted",
          linkRole: "creator",
        }),
      ).rejects.toMatchObject({ status: 400 });

      // The mirror: "venue" is PLACE_ROLES only, so an entity mint
      // cannot carry it either.
      const entityId = crypto.randomUUID();
      await seedProposal({
        id: entityId,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({ evidenceRef: "CMD 3200" }),
      });
      await expect(
        ruleAuthorityProposal(db, admin, alpha, entityId, {
          ruling: "accepted",
          linkRole: "venue",
        }),
      ).rejects.toMatchObject({ status: 400 });

      // Neither refusal left anything behind, and both questions are
      // still open for someone to rule properly.
      expect(await db.select().from(schema.places).all()).toHaveLength(0);
      expect(await db.select().from(schema.entities).all()).toHaveLength(0);
      expect(await db.select().from(schema.descriptionPlaces).all()).toHaveLength(0);
      expect(await db.select().from(schema.descriptionEntities).all()).toHaveLength(0);
      const rows = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.kind, "authority-proposal"))
        .all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === "open")).toBe(true);
    });

    it("skipLink leaves the mint standing with no junction row and no linkedRef", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await seedDescription(ALPHA_TENANT_ID, "CMD 2928");
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({ evidenceRef: "CMD 2928", proposedRole: "witness" }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
        skipLink: true,
      });
      expect(result.resultId).toBeTruthy();
      expect(result.linkedRef).toBeNull();
      expect(await db.select().from(schema.descriptionEntities).all()).toHaveLength(0);
    });

    it("an absent or unresolvable evidenceRef leaves the mint standing and reports linkedRef null", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      // A record exists, but under a code neither proposal cites.
      await seedDescription(ALPHA_TENANT_ID, "CMD 2928");

      const absentId = crypto.randomUUID();
      await seedProposal({
        id: absentId,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload(),
      });
      const absent = await ruleAuthorityProposal(db, admin, alpha, absentId, {
        ruling: "accepted",
      });
      expect(absent.resultId).toBeTruthy();
      expect(absent.linkedRef).toBeNull();

      const unresolvableId = crypto.randomUUID();
      await seedProposal({
        id: unresolvableId,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({
          heading: "Ana Ruiz, escribana",
          proposedName: "Ana Ruiz",
          sortName: "ruiz, ana",
          evidenceRef: "CMD 9999",
        }),
      });
      const unresolvable = await ruleAuthorityProposal(
        db,
        admin,
        alpha,
        unresolvableId,
        { ruling: "accepted" },
      );
      expect(unresolvable.resultId).toBeTruthy();
      expect(unresolvable.linkedRef).toBeNull();

      // Both mints landed; neither wrote a junction row.
      expect(await db.select().from(schema.entities).all()).toHaveLength(2);
      expect(await db.select().from(schema.descriptionEntities).all()).toHaveLength(0);
    });

    it("an evidenceRef matching only another tenant's record does not resolve", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      // Reference codes are unique per tenant, so Beta may hold "CMD
      // 2928" while Alpha holds nothing of the sort. Alpha's ruling must
      // see a gap in the evidence, not the neighbour's record.
      await seedDescription(BETA_TENANT_ID, "CMD 2928");

      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({ evidenceRef: "CMD 2928" }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
      });
      expect(result.resultId).toBeTruthy();
      expect(result.linkedRef).toBeNull();
      expect(await db.select().from(schema.descriptionEntities).all()).toHaveLength(0);
    });

    it("a second acceptance still 409s, and the link was written exactly once", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      await seedDescription(ALPHA_TENANT_ID, "CMD 2928");
      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: mintPayload({ evidenceRef: "CMD 2928" }),
      });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).resolves.toMatchObject({ ruling: "accepted", linkedRef: "CMD 2928" });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, { ruling: "accepted" }),
      ).rejects.toMatchObject({ status: 409 });

      expect(await db.select().from(schema.entities).all()).toHaveLength(1);
      expect(await db.select().from(schema.descriptionEntities).all()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // 12. The external authority registry (0076)
  // ---------------------------------------------------------------------

  describe("the external authority registry", () => {
    const CANDIDATE = {
      scheme: "lcnaf" as const,
      id: "no2018001234",
      label: "Cruz, Juan de la",
    };

    it("a confirmed candidate the payload proposed writes one reconciled-confirmed row", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
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
        payload: mintPayload({ externalCandidates: [CANDIDATE] }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
        confirmedExternal: { scheme: "lcnaf", externalId: CANDIDATE.id },
      });

      const rows = await db.select().from(schema.externalAuthorityLinks).all();
      expect(rows).toHaveLength(1);
      const link = rows[0];
      expect(link.federationId).toBe(NEOGRANADINA_FEDERATION_ID);
      expect(link.recordType).toBe("entity");
      expect(link.recordId).toBe(result.resultId);
      expect(link.scheme).toBe("lcnaf");
      expect(link.externalId).toBe(CANDIDATE.id);
      // The label comes off the candidate, never off the form.
      expect(link.matchedLabel).toBe(CANDIDATE.label);
      expect(link.matchedBy).toBe("reconciled-confirmed");
      expect(link.decisionId).toBe(id);
      expect(link.status).toBe("active");
      expect(link.labelCheckedAt).toBeNull();
    });

    it("an identifier no candidate proposed is a 400 before anything is minted", async () => {
      const db = drizzle(env.DB, { schema });
      await setAuthorityCodePrefixes(ALPHA_TENANT_ID, "al-e", "al-p");
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
        payload: mintPayload({ externalCandidates: [CANDIDATE] }),
      });

      await expect(
        ruleAuthorityProposal(db, admin, alpha, id, {
          ruling: "accepted",
          // The right scheme, an identifier nobody proposed.
          confirmedExternal: { scheme: "lcnaf", externalId: "no9999999999" },
        }),
      ).rejects.toMatchObject({ status: 400 });

      expect(await db.select().from(schema.externalAuthorityLinks).all()).toHaveLength(0);
      expect(await db.select().from(schema.entities).all()).toHaveLength(0);
      const row = await db
        .select()
        .from(schema.pendingDecisions)
        .where(eq(schema.pendingDecisions.id, id))
        .get();
      expect(row?.status).toBe("open");
    });

    it("a topic ruling ignores a confirmed candidate — there is no record to attach it to", async () => {
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
        payload: topicPayload({
          externalCandidates: [
            { scheme: "lcsh", id: "sh85134022", label: "Wills" },
          ],
        }),
      });

      const result = await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
        confirmedExternal: { scheme: "lcsh", externalId: "sh85134022" },
      });
      expect(result).toMatchObject({ ruling: "accepted", resultId: null });
      expect(await db.select().from(schema.externalAuthorityLinks).all()).toHaveLength(0);
    });

    it("the unique key makes a repeat confirmation a no-op rather than a second row", async () => {
      const db = drizzle(env.DB, { schema });
      const alpha = await loadTenant(ALPHA_TENANT_ID);
      const admin = makeUser({
        id: ALPHA_ADMIN_ID,
        tenantId: ALPHA_TENANT_ID,
        isAdmin: true,
      });
      // An import already recorded this match against the record the
      // link proposal resolves to.
      const targetId = crypto.randomUUID();
      await seedEntity(targetId, ALPHA_TENANT_ID);
      const now = Date.now();
      await db.insert(schema.externalAuthorityLinks).values({
        id: crypto.randomUUID(),
        federationId: NEOGRANADINA_FEDERATION_ID,
        recordType: "entity",
        recordId: targetId,
        scheme: CANDIDATE.scheme,
        externalId: CANDIDATE.id,
        matchedLabel: "Carried in by the load",
        matchedBy: "import",
        decisionId: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      const id = crypto.randomUUID();
      await seedProposal({
        id,
        tenantId: ALPHA_TENANT_ID,
        payload: linkPayload(
          { type: "entity", id: targetId },
          { externalCandidates: [CANDIDATE] },
        ),
      });
      await ruleAuthorityProposal(db, admin, alpha, id, {
        ruling: "accepted",
        confirmedExternal: { scheme: CANDIDATE.scheme, externalId: CANDIDATE.id },
      });

      const rows = await db.select().from(schema.externalAuthorityLinks).all();
      expect(rows).toHaveLength(1);
      // The conflict was ignored, not resolved in the newcomer's favour.
      expect(rows[0].matchedBy).toBe("import");
      expect(rows[0].matchedLabel).toBe("Carried in by the load");
      expect(rows[0].decisionId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 8. Decision comments (unified comments table, migration 0071)
  // ---------------------------------------------------------------------

  describe("decision comments in the unified comments table", () => {
    it("label-authored comment round-trips as System with the decision's tenant stamped", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      await addDecisionComment(
        db,
        id,
        { label: "Fisqua" },
        "Appears three times in the index. From row 42 of the subject index you imported.",
        {
          quote: "Juan de la Cruz, indio principal de Bogotá",
          quoteRef: "CMD 12",
          note: "Suggested from the catalogue itself.",
        },
      );

      const threads = await listDecisionComments(db, [id]);
      expect(threads[id]).toHaveLength(1);
      const c = threads[id][0];
      expect(c.author).toBe("Fisqua");
      expect(c.isSystem).toBe(true);
      expect(c.role).toBeNull();
      expect(c.quote).toBe("Juan de la Cruz, indio principal de Bogotá");
      expect(c.quoteRef).toBe("CMD 12");
      expect(c.note).toBe("Suggested from the catalogue itself.");

      // Storage-level: the row lives in `comments`, decision-targeted,
      // tenant copied from the decision.
      const row = await db
        .select()
        .from(schema.comments)
        .where(eq(schema.comments.decisionId, id))
        .get();
      expect(row?.tenantId).toBe(ALPHA_TENANT_ID);
      expect(row?.authorLabel).toBe("Fisqua");
      expect(row?.authorId).toBeNull();
      expect(row?.volumeId).toBeNull();
    });

    it("user-authored comment resolves the author name and snapshots the role", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      await addDecisionComment(
        db,
        id,
        { userId: ALPHA_ADMIN_ID, role: "admin" },
        "Agreed — the heading refers to the person, not the office.",
      );

      const threads = await listDecisionComments(db, [id]);
      const c = threads[id][0];
      expect(c.isSystem).toBe(false);
      expect(c.role).toBe("admin");
      expect(c.author.length).toBeGreaterThan(0);
      // The view carries the raw authorId (the edit affordance keys on
      // it) and editedAt, NULL until a real body edit lands.
      expect(c.authorId).toBe(ALPHA_ADMIN_ID);
      expect(c.editedAt).toBeNull();
      expect(c.quote).toBeNull();
    });

    it("threads come back oldest-first per decision, one query for many", async () => {
      const db = drizzle(env.DB, { schema });
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      await seedProposal({ id: a, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });
      await seedProposal({ id: b, tenantId: ALPHA_TENANT_ID, payload: topicPayload() });

      await addDecisionComment(db, a, { label: "Fisqua" }, "first on a", {}, 1000);
      await addDecisionComment(db, a, { userId: ALPHA_ADMIN_ID }, "second on a", {}, 2000);
      await addDecisionComment(db, b, { label: "Fisqua" }, "only on b", {}, 1500);

      const threads = await listDecisionComments(db, [a, b]);
      expect(threads[a].map((c) => c.body)).toEqual(["first on a", "second on a"]);
      expect(threads[b]).toHaveLength(1);
    });

    it("commenting on a missing decision 404s", async () => {
      const db = drizzle(env.DB, { schema });
      await expect(
        addDecisionComment(db, crypto.randomUUID(), { label: "Fisqua" }, "x"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("a decision carrying comments cannot be hard-deleted (RESTRICT)", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });
      await addDecisionComment(db, id, { label: "Fisqua" }, "case file");

      await expect(
        db.delete(schema.pendingDecisions).where(eq(schema.pendingDecisions.id, id)),
      ).rejects.toThrow();
    });

    it("the DB rejects a comment with both an author user and a label", async () => {
      const db = drizzle(env.DB, { schema });
      const id = crypto.randomUUID();
      await seedProposal({ id, tenantId: ALPHA_TENANT_ID, payload: mintPayload() });

      await expect(
        db.insert(schema.comments).values({
          id: crypto.randomUUID(),
          tenantId: ALPHA_TENANT_ID,
          decisionId: id,
          authorId: ALPHA_ADMIN_ID,
          authorLabel: "Fisqua",
          text: "two authors",
          createdAt: 1,
          updatedAt: 1,
        }),
      ).rejects.toThrow();
    });
  });
});
