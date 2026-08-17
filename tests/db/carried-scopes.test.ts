/**
 * Tests — carried scopes
 *
 * Covers `app/lib/carried-scopes.server.ts`, the stash that hands a
 * search selection forward to the export surface. What is pinned here
 * is everything the two calling surfaces cannot check for themselves:
 * that what a person ticked is what gets stored, that "all matching"
 * means the FACETED set and not the tab's number, that the tenant
 * boundary survives being crossed twice (once when the set is
 * materialised, once when it is read back), that the cap refuses
 * rather than truncates, and that a stashed scope is invisible to
 * everyone but the person who made it.
 *
 * THE TWO MODES ARE TESTED AGAINST DIFFERENT RISKS. `ids` mode is
 * trusted arithmetic — the list is taken as given, so the pins are
 * about deduplication, verbatim storage and the count following the
 * list. `all` mode is a real read, so its pins are about the read
 * being the SAME read the results page ran: a facet narrows it, an
 * exclusion subtracts from it with no MATCH clause to hide behind, the
 * authority scope holds for entities and places, and a merged-away
 * record never arrives. A carry whose membership drifted from what the
 * person was looking at is the failure this file exists to catch.
 *
 * ONE PIN IS ABOUT A DELIBERATE ABSENCE. `ids` mode does not
 * re-validate its members against the tenant, and the test that proves
 * it says so in as many words, because a reader who found that out
 * from the code alone would reasonably file it as a bug. The contract
 * it implies belongs to the consuming surface, and is stated there.
 *
 * FIXTURES. The request tenant (Neogranadina), a SIBLING tenant inside
 * the same federation — the neighbour whose records and authorities
 * must never materialise — and the second test tenant in a second
 * federation, which serves as the foreign workspace the read gate is
 * measured against. Marker words are unique to the group they
 * interrogate (`tunjuelo` for the faceted record set, `quiba`/`usme`/
 * `sumapaz` for the browse playground, `suamox` for entities,
 * `cachipay` for places), so one scenario's counts cannot be moved by
 * another's rows. The search fixtures are read-only and seeded once;
 * the carried_scopes rows the tests write are measured against a
 * before-and-after read rather than a wipe between tests.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { parseSearch } from "../../app/lib/search-query";
import {
  stashCarriedScope,
  getCarriedScope,
  CARRIED_SCOPE_MAX_MEMBERS,
} from "../../app/lib/carried-scopes.server";
import type { StashCarriedScopeInput } from "../../app/lib/carried-scopes.server";
import type { Tenant, User } from "../../app/context";

const TENANT_A = NEOGRANADINA_TENANT_ID;
const FED_A = NEOGRANADINA_FEDERATION_ID;
const TENANT_B = SECOND_TEST_TENANT_ID;
const FED_B = SECOND_TEST_FEDERATION_ID;

/** A third tenant, inside the request tenant's own federation. */
const SIBLING_TENANT_ID = "7a7a0000-0000-4000-8000-00000000000a";

const REPO_MAIN = "7b000000-0000-4000-8000-000000000001";
/** The browse playground: a facet on it isolates its three records. */
const REPO_BROWSE = "7b000000-0000-4000-8000-000000000002";
const REPO_SIBLING = "7b000000-0000-4000-8000-000000000003";

/**
 * The faceted trio, all three on the marker word `tunjuelo`: two items
 * and one file, so a level facet narrows three matches to two and the
 * difference between the tab count and the faceted total is visible.
 * The sibling's copy carries the same word from across the boundary.
 */
const D_ITEM_ONE = "7c000000-0000-4000-8000-000000000001";
const D_ITEM_TWO = "7c000000-0000-4000-8000-000000000002";
const D_FILE_ONE = "7c000000-0000-4000-8000-000000000003";
const D_SIBLING = "7c000000-0000-4000-8000-000000000004";

/** The browse trio, ordered by reference code, one of them excludable. */
const D_QUIBA = "7c000000-0000-4000-8000-000000000005";
const D_USME = "7c000000-0000-4000-8000-000000000006";
const D_SUMAPAZ = "7c000000-0000-4000-8000-000000000007";

