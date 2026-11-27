/**
 * Tests — import revert step bodies
 *
 * Drives the ImportRevertWorkflow's step functions directly against the
 * real D1 harness with an in-memory staging store (the commit.server.test
 * pattern), so the compensating write path is exercised without the
 * Workflows runtime. Each scenario first COMMITS an import (populating the
 * journal the revert inverts), then reverts it and asserts the outcome.
 *
 * Pins: the full create round-trip (untouched creates deleted leaf-first,
 * a hand-edited row KEPT, delete journal rows carry full pre-image
 * snapshots, the target stamped reverted_by_run_id); the update round-trip
 * (before-images restored, reverse diff journalled); revert-of-revert
 * (the original import's effects return via re-insert); a row edited
 * between run start and its batch (the edited-since test reads live
 * updated_at); a created container with foreign children skipped;
 * double-revert refused by the mint mutex; the write-derived
 * reverted/kept counts; versions that start ahead of the clock move
 * strictly past it, on the import's write and on the revert's, and the
 * revert still treats the import's write as the run's own; and a
 * description recording a deleted or re-created code as a former
 * reference code keeps its version through both reverts. Any version
 * past the run's is an edit: a row given a column the import left out,
 * or new OCR pages, is kept. Two rows created by one import, one
 * recording the other's code as a former one, are both deleted, in one
 * batch or across batches. A re-inserted row takes a version past its
 * deleted one and the clock. A restore batch or a container
 * reconciliation whose row was written after the step read it writes
 * nothing and throws, and the retry keeps the edit. Restoring a child's
 * level moves its parent's version, and a child listed before its
 * parent in one batch leaves both restored, each with its journal row.
 *
 * Fixtures are REAL SBMAL rows over the verbatim DACS headers; hierarchy
 * fixtures add placeholder container codes only — never invented archival
 * metadata.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { seedPage } from "../helpers/ocr-fixtures";
import { changelog, descriptions, stewardshipRuns } from "../../app/db/schema";
import { createProfile } from "../../app/lib/import/profiles.server";
import { createUpload } from "../../app/lib/import/uploads.server";
import { runDryRun } from "../../app/lib/import/dry-run.server";
import { stagingKey, type StagingStore } from "../../app/lib/import/staging.server";
import { parseCsv } from "../../app/lib/import/csv";
import {
  finalizeRun,
  loadCommitConfig,
  mintImportRun,
  processCreateBatch,
  processUpdateBatch,
  recomputeStructuralCaches,
} from "../../app/lib/import/commit.server";
import {
  finalizeRevertRun,
  loadRevertConfig,
  mintRevertRun,
  processDeleteBatch,
  processReinsertBatch,
  processRestoreBatch,
  reconcileContainers,
  REVERT_BATCH_SIZE,
  type RevertConfig,
  type RevertCounts,
} from "../../app/lib/import/revert.server";
import { makeSbmalCsv, SBMAL_REAL_ROWS, SBMAL_DACS_BINDINGS, withBom } from "./fixtures";

function db() {
  return drizzle(env.DB);
}

function memStore(): StagingStore {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (b: unknown): Uint8Array =>
    typeof b === "string" ? enc.encode(b) : (b as Uint8Array);
  return {
    async put(key, body) {
      map.set(key, toBytes(body));
    },
    async getBytes(key) {
      return map.get(key) ?? null;
    },
    async head(key) {
      const b = map.get(key);
      return b ? { size: b.byteLength } : null;
    },
    async exists(key) {
      return map.has(key);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/** Stage a CSV, make a profile, run the dry-run, mint the import run. */
