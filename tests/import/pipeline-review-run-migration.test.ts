/**
 * Tests — migrations 0102 and 0103, the review run in the run ledger
 *
 * This suite builds an in-memory SQLite from every file in `drizzle/`
 * up to 0101, in order, with foreign keys on, puts rows in the run
 * ledger and every table that references it, then applies 0102 and
 * 0103 and pins what they must keep and what they change:
 *
 *   - every row of `pipeline_runs`, `pipeline_run_chunks`,
 *     `pipeline_run_volumes`, `pipeline_review_items` and
 *     `pipeline_publications` survives with every column, in the same
 *     column order; every index of those tables is there again under its
 *     name with the same definition; every foreign key is declared as it
 *     was, still holds and still refuses an orphan; and no holding table
 *     is left;
 *   - `pipeline_runs` takes kind `review_run` with a null purpose and a
 *     null user, refuses a null purpose or a null user for the other
 *     kinds, refuses a purpose for a review run, and refuses any kind
 *     outside the three;
 *   - the `tenants_slug_frozen` trigger still fires;
 *   - 0103 adds `capture_review_runs`, keyed by tenant, run and volume,
 *     with its delivery's foreign key, and `pipeline_run_volumes`
 *     gains `review_purge`, which holds JSON or null.
 *
 * Rows in tables outside the ledger are filled by `insert`, which gives
 * each column that needs a value and has none a test value of its type;
 * the ledger's rows are written out in full. Every value here is a test
 * value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DRIZZLE = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const LEDGER = [
  "pipeline_runs",
  "pipeline_run_chunks",
  "pipeline_run_volumes",
  "pipeline_review_items",
  "pipeline_publications",
];
const HEX = "a".repeat(64);
const IMAGE = `ghcr.io/test/runner@sha256:${"0".repeat(64)}`;
const TENANT = "tenant-1";

const migration = (name: string) => readFileSync(`${DRIZZLE}${name}`, "utf8");

function apply(db: DatabaseSync, name: string): void {
  for (const statement of migration(name).split("--> statement-breakpoint")) {
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

function run(id: string, extra: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    federation_id: null,
    user_id: "user-1",
    kind: "volume_run",
    purpose: "wave",
    regenerates_run_id: null,
    status: "completed",
    runner_image: IMAGE,
    script_version: "v1.0.0",
    arch: "x64",
    max_review_frac: 0.5,
    spec_key: `${TENANT}/spec/${id}.json`,
    spec_sha256: HEX,
    spec_url_expires_at: 100,
    chunk_count: 1,
    volume_count: 1,
    volumes_reported: 1,
    callback_token_hash: HEX,
    token_expires_at: 200,
    token_revoked_at: 150,
    error: null,
    created_at: 10,
    dispatched_at: 11,
    completed_at: 150,
    ...extra,
  };
}

/** The chain to 0101 with a row in every ledger table and their parents. */
function seeded(): DatabaseSync {
  const db = chainUpTo("0101");
  insert(db, "tenants", { id: TENANT, slug: "test-tenant", name: "Test", kind: "tenant", descriptive_standard: "isadg" });
  insert(db, "users", { id: "user-1", email: "user@example.test", tenant_id: TENANT });
  insert(db, "repositories", { id: "repo-1", tenant_id: TENANT, code: "repo-1" });
  insert(db, "descriptions", {
    id: "desc-1", tenant_id: TENANT, repository_id: "repo-1", description_level: "fonds",
    reference_code: "co-1", title: "Fonds", created_at: 1, updated_at: 1,
  });
  insert(db, "pipeline_recipe_declarations", {
    id: "decl-1", tenant_id: TENANT, scope_description_id: "desc-1", version: 1, platen: "v",
    background: "dark", output_class: "tonal", tone_preset: "default", created_by: "user-1", created_at: 1,
  });
  insert(db, "pipeline_volumes", {
    id: "pv-1", tenant_id: TENANT, description_id: "desc-1", reference_code: "co-1", kind: "volume_run",
    masters_backend: "b2", masters_endpoint: "https://s3.test", masters_bucket: "masters",
    masters_prefix: "test-tenant/co-1/", expected_count: 2, recipe_scope_description_id: "desc-1",
    created_at: 1, updated_at: 1,
  });
  insert(db, "pipeline_runs", run("run-1"));
  insert(db, "pipeline_runs", run("run-2", {
    kind: "item_pdf", purpose: "sample", status: "halted", token_revoked_at: null, completed_at: null,
    error: '{"class":"auth"}', regenerates_run_id: "run-1",
  }));
  insert(db, "pipeline_run_chunks", {
    id: "chunk-1", run_id: "run-1", tenant_id: TENANT, chunk_index: 0, status: "completed",
    dispatch_error: null, claim_id: "c-1", idempotency_key: "run-1:chunk:0:1.1", body_sha256: HEX,
    stored_response: '{"accepted":true}', attempt: "1.1", conclusion: "success", unreported_volume_ids: "[]",
    dispatched_at: 11, reported_at: 140, created_at: 10,
  });
  insert(db, "pipeline_run_chunks", {
    id: "chunk-2", run_id: "run-2", tenant_id: TENANT, chunk_index: 0, status: "failed",
    dispatch_error: '{"http_status":502}', created_at: 10,
  });
  insert(db, "pipeline_run_volumes", {
    id: "rv-1", run_id: "run-1", tenant_id: TENANT, pipeline_volume_id: "pv-1", declaration_id: "decl-1",
    job_index: 0, chunk_index: 0, reference_code: "co-1", tile_root: "co-1", expected_count: 2,
    resolved_recipe: '{"declaration_version":1}', status: "review_pending", claim_id: "c-2",
    idempotency_key: "run-1:pv-1:1.1", body_sha256: HEX, stored_response: '{"accepted":true}', attempt: "1.1",
    runner_versions: "{}", stages: "{}", qc: "{}", verification: "{}", flags_count: 1,
    flags: '[{"id":"ri-1"}]', flags_truncated: 0, flags_ingested_at: 120, flags_ingest_attempts: 2,
    tiles_bytes: 1000, ocr_bytes: 0, elapsed_s: 1.5, manifest_key: "m.json", report_key: "r.json",
    error: null, reported_at: 120, created_at: 10,
  });
  insert(db, "pipeline_review_items", {
    id: "ri-1", tenant_id: TENANT, pipeline_volume_id: "pv-1", run_id: "run-1", page_key: "p0001",
    stage: "render", code: "edge", summary: "Edge", declaration_id: "decl-1", declaration_version: 1,
    script_version: "v1.0.0", verdict: "accept", verdict_note: "fine", verdict_by: "user-1",
    verdict_at: 130, created_at: 120,
  });
  insert(db, "pipeline_publications", {
    id: "pub-1", tenant_id: TENANT, pipeline_volume_id: "pv-1", run_id: "run-1", run_volume_id: "rv-1",
    user_id: "user-1", status: "published", claim_id: "pc-1", canonical_url: "https://m.test/co-1.json",
    canonical_key: "test-tenant/co-1.json", manifest_sha256: HEX, canonical_expect: '{"absent":true}',
    description_before: "{}", previous_catalogue_url: "https://old.test", previous_manifest_sha256: HEX,
    previous_manifest_etag: '"e"', previous_manifest_copy_key: "copy.json", previous_image_roots: "[]",
    retirement_status: "pending", ocr_pages_written: 2, ocr_bytes_read: 10, error: null, needs_person: 1,
    resolve_attempts: 3, claimed_at: 160, copying_at: 161, published_at: 162, finished_at: 163,
    previous_ocr_copy_key: "ocr.json", previous_ocr_sha256: HEX,
  });
  return db;
}

