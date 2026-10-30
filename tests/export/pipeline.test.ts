/**
 * Tests — pipeline
 *
 * This suite pins the export pipeline's per-step contract: every
 * pipeline step takes a `tenant: ExportTenant` argument. The
 * mock-DB tests below pass a fixed test tenant (`TEST_TENANT`) and
 * assert the slug-prefixed key shape; the cross-tenant data-leak
 * coverage lives in `tests/export/cross-tenant.test.ts` against a
 * real D1 binding.
 *
 * The `ocr_text` field is read from each description's OCR page rows,
 * not from the description row. The cases at the end seed a real D1 to
 * pin that source: a migrated page-1 row is exported as it stands and
 * wins over the column, pages written by a pipeline run are exported
 * joined in page order with a blank line between pages, a description
 * with no pages exports an empty string, and another tenant's pages
 * never reach the file. `readExportOcrText`, which the workspace JSON
 * and canonical CSV exports read through, is pinned the same way.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import * as descriptionsServer from "../../app/lib/export/descriptions.server";
import { readExportOcrText } from "../../app/lib/export/rows.server";
import {
  exportFondsDescriptions,
  exportFondsChildren,
  exportRepositories,
  exportEntities,
  exportPlaces,
  recordStepStart,
  recordStepEnd,
} from "../../app/lib/export/pipeline.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

const TEST_TENANT: ExportTenant = {
  id: "test-tenant-id",
  federationId: "b4462493-6170-44f8-ae07-24666606d1f1", // NEOGRANADINA_FEDERATION_ID
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

/**
 * Tests for the per-step pure functions introduced in 23-06.
 *
 * The legacy `runExportPipeline` orchestration is gone — that responsibility
 * lives in the PublishExportWorkflow now (Task 3). These tests cover each
 * extracted step function in isolation, with a chainable mock DB that can
 * be configured per query.
 */

function mockStorage() {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    putObjectStream: vi.fn().mockResolvedValue(undefined),
    getObjectStream: vi.fn().mockResolvedValue(null),
    getObjectHead: vi.fn().mockResolvedValue(null),
  } as unknown as ExportStorage & {
    putObject: ReturnType<typeof vi.fn>;
  };
}

function makeDescRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "desc-001",
    repositoryId: "repo-001",
    parentId: null as string | null,
    position: 0,
    rootDescriptionId: "root-001",
    depth: 0,
    childCount: 0,
    pathCache: "",
    descriptionLevel: "file",
    resourceType: null,
    genre: "[]",
    referenceCode: "co-ahr-gob-caj001-car001",
    localIdentifier: "GOB-001",
    title: "Test description",
    translatedTitle: null,
    uniformTitle: null,
    dateExpression: "1810",
    dateStart: "1810-01-01",
    dateEnd: null,
    dateCertainty: null,
    extent: "1 folio",
    dimensions: null,
    medium: null,
    imprint: null,
    editionStatement: null,
    seriesStatement: null,
    volumeNumber: null,
    issueNumber: null,
    pages: null,
    provenance: null,
    scopeContent: "Test scope",
    arrangement: null,
    accessConditions: null,
    reproductionConditions: null,
    language: "192",
    locationOfOriginals: null,
    locationOfCopies: null,
    // related_materials dropped in 0036 (0% populated).
    findingAids: null,
    sectionTitle: null,
    notes: null,
    internalNotes: null,
    creatorDisplay: null,
    placeDisplay: null,
    iiifManifestUrl: null,
    hasDigital: false,
    isPublished: true,
    createdBy: null,
    updatedBy: null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

/**
 * A minimal Drizzle-shaped mock that resolves the next configured response
 * for `.get()` / `.all()`. Each `db.select(...)` call advances an internal
 * cursor; tests provide an ordered list of responses.
 */