async function setupImport(opts: {
  csv: string;
  bindings: unknown;
  updateExisting: boolean;
  store: StagingStore;
}) {
  const tenantId = DEFAULT_TEST_TENANT_ID;
  const user = await createTestUser({ isAdmin: true, tenantId });
  const repo = await createTestRepository({ tenantId });
  const uploadId = crypto.randomUUID();
  const bytes = withBom(opts.csv);
  const artifactKey = stagingKey.upload(tenantId, uploadId);
  await opts.store.put(artifactKey, bytes);
  const parsed = parseCsv(opts.csv);
  await createUpload(db(), {
    id: uploadId,
    tenantId,
    userId: user.id,
    filename: "sbmal.csv",
    artifactKey,
    byteSize: bytes.byteLength,
    rowCount: parsed.rowCount,
    headers: parsed.headers,
  });
  const created = await createProfile(db(), {
    tenantId,
    standard: "isadg",
    name: `profile-${uploadId.slice(0, 8)}`,
    bindings: opts.bindings,
    sharedWithFederation: false,
    userId: user.id,
  });
  if (!created.ok) throw new Error(`profile create failed: ${created.error}`);
  const { getUpload } = await import("../../app/lib/import/uploads.server");
  const upload = (await getUpload(db(), tenantId, uploadId))!;
  const { parseProfileBindings } = await import("../../app/lib/import/profile-schema");
  const pb = parseProfileBindings(opts.bindings);
  if (!pb.success) throw new Error("bindings invalid");
  await runDryRun({
    db: db(),
    store: opts.store,
    tenantId,
    upload,
    profile: { id: created.id, version: created.version, bindings: pb.data },
    standard: "isadg",
    updateExisting: opts.updateExisting,
  });
  const stamped = (await getUpload(db(), tenantId, uploadId))!;
  const minted = await mintImportRun(db(), {
    tenantId,
    userId: user.id,
    message: "Test import run",
    profileId: created.id,
    profileVersion: created.version,
    sourceArtifact: stamped.artifactKey,
    reportArtifact: stamped.reportArtifact!,
    uploadId,
  });
  if (!minted) throw new Error("mint refused");
  return { tenantId, userId: user.id, repositoryId: repo.id, uploadId, importRunId: minted.runId };
}

/** Drive the commit step bodies in sequence, as the Workflow would. */
async function driveCommit(
  ctx: { importRunId: string; uploadId: string; repositoryId: string; store: StagingStore },
  updateExisting: boolean,
  BS = 50,
) {
  const config = await loadCommitConfig(db(), ctx.store, {
    runId: ctx.importRunId,
    uploadId: ctx.uploadId,
    repositoryId: ctx.repositoryId,
    updateExisting,
  });
  const executed = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: config.counts.skipped,
    rejected: config.counts.rejected,
    pathCacheCapped: 0,
  };
  for (let i = 0; i < config.createCodes.length; i += BS) {
    const r = await processCreateBatch(db(), ctx.store, config, config.createCodes.slice(i, i + BS));
    executed.created += r.created;
  }
  for (let i = 0; i < config.updateCodes.length; i += BS) {
    const r = await processUpdateBatch(db(), ctx.store, config, config.updateCodes.slice(i, i + BS));
    executed.updated += r.updated;
    executed.unchanged += r.unchanged;
  }
  await recomputeStructuralCaches(db(), config);
  await finalizeRun(db(), ctx.importRunId, executed);
}

/** Mint + drive a revert run against a target, as the Workflow would. */
async function driveRevert(opts: {
  tenantId: string;
  userId: string;
  targetRunId: string;
  store: StagingStore;
  message?: string;
}): Promise<{ revertRunId: string; counts: RevertCounts } | null> {
  const minted = await mintRevertRun(db(), {
    tenantId: opts.tenantId,
    userId: opts.userId,
    message: opts.message ?? "Test revert run",
    targetRunId: opts.targetRunId,
  });
  if (!minted) return null;
  const config = await loadRevertConfig(db(), { runId: minted.runId });
  const executed: RevertCounts = {
    deleted: 0,
    restored: 0,
    reinserted: 0,
    skippedEdited: 0,
    skippedForeignChildren: 0,
    skippedConflict: 0,
  };
  const BS = REVERT_BATCH_SIZE;
  for (let i = 0; i < config.restores.length; i += BS) {
    const r = await processRestoreBatch(db(), config, config.restores.slice(i, i + BS));
    executed.restored += r.restored;
    executed.skippedEdited += r.skippedEdited;
  }
  for (let i = 0; i < config.deletes.length; i += BS) {
    const r = await processDeleteBatch(db(), config, config.deletes.slice(i, i + BS));
    executed.deleted += r.deleted;
    executed.skippedEdited += r.skippedEdited;
    executed.skippedForeignChildren += r.skippedForeignChildren;
  }
  for (let i = 0; i < config.reinserts.length; i += BS) {
    const r = await processReinsertBatch(db(), config, config.reinserts.slice(i, i + BS));
    executed.reinserted += r.reinserted;
    executed.skippedConflict += r.skippedConflict;
  }
  await reconcileContainers(db(), config);
  await finalizeRevertRun(db(), opts.store, config, executed);
  return { revertRunId: minted.runId, counts: executed };
}