const rows = (db: DatabaseSync, table: string) =>
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name);
const indexes = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN (${LEDGER.map((t) => `'${t}'`).join(", ")})
       ORDER BY name`,
    )
    .all()
    .map((r: any) => ({ ...r, sql: r.sql === null ? null : String(r.sql).replace(/\s+/g, " ") }));
const foreignKeys = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA foreign_key_list(${table})`).all();

describe("migration 0102", () => {
  it("keeps every row, column, index and foreign key of the run ledger and its four children", () => {
    const db = seeded();
    const before = Object.fromEntries(LEDGER.map((t) => [t, rows(db, t)]));
    const columnsBefore = Object.fromEntries(LEDGER.map((t) => [t, columns(db, t)]));
    const indexesBefore = indexes(db);
    const keysBefore = Object.fromEntries(LEDGER.map((t) => [t, foreignKeys(db, t)]));
    for (const t of LEDGER) expect(before[t].length, t).toBeGreaterThan(0);

    apply(db, "0102_pipeline_review_run_kind.sql");

    for (const t of LEDGER) {
      expect(columns(db, t), t).toEqual(columnsBefore[t]);
      expect(rows(db, t), t).toEqual(before[t]);
      expect(foreignKeys(db, t), t).toEqual(keysBefore[t]);
    }
    // The autoindexes of UNIQUE and PRIMARY KEY constraints are named
    // after their table, so they come back under the same names.
    expect(indexes(db)).toEqual(indexesBefore);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_hold'").all()).toEqual([]);
  });

  it("still refuses an orphan in every child", () => {
    const db = seeded();
    apply(db, "0102_pipeline_review_run_kind.sql");
    expect(() =>
      insert(db, "pipeline_run_chunks", { id: "chunk-x", run_id: "no-run", tenant_id: TENANT, chunk_index: 0, created_at: 1 }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert(db, "pipeline_run_volumes", {
        id: "rv-x", run_id: "no-run", tenant_id: TENANT, pipeline_volume_id: "pv-1", declaration_id: "decl-1",
        job_index: 0, chunk_index: 0, reference_code: "co-1", tile_root: "co-1", expected_count: 1,
        resolved_recipe: "{}", created_at: 1,
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert(db, "pipeline_review_items", {
        id: "ri-x", tenant_id: TENANT, pipeline_volume_id: "pv-1", run_id: "no-run", page_key: "p",
        stage: "render", code: "c", summary: "s", declaration_id: "decl-1", declaration_version: 1,
        script_version: "v", created_at: 1,
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      insert(db, "pipeline_publications", {
        id: "pub-x", tenant_id: TENANT, pipeline_volume_id: "pv-1", run_id: "run-1", run_volume_id: "no-rv",
        user_id: "user-1", status: "claimed", claim_id: "c", canonical_url: "u", canonical_key: "k-x",
        manifest_sha256: HEX, canonical_expect: "{}", claimed_at: 1,
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("DELETE FROM pipeline_runs WHERE id = 'run-1'").run()).toThrow(/FOREIGN KEY/);
  });

  it("takes a review run with no purpose and no user, and refuses those nulls for the other kinds", () => {
    const db = seeded();
    apply(db, "0102_pipeline_review_run_kind.sql");
    const open = { status: "dispatched", token_revoked_at: null, completed_at: null };

    insert(db, "pipeline_runs", run("review-1", { ...open, kind: "review_run", purpose: null, user_id: null }));
    insert(db, "pipeline_runs", run("review-2", { ...open, kind: "review_run", purpose: null, user_id: "user-1" }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE kind = 'review_run'").get()).toEqual({ n: 2 });

    for (const kind of ["volume_run", "item_pdf"]) {
      expect(() => insert(db, "pipeline_runs", run(`${kind}-np`, { ...open, kind, purpose: null })), kind).toThrow(/CHECK/);
      expect(() => insert(db, "pipeline_runs", run(`${kind}-nu`, { ...open, kind, user_id: null })), kind).toThrow(/CHECK/);
    }
    expect(() =>
      insert(db, "pipeline_runs", run("review-3", { ...open, kind: "review_run", purpose: "sample", user_id: null })),
    ).toThrow(/CHECK/);
    expect(() =>
      insert(db, "pipeline_runs", run("purge-1", { ...open, kind: "review_purge", purpose: null, user_id: null })),
    ).toThrow(/CHECK/);
  });

  it("keeps the slug freeze firing", () => {
    const db = seeded();
    apply(db, "0102_pipeline_review_run_kind.sql");
    expect(() => db.prepare(`UPDATE tenants SET slug = 'renamed' WHERE id = '${TENANT}'`).run()).toThrow(
      /tenant_slug_frozen/,
    );
  });
});

describe("migration 0103", () => {
  function migrated(): DatabaseSync {
    const db = seeded();
    apply(db, "0102_pipeline_review_run_kind.sql");
    apply(db, "0103_capture_review_runs.sql");
    insert(db, "pipeline_runs", run("review-1", {
      status: "dispatched", token_revoked_at: null, completed_at: null, kind: "review_run", purpose: null, user_id: null,
    }));
    insert(db, "capture_deliveries", {
      tenant_id: TENANT, id: "del-1", route: "file", scanner_id: null, reference_code: "co-1", pipeline_volume_id: "pv-1",
      body_sha256: HEX, state: "registered", answer_status: 200, answer_body: "{}", openings: 2, received_at: 1, seq: 1,
    });
    return db;
  }

  const review = (extra: Row = {}): Row => ({
    tenant_id: TENANT, run_id: "review-1", delivery_id: "del-1", pipeline_volume_id: "pv-1",
    review_prefix: "test-tenant/del-1/", created_at: 1, ...extra,
  });

  it("adds the review runs and keeps the ledger's rows", () => {
    const db = seeded();
    apply(db, "0102_pipeline_review_run_kind.sql");
    const before = rows(db, "pipeline_run_volumes");
    apply(db, "0103_capture_review_runs.sql");
    expect(rows(db, "pipeline_run_volumes")).toEqual(before.map((r) => ({ ...r, review_purge: null })));
    expect(columns(db, "capture_review_runs")).toEqual([
      "tenant_id", "run_id", "delivery_id", "pipeline_volume_id", "review_prefix", "status", "claim_id",
      "idempotency_key", "body_sha256", "stored_response", "attempt", "error", "tiles_bytes", "report_key",
      "reported_at", "created_at", "purge_status", "purged_at",
    ]);
  });

  it("records a review run against its delivery, once per run and volume, and checks its values", () => {
    const db = migrated();
    insert(db, "capture_review_runs", review());
    expect(rows(db, "capture_review_runs")[0]).toMatchObject({ status: "dispatched", purge_status: null });
    expect(() => insert(db, "capture_review_runs", review())).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(db, "capture_review_runs", review({ run_id: "run-1", delivery_id: "no-delivery" }))).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => insert(db, "capture_review_runs", review({ run_id: "run-1", status: "prepared" }))).toThrow(/CHECK/);
    expect(() => insert(db, "capture_review_runs", review({ run_id: "run-1", review_prefix: "no-slash" }))).toThrow(/CHECK/);
    expect(() => insert(db, "capture_review_runs", review({ run_id: "run-1", purge_status: "purged" }))).toThrow(/CHECK/);
    expect(() => insert(db, "capture_review_runs", review({ run_id: "run-1", purged_at: 5 }))).toThrow(/CHECK/);
    insert(db, "capture_review_runs", review({ run_id: "run-1", purge_status: "purged", purged_at: 5 }));
    insert(db, "capture_review_runs", review({ run_id: "run-2", purge_status: "failed" }));
  });

  it("keeps review_purge to JSON or null", () => {
    const db = migrated();
    db.prepare(`UPDATE pipeline_run_volumes SET review_purge = '{"status":"purged"}' WHERE id = 'rv-1'`).run();
    expect(() => db.prepare("UPDATE pipeline_run_volumes SET review_purge = 'not json' WHERE id = 'rv-1'").run()).toThrow(
      /CHECK/,
    );
  });
});

// @version v0.8.0
