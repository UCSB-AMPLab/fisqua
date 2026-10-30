/**
 * Tests — migration 0100, carried approvals and the unit's fetches
 *
 * This suite applies migration 0100 to an in-memory SQLite built from
 * the real files that create the capture link's tables (0093), capture
 * QC's (0094) and the delivery route (0095), behind stand-ins for the
 * tables they reference, with a delivery, an image and a decision set
 * already there, and pins what the migration must do:
 *
 *   - every existing set keeps its row and gets `carried_from` null, and
 *     the column takes a delivery id;
 *   - each image takes its record's status from its delivery's records
 *     when they are plain JSON and name the record once; an image of a
 *     repeated record id or of packed records keeps null;
 *   - each existing decision takes its set's revision as `set_revision`;
 *   - `capture_qc_fetches` keys a fetch by tenant and `decisionsId`,
 *     refuses a fetch of a delivery that does not exist and a last fetch
 *     before the first, and is indexed by delivery;
 *   - `capture_images` gains its index by record.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const HEX = "a".repeat(64);

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(migration("0093_capture_link.sql"));
  db.exec(migration("0094_capture_qc.sql"));
  db.exec(migration("0095_capture_delivery_route.sql"));
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}')`);
  db.exec("INSERT INTO pipeline_volumes (id) VALUES ('pv-1')");
  db.exec(
    `INSERT INTO capture_deliveries (tenant_id, id, route, body_sha256, state, problems, answer_status, answer_body,
       records, openings, received_at, pipeline_volume_id, seq, write_id)
     VALUES ('${TENANT}', 'm-1', 'file', '${HEX}', 'registered', '[]', 200, '{}',
       '[{"captuaRecordId":1,"sequence":1,"status":"in_review"},{"captuaRecordId":2,"sequence":2,"status":"rejected"},{"captuaRecordId":3,"sequence":3,"status":"approved"},{"captuaRecordId":3,"sequence":4,"status":"rejected"}]',
       1, 10, 'pv-1', 1, 'w-1'),
       ('${TENANT}', 'm-0', 'file', '${HEX}', 'refused', '[]', 422, '{}', '{"$gzip":"H4sI"}', 1, 5, 'pv-1', 0, 'w-0')`,
  );
  db.exec(
    `INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
       capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes)
     VALUES ('img-1', '${TENANT}', 'm-1', 1, 'cap-1', NULL, 'single', 'co-1-img_0001_c0', 'acme/co-1/captures/a.cr3', '${HEX}', 100, NULL, NULL, NULL),
            ('img-2', '${TENANT}', 'm-1', 2, 'cap-2', NULL, 'single', 'co-1-img_0002_c0', 'acme/co-1/captures/b.cr3', '${HEX}', 100, NULL, NULL, NULL),
            ('img-3', '${TENANT}', 'm-1', 3, 'cap-3', NULL, 'single', 'co-1-img_0003_c0', 'acme/co-1/captures/c.cr3', '${HEX}', 100, NULL, NULL, NULL),
            ('img-4', '${TENANT}', 'm-0', 1, 'cap-1', NULL, 'single', 'co-1-img_0001_c0', 'acme/co-1/captures/a.cr3', '${HEX}', 100, NULL, NULL, NULL)`,
  );
  db.exec(
    `INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
       opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id)
     VALUES ('${TENANT}', 'm-1', 'pv-1', 'dec-1', 40, 3, 1, 1, 1, 0, 0, 'approved', 40, 'w-2')`,
  );
  db.exec("INSERT INTO users VALUES ('user-1')");
  db.exec(
    `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, decided_by, decided_by_name, decided_at)
     VALUES ('${TENANT}', 'm-1', 1, 'approved', 'user-1', 'Reviewer', 40)`,
  );
  return db;
}

const fetch = (db: DatabaseSync, delivery: string, decisionsId: string, first: number, last: number) =>
  db
    .prepare(
      `INSERT INTO capture_qc_fetches (tenant_id, delivery_id, decisions_id, set_revision, first_fetched_at, last_fetched_at)
       VALUES (?, ?, ?, 3, ?, ?)`,
    )
    .run(TENANT, delivery, decisionsId, first, last);

describe("migration 0100", () => {
  it("keeps every set, with carried_from null, and lets the column name a delivery", () => {
    const db = database();
    const before = db.prepare("SELECT * FROM capture_qc_sets").all();
    db.exec(migration("0100_capture_qc_retakes.sql"));
    expect(db.prepare("SELECT * FROM capture_qc_sets").all()).toEqual(
      before.map((r) => ({ ...(r as object), carried_from: null })),
    );
    db.exec("UPDATE capture_qc_sets SET carried_from = 'm-0'");
    expect(db.prepare("SELECT carried_from FROM capture_qc_sets").get()).toEqual({ carried_from: "m-0" });
  });

  it("tells each image its record's status where the records say it once, and leaves the rest null", () => {
    const db = database();
    db.exec(migration("0100_capture_qc_retakes.sql"));
    expect(db.prepare("SELECT id, record_status FROM capture_images ORDER BY id").all()).toEqual([
      { id: "img-1", record_status: "in_review" },
      { id: "img-2", record_status: "rejected" },
      // Record 3 appears twice in the records: which image is which cannot be told.
      { id: "img-3", record_status: null },
      // Packed records cannot be read in SQL.
      { id: "img-4", record_status: null },
    ]);
    expect(() => db.exec("UPDATE capture_images SET record_status = 'lost' WHERE id = 'img-1'")).toThrow(/CHECK constraint failed/);
  });

  it("stamps each existing decision with its set's revision", () => {
    const db = database();
    db.exec(migration("0100_capture_qc_retakes.sql"));
    expect(db.prepare("SELECT captua_record_id, set_revision FROM capture_qc_decisions").all()).toEqual([
      { captua_record_id: 1, set_revision: 3 },
    ]);
  });

  it("keys a fetch by tenant and decisionsId, and refuses an unknown delivery or a last fetch before the first", () => {
    const db = database();
    db.exec(migration("0100_capture_qc_retakes.sql"));
    fetch(db, "m-1", "dec-1", 50, 60);
    expect(() => fetch(db, "m-1", "dec-1", 70, 70)).toThrow(/UNIQUE constraint failed/);
    expect(() => fetch(db, "m-9", "dec-2", 50, 50)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => fetch(db, "m-1", "dec-3", 50, 49)).toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM capture_qc_fetches").get()).toEqual({ n: 1 });
  });

  it("indexes fetches by delivery and images by record", () => {
    const db = database();
    db.exec(migration("0100_capture_qc_retakes.sql"));
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(names).toEqual(expect.arrayContaining(["capture_qc_fetches_delivery_idx", "capture_images_record_idx"]));
  });
});

// @version v0.8.0
