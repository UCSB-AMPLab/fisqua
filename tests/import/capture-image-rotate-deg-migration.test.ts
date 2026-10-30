/**
 * Tests — migration 0109, the rotation that makes a capture image upright
 *
 * This suite applies migration 0109 to an in-memory SQLite built from
 * the real files that create the capture link's tables and the image's
 * record status (0093, 0094, 0095 and 0100), behind stand-ins for the
 * tables they reference, with an image already recorded, and pins what
 * the migration must do:
 *
 *   - every existing image keeps its row and takes `rotate_deg` null;
 *   - an image takes 0, 90, 180 or 270, and null;
 *   - any other value is refused: 45, 360, -90, 90.5 and a string.
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
  db.exec(migration("0100_capture_qc_retakes.sql"));
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}')`);
  db.exec("INSERT INTO pipeline_volumes (id) VALUES ('pv-1')");
  db.exec(
    `INSERT INTO capture_deliveries (tenant_id, id, route, body_sha256, state, problems, answer_status, answer_body,
       records, openings, received_at, pipeline_volume_id, seq, write_id)
     VALUES ('${TENANT}', 'm-1', 'file', '${HEX}', 'registered', '[]', 200, '{}',
       '[{"captuaRecordId":1,"sequence":1,"status":"in_review"}]', 1, 10, 'pv-1', 1, 'w-1')`,
  );
  db.exec(
    `INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
       capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes, record_status)
     VALUES ('img-1', '${TENANT}', 'm-1', 1, 'cap-1', NULL, 'single', 'co-test-001-img_0001_c0',
       'sbmal/co-test-001/captures/co-test-001-img_0001_c0.cr3', '${HEX}', 1000,
       'sbmal/co-test-001/previews/co-test-001-img_0001_c0_preview.jpg', '${HEX}', 100, 'in_review')`,
  );
  return db;
}

const setRotation = (db: DatabaseSync, value: unknown) =>
  db.prepare("UPDATE capture_images SET rotate_deg = ? WHERE id = 'img-1'").run(value as number | string | null);

describe("migration 0109", () => {
  it("keeps every image, each with rotate_deg null", () => {
    const db = database();
    const before = db.prepare("SELECT * FROM capture_images").all();
    db.exec(migration("0109_capture_image_rotate_deg.sql"));
    expect(db.prepare("SELECT * FROM capture_images").all()).toEqual(
      before.map((r) => ({ ...(r as object), rotate_deg: null })),
    );
  });

  it("takes 0, 90, 180 and 270, and null", () => {
    const db = database();
    db.exec(migration("0109_capture_image_rotate_deg.sql"));
    for (const value of [0, 90, 180, 270, null]) {
      setRotation(db, value);
      expect(db.prepare("SELECT rotate_deg FROM capture_images").get()).toEqual({ rotate_deg: value });
    }
  });

  it("refuses any other value", () => {
    const db = database();
    db.exec(migration("0109_capture_image_rotate_deg.sql"));
    for (const value of [45, 360, -90, 90.5, "ninety"]) {
      expect(() => setRotation(db, value), String(value)).toThrow(/CHECK constraint failed/);
    }
  });
});

// @version v0.8.0