describe("import revert — create round-trip", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deletes untouched creates, keeps a hand-edited row, journals delete snapshots, stamps the target", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    // A cataloguer edits CMD 1 by hand AFTER the import (bump updated_at).
    const cmd1Before = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as Record<string, unknown>;
    await db()
      .update(descriptions)
      .set({ title: "Hand-edited title", updatedAt: (cmd1Before.updatedAt as number) + 100000 })
      .where(eq(descriptions.id, cmd1Before.id as string));

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.deleted).toBe(7);
    expect(result.counts.skippedEdited).toBe(1);
    expect(result.counts.restored).toBe(0);

    // Only the hand-edited CMD 1 survives, with its edit intact.
    const remaining = (await db()
      .select()
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all()) as Record<string, unknown>[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].referenceCode).toBe("CMD 1");
    expect(remaining[0].title).toBe("Hand-edited title");

    // The revert journalled 7 delete rows with full pre-image snapshots.
    const revertJournal = (await db()
      .select()
      .from(changelog)
      .where(eq(changelog.runId, result.revertRunId))
      .all()) as { kind: string; diff: string }[];
    expect(revertJournal).toHaveLength(7);
    for (const j of revertJournal) {
      expect(j.kind).toBe("delete");
      const diff = JSON.parse(j.diff) as Record<string, { old: unknown; new: unknown }>;
      expect(diff.title.new).toBeNull();
      expect(diff.referenceCode.old).toBeTruthy();
    }

    // Target stamped reverted_by_run_id; revert run complete with counts.
    const target = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, s.importRunId))
      .get();
    expect(target!.revertedByRunId).toBe(result.revertRunId);
    const revertRun = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, result.revertRunId))
      .get();
    expect(revertRun!.status).toBe("complete");
    expect(revertRun!.revertsRunId).toBe(s.importRunId);
    expect(JSON.parse(revertRun!.recordCounts!)).toMatchObject({ deleted: 7, skippedEdited: 1 });
    // The report artefact pointer is stamped.
    expect(revertRun!.reportArtifact).toBeTruthy();
    const report = JSON.parse(
      new TextDecoder().decode((await store.getBytes(revertRun!.reportArtifact!))!),
    );
    expect(report).toMatchObject({ reverted: 7, kept: 1 });
  });
});

describe("import revert — update round-trip (restore before-images)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("restores an updated row to its pre-run values and journals the reverse diff", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const seeded = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      title: "Old title",
      descriptionLevel: "item",
    });

    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: true,
      store,
    });
    // Reuse the seeded repo's tenant; the import updates CMD 1, creates 7.
    await driveCommit({ ...s, store }, true);

    const afterImport = (await db()
      .select({ title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as { title: string };
    expect(afterImport.title).toBe("Mexico. 1521-1605.");

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.restored).toBe(1);
    expect(result.counts.deleted).toBe(7);

    // CMD 1 restored to its pre-run title; the row still exists (not deleted).
    const restored = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as Record<string, unknown>;
    expect(restored.id).toBe(seeded.id);
    expect(restored.title).toBe("Old title");

    // The revert journalled an update row whose reverse diff restores the old.
    const updateRow = (await db()
      .select()
      .from(changelog)
      .where(and(eq(changelog.runId, result.revertRunId), eq(changelog.recordId, seeded.id)))
      .get()) as { kind: string; diff: string };
    expect(updateRow.kind).toBe("update");
    expect(JSON.parse(updateRow.diff)).toMatchObject({
      title: { old: "Mexico. 1521-1605.", new: "Old title" },
    });
  });

  // A version ahead of the clock, as a save that moved it past the clock
  // leaves it. The import moves it strictly past, the revert still
  // recognises the import's write as the run's own, and moves it on again.
  it("restores a row whose version is ahead of the clock, moving the version strictly past each time", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const seeded = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "CMD 1", title: "Old title", descriptionLevel: "item",
    });
    const ahead = Date.now() + 10_000;
    await db().update(descriptions).set({ updatedAt: ahead }).where(eq(descriptions.id, seeded.id));
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: true,
      store,
    });
    await driveCommit({ ...s, store }, true);
    const version = async () =>
      (await db().select({ v: descriptions.updatedAt }).from(descriptions).where(eq(descriptions.id, seeded.id)).get())!.v;
    const afterImport = await version();
    expect(afterImport).toBeGreaterThan(ahead);

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.restored).toBe(1);
    expect(result.counts.skippedEdited).toBe(0);
    expect(await version()).toBeGreaterThan(afterImport);
  });
});

