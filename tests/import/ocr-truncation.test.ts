/**
 * Tests — OCR text at the CLI import boundary
 *
 * This suite covers OCR text at the command-line import boundary.
 * `descriptions` has no `ocr_text` column: OCR text lives in
 * `ocr_pages`. The bulk importer writes each imported record's
 * `ocr_text`, when it is neither null nor empty, as one page-1 row in
 * the shape migration 0086 gave the text it moved out of the column
 * (whole text, no source or ALTO key, no run id), in `ocr_pages-NNN.sql`
 * files returned after the descriptions files. Text over 90 KB is cut at
 * a UTF-8/word boundary with the importer's long-standing marker, the
 * original length is recorded in legacy_ids, and the cut is listed in a
 * sidecar, because each page row is one INSERT under D1's statement
 * limit. The descriptions INSERT never names `ocr_text`.
 *
 * One test applies the generated page SQL and migration 0086 to the
 * same text in an in-memory SQLite database built from migration 0085,
 * and compares the two rows; the same database shows the insert trigger
 * indexing the imported row.
 *
 * The OCR values below are synthetic placeholders.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

// Per-suite scratch dir (never the production `.import/` snapshot dir —
// see audit item 23).
let outputDir: string;
async function setUpOutputDir() {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "fisqua-import-test-"));
}
async function cleanOutput() {
  try {
    await fs.rm(outputDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

interface MinimalDescription {
  id: number;
  repository_id: number;
  parent_id: number | null;
  description_level: string;
  resource_type: string;
  genre: unknown[];
  reference_code: string;
  local_identifier: string | null;
  title: string;
  ocr_text: string | null;
  [k: string]: unknown;
}

function makeRow(
  id: number,
  reference_code: string,
  ocr_text: string | null,
): MinimalDescription {
  return {
    id,
    repository_id: 1,
    parent_id: null,
    description_level: "fonds",
    resource_type: "text",
    genre: [],
    reference_code,
    local_identifier: null,
    title: `Test ${id}`,
    translated_title: null,
    uniform_title: null,
    date_expression: null,
    date_start: null,
    date_end: null,
    date_certainty: null,
    extent: null,
    dimensions: null,
    medium: null,
    imprint: null,
    edition: null,
    volume_number: null,
    issue_number: null,
    pages: null,
    publication_title: null,
    provenance: null,
    scope_content: null,
    ocr_text,
    arrangement: null,
    access_conditions: null,
    reproduction_conditions: null,
    language: null,
    location_of_originals: null,
    location_of_copies: null,
    finding_aids: null,
    section_title: null,
    notes: null,
    internal_notes: null,
    creator_display: null,
    place_display: null,
    iiif_manifest_url: null,
    has_digital: false,
    is_published: true,
    last_exported_at: null,
    admin_biog_history: null,
    preferred_citation: null,
    acquisition_info: null,
    system_of_arrangement: null,
    physical_characteristics: null,
    legacy_ids: null,
    ca_object_id: null,
    ca_collection_id: null,
    created_by: null,
    updated_by: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
  };
}

async function writeFixture(rows: MinimalDescription[]): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fisqua-ocr-trunc-"));
  const file = path.join(tmp, "descriptions.json");
  await fs.writeFile(file, JSON.stringify(rows));
  return file;
}

const NEO = NEOGRANADINA_TENANT_ID;

/** The VALUES tuples of every page INSERT in the given files. */
async function pageSql(files: string[]): Promise<string> {
  const pageFiles = files.filter((f) => path.basename(f).startsWith("ocr_pages-"));
  const parts = await Promise.all(pageFiles.map((f) => fs.readFile(f, "utf8")));
  return parts.join("\n");
}

/** Migration SQL split into statements on Drizzle's breakpoint marker. */
async function migrationStatements(name: string): Promise<string[]> {
  const text = await fs.readFile(path.join("drizzle", name), "utf8");
  return text.split("--> statement-breakpoint").map((t) => t.trim()).filter(Boolean);
}

