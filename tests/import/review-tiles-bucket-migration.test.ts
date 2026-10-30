/**
 * Tests — migration 0097, the federation's review-tiles bucket
 *
 * This suite applies migration 0097 to an in-memory SQLite built from
 * the real file that adds the destination columns (0091), behind
 * stand-ins for the tables it references, with federations whose
 * records are complete and empty, and pins what the migration must
 * keep and what it adds:
 *
 *   - every existing row keeps every column, takes null in the new
 *     column, and a complete record stays complete (`isRecordComplete`
 *     read from the row as the operator's commands read it);
 *   - the column takes a bucket name, two federations cannot record the
 *     same one, and any number can record none;
 *   - nothing else about the table changes: 0091's indexes are all there.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isRecordComplete, type FederationRow } from "../../scripts/lib/tenant-storage";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");

const COMPLETE = {
  pipeline_delivery_endpoint: "https://s3.us-west-000.backblazeb2.com",
  pipeline_tiles_bucket: "acme-iiif-tiles",
  pipeline_masters_bucket: "acme-masters",
  pipeline_image_base_url: "https://iiif.acme.example.test",
  manifest_endpoint: "https://acct.r2.cloudflarestorage.com",
  manifest_bucket: "acme-manifests",
  manifest_base_url: "https://manifests.acme.example.test",
  storage_secret_prefix: "FEDERATION_ACME",
};

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL)");
  db.exec("CREATE TABLE pipeline_run_volumes (tenant_id TEXT NOT NULL)");
  // Stand-in for 0044's table, with the columns this test reads.
  db.exec("CREATE TABLE federations (id TEXT PRIMARY KEY NOT NULL, slug TEXT NOT NULL UNIQUE)");
  db.exec(migration("0091_tenant_destinations.sql"));
  const columns = Object.keys(COMPLETE);
  db.prepare(`INSERT INTO federations (id, slug, ${columns.join(", ")}) VALUES (?, ?, ${columns.map(() => "?").join(", ")})`).run(
    "f-acme",
    "acme",
    ...Object.values(COMPLETE),
  );
  db.exec("INSERT INTO federations (id, slug) VALUES ('f-empty', 'empty'), ('f-other', 'other')");
  return db;
}

const rows = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM federations ORDER BY id").all() as unknown as FederationRow[];

describe("migration 0097", () => {
  it("keeps every row and column, gives each row null, and a complete record stays complete", () => {
    const db = database();
    const before = rows(db);
    db.exec(migration("0097_review_tiles_bucket.sql"));
    const after = rows(db);
    expect(after).toEqual(before.map((r) => ({ ...r, pipeline_review_tiles_bucket: null })));
    const acme = after.find((r) => r.slug === "acme")!;
    expect(isRecordComplete(acme)).toBe(true);
    expect(isRecordComplete(after.find((r) => r.slug === "empty")!)).toBe(false);
  });

  it("takes a bucket name, refuses one another federation records, and lets any number record none", () => {
    const db = database();
    db.exec(migration("0097_review_tiles_bucket.sql"));
    db.exec("UPDATE federations SET pipeline_review_tiles_bucket = 'acme-review-tiles' WHERE id = 'f-acme'");
    expect(() =>
      db.exec("UPDATE federations SET pipeline_review_tiles_bucket = 'acme-review-tiles' WHERE id = 'f-other'"),
    ).toThrow(/UNIQUE/);
    db.exec("UPDATE federations SET pipeline_review_tiles_bucket = 'other-review-tiles' WHERE id = 'f-other'");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM federations WHERE pipeline_review_tiles_bucket IS NULL").get() as { n: number }).n,
    ).toBe(1);
    const acme = rows(db).find((r) => r.slug === "acme")!;
    expect(isRecordComplete(acme)).toBe(true);
  });

  it("adds its index and keeps 0091's", () => {
    const db = database();
    db.exec(migration("0097_review_tiles_bucket.sql"));
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'federations' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual([
      "federations_manifest_base_url_idx",
      "federations_manifest_bucket_idx",
      "federations_pipeline_masters_bucket_idx",
      "federations_pipeline_review_tiles_bucket_idx",
      "federations_pipeline_tiles_bucket_idx",
      "federations_storage_secret_prefix_idx",
    ]);
  });
});

// @version v0.8.0