describe("import revert — revert-of-revert re-applies the original", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reverting a revert re-creates the rows the import created", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    // Revert 1 deletes all 8.
    const rev1 = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(rev1.counts.deleted).toBe(8);
    expect(
      (await db().select().from(descriptions).where(eq(descriptions.tenantId, s.tenantId)).all()),
    ).toHaveLength(0);

    // Revert 2 targets rev1 (a revert) and re-inserts all 8.
    const rev2 = (await driveRevert({
      ...s,
      store,
      targetRunId: rev1.revertRunId,
      message: "Undo the revert",
    }))!;
    expect(rev2.counts.reinserted).toBe(8);

    const back = (await db()
      .select()
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all()) as Record<string, unknown>[];
    expect(back).toHaveLength(8);
    const cmd1 = back.find((r) => r.referenceCode === "CMD 1")!;
    expect(cmd1.title).toBe("Mexico. 1521-1605.");
    expect(cmd1.createdBy).toBe(s.userId); // original attribution preserved

    // rev1 is now stamped reverted-by rev2.
    const rev1Row = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, rev1.revertRunId))
      .get();
    expect(rev1Row!.revertedByRunId).toBe(rev2.revertRunId);
  });
  // Imported rows carried created_at in seconds; the delete snapshot keeps
  // whatever the row held, and a re-created row must hold milliseconds.
  it("re-creates a row whose snapshot created_at is in seconds with milliseconds, and leaves milliseconds unchanged", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: false, store,
    });
    await driveCommit({ ...s, store }, false);
    // The delete snapshot journals the row as it stands, so set the unit
    // on the live rows before the first revert.
    const SECONDS = 1_700_000_000;
    const MILLIS = 1_700_000_000_123;
    await db().update(descriptions).set({ createdAt: SECONDS })
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 1")));
    await db().update(descriptions).set({ createdAt: MILLIS })
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")));
    const rev1 = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(rev1.counts.deleted).toBe(8);

    const rev2 = (await driveRevert({ ...s, store, targetRunId: rev1.revertRunId, message: "Undo the revert" }))!;
    expect(rev2.counts.reinserted).toBe(8);
    const back = (await db()
      .select()
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all()) as Record<string, unknown>[];
    expect(back.find((r) => r.referenceCode === "CMD 1")!.createdAt).toBe(SECONDS * 1000);
    expect(back.find((r) => r.referenceCode === "CMD 2")!.createdAt).toBe(MILLIS);
  });

  // A description outside the run that records one of the run's codes as
  // a former reference code publishes it only while the code is free: the
  // revert that deletes the row and the revert that re-creates it each
  // move its version.
  it("leaves the version of a description recording a deleted or re-created code as a former one", async () => {
    const store = memStore();
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID });
    const keeper = await createTestDescription({
      tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id, referenceCode: "KEEPER 1",
    });
    await db().update(descriptions)
      .set({ legacyIds: JSON.stringify([{ provider: "former-reference-code", id: "CMD 3" }]) })
      .where(eq(descriptions.id, keeper.id));
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: false, store,
    });
    await driveCommit({ ...s, store }, false);
    const version = async () =>
      (await db().select({ v: descriptions.updatedAt }).from(descriptions).where(eq(descriptions.id, keeper.id)).get())!.v;
    const before = await version();
    const rev1 = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(rev1.counts.deleted).toBe(8);
    const rev2 = (await driveRevert({ ...s, store, targetRunId: rev1.revertRunId, message: "Undo the revert" }))!;
    expect(rev2.counts.reinserted).toBe(8);
    expect(await version()).toBe(before);
  });
});

