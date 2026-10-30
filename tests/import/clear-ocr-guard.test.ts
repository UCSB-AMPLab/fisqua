/**
 * Tests — the clear refuses while it would lose OCR or pipeline state
 *
 * This suite covers the guard in front of the tenant-scoped clear.
 * Deleting the tenant's descriptions takes their OCR page rows with
 * them. Pages a pipeline run wrote exist only for published volumes,
 * which cannot be regenerated, and pipeline volumes and recipe
 * declarations are production state the reimport does not hold, so the
 * guard refuses while the tenant has any of them, and names each count.
 * A page row without a run id in any shape other than the migrated page
 * 1 is refused too, since no importer writes it. The page-1 rows
 * migration 0086 backfilled from the old `ocr_text` column do not block
 * the clear: the importer writes them again from the dump, and the guard
 * returns their count.
 *
 * The clear SQL deletes those migrated rows in four rowid chunks before
 * it deletes the descriptions. One test runs it against a database
 * built from migration 0085, so the full-text index is seen to drop the
 * deleted rows and keep the other tenant's.
 *
 * The guard's SQL runs here against an in-memory SQLite database built
 * with the tables it reads, so the probe and the counts are tested as
 * SQL, not only as strings. The guard does not look for the
 * `descriptions.ocr_text` column, which neither importer writes.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  clearGuardProbeSql, clearGuardCountsSql, refuseUnsafeTenantClear, generateTenantScopedClearSql,
} from "../../scripts/commands/clear";

const T = "tenant-x";
const OTHER = "tenant-y";

interface Shape {
  ocrPages?: boolean;
  ocrTextColumn?: boolean;
  pipelineTables?: boolean;
}

/** A database with the tables the guard reads, in the shape asked for. */
function database(shape: Shape = {}): DatabaseSync {
  const { ocrPages = true, ocrTextColumn = true, pipelineTables = false } = shape;
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL${ocrTextColumn ? ", ocr_text TEXT" : ""});`);
  if (ocrPages) {
    db.exec("CREATE TABLE ocr_pages (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, description_id TEXT NOT NULL, page_seq INTEGER NOT NULL, source_key TEXT, alto_key TEXT, run_id TEXT);");
  }
  if (pipelineTables) {
    db.exec("CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);");
    db.exec("CREATE TABLE pipeline_recipe_declarations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);");
  }
  return db;
}

function reader(db: DatabaseSync): (sql: string) => Promise<unknown[]> {
  return async (sql) => db.prepare(sql).all();
}

function addPage(
  db: DatabaseSync,
  tenant: string,
  runId: string | null,
  shape: { pageSeq?: number; sourceKey?: string | null; altoKey?: string | null } = {},
) {
  db.prepare("INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, source_key, alto_key, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), tenant, crypto.randomUUID(), shape.pageSeq ?? 1, shape.sourceKey ?? null, shape.altoKey ?? null, runId);
}

describe("the guard's SQL", () => {
  it("probes for the tables it depends on, and not for the ocr_text column", () => {
    const s = clearGuardProbeSql();
    for (const name of ["ocr_pages", "pipeline_volumes", "pipeline_recipe_declarations"]) {
      expect(s).toContain(`'${name}'`);
    }
    expect(s).not.toContain("ocr_text");
  });

  it("counts each kind of page row for the tenant, and the pipeline tables only when they exist", () => {
    const without = clearGuardCountsSql(T, { pipelineTables: false });
    expect(without).toContain("run_id IS NOT NULL");
    expect(without).toContain("page_seq = 1 AND source_key IS NULL AND alto_key IS NULL");
    expect(without).toContain(`tenant_id = '${T}'`);
    expect(without).not.toContain("FROM pipeline_");
    const withTables = clearGuardCountsSql(T, { pipelineTables: true });
    expect(withTables).toContain("FROM pipeline_volumes");
    expect(withTables).toContain("FROM pipeline_recipe_declarations");
  });

  it("quotes the tenant id", () => {
    expect(clearGuardCountsSql("o'brien", { pipelineTables: true })).toContain("tenant_id = 'o''brien'");
  });
});

describe("refuseUnsafeTenantClear", () => {
  it("lets the clear go ahead when the tenant has no pages, volumes or declarations", async () => {
    const db = database({ pipelineTables: true });
    addPage(db, OTHER, "run-9");
    addPage(db, OTHER, null);
    db.prepare("INSERT INTO pipeline_volumes VALUES ('v', ?)").run(OTHER);
    await expect(refuseUnsafeTenantClear(T, reader(db))).resolves.toEqual({ migratedPages: 0 });
  });

  it("lets the clear go ahead on a database without the pipeline tables", async () => {
    await expect(refuseUnsafeTenantClear(T, reader(database()))).resolves.toEqual({ migratedPages: 0 });
  });

  it("lets the clear go ahead over migrated page-1 rows, which the reimport writes again, and returns their count", async () => {
    const db = database({ pipelineTables: true });
    addPage(db, T, null);
    addPage(db, T, null);
    addPage(db, OTHER, null);
    await expect(refuseUnsafeTenantClear(T, reader(db))).resolves.toEqual({ migratedPages: 2 });
  });

  it("refuses and names the count when the tenant has pipeline pages", async () => {
    const db = database();
    for (let i = 0; i < 3; i++) addPage(db, T, "run-1", { pageSeq: i + 1, sourceKey: `k/${i}` });
    addPage(db, T, null);
    const run = refuseUnsafeTenantClear(T, reader(db));
    await expect(run).rejects.toThrow(/3 OCR pages written by the media pipeline/);
    await expect(run).rejects.toThrow(T);
  });

  it("refuses page rows without a run id that are not in the migrated page-1 shape", async () => {
    for (const shape of [{ pageSeq: 2 }, { sourceKey: "k/1" }, { altoKey: "a/1" }]) {
      const db = database();
      addPage(db, T, null, shape);
      await expect(refuseUnsafeTenantClear(T, reader(db)))
        .rejects.toThrow(/1 OCR pages without a run id that are not migrated page-1 rows/);
    }
  });

  it("refuses and names the counts when the tenant has pipeline volumes or recipe declarations", async () => {
    const db = database({ pipelineTables: true });
    db.prepare("INSERT INTO pipeline_volumes VALUES ('v1', ?), ('v2', ?)").run(T, T);
    db.prepare("INSERT INTO pipeline_recipe_declarations VALUES ('r1', ?)").run(T);
    const run = refuseUnsafeTenantClear(T, reader(db));
    await expect(run).rejects.toThrow(/2 pipeline volumes/);
    await expect(run).rejects.toThrow(/1 recipe declaration/);
  });

  it("refuses a recipe declaration on its own", async () => {
    const db = database({ pipelineTables: true });
    db.prepare("INSERT INTO pipeline_recipe_declarations VALUES ('r1', ?)").run(T);
    await expect(refuseUnsafeTenantClear(T, reader(db))).rejects.toThrow(/1 recipe declaration/);
  });

  it("names every count in one message", async () => {
    const db = database({ pipelineTables: true });
    addPage(db, T, "run-1");
    addPage(db, T, null, { pageSeq: 2 });
    db.prepare("INSERT INTO pipeline_volumes VALUES ('v1', ?)").run(T);
    const run = refuseUnsafeTenantClear(T, reader(db));
    await expect(run).rejects.toThrow(/1 OCR pages written by the media pipeline.*1 OCR pages without a run id.*1 pipeline volumes/);
  });

  it("lets the clear go ahead when descriptions has no ocr_text column", async () => {
    const db = database({ ocrTextColumn: false, pipelineTables: true });
    await expect(refuseUnsafeTenantClear(T, reader(db))).resolves.toEqual({ migratedPages: 0 });
  });

  it("still refuses pipeline pages on a database without the ocr_text column", async () => {
    const db = database({ ocrTextColumn: false });
    addPage(db, T, "run-1");
    await expect(refuseUnsafeTenantClear(T, reader(db)))
      .rejects.toThrow(/1 OCR pages written by the media pipeline/);
  });

  it("refuses when the database has no ocr_pages table", async () => {
    await expect(refuseUnsafeTenantClear(T, reader(database({ ocrPages: false })))).rejects.toThrow(/ocr_pages/);
  });

  it("refuses when a count cannot be read", async () => {
    await expect(refuseUnsafeTenantClear(T, async () => [])).rejects.toThrow();
    const db = database();
    let calls = 0;
    const second = async (sql: string) => (++calls === 1 ? reader(db)(sql) : []);
    await expect(refuseUnsafeTenantClear(T, second)).rejects.toThrow();
  });
});

describe("the clear SQL", () => {
  async function clearSql(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clear-ocr-"));
    try {
      const [file] = await generateTenantScopedClearSql({ tenantId: T, outputDir: dir });
      return await fs.readFile(file, "utf8");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("deletes the tenant's migrated page-1 rows in four rowid chunks before the descriptions", async () => {
    const text = await clearSql();
    const deletes = text.split("\n").filter((l) => l.startsWith("DELETE FROM ocr_pages"));
    expect(deletes).toHaveLength(4);
    for (const [i, line] of deletes.entries()) {
      expect(line).toContain(`tenant_id = '${T}'`);
      expect(line).toContain("run_id IS NULL AND page_seq = 1 AND source_key IS NULL AND alto_key IS NULL");
      expect(line).toContain(`rowid % 4 = ${i}`);
    }
    expect(text.indexOf("DELETE FROM ocr_pages")).toBeLessThan(text.indexOf("DELETE FROM descriptions"));
  });

  it("run against the 0085 schema, removes the tenant's migrated rows and their index entries and keeps the other tenant's", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY);");
    db.exec("CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);");
    db.exec("CREATE TABLE entities (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);");
    db.exec("CREATE TABLE entity_functions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL);");
    db.exec("CREATE TABLE places (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);");
    db.exec("CREATE TABLE repositories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);");
    const migration = await fs.readFile(path.join("drizzle", "0085_ocr_pages.sql"), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
    db.prepare("INSERT INTO tenants VALUES (?), (?)").run(T, OTHER);
    const page = db.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES (?, ?, ?, 1, ?, 0)",
    );
    for (let i = 0; i < 6; i++) {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO descriptions VALUES (?, ?)").run(id, T);
      page.run(crypto.randomUUID(), T, id, `cleared zaffrewing ${i}`);
    }
    const kept = crypto.randomUUID();
    db.prepare("INSERT INTO descriptions VALUES (?, ?)").run(kept, OTHER);
    page.run(crypto.randomUUID(), OTHER, kept, "kept zaffrewing");

    db.exec(await clearSql());

    const rows = db.prepare("SELECT tenant_id FROM ocr_pages").all();
    expect(rows).toEqual([{ tenant_id: OTHER }]);
    const hits = db.prepare(
      "SELECT p.description_id AS id FROM ocr_pages p JOIN ocr_pages_fts f ON f.rowid = p.rowid WHERE f.ocr_pages_fts MATCH 'zaffrewing'",
    ).all();
    expect(hits).toEqual([{ id: kept }]);
    db.exec("INSERT INTO ocr_pages_fts(ocr_pages_fts) VALUES('integrity-check');");
    db.close();
  });
});

// Version: v0.8.0
