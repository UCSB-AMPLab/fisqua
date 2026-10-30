/**
 * Tests — migration 0095, the capture delivery's route
 *
 * This suite applies migration 0095 to an in-memory SQLite built from
 * the real files that create the capture link's tables (0093) and
 * capture QC's (0094), behind stand-ins for the tables they reference,
 * with a row in every table of the module, and pins what the rebuild
 * must keep and what it changes:
 *
 *   - every row of the deliveries, images, decision sets, decisions and
 *     rotations survives with every column, and each delivery is
 *     written as route `link`, with its openings counted from its
 *     records (`in_review` or `approved`), 0 for a refusal and 1 for
 *     records stored packed, which SQL cannot read;
 *   - every index of those tables is there again under its name, with
 *     the same definition, and every foreign key still holds and still
 *     refuses an orphan;
 *   - `scanner_id` takes null for a file delivery, a CHECK keeps route
 *     and scanner in step, and the route is `link` or `file` only;
 *   - the reviewers table is not touched and no holding table is left.
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
const TABLES = ["capture_deliveries", "capture_images", "capture_qc_sets", "capture_qc_decisions", "capture_qc_rotations"];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  // 0093 adds the page revision to this stand-in.
  db.exec("CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY NOT NULL)");
  db.exec(migration("0093_capture_link.sql"));
  db.exec(migration("0094_capture_qc.sql"));
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}')`);
  db.exec("INSERT INTO users VALUES ('user-1')");
  db.exec("INSERT INTO pipeline_volumes (id) VALUES ('pv-1')");
  db.exec(
    `INSERT INTO capture_scanners (id, tenant_id, name, token_sha256, created_at, updated_at)
     VALUES ('sc-1', '${TENANT}', 'rig-1', '${HEX}', 1, 1)`,
  );
  db.exec(
    `INSERT INTO capture_deliveries (tenant_id, id, scanner_id, reference_code, pipeline_volume_id, body_sha256, state,
       problems, answer_status, answer_body, records, received_at, superseded_by, superseded_at, seq, write_id)
     VALUES ('${TENANT}', 'm-1', 'sc-1', 'co-1', 'pv-1', '${HEX}', 'superseded', '[]', 200, '{"a":1}', '[]', 10, 'm-2', 20, 1, 'w-1'),
            ('${TENANT}', 'm-2', 'sc-1', 'co-1', 'pv-1', '${HEX}', 'registered', '[{"rule":"unlisted-object"}]', 200, '{"a":2}',
             '[{"captuaRecordId":1,"status":"approved"},{"captuaRecordId":2,"status":"in_review"},{"captuaRecordId":3,"status":"rejected"},{"captuaRecordId":4,"status":"captured"}]',
             20, NULL, NULL, 2, 'w-2'),
            ('${TENANT}', 'm-3', 'sc-1', 'co-1', NULL, '${HEX}', 'refused', '[]', 422, '{"problems":[]}', NULL, 30, NULL, NULL, 3, NULL),
            ('${TENANT}', 'm-4', 'sc-1', 'co-1', 'pv-1', '${HEX}', 'superseded', '[]', 200, '{"a":4}', '{"$gzip":"H4sI"}',
             5, 'm-1', 6, 4, 'w-4')`,
  );
  db.exec(
    `INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
       capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes)
     VALUES ('img-1', '${TENANT}', 'm-2', 1, 'cap-1', NULL, 'single', 'co-1-img_0001_c0',
       'acme/co-1/captures/a.cr3', '${HEX}', 100, 'acme/co-1/previews/a_preview.jpg', '${HEX}', 50)`,
  );
  db.exec(
    `INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
       opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id)
     VALUES ('${TENANT}', 'm-2', 'pv-1', 'dec-1', 40, 1, 1, 1, 0, 1, 4, 'retakes_requested', 40, 'w-3')`,
  );
  db.exec(
    `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, note,
       decided_by, decided_by_name, decided_at)
     VALUES ('${TENANT}', 'm-2', 1, 'rejected', 'other', 'torn', 'user-1', 'Reviewer', 40)`,
  );
  db.exec(
    `INSERT INTO capture_qc_rotations (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
     VALUES ('${TENANT}', 'm-2', 1, 'cap-1', 'single', 2)`,
  );
  db.exec(
    `INSERT INTO capture_qc_reviewers (tenant_id, pipeline_volume_id, reviewer_id, assigned_by, assigned_at)
     VALUES ('${TENANT}', 'pv-1', 'user-1', 'user-1', 5)`,
  );
  return db;
}

const rows = (db: DatabaseSync, table: string) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, any>>;

const indexes = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
       AND tbl_name LIKE 'capture_%' ORDER BY name`,
    )
    .all();

const foreignKeys = (db: DatabaseSync, table: string) =>
  db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<Record<string, any>>;

describe("migration 0095", () => {
  it("keeps every row, column, index and foreign key, and writes each delivery as link", () => {
    const db = database();
    const before = Object.fromEntries(TABLES.map((t) => [t, rows(db, t)]));
    const indexesBefore = indexes(db);
    const keysBefore = Object.fromEntries(TABLES.map((t) => [t, foreignKeys(db, t)]));
    const reviewersBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'capture_qc_reviewers'").get();

    db.exec(migration("0095_capture_delivery_route.sql"));

    // Openings counted from readable records; a refusal 0; a packed row 1.
    const openings: Record<string, number> = { "m-1": 0, "m-2": 2, "m-3": 0, "m-4": 1 };
    expect(rows(db, "capture_deliveries")).toEqual(
      before.capture_deliveries.map((r) => ({ ...r, route: "link", openings: openings[r.id] })),
    );
    for (const t of TABLES.slice(1)) expect(rows(db, t), t).toEqual(before[t]);
    expect(indexes(db)).toEqual(indexesBefore);
    for (const t of TABLES) expect(foreignKeys(db, t), t).toEqual(keysBefore[t]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'capture_qc_reviewers'").get()).toEqual(reviewersBefore);
    expect(rows(db, "capture_qc_reviewers")).toHaveLength(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_hold'").all(),
    ).toEqual([]);
  });

  it("takes a file delivery with no scanner, and keeps route and scanner in step", () => {
    const db = database();
    db.exec(migration("0095_capture_delivery_route.sql"));
    const insert = (id: string, route: string, scanner: string | null, seq: number) =>
      db
        .prepare(
          `INSERT INTO capture_deliveries (tenant_id, id, route, scanner_id, body_sha256, state, answer_status,
             answer_body, openings, received_at, seq) VALUES (?, ?, ?, ?, ?, 'refused', 422, '{}', 0, 1, ?)`,
        )
        .run(TENANT, id, route, scanner, HEX, seq);
    insert("f-1", "file", null, 10);
    expect(() => insert("f-2", "file", "sc-1", 11)).toThrow(/CHECK constraint failed/);
    expect(() => insert("l-1", "link", null, 12)).toThrow(/CHECK constraint failed/);
    expect(() => insert("x-1", "carried", null, 13)).toThrow(/CHECK constraint failed/);
    expect(() => insert("l-2", "link", "sc-unknown", 14)).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db.exec(
        `INSERT INTO capture_deliveries (tenant_id, id, route, body_sha256, state, answer_status, answer_body, openings,
           received_at, seq) VALUES ('${TENANT}', 'f-3', 'file', '${HEX}', 'refused', 422, '{}', -1, 1, 15)`,
      ),
    ).toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT route, scanner_id FROM capture_deliveries WHERE id = 'f-1'").get()).toEqual({
      route: "file",
      scanner_id: null,
    });
  });

  it("still refuses an image or a decision set of a delivery that does not exist, and a delete under them", () => {
    const db = database();
    db.exec(migration("0095_capture_delivery_route.sql"));
    expect(() =>
      db.exec(
        `INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, role, page_key,
           capture_key, capture_sha256) VALUES ('img-x', '${TENANT}', 'm-none', 1, 'c', 'single', 'k', 'key', '${HEX}')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db.exec(
        `INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
           opening_count, state, state_entered_at, write_id)
         VALUES ('${TENANT}', 'm-none', 'pv-1', 'dec-x', 1, 1, 1, 'in_capture_qc', 1, 'w')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.exec("DELETE FROM capture_deliveries WHERE id = 'm-2'")).toThrow(/FOREIGN KEY constraint failed/);
  });
});

// @version v0.8.0