describe("import revert — concurrency + refusals", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("skips a row edited between run start and its delete batch (edited-since reads live updated_at)", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    // Mint + plan the revert (run start), THEN edit a row before its batch.
    const minted = (await mintRevertRun(db(), {
      tenantId: s.tenantId,
      userId: s.userId,
      message: "Revert with a mid-flight edit",
      targetRunId: s.importRunId,
    }))!;
    const config = await loadRevertConfig(db(), { runId: minted.runId });

    const cmd2 = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")))
      .get()) as Record<string, unknown>;
    await db()
      .update(descriptions)
      .set({ title: "Edited mid-revert", updatedAt: (cmd2.updatedAt as number) + 100000 })
      .where(eq(descriptions.id, cmd2.id as string));

    let deleted = 0;
    let skippedEdited = 0;
    for (let i = 0; i < config.deletes.length; i += REVERT_BATCH_SIZE) {
      const r = await processDeleteBatch(db(), config, config.deletes.slice(i, i + REVERT_BATCH_SIZE));
      deleted += r.deleted;
      skippedEdited += r.skippedEdited;
    }
    expect(deleted).toBe(7);
    expect(skippedEdited).toBe(1);

    const survivor = await db()
      .select({ title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")))
      .get();
    expect(survivor!.title).toBe("Edited mid-revert");
  });

  it("skips a created container that acquired a foreign child", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    // Import creates a parent container P and a child C beneath it (both
    // via the run). Placeholder container codes — not archival records.
    // PARENT 1 is a file-level container (light isadg requirements — the
    // identity 4 + a date, like items — and able to hold children).
    const rows = [
      { Reference_Code: "PARENT 1", Title: "Container", Date_Expressed: "1700", Format: "file" },
      { Reference_Code: "CHILD 1", Title: "Child item", Date_Expressed: "1701", Parent_Ref: "PARENT 1" },
    ] as unknown as Parameters<typeof makeSbmalCsv>[0];
    const bindings = [
      ...SBMAL_DACS_BINDINGS.filter((b) => b.target !== "descriptionLevel"),
      { source: "Format", target: "descriptionLevel" as const, transform: { kind: "defaultWhenBlank" as const, default: "item" } },
      { source: "Parent_Ref", target: "parent" as const },
    ];
    const s = await setupImport({
      csv: makeSbmalCsv(rows, ["Parent_Ref"]),
      bindings,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    const parent = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "PARENT 1")))
      .get()) as Record<string, unknown>;

    // A foreign child F is added under P OUTSIDE the run.
    await createTestDescription({
      tenantId,
      repositoryId: s.repositoryId,
      parentId: parent.id as string,
      referenceCode: "FOREIGN 1",
      title: "Foreign child",
      descriptionLevel: "item",
      depth: 1,
    });

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    // CHILD 1 deleted (leaf); PARENT 1 kept — it has a foreign child.
    expect(result.counts.deleted).toBe(1);
    expect(result.counts.skippedForeignChildren).toBe(1);

    const survivors = (await db()
      .select({ referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(eq(descriptions.tenantId, tenantId))
      .all()) as { referenceCode: string }[];
    const codes = survivors.map((r) => r.referenceCode).sort();
    expect(codes).toEqual(["FOREIGN 1", "PARENT 1"]);
  });

  it("refuses a second revert of the same target (the mint mutex)", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);
    const first = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(first).toBeTruthy();

    // A second revert of the same (now-reverted) target mints nothing.
    const second = await mintRevertRun(db(), {
      tenantId: s.tenantId,
      userId: s.userId,
      message: "Second revert of the same target",
      targetRunId: s.importRunId,
    });
    expect(second).toBeNull();

    const revertRuns = await db()
      .select({ id: stewardshipRuns.id })
      .from(stewardshipRuns)
      .where(and(eq(stewardshipRuns.tenantId, s.tenantId), eq(stewardshipRuns.kind, "revert")))
      .all();
    expect(revertRuns).toHaveLength(1);
  });
});

