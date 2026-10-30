/**
 * Tests — migration 0104, the delivery the review run sweep declined
 *
 * This suite builds an in-memory SQLite from every file in `drizzle/`
 * up to 0103, in order, with foreign keys on, puts capture deliveries
 * in each state, with their review runs, then applies 0104 and pins
 * that every row of `capture_deliveries` and `capture_review_runs` is
 * kept with every column, that the deliveries gain
 * `review_declined_at`, null for each of them and last among the
 * columns, and that the column takes a time and null again. Every
 * value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DRIZZLE = fileURLToPath(new URL("../../drizzle/", import.meta.url));
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

function seeded(): DatabaseSync {
  const db = chainUpTo("0103");
  insert(db, "tenants", { id: TENANT, slug: "test-tenant", name: "Test", kind: "tenant", descriptive_standard: "isadg" });
  insert(db, "users", { id: "user-1", email: "user@example.test", tenant_id: TENANT });
  insert(db, "repositories", { id: "repo-1", tenant_id: TENANT, code: "repo-1" });
  insert(db, "descriptions", {
    id: "desc-1", tenant_id: TENANT, repository_id: "repo-1", description_level: "volume",
    reference_code: "co-1", title: "Volume", created_at: 1, updated_at: 1,
  });
  insert(db, "pipeline_volumes", {
    id: "pv-1", tenant_id: TENANT, description_id: "desc-1", reference_code: "co-1", kind: "volume_run",
    masters_backend: "b2", masters_endpoint: "https://s3.test", masters_bucket: "masters",
    masters_prefix: "test-tenant/co-1/", expected_count: 1, recipe_scope_description_id: "desc-1",
    created_at: 1, updated_at: 1,
  });
  const delivery = (id: string, state: string, extra: Row = {}) =>
    insert(db, "capture_deliveries", {
      tenant_id: TENANT, id, route: "file", scanner_id: null, reference_code: "co-1", body_sha256: HEX, state,
      problems: "[]", answer_status: 200, answer_body: "{}", records: "[]", openings: 1, received_at: 1,
      ...extra,
    });
  delivery("del-old", "superseded", { pipeline_volume_id: "pv-1", superseded_by: "del-new", superseded_at: 2, seq: 1, write_id: "w-1" });
  delivery("del-new", "registered", { pipeline_volume_id: "pv-1", seq: 2, write_id: "w-2", received_at: 2 });
  delivery("del-refused", "refused", { answer_status: 422, openings: 0, records: null, seq: 3 });
  insert(db, "pipeline_runs", {
    id: "review-1", tenant_id: TENANT, user_id: null, kind: "review_run", purpose: null, status: "dispatched",
    runner_image: `ghcr.io/test/runner@sha256:${"0".repeat(64)}`, script_version: "v1.1.0", arch: "x64",
    max_review_frac: 1, spec_key: "k", spec_sha256: HEX, spec_url_expires_at: 10, chunk_count: 1, volume_count: 1,
    callback_token_hash: HEX, token_expires_at: 20, created_at: 1,
  });
  insert(db, "capture_review_runs", {
    tenant_id: TENANT, run_id: "review-1", delivery_id: "del-new", pipeline_volume_id: "pv-1",
    review_prefix: "test-tenant/del-new/", status: "dispatched", created_at: 1,
  });
  return db;
}

const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);

describe("migration 0104", () => {
  it("keeps every delivery and review run, and gives each delivery a null review_declined_at", () => {
    const db = seeded();
    const deliveries = rows(db, "capture_deliveries");
    const reviews = rows(db, "capture_review_runs");
    const before = columns(db, "capture_deliveries");
    expect(deliveries).toHaveLength(3);

    apply(db, "0104_capture_review_declined.sql");

    expect(columns(db, "capture_deliveries")).toEqual([...before, "review_declined_at"]);
    expect(rows(db, "capture_deliveries")).toEqual(deliveries.map((r) => ({ ...r, review_declined_at: null })));
    expect(rows(db, "capture_review_runs")).toEqual(reviews);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("takes a time and null again", () => {
    const db = seeded();
    apply(db, "0104_capture_review_declined.sql");
    db.prepare("UPDATE capture_deliveries SET review_declined_at = 1800000000000 WHERE id = 'del-new'").run();
    expect(db.prepare("SELECT review_declined_at FROM capture_deliveries WHERE id = 'del-new'").get()).toEqual({
      review_declined_at: 1800000000000,
    });
    db.prepare("UPDATE capture_deliveries SET review_declined_at = NULL WHERE id = 'del-new'").run();
    expect(db.prepare("SELECT review_declined_at FROM capture_deliveries WHERE id = 'del-new'").get()).toEqual({
      review_declined_at: null,
    });
  });
});

// @version v0.8.0
