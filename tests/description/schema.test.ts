/**
 * Tests — schema
 *
 * @version v0.3.0
 */
import { describe, test, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "../helpers/db";

describe("Description schema (DESC-01)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  test("entries table has description status column", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(entries)").all();
    const columnNames = result.results.map((r: any) => r.name);
    expect(columnNames).toContain("description_status");
  });

  test("entries table has all 11 description metadata columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(entries)").all();
    const columnNames = result.results.map((r: any) => r.name);
    const expectedColumns = [
      "translated_title",
      "resource_type",
      "date_expression",
      "date_start",
      "date_end",
      "extent",
      "scope_content",
      "language",
      "description_notes",
      "internal_notes",
      "description_level",
    ];
    for (const col of expectedColumns) {
      expect(columnNames).toContain(col);
    }
  });

  test("entries table has assignment columns (assignedDescriber, assignedDescriptionReviewer)", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(entries)").all();
    const columnNames = result.results.map((r: any) => r.name);
    expect(columnNames).toContain("assigned_describer");
    expect(columnNames).toContain("assigned_description_reviewer");
  });

  test("comments table exists with correct columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    const columnNames = result.results.map((r: any) => r.name);
    const expectedColumns = [
      "id",
      "entry_id",
      "parent_id",
      "author_id",
      "author_role",
      "text",
      "created_at",
      "updated_at",
    ];
    for (const col of expectedColumns) {
      expect(columnNames).toContain(col);
    }
  });

  test("resegmentation_flags table exists with correct columns", async () => {
    const result = await env.DB.prepare(
      "PRAGMA table_info(resegmentation_flags)"
    ).all();
    const columnNames = result.results.map((r: any) => r.name);
    const expectedColumns = [
      "id",
      "volume_id",
      "reported_by",
      "entry_id",
      "problem_type",
      "affected_entry_ids",
      "description",
      "status",
      "resolved_by",
      "resolved_at",
      "created_at",
    ];
    for (const col of expectedColumns) {
      expect(columnNames).toContain(col);
    }
  });
});