describe("reconcileContainers — many containers stay within D1 bounds", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reconciles 120 containers' childCounts without a param-cap throw", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await createTestUser({ isAdmin: true, tenantId });
    const repo = await createTestRepository({ tenantId });

    // 120 containers (> the 99-param chunk bound), each holding ONE child
    // but storing a deliberately wrong childCount. Placeholder codes are
    // test infrastructure, not archival metadata.
    const parentIds: string[] = [];
    for (let i = 1; i <= 120; i++) {
      const parent = await createTestDescription({
        tenantId,
        repositoryId: repo.id,
        referenceCode: `RC ${String(i).padStart(3, "0")}`,
        descriptionLevel: "fonds",
        childCount: 5,
      });
      await createTestDescription({
        tenantId,
        repositoryId: repo.id,
        referenceCode: `RC ${String(i).padStart(3, "0")} CHILD`,
        descriptionLevel: "item",
        parentId: parent.id,
      });
      parentIds.push(parent.id);
    }

    const runId = crypto.randomUUID();
    const config = {
      runId,
      targetRunId: crypto.randomUUID(),
      tenantId,
      userId: user.id,
      restores: [],
      deletes: [],
      reinserts: [],
      affectedParentIds: parentIds,
      totalSteps: 1,
    } as RevertConfig;

    const { reconciled } = await reconcileContainers(db(), config);
    expect(reconciled).toBe(120);

    const parents = (await db()
      .select({ childCount: descriptions.childCount })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenantId),
          eq(descriptions.descriptionLevel, "fonds"),
          sql`${descriptions.referenceCode} LIKE 'RC %'`,
        ),
      )
      .all()) as { childCount: number }[];
    expect(parents).toHaveLength(120);
    for (const p of parents) expect(p.childCount).toBe(1);

    // Every reconciliation journalled under the run.
    const journal = await db()
      .select({ id: changelog.id })
      .from(changelog)
      .where(eq(changelog.runId, runId))
      .all();
    expect(journal).toHaveLength(120);
  });

  it("moves a container's version that is ahead of the clock strictly past it", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await createTestUser({ isAdmin: true, tenantId });
    const repo = await createTestRepository({ tenantId });
    const parent = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "RC AHEAD", descriptionLevel: "fonds", childCount: 5,
    });
    const ahead = Date.now() + 10_000;
    await db().update(descriptions).set({ updatedAt: ahead }).where(eq(descriptions.id, parent.id));
    const runId = crypto.randomUUID();
    const config = {
      runId, targetRunId: crypto.randomUUID(), tenantId, userId: user.id,
      restores: [], deletes: [], reinserts: [], affectedParentIds: [parent.id], totalSteps: 1,
    } as RevertConfig;
    expect((await reconcileContainers(db(), config)).reconciled).toBe(1);
    const row = (await db().select({ v: descriptions.updatedAt, n: descriptions.childCount }).from(descriptions)
      .where(eq(descriptions.id, parent.id)).get())!;
    expect(row.n).toBe(0);
    expect(row.v).toBeGreaterThan(ahead);
  });
});

/**
 * The D1 binding with `concurrent` run once, just before the first
 * batch: a write that lands between a step's reads and its batch.
 */
function racedDb(concurrent: (d: D1Database) => Promise<unknown>) {
  let done = false;
  const raced = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await concurrent(target);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return drizzle(raced);
}

async function mintAndLoad(tenantId: string, userId: string, targetRunId: string) {
  const minted = (await mintRevertRun(db(), { tenantId, userId, message: "Test revert run", targetRunId }))!;
  return loadRevertConfig(db(), { runId: minted.runId });
}

