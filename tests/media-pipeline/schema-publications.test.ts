/**
 * Tests — media pipeline schema: the publication ledger
 *
 * This suite pins the constraints of `pipeline_publications`, the table
 * that records each attempt to publish a ready volume. The migration
 * files themselves (0088, then 0089) are run here, not the hand-built mirror in
 * `tests/helpers/db.ts`, so the CHECKs and partial unique indexes under
 * test are the ones D1 will see; one case compares the file-built table
 * with the mirror so the mirror the other suites use cannot drift.
 *
 * What the constraints carry: at most one in-flight publication
 * (`claimed` or `copying`) per volume, at most one `published` row per
 * volume, and at most one in-flight or published row per canonical key
 * across every tenant, because the canonical key space is shared. A
 * `published` row has a publication time and no other row has one; a
 * `copying` row has the time it started copying. A NULL status is
 * refused even inside a batch, and the batch then applies nothing,
 * which is what lets the final publish statement assert its own
 * preconditions. A volume a publication names cannot be deleted. The
 * two columns that record migrated OCR text kept before a publish
 * replaced it are nullable, and a digest, when present, is 64 characters.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { runMigrationFile } from "../helpers/migration-file";
import { seedPipelineRun, insertRow, type SeededRun } from "../helpers/media-pipeline";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";

const HEX64 = "0123456789abcdef".repeat(4);
const KEY = "iiif/co-shared-001/manifest.json";

type Row = Record<string, unknown>;

async function shape(): Promise<{ columns: unknown[]; indexes: unknown[] }> {
  const cols = await env.DB.prepare("PRAGMA table_info(pipeline_publications)").all();
  const idx = await env.DB.prepare("PRAGMA index_list(pipeline_publications)").all<{
    name: string;
    unique: number;
    partial: number;
  }>();
  return {
    columns: cols.results,
    indexes: idx.results
      .map((r) => ({ name: r.name, unique: r.unique, partial: r.partial }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function row(run: SeededRun, over: Row = {}): Row {
  const v = run.volumes[0];
  return {
    id: crypto.randomUUID(),
    tenant_id: run.tenantId,
    pipeline_volume_id: v.id,
    run_id: run.runId,
    run_volume_id: v.runVolumeId,
    user_id: run.userId,
    status: "claimed",
    claim_id: crypto.randomUUID(),
    canonical_url: `https://manifests.test.example/${KEY}`,
    canonical_key: `iiif/${v.referenceCode}/manifest.json`,
    manifest_sha256: HEX64,
    canonical_expect: JSON.stringify({ absent: true }),
    claimed_at: Date.now(),
    ...over,
  };
}

async function setStatus(id: string, status: string, extra = ""): Promise<void> {
  await env.DB.prepare(`UPDATE pipeline_publications SET status = ?${extra} WHERE id = ?`)
    .bind(status, id)
    .run();
}

let mirror: { columns: unknown[]; indexes: unknown[] };

describe("migrations 0088 and 0089", () => {
  beforeAll(async () => {
    await applyMigrations();
    mirror = await shape();
    await cleanDatabase();
    await env.DB.prepare("DROP TABLE IF EXISTS pipeline_publications").run();
    await runMigrationFile("0088_pipeline_publications.sql");
    await runMigrationFile("0089_publication_previous_ocr.sql");
  });

  it("builds the same table as the test mirror", async () => {
    expect(await shape()).toEqual(mirror);
  });

  it("allows one in-flight and one published publication per volume, and one per canonical key across tenants", async () => {
    const run = await seedPipelineRun();
    const first = row(run);
    await insertRow("pipeline_publications", first);
    await expect(insertRow("pipeline_publications", row(run, { canonical_key: "k-a" }))).rejects.toThrow();
    await expect(
      insertRow("pipeline_publications", row(run, { canonical_key: "k-b", status: "copying", copying_at: Date.now() })),
    ).rejects.toThrow();
    await setStatus(first.id as string, "failed");
    const second = row(run);
    await insertRow("pipeline_publications", second);
    await setStatus(second.id as string, "published", ", published_at = 1");
    await expect(
      insertRow("pipeline_publications", row(run, { canonical_key: "k-c", status: "published", published_at: 2 })),
    ).rejects.toThrow();

    // Another tenant's volume naming the same canonical key.
    const other = await seedPipelineRun({ tenantId: DACS_TEST_TENANT_ID });
    const sameKey = { canonical_key: second.canonical_key };
    await expect(insertRow("pipeline_publications", row(other, sameKey))).rejects.toThrow();
    await setStatus(second.id as string, "failed", ", published_at = NULL");
    const otherRow = row(other, sameKey);
    await insertRow("pipeline_publications", otherRow);
    await expect(insertRow("pipeline_publications", row(run, sameKey))).rejects.toThrow();
    await setStatus(otherRow.id as string, "failed");
    await insertRow("pipeline_publications", row(run, sameKey));
  });

  it("checks the publication and copying times, the status, the expectation and the digest", async () => {
    const run = await seedPipelineRun();
    for (const bad of [
      { status: "published" },
      { status: "failed", published_at: 1 },
      { status: "copying" },
      { status: "unknown" },
      { canonical_expect: "not json" },
      { manifest_sha256: HEX64.slice(1) },
    ]) {
      await expect(insertRow("pipeline_publications", row(run, bad))).rejects.toThrow();
    }
    await insertRow("pipeline_publications", row(run, { status: "failed" }));
  });

  it("refuses a NULL status, and a batch holding that update applies nothing", async () => {
    const run = await seedPipelineRun();
    const r = row(run);
    await insertRow("pipeline_publications", r);
    await expect(
      env.DB.prepare("UPDATE pipeline_publications SET status = NULL WHERE id = ?").bind(r.id).run(),
    ).rejects.toThrow(/NOT NULL/);
    const before = await env.DB.prepare("SELECT updated_at FROM pipeline_volumes WHERE id = ?")
      .bind(run.volumes[0].id)
      .first<{ updated_at: number }>();
    await expect(
      env.DB.batch([
        env.DB.prepare("UPDATE pipeline_volumes SET updated_at = 42 WHERE id = ?").bind(run.volumes[0].id),
        env.DB.prepare(
          "UPDATE pipeline_publications SET status = CASE WHEN claim_id = 'other' THEN 'copying' ELSE NULL END WHERE id = ?",
        ).bind(r.id),
      ]),
    ).rejects.toThrow();
    const after = await env.DB.prepare("SELECT updated_at FROM pipeline_volumes WHERE id = ?")
      .bind(run.volumes[0].id)
      .first<{ updated_at: number }>();
    expect(after!.updated_at).toBe(before!.updated_at);
    const pub = await env.DB.prepare("SELECT status FROM pipeline_publications WHERE id = ?")
      .bind(r.id)
      .first<{ status: string }>();
    expect(pub!.status).toBe("claimed");
  });

  it("records kept OCR text in two nullable columns, with a 64-character digest", async () => {
    const run = await seedPipelineRun();
    const cols = (await env.DB.prepare("PRAGMA table_info(pipeline_publications)").all<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>()).results.filter((c) => c.name.startsWith("previous_ocr_"));
    expect(cols.map((c) => [c.name, c.notnull, c.dflt_value])).toEqual([
      ["previous_ocr_copy_key", 0, null],
      ["previous_ocr_sha256", 0, null],
    ]);
    await insertRow("pipeline_publications", row(run, { status: "failed" }));
    await expect(
      insertRow("pipeline_publications", row(run, { status: "failed", previous_ocr_sha256: HEX64.slice(1) })),
    ).rejects.toThrow();
    await insertRow(
      "pipeline_publications",
      row(run, { status: "failed", previous_ocr_copy_key: "t/pipeline-publications/p/previous-ocr.txt", previous_ocr_sha256: HEX64 }),
    );
  });

  it("restricts deleting a volume that a publication names", async () => {
    const run = await seedPipelineRun();
    const fks = await env.DB.prepare("PRAGMA foreign_key_list(pipeline_publications)").all<{
      table: string;
      from: string;
      on_delete: string;
    }>();
    const restricts = fks.results
      .map((f) => `${f.from}->${f.table}:${f.on_delete}`)
      .sort();
    expect(restricts).toEqual([
      "pipeline_volume_id->pipeline_volumes:RESTRICT",
      "run_id->pipeline_runs:RESTRICT",
      "run_volume_id->pipeline_run_volumes:RESTRICT",
      "tenant_id->tenants:RESTRICT",
      "user_id->users:RESTRICT",
    ]);
    const pub = row(run, { status: "failed" });
    await insertRow("pipeline_publications", pub);
    await expect(
      env.DB.prepare("DELETE FROM pipeline_volumes WHERE id = ?").bind(run.volumes[0].id).run(),
    ).rejects.toThrow();
  });
});
