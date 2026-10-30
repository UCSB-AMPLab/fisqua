/**
 * Tests — media pipeline schema: runs, dispatch chunks, run volumes
 *
 * This suite pins the table constraints of the run ledger: the run row,
 * one row per dispatch chunk, and one row per volume in the run. Each
 * case is a single INSERT expected either to fail a constraint or to
 * succeed against the test schema.
 *
 * What the constraints carry: a run names its runner image by digest,
 * never by tag; its script version is never blank; it stores only the
 * 64-character digest of its callback token, and no other column whose
 * name mentions a token beyond that digest and the token's expiry and
 * revocation times; its spec URL expires before its token does; and
 * its status agrees with whether it is closed (`token_revoked_at`), with
 * `halted` allowed either way. A run volume carries its resolved recipe
 * as valid JSON, and a volume appears once per run. A chunk appears once
 * per run, with a known status and a known conclusion.
 *
 * The last case checks that `cleanDatabase()` wipes the ledger in an
 * order its foreign keys allow.
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
const DIGEST_IMAGE = `ghcr.io/example/runner@sha256:${HEX64}`;

let userId: string;
let volumeId: string;
let declarationId: string;

type Row = Record<string, unknown>;

async function insert(table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  )
    .bind(...cols.map((c) => row[c]))
    .run();
}

async function seed(): Promise<void> {
  const now = Date.now();
  const repo = await createTestRepository();
  const user = await createTestUser();
  userId = user.id;
  const scopeId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "fonds" })).id;
  const unitId = (await createTestDescription({ repositoryId: repo.id, descriptionLevel: "file", parentId: scopeId })).id;
  declarationId = crypto.randomUUID();
  await insert("pipeline_recipe_declarations", {
    id: declarationId,
    tenant_id: TENANT,
    scope_description_id: scopeId,
    version: 1,
    platen: "v",
    background: "dark",
    output_class: "bilevel",
    tone_preset: "default",
    created_by: userId,
    created_at: now,
  });
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
}

function run(overrides: Row = {}): Row {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    tenant_id: TENANT,
    user_id: userId,
    kind: "volume_run",
    purpose: "sample",
    runner_image: DIGEST_IMAGE,
    script_version: "1.0.0",
    arch: "x64",
    max_review_frac: 0.2,
    spec_key: `${TENANT}/pipeline-runs/x/spec.json`,
    spec_sha256: HEX64,
    spec_url_expires_at: now + 1000,
    chunk_count: 1,
    volume_count: 1,
    callback_token_hash: HEX64,
    token_expires_at: now + 2000,
    created_at: now,
    ...overrides,
  };
}

async function insertRun(overrides: Row = {}): Promise<string> {
  const row = run(overrides);
  await insert("pipeline_runs", row);
  return row.id as string;
}

function chunk(runId: string, overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: TENANT,
    chunk_index: 0,
    created_at: Date.now(),
    ...overrides,
  };
}

function runVolume(runId: string, overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: TENANT,
    pipeline_volume_id: volumeId,
    declaration_id: declarationId,
    job_index: 0,
    chunk_index: 0,
    reference_code: "co-test-vol-1",
    tile_root: "co-test-vol-1",
    expected_count: 2,
    resolved_recipe: "{}",
    created_at: Date.now(),
    ...overrides,
  };
}

describe("media pipeline schema: runs", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
  });

  it("refuses a runner image given by tag", async () => {
    await expect(insertRun({ runner_image: "ghcr.io/x/y:v1" })).rejects.toThrow(/CHECK/);
  });

  it("refuses a runner image digest with trailing characters", async () => {
    await expect(insertRun({ runner_image: `ghcr.io/x/y@sha256:${HEX64}zz` })).rejects.toThrow(/CHECK/);
  });

  it("refuses a runner image digest of 63 hex digits", async () => {
    await expect(
      insertRun({ runner_image: `ghcr.io/x/y@sha256:${HEX64.slice(1)}` }),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a runner image digest in upper-case hex", async () => {
    await expect(
      insertRun({ runner_image: `ghcr.io/x/y@sha256:${HEX64.toUpperCase()}` }),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a bare digest with no repository", async () => {
    await expect(insertRun({ runner_image: `@sha256:${HEX64}` })).rejects.toThrow(/CHECK/);
  });

  it("inserts a run whose runner image is a repository and a digest", async () => {
    await insertRun();
  });

  it("refuses an empty script version", async () => {
    await expect(insertRun({ script_version: "" })).rejects.toThrow(/CHECK/);
    await expect(insertRun({ script_version: "   " })).rejects.toThrow(/CHECK/);
  });

  it("refuses a token digest of 63 characters", async () => {
    await expect(insertRun({ callback_token_hash: HEX64.slice(1) })).rejects.toThrow(/CHECK/);
  });

  it("refuses a spec URL that expires at or after the token", async () => {
    const now = Date.now();
    await expect(
      insertRun({ spec_url_expires_at: now + 2000, token_expires_at: now + 2000 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRun({ spec_url_expires_at: now + 3000, token_expires_at: now + 2000 }),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a completed run that is not closed", async () => {
    await expect(insertRun({ status: "completed", token_revoked_at: null })).rejects.toThrow(/CHECK/);
  });

  it("refuses a running run that is closed", async () => {
    await expect(insertRun({ status: "running", token_revoked_at: Date.now() })).rejects.toThrow(/CHECK/);
  });

  it("inserts a halted run whether or not it is closed", async () => {
    await insertRun({ status: "halted", token_revoked_at: null });
    await insertRun({ status: "halted", token_revoked_at: Date.now() });
  });

  it("stores no token column beyond the digest, the expiry and the revocation time", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(pipeline_runs)").all<{ name: string }>();
    const tokenColumns = results.map((r) => r.name).filter((n) => n.includes("token")).sort();
    expect(tokenColumns).toEqual(["callback_token_hash", "token_expires_at", "token_revoked_at"]);
  });
});

describe("media pipeline schema: run volumes and chunks", () => {
  let runId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seed();
    runId = await insertRun();
  });

  it("refuses a resolved recipe that is not JSON", async () => {
    await expect(
      insert("pipeline_run_volumes", runVolume(runId, { resolved_recipe: "not json" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a second row for the same volume in the same run", async () => {
    await insert("pipeline_run_volumes", runVolume(runId));
    await expect(insert("pipeline_run_volumes", runVolume(runId, { job_index: 1 }))).rejects.toThrow(
      /UNIQUE/,
    );
  });

  it("refuses a second chunk row with the same index in the same run", async () => {
    await insert("pipeline_run_chunks", chunk(runId));
    await expect(insert("pipeline_run_chunks", chunk(runId))).rejects.toThrow(/UNIQUE/);
  });

  it("refuses an unknown chunk status", async () => {
    await expect(insert("pipeline_run_chunks", chunk(runId, { status: "sent" }))).rejects.toThrow(/CHECK/);
  });

  it("refuses an unknown chunk conclusion", async () => {
    await expect(
      insert("pipeline_run_chunks", chunk(runId, { conclusion: "skipped" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("defaults a chunk to pending and a run volume to dispatched", async () => {
    const chunkRow = chunk(runId);
    await insert("pipeline_run_chunks", chunkRow);
    const rvRow = runVolume(runId);
    await insert("pipeline_run_volumes", rvRow);
    const c = await env.DB.prepare("SELECT status FROM pipeline_run_chunks WHERE id = ?")
      .bind(chunkRow.id)
      .first<{ status: string }>();
    const rv = await env.DB.prepare(
      "SELECT status, flags_truncated FROM pipeline_run_volumes WHERE id = ?",
    )
      .bind(rvRow.id)
      .first<{ status: string; flags_truncated: number }>();
    expect(c?.status).toBe("pending");
    expect(rv).toEqual({ status: "dispatched", flags_truncated: 0 });
  });

  it("cleanDatabase wipes a run with its chunk and run volume", async () => {
    await insert("pipeline_run_chunks", chunk(runId));
    await insert("pipeline_run_volumes", runVolume(runId));
    await cleanDatabase();
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM pipeline_runs) AS runs, " +
        "(SELECT COUNT(*) FROM pipeline_run_chunks) AS chunks, " +
        "(SELECT COUNT(*) FROM pipeline_run_volumes) AS run_volumes",
    ).first<{ runs: number; chunks: number; run_volumes: number }>();
    expect(counts).toEqual({ runs: 0, chunks: 0, run_volumes: 0 });
  });
});