function createMockDb(responses: unknown[]) {
  let cursor = 0;
  const updateCalls: Array<{ values: any }> = [];

  function chain(method: "select" | "selectDistinct" | "update") {
    const c: any = {
      from: () => c,
      where: () => c,
      innerJoin: () => c,
      orderBy: () => c,
      limit: () => c,
      groupBy: () => c,
      set: (values: any) => {
        c._setValues = values;
        return c;
      },
      get: () => Promise.resolve(responses[cursor++] ?? null),
      all: () => Promise.resolve((responses[cursor++] ?? []) as unknown[]),
      then: undefined as any,
    };
    if (method === "update") {
      c.then = (resolve: (v: undefined) => void) => {
        updateCalls.push({ values: c._setValues });
        resolve(undefined);
      };
    }
    return c;
  }

  const db: any = {
    select: () => chain("select"),
    selectDistinct: () => chain("selectDistinct"),
    update: () => chain("update"),
    _updateCalls: updateCalls,
    _cursor: () => cursor,
  };
  return db;
}

describe("exportFondsDescriptions", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uploads descriptions-{fonds}.json with the formatted rows and returns recordCount + byteSize", async () => {
    const desc = makeDescRow({ id: "d1", referenceCode: "co-ahr-gob-001" });
    const db = createMockDb([
      { id: "root-1" }, // root lookup
      [desc],          // fonds rows
      [],              // migrated OCR page rows
      { code: "co-ahr", country: "Colombia" }, // repo lookup
    ]);

    const result = await exportFondsDescriptions(db, storage, "co-ahr-gob", TEST_TENANT);

    expect(result.recordCount).toBe(1);
    expect(result.byteSize).toBeGreaterThan(0);
    const calls = (storage.putObject as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("neogranadina/descriptions-co-ahr-gob.json");
    const body = JSON.parse(calls[0][1]);
    expect(body).toHaveLength(1);
    expect(body[0].reference_code).toBe("co-ahr-gob-001");
  });

  it("uploads an empty array and returns recordCount=0 when the fonds root does not exist", async () => {
    const db = createMockDb([null]); // root lookup returns null
    const result = await exportFondsDescriptions(db, storage, "missing", TEST_TENANT);

    expect(result.recordCount).toBe(0);
    expect(result.byteSize).toBe(2); // "[]"
    expect((storage.putObject as any).mock.calls[0][0]).toBe(
      "neogranadina/descriptions-missing.json"
    );
    expect((storage.putObject as any).mock.calls[0][1]).toBe("[]");
  });

  it("does NOT touch a global accumulator across fonds", async () => {
    // Independence assertion: two separate calls to exportFondsDescriptions
    // must not share state — each call uploads exactly one per-fonds key
    // and never the combined descriptions.json key.
    const desc = makeDescRow({ id: "d1" });
    const db1 = createMockDb([{ id: "root-1" }, [desc], [], { code: "co-ahr", country: "Colombia" }]);
    const db2 = createMockDb([{ id: "root-2" }, [desc], [], { code: "co-ahr", country: "Colombia" }]);

    await exportFondsDescriptions(db1, storage, "co-ahr-gob", TEST_TENANT);
    await exportFondsDescriptions(db2, storage, "co-ahr-jud", TEST_TENANT);

    const keys = (storage.putObject as any).mock.calls.map((c: any[]) => c[0]);
    expect(keys).toEqual([
      "neogranadina/descriptions-co-ahr-gob.json",
      "neogranadina/descriptions-co-ahr-jud.json",
    ]);
    expect(keys).not.toContain("descriptions.json");
  });
});