describe("OCR text at the CLI import boundary", () => {
  beforeEach(setUpOutputDir);
  afterEach(cleanOutput);

  const repoIdMap = new Map<number, string>([
    [1, "00000000-0000-4000-8000-000000000001"],
  ]);

  async function filesIn(dir: string): Promise<string[]> {
    return fs.readdir(dir).catch(() => [] as string[]);
  }

  it("writes a record's OCR text as a page-1 row, after the descriptions files, and never names ocr_text in descriptions", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    const fixture = await writeFixture([
      makeRow(100, "test-plain", null),
      makeRow(101, "test-ocr", "placeholder OCR text"),
    ]);
    const { result, idMap } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(path.basename(result.sqlFiles[0])).toBe("descriptions-001.sql");
    expect(result.sqlFiles.map((f) => path.basename(f))).toEqual(["descriptions-001.sql", "ocr_pages-001.sql"]);
    const descSql = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(descSql).not.toContain("ocr_text");
    expect(descSql).not.toContain("placeholder OCR text");

    const pages = await pageSql(result.sqlFiles);
    expect(pages).toContain(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at)",
    );
    expect(pages).toContain(`'${NEO}', '${idMap.get(101)}', 1, 'placeholder OCR text', NULL, NULL, NULL,`);
    expect(pages).not.toContain(idMap.get(100)!);
    expect(await filesIn(outputDir)).not.toContain("ocr-truncations.json");
  });

  it("writes no page row for null or empty ocr_text, and one for any other value, as 0086 did", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    const fixture = await writeFixture([
      makeRow(400, "test-null", null),
      makeRow(401, "test-empty", ""),
      makeRow(402, "test-blank", "  \n "),
    ]);
    const { result, idMap } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(3);
    const pages = await pageSql(result.sqlFiles);
    expect(pages).not.toContain(idMap.get(400)!);
    expect(pages).not.toContain(idMap.get(401)!);
    expect(pages).toContain(`'${idMap.get(402)}', 1, '  \n ',`);
  });

  it("writes no page file when no record carries OCR text, and removes page files an earlier run left", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    await fs.writeFile(path.join(outputDir, "ocr_pages-001.sql"), "-- stale\n");
    await fs.writeFile(path.join(outputDir, "ocr_pages-002.sql"), "-- stale\n");
    const fixture = await writeFixture([makeRow(500, "test-none", null)]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.sqlFiles.map((f) => path.basename(f))).toEqual(["descriptions-001.sql"]);
    expect((await filesIn(outputDir)).filter((f) => f.startsWith("ocr_pages-"))).toEqual([]);
  });

  it("writes no page row for a record the importer skips", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    const fixture = await writeFixture([makeRow(600, "bad code!", "placeholder skipped text")]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(0);
    expect(await pageSql(result.sqlFiles)).not.toContain("placeholder skipped text");
  });

  it("cuts OCR text over 90 KB with the marker, tags legacy_ids and lists it in the sidecar", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    const longOcr = "Lorem ipsum dolor sit amet ".repeat(5000) + "TAIL_SENTINEL_THIS_SHOULD_NOT_APPEAR";
    const originalBytes = Buffer.byteLength(longOcr, "utf8");
    expect(originalBytes).toBeGreaterThan(120_000);
    const fixture = await writeFixture([makeRow(200, "test-long", longOcr)]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    expect(result.imported).toBe(1);
    const descSql = await fs.readFile(result.sqlFiles[0], "utf8");
    expect(descSql).toContain('"provider":"ocr-truncated"');
    expect(descSql).toContain(`"id":${originalBytes}`);

    const pages = await pageSql(result.sqlFiles);
    expect(pages).toContain("OCR truncated to fit D1");
    expect(pages).toContain(`original ${originalBytes} bytes`);
    expect(pages).not.toContain("TAIL_SENTINEL_THIS_SHOULD_NOT_APPEAR");
    expect(Buffer.byteLength(pages, "utf8")).toBeLessThan(100_000);

    const sidecar = JSON.parse(await fs.readFile(path.join(outputDir, "ocr-truncations.json"), "utf8"));
    expect(sidecar.truncations).toHaveLength(1);
    expect(sidecar.truncations[0]).toMatchObject({ djangoPk: 200, referenceCode: "test-long", originalBytes });
    expect(sidecar.truncations[0].truncatedBytes).toBeLessThanOrEqual(95_000);
  });

  it("keeps UTF-8 characters whole when cutting", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    const longOcr = "áéíóú ñ ç ã ÑΩψβ אבגד ".repeat(4000);
    expect(Buffer.byteLength(longOcr, "utf8")).toBeGreaterThan(100_000);
    const fixture = await writeFixture([makeRow(300, "test-utf8", longOcr)]);
    const { result } = await importDescriptions(fixture, repoIdMap, outputDir);

    const pages = await pageSql(result.sqlFiles);
    expect(pages).toContain("OCR truncated to fit D1");
    expect(pages).not.toContain("\uFFFD");
  });

  it("writes the same row migration 0086 writes for the same text, and the insert trigger indexes it", async () => {
    const { importDescriptions } = await import("../../scripts/commands/descriptions");
    const text = "placeholder wexlombard text\nwith a second line and a quote's mark";
    const fixture = await writeFixture([makeRow(700, "test-same", text)]);
    const { result, idMap } = await importDescriptions(fixture, repoIdMap, outputDir);
    const descriptionId = idMap.get(700)!;

    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY);");
    db.exec("CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, ocr_text TEXT);");
    for (const statement of await migrationStatements("0085_ocr_pages.sql")) db.exec(statement);
    db.prepare("INSERT INTO tenants VALUES (?)").run(NEO);
    db.prepare("INSERT INTO descriptions VALUES (?, ?, ?)").run(descriptionId, NEO, text);

    const columns = "tenant_id, description_id, page_seq, text, source_key, alto_key, run_id";
    for (const statement of await migrationStatements("0086_ocr_pages_backfill.sql")) db.exec(statement);
    const backfilled = db.prepare(`SELECT ${columns} FROM ocr_pages`).all();
    expect(backfilled).toHaveLength(1);
    db.exec("DELETE FROM ocr_pages;");

    for (const file of result.sqlFiles.filter((f) => path.basename(f).startsWith("ocr_pages-"))) {
      db.exec(await fs.readFile(file, "utf8"));
    }
    expect(db.prepare(`SELECT ${columns} FROM ocr_pages`).all()).toEqual(backfilled);
    const hits = db.prepare(
      "SELECT p.description_id AS id FROM ocr_pages p JOIN ocr_pages_fts f ON f.rowid = p.rowid WHERE f.ocr_pages_fts MATCH 'wexlombard'",
    ).all();
    expect(hits).toEqual([{ id: descriptionId }]);
    db.close();
  });
});

// Version: v0.8.0