describe("schema (page targets + qc_flags)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  // --- comments table shape ---

  test("comments table has volume_id, entry_id, page_id columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    const columnNames = result.results.map((r: any) => r.name);
    const expectedColumns = [
      "id",
      "volume_id",
      "entry_id",
      "page_id",
      "parent_id",
      "author_id",
      "author_role",
      "text",
      "created_at",
      "updated_at",
    ];
    for (const col of expectedColumns) {
      expect(columnNames).toContain(col);
    }
  });

  test("comments.entry_id is nullable", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    const row = result.results.find((r: any) => r.name === "entry_id") as any;
    expect(row).toBeDefined();
    expect(row.notnull).toBe(0);
  });

  test("comments.page_id is nullable", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    const row = result.results.find((r: any) => r.name === "page_id") as any;
    expect(row).toBeDefined();
    expect(row.notnull).toBe(0);
  });

  test("comments.volume_id is NOT NULL", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    const row = result.results.find((r: any) => r.name === "volume_id") as any;
    expect(row).toBeDefined();
    expect(row.notnull).toBe(1);
  });

  // --- comments CHECK constraint (exactly one of entry_id, page_id) ---

  test("comments CHECK rejects rows with both entry_id and page_id set", async () => {
    // Fixture: user, project, volume, volume_page, entry
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-both", "u-both@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-both", "p", "u-both", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-both", "p-both", "v", "ref", "http://x", 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volume_pages (id, volume_id, position, image_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("vp-both", "v-both", 1, "http://x", 100, 100, now).run();
    await env.DB.prepare(
      "INSERT INTO entries (id, volume_id, position, start_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind("e-both", "v-both", 0, 1, now, now).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO comments (id, volume_id, entry_id, page_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("c-both", "v-both", "e-both", "vp-both", "u-both", "cataloguer", "x", now, now).run()
    ).rejects.toThrow();
  });

  test("comments CHECK rejects rows with neither entry_id nor page_id set", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-neither", "u-neither@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-neither", "p", "u-neither", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-neither", "p-neither", "v", "ref", "http://x", 1, now, now).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO comments (id, volume_id, entry_id, page_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("c-neither", "v-neither", null, null, "u-neither", "cataloguer", "x", now, now).run()
    ).rejects.toThrow();
  });

  // --- qc_flags table shape ---

  // Note: column count was 12 at baseline; migration 0031
  // added `region_comment_id` for the (subsequently reverted)
  // follow-up. The column still exists in D1 because no drop-column
  // migration was issued, but no application code reads/writes it
  // after the 2026-04-18 cleanup, so the schema-test suite no longer
  // asserts that specific column or the dedicated describe block.
  test("qc_flags table has the 12 baseline columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(qc_flags)").all();
    const columnNames = result.results.map((r: any) => r.name);
    const expectedColumns = [
      "id",
      "volume_id",
      "page_id",
      "reported_by",
      "problem_type",
      "description",
      "status",
      "resolution_action",
      "resolver_note",
      "resolved_by",
      "resolved_at",
      "created_at",
    ];
    for (const col of expectedColumns) {
      expect(columnNames).toContain(col);
    }
  });

  test("qc_flags has expected indexes", async () => {
    const result = await env.DB.prepare(
      "PRAGMA index_list(qc_flags)"
    ).all();
    const indexNames = result.results.map((r: any) => r.name);
    expect(indexNames).toContain("qc_flags_volume_status_idx");
    expect(indexNames).toContain("qc_flags_page_idx");
    expect(indexNames).toContain("qc_flags_reporter_idx");
  });

  // --- qc_flags CHECK constraints ---

  test("qc_flags CHECK rejects problem_type='other' with empty description", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-qc1", "u-qc1@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-qc1", "p", "u-qc1", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-qc1", "p-qc1", "v", "ref", "http://x", 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volume_pages (id, volume_id, position, image_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("vp-qc1", "v-qc1", 1, "http://x", 100, 100, now).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO qc_flags (id, volume_id, page_id, reported_by, problem_type, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("f-qc1", "v-qc1", "vp-qc1", "u-qc1", "other", "", "open", now).run()
    ).rejects.toThrow();
  });

  test("qc_flags CHECK rejects status='resolved' with NULL resolution_action", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-qc2", "u-qc2@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-qc2", "p", "u-qc2", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-qc2", "p-qc2", "v", "ref", "http://x", 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volume_pages (id, volume_id, position, image_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("vp-qc2", "v-qc2", 1, "http://x", 100, 100, now).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO qc_flags (id, volume_id, page_id, reported_by, problem_type, description, status, resolution_action, resolved_by, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("f-qc2", "v-qc2", "vp-qc2", "u-qc2", "damaged", "torn page", "resolved", null, null, null, now).run()
    ).rejects.toThrow();
  });

  test("qc_flags CHECK rejects status='open' with resolution_action set", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-qc3", "u-qc3@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-qc3", "p", "u-qc3", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-qc3", "p-qc3", "v", "ref", "http://x", 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volume_pages (id, volume_id, position, image_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("vp-qc3", "v-qc3", 1, "http://x", 100, 100, now).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO qc_flags (id, volume_id, page_id, reported_by, problem_type, description, status, resolution_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("f-qc3", "v-qc3", "vp-qc3", "u-qc3", "damaged", "torn", "open", "retake_requested", now).run()
    ).rejects.toThrow();
  });

  test("qc_flags accepts a valid open flag", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-qc4", "u-qc4@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-qc4", "p", "u-qc4", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-qc4", "p-qc4", "v", "ref", "http://x", 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volume_pages (id, volume_id, position, image_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("vp-qc4", "v-qc4", 1, "http://x", 100, 100, now).run();

    await env.DB.prepare(
      "INSERT INTO qc_flags (id, volume_id, page_id, reported_by, problem_type, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("f-qc4", "v-qc4", "vp-qc4", "u-qc4", "damaged", "torn page", "open", now).run();

    const rows = await env.DB.prepare("SELECT * FROM qc_flags WHERE id = ?").bind("f-qc4").all();
    expect(rows.results.length).toBe(1);
  });
});

