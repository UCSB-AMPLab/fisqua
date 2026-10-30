/**
 * Tests — media pipeline schema: review items and gate passes
 *
 * This suite pins the table constraints of the two tables that record
 * what people decided about the pipeline's output. A review item is an
 * open flag on one page of one volume in one run, at a known stage; a
 * gate pass records that one declaration version passed its sample
 * gate with one script version. Because each declaration version is
 * its own row, a pass for version 1 does not cover version 2: the next
 * version needs its own pass, and the same version cannot pass twice
 * with the same script version.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestUser } from "../helpers/auth";

const TENANT = DEFAULT_TEST_TENANT_ID;
const HEX64 = "0123456789abcdef".repeat(4);

let userId: string;
let scopeId: string;
let volumeId: string;
let runId: string;
let declarationV1: string;
let declarationV2: string;

type Row = Record<string, unknown>;

async function insert(table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  )
    .bind(...cols.map((c) => row[c]))
    .run();
}

async function insertDeclaration(version: number): Promise<string> {
  const id = crypto.randomUUID();
  await insert("pipeline_recipe_declarations", {
    id,
    tenant_id: TENANT,
    scope_description_id: scopeId,
    version,
    platen: "v",
    background: "dark",
    output_class: "bilevel",
    tone_preset: "default",
    created_by: userId,
    created_at: Date.now(),
  });
  return id;
}

async function seed(): Promise<void> {
  const now = Date.now();
  const repo = await createTestRepository();
  userId = (await createTestUser()).id;
  scopeId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "fonds" })).id;
  const unitId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "file", parentId: scopeId })).id;
  declarationV1 = await insertDeclaration(1);
  declarationV2 = await insertDeclaration(2);
  volumeId = crypto.randomUUID();
  await insert("pipeline_volumes", {
    id: volumeId,
    tenant_id: TENANT,
    description_id: unitId,
    reference_code: "co-test-vol-1",
    kind: "volume_run",
    masters_backend: "b2",
    masters_endpoint: "https://s3.example.test",
    masters_bucket: "masters",
    masters_prefix: "masters/co-test-vol-1/",
    expected_count: 2,
    recipe_scope_description_id: scopeId,
    created_at: now,
    updated_at: now,
  });
  runId = crypto.randomUUID();
  await insert("pipeline_runs", {
    id: runId,
    tenant_id: TENANT,
    user_id: userId,
    kind: "volume_run",
    purpose: "sample",
    runner_image: `ghcr.io/example/runner@sha256:${HEX64}`,
    script_version: "1.0.0",
    arch: "x64",
    max_review_frac: 0.2,
    spec_key: `${TENANT}/pipeline-runs/${runId}/spec.json`,
    spec_sha256: HEX64,
    spec_url_expires_at: now + 1000,
    chunk_count: 1,
    volume_count: 1,
    callback_token_hash: HEX64,
    token_expires_at: now + 2000,
    created_at: now,
  });
}

function reviewItem(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT,
    pipeline_volume_id: volumeId,
    run_id: runId,
    page_key: "p0001",
    stage: "preprocess",
    code: "skew",
    summary: "Skew above threshold",
    declaration_id: declarationV1,
    declaration_version: 1,
    script_version: "1.0.0",
    created_at: Date.now(),
    ...overrides,
  };
}

function gatePass(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT,
    declaration_id: declarationV1,
    script_version: "1.0.0",
    sample_run_id: runId,
    passed_by: userId,
    passed_at: Date.now(),
    ...overrides,
  };
}

describe("media pipeline schema: review items and gate passes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
  });

  it("inserts an open review item", async () => {
    const row = reviewItem();
    await insert("pipeline_review_items", row);
    const stored = await env.DB.prepare("SELECT verdict FROM pipeline_review_items WHERE id = ?")
      .bind(row.id)
      .first<{ verdict: string | null }>();
    expect(stored?.verdict).toBeNull();
  });

  it("refuses a review item at an unknown stage", async () => {
    await expect(insert("pipeline_review_items", reviewItem({ stage: "scan" }))).rejects.toThrow(/CHECK/);
  });

  it("refuses an unknown verdict", async () => {
    await expect(
      insert("pipeline_review_items", reviewItem({ verdict: "reject" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses the same flag twice for one page in one run", async () => {
    await insert("pipeline_review_items", reviewItem());
    await expect(insert("pipeline_review_items", reviewItem())).rejects.toThrow(/UNIQUE/);
  });

  it("refuses a second gate pass for the same declaration version and script version", async () => {
    await insert("pipeline_gate_passes", gatePass());
    await expect(insert("pipeline_gate_passes", gatePass())).rejects.toThrow(/UNIQUE/);
  });

  it("accepts a gate pass for the next declaration version with the same script version", async () => {
    await insert("pipeline_gate_passes", gatePass());
    await insert("pipeline_gate_passes", gatePass({ declaration_id: declarationV2 }));
  });

  it("cleanDatabase wipes review items and gate passes with the ledger", async () => {
    await insert("pipeline_review_items", reviewItem());
    await insert("pipeline_gate_passes", gatePass());
    await cleanDatabase();
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM pipeline_review_items) AS items, " +
        "(SELECT COUNT(*) FROM pipeline_gate_passes) AS passes, " +
        "(SELECT COUNT(*) FROM pipeline_recipe_declarations) AS declarations",
    ).first<{ items: number; passes: number; declarations: number }>();
    expect(counts).toEqual({ items: 0, passes: 0, declarations: 0 });
  });
});
