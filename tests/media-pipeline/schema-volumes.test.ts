/**
 * Tests — media pipeline schema: recipe declarations, volumes, pages
 *
 * This suite pins the table constraints of the three tables that
 * describe what the media pipeline works on: the versioned recipe
 * declarations, the pipeline volumes, and each volume's page list.
 * Every case is a single INSERT against the test schema that is
 * expected either to fail a constraint or to succeed, so a constraint
 * dropped from the harness or the migration shows up here.
 *
 * A page's digest (0092) is null or 64 lowercase hex characters.
 *
 * The page-key cases run the same table of keys against the table's
 * CHECK and against `PIPELINE_PAGE_KEY_PATTERN`, the run spec's
 * pattern, so the two forms of the rule cannot drift apart.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestUser } from "../helpers/auth";
import { PIPELINE_PAGE_KEY_PATTERN } from "../../app/lib/validation/enums";

const TENANT = DEFAULT_TEST_TENANT_ID;

let userId: string;
let scopeId: string;
let unitId: string;
let otherUnitId: string;

async function seed(): Promise<void> {
  const repo = await createTestRepository();
  const user = await createTestUser();
  userId = user.id;
  scopeId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "fonds" })).id;
  unitId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "file", parentId: scopeId })).id;
  otherUnitId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "file", parentId: scopeId })).id;
}

type Row = Record<string, unknown>;

async function insert(table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  )
    .bind(...cols.map((c) => row[c]))
    .run();
}

function declaration(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT,
    scope_description_id: scopeId,
    version: 1,
    platen: "v",
    background: "dark",
    output_class: "bilevel",
    ocr: 0,
    ocr_lang: null,
    tone_preset: "default",
    created_by: userId,
    created_at: Date.now(),
    ...overrides,
  };
}

function volume(overrides: Row = {}): Row {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT,
    description_id: unitId,
    reference_code: `co-test-${crypto.randomUUID().slice(0, 8)}`,
    kind: "volume_run",
    masters_backend: "b2",
    masters_endpoint: "https://s3.example.test",
    masters_bucket: "masters",
    masters_prefix: "masters/co-test/",
    masters_key: null,
    expected_count: 3,
    recipe_scope_description_id: scopeId,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function insertVolume(overrides: Row = {}): Promise<string> {
  const row = volume(overrides);
  await insert("pipeline_volumes", row);
  return row.id as string;
}

function page(volumeId: string, overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT,
    pipeline_volume_id: volumeId,
    seq: 1,
    page_key: "p0001",
    master_key: "masters/co-test/p0001.tif",
    pdf_page: null,
    ...overrides,
  };
}

describe("media pipeline schema: recipe declarations", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
  });

  it("refuses OCR on a tonal output class", async () => {
    await expect(
      insert("pipeline_recipe_declarations", declaration({ ocr: 1, ocr_lang: "spa", output_class: "tonal" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a repeated version within a family and accepts the next version", async () => {
    await insert("pipeline_recipe_declarations", declaration({ version: 1 }));
    await expect(
      insert("pipeline_recipe_declarations", declaration({ version: 1 })),
    ).rejects.toThrow(/UNIQUE/);
    await insert("pipeline_recipe_declarations", declaration({ version: 2 }));
    const { results } = await env.DB.prepare(
      "SELECT version FROM pipeline_recipe_declarations WHERE tenant_id = ? AND scope_description_id = ? ORDER BY version",
    )
      .bind(TENANT, scopeId)
      .all<{ version: number }>();
    expect(results.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe("media pipeline schema: volumes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
  });

  it("refuses a duplicate reference code within a tenant", async () => {
    await insertVolume({ reference_code: "co-test-dup" });
    await expect(
      insertVolume({ reference_code: "co-test-dup", description_id: otherUnitId }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuses a volume run that names a single master object instead of a prefix", async () => {
    await expect(
      insertVolume({ kind: "volume_run", masters_key: "masters/one.tif", masters_prefix: null }),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses an expected count of zero", async () => {
    await expect(insertVolume({ expected_count: 0 })).rejects.toThrow(/CHECK/);
  });

  it("refuses a restricted flag outside 0 and 1", async () => {
    await expect(insertVolume({ restricted: 2 })).rejects.toThrow(/CHECK/);
  });

  it("inserts a valid volume with its defaults", async () => {
    const id = await insertVolume();
    const row = await env.DB.prepare(
      "SELECT state, restricted, held_by_run_id, open_review_count FROM pipeline_volumes WHERE id = ?",
    )
      .bind(id)
      .first<{ state: string; restricted: number; held_by_run_id: string | null; open_review_count: number }>();
    expect(row).toEqual({ state: "received", restricted: 0, held_by_run_id: null, open_review_count: 0 });
  });

  it("inserts an item PDF volume that names its master object", async () => {
    await insertVolume({ kind: "item_pdf", masters_key: "masters/item.pdf", masters_prefix: null });
  });
});

describe("media pipeline schema: volume pages", () => {
  let volumeId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
    volumeId = await insertVolume();
  });

  it("refuses a repeated page key within a volume", async () => {
    await insert("pipeline_volume_pages", page(volumeId, { seq: 1, page_key: "p0001" }));
    await expect(
      insert("pipeline_volume_pages", page(volumeId, { seq: 2, page_key: "p0001" })),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("refuses a sequence number of zero", async () => {
    await expect(insert("pipeline_volume_pages", page(volumeId, { seq: 0 }))).rejects.toThrow(/CHECK/);
  });

  it("refuses a page that names both a master object and a PDF page", async () => {
    await expect(
      insert("pipeline_volume_pages", page(volumeId, { master_key: "masters/p.tif", pdf_page: 1 })),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a page that names neither a master object nor a PDF page", async () => {
    await expect(
      insert("pipeline_volume_pages", page(volumeId, { master_key: null, pdf_page: null })),
    ).rejects.toThrow(/CHECK/);
  });

  it("inserts a page that names only a PDF page", async () => {
    await insert("pipeline_volume_pages", page(volumeId, { master_key: null, pdf_page: 3 }));
  });

  it("refuses PDF page zero", async () => {
    await expect(
      insert("pipeline_volume_pages", page(volumeId, { master_key: null, pdf_page: 0 })),
    ).rejects.toThrow(/CHECK/);
  });

  it("accepts a page without a digest and one with 64 lowercase hex characters", async () => {
    await insert("pipeline_volume_pages", page(volumeId, { seq: 1, page_key: "p0001" }));
    await insert("pipeline_volume_pages", page(volumeId, { seq: 2, page_key: "p0002", sha256: "0123456789abcdef".repeat(4) }));
  });

  const BAD_DIGESTS: [string, string][] = [
    ["upper case", "0123456789ABCDEF".repeat(4)],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["a character outside hex", "g" + "a".repeat(63)],
    ["the empty string", ""],
  ];
  for (const [name, digest] of BAD_DIGESTS) {
    it(`refuses a digest of ${name}`, async () => {
      await expect(insert("pipeline_volume_pages", page(volumeId, { sha256: digest }))).rejects.toThrow(/CHECK/);
    });
  }

  // Titles escape non-ASCII characters, because the test runner sends
  // each title in a request header.
  const label = (key: string) =>
    JSON.stringify(key).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const ACCEPTED = ["p0001", "_x", "-x", "a.b-c_d"];
  const REFUSED = [".x", "a/b", "a b", "ä1", ""];

  for (const key of ACCEPTED) {
    it(`accepts the page key ${label(key)} in the table and in the spec pattern`, async () => {
      await insert("pipeline_volume_pages", page(volumeId, { page_key: key }));
      expect(PIPELINE_PAGE_KEY_PATTERN.test(key)).toBe(true);
    });
  }

  for (const key of REFUSED) {
    it(`refuses the page key ${label(key)} in the table and in the spec pattern`, async () => {
      await expect(
        insert("pipeline_volume_pages", page(volumeId, { page_key: key })),
      ).rejects.toThrow(/CHECK/);
      expect(PIPELINE_PAGE_KEY_PATTERN.test(key)).toBe(false);
    });
  }
});
