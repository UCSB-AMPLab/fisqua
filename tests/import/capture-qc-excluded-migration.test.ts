/**
 * Tests — migration 0111, the excluded opening
 *
 * This suite applies migration 0111 to an in-memory SQLite built from
 * the real files that create capture QC's tables and the later changes
 * to them (0093, 0094, 0095, 0096, 0100, 0104, 0106, 0109 and 0110),
 * behind stand-ins for the tables they reference, with foreign keys
 * enforced and a row in every table the migration rebuilds, and pins
 * what the rebuild must keep and what it changes:
 *
 *   - every image, decision set, decision and rotation survives with
 *     every column, each set with `excluded_count` 0; every index is there
 *     again under its name with the same definition, every foreign key
 *     still holds, and no holding table is left;
 *   - the tables the migration does not rebuild (deliveries, fetches,
 *     reviewers) keep their definitions and rows;
 *   - an image's record status may be `excluded`, as a unit on contract
 *     1.6 gives it, and nothing else new;
 *   - a decision may be `excluded`, with no reason and no side, and a
 *     note or none; any other value is refused;
 *   - the other rules still hold: a rejection needs a reason, a side
 *     belongs to a rejection only, `other` needs a note, and a set's
 *     counts add up, excluded openings included.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)), "utf8");

const MIGRATION = "0111_capture_qc_excluded.sql";
const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const HEX = "a".repeat(64);
const REBUILT = ["capture_images", "capture_qc_sets", "capture_qc_decisions", "capture_qc_rotations"];
const UNTOUCHED = ["capture_deliveries", "capture_qc_fetches", "capture_qc_reviewers"];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE tenants (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  db.exec("CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY NOT NULL)");
  for (const name of [
    "0093_capture_link.sql",
    "0094_capture_qc.sql",
    "0095_capture_delivery_route.sql",
    "0096_capture_qc_rotation_role.sql",
    "0100_capture_qc_retakes.sql",
    "0104_capture_review_declined.sql",
    "0106_capture_qc_side.sql",
    "0109_capture_image_rotate_deg.sql",
    "0110_capture_rejected_records.sql",
  ]) {
    db.exec(migration(name));
  }
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}')`);
  db.exec("INSERT INTO users VALUES ('user-1')");
  db.exec("INSERT INTO pipeline_volumes (id) VALUES ('pv-1')");
  db.exec(
    `INSERT INTO capture_deliveries (tenant_id, id, route, body_sha256, state, problems, answer_status, answer_body,
       records, openings, received_at, pipeline_volume_id, seq, write_id)
     VALUES ('${TENANT}', 'm-1', 'file', '${HEX}', 'registered', '[]', 200, '{}',
       '[{"captuaRecordId":1,"sequence":1,"status":"in_review"},{"captuaRecordId":2,"sequence":2,"status":"in_review"},{"captuaRecordId":3,"sequence":3,"status":"in_review"}]',
       3, 10, 'pv-1', 1, 'w-1')`,
  );
  db.exec(
    `INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
       capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes, record_status)
     VALUES ('img-1', '${TENANT}', 'm-1', 1, 'cap-1', NULL, 'single', 'co-1-img_0001_c0',
       'acme/co-1/captures/a.jpg', '${HEX}', 100, NULL, NULL, NULL, 'in_review')`,
  );
  db.exec(
    `INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
       opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id,
       carried_from)
     VALUES ('${TENANT}', 'm-1', 'pv-1', 'dec-1', 40, 2, 3, 2, 1, 1, 4, 'retakes_requested', 40, 'w-2', NULL)`,
  );
  db.exec(
    `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, side, note, decided_by,
       decided_by_name, decided_at, set_revision)
     VALUES ('${TENANT}', 'm-1', 1, 'approved', NULL, NULL, NULL, 'user-1', 'Reviewer', 40, 1),
            ('${TENANT}', 'm-1', 2, 'rejected', 'other', 'left', 'torn', 'user-1', 'Reviewer', 40, 2)`,
  );
  db.exec(
    `INSERT INTO capture_qc_rotations (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
     VALUES ('${TENANT}', 'm-1', 1, 'cap-1', 'single', 2)`,
  );
  db.exec(
    `INSERT INTO capture_qc_fetches (tenant_id, delivery_id, decisions_id, set_revision, first_fetched_at, last_fetched_at)
     VALUES ('${TENANT}', 'm-1', 'dec-0', 1, 30, 35)`,
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

const definition = (db: DatabaseSync, table: string) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

const foreignKeys = (db: DatabaseSync, table: string) =>
  db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<Record<string, any>>;

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

function decide(
  db: DatabaseSync,
  record: number,
  decision: string,
  fields: { reason?: string | null; side?: string | null; note?: string | null } = {},
) {
  db.prepare(
    `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, side, note, decided_by,
       decided_by_name, decided_at, set_revision) VALUES (?, 'm-1', ?, ?, ?, ?, ?, 'user-1', 'Reviewer', 50, 3)
     ON CONFLICT (tenant_id, delivery_id, captua_record_id) DO UPDATE SET decision = excluded.decision,
       reason = excluded.reason, side = excluded.side, note = excluded.note`,
  ).run(TENANT, record, decision, fields.reason ?? null, fields.side ?? null, fields.note ?? null);
}

describe("migration 0111", () => {
  it("keeps every row, column, index and foreign key, and counts no opening excluded", () => {
    const db = database();
    const before = Object.fromEntries([...REBUILT, ...UNTOUCHED].map((t) => [t, rows(db, t)]));
    const columnsBefore = Object.fromEntries(REBUILT.map((t) => [t, columns(db, t)]));
    const indexesBefore = indexes(db);
    const keysBefore = Object.fromEntries([...REBUILT, ...UNTOUCHED].map((t) => [t, foreignKeys(db, t)]));
    const untouchedBefore = Object.fromEntries(UNTOUCHED.map((t) => [t, definition(db, t)]));

    db.exec(migration(MIGRATION));

    expect(rows(db, "capture_qc_sets")).toEqual(before.capture_qc_sets.map((r) => ({ ...r, excluded_count: 0 })));
    expect(rows(db, "capture_qc_decisions")).toEqual(before.capture_qc_decisions);
    expect(rows(db, "capture_qc_rotations")).toEqual(before.capture_qc_rotations);
    expect(columns(db, "capture_qc_sets").sort()).toEqual([...columnsBefore.capture_qc_sets, "excluded_count"].sort());
    expect(rows(db, "capture_images")).toEqual(before.capture_images);
    for (const t of ["capture_images", "capture_qc_decisions", "capture_qc_rotations"]) {
      expect(columns(db, t).sort(), t).toEqual([...columnsBefore[t]].sort());
    }
    for (const t of UNTOUCHED) {
      expect(rows(db, t), t).toEqual(before[t]);
      expect(definition(db, t), t).toEqual(untouchedBefore[t]);
    }
    expect(indexes(db)).toEqual(indexesBefore);
    for (const t of [...REBUILT, ...UNTOUCHED]) expect(foreignKeys(db, t), t).toEqual(keysBefore[t]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_hold'").all()).toEqual([]);
  });

  it("keeps the images of a record the unit gives as excluded, and refuses any other status", () => {
    const db = database();
    db.exec(migration(MIGRATION));
    const image = (id: string, status: string | null) =>
      db
        .prepare(
          `INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, role, page_key,
             capture_key, capture_sha256, record_status) VALUES (?, ?, 'm-1', 9, ?, 'single', ?, 'k', ?, ?)`,
        )
        .run(id, TENANT, `cap-${id}`, `pk-${id}`, HEX, status);
    image("img-x", "excluded");
    image("img-n", null);
    expect(() => image("img-z", "skipped")).toThrow(/CHECK constraint failed/);
    expect(
      db.prepare("SELECT id, record_status FROM capture_images WHERE captua_record_id = 9 ORDER BY id").all(),
    ).toEqual([
      { id: "img-n", record_status: null },
      { id: "img-x", record_status: "excluded" },
    ]);
  });

  it("takes an excluded opening with no reason and no side, with or without a note", () => {
    const db = database();
    db.exec(migration(MIGRATION));
    decide(db, 3, "excluded");
    decide(db, 1, "excluded", { note: "test shot of the rig" });
    expect(
      db.prepare("SELECT captua_record_id, decision, reason, side, note FROM capture_qc_decisions ORDER BY 1").all(),
    ).toEqual([
      { captua_record_id: 1, decision: "excluded", reason: null, side: null, note: "test shot of the rig" },
      { captua_record_id: 2, decision: "rejected", reason: "other", side: "left", note: "torn" },
      { captua_record_id: 3, decision: "excluded", reason: null, side: null, note: null },
    ]);
  });

  it("refuses a reason or a side on an exclusion, and any other value", () => {
    const db = database();
    db.exec(migration(MIGRATION));
    expect(() => decide(db, 3, "excluded", { reason: "blur" })).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "excluded", { side: "left" })).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "skipped")).toThrow(/CHECK constraint failed/);
  });

  it("keeps the rules of a rejection and an approval", () => {
    const db = database();
    db.exec(migration(MIGRATION));
    expect(() => decide(db, 3, "rejected")).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "rejected", { reason: "other" })).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "approved", { reason: "blur" })).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "approved", { side: "both" })).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "rejected", { reason: "blur", side: "single" })).toThrow(/CHECK constraint failed/);
    expect(() => decide(db, 3, "approved", { note: "" })).toThrow(/CHECK constraint failed/);
    decide(db, 3, "rejected", { reason: "blur", side: "both" });
  });

  it("makes a set's counts add up with its excluded openings", () => {
    const db = database();
    db.exec(migration(MIGRATION));
    const count = (decided: number, approved: number, rejected: number, excluded: number) =>
      db
        .prepare(
          `UPDATE capture_qc_sets SET decided_count = ?, approved_count = ?, rejected_count = ?, excluded_count = ?
           WHERE delivery_id = 'm-1'`,
        )
        .run(decided, approved, rejected, excluded);
    count(3, 1, 1, 1);
    expect(() => count(2, 1, 0, 2)).toThrow(/CHECK constraint failed/);
    expect(() => count(4, 1, 1, 2)).toThrow(/CHECK constraint failed/);
  });

  it("still refuses a decision on a set that does not exist, and a rotation on a decision that does not", () => {
    const db = database();
    db.exec(migration(MIGRATION));
    expect(() =>
      db.exec(
        `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, decided_by, decided_by_name,
           decided_at) VALUES ('${TENANT}', 'm-none', 1, 'excluded', 'user-1', 'Reviewer', 1)`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      db.exec(
        `INSERT INTO capture_qc_rotations (tenant_id, delivery_id, captua_record_id, capture_id, role, quarter_turns)
         VALUES ('${TENANT}', 'm-1', 3, 'cap-9', 'single', 1)`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

// @version v0.9.0