describe("exportFondsChildren", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("batches PUTs at 50 concurrent, never exceeding parent count", async () => {
    // 130 parents → 3 batches of 50/50/30. Total PUTs = 130 (one per parent
    // in childrenMap). Without batching this would be a single Promise.all of
    // 130, but the public surface is "<= parent count, batched". The test
    // asserts the count and that all keys are children/* keys.
    const parents = Array.from({ length: 130 }, (_, i) => ({
      id: `p${i}`,
      parentId: "root-1",
      referenceCode: `ref-${i}`,
      title: `T${i}`,
      descriptionLevel: "file",
      dateExpression: null,
      childCount: 1, // each parent has one child to ensure it shows up in childrenMap
      hasDigital: false,
      position: i,
    }));
    // Add a child for each parent so childrenMap has entries
    const children = parents.map((p, i) => ({
      id: `c${i}`,
      parentId: p.id,
      referenceCode: `child-${i}`,
      title: `Child ${i}`,
      descriptionLevel: "file",
      dateExpression: null,
      childCount: 0,
      hasDigital: false,
      position: 0,
    }));

    const db = createMockDb([
      { id: "root-1" },          // root lookup
      [...parents, ...children], // fonds rows
    ]);

    const result = await exportFondsChildren(db, storage, "co-ahr-gob", TEST_TENANT);

    const keys = (storage.putObject as any).mock.calls.map((c: any[]) => c[0]);
    // Every PUT must be a slug-prefixed children/* key
    expect(keys.every((k: string) => k.startsWith("neogranadina/children/"))).toBe(true);
    // No more PUTs than parents
    expect(keys.length).toBeLessThanOrEqual(parents.length);
    expect(result.parentCount).toBeLessThanOrEqual(parents.length);
    expect(result.putCount).toBe(keys.length);
  });

  it("returns 0/0 when the fonds root is missing and issues no PUTs", async () => {
    const db = createMockDb([null]);
    const result = await exportFondsChildren(db, storage, "missing", TEST_TENANT);
    expect(result).toEqual({ parentCount: 0, putCount: 0 });
    expect((storage.putObject as any).mock.calls).toHaveLength(0);
  });
});

describe("exportRepositories", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uses a lightweight count query and only formats the (small) root description set", async () => {
    const formatSpy = vi.spyOn(descriptionsServer, "formatDescription");
    const db = createMockDb([
      // 1) enabled repos
      [
        {
          id: "repo-1",
          code: "co-ahr",
          name: "Archivo Histórico de Rionegro",
          shortName: "AHR",
          countryCode: "COL",
          country: "Colombia",
          city: "Rionegro",
          address: null,
          website: null,
        },
      ],
      // 2) GROUP BY count
      [{ repositoryId: "repo-1", n: 12345 }],
      // 3) root descriptions (one per fonds — small set)
      [makeDescRow({ id: "root-1", referenceCode: "co-ahr-gob", parentId: null })],
    ]);

    const result = await exportRepositories(db, storage, TEST_TENANT);

    expect(result.count).toBe(1);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/repositories.json"
    );
    expect(call).toBeDefined();
    const body = JSON.parse(call[1]);
    expect(body).toHaveLength(1);
    expect(body[0].code).toBe("co-ahr");
    // count came from the GROUP BY, not from formatting all 12345 descriptions
    expect(body[0].description_count).toBe(12345);
    // formatDescription was called only for the root set (1 row), not 12345
    expect(formatSpy).toHaveBeenCalledTimes(1);
    formatSpy.mockRestore();
  });
});

describe("exportEntities", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uploads only entities linked to published descriptions", async () => {
    // Single JOIN query returns distinct entities (see exportEntities impl).
    const db = createMockDb([
      [
        {
          id: "ent-1",
          entityCode: "ne-000001",
          displayName: "Entity One",
          sortName: "Entity One",
          givenName: null,
          surname: null,
          entityType: "person",
          honorific: null,
          primaryFunction: null,
          nameVariants: "[]",
          datesOfExistence: null,
          dateStart: null,
          dateEnd: null,
          history: null,
          functions: null,
          sources: null,
          wikidataId: null,
          viafId: null,
          mergedInto: null,
        },
      ],
    ]);

    const result = await exportEntities(db, storage, TEST_TENANT);
    expect(result.count).toBe(1);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/entities.json"
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call[1])[0].entity_code).toBe("ne-000001");
  });

  it("uploads an empty array when no entities are linked", async () => {
    const db = createMockDb([[]]);
    const result = await exportEntities(db, storage, TEST_TENANT);
    expect(result.count).toBe(0);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/entities.json"
    );
    expect(call[1]).toBe("[]");
  });
});

