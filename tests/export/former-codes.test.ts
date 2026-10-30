/**
 * Tests — former codes in the export
 *
 * This suite pins how the export writes the codes zasqua.org published
 * a record under before: `former_codes` on entities and places, read
 * from `legacy_ids` under `zasqua-2026-04`, including the codes of
 * records merged into the exported one, at the end of a merge chain;
 * and `former_reference_codes` on descriptions, read under
 * `former-reference-code`, less any code a description holds now. A
 * record with none carries no field. The helpers are pinned on their
 * own first, then the three export steps against a real D1.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportEntities,
  exportFondsDescriptions,
  exportPlaces,
} from "../../app/lib/export/pipeline.server";
import {
  formerCodesFor,
  legacyIdsOf,
  mergedFormerCodes,
} from "../../app/lib/export/former-codes.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

const retired = (...codes: string[]) =>
  JSON.stringify([
    { provider: "django-zasqua", id: 101 },
    ...codes.map((id) => ({ provider: "zasqua-2026-04", id })),
  ]);
const formerRef = (...codes: string[]) =>
  JSON.stringify(codes.map((id) => ({ provider: "former-reference-code", id })));

describe("former-code helpers", () => {
  it("reads one provider's ids in recorded order, once each", () => {
    const text = JSON.stringify([
      { provider: "zasqua-2026-04", id: "ne-b2c3d" },
      { provider: "django-zasqua", id: 7 },
      { provider: "zasqua-2026-04", id: "ne-x9y8z" },
      { provider: "zasqua-2026-04", id: "ne-b2c3d" },
    ]);
    expect(legacyIdsOf(text, "zasqua-2026-04")).toEqual(["ne-b2c3d", "ne-x9y8z"]);
    expect(legacyIdsOf(text, "django-zasqua")).toEqual(["7"]);
  });

  it("reads nothing from empty, malformed or non-array text", () => {
    expect(legacyIdsOf(null, "zasqua-2026-04")).toEqual([]);
    expect(legacyIdsOf("not json", "zasqua-2026-04")).toEqual([]);
    expect(legacyIdsOf('{"provider":"zasqua-2026-04"}', "zasqua-2026-04")).toEqual([]);
    expect(legacyIdsOf('[{"provider":"zasqua-2026-04","id":""}]', "zasqua-2026-04")).toEqual([]);
  });

  it("gives a merged record's codes to the end of its chain and drops a loop", () => {
    const map = mergedFormerCodes([
      { id: "a", mergedInto: "b", legacyIds: retired("ne-aaaaa") },
      { id: "b", mergedInto: "c", legacyIds: retired("ne-bbbbb") },
      { id: "x", mergedInto: "y", legacyIds: retired("ne-xxxxx") },
      { id: "y", mergedInto: "x", legacyIds: retired("ne-yyyyy") },
      { id: "n", mergedInto: "c", legacyIds: "[]" },
    ]);
    expect(map.get("c")).toEqual(["ne-aaaaa", "ne-bbbbb"]);
    expect([...map.keys()]).toEqual(["c"]);
  });

  it("lists a record's own codes before inherited ones, never its current code", () => {
    expect(formerCodesFor("ne-cccccc", retired("ne-ccccc", "ne-cccccc"), ["ne-aaaaa", "ne-ccccc"])).toEqual([
      "ne-ccccc",
      "ne-aaaaa",
    ]);
  });
});

/** Storage that keeps the JSON text of each put. */
function memoryStorage() {
  const objects = new Map<string, string>();
  const storage = {
    putObject: async (key: string, body: string) => {
      objects.set(key, body);
    },
  } as unknown as ExportStorage;
  return { storage, json: (key: string) => JSON.parse(objects.get(key)!) };
}

