/**
 * Tests — agency-scoped authority code prefixes
 *
 * An entity or place code is an agency prefix, a hyphen, and six
 * characters. The prefix names the agency that MAINTAINS the record, and
 * migration 0068 moved it out of the code generator — where it was a
 * hardcoded `ne`/`nl`, Neogranadina's mark on every institution's
 * records — into a stored pair of columns on `federations` and
 * `tenants`. This suite holds the three halves of that change against
 * regression.
 *
 * THE FORMAT RULE (`AUTHORITY_CODE_RE`)
 *   The validators can no longer pin one institution's literal, so they
 *   pin the SHAPE: a prefix of lowercase letters, digits and hyphens,
 *   then exactly six characters from the real 30-character alphabet. The
 *   first block checks both directions — `ne-abc234` and
 *   `sbmal-e-abc234` in, a character the generator never emits out — and
 *   walks the alphabet against the character class so the two cannot
 *   drift apart.
 *
 * CHOOSING THE AGENCY (`resolveAuthorityCodePrefix`)
 *   The prefix comes from the owner `requireAuthorityMint` resolved, so
 *   the same shared-versus-owned test decides who may mint and whose
 *   mark goes on the result. A shared mint takes the federation's
 *   prefix; a tenant-owned one takes the minting tenant's. The tests
 *   drive the two through `requireAuthorityMint` itself rather than
 *   passing an owner by hand, because the point is that the two
 *   decisions cannot diverge.
 *
 *   An agency with no prefix configured is a hard failure, not a
 *   fallback: minting under a default would put another institution's
 *   name on the record permanently and silently, which is the defect
 *   0068 exists to end.
 *
 * THE REGRESSION THAT MATTERS
 *   Neogranadina's series must not shift. Its ~78K existing codes are
 *   citable identifiers and its NEW mints have to keep landing in the
 *   same series, so the last block asserts that a mint in its shared
 *   space still produces `ne-xxxxxx` in exactly the old shape.
 *
 * Fixtures mirror `tests/admin/authority-ownership.test.ts`: member
 * tenants inside the Neogranadina federation, one of them (MISSION)
 * standing in for SBMAL with a prefix pair of its own.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import {
  generateUniqueCode,
  resolveAuthorityCodePrefix,
} from "../../app/lib/codes.server";
import { requireAuthorityMint } from "../../app/lib/authority-ownership.server";
import {
  AUTHORITY_CODE_ALPHABET,
  AUTHORITY_CODE_CHAR_CLASS,
  AUTHORITY_CODE_RE,
} from "../../app/lib/validation/authority-code";
import { entitySchema } from "../../app/lib/validation/entity";
import { placeSchema } from "../../app/lib/validation/place";
import type { Tenant, User } from "../../app/context";

// MISSION stands in for SBMAL: a member tenant that mints its own
// authority records and carries its own prefix pair. PLAIN is a member
// tenant with no prefix configured — the state every agency is in until
// somebody provisions it.
const MISSION_TENANT_ID = "0a1a0000-0000-4000-8000-0000000000e1";
const PLAIN_TENANT_ID = "0b1b0000-0000-4000-8000-0000000000e2";

const LEAD_ADMIN_ID = "0c000000-0000-4000-8000-0000000000e1";
const MISSION_ADMIN_ID = "0c000000-0000-4000-8000-0000000000e2";
const PLAIN_ADMIN_ID = "0c000000-0000-4000-8000-0000000000e3";

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

async function seedTenant(
  id: string,
  slug: string,
  entityPrefix: string | null,
  placePrefix: string | null,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, entity_code_prefix, place_code_prefix, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id, slug, slug, "tenant", "dacs", "active",
      0, 1, 0, 0, null, NEOGRANADINA_FEDERATION_ID,
      entityPrefix, placePrefix, now, now,
    )
    .run();
}

async function seedFixtures(): Promise<void> {
  const now = Date.now();
  await seedTenant(MISSION_TENANT_ID, "mission-tenant", "sbmal-e", "sbmal-p");
  await seedTenant(PLAIN_TENANT_ID, "plain-tenant", null, null);

  const users: Array<[string, string]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID],
    [MISSION_ADMIN_ID, MISSION_TENANT_ID],
    [PLAIN_ADMIN_ID, PLAIN_TENANT_ID],
  ];
  for (const [id, tenantId] of users) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, 1, now, now)
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

async function setSharedAuthorities(enabled: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE federations SET shared_authorities_enabled = ? WHERE id = ?",
  )
    .bind(enabled ? 1 : 0, NEOGRANADINA_FEDERATION_ID)
    .run();
}

describe("agency-scoped authority code prefixes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFixtures();
  });

  // -------------------------------------------------------------------
  // The format rule
  // -------------------------------------------------------------------

  describe("the code format", () => {
    it("accepts both agency forms, entity and place", () => {
      for (const code of [
        "ne-abc234",
        "nl-abc234",
        "sbmal-e-abc234",
        "sbmal-p-abc234",
      ]) {
        expect(AUTHORITY_CODE_RE.test(code)).toBe(true);
      }
      expect(entitySchema.shape.entityCode.safeParse("ne-abc234").success).toBe(
        true,
      );
      expect(
        entitySchema.shape.entityCode.safeParse("sbmal-e-abc234").success,
      ).toBe(true);
      expect(placeSchema.shape.placeCode.safeParse("nl-abc234").success).toBe(
        true,
      );
      expect(
        placeSchema.shape.placeCode.safeParse("sbmal-p-abc234").success,
      ).toBe(true);
    });

    it("rejects a character the generator never emits", () => {
      // i, l, o, u, 0 and 1 are outside the alphabet; the old
      // `[a-z2-9]` class wrongly admitted the four letters.
      for (const code of [
        "ne-abci23",
        "ne-abcl23",
        "ne-abco23",
        "ne-abcu23",
        "sbmal-e-abci23",
      ]) {
        expect(AUTHORITY_CODE_RE.test(code)).toBe(false);
        expect(entitySchema.shape.entityCode.safeParse(code).success).toBe(
          false,
        );
      }
    });

    it("rejects a code with no prefix at all", () => {
      for (const code of ["abc234", "-abc234", "abc234-"]) {
        expect(AUTHORITY_CODE_RE.test(code)).toBe(false);
      }
    });

    it("rejects the wrong number of characters after the prefix", () => {
      for (const code of [
        "ne-abc23",
        "ne-abc2345",
        "sbmal-e-abc23",
        "sbmal-e-abc2345",
      ]) {
        expect(AUTHORITY_CODE_RE.test(code)).toBe(false);
      }
    });

    it("rejects uppercase, empty prefix segments, and stray punctuation", () => {
      for (const code of [
        "NE-abc234",
        "ne-ABC234",
        "ne--abc234",
        "-ne-abc234",
        "ne_abc234",
        "sbmal e-abc234",
        "sbmal-e-abc 234",
      ]) {
        expect(AUTHORITY_CODE_RE.test(code)).toBe(false);
      }
    });

    it("the character class enumerates the generator's alphabet exactly", () => {
      const cls = new RegExp(`^${AUTHORITY_CODE_CHAR_CLASS}$`);
      expect(AUTHORITY_CODE_ALPHABET).toHaveLength(30);
      for (const ch of AUTHORITY_CODE_ALPHABET) {
        expect(cls.test(ch)).toBe(true);
      }
      for (const ch of "ilou01") {
        expect(cls.test(ch)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------
  // Choosing the agency at mint
  // -------------------------------------------------------------------

  describe("choosing the agency at mint", () => {
    it("a shared mint takes the federation's prefix", async () => {
      const db = drizzle(env.DB);
      await setSharedAuthorities(true);
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });

      const owner = await requireAuthorityMint(db, leadAdmin, lead);
      expect(owner).toBeNull();

      await expect(
        resolveAuthorityCodePrefix(db, "entity", lead.federationId, owner),
      ).resolves.toBe("ne");
      await expect(
        resolveAuthorityCodePrefix(db, "place", lead.federationId, owner),
      ).resolves.toBe("nl");
    });

    it("a tenant-owned mint takes the minting tenant's prefix", async () => {
      const db = drizzle(env.DB);
      await setSharedAuthorities(false);
      const mission = await loadTenant(MISSION_TENANT_ID);
      const missionAdmin = makeUser({
        id: MISSION_ADMIN_ID,
        tenantId: MISSION_TENANT_ID,
        isAdmin: true,
      });

      const owner = await requireAuthorityMint(db, missionAdmin, mission);
      expect(owner).toBe(MISSION_TENANT_ID);

      await expect(
        resolveAuthorityCodePrefix(db, "entity", mission.federationId, owner),
      ).resolves.toBe("sbmal-e");
      await expect(
        resolveAuthorityCodePrefix(db, "place", mission.federationId, owner),
      ).resolves.toBe("sbmal-p");
    });

    it("the owner decides, not the request tenant", async () => {
      // The same tenant, minting into a SHARED space, marks the record
      // with the federation's prefix — its own pair is irrelevant there,
      // because the federation is the agency maintaining the record.
      const db = drizzle(env.DB);
      const mission = await loadTenant(MISSION_TENANT_ID);
      await expect(
        resolveAuthorityCodePrefix(db, "entity", mission.federationId, null),
      ).resolves.toBe("ne");
    });

    it("mints codes that carry the resolved prefix and pass validation", async () => {
      const db = drizzle(env.DB);
      const entityCode = await generateUniqueCode(
        db,
        "sbmal-e",
        schema.entities,
        schema.entities.entityCode,
      );
      const placeCode = await generateUniqueCode(
        db,
        "sbmal-p",
        schema.places,
        schema.places.placeCode,
      );
      expect(entityCode).toMatch(/^sbmal-e-[a-hjkmnp-tv-z2-9]{6}$/);
      expect(placeCode).toMatch(/^sbmal-p-[a-hjkmnp-tv-z2-9]{6}$/);
      expect(entitySchema.shape.entityCode.safeParse(entityCode).success).toBe(
        true,
      );
      expect(placeSchema.shape.placeCode.safeParse(placeCode).success).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------
  // No prefix configured
  // -------------------------------------------------------------------

  describe("an agency with no prefix configured fails loudly", () => {
    it("throws for a federation with no prefix rather than minting one", async () => {
      const db = drizzle(env.DB);
      await expect(
        resolveAuthorityCodePrefix(
          db,
          "entity",
          SECOND_TEST_FEDERATION_ID,
          null,
        ),
      ).rejects.toThrow(/No entity code prefix configured for federations row/);
    });

    it("throws for a tenant with no prefix, naming the column to fill", async () => {
      const db = drizzle(env.DB);
      await expect(
        resolveAuthorityCodePrefix(
          db,
          "place",
          NEOGRANADINA_FEDERATION_ID,
          PLAIN_TENANT_ID,
        ),
      ).rejects.toThrow(/tenants\.place_code_prefix/);
    });

    it("treats a blank prefix as no prefix", async () => {
      const db = drizzle(env.DB);
      await env.DB.prepare(
        "UPDATE tenants SET entity_code_prefix = ' ' WHERE id = ?",
      )
        .bind(PLAIN_TENANT_ID)
        .run();
      await expect(
        resolveAuthorityCodePrefix(
          db,
          "entity",
          NEOGRANADINA_FEDERATION_ID,
          PLAIN_TENANT_ID,
        ),
      ).rejects.toThrow(/No entity code prefix configured/);
    });

    it("throws for an agency row that does not exist at all", async () => {
      const db = drizzle(env.DB);
      await expect(
        resolveAuthorityCodePrefix(
          db,
          "entity",
          "00000000-0000-4000-8000-000000000000",
          null,
        ),
      ).rejects.toThrow(/No entity code prefix configured/);
    });
  });

  // -------------------------------------------------------------------
  // Neogranadina's series is unchanged
  // -------------------------------------------------------------------

  describe("Neogranadina's series does not shift", () => {
    it("the seeded federation carries the prefixes it has always minted", async () => {
      const db = drizzle(env.DB);
      const fed = await db
        .select({
          entityPrefix: schema.federations.entityCodePrefix,
          placePrefix: schema.federations.placeCodePrefix,
        })
        .from(schema.federations)
        .where(eq(schema.federations.id, NEOGRANADINA_FEDERATION_ID))
        .get();
      expect(fed?.entityPrefix).toBe("ne");
      expect(fed?.placePrefix).toBe("nl");
    });

    it("a new mint in its shared space still produces ne-/nl- codes", async () => {
      const db = drizzle(env.DB);
      await setSharedAuthorities(true);
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      const leadAdmin = makeUser({
        id: LEAD_ADMIN_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
      });
      const owner = await requireAuthorityMint(db, leadAdmin, lead);

      for (let i = 0; i < 5; i++) {
        const entityCode = await generateUniqueCode(
          db,
          await resolveAuthorityCodePrefix(
            db,
            "entity",
            lead.federationId,
            owner,
          ),
          schema.entities,
          schema.entities.entityCode,
        );
        const placeCode = await generateUniqueCode(
          db,
          await resolveAuthorityCodePrefix(
            db,
            "place",
            lead.federationId,
            owner,
          ),
          schema.places,
          schema.places.placeCode,
        );
        // The pre-0068 shape, character for character.
        expect(entityCode).toMatch(/^ne-[a-hjkmnp-tv-z2-9]{6}$/);
        expect(placeCode).toMatch(/^nl-[a-hjkmnp-tv-z2-9]{6}$/);
      }
    });
  });
});