describe("exportPlaces", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uploads only places linked to published descriptions", async () => {
    // Single JOIN query returns distinct places (see exportPlaces impl).
    const db = createMockDb([
      [
        {
          id: "pl-1",
          placeCode: "nl-000001",
          label: "Rionegro",
          displayName: "Rionegro",
          placeType: "city",
          nameVariants: "[]",
          latitude: 6.15,
          longitude: -75.37,
          coordinatePrecision: "exact",
          // historical_*, country_code, admin_level_*, wikidata_id all
          // dropped on places in 0036.
          fclass: "P" as "P" | "H" | "A" | "T" | "S" | null,
          tgnId: null,
          hgisId: null,
          whgId: null,
          mergedInto: null,
        },
      ],
    ]);

    const result = await exportPlaces(db, storage, TEST_TENANT);
    expect(result.count).toBe(1);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/places.json"
    );
    expect(JSON.parse(call[1])[0].place_code).toBe("nl-000001");
  });
});

describe("recordStepStart / recordStepEnd", () => {
  it("recordStepStart writes currentStep, currentStepStartedAt, and lastHeartbeatAt", async () => {
    const db = createMockDb([]);
    await recordStepStart(db, "exp-1", "descriptions:co-ahr-gob");
    const call = db._updateCalls[0];
    expect(call.values.currentStep).toBe("descriptions:co-ahr-gob");
    expect(call.values.currentStepStartedAt).toBeTypeOf("number");
    expect(call.values.lastHeartbeatAt).toBeTypeOf("number");
    expect(call.values.currentStepCompletedAt).toBeNull();
  });

  it("recordStepEnd writes currentStepCompletedAt and a fresh lastHeartbeatAt", async () => {
    const db = createMockDb([]);
    await recordStepEnd(db, "exp-1", "descriptions:co-ahr-gob", { foo: 1 });
    const call = db._updateCalls[0];
    expect(call.values.currentStepCompletedAt).toBeTypeOf("number");
    expect(call.values.lastHeartbeatAt).toBeTypeOf("number");
    expect(call.values.recordCounts).toBe(JSON.stringify({ foo: 1 }));
  });
});

describe("legacy entry point removal", () => {
  it("does NOT export runExportPipeline", async () => {
    const mod = await import("../../app/lib/export/pipeline.server");
    expect((mod as any).runExportPipeline).toBeUndefined();
    expect((mod as any).updateProgress).toBeUndefined();
  });
});