/**
 * The authority set, one record per arm of the visibility rule: the
 * federation's shared record, the tenant's own, the sibling's, another
 * federation's, and one merged away.
 */
const E_SHARED = "7d000000-0000-4000-8000-000000000001";
const E_OWN = "7d000000-0000-4000-8000-000000000002";
const E_SIBLING = "7d000000-0000-4000-8000-000000000003";
const E_OTHER_FED = "7d000000-0000-4000-8000-000000000004";
const E_MERGED = "7d000000-0000-4000-8000-000000000005";

const P_SHARED = "7e000000-0000-4000-8000-000000000001";
const P_OWN = "7e000000-0000-4000-8000-000000000002";
const P_SIBLING = "7e000000-0000-4000-8000-000000000003";
const P_MERGED = "7e000000-0000-4000-8000-000000000004";

/** The person who makes every carry, and a colleague beside them. */
const OWNER_ID = "7f000000-0000-4000-8000-000000000001";
const COLLEAGUE_ID = "7f000000-0000-4000-8000-000000000002";

function db() {
  return drizzle(env.DB, { schema });
}

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

const owner = makeUser({ id: OWNER_ID, tenantId: TENANT_A });
const colleague = makeUser({ id: COLLEAGUE_ID, tenantId: TENANT_A });

async function loadTenant(id: string): Promise<Tenant> {
  const row = await db()
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, id))
    .get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function seedTenant(id: string, slug: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, slug, slug, "tenant", "isadg", "active", 0, 1, 0, 0, null, FED_A, now, now)
    .run();
}

async function seedUser(id: string, tenantId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, tenantId, `${id}@test.local`, 0, now, now)
    .run();
}

