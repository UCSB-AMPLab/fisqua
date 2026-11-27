/**
 * Tests — former codes in the export
 *
 * This suite pins how the export writes the codes zasqua.org published
 * a record under before: `former_codes` on entities and places, read
 * from `legacy_ids` under `zasqua-2026-04`, including the retired codes
 * and current code of each record merged into the exported one, at the
 * end of a merge chain, with a looping chain carrying nothing, and never
 * a code the same file exports as current, whatever is merged while it
 * is written;
 * and `former_reference_codes` on descriptions, read under
 * `former-reference-code`, less any code a description holds now. A
 * record with none carries no field. The helpers are pinned on their
 * own first, then the three export steps against a real D1.
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
import {
  EntitiesChangedDuringPublishError,
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
import { MemoryStorage } from "./memory-storage";

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
      { id: "a", mergedInto: "b", code: "ne-aaaaaa", legacyIds: retired("ne-aaaaa") },
      { id: "b", mergedInto: "c", code: "ne-bbbbbb", legacyIds: retired("ne-bbbbb") },
      { id: "x", mergedInto: "y", code: "ne-xxxxxx", legacyIds: retired("ne-xxxxx") },
      { id: "y", mergedInto: "x", code: "ne-yyyyyy", legacyIds: retired("ne-yyyyy") },
      { id: "n", mergedInto: "c", code: null, legacyIds: "[]" },
    ]);
    expect(map.get("c")).toEqual(["ne-aaaaa", "ne-aaaaaa", "ne-bbbbb", "ne-bbbbbb"]);
    expect([...map.keys()]).toEqual(["c"]);
  });

  it("carries a merged record's own code when it has no retired code", () => {
    const map = mergedFormerCodes([
      { id: "m", mergedInto: "s", code: "ne-9x7nnq", legacyIds: null },
      { id: "k", mergedInto: "s", code: "ne-9x7nnq", legacyIds: "[]" },
    ]);
    expect(map.get("s")).toEqual(["ne-9x7nnq"]);
  });

  it("lists a record's own codes before inherited ones, never its current code", () => {
    expect(formerCodesFor("ne-cccccc", retired("ne-ccccc", "ne-cccccc"), ["ne-aaaaa", "ne-ccccc"])).toEqual([
      "ne-ccccc",
      "ne-aaaaa",
    ]);
  });

  it("never lists a code the same file exports as current", () => {
    expect(
      formerCodesFor("ne-ssssss", retired("ne-sssss"), ["ne-mmmmm", "ne-mmmmmm"], new Set(["ne-mmmmmm"]))
    ).toEqual(["ne-sssss", "ne-mmmmm"]);
  });

  it("never lists a survivor's current code among the codes it inherits", () => {
    const map = mergedFormerCodes([
      { id: "m", mergedInto: "s", code: "ne-mmmmmm", legacyIds: retired("ne-ssssss", "ne-mmmmm") },
    ]);
    expect(formerCodesFor("ne-ssssss", "[]", map.get("s"))).toEqual(["ne-mmmmm", "ne-mmmmmm"]);
  });
});

/** Storage that keeps the JSON text of each put. */
function memoryStorage() {
  const objects = new Map<string, string>();
  const storage = {
    putObject: async (key: string, body: string) => {
      objects.set(key, body);
    },
    // The descriptions file arrives as UTF-8 bytes from `JsonArrayUpload`.
    putObjectBytes: async (key: string, body: Uint8Array) => {
      objects.set(key, new TextDecoder().decode(body));
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
    expect(byCode.get("ne-aaszvt")!.former_codes).toEqual([
      "ne-u3ufz",
      "ne-b2b2b",
      "ne-bbbbbb",
      "ne-c3c3c",
      "ne-cccccc",
    ]);
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
    expect(byCode.get("nl-s9z5px")!.former_codes).toEqual(["nl-bkc9a", "nl-5mp87", "nl-nstfgb"]);
    expect(byCode.get("nl-kp3cv8")!.former_codes).toEqual(["nl-z9ruz"]);
  });

  it("carries the codes of a place merge chain to its end and drops a loop", async () => {
    const repo = await seedRepo(db);
    const desc = await seedDescription(db, repo, "co-x-001");
    const place = (code: string, legacyIds: string, mergedInto: string | null = null) => {
      const placeId = id();
      return db
        .insert(schema.places)
        .values({
          id: placeId,
          federationId: TENANT.federationId,
          placeCode: code,
          label: code,
          displayName: code,
          legacyIds,
          mergedInto,
          createdAt: now,
          updatedAt: now,
        })
        .then(() => placeId);
    };
    const survivor = await place("nl-ssssss", "[]");
    const middle = await place("nl-mmmmmm", "[]", survivor);
    await place("nl-ffffff", retired("nl-fffff"), middle);
    // Two records merged into each other: neither reaches a survivor.
    const x = await place("nl-xxxxxx", retired("nl-xxxxx"));
    const y = await place("nl-yyyyyy", "[]", x);
    await db.update(schema.places).set({ mergedInto: y }).where(eq(schema.places.id, x));
    await db.insert(schema.descriptionPlaces).values({
      id: id(),
      descriptionId: desc,
      placeId: survivor,
      role: "mentioned",
      createdAt: now,
    });

    const { storage, json } = memoryStorage();
    await exportPlaces(db, storage, TENANT);
    const rows = json("neogranadina/places.json") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].place_code).toBe("nl-ssssss");
    expect(rows[0].former_codes).toEqual(["nl-mmmmmm", "nl-fffff", "nl-ffffff"]);
  });

  it("never writes a place's code as a former code while the same file exports it", async () => {
    const repo = await seedRepo(db);
    const desc = await seedDescription(db, repo, "co-x-001");
    const place = (code: string, legacyIds: string) => {
      const placeId = id();
      return db
        .insert(schema.places)
        .values({
          id: placeId,
          federationId: TENANT.federationId,
          placeCode: code,
          label: code,
          displayName: code,
          legacyIds,
          createdAt: now,
          updatedAt: now,
        })
        .then(() => placeId);
    };
    const a = await place("nl-aaaaaa", retired("nl-aaaaa"));
    const b = await place("nl-bbbbbb", retired("nl-bbbbb"));
    // A record merged into A before the publish: its codes go to A.
    await db.insert(schema.places).values({
      id: id(),
      federationId: TENANT.federationId,
      placeCode: "nl-cccccc",
      label: "nl-cccccc",
      displayName: "nl-cccccc",
      legacyIds: "[]",
      mergedInto: a,
      createdAt: now,
      updatedAt: now,
    });
    for (const placeId of [a, b]) {
      await db.insert(schema.descriptionPlaces).values({
        id: id(),
        descriptionId: desc,
        placeId,
        role: "mentioned",
        createdAt: now,
      });
    }

    const { storage, json } = memoryStorage();
    await exportPlaces(db, storage, TENANT, undefined, {
      hooks: {
        // A is merged into B after the file's places are read.
        beforeMergedRead: async () => {
          await db.update(schema.places).set({ mergedInto: b }).where(eq(schema.places.id, a));
        },
      },
    });
    const rows = json("neogranadina/places.json") as Array<Record<string, unknown>>;
    const byCode = new Map(rows.map((r) => [r.place_code, r]));
    expect([...byCode.keys()].sort()).toEqual(["nl-aaaaaa", "nl-bbbbbb"]);
    expect(byCode.get("nl-aaaaaa")!.former_codes).toEqual(["nl-aaaaa", "nl-cccccc"]);
    expect(byCode.get("nl-bbbbbb")!.former_codes).toEqual(["nl-bbbbb"]);
  });

  it("refuses the entities file when a merged entity's code would be exported as current and as former", async () => {
    const repo = await seedRepo(db);
    const desc = await seedDescription(db, repo, "co-x-001");
    const entity = (code: string, mergedInto: string | null) => {
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
          legacyIds: "[]",
          mergedInto,
          createdAt: now,
          updatedAt: now,
        })
        .then(() => entityId);
    };
    // B sorts before A, so B is written, carrying A's code, before A is read.
    const b = await entity("ne-bbbbbb", null);
    const a = await entity("ne-aaaaaa", b);
    for (const entityId of [a, b]) {
      await db.insert(schema.descriptionEntities).values({
        id: id(),
        descriptionId: desc,
        entityId,
        role: "subject",
        createdAt: now,
      });
    }

    const storage = new MemoryStorage();
    const previous = new TextEncoder().encode("[]");
    storage.objects.set("neogranadina/entities.json", previous);
    const err = await exportEntities(db, storage as unknown as ExportStorage, TENANT, undefined, {
      batchSize: 1,
      hooks: {
        // A is unmerged after B's batch is written.
        beforeBatch: async (i) => {
          if (i === 1) await db.update(schema.entities).set({ mergedInto: null }).where(eq(schema.entities.id, a));
        },
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EntitiesChangedDuringPublishError);
    expect(storage.objects.get("neogranadina/entities.json")).toEqual(previous);
    expect(storage.uploads.size).toBe(0);
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

// @version v0.9.0