describe("import revert — edited since the run is a version past the run's", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  // CMD 1 records CMD 5 as a former reference code. The import does not
  // move a former-code holder's version, so the revert finds both rows
  // as the run left them and deletes them.
  const FORMER_BINDINGS = [
    ...SBMAL_DACS_BINDINGS,
    { source: "Former_Code", target: "legacyIds", provider: "former-reference-code" },
  ];
  const csvWithFormer = () =>
    makeSbmalCsv(
      SBMAL_REAL_ROWS.map((row) => ({ ...row, Former_Code: row.Reference_Code === "CMD 1" ? "CMD 5" : "" }) as typeof row),
      ["Former_Code"],
    );

  for (const [label, batchSize] of [["in one batch", 50], ["one row per batch", 1]] as const) {
    it(`deletes both rows when one records the other as a former code, created ${label}`, async () => {
      const store = memStore();
      const s = await setupImport({ csv: csvWithFormer(), bindings: FORMER_BINDINGS, updateExisting: false, store });
      await driveCommit({ ...s, store }, false, batchSize);
      const cmd1 = (await db().select().from(descriptions)
        .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 1"))).get())!;
      expect(cmd1.legacyIds).toContain("CMD 5");
      const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
      expect(result.counts.skippedEdited).toBe(0);
      expect(result.counts.deleted).toBe(8);
      expect(await db().select().from(descriptions).where(eq(descriptions.tenantId, s.tenantId)).all()).toEqual([]);
    });
  }

  it("keeps a row given a column the import left out", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: false, store,
    });
    await driveCommit({ ...s, store }, false);
    await db().update(descriptions).set({ notes: "Nota del catalogador", updatedAt: Date.now() + 10_000 })
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")));
    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.skippedEdited).toBe(1);
    const kept = await db().select().from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2"))).get();
    expect(kept?.notes).toBe("Nota del catalogador");
  });

  it("keeps a row whose OCR pages were written after the run", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: false, store,
    });
    await driveCommit({ ...s, store }, false);
    const cmd3 = (await db().select().from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 3"))).get())!;
    // As an OCR ingest leaves it: new pages, and the version moved.
    await seedPage({ descriptionId: cmd3.id, tenantId: s.tenantId, pageSeq: 1, text: "placeholder page text" });
    await db().update(descriptions).set({ updatedAt: Date.now() + 10_000 }).where(eq(descriptions.id, cmd3.id));
    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.skippedEdited).toBe(1);
    expect(await db().select().from(descriptions).where(eq(descriptions.id, cmd3.id)).get()).toBeDefined();
  });

  it("still keeps a row whose columns were edited after the run", async () => {
    const store = memStore();
    const s = await setupImport({ csv: csvWithFormer(), bindings: FORMER_BINDINGS, updateExisting: false, store });
    await driveCommit({ ...s, store }, false);
    await db().update(descriptions).set({ title: "Hand edit", updatedAt: Date.now() + 10_000 })
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")));
    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.skippedEdited).toBe(1);
    expect(result.counts.deleted).toBe(7);
  });

  it("re-inserts a row with a version past both the deleted row's and the clock", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: false, store,
    });
    // The import runs on a clock ten seconds ahead, so the rows it creates,
    // and the delete snapshots of them, hold versions ahead of the clock
    // the reverts then run on.
    const ahead = Date.now() + 10_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(ahead);
    try {
      await driveCommit({ ...s, store }, false);
    } finally {
      clock.mockRestore();
    }
    const rev1 = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(rev1.counts.deleted).toBe(8);
    const rev2 = (await driveRevert({ ...s, store, targetRunId: rev1.revertRunId, message: "Undo the revert" }))!;
    expect(rev2.counts.reinserted).toBe(8);
    const back = (await db().select().from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 1"))).get())!;
    expect(back.updatedAt).toBeGreaterThan(ahead);
    const journal = (await db().select().from(changelog)
      .where(and(eq(changelog.runId, rev2.revertRunId), eq(changelog.recordId, back.id))).get())!;
    expect(journal.createdAt).toBe(back.updatedAt);
  });
});