// extends the comments table: a new nullable qc_flag_id FK so
// comments can attach to a QC flag, and nullable region_x/y/w/h
// REAL columns for image-region pins on page-targeted comments.
// The target CHECK extends from a two-way XOR on (entry_id, page_id) to a
// three-way XOR that also covers qc_flag_id. Region columns are
// independent of the CHECK: the DB does not enforce "region requires
// page_id" -- that invariant lives in createComment.
describe("schema (qc_flag target + image regions)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  // Shared fixture helper -- FK-safe setup inserting user, project,
  // volume, volume_page, entry, and an open qc_flag keyed by `tag`.
  async function seedFixture(tag: string) {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(`u-${tag}`, `u-${tag}@example.com`, now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(`p-${tag}`, "p", `u-${tag}`, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(`v-${tag}`, `p-${tag}`, "v", "ref", "http://x", 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO volume_pages (id, volume_id, position, image_url, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(`vp-${tag}`, `v-${tag}`, 1, "http://x", 100, 100, now).run();
    await env.DB.prepare(
      "INSERT INTO entries (id, volume_id, position, start_page, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(`e-${tag}`, `v-${tag}`, 0, 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO qc_flags (id, volume_id, page_id, reported_by, problem_type, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(`f-${tag}`, `v-${tag}`, `vp-${tag}`, `u-${tag}`, "damaged", "torn", "open", now).run();
    return {
      now,
      userId: `u-${tag}`,
      volumeId: `v-${tag}`,
      pageId: `vp-${tag}`,
      entryId: `e-${tag}`,
      qcFlagId: `f-${tag}`,
    };
  }

  // --- column shape assertions ---

  test("comments.qc_flag_id column exists and is nullable TEXT", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    const row = result.results.find((r: any) => r.name === "qc_flag_id") as any;
    expect(row).toBeDefined();
    expect(row.type).toBe("TEXT");
    expect(row.notnull).toBe(0);
  });

  test("comments region columns exist and are nullable REAL", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(comments)").all();
    for (const col of ["region_x", "region_y", "region_w", "region_h"]) {
      const row = result.results.find((r: any) => r.name === col) as any;
      expect(row).toBeDefined();
      expect(row.type).toBe("REAL");
      expect(row.notnull).toBe(0);
    }
  });

  test("comment_qc_flag_idx index exists on comments", async () => {
    const result = await env.DB.prepare("PRAGMA index_list(comments)").all();
    const indexNames = result.results.map((r: any) => r.name);
    expect(indexNames).toContain("comment_qc_flag_idx");
  });

  // --- three-way CHECK rejects ---

  test("three-way CHECK rejects setting entry_id AND qc_flag_id", async () => {
    const f = await seedFixture("c3a");
    await expect(
      env.DB.prepare(
        "INSERT INTO comments (id, volume_id, entry_id, page_id, qc_flag_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          "c-c3a",
          f.volumeId,
          f.entryId,
          null,
          f.qcFlagId,
          f.userId,
          "cataloguer",
          "x",
          f.now,
          f.now
        )
        .run()
    ).rejects.toThrow();
  });

  test("three-way CHECK rejects setting page_id AND qc_flag_id", async () => {
    const f = await seedFixture("c3b");
    await expect(
      env.DB.prepare(
        "INSERT INTO comments (id, volume_id, entry_id, page_id, qc_flag_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          "c-c3b",
          f.volumeId,
          null,
          f.pageId,
          f.qcFlagId,
          f.userId,
          "cataloguer",
          "x",
          f.now,
          f.now
        )
        .run()
    ).rejects.toThrow();
  });

  test("three-way CHECK rejects all three target columns NULL", async () => {
    const f = await seedFixture("c3c");
    await expect(
      env.DB.prepare(
        "INSERT INTO comments (id, volume_id, entry_id, page_id, qc_flag_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          "c-c3c",
          f.volumeId,
          null,
          null,
          null,
          f.userId,
          "cataloguer",
          "x",
          f.now,
          f.now
        )
        .run()
    ).rejects.toThrow();
  });

  // --- accept paths ---

  test("qc_flag-only target succeeds", async () => {
    const f = await seedFixture("c3d");
    await env.DB.prepare(
      "INSERT INTO comments (id, volume_id, entry_id, page_id, qc_flag_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "c-c3d",
        f.volumeId,
        null,
        null,
        f.qcFlagId,
        f.userId,
        "cataloguer",
        "Discussing this flag",
        f.now,
        f.now
      )
      .run();

    const rows = await env.DB.prepare(
      "SELECT entry_id, page_id, qc_flag_id FROM comments WHERE id = ?"
    )
      .bind("c-c3d")
      .all();
    expect(rows.results.length).toBe(1);
    const row = rows.results[0] as any;
    expect(row.entry_id).toBeNull();
    expect(row.page_id).toBeNull();
    expect(row.qc_flag_id).toBe(f.qcFlagId);
  });

  test("page-target with region coords succeeds and preserves REAL values", async () => {
    const f = await seedFixture("c3e");
    await env.DB.prepare(
      "INSERT INTO comments (id, volume_id, entry_id, page_id, qc_flag_id, region_x, region_y, region_w, region_h, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "c-c3e",
        f.volumeId,
        null,
        f.pageId,
        null,
        0.25,
        0.5,
        0.1,
        0.1,
        f.userId,
        "cataloguer",
        "see this smudge",
        f.now,
        f.now
      )
      .run();

    const rows = await env.DB.prepare(
      "SELECT region_x, region_y, region_w, region_h FROM comments WHERE id = ?"
    )
      .bind("c-c3e")
      .all();
    expect(rows.results.length).toBe(1);
    const row = rows.results[0] as any;
    expect(row.region_x).toBeCloseTo(0.25, 6);
    expect(row.region_y).toBeCloseTo(0.5, 6);
    expect(row.region_w).toBeCloseTo(0.1, 6);
    expect(row.region_h).toBeCloseTo(0.1, 6);
  });

  test("page-target with no region coords stores NULL region columns", async () => {
    const f = await seedFixture("c3f");
    await env.DB.prepare(
      "INSERT INTO comments (id, volume_id, entry_id, page_id, qc_flag_id, author_id, author_role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "c-c3f",
        f.volumeId,
        null,
        f.pageId,
        null,
        f.userId,
        "cataloguer",
        "page-only",
        f.now,
        f.now
      )
      .run();

    const rows = await env.DB.prepare(
      "SELECT region_x, region_y, region_w, region_h FROM comments WHERE id = ?"
    )
      .bind("c-c3f")
      .all();
    expect(rows.results.length).toBe(1);
    const row = rows.results[0] as any;
    expect(row.region_x).toBeNull();
    expect(row.region_y).toBeNull();
    expect(row.region_w).toBeNull();
    expect(row.region_h).toBeNull();
  });
});

// cleanup 2026-04-18: the "Vincular a región" follow-up
// describe block previously pinned the `qc_flags.region_comment_id`
// column shape, the supporting index, and NULL + FK-linked insert paths.
// The feature was reverted after Wave 2 browser UAT -- QC flags are
// image-level, not region-level -- so those assertions have been
// dropped. The DB column still exists (migration 0031 was NOT rolled
// back per cleanup policy) but is deprecated and no application code
// reads or writes it any longer.

// post-Wave-2 (migration 0032): `entries.subtype` carries the
// per-entry document subtype label (only meaningful when type='item'),
// and `test_images` joins the EntryType CHECK so cataloguers can tag
// test / calibration targets separately from blank or front-matter
// pages. Tests pin the column shape AND the accept-vs-reject behaviour
// of the CHECK against the new enum value.
describe("schema (entries.subtype + test_images EntryType)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  test("entries.subtype column exists as nullable TEXT", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(entries)").all();
    const row = result.results.find((r: any) => r.name === "subtype") as any;
    expect(row).toBeDefined();
    expect(row.type).toBe("TEXT");
    expect(row.notnull).toBe(0);
  });

  test("entries.type CHECK accepts 'test_images'", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-ti", "u-ti@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-ti", "p", "u-ti", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-ti", "p-ti", "v", "ref", "http://x", 1, now, now).run();

    await env.DB.prepare(
      "INSERT INTO entries (id, volume_id, position, start_page, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("e-ti", "v-ti", 0, 1, "test_images", now, now).run();

    const rows = await env.DB.prepare(
      "SELECT type, subtype FROM entries WHERE id = ?"
    ).bind("e-ti").all();
    expect(rows.results.length).toBe(1);
    const row = rows.results[0] as any;
    expect(row.type).toBe("test_images");
    expect(row.subtype).toBeNull();
  });

  test("entries.type CHECK rejects a bogus value", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-bogus", "u-bogus@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-bogus", "p", "u-bogus", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-bogus", "p-bogus", "v", "ref", "http://x", 1, now, now).run();

    await expect(
      env.DB.prepare(
        "INSERT INTO entries (id, volume_id, position, start_page, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("e-bogus", "v-bogus", 0, 1, "not_a_real_type", now, now).run()
    ).rejects.toThrow();
  });

  test("entries.subtype round-trips a Colombian Spanish label", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind("u-st", "u-st@example.com", now, now).run();
    await env.DB.prepare(
      "INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("p-st", "p", "u-st", now, now).run();
    await env.DB.prepare(
      "INSERT INTO volumes (id, project_id, name, reference_code, manifest_url, page_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("v-st", "p-st", "v", "ref", "http://x", 1, now, now).run();

    await env.DB.prepare(
      "INSERT INTO entries (id, volume_id, position, start_page, type, subtype, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind("e-st", "v-st", 0, 1, "item", "Escritura", now, now).run();

    const rows = await env.DB.prepare(
      "SELECT type, subtype FROM entries WHERE id = ?"
    ).bind("e-st").all();
    expect(rows.results.length).toBe(1);
    const row = rows.results[0] as any;
    expect(row.type).toBe("item");
    expect(row.subtype).toBe("Escritura");
  });
});
