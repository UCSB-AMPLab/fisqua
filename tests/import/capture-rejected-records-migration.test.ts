/**
 * Tests — migration 0110, the delivery's rejected records
 *
 * This suite builds an in-memory SQLite from every file in `drizzle/`
 * up to 0109, in order, with foreign keys on, puts capture deliveries
 * there with plain JSON records, with and without rejected records, and
 * a refusal, then applies 0110 and pins that:
 *
 *   - every delivery is kept with every column, and gains
 *     `rejected_records` last among the columns;
 *   - a delivery counts its records `rejected`, and a refusal counts
 *     none;
 *   - with a delivery whose records are packed, the migration fails at
 *     its guard and changes nothing: the count cannot be read from the
 *     packed records, and is not guessed from the images' statuses;
 *   - the column refuses a negative count, and a delivery written
 *     without it takes 0.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DRIZZLE = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const MIGRATION = "0110_capture_rejected_records.sql";
const TENANT = "tenant-1";
const HEX = "a".repeat(64);

function apply(db: DatabaseSync, name: string): void {
  for (const statement of readFileSync(`${DRIZZLE}${name}`, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function chainUpTo(last: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(DRIZZLE).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    if (file.slice(0, 4) > last) break;
    apply(db, file);
  }
  return db;
}

type Row = Record<string, unknown>;

/** Inserts a row, filling each NOT NULL column without a default that `row` leaves out. */
function insert(db: DatabaseSync, table: string, row: Row): void {
  const full: Row = { ...row };
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, any>>;
  for (const c of columns) {
    if (c.name in full || !c.notnull || c.dflt_value !== null || c.pk) continue;
    full[c.name] = /INT|REAL/i.test(c.type) ? 1 : `${c.name}-x`;
  }
  const names = Object.keys(full);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
    ...(names.map((n) => full[n]) as any[]),
  );
}

const record = (id: number, status: string) => ({ captuaRecordId: id, sequence: id, status, rejectionNote: null });
const PACKED = '{"$gzip":"H4sIAAAAAAAAA4uOBQApu0wNAgAAAA=="}';

function seeded(opts: { packed?: boolean } = {}): DatabaseSync {
  const db = chainUpTo("0109");
  insert(db, "tenants", { id: TENANT, slug: "test-tenant", name: "Test", kind: "tenant", descriptive_standard: "isadg" });
  insert(db, "repositories", { id: "repo-1", tenant_id: TENANT, code: "repo-1" });
  for (const n of [1, 2, 3]) {
    insert(db, "descriptions", {
      id: `desc-${n}`, tenant_id: TENANT, repository_id: "repo-1", description_level: "volume",
      reference_code: `co-${n}`, title: `Volume ${n}`, created_at: 1, updated_at: 1,
    });
    insert(db, "pipeline_volumes", {
      id: `pv-${n}`, tenant_id: TENANT, description_id: `desc-${n}`, reference_code: `co-${n}`, kind: "volume_run",
      masters_backend: "b2", masters_endpoint: "https://s3.test", masters_bucket: "masters",
      masters_prefix: `test-tenant/co-${n}/`, expected_count: 1, recipe_scope_description_id: `desc-${n}`,
      created_at: 1, updated_at: 1,
    });
  }
  let seq = 0;
  const delivery = (id: string, extra: Row) =>
    insert(db, "capture_deliveries", {
      tenant_id: TENANT, id, route: "file", scanner_id: null, body_sha256: HEX, state: "registered",
      problems: "[]", answer_status: 200, answer_body: "{}", received_at: 1, seq: ++seq, write_id: `w-${id}`,
      ...extra,
    });

  // Two records rejected beside two openings.
  delivery("plain-rejected", {
    reference_code: "co-1", pipeline_volume_id: "pv-1", openings: 2,
    records: JSON.stringify([record(1, "approved"), record(2, "rejected"), record(3, "in_review"), record(4, "rejected")]),
  });
  // No record rejected.
  delivery("plain-clear", {
    reference_code: "co-2", pipeline_volume_id: "pv-2", openings: 2,
    records: JSON.stringify([record(1, "approved"), record(2, "in_review")]),
  });
  // A refusal: no records.
  delivery("refused", { reference_code: "co-1", state: "refused", answer_status: 422, openings: 0, records: null });
  if (opts.packed) {
    // Packed records, with an image whose record status says rejected:
    // the migration must not count from it.
    delivery("packed", { reference_code: "co-3", pipeline_volume_id: "pv-3", openings: 1, records: PACKED });
    insert(db, "capture_images", {
      id: "packed-cap-7", tenant_id: TENANT, delivery_id: "packed", captua_record_id: 7, capture_id: "cap-7",
      pair_id: null, role: "single", page_key: "p-cap-7", capture_key: "k-cap-7", capture_sha256: HEX,
      record_status: "rejected",
    });
  }
  return db;
}

const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);

describe("migration 0110", () => {
  it("keeps every delivery and counts its rejected records", () => {
    const db = seeded();
    const deliveries = rows(db, "capture_deliveries");
    const before = columns(db, "capture_deliveries");
    expect(deliveries).toHaveLength(3);

    apply(db, MIGRATION);

    expect(columns(db, "capture_deliveries")).toEqual([...before, "rejected_records"]);
    const counts: Record<string, number> = { "plain-rejected": 2, "plain-clear": 0, refused: 0 };
    expect(rows(db, "capture_deliveries")).toEqual(
      deliveries.map((r) => ({ ...r, rejected_records: counts[r.id as string] })),
    );
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'capture_rejected_records_guard'").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("fails at its guard, before changing the deliveries, when a delivery's records are packed", () => {
    const db = seeded({ packed: true });
    const deliveries = rows(db, "capture_deliveries");
    const before = columns(db, "capture_deliveries");

    expect(() => apply(db, MIGRATION)).toThrow(/CHECK constraint failed/);

    expect(columns(db, "capture_deliveries")).toEqual(before);
    expect(rows(db, "capture_deliveries")).toEqual(deliveries);
  });

  it("refuses a negative count, and gives 0 to a delivery written without one", () => {
    const db = seeded();
    apply(db, MIGRATION);
    expect(() => db.prepare("UPDATE capture_deliveries SET rejected_records = -1 WHERE id = 'plain-clear'").run()).toThrow(
      /CHECK constraint failed/,
    );
    insert(db, "capture_deliveries", {
      tenant_id: TENANT, id: "later", route: "file", scanner_id: null, reference_code: "co-2", body_sha256: HEX,
      state: "refused", problems: "[]", answer_status: 422, answer_body: "{}", records: null, openings: 0,
      received_at: 2, seq: 99,
    });
    expect(db.prepare("SELECT rejected_records FROM capture_deliveries WHERE id = 'later'").get()).toEqual({
      rejected_records: 0,
    });
  });
});

// @version v0.8.0