async function seedRepository(id: string, tenantId: string, code: string): Promise<void> {
  const now = Date.now();
  await db().insert(schema.repositories).values({
    id,
    tenantId,
    code,
    name: `Repository ${code}`,
    countryCode: "COL",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedDescription(values: {
  id: string;
  tenantId: string;
  repositoryId: string;
  referenceCode: string;
  title: string;
  level?: (typeof schema.descriptions.$inferInsert)["descriptionLevel"];
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.descriptions).values({
    id: values.id,
    tenantId: values.tenantId,
    repositoryId: values.repositoryId,
    descriptionLevel: values.level ?? "item",
    referenceCode: values.referenceCode,
    title: values.title,
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEntity(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
  mergedInto?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.entities).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    entityCode: `ne-${values.id.slice(-6)}`,
    displayName: values.displayName,
    sortName: values.displayName.toLowerCase(),
    entityType: "person",
    mergedInto: values.mergedInto ?? null,
    nameVariants: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlace(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
  mergedInto?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.places).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    placeCode: `nl-${values.id.slice(-6)}`,
    label: values.displayName,
    displayName: values.displayName,
    mergedInto: values.mergedInto ?? null,
    nameVariants: "[]",
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedFixtures(): Promise<void> {
  await seedTenant(SIBLING_TENANT_ID, "cs-sibling");
  await seedUser(OWNER_ID, TENANT_A);
  await seedUser(COLLEAGUE_ID, TENANT_A);

  await seedRepository(REPO_MAIN, TENANT_A, "CS-MAIN");
  await seedRepository(REPO_BROWSE, TENANT_A, "CS-BRW");
  await seedRepository(REPO_SIBLING, SIBLING_TENANT_ID, "CS-SIB");

  // The faceted trio. Two items and one file on one marker word, so a
  // level facet is the difference between three and two.
  await seedDescription({
    id: D_ITEM_ONE,
    tenantId: TENANT_A,
    repositoryId: REPO_MAIN,
    referenceCode: "CS-T01",
    title: "Tunjuelo, cuentas de fábrica",
    level: "item",
  });
  await seedDescription({
    id: D_ITEM_TWO,
    tenantId: TENANT_A,
    repositoryId: REPO_MAIN,
    referenceCode: "CS-T02",
    title: "Tunjuelo, cuentas de cofradía",
    level: "item",
  });
  await seedDescription({
    id: D_FILE_ONE,
    tenantId: TENANT_A,
    repositoryId: REPO_MAIN,
    referenceCode: "CS-T03",
    title: "Tunjuelo, expediente de tierras",
    level: "file",
  });
  // The neighbour's copy of the same word, from across the boundary.
  await seedDescription({
    id: D_SIBLING,
    tenantId: SIBLING_TENANT_ID,
    repositoryId: REPO_SIBLING,
    referenceCode: "CS-T04",
    title: "Tunjuelo, padrón ajeno",
    level: "item",
  });

  // The browse playground, ordered by reference code — the browse
  // default — with one record an exclusion can subtract.
  await seedDescription({
    id: D_QUIBA,
    tenantId: TENANT_A,
    repositoryId: REPO_BROWSE,
    referenceCode: "CS-B01",
    title: "Vereda Quiba",
  });
  await seedDescription({
    id: D_USME,
    tenantId: TENANT_A,
    repositoryId: REPO_BROWSE,
    referenceCode: "CS-B02",
    title: "Vereda Usme",
  });
  await seedDescription({
    id: D_SUMAPAZ,
    tenantId: TENANT_A,
    repositoryId: REPO_BROWSE,
    referenceCode: "CS-B03",
    title: "Vereda Sumapaz",
  });

  await seedEntity({
    id: E_SHARED,
    federationId: FED_A,
    tenantId: null,
    displayName: "Ana Suamox",
  });
  await seedEntity({
    id: E_OWN,
    federationId: FED_A,
    tenantId: TENANT_A,
    displayName: "Bruno Suamox",
  });
  await seedEntity({
    id: E_SIBLING,
    federationId: FED_A,
    tenantId: SIBLING_TENANT_ID,
    displayName: "Clara Suamox",
  });
  await seedEntity({
    id: E_OTHER_FED,
    federationId: FED_B,
    tenantId: TENANT_B,
    displayName: "Diego Suamox",
  });
  await seedEntity({
    id: E_MERGED,
    federationId: FED_A,
    tenantId: TENANT_A,
    displayName: "Elena Suamox",
    mergedInto: E_OWN,
  });

  await seedPlace({
    id: P_SHARED,
    federationId: FED_A,
    tenantId: null,
    displayName: "Cachipay Alto",
  });
  await seedPlace({
    id: P_OWN,
    federationId: FED_A,
    tenantId: TENANT_A,
    displayName: "Cachipay Bajo",
  });
  await seedPlace({
    id: P_SIBLING,
    federationId: FED_A,
    tenantId: SIBLING_TENANT_ID,
    displayName: "Cachipay Medio",
  });
  await seedPlace({
    id: P_MERGED,
    federationId: FED_A,
    tenantId: TENANT_A,
    displayName: "Cachipay Viejo",
    mergedInto: P_OWN,
  });
}

/** Every stored scope, so a test can prove a refusal wrote nothing. */
async function scopeRows() {
  return await db().select().from(schema.carriedScopes).all();
}

/** One stored row, read raw — the JSON columns as they were written. */
async function scopeRow(id: string) {
  const row = await db()
    .select()
    .from(schema.carriedScopes)
    .where(eq(schema.carriedScopes.id, id))
    .get();
  if (!row) throw new Error(`carried scope ${id} not stored`);
  return row;
}

/** An `all`-mode carry of one category, under one set of facets. */
function allOf(
  recordType: StashCarriedScopeInput["recordType"],
  query: StashCarriedScopeInput["query"],
  constraints: StashCarriedScopeInput["constraints"] = [],
): StashCarriedScopeInput {
  return { recordType, mode: "all", constraints, query };
}

describe("carried scopes", () => {
  let tenantA: Tenant;
  let tenantB: Tenant;
  let sibling: Tenant;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedFixtures();
    tenantA = await loadTenant(TENANT_A);
    tenantB = await loadTenant(TENANT_B);
    sibling = await loadTenant(SIBLING_TENANT_ID);
  });

  describe("stashing a ticked list", () => {
    it("stores exactly the ticked ids, deduplicated, and counts them", async () => {
      const id = await stashCarriedScope(db(), owner, tenantA, {
        recordType: "records",
        mode: "ids",
        // The middle id arrives twice, as a re-render can tick it: a
        // member counted twice would inflate the promise.
        ids: [D_ITEM_ONE, D_FILE_ONE, D_ITEM_ONE, D_ITEM_TWO],
        constraints: [],
        query: { input: parseSearch(["tunjuelo"]), facets: {} },
      });

      const row = await scopeRow(id);
      // Order is the order the page showed, minus the repeat.
      expect(JSON.parse(row.memberIds)).toEqual([D_ITEM_ONE, D_FILE_ONE, D_ITEM_TWO]);
      expect(row.total).toBe(3);
      expect(row.recordType).toBe("records");
      expect(row.tenantId).toBe(TENANT_A);
      expect(row.userId).toBe(OWNER_ID);
    });

    it("keeps the pills verbatim and leaves the scope unspent", async () => {
      const constraints = [
        { label: "tunjuelo" },
        { label: "Nivel: unidad documental" },
        { label: "1750–1780" },
      ];
      const id = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        {
          recordType: "records",
          mode: "ids",
          ids: [D_ITEM_ONE, D_ITEM_TWO],
          constraints,
          query: { input: parseSearch(["tunjuelo"]), facets: { levels: ["item"] } },
        },
        1_700_000_000_000,
      );

      const row = await scopeRow(id);
      // The summary is display-only, so what was handed in is what is
      // held: the labels in order, beside the total they were shown with.
      expect(JSON.parse(row.constraintSummary)).toEqual({
        pills: constraints,
        total: 2,
      });
      expect(row.createdAt).toBe(1_700_000_000_000);
      // Spending a scope belongs to the export surface, not to the stash.
      expect(row.consumedAt).toBeNull();
    });

    it("takes the ticked ids as given, without re-checking the tenant", async () => {
      // PINNED DELIBERATELY. `ids` mode trusts its caller: the sibling
      // tenant's record id below is stored verbatim, because the stash
      // does not re-run the search to validate membership. The contract
      // this implies belongs downstream — the consuming surface (4c)
      // MUST read the members under its own tenant scope rather than
      // treating a stored id as proof of visibility. If that read ever
      // stops scoping, this row is how a foreign record leaves the
      // workspace, and this test is where the reason is written down.
      const id = await stashCarriedScope(db(), owner, tenantA, {
        recordType: "records",
        mode: "ids",
        ids: [D_ITEM_ONE, D_SIBLING],
        constraints: [],
        query: { input: parseSearch(["tunjuelo"]), facets: {} },
      });

      const stored = await getCarriedScope(db(), tenantA, owner, id);
      expect(stored.memberIds).toEqual([D_ITEM_ONE, D_SIBLING]);
      expect(stored.total).toBe(2);
    });
  });

  describe("materialising the whole matching set", () => {
    it("materialises the faceted set, not the number on the tab", async () => {
      const unfaceted = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        allOf("records", { input: parseSearch(["tunjuelo"]), facets: {} }),
      );
      const wholeSet = await getCarriedScope(db(), tenantA, owner, unfaceted);
      expect(wholeSet.total).toBe(3);
      expect([...wholeSet.memberIds].sort()).toEqual(
        [D_ITEM_ONE, D_ITEM_TWO, D_FILE_ONE].sort(),
      );

      const faceted = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        allOf("records", {
          input: parseSearch(["tunjuelo"]),
          facets: { levels: ["item"] },
        }),
      );
      const narrowed = await getCarriedScope(db(), tenantA, owner, faceted);
      // Three records answer the question; the level facet is what the
      // person was looking at, so two is what the carry promises.
      expect(narrowed.total).toBe(2);
      expect([...narrowed.memberIds].sort()).toEqual([D_ITEM_ONE, D_ITEM_TWO].sort());
      expect(narrowed.memberIds).not.toContain(D_FILE_ONE);
      // The stored total and the member count answer different
      // questions, and for a well-formed carry they agree.
      expect(narrowed.total).toBe(narrowed.memberIds.length);
    });

    it("carries a browse read, exclusion and all", async () => {
      // No positive term at all: the read has no MATCH clause to hide
      // behind, and the exclusion has to subtract from a scoped browse.
      const id = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        allOf("records", {
          input: parseSearch(["-sumapaz"]),
          facets: { repoIds: [REPO_BROWSE] },
        }),
      );

      const stored = await getCarriedScope(db(), tenantA, owner, id);
      expect(stored.total).toBe(2);
      // Browse order is reference code ascending, which is the order
      // the page showed and therefore the order stored.
      expect(stored.memberIds).toEqual([D_QUIBA, D_USME]);
      expect(stored.memberIds).not.toContain(D_SUMAPAZ);
    });

    it("never materialises the neighbour's records", async () => {
      const mine = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        allOf("records", { input: parseSearch(["tunjuelo"]), facets: {} }),
      );
      const ours = await getCarriedScope(db(), tenantA, owner, mine);
      expect(ours.memberIds).not.toContain(D_SIBLING);

      // And from the other side of the boundary, the same question
      // reaches exactly the one record that tenant owns.
      const theirs = await stashCarriedScope(
        db(),
        makeUser({ id: OWNER_ID, tenantId: SIBLING_TENANT_ID }),
        sibling,
        allOf("records", { input: parseSearch(["tunjuelo"]), facets: {} }),
      );
      const stored = await getCarriedScope(db(), sibling, owner, theirs);
      expect(stored.total).toBe(1);
      expect(stored.memberIds).toEqual([D_SIBLING]);
    });

    it("holds the authority scope, and skips a record merged away", async () => {
      const id = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        allOf("entities", { input: parseSearch(["suamox"]), facets: {} }),
      );

      const stored = await getCarriedScope(db(), tenantA, owner, id);
      expect(stored.recordType).toBe("entities");
      expect(stored.total).toBe(2);
      // The federation's shared record and the tenant's own — and
      // nothing else the marker word touches.
      expect([...stored.memberIds].sort()).toEqual([E_SHARED, E_OWN].sort());
      expect(stored.memberIds).not.toContain(E_SIBLING);
      expect(stored.memberIds).not.toContain(E_OTHER_FED);
      expect(stored.memberIds).not.toContain(E_MERGED);

      // The three absences above are only worth something if the rows
      // they name are really in the index, so each is read from the
      // context that CAN see it. The sibling's own carry reaches its
      // record and the federation's shared one; the other federation's
      // carry reaches its own and nothing of this one's.
      const theirs = await getCarriedScope(
        db(),
        sibling,
        owner,
        await stashCarriedScope(
          db(),
          makeUser({ id: OWNER_ID, tenantId: SIBLING_TENANT_ID }),
          sibling,
          allOf("entities", { input: parseSearch(["suamox"]), facets: {} }),
        ),
      );
      expect([...theirs.memberIds].sort()).toEqual([E_SHARED, E_SIBLING].sort());

      const acrossFederations = await getCarriedScope(
        db(),
        tenantB,
        owner,
        await stashCarriedScope(
          db(),
          makeUser({ id: OWNER_ID, tenantId: TENANT_B }),
          tenantB,
          allOf("entities", { input: parseSearch(["suamox"]), facets: {} }),
        ),
      );
      expect(acrossFederations.memberIds).toEqual([E_OTHER_FED]);
      // E_MERGED shares the seeding path the four visible rows above
      // came through, so its absence is the merge rule, not a fixture
      // that never reached the index.
    });

    it("reads places under the same rule", async () => {
      const id = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        allOf("places", { input: parseSearch(["cachipay"]), facets: {} }),
      );

      const stored = await getCarriedScope(db(), tenantA, owner, id);
      expect(stored.recordType).toBe("places");
      expect(stored.total).toBe(2);
      expect([...stored.memberIds].sort()).toEqual([P_SHARED, P_OWN].sort());
      expect(stored.memberIds).not.toContain(P_SIBLING);
      expect(stored.memberIds).not.toContain(P_MERGED);
    });
  });

  describe("the cap on membership", () => {
    it("refuses an oversized selection with a 400 that names the cap, storing nothing", async () => {
      const before = await scopeRows();
      const tooMany = Array.from(
        { length: CARRIED_SCOPE_MAX_MEMBERS + 1 },
        (_, i) => `7ffffff0-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );

      const error = await stashCarriedScope(db(), owner, tenantA, {
        recordType: "records",
        mode: "ids",
        ids: tooMany,
        constraints: [],
        query: { input: parseSearch(["tunjuelo"]), facets: {} },
      }).catch((e) => e);

      expect(error).toBeInstanceOf(Response);
      expect(error.status).toBe(400);
      const body = await error.text();
      // The number is in the refusal, so a person reading it knows how
      // far past the cap they are rather than guessing.
      expect(body).toContain(String(CARRIED_SCOPE_MAX_MEMBERS));
      expect(body).toContain(String(CARRIED_SCOPE_MAX_MEMBERS + 1));

      // Refused, not truncated: no row at all.
      expect(await scopeRows()).toEqual(before);
    });

    it("accepts a selection exactly at the cap", async () => {
      const atCap = Array.from(
        { length: CARRIED_SCOPE_MAX_MEMBERS },
        (_, i) => `7fffffff-0000-4000-8000-${String(i).padStart(12, "0")}`,
      );

      const id = await stashCarriedScope(db(), owner, tenantA, {
        recordType: "records",
        mode: "ids",
        ids: atCap,
        constraints: [],
        query: { input: parseSearch(["tunjuelo"]), facets: {} },
      });

      const stored = await getCarriedScope(db(), tenantA, owner, id);
      expect(stored.total).toBe(CARRIED_SCOPE_MAX_MEMBERS);
      expect(stored.memberIds).toHaveLength(CARRIED_SCOPE_MAX_MEMBERS);
    });
  });

  describe("reading a scope back", () => {
    it("hands the owner the whole shape", async () => {
      const constraints = [{ label: "tunjuelo" }, { label: "Nivel: unidad documental" }];
      const id = await stashCarriedScope(
        db(),
        owner,
        tenantA,
        {
          recordType: "records",
          mode: "all",
          constraints,
          query: {
            input: parseSearch(["tunjuelo"]),
            facets: { levels: ["item"] },
          },
        },
        1_700_000_000_001,
      );

      const stored = await getCarriedScope(db(), tenantA, owner, id);
      expect(stored).toEqual({
        id,
        recordType: "records",
        constraints,
        memberIds: stored.memberIds,
        total: 2,
        // An all-mode stash prunes nothing, so the faceted found count
        // equals the materialised total (the field arrived with the
        // export surface's pruned-arithmetic contract, phase 4c).
        found: 2,
        // A carry made from a search has no browse surface to name.
        origin: null,
        createdAt: 1_700_000_000_001,
        consumedAt: null,
      });
      expect([...stored.memberIds].sort()).toEqual([D_ITEM_ONE, D_ITEM_TWO].sort());
    });

    it("404s for a colleague, for another workspace, and for an id that never existed", async () => {
      const id = await stashCarriedScope(db(), owner, tenantA, {
        recordType: "records",
        mode: "ids",
        ids: [D_ITEM_ONE],
        constraints: [],
        query: { input: parseSearch(["tunjuelo"]), facets: {} },
      });

      // Someone else in the same workspace: an unconsumed selection is
      // nobody else's business.
      const otherUser = await getCarriedScope(db(), tenantA, colleague, id).catch(
        (e) => e,
      );
      // The same person, reading from another workspace's context.
      const otherTenant = await getCarriedScope(db(), tenantB, owner, id).catch((e) => e);
      // A scope that was never made.
      const missing = await getCarriedScope(
        db(),
        tenantA,
        owner,
        "7f0f0f0f-0000-4000-8000-00000000ffff",
      ).catch((e) => e);

      for (const refusal of [otherUser, otherTenant, missing]) {
        expect(refusal).toBeInstanceOf(Response);
        expect(refusal.status).toBe(404);
      }
      // Indistinguishable by design: the same status and the same body,
      // so a refusal never reports that the scope exists.
      const bodies = await Promise.all(
        [otherUser, otherTenant, missing].map((r: Response) => r.text()),
      );
      expect(new Set(bodies).size).toBe(1);

      // And the owner still reads it, so the gate refused rather than
      // the row being absent.
      expect((await getCarriedScope(db(), tenantA, owner, id)).memberIds).toEqual([
        D_ITEM_ONE,
      ]);
    });
  });
});
