/**
 * Tests — pipeline EAD3 + Dublin Core step functions
 *
 * This suite pins `exportFondsEad` and `exportFondsDc`, the per-fonds
 * pipeline step functions that wire the EAD3 builder and the Dublin Core
 * builder into the publish pipeline. These tests cover the happy
 * path (positive recordCount + byteSize, slug-prefixed R2 key with an
 * XML content type, expected XML root element), the empty-fonds edge
 * case (no root matching `referenceCode + tenantId` → empty body,
 * recordCount 0), legacy ids parsed into `<unitid localtype>`, the
 * profile picked from the tenant's descriptive standard, and only
 * published rows counted.
 *
 * The steps read the fonds in batches and write through a multipart
 * upload, so the suite runs them against the test D1 and an in-memory
 * storage rather than a stub that answers a fixed sequence of queries.
 * Byte identity with the single-string builders, change detection and
 * query plans are pinned in `fonds-xml-upload.test.ts`.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportFondsEad,
  exportFondsDc,
} from "../../app/lib/export/pipeline.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";
import { MemoryStorage } from "./memory-storage";

const TEST_TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const now = 1_700_000_000_000;
const REPO = "00000000-0000-4000-8000-000000000001";

type Row = typeof schema.descriptions.$inferInsert;

async function seed(rows: Array<Partial<Row> & { id: string; referenceCode: string }>) {
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.repositories).values({
    id: REPO, tenantId: TEST_TENANT.id, code: "co-ahr", name: "Archivo Histórico de Rionegro",
    city: "Rionegro", enabled: true, createdAt: now, updatedAt: now,
  });
  const rootId = rows[0].id;
  for (const r of rows) {
    await db.insert(schema.descriptions).values({
      tenantId: TEST_TENANT.id,
      repositoryId: REPO,
      parentId: r.id === rootId ? null : rootId,
      rootDescriptionId: rootId,
      descriptionLevel: r.id === rootId ? "fonds" : "file",
      title: "Fondo Gobernación",
      dateExpression: "1810-1850",
      extent: "50 cajas",
      creatorDisplay: "Gobernación de Antioquia",
      scopeContent: "Records of the colonial governorship",
      language: "spa",
      placeDisplay: "Antioquia",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
      ...r,
    });
  }
}

const db = () => drizzle(env.DB, { schema });
const asStorage = (s: MemoryStorage) => s as unknown as ExportStorage;

beforeAll(async () => {
  await applyMigrations();
});

// ---------------------------------------------------------------------------
// exportFondsEad
// ---------------------------------------------------------------------------

describe("exportFondsEad", () => {
  let storage: MemoryStorage;
  beforeEach(async () => {
    await cleanDatabase();
    storage = new MemoryStorage();
  });

  it("uploads ead/<ref>.xml under the tenant's slug prefix and returns positive counts", async () => {
    await seed([{ id: "00000000-0000-4000-8000-000000000010", referenceCode: "co-ahr-gob" }]);

    const result = await exportFondsEad(db(), asStorage(storage), "co-ahr-gob", TEST_TENANT);

    expect(result.recordCount).toBe(1);
    expect(result.byteSize).toBeGreaterThan(0);
    expect([...storage.objects.keys()]).toEqual(["neogranadina/ead/co-ahr-gob.xml"]);
    const xml = storage.text("neogranadina/ead/co-ahr-gob.xml")!;
    expect(result.byteSize).toBe(new TextEncoder().encode(xml).length);
    expect(storage.contentTypes.get("neogranadina/ead/co-ahr-gob.xml")).toBe("application/xml; charset=utf-8");
    expect(xml).toContain('<ead xmlns="http://ead3.archivists.org/schema/"');
    expect(xml).toContain("<unitid>co-ahr-gob</unitid>");
  });

  it("strips URL-syntactic chars from the reference code in the R2 key", async () => {
    await seed([{ id: "00000000-0000-4000-8000-000000000010", referenceCode: "co-ahr-gob?weird#hash" }]);

    await exportFondsEad(db(), asStorage(storage), "co-ahr-gob?weird#hash", TEST_TENANT);

    // sanitiseRefForKey removes ? and # before the key is composed.
    expect([...storage.objects.keys()]).toEqual(["neogranadina/ead/co-ahr-gobweirdhash.xml"]);
  });

  it("emits an empty-shell document and returns recordCount 0 when the fonds root is missing", async () => {
    const result = await exportFondsEad(db(), asStorage(storage), "missing", TEST_TENANT);

    expect(result.recordCount).toBe(0);
    expect(result.byteSize).toBe(0);
    expect([...storage.objects.keys()]).toEqual(["neogranadina/ead/missing.xml"]);
    expect(storage.text("neogranadina/ead/missing.xml")).toBe("");
  });

  it("parses legacyIds JSON text from the row before handing rows to the builder", async () => {
    await seed([
      {
        id: "00000000-0000-4000-8000-000000000010",
        referenceCode: "co-ahr-gob",
        legacyIds: JSON.stringify([{ provider: "ca", id: "12345" }]),
      },
    ]);

    await exportFondsEad(db(), asStorage(storage), "co-ahr-gob", TEST_TENANT);

    // Secondary <unitid localtype="..."> emitted from the parsed legacyIds.
    expect(storage.text("neogranadina/ead/co-ahr-gob.xml")).toContain('<unitid localtype="ca">12345</unitid>');
  });

  it("uses the tenant's descriptiveStandard to pick the EAD profile", async () => {
    // RAD profile turns includeSystemOfArrangement on; ISAD(G) leaves it off.
    const radTenant: ExportTenant = { ...TEST_TENANT, slug: "rad-archive", descriptiveStandard: "rad" };
    await seed([
      {
        id: "00000000-0000-4000-8000-000000000010",
        referenceCode: "ca-mcg-fonds",
        systemOfArrangement: "Arranged in five series, original order",
      },
    ]);

    await exportFondsEad(db(), asStorage(storage), "ca-mcg-fonds", radTenant);
    const xml = storage.text("rad-archive/ead/ca-mcg-fonds.xml")!;
    expect(xml).toContain("<arrangement>");
    expect(xml).toContain("Arranged in five series");

    await exportFondsEad(db(), asStorage(storage), "ca-mcg-fonds", TEST_TENANT);
    expect(storage.text("neogranadina/ead/ca-mcg-fonds.xml")).not.toContain("<arrangement>");
  });
});

// ---------------------------------------------------------------------------
// exportFondsDc
// ---------------------------------------------------------------------------

describe("exportFondsDc", () => {
  let storage: MemoryStorage;
  beforeEach(async () => {
    await cleanDatabase();
    storage = new MemoryStorage();
  });

  it("uploads dc/<ref>.xml under the tenant's slug prefix and returns positive counts", async () => {
    await seed([{ id: "00000000-0000-4000-8000-000000000010", referenceCode: "co-ahr-gob" }]);

    const result = await exportFondsDc(db(), asStorage(storage), "co-ahr-gob", TEST_TENANT);

    expect(result.recordCount).toBe(1);
    expect(result.byteSize).toBeGreaterThan(0);
    expect([...storage.objects.keys()]).toEqual(["neogranadina/dc/co-ahr-gob.xml"]);
    expect(storage.contentTypes.get("neogranadina/dc/co-ahr-gob.xml")).toBe("application/xml; charset=utf-8");
    const xml = storage.text("neogranadina/dc/co-ahr-gob.xml")!;
    expect(xml).toContain("<ListRecords");
    expect(xml).toContain("<dc:title>Fondo Gobernación</dc:title>");
  });

  it("strips URL-syntactic chars from the reference code in the R2 key", async () => {
    await seed([{ id: "00000000-0000-4000-8000-000000000010", referenceCode: "co-ahr-gob?weird#hash" }]);

    await exportFondsDc(db(), asStorage(storage), "co-ahr-gob?weird#hash", TEST_TENANT);

    expect([...storage.objects.keys()]).toEqual(["neogranadina/dc/co-ahr-gobweirdhash.xml"]);
  });

  it("emits an empty-shell document and returns recordCount 0 when the fonds root is missing", async () => {
    const result = await exportFondsDc(db(), asStorage(storage), "missing", TEST_TENANT);

    expect(result.recordCount).toBe(0);
    expect(result.byteSize).toBe(0);
    expect([...storage.objects.keys()]).toEqual(["neogranadina/dc/missing.xml"]);
    expect(storage.text("neogranadina/dc/missing.xml")).toBe("");
  });

  it("only counts published rows in the returned recordCount", async () => {
    // Fonds root is published, but its single descendant is not.
    await seed([
      { id: "00000000-0000-4000-8000-000000000010", referenceCode: "co-ahr-gob" },
      { id: "00000000-0000-4000-8000-000000000011", referenceCode: "co-ahr-gob-f1", isPublished: false },
    ]);

    const result = await exportFondsDc(db(), asStorage(storage), "co-ahr-gob", TEST_TENANT);
    expect(result.recordCount).toBe(1);
    expect(storage.text("neogranadina/dc/co-ahr-gob.xml")).not.toContain("co-ahr-gob-f1");
  });
});

// @version v0.9.0
