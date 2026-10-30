/**
 * Tests — migration 0106, the image a rejection asks to retake
 *
 * This suite applies migration 0106 to an in-memory SQLite built from
 * the real files that create capture QC's tables (0093, 0094, 0095,
 * 0096 and 0100), behind stand-ins for the tables they reference, with
 * an approval and a rejection already recorded, and pins what the
 * migration must do:
 *
 *   - every existing decision keeps its row and takes `side` null;
 *   - a rejection takes `left`, `right` or `both`, and nothing else;
 *   - an approval takes no side;
 *   - a rejection may still have none, as a one-image opening's does.
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
  db.exec(migration("0096_capture_qc_rotation_role.sql"));
  db.exec(migration("0100_capture_qc_retakes.sql"));
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}')`);
  db.exec("INSERT INTO users VALUES ('user-1')");
  db.exec("INSERT INTO pipeline_volumes (id) VALUES ('pv-1')");
  db.exec(
    `INSERT INTO capture_deliveries (tenant_id, id, route, body_sha256, state, problems, answer_status, answer_body,
       records, openings, received_at, pipeline_volume_id, seq, write_id)
     VALUES ('${TENANT}', 'm-1', 'file', '${HEX}', 'registered', '[]', 200, '{}',
       '[{"captuaRecordId":1,"sequence":1,"status":"in_review"},{"captuaRecordId":2,"sequence":2,"status":"in_review"}]',
       2, 10, 'pv-1', 1, 'w-1')`,
  );
  db.exec(
    `INSERT INTO capture_qc_sets (tenant_id, delivery_id, pipeline_volume_id, decisions_id, decided_at, revision,
       opening_count, decided_count, approved_count, rejected_count, notes_bytes, state, state_entered_at, write_id)
     VALUES ('${TENANT}', 'm-1', 'pv-1', 'dec-1', 40, 2, 2, 2, 1, 1, 0, 'retakes_requested', 40, 'w-2')`,
  );
  db.exec(
    `INSERT INTO capture_qc_decisions (tenant_id, delivery_id, captua_record_id, decision, reason, decided_by,
       decided_by_name, decided_at, set_revision)
     VALUES ('${TENANT}', 'm-1', 1, 'approved', NULL, 'user-1', 'Reviewer', 40, 1),
            ('${TENANT}', 'm-1', 2, 'rejected', 'blur', 'user-1', 'Reviewer', 40, 2)`,
  );
  return db;
}

const setSide = (db: DatabaseSync, record: number, side: string | null) =>
  db
    .prepare("UPDATE capture_qc_decisions SET side = ? WHERE tenant_id = ? AND delivery_id = 'm-1' AND captua_record_id = ?")
    .run(side, TENANT, record);

describe("migration 0106", () => {
  it("keeps every decision, each with side null", () => {
    const db = database();
    const before = db.prepare("SELECT * FROM capture_qc_decisions ORDER BY captua_record_id").all();
    db.exec(migration("0106_capture_qc_side.sql"));
    expect(db.prepare("SELECT * FROM capture_qc_decisions ORDER BY captua_record_id").all()).toEqual(
      before.map((r) => ({ ...(r as object), side: null })),
    );
  });

  it("lets a rejection name left, right or both, and nothing else", () => {
    const db = database();
    db.exec(migration("0106_capture_qc_side.sql"));
    for (const side of ["left", "right", "both"]) {
      setSide(db, 2, side);
      expect(db.prepare("SELECT side FROM capture_qc_decisions WHERE captua_record_id = 2").get()).toEqual({ side });
    }
    expect(() => setSide(db, 2, "single")).toThrow(/CHECK constraint failed/);
    expect(() => setSide(db, 2, "")).toThrow(/CHECK constraint failed/);
  });

  it("refuses a side on an approval", () => {
    const db = database();
    db.exec(migration("0106_capture_qc_side.sql"));
    expect(() => setSide(db, 1, "left")).toThrow(/CHECK constraint failed/);
    // Turning a rejection with a side into an approval must clear the side.
    setSide(db, 2, "right");
    expect(() =>
      db.exec("UPDATE capture_qc_decisions SET decision = 'approved', reason = NULL WHERE captua_record_id = 2"),
    ).toThrow(/CHECK constraint failed/);
    db.exec("UPDATE capture_qc_decisions SET decision = 'approved', reason = NULL, side = NULL WHERE captua_record_id = 2");
  });

  it("lets a rejection have no side, as a one-image opening's has", () => {
    const db = database();
    db.exec(migration("0106_capture_qc_side.sql"));
    setSide(db, 2, null);
    expect(db.prepare("SELECT side FROM capture_qc_decisions WHERE captua_record_id = 2").get()).toEqual({ side: null });
  });
});

// @version v0.8.0