describe("import revert — writes made from a stale read", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  // A write lands between the step's read and its batch. The batch then
  // changes nothing and the step throws; the Workflow runs the step again,
  // and the fresh read finds the row edited since the run and keeps it.
  it("a restore batch whose row was edited after it was read writes nothing and throws; the retry keeps the edit", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const seeded = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "CMD 1", title: "Old title", descriptionLevel: "item",
    });
    const s = await setupImport({ csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: true, store });
    await driveCommit({ ...s, store }, true);
    const config = await mintAndLoad(tenantId, s.userId, s.importRunId);
    const handVersion = Date.now() + 10_000;
    const raced = racedDb((d) =>
      d.prepare("UPDATE descriptions SET title = 'Hand edit', updated_at = ? WHERE id = ?").bind(handVersion, seeded.id).run());
    await expect(processRestoreBatch(raced, config, config.restores)).rejects.toThrow();
    const after = (await db().select().from(descriptions).where(eq(descriptions.id, seeded.id)).get())!;
    expect(after.title).toBe("Hand edit");
    expect(await db().select().from(changelog).where(eq(changelog.runId, config.runId)).all()).toEqual([]);
    const retried = await processRestoreBatch(db(), config, config.restores);
    expect(retried.skippedEdited).toBe(1);
  });

  it("a container reconciliation whose row was edited after it was read writes nothing and throws", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await createTestUser({ isAdmin: true, tenantId });
    const repo = await createTestRepository({ tenantId });
    const parent = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "RC RACE", descriptionLevel: "fonds", childCount: 5,
    });
    const config = {
      runId: crypto.randomUUID(), targetRunId: crypto.randomUUID(), tenantId, userId: user.id,
      restores: [], deletes: [], reinserts: [], affectedParentIds: [parent.id], totalSteps: 1,
    } as RevertConfig;
    const handVersion = Date.now() + 10_000;
    const raced = racedDb((d) =>
      d.prepare("UPDATE descriptions SET title = 'Hand edit', updated_at = ? WHERE id = ?").bind(handVersion, parent.id).run());
    await expect(reconcileContainers(raced, config)).rejects.toThrow();
    const after = (await db().select().from(descriptions).where(eq(descriptions.id, parent.id)).get())!;
    expect(after.childCount).toBe(5);
    expect(after.updatedAt).toBe(handVersion);
  });

  it("restores a child listed before its parent, both changed, and moves the parent past its own write", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    // CMD 2 is the parent, CMD 1 its child; the import changes both rows.
    const parent = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "CMD 2", title: "Old parent", descriptionLevel: "file", childCount: 1,
    });
    const child = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "CMD 1", title: "Old child", descriptionLevel: "file",
      parentId: parent.id, rootDescriptionId: parent.id, depth: 1,
    });
    const s = await setupImport({ csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: true, store });
    await driveCommit({ ...s, store }, true);
    const config = await mintAndLoad(tenantId, s.userId, s.importRunId);
    const order = [config.restores.find((r) => r.recordId === child.id)!, config.restores.find((r) => r.recordId === parent.id)!];
    const out = await processRestoreBatch(db(), config, order);
    expect(out).toEqual({ restored: 2, skippedEdited: 0 });
    const rows = await db().select().from(descriptions).where(inArray(descriptions.id, [child.id, parent.id])).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(child.id)!.title).toBe("Old child");
    expect(byId.get(child.id)!.descriptionLevel).toBe("file");
    expect(byId.get(parent.id)!.title).toBe("Old parent");
    const journal = await db().select().from(changelog).where(eq(changelog.runId, config.runId)).all();
    for (const id of [child.id, parent.id]) {
      const entry = journal.find((j) => j.recordId === id)!;
      expect(entry.createdAt).toBe(byId.get(id)!.updatedAt);
    }
  });

  it("restoring a child's level moves its parent's version", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const parent = await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "PARENT 1", descriptionLevel: "fonds", childCount: 1,
    });
    await createTestDescription({
      tenantId, repositoryId: repo.id, referenceCode: "CMD 1", title: "Old title", descriptionLevel: "file",
      parentId: parent.id, rootDescriptionId: parent.id, depth: 1,
    });
    const s = await setupImport({ csv: makeSbmalCsv(SBMAL_REAL_ROWS), bindings: SBMAL_DACS_BINDINGS, updateExisting: true, store });
    await driveCommit({ ...s, store }, true);
    const ahead = Date.now() + 10_000;
    await db().update(descriptions).set({ updatedAt: ahead }).where(eq(descriptions.id, parent.id));
    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.restored).toBe(1);
    const child = (await db().select().from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1"))).get())!;
    expect(child.descriptionLevel).toBe("file");
    const after = (await db().select({ v: descriptions.updatedAt }).from(descriptions).where(eq(descriptions.id, parent.id)).get())!;
    expect(after.v).toBeGreaterThan(ahead);
  });
});

// @version v0.9.0
