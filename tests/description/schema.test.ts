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
