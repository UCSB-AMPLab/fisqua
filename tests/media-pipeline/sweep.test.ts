/**
 * Tests — media pipeline scheduled sweep
 *
 * This suite drives `runPipelineSweep` against the local D1 database
 * with a fake media object reader. It pins:
 *
 *   - token expiry: every open run whose token has expired closes once,
 *     across tenants. A run with volumes outstanding ends in error with
 *     `token_expired`; one that recorded a dispatch error keeps it; one
 *     whose volumes all reported with no error completes; a halted run
 *     keeps its status and its halt error. No run-volume or volume row
 *     changes, and closed or unexpired runs are not touched;
 *   - a second sweep changes nothing;
 *   - holds: an open run past its expiry holds nothing before any sweep,
 *     and its volumes can enter a new run after the sweep;
 *   - truncated flags: a run volume whose flags the request could not
 *     finish ingesting is completed by the sweep; unfinished rows are
 *     retried oldest first, and a row whose report cannot be read is
 *     given up after a bounded number of attempts, so it stops taking a
 *     place from the rows behind it;
 *   - independence: the stalled-publication step runs when the earlier
 *     steps fail, and a failure in it leaves their counts as they were.
 *     That step's own cases are in `publish-sweep.test.ts`.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  seedPipelineRun,
  insertRow,
  wrapD1,
  type SeededRun,
  seedTenantDestination,
  githubAppEnv,
  withTokenExchange,
} from "../helpers/media-pipeline";
import { r2CanonicalManifestStore } from "../../app/lib/pipeline/canonical.server";
import {
  runPipelineSweep,
  SWEEP_FLAG_ROWS,
  SWEEP_FLAG_MAX_ATTEMPTS,
} from "../../app/lib/pipeline/sweep.server";
import { ingestTruncatedFlags } from "../../app/lib/pipeline/flags-ingest.server";
import { runHoldsVolumesSql } from "../../app/lib/pipeline/run-state.server";
import { startPipelineRun } from "../../app/lib/pipeline/dispatch.server";
import { getPipelineSpecStore, type MediaObjectReader } from "../../app/lib/pipeline/store.server";
import { TONAL_DEFAULT_PRESET } from "../../app/lib/pipeline/recipe";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";

type Json = Record<string, any>;

const WORKING_BUCKET = "test-working";

const nullReader: MediaObjectReader = { getText: async () => null };

async function first<T = Json>(query: string, ...binds: unknown[]): Promise<T> {
  return (await env.DB.prepare(query).bind(...binds).first<T>()) as T;
}
async function all<T = Json>(query: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(query).bind(...binds).all<T>()).results;
}
const runRow = (run: SeededRun) => first("SELECT * FROM pipeline_runs WHERE id = ?", run.runId);

function sweep(now = Date.now(), reader: MediaObjectReader = nullReader) {
  return runPipelineSweep({
    db: drizzle(env.DB),
    reader,
    now,
    workingBucket: WORKING_BUCKET,
    canonicalFor: async () => r2CanonicalManifestStore((env as any).MANIFESTS_BUCKET),
  });
}

const past = () => Date.now() - 1000;

describe("runPipelineSweep", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
  });

  it("closes an expired running run with outstanding volumes as an error, touching no volume", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, status: "running", tokenExpiresAt: past() });
    const volumesBefore = await all("SELECT * FROM pipeline_volumes ORDER BY id");
    const rowsBefore = await all("SELECT * FROM pipeline_run_volumes ORDER BY id");
    const counts = await sweep();
    expect(counts.expired).toBe(1);
    const r = await runRow(run);
    expect(r.status).toBe("error");
    expect(JSON.parse(r.error)).toEqual({ class: "token_expired" });
    expect(r.token_revoked_at).not.toBeNull();
    expect(await all("SELECT * FROM pipeline_volumes ORDER BY id")).toEqual(volumesBefore);
    expect(await all("SELECT * FROM pipeline_run_volumes ORDER BY id")).toEqual(rowsBefore);
  });

  it("closes an expired pending run the same way", async () => {
    const run = await seedPipelineRun({ status: "pending", tokenExpiresAt: past() });
    await sweep();
    const r = await runRow(run);
    expect(r.status).toBe("error");
    expect(JSON.parse(r.error)).toEqual({ class: "token_expired" });
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("completes an expired run whose volumes all reported though a chunk never did", async () => {
    const run = await seedPipelineRun({ volumeCount: 2, status: "running", volumesReported: 2, tokenExpiresAt: past() });
    await sweep();
    const r = await runRow(run);
    expect(r.status).toBe("completed");
    expect(r.error).toBeNull();
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("leaves closed runs and unexpired runs alone", async () => {
    const closed = await seedPipelineRun({ status: "completed", tokenRevokedAt: past() - 5000, tokenExpiresAt: past() });
    const live = await seedPipelineRun({ status: "running" });
    const closedBefore = await runRow(closed);
    const liveBefore = await runRow(live);
    expect((await sweep()).expired).toBe(0);
    expect(await runRow(closed)).toEqual(closedBefore);
    expect(await runRow(live)).toEqual(liveBefore);
  });

  it("changes nothing the second time", async () => {
    await seedPipelineRun({ status: "running", tokenExpiresAt: past() });
    await seedPipelineRun({ tenantId: SECOND_TEST_TENANT_ID, status: "dispatched", tokenExpiresAt: past() });
    expect((await sweep()).expired).toBe(2);
    const before = await all("SELECT * FROM pipeline_runs ORDER BY id");
    const second = await sweep(Date.now() + 60_000);
    expect(second.expired).toBe(0);
    expect(await all("SELECT * FROM pipeline_runs ORDER BY id")).toEqual(before);
  });

  it("keeps a halted run's status and halt error and closes it", async () => {
    const halt = { class: "auth", volume_id: "v", message: "The stage failed." };
    const run = await seedPipelineRun({ status: "halted", error: halt, tokenExpiresAt: past() });
    await sweep();
    const r = await runRow(run);
    expect(r.status).toBe("halted");
    expect(JSON.parse(r.error)).toEqual(halt);
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("frees an expired run's volumes: held by nothing before the sweep, startable after it", async () => {
    await seedFederations();
    await seedTenantDestination();
    const run = await seedPipelineRun({ volumeCount: 1, status: "running", tokenExpiresAt: past() });
    const held = await drizzle(env.DB).all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM pipeline_volumes v WHERE v.tenant_id = ${run.tenantId} AND EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = v.held_by_run_id AND r.tenant_id = v.tenant_id AND (${runHoldsVolumesSql(Date.now())}))`,
    );
    expect(held[0].n).toBe(0);
    await sweep();

    const admin = await createTestUser({ isAdmin: true });
    const testEnv = { ...env, ...(await githubAppEnv()) } as any;
    const result = await startPipelineRun(
      {
        db: drizzle(env.DB),
        env: testEnv,
        specStore: getPipelineSpecStore(testEnv),
        fetchImpl: withTokenExchange((async () => new Response(null, { status: 204 })) as typeof fetch),
        manifestResolverFor: () => (v) => ({
          id: `https://iiif.example.test/${v.referenceCode}/manifest.json`,
          label: { es: [v.referenceCode] },
          homepage: [{ id: `https://catalogue.example.test/${v.referenceCode}` }],
          rights: null,
          required_statement: null,
          provider: [],
        }),
        config: {
          maxRunVolumes: 10,
          maxRunPages: 100,
          maxSampleVolumes: 10,
          targetImagesPerJob: 734,
          lifetime: {
            secondsPerImage: 0.95,
            perJobOverheadSeconds: 120,
            lanes: 16,
            chunkSpacingSeconds: 60,
            queueAllowanceSeconds: 600,
            marginFactor: 1.5,
            tokenFloorSeconds: 3600,
            urlFloorSeconds: 1800,
            callbackTailSeconds: 600,
          },
          presets: { byOutputClass: { tonal: TONAL_DEFAULT_PRESET }, acceptedKeys: { preprocess: [], render: [] } },
        },
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      },
      {
        tenant: makeTenantContext({
          id: DEFAULT_TEST_TENANT_ID,
          federationId: NEOGRANADINA_FEDERATION_ID,
          mediaPipelineEnabled: true,
        }),
        user: makeUserContext({ id: admin.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true }),
        pipelineVolumeIds: [run.volumes[0].id],
        kind: "volume_run",
        purpose: "sample",
        maxReviewFrac: 0.1,
      },
    );
    expect((await first("SELECT held_by_run_id FROM pipeline_volumes WHERE id = ?", run.volumes[0].id)).held_by_run_id).toBe(
      result.runId,
    );
  });

  it("completes the flag ingest a request could not finish", async () => {
    const run = await seedPipelineRun({ status: "running" });
    const v = run.volumes[0];
    await env.DB.prepare(
      "UPDATE pipeline_run_volumes SET status = 'review_pending', flags_truncated = 1, flags_ingested_at = NULL, report_key = 'r.json' WHERE id = ?",
    )
      .bind(v.runVolumeId)
      .run();
    const failing: MediaObjectReader = {
      getText: async () => {
        throw new Error("unreachable");
      },
    };
    const during = await ingestTruncatedFlags(
      { db: drizzle(env.DB), reader: failing, now: () => Date.now(), workingBucket: WORKING_BUCKET },
      { tenantId: run.tenantId, runVolumeId: v.runVolumeId },
    );
    expect(during.complete).toBe(false);

    const flags = Array.from({ length: 3 }, (_, i) => ({
      page_key: `p000${i + 1}`,
      stage: "render",
      code: "edge_overflow",
      summary: `Flag ${i}.`,
      corroboration: null,
    }));
    const reader: MediaObjectReader = {
      getText: async () => JSON.stringify({ spec_version: 1, flags, pages: [] }),
    };
    const counts = await sweep(Date.now(), reader);
    expect(counts.flagsCompleted).toBe(1);
    expect((await first("SELECT COUNT(*) AS n FROM pipeline_review_items")).n).toBe(3);
    expect((await first("SELECT flags_ingested_at FROM pipeline_run_volumes WHERE id = ?", v.runVolumeId)).flags_ingested_at).not.toBeNull();
    expect((await first("SELECT open_review_count FROM pipeline_volumes WHERE id = ?", v.id)).open_review_count).toBe(3);
  });

  async function truncatedRows(count: number): Promise<SeededRun> {
    const run = await seedPipelineRun({ status: "running", volumeCount: count });
    const base = Date.now() - 10 * 60_000;
    // Creation order runs against id order, so only an ORDER BY on
    // created_at picks the oldest.
    const byId = [...run.volumes].sort((a, b) => (a.runVolumeId < b.runVolumeId ? -1 : 1));
    for (const [i, v] of byId.entries()) {
      await env.DB.prepare(
        "UPDATE pipeline_run_volumes SET status = 'review_pending', flags_truncated = 1, flags_ingested_at = NULL, report_key = ?, created_at = ? WHERE id = ?",
      )
        .bind(`reports/${v.runVolumeId}.json`, base + (count - i) * 1000, v.runVolumeId)
        .run();
    }
    return run;
  }

  function recordingReader(readable: Set<string> = new Set()) {
    const asked: string[] = [];
    const reader: MediaObjectReader = {
      getText: async (_bucket, key) => {
        asked.push(key);
        const id = key.replace(/^reports\/|\.json$/g, "");
        if (!readable.has(id)) return null;
        return JSON.stringify({
          spec_version: 1,
          flags: [{ page_key: "p0001", stage: "render", code: "edge_overflow", summary: "Flag.", corroboration: null }],
          pages: [],
        });
      },
    };
    return { reader, asked };
  }

  it("retries unfinished flag ingests oldest first", async () => {
    await truncatedRows(SWEEP_FLAG_ROWS + 5);
    const oldest = await all<{ id: string }>(
      "SELECT id FROM pipeline_run_volumes ORDER BY created_at, id LIMIT ?",
      SWEEP_FLAG_ROWS,
    );
    const { reader, asked } = recordingReader();
    const counts = await sweep(Date.now(), reader);
    expect(counts.flagsAttempted).toBe(SWEEP_FLAG_ROWS);
    expect(asked).toEqual(oldest.map((r) => `reports/${r.id}.json`));
  });

  it("gives up on a row whose report cannot be read, so the rows behind it are reached", async () => {
    await truncatedRows(SWEEP_FLAG_ROWS + 1);
    const rows = await all<{ id: string }>("SELECT id FROM pipeline_run_volumes ORDER BY created_at, id");
    const newest = rows[rows.length - 1].id;
    const { reader, asked } = recordingReader(new Set([newest]));
    for (let i = 0; i < SWEEP_FLAG_MAX_ATTEMPTS; i++) {
      const c = await sweep(Date.now(), reader);
      expect(c.flagsAttempted).toBe(SWEEP_FLAG_ROWS);
      expect(c.flagsCompleted).toBe(0);
    }
    expect(asked).not.toContain(`reports/${newest}.json`);
    const stuck = await all<{ flags_ingest_attempts: number; flags_ingested_at: number | null }>(
      "SELECT flags_ingest_attempts, flags_ingested_at FROM pipeline_run_volumes WHERE id <> ?",
      newest,
    );
    for (const r of stuck) {
      expect(r.flags_ingest_attempts).toBe(SWEEP_FLAG_MAX_ATTEMPTS);
      expect(r.flags_ingested_at).toBeNull();
    }

    const after = await sweep(Date.now(), reader);
    expect(after).toMatchObject({ flagsAttempted: 1, flagsCompleted: 1 });
    expect((await first("SELECT flags_ingested_at FROM pipeline_run_volumes WHERE id = ?", newest)).flags_ingested_at).not.toBeNull();
    expect(await sweep(Date.now(), reader)).toMatchObject({ flagsAttempted: 0 });
  });

  it("closes an expired run with every volume reported and a dispatch error as an error, keeping it", async () => {
    const dispatchError = { class: "dispatch", chunk_index: 0, status: 500 };
    const run = await seedPipelineRun({
      volumeCount: 1,
      status: "dispatched",
      volumesReported: 1,
      error: dispatchError,
      tokenExpiresAt: past(),
    });
    await sweep();
    const r = await runRow(run);
    expect(r.status).toBe("error");
    expect(JSON.parse(r.error)).toEqual(dispatchError);
    expect(r.token_revoked_at).not.toBeNull();
  });

  it("keeps its earlier counts when the publication step fails, and runs that step when they fail", async () => {
    const expiredRun = await seedPipelineRun({ status: "running", tokenExpiresAt: past() });
    const failSelect = wrapD1(env.DB, {
      before(text) {
        if (/from "pipeline_publications"/.test(text)) throw new Error("D1 unavailable");
      },
    });
    const counts = await runPipelineSweep({
      db: drizzle(failSelect),
      reader: nullReader,
      now: Date.now(),
      workingBucket: WORKING_BUCKET,
      canonicalFor: async () => r2CanonicalManifestStore((env as any).MANIFESTS_BUCKET),
    });
    expect(counts).toMatchObject({ expired: 1, flagsAttempted: 0, flagsCompleted: 0 });
    expect(counts.publicationsResolved).toBe(0);
    expect(counts.publicationsUnresolved).toBe(0);
    expect((await runRow(expiredRun)).status).toBe("error");

    // An expired claim, and an expiry step that throws.
    const run = await seedPipelineRun();
    const v = run.volumes[0];
    const pubId = crypto.randomUUID();
    await insertRow("pipeline_publications", {
      id: pubId,
      tenant_id: run.tenantId,
      pipeline_volume_id: v.id,
      run_id: run.runId,
      run_volume_id: v.runVolumeId,
      user_id: run.userId,
      status: "claimed",
      claim_id: crypto.randomUUID(),
      canonical_url: `https://manifests.test.example/iiif/${v.referenceCode}/manifest.json`,
      canonical_key: `iiif/${v.referenceCode}/manifest.json`,
      manifest_sha256: "0".repeat(64),
      canonical_expect: JSON.stringify({ absent: true }),
      claimed_at: Date.now() - 31 * 60_000,
    });
    const failExpiry = wrapD1(env.DB, {
      before(text) {
        if (/^update "pipeline_runs"/.test(text)) throw new Error("D1 unavailable");
      },
    });
    await expect(
      runPipelineSweep({
        db: drizzle(failExpiry),
        reader: nullReader,
        now: Date.now(),
        workingBucket: WORKING_BUCKET,
        canonicalFor: async () => r2CanonicalManifestStore((env as any).MANIFESTS_BUCKET),
      }),
    ).rejects.toThrow(/update "pipeline_runs"/);
    expect((await first("SELECT status FROM pipeline_publications WHERE id = ?", pubId)).status).toBe("abandoned");
  });
});

// @version v0.8.0
