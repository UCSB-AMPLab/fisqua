/**
 * Tests — media pipeline truncated-flag ingest
 *
 * A per-volume report carries at most 500 flags. When a volume raised
 * more, the callback says the list was truncated and the rest are read
 * from the run report in the working bucket, in the background. This
 * suite pins that ingest:
 *
 *   - every open flag in the report becomes a review item, and flags
 *     the runner resolved by corroboration do not;
 *   - a second call finds the volume already ingested and inserts
 *     nothing;
 *   - a report that cannot be read leaves the volume marked as not yet
 *     ingested, so the sweep retries it, and the log names no object
 *     key;
 *   - with a small statement budget the work spreads over several
 *     calls, each making progress, until the volume's open review count
 *     is recomputed and it is marked ingested;
 *   - no statement binds more than 100 parameters.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedTenants } from "../helpers/db";
import { seedPipelineRun, type SeededRun } from "../helpers/media-pipeline";
import {
  ingestTruncatedFlags,
  buildFlagInsertStatements,
} from "../../app/lib/pipeline/flags-ingest.server";
import type { MediaObjectReader } from "../../app/lib/pipeline/store.server";

const WORKING_BUCKET = "test-working";
const REPORT_KEY = "report-key-for-test.json";

let run: SeededRun;

function reportFlag(i: number, corroborated = false) {
  return {
    page_key: `p${String(i).padStart(4, "0")}`,
    stage: "render",
    code: "edge_overflow",
    summary: `Flag ${i}.`,
    evidence: {},
    corroboration: corroborated ? { by: "preprocess" } : null,
  };
}

function report(open: number, corroborated = 0): string {
  const flags = [];
  for (let i = 1; i <= open; i++) flags.push(reportFlag(i));
  for (let i = 1; i <= corroborated; i++) flags.push(reportFlag(10_000 + i, true));
  return JSON.stringify({ spec_version: 1, flags, pages: [] });
}

function fakeReader(text: string | null): MediaObjectReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getText(bucket, key) {
      calls.push(`${bucket}/${key}`);
      return text;
    },
  };
}

async function markTruncated(runVolumeId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE pipeline_run_volumes SET status = 'review_pending', flags_truncated = 1, " +
      "flags_ingested_at = NULL, report_key = ? WHERE id = ?",
  )
    .bind(REPORT_KEY, runVolumeId)
    .run();
}

async function counts(): Promise<{ items: number; open: number; ingested: number | null }> {
  const v = run.volumes[0];
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM pipeline_review_items WHERE pipeline_volume_id = ?1) AS items, " +
      "(SELECT open_review_count FROM pipeline_volumes WHERE id = ?1) AS open, " +
      "(SELECT flags_ingested_at FROM pipeline_run_volumes WHERE id = ?2) AS ingested",
  )
    .bind(v.id, v.runVolumeId)
    .first<{ items: number; open: number; ingested: number | null }>();
  return row!;
}

function deps(reader: MediaObjectReader) {
  return { db: drizzle(env.DB), reader, now: () => Date.now(), workingBucket: WORKING_BUCKET };
}

describe("truncated-flag ingest", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    run = await seedPipelineRun();
    await markTruncated(run.volumes[0].runVolumeId);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const target = () => ({ tenantId: run.tenantId, runVolumeId: run.volumes[0].runVolumeId });

  it("turns every open flag into a review item and skips corroborated ones", async () => {
    const reader = fakeReader(report(520, 30));
    const result = await ingestTruncatedFlags(deps(reader), target());
    expect(result).toEqual({ inserted: 520, complete: true, statements: 65 });
    expect(reader.calls).toEqual([`${WORKING_BUCKET}/${REPORT_KEY}`]);
    const c = await counts();
    expect(c.items).toBe(520);
    expect(c.open).toBe(520);
    expect(c.ingested).not.toBeNull();
  });

  it("records the recipe triple of the run volume on every item", async () => {
    await ingestTruncatedFlags(deps(fakeReader(report(3))), target());
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT declaration_id, declaration_version, script_version, run_id, tenant_id " +
        "FROM pipeline_review_items",
    ).all();
    expect(results).toEqual([
      {
        declaration_id: run.declarationId,
        declaration_version: run.declarationVersion,
        script_version: "v1.0.0",
        run_id: run.runId,
        tenant_id: run.tenantId,
      },
    ]);
  });

  it("inserts nothing on a second call", async () => {
    await ingestTruncatedFlags(deps(fakeReader(report(520, 30))), target());
    const reader = fakeReader(report(520, 30));
    const again = await ingestTruncatedFlags(deps(reader), target());
    expect(again.inserted).toBe(0);
    expect(reader.calls).toEqual([]);
    expect((await counts()).items).toBe(520);
  });

  it("keeps items the callback already inserted and adds only the rest", async () => {
    const v = run.volumes[0];
    await env.DB.prepare(
      "INSERT INTO pipeline_review_items (id, tenant_id, pipeline_volume_id, run_id, page_key, stage, " +
        "code, summary, declaration_id, declaration_version, script_version, created_at) " +
        "VALUES (?, ?, ?, ?, 'p0001', 'render', 'edge_overflow', 'Flag 1.', ?, 1, 'v1.0.0', 1)",
    )
      .bind("already-there", run.tenantId, v.id, run.runId, run.declarationId)
      .run();
    const result = await ingestTruncatedFlags(deps(fakeReader(report(10))), target());
    expect(result).toEqual({ inserted: 9, complete: true, statements: 2 });
    expect((await counts()).items).toBe(10);
  });

  it("leaves the volume for the sweep when the report is missing, and logs no key", async () => {
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const result = await ingestTruncatedFlags(deps(fakeReader(null)), target());
    expect(result).toEqual({ inserted: 0, complete: false, statements: 0 });
    expect((await counts()).ingested).toBeNull();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(REPORT_KEY);
    expect(logged.join("\n")).toContain(run.runId);
  });

  it("leaves the volume for the sweep when the reader fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reader: MediaObjectReader = {
      async getText() {
        throw new Error("network down");
      },
    };
    const result = await ingestTruncatedFlags(deps(reader), target());
    expect(result.complete).toBe(false);
    expect((await counts()).ingested).toBeNull();
  });

  it("spreads the work over calls under a statement budget", async () => {
    const text = report(520, 30);
    const first = await ingestTruncatedFlags(deps(fakeReader(text)), target(), { maxStatements: 10 });
    expect(first).toEqual({ inserted: 80, complete: false, statements: 10 });
    expect((await counts()).ingested).toBeNull();
    let calls = 1;
    let result = first;
    while (!result.complete) {
      result = await ingestTruncatedFlags(deps(fakeReader(text)), target(), { maxStatements: 10 });
      calls++;
      expect(calls).toBeLessThan(20);
    }
    const c = await counts();
    expect(c.items).toBe(520);
    expect(c.open).toBe(520);
    expect(c.ingested).not.toBeNull();
    expect(calls).toBe(7);
  });

  it("builds no statement with more than 100 parameters", () => {
    const rows = Array.from({ length: 520 }, (_, i) => ({
      id: `id-${i}`,
      pipelineVolumeId: run.volumes[0].id,
      runId: run.runId,
      pageKey: `p${i}`,
      stage: "render" as const,
      code: "edge_overflow",
      summary: "A flag.",
      declarationId: run.declarationId,
      declarationVersion: 1,
      scriptVersion: "v1.0.0",
      createdAt: 1,
    }));
    const statements = buildFlagInsertStatements(drizzle(env.DB), run.tenantId, rows);
    expect(statements.length).toBe(65);
    for (const s of statements) {
      expect(s.toSQL().params.length).toBeLessThanOrEqual(100);
    }
  });
});

// @version v0.8.0