describe("exportFondsDescriptions reads ocr_text from the page rows", () => {
  const ROOT_A = "0d000000-0000-4000-8000-0000000000f0";
  const FONDS = "pe-bn-cdip";

  beforeEach(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedOcrFixtures();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO descriptions (id, tenant_id, repository_id, description_level, reference_code, title, is_published, created_at, updated_at) VALUES (?, ?, ?, 'fonds', ?, 'Fondo', 1, ?, ?)",
    ).bind(ROOT_A, OCR_IDS.tenantA, OCR_IDS.repoA, FONDS, now, now).run();
    await env.DB.prepare(
      "UPDATE descriptions SET root_description_id = ?, parent_id = ?, is_published = 1 WHERE id IN (?, ?, ?)",
    ).bind(ROOT_A, ROOT_A, OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descA3).run();
    await env.DB.prepare("UPDATE descriptions SET is_published = 1 WHERE id = ?").bind(OCR_IDS.descB1).run();
  });

  async function setColumn(id: string, text: string): Promise<void> {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('descriptions')").all<{ name: string }>();
    if (!cols.results.some((c) => c.name === "ocr_text")) return;
    await env.DB.prepare("UPDATE descriptions SET ocr_text = ? WHERE id = ?").bind(text, id).run();
  }

  async function exportA(): Promise<Map<string, string>> {
    const storage = mockStorage();
    await exportFondsDescriptions(getTestDb(), storage, FONDS, {
      ...TEST_TENANT, id: OCR_IDS.tenantA,
    });
    const body = JSON.parse((storage.putObject as any).mock.calls[0][1]) as Array<{ id: string; ocr_text: string }>;
    return new Map(body.map((d) => [d.id, d.ocr_text]));
  }

  it("emits the migrated page-1 text, not the column value", async () => {
    await setColumn(OCR_IDS.descA1, "columna");
    await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "texto migrado" });
    const out = await exportA();
    expect(out.get(OCR_IDS.descA1)).toBe("texto migrado");
  });

  it("emits a run's pages joined in page order, a blank line between pages", async () => {
    // Inserted out of order, so the order comes from page_seq, not rowid.
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 3, text: "pagina tres", runId: "run-1" });
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "pagina uno", runId: "run-1" });
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "pagina dos\nsegunda linea", runId: "run-1" });
    const out = await exportA();
    expect(out.get(OCR_IDS.descA2)).toBe("pagina uno\n\npagina dos\nsegunda linea\n\npagina tres");
  });

  it("emits a run's single page as it stands", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "sola pagina", runId: "run-1" });
    const out = await exportA();
    expect(out.get(OCR_IDS.descA2)).toBe("sola pagina");
  });

  it("emits migrated, pipeline and absent text side by side in one fonds", async () => {
    const migrated = "texto migrado\n\ncon parrafos  y espacios \n";
    await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: migrated });
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "dos", runId: "run-1" });
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "uno", runId: "run-1" });
    const out = await exportA();
    expect(out.get(OCR_IDS.descA1)).toBe(migrated);
    expect(out.get(OCR_IDS.descA2)).toBe("uno\n\ndos");
    expect(out.get(OCR_IDS.descA3)).toBe("");
  });

  it("emits an empty ocr_text for a description with no page rows", async () => {
    const out = await exportA();
    expect(out.get(OCR_IDS.descA3)).toBe("");
  });

  it("never emits another tenant's page text", async () => {
    await seedPage({ descriptionId: OCR_IDS.descB1, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "texto ajeno" });
    // A page row carrying tenant B's id on a description tenant A holds.
    await seedPage({ descriptionId: OCR_IDS.descA3, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "fila ajena" });
    const storage = mockStorage();
    await exportFondsDescriptions(getTestDb(), storage, FONDS, { ...TEST_TENANT, id: OCR_IDS.tenantA });
    const raw = (storage.putObject as any).mock.calls[0][1] as string;
    expect(raw).not.toContain("texto ajeno");
    expect(raw).not.toContain("fila ajena");
    expect(raw).not.toContain(OCR_IDS.descB1);
  });
});

describe("readExportOcrText", () => {
  const tenantA = () => ({ id: OCR_IDS.tenantA }) as any;

  beforeEach(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedOcrFixtures();
  });

  it("returns migrated text unchanged, run pages joined in order, and nothing for a description with no pages", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "texto migrado" });
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 2, text: "pagina dos", runId: "run-1" });
    await seedPage({ descriptionId: OCR_IDS.descA2, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "pagina uno", runId: "run-1" });
    const out = await readExportOcrText(getTestDb(), tenantA(), [OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descA3]);
    expect(out.get(OCR_IDS.descA1)).toBe("texto migrado");
    expect(out.get(OCR_IDS.descA2)).toBe("pagina uno\n\npagina dos");
    expect(out.has(OCR_IDS.descA3)).toBe(false);
  });

  it("reads no page of another tenant", async () => {
    await seedPage({ descriptionId: OCR_IDS.descA3, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "fila ajena" });
    await seedPage({ descriptionId: OCR_IDS.descB1, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "texto ajeno" });
    const out = await readExportOcrText(getTestDb(), tenantA(), [OCR_IDS.descA3, OCR_IDS.descB1]);
    expect(out.size).toBe(0);
  });
});