type Db = ReturnType<typeof drizzle>;
const now = Date.now();
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function seedRepo(db: Db, tenantId = TENANT.id, code = "co-x") {
  const repoId = id();
  await db.insert(schema.repositories).values({
    id: repoId,
    tenantId,
    code,
    name: code,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return repoId;
}

async function seedDescription(
  db: Db,
  repositoryId: string,
  referenceCode: string,
  extra: Partial<typeof schema.descriptions.$inferInsert> = {}
) {
  const descId = id();
  await db.insert(schema.descriptions).values({
    id: descId,
    tenantId: TENANT.id,
    ...("tenantId" in extra ? { tenantId: extra.tenantId } : {}),
    repositoryId,
    parentId: null,
    rootDescriptionId: descId,
    descriptionLevel: "file",
    referenceCode,
    title: `Title of ${referenceCode}`,
    isPublished: true,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return descId;
}

describe("former codes in the export files", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("writes former_codes on entities, with the codes of records merged into them", async () => {
    const repo = await seedRepo(db);
    const desc = await seedDescription(db, repo, "co-x-001");
    const entity = (
      code: string,
      legacyIds: string,
      mergedInto: string | null = null,
      tenantId: string | null = null
    ) => {
      const entityId = id();
      return db
        .insert(schema.entities)
        .values({
          id: entityId,
          federationId: TENANT.federationId,
          entityCode: code,
          displayName: code,
          sortName: code,
          entityType: "person",
          legacyIds,
          mergedInto,
          tenantId,
          createdAt: now,
          updatedAt: now,
        })
        .then(() => entityId);
    };
    const survivor = await entity("ne-aaszvt", retired("ne-u3ufz"));
    const middle = await entity("ne-bbbbbb", retired("ne-b2b2b"), survivor);
    await entity("ne-cccccc", retired("ne-c3c3c"), middle);
    // Owned by a tenant outside this export's scope: not read.
    await entity("ne-eeeeee", retired("ne-e5e5e"), survivor, SECOND_TEST_TENANT_ID);
    const plain = await entity("ne-dddddd", "[]");
    for (const entityId of [survivor, plain]) {
      await db.insert(schema.descriptionEntities).values({
        id: id(),
        descriptionId: desc,
        entityId,
        role: "subject",
        createdAt: now,
      });
    }

    const { storage, json } = memoryStorage();
    await exportEntities(db, storage, TENANT);
    const rows = json("neogranadina/entities.json") as Array<Record<string, unknown>>;
    const byCode = new Map(rows.map((r) => [r.entity_code, r]));
    expect(rows).toHaveLength(2);
    expect(byCode.get("ne-aaszvt")!.former_codes).toEqual(["ne-u3ufz", "ne-b2b2b", "ne-c3c3c"]);
    expect(byCode.get("ne-dddddd")).not.toHaveProperty("former_codes");
  });

  it("writes former_codes on places, including a code recorded without a place of its own", async () => {
    const repo = await seedRepo(db);
    const desc = await seedDescription(db, repo, "co-x-001");
    const place = (code: string, label: string, legacyIds: string, mergedInto: string | null = null) => {
      const placeId = id();
      return db
        .insert(schema.places)
        .values({
          id: placeId,
          federationId: TENANT.federationId,
          placeCode: code,
          label,
          displayName: label,
          legacyIds,
          mergedInto,
          createdAt: now,
          updatedAt: now,
        })
        .then(() => placeId);
    };
    const zipaquira = await place("nl-s9z5px", "Zipaquirá", retired("nl-bkc9a"));
    await place("nl-nstfgb", "Zipaquira", retired("nl-5mp87"), zipaquira);
    const palma = await place("nl-kp3cv8", "Palma", retired("nl-z9ruz"));
    for (const placeId of [zipaquira, palma]) {
      await db.insert(schema.descriptionPlaces).values({
        id: id(),
        descriptionId: desc,
        placeId,
        role: "mentioned",
        createdAt: now,
      });
    }

    const { storage, json } = memoryStorage();
    await exportPlaces(db, storage, TENANT);
    const rows = json("neogranadina/places.json") as Array<Record<string, unknown>>;
    const byCode = new Map(rows.map((r) => [r.place_code, r]));
    expect(rows).toHaveLength(2);
    expect(byCode.get("nl-s9z5px")!.former_codes).toEqual(["nl-bkc9a", "nl-5mp87"]);
    expect(byCode.get("nl-kp3cv8")!.former_codes).toEqual(["nl-z9ruz"]);
  });

  it("writes former_reference_codes, leaving out a code a description holds now", async () => {
    const repo = await seedRepo(db);
    const root = await seedDescription(db, repo, "co-x", { descriptionLevel: "fonds" });
    await seedDescription(db, repo, "co-x-caj103", {
      parentId: root,
      rootDescriptionId: root,
      legacyIds: formerRef("co-x-caj102"),
    });
    await seedDescription(db, repo, "co-x-caj104", {
      parentId: root,
      rootDescriptionId: root,
      // co-x-caj103 is live: history only, no redirect.
      legacyIds: formerRef("co-x-caj103", "co-x-caj104?"),
    });
    await seedDescription(db, repo, "co-x-caj105", { parentId: root, rootDescriptionId: root });

    const { storage, json } = memoryStorage();
    await exportFondsDescriptions(db, storage, "co-x", TENANT);
    const rows = json("neogranadina/descriptions-co-x.json") as Array<Record<string, unknown>>;
    const byRef = new Map(rows.map((r) => [r.reference_code, r]));
    expect(byRef.get("co-x-caj103")!.former_reference_codes).toEqual(["co-x-caj102"]);
    expect(byRef.get("co-x-caj104")!.former_reference_codes).toEqual(["co-x-caj104?"]);
    expect(byRef.get("co-x-caj105")).not.toHaveProperty("former_reference_codes");
    expect(byRef.get("co-x")).not.toHaveProperty("former_reference_codes");
  });

  it("leaves out a former reference code another member tenant holds now", async () => {
    const repo = await seedRepo(db);
    const root = await seedDescription(db, repo, "co-x", { descriptionLevel: "fonds" });
    await seedDescription(db, repo, "co-x-001", {
      parentId: root,
      rootDescriptionId: root,
      legacyIds: formerRef("co-y-001", "co-x-001?"),
    });
    const other = await seedRepo(db, SECOND_TEST_TENANT_ID, "co-y");
    await seedDescription(db, other, "co-y-001", { tenantId: SECOND_TEST_TENANT_ID });

    const { storage, json } = memoryStorage();
    await exportFondsDescriptions(db, storage, "co-x", TENANT, [TENANT.id, SECOND_TEST_TENANT_ID]);
    const rows = json("neogranadina/descriptions-co-x.json") as Array<Record<string, unknown>>;
    const child = rows.find((r) => r.reference_code === "co-x-001")!;
    expect(child.former_reference_codes).toEqual(["co-x-001?"]);
  });

  it("checks many former codes against a large federation within D1's parameter limit", async () => {
    const repo = await seedRepo(db);
    const root = await seedDescription(db, repo, "co-x", { descriptionLevel: "fonds" });
    const codes = Array.from({ length: 95 }, (_, i) => `co-x-old${i}`);
    await seedDescription(db, repo, "co-x-001", {
      parentId: root,
      rootDescriptionId: root,
      legacyIds: formerRef(...codes, "co-x"),
    });
    const members = [TENANT.id, ...Array.from({ length: 15 }, (_, i) => `member-${i}`)];

    const { storage, json } = memoryStorage();
    await exportFondsDescriptions(db, storage, "co-x", TENANT, members);
    const rows = json("neogranadina/descriptions-co-x.json") as Array<Record<string, unknown>>;
    const child = rows.find((r) => r.reference_code === "co-x-001")!;
    expect(child.former_reference_codes).toEqual(codes);
  });
});
