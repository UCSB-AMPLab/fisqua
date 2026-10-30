/**
 * Tests — media pipeline seed helpers
 *
 * This helper module deals with the rows the media pipeline tests need
 * before they can exercise a handler: a recipe declaration, pipeline
 * volumes in Received with their page lists, and a dispatched run with
 * a known bearer token, its dispatch chunks and one run-volume row per
 * volume. The tests call `seedTenants()` first, as for every other
 * tenant-scoped row.
 *
 * `seedDeclaration` inserts one version of a declaration family.
 * `seedPipelineRun` builds a whole run in one call: a repository and a
 * scope description, a declaration (version 1 unless told otherwise),
 * `volumeCount` volumes, each with `pageCount` pages, and the run with
 * its chunks. Volume `i` goes to chunk `chunkOf(i)` (every volume in
 * chunk 0 by default) and to its own job. The token is minted for real,
 * so the handler's hash comparison runs as it does in production; only
 * its hash is written. The run's spec URL expires half an hour before
 * the token, as the table's CHECK requires.
 *
 * `seedReceivedVolumes` registers volumes that no run holds yet, as a
 * start-run request finds them: a repository, a scope description with
 * its declaration family (version 1 unless told otherwise), one file
 * description per volume, the volumes in Received and their page lists.
 * It writes descriptions, volumes and pages with one recursive
 * statement each, so the dispatch tests can register thousands of
 * volumes and hundreds of thousands of pages quickly. Reference codes
 * are `{prefix}-00001` onwards, and page keys `p00001` onwards.
 *
 * `seedReviewRun` builds a review run the way a registered capture
 * delivery will have one: a volume in Received that no run holds, a
 * delivery by the file route that holds it with two openings, and a
 * dispatched run of kind `review_run` (no purpose, no user unless one is
 * given) with its one chunk and one review row under the delivery's
 * prefix. It writes no run-volume row. `makeReviewCallback` returns the
 * report a review run's job posts for it, `review_ready` unless told
 * otherwise.
 *
 * `makeVolumeCallback` returns a per-volume report for one seeded
 * volume, built from the documented example in the fixtures with the
 * run id, volume id, tile root and working-prefix keys replaced, and
 * `callbackHeaders` the headers the runner sends with it.
 *
 * `seedReadyVolume` builds on `seedPipelineRun` and leaves one volume
 * that publishes cleanly with the test locator: the volume in Ready to
 * publish with the run as its last run, a closed run whose spec URL has
 * expired, a gate pass, the run volume `prepared` with its held manifest
 * and report keys under the run's working prefix, the spec in the
 * `SPEC_BUCKET` binding with its SHA-256 on the run row, and in the
 * `BUCKET` binding (which the test reader reads) the held manifest, the
 * report and one text object per page. The held manifest is the document Fisqua builds
 * from the spec, serialised with its keys in reverse order, so a check
 * that compares it with the built one is shown not to depend on key
 * order. Options turn OCR off, change the page count, place a previous
 * object at the canonical key, point the description at another
 * manifest URL, or name another tenant's tiles bucket, image address and
 * manifest host in the spec.
 *
 * `wrapD1` wraps the D1 binding so a test can count executed statements
 * and batches, or make one of them fail before or after it runs.
 *
 * `TEST_DESTINATION` is a complete storage destination for a
 * federation: the tiles bucket and image address the seeded specs name,
 * the manifests host the publish tests' locator accepts, a manifest
 * bucket, a masters bucket, and the secret prefix `TEST_TENANT`, whose
 * four secrets `vitest.config.ts` binds. `seedTenantDestination` writes
 * it (or other values) onto the row of a tenant's federation;
 * `testSecrets(prefix)` gives the four secret values for another prefix,
 * to spread into a test environment. A tenant's output sits under its
 * slug in its federation's buckets, so `seedReadyVolume` names the
 * tenant's prefixes and addresses in the spec it writes, as dispatch
 * does.
 *
 * `githubAppTestKeys` generates one RSA key pair per test isolate and
 * gives its private key as a PKCS#8 PEM and as the PKCS#1 PEM GitHub
 * issues (the PKCS#8 structure's inner octet string, read with a small
 * DER reader of its own rather than the code under test), with the
 * public key to verify signatures. `githubAppEnv` gives the PKCS#1 key as
 * the `PIPELINE_GITHUB_APP_PRIVATE_KEY` setting, to spread into a test
 * environment over the placeholder `vitest.config.ts` binds.
 * `withTokenExchange` wraps a dispatch fetch stub so that a POST to the
 * App installation's `access_tokens` endpoint is answered with
 * `TEST_INSTALLATION_TOKEN` (or the status, or the response, given) and
 * recorded, and every other request goes to the stub.
 *
 * Every value here is a test value: no real bucket, endpoint, digest or
 * credential.
 *
 * @version v0.8.0
 */
import { env } from "cloudflare:test";
import { createTestRepository } from "./repositories";
import { createTestDescription } from "./descriptions";
import { createTestUser } from "./auth";
import { DEFAULT_TEST_TENANT_ID } from "./db";
import { mintRunToken } from "../../app/lib/pipeline/token.server";
import { pipelineKey } from "../../app/lib/pipeline/store.server";
import { expectedHeldManifest } from "../../app/lib/pipeline/publish.server";
import preparedFixture from "../fixtures/media-pipeline/callback-prepared.json";

export const TEST_RUNNER_IMAGE =
  "ghcr.io/example/runner@sha256:" + "0123456789abcdef".repeat(4);
export const TEST_SCRIPT_VERSION = "v1.0.0";
const HEX64 = "0123456789abcdef".repeat(4);

type Row = Record<string, unknown>;

export async function insertRow(table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  )
    .bind(...cols.map((c) => row[c]))
    .run();
}

export async function seedDeclaration(opts: {
  tenantId?: string;
  scopeDescriptionId: string;
  createdBy: string;
  version?: number;
}): Promise<{ id: string; version: number }> {
  const id = crypto.randomUUID();
  const version = opts.version ?? 1;
  await insertRow("pipeline_recipe_declarations", {
    id,
    tenant_id: opts.tenantId ?? DEFAULT_TEST_TENANT_ID,
    scope_description_id: opts.scopeDescriptionId,
    version,
    platen: "v",
    background: "dark",
    output_class: "tonal",
    tone_preset: "default",
    created_by: opts.createdBy,
    created_at: Date.now(),
  });
  return { id, version };
}

export interface SeededVolume {
  id: string;
  runVolumeId: string;
  referenceCode: string;
  chunkIndex: number;
  pageKeys: string[];
}

export interface SeededRun {
  tenantId: string;
  runId: string;
  token: string;
  tokenHash: string;
  userId: string;
  scopeDescriptionId: string;
  declarationId: string;
  declarationVersion: number;
  volumes: SeededVolume[];
  tokenExpiresAt: number;
}

export async function seedPipelineRun(
  opts: {
    tenantId?: string;
    volumeCount?: number;
    pageCount?: number;
    chunkCount?: number;
    chunkOf?: (i: number) => number;
    status?: string;
    maxReviewFrac?: number;
    tokenExpiresAt?: number;
    tokenRevokedAt?: number | null;
    error?: Row | null;
    volumesReported?: number;
    declarationVersion?: number;
    codePrefix?: string;
  } = {},
): Promise<SeededRun> {
  const tenantId = opts.tenantId ?? DEFAULT_TEST_TENANT_ID;
  const volumeCount = opts.volumeCount ?? 1;
  const pageCount = opts.pageCount ?? 2;
  const chunkOf = opts.chunkOf ?? (() => 0);
  const chunkCount = opts.chunkCount ?? 1;
  const now = Date.now();
  const tokenExpiresAt = opts.tokenExpiresAt ?? now + 3_600_000;
  const prefix = opts.codePrefix ?? `co-test-${crypto.randomUUID().slice(0, 6)}`;

  const repo = await createTestRepository({ tenantId, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
  const user = await createTestUser({ tenantId });
  const scope = await createTestDescription({ tenantId, repositoryId: repo.id, descriptionLevel: "fonds" });
  const declaration = await seedDeclaration({
    tenantId,
    scopeDescriptionId: scope.id,
    createdBy: user.id,
    version: opts.declarationVersion ?? 1,
  });

  const { token, hash } = await mintRunToken();
  const runId = crypto.randomUUID();
  await insertRow("pipeline_runs", {
    id: runId,
    tenant_id: tenantId,
    user_id: user.id,
    kind: "volume_run",
    purpose: "sample",
    status: opts.status ?? "dispatched",
    runner_image: TEST_RUNNER_IMAGE,
    script_version: TEST_SCRIPT_VERSION,
    arch: "x64",
    max_review_frac: opts.maxReviewFrac ?? 1,
    spec_key: pipelineKey.spec(tenantId, runId),
    spec_sha256: HEX64,
    spec_url_expires_at: tokenExpiresAt - 1_800_000,
    chunk_count: chunkCount,
    volume_count: volumeCount,
    volumes_reported: opts.volumesReported ?? 0,
    callback_token_hash: hash,
    token_expires_at: tokenExpiresAt,
    token_revoked_at: opts.tokenRevokedAt ?? null,
    error: opts.error ? JSON.stringify(opts.error) : null,
    created_at: now,
    dispatched_at: now,
  });
  for (let c = 0; c < chunkCount; c++) {
    await insertRow("pipeline_run_chunks", {
      id: crypto.randomUUID(),
      run_id: runId,
      tenant_id: tenantId,
      chunk_index: c,
      status: "dispatched",
      dispatched_at: now,
      created_at: now,
    });
  }

  const volumes: SeededVolume[] = [];
  for (let i = 0; i < volumeCount; i++) {
    const unit = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      descriptionLevel: "file",
      parentId: scope.id,
    });
    const id = crypto.randomUUID();
    const referenceCode = `${prefix}-${String(i + 1).padStart(3, "0")}`;
    await insertRow("pipeline_volumes", {
      id,
      tenant_id: tenantId,
      description_id: unit.id,
      reference_code: referenceCode,
      kind: "volume_run",
      masters_backend: "b2",
      masters_endpoint: "https://s3.example.test",
      masters_bucket: "test-masters",
      masters_prefix: `masters/${referenceCode}/`,
      expected_count: pageCount,
      recipe_scope_description_id: scope.id,
      held_by_run_id: runId,
      created_at: now,
      updated_at: now,
    });
    const pageKeys: string[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const pageKey = `p${String(p).padStart(4, "0")}`;
      pageKeys.push(pageKey);
      await insertRow("pipeline_volume_pages", {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        pipeline_volume_id: id,
        seq: p,
        page_key: pageKey,
        master_key: `masters/${referenceCode}/${pageKey}.tif`,
      });
    }
    const runVolumeId = crypto.randomUUID();
    const chunkIndex = chunkOf(i);
    await insertRow("pipeline_run_volumes", {
      id: runVolumeId,
      run_id: runId,
      tenant_id: tenantId,
      pipeline_volume_id: id,
      declaration_id: declaration.id,
      job_index: i,
      chunk_index: chunkIndex,
      reference_code: referenceCode,
      tile_root: referenceCode,
      expected_count: pageCount,
      resolved_recipe: JSON.stringify({
        declaration_id: declaration.id,
        declaration_version: declaration.version,
        output_class: "tonal",
      }),
      status: "dispatched",
      flags_truncated: 0,
      created_at: now,
    });
    volumes.push({ id, runVolumeId, referenceCode, chunkIndex, pageKeys });
  }

  return {
    tenantId,
    runId,
    token,
    tokenHash: hash,
    userId: user.id,
    scopeDescriptionId: scope.id,
    declarationId: declaration.id,
    declarationVersion: declaration.version,
    volumes,
    tokenExpiresAt,
  };
}

export interface ReceivedVolume {
  id: string;
  referenceCode: string;
  descriptionId: string;
  pageKeys: string[];
}

export interface ReceivedVolumes {
  tenantId: string;
  userId: string;
  repositoryId: string;
  scopeDescriptionId: string;
  declarations: Array<{ id: string; version: number }>;
  volumes: ReceivedVolume[];
}

export async function seedReceivedVolumes(
  opts: {
    tenantId?: string;
    count?: number;
    pageCount?: number;
    kind?: "volume_run" | "item_pdf";
    codePrefix?: string;
    declarationVersions?: number[];
    userId?: string;
  } = {},
): Promise<ReceivedVolumes> {
  const tenantId = opts.tenantId ?? DEFAULT_TEST_TENANT_ID;
  const count = opts.count ?? 1;
  const pageCount = opts.pageCount ?? 2;
  const kind = opts.kind ?? "volume_run";
  const tag = crypto.randomUUID().slice(0, 8);
  const prefix = opts.codePrefix ?? `co-${tag}`;
  const now = Date.now();

  const repo = await createTestRepository({ tenantId, code: `repo-${tag}` });
  const userId = opts.userId ?? (await createTestUser({ tenantId })).id;
  const scope = await createTestDescription({ tenantId, repositoryId: repo.id, descriptionLevel: "fonds" });
  const declarations: Array<{ id: string; version: number }> = [];
  for (const version of opts.declarationVersions ?? [1]) {
    declarations.push(
      await seedDeclaration({ tenantId, scopeDescriptionId: scope.id, createdBy: userId, version }),
    );
  }

  const seq = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) ";
  const code = "? || '-' || printf('%05d', i)";
  await env.DB.prepare(
    seq +
      "INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, description_level, " +
      "reference_code, local_identifier, title, created_at, updated_at) " +
      `SELECT ? || '-d-' || i, ?, ?, ?, 'file', ${code}, ${code}, 'Test unit', ?, ? FROM n`,
  )
    .bind(count, tag, tenantId, repo.id, scope.id, prefix, prefix, now, now)
    .run();
  await env.DB.prepare(
    seq +
      "INSERT INTO pipeline_volumes (id, tenant_id, description_id, reference_code, kind, " +
      "masters_backend, masters_endpoint, masters_bucket, masters_prefix, masters_key, " +
      "expected_count, recipe_scope_description_id, created_at, updated_at) " +
      `SELECT ? || '-v-' || i, ?, ? || '-d-' || i, ${code}, ?, 'b2', 'https://s3.example.test', ` +
      `'test-masters', CASE WHEN ? = 'volume_run' THEN 'masters/' || ${code} || '/' END, ` +
      `CASE WHEN ? = 'item_pdf' THEN 'masters/' || ${code} || '.pdf' END, ?, ?, ?, ? FROM n`,
  )
    .bind(count, tag, tenantId, tag, prefix, kind, kind, prefix, kind, prefix, pageCount, scope.id, now, now)
    .run();
  await env.DB.prepare(
    "WITH RECURSIVE p(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM p WHERE j < ?) " +
      "INSERT INTO pipeline_volume_pages (id, tenant_id, pipeline_volume_id, seq, page_key, master_key, pdf_page) " +
      "SELECT v.id || '-p-' || j, v.tenant_id, v.id, j, 'p' || printf('%05d', j), " +
      "CASE WHEN v.kind = 'volume_run' THEN v.masters_prefix || 'p' || printf('%05d', j) || '.tif' END, " +
      "CASE WHEN v.kind = 'item_pdf' THEN j END " +
      "FROM pipeline_volumes v, p WHERE v.tenant_id = ? AND v.id LIKE ? || '-v-%'",
  )
    .bind(pageCount, tenantId, tag)
    .run();

  const pageKeys = Array.from({ length: pageCount }, (_, j) => `p${String(j + 1).padStart(5, "0")}`);
  const volumes: ReceivedVolume[] = Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    return {
      id: `${tag}-v-${i}`,
      referenceCode: `${prefix}-${String(i).padStart(5, "0")}`,
      descriptionId: `${tag}-d-${i}`,
      pageKeys,
    };
  });
  return { tenantId, userId, repositoryId: repo.id, scopeDescriptionId: scope.id, declarations, volumes };
}

/** A gate pass for the seeded run's declaration row and script version. */
export async function seedGatePass(
  run: SeededRun,
  opts: { declarationId?: string; scriptVersion?: string } = {},
): Promise<void> {
  await insertRow("pipeline_gate_passes", {
    id: crypto.randomUUID(),
    tenant_id: run.tenantId,
    declaration_id: opts.declarationId ?? run.declarationId,
    script_version: opts.scriptVersion ?? TEST_SCRIPT_VERSION,
    sample_run_id: run.runId,
    passed_by: run.userId,
    passed_at: Date.now(),
  });
}

export interface SeededReviewRun {
  tenantId: string;
  runId: string;
  token: string;
  volumeId: string;
  referenceCode: string;
  deliveryId: string;
  reviewPrefix: string;
}

export async function seedReviewRun(
  opts: { tenantId?: string; userId?: string | null; tokenExpiresAt?: number } = {},
): Promise<SeededReviewRun> {
  const tenantId = opts.tenantId ?? DEFAULT_TEST_TENANT_ID;
  const now = Date.now();
  const tokenExpiresAt = opts.tokenExpiresAt ?? now + 3_600_000;
  const referenceCode = `co-review-${crypto.randomUUID().slice(0, 6)}`;
  const repo = await createTestRepository({ tenantId, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
  const scope = await createTestDescription({ tenantId, repositoryId: repo.id, descriptionLevel: "fonds" });
  const unit = await createTestDescription({
    tenantId,
    repositoryId: repo.id,
    descriptionLevel: "file",
    parentId: scope.id,
  });
  const volumeId = crypto.randomUUID();
  await insertRow("pipeline_volumes", {
    id: volumeId,
    tenant_id: tenantId,
    description_id: unit.id,
    reference_code: referenceCode,
    kind: "volume_run",
    masters_backend: "b2",
    masters_endpoint: "https://s3.example.test",
    masters_bucket: "test-masters",
    masters_prefix: `test-tenant/${referenceCode}/`,
    expected_count: 2,
    recipe_scope_description_id: scope.id,
    created_at: now,
    updated_at: now,
  });
  const deliveryId = crypto.randomUUID();
  const seq = Number((await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM capture_deliveries WHERE tenant_id = ?").bind(tenantId).first<{ n: number }>())?.n ?? 1);
  await insertRow("capture_deliveries", {
    tenant_id: tenantId,
    id: deliveryId,
    route: "file",
    scanner_id: null,
    reference_code: referenceCode,
    pipeline_volume_id: volumeId,
    body_sha256: HEX64,
    state: "registered",
    answer_status: 200,
    answer_body: "{}",
    records: "[]",
    openings: 2,
    received_at: now,
    seq,
  });
  const { token, hash } = await mintRunToken();
  const runId = crypto.randomUUID();
  await insertRow("pipeline_runs", {
    id: runId,
    tenant_id: tenantId,
    user_id: opts.userId ?? null,
    kind: "review_run",
    purpose: null,
    status: "dispatched",
    runner_image: TEST_RUNNER_IMAGE,
    script_version: "v1.1.0",
    arch: "x64",
    max_review_frac: 1,
    spec_key: pipelineKey.spec(tenantId, runId),
    spec_sha256: HEX64,
    spec_url_expires_at: tokenExpiresAt - 1_800_000,
    chunk_count: 1,
    volume_count: 1,
    volumes_reported: 0,
    callback_token_hash: hash,
    token_expires_at: tokenExpiresAt,
    created_at: now,
    dispatched_at: now,
  });
  await insertRow("pipeline_run_chunks", {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: tenantId,
    chunk_index: 0,
    status: "dispatched",
    dispatched_at: now,
    created_at: now,
  });
  const reviewPrefix = `test-tenant/${deliveryId}/`;
  await insertRow("capture_review_runs", {
    tenant_id: tenantId,
    run_id: runId,
    delivery_id: deliveryId,
    pipeline_volume_id: volumeId,
    review_prefix: reviewPrefix,
    status: "dispatched",
    created_at: now,
  });
  return { tenantId, runId, token, volumeId, referenceCode, deliveryId, reviewPrefix };
}

/** A review run's report for its one volume. */
export function makeReviewCallback(
  run: SeededReviewRun,
  opts: { outcome?: "review_ready" | "aborted" | "halted"; attempt?: string; errorClass?: string } = {},
): CallbackBody {
  const outcome = opts.outcome ?? "review_ready";
  const working = pipelineKey.workingPrefix(run.tenantId, run.runId);
  const skipped = { status: "skipped", reason: "review run: the image is tiled as captured" };
  const ready = outcome === "review_ready";
  return {
    spec_version: 1,
    run_id: run.runId,
    volume_id: run.volumeId,
    attempt: opts.attempt ?? "11223344.1",
    outcome,
    error: ready
      ? null
      : {
          class: opts.errorClass ?? (outcome === "halted" ? "destination" : "fixity"),
          stage: "pull",
          message: "The stage failed.",
          page_keys: [],
        },
    runner: { script_version: "v1.1.0" },
    stages: {
      pull: { status: ready ? "ok" : "failed", count: 2, bytes: 10, elapsed_s: 0 },
      preprocess: skipped,
      render: skipped,
      ocr: skipped,
      tile: ready ? { status: "ok", count: 2, elapsed_s: 0 } : { status: "not_reached" },
      upload: ready ? { status: "ok", bytes: 100, elapsed_s: 0 } : { status: "not_reached" },
      verify: ready ? { status: "ok", elapsed_s: 0 } : { status: "not_reached" },
    },
    qc: ready
      ? {
          expected_count: 2,
          processed_count: 2,
          canvas_count: null,
          info_json_complete: true,
          homepage_conformant: null,
          ocr_pairs_complete: null,
        }
      : null,
    verification: ready ? { method: "rclone-check", passed: true, files_checked: 40, differences: 0 } : null,
    flags: [],
    flags_truncated: false,
    outputs: {
      review_prefix: run.reviewPrefix,
      tiles_bytes: ready ? 100 : 0,
      report_key: `${working}volumes/${run.volumeId}/report.json`,
    },
    elapsed_s: 1,
  };
}

export type CallbackBody = Record<string, any>;

export interface CallbackOptions {
  outcome?: "prepared" | "review_pending" | "aborted" | "halted";
  attempt?: string;
  errorClass?: string;
  flags?: Array<{ page_key: string; stage: string; code: string; summary: string }>;
  flagsTruncated?: boolean;
}

/** A per-volume report for one seeded volume. */
export function makeVolumeCallback(
  run: SeededRun,
  volume: SeededVolume,
  opts: CallbackOptions = {},
): CallbackBody {
  const body = structuredClone(preparedFixture) as CallbackBody;
  const outcome = opts.outcome ?? "prepared";
  const working = pipelineKey.workingPrefix(run.tenantId, run.runId);
  body.run_id = run.runId;
  body.volume_id = volume.id;
  body.attempt = opts.attempt ?? "11223344.1";
  body.outcome = outcome;
  body.outputs.tile_root = volume.referenceCode;
  body.outputs.manifest_key = `${working}volumes/${volume.id}/manifest.json`;
  body.outputs.report_key = `${working}volumes/${volume.id}/report.json`;
  if (outcome === "review_pending") {
    body.flags = opts.flags ?? [
      { page_key: volume.pageKeys[0], stage: "render", code: "edge_overflow", summary: "Edge ran past the frame." },
    ];
    body.flags_truncated = opts.flagsTruncated ?? false;
  }
  if (outcome === "aborted" || outcome === "halted") {
    body.error = {
      class: opts.errorClass ?? (outcome === "halted" ? "auth" : "image"),
      stage: "render",
      message: "The stage failed.",
      page_keys: [],
    };
  }
  return body;
}

export function callbackIdempotencyKey(body: CallbackBody): string {
  return `${body.run_id}:${body.volume_id}:${body.attempt}`;
}

export function callbackHeaders(token: string | null, body: CallbackBody): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": callbackIdempotencyKey(body),
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Every row of the plan's tables, for before-and-after comparisons. */
export async function snapshotPipelineTables(): Promise<Record<string, unknown[]>> {
  const tables = [
    "pipeline_runs",
    "pipeline_run_chunks",
    "pipeline_run_volumes",
    "pipeline_volumes",
    "pipeline_review_items",
  ];
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
    out[t] = results;
  }
  return out;
}

/** The canonical manifest host the publish tests' locator accepts. */
export const TEST_MANIFEST_BASE = "https://manifests.test.example";
export const TEST_IMAGE_BASE = "https://tiles.test.example";
export const TEST_WORKING_BUCKET = "test-working-bucket";
export const TEST_TILES_BUCKET = "test-tiles-bucket";
export const TEST_CANVAS = { width: 1000, height: 1500 };

/**
 * The default test tenant's part of its federation's buckets: its slug,
 * Neogranadina's, as the seeded tenant row holds it.
 */
export const TEST_KEY_PREFIX = "neogranadina/";

/** The secret prefix of the test destination; vitest.config.ts binds its four secrets. */
export const TEST_SECRET_PREFIX = "TEST_TENANT";
export const TEST_DELIVERY_ENDPOINT = "https://s3.us-west-000.backblazeb2.com";
export const TEST_MANIFEST_ENDPOINT = "https://test-account.r2.cloudflarestorage.com";
export const TEST_MANIFEST_BUCKET = "test-manifests";
export const TEST_MASTERS_BUCKET = "test-masters-bucket";

export interface TestDestination {
  pipelineDeliveryEndpoint: string | null;
  pipelineTilesBucket: string | null;
  pipelineMastersBucket: string | null;
  pipelineImageBaseUrl: string | null;
  manifestEndpoint: string | null;
  manifestBucket: string | null;
  manifestBaseUrl: string | null;
  storageSecretPrefix: string | null;
  /** Optional in the record; null in the test destination. */
  pipelineReviewTilesBucket: string | null;
}

export const TEST_DESTINATION: TestDestination = {
  pipelineDeliveryEndpoint: TEST_DELIVERY_ENDPOINT,
  pipelineTilesBucket: TEST_TILES_BUCKET,
  pipelineMastersBucket: TEST_MASTERS_BUCKET,
  pipelineImageBaseUrl: TEST_IMAGE_BASE,
  manifestEndpoint: TEST_MANIFEST_ENDPOINT,
  manifestBucket: TEST_MANIFEST_BUCKET,
  manifestBaseUrl: TEST_MANIFEST_BASE,
  storageSecretPrefix: TEST_SECRET_PREFIX,
  pipelineReviewTilesBucket: null,
};

/** The test tiles bucket as a reader target, with a test key. */
export const TEST_TILES_TARGET = {
  endpoint: TEST_DELIVERY_ENDPOINT,
  bucket: TEST_TILES_BUCKET,
  keyId: "test_tenant-delivery-key-id",
  secretKey: "test_tenant-delivery-secret",
};

/** Four test secret values for a prefix, keyed by their secret names. */
export function testSecrets(prefix: string): Record<string, string> {
  const tag = prefix.toLowerCase();
  return {
    [`${prefix}_DELIVERY_READ_KEY_ID`]: `${tag}-delivery-key-id`,
    [`${prefix}_DELIVERY_READ_SECRET_KEY`]: `${tag}-delivery-secret`,
    [`${prefix}_MANIFEST_WRITE_KEY_ID`]: `${tag}-manifest-key-id`,
    [`${prefix}_MANIFEST_WRITE_SECRET_KEY`]: `${tag}-manifest-secret`,
  };
}

/** Writes a storage destination onto the row of a tenant's federation. */
export async function seedTenantDestination(
  tenantId: string = DEFAULT_TEST_TENANT_ID,
  values: Partial<TestDestination> = TEST_DESTINATION,
): Promise<void> {
  const v = { ...TEST_DESTINATION, ...values };
  await env.DB.prepare(
    "UPDATE federations SET pipeline_delivery_endpoint = ?, pipeline_tiles_bucket = ?, " +
      "pipeline_masters_bucket = ?, pipeline_image_base_url = ?, manifest_endpoint = ?, " +
      "manifest_bucket = ?, manifest_base_url = ?, storage_secret_prefix = ?, " +
      "pipeline_review_tiles_bucket = ? " +
      "WHERE id = (SELECT federation_id FROM tenants WHERE id = ?)",
  )
    .bind(
      v.pipelineDeliveryEndpoint,
      v.pipelineTilesBucket,
      v.pipelineMastersBucket,
      v.pipelineImageBaseUrl,
      v.manifestEndpoint,
      v.manifestBucket,
      v.manifestBaseUrl,
      v.storageSecretPrefix,
      v.pipelineReviewTilesBucket,
      tenantId,
    )
    .run();
}

/** A tenant's slug, which names its part of its federation's buckets. */
export async function tenantSlugOf(tenantId: string = DEFAULT_TEST_TENANT_ID): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM tenants WHERE id = ?").bind(tenantId).first<{ slug: string }>();
  if (!row) throw new Error(`No test tenant ${tenantId}`);
  return row.slug;
}

/** The same JSON value with every object's keys in reverse order. */
export function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ReadyVolume {
  run: SeededRun;
  tenantId: string;
  runId: string;
  userId: string;
  volumeId: string;
  runVolumeId: string;
  descriptionId: string;
  referenceCode: string;
  pageKeys: string[];
  canonicalUrl: string;
  canonicalKey: string;
  manifestKey: string;
  reportKey: string;
  spec: Record<string, any>;
  heldManifest: Record<string, any>;
  report: Record<string, any>;
  ocr: boolean;
}

export async function seedReadyVolume(
  opts: {
    tenantId?: string;
    ocr?: boolean;
    pages?: number;
    codePrefix?: string;
    withPreviousCanonical?: Uint8Array | string;
    previousCatalogueUrl?: string;
    homepageId?: string;
    /** Optional manifest inputs (metadata, summary, see_also) added to the spec entry. */
    manifestExtras?: Record<string, unknown>;
    /**
     * The federation destination the spec names; the test destination's
     * by default. The tenant's slug is added to each, as dispatch does.
     */
    tilesBucket?: string;
    imageBase?: string;
    manifestBase?: string;
    /**
     * The slug the canonical key and manifest id are put under, when a
     * test needs a tenant's spec to name another tenant's key.
     */
    keySlug?: string;
  } = {},
): Promise<ReadyVolume> {
  const slug = await tenantSlugOf(opts.tenantId ?? DEFAULT_TEST_TENANT_ID);
  const keySlug = opts.keySlug ?? slug;
  const tilesBucket = opts.tilesBucket ?? TEST_TILES_BUCKET;
  const imageBase = `${opts.imageBase ?? TEST_IMAGE_BASE}/${slug}`;
  const manifestBase = opts.manifestBase ?? TEST_MANIFEST_BASE;
  const ocrPrefix = `${slug}/ocr/`;
  const ocr = opts.ocr ?? true;
  const pageCount = opts.pages ?? 3;
  const now = Date.now();
  const run = await seedPipelineRun({
    tenantId: opts.tenantId,
    pageCount,
    codePrefix: opts.codePrefix,
    status: "completed",
    tokenExpiresAt: now - 60_000,
    tokenRevokedAt: now - 30_000,
  });
  const v = run.volumes[0];
  const ref = v.referenceCode;
  const working = pipelineKey.workingPrefix(run.tenantId, run.runId);
  const manifestKey = `${working}volumes/${v.id}/manifest.json`;
  const reportKey = `${working}volumes/${v.id}/report.json`;
  const canonicalKey = `${keySlug}/iiif/${ref}/manifest.json`;
  const canonicalUrl = `${manifestBase}/${canonicalKey}`;
  const row = await env.DB.prepare("SELECT description_id FROM pipeline_volumes WHERE id = ?")
    .bind(v.id)
    .first<{ description_id: string }>();
  const descriptionId = row!.description_id;

  const recipe = {
    declaration_id: run.declarationId,
    declaration_version: run.declarationVersion,
    capture: { platen: "v", background: "dark" },
    output_class: ocr ? "bilevel" : "tonal",
    tone_preset: "default",
    stages: {
      preprocess: { run: false, reason: "test" },
      render: { run: false, reason: "test" },
      ocr: ocr
        ? { run: true, params: { engine: "tesseract", lang: "spa" } }
        : { run: false, reason: "test" },
      tile: { run: true, params: { layout: "level0", tile_size: 512, thumbnail_widths: [96, 200] } },
    },
    page_overrides: [],
  };
  const manifest = {
    id: canonicalUrl,
    label: { none: [`Test volume ${ref}`] },
    homepage: [
      {
        id: opts.homepageId ?? `https://zasqua.org/${ref}`,
        type: "Text",
        label: { none: [`Test volume ${ref}`] },
        format: "text/html",
      },
    ],
    rights: null,
    required_statement: { label: { none: ["Test statement"] }, value: { none: ["Test value"] } },
    provider: [{ id: "https://provider.test.example", type: "Agent", label: { none: ["Test provider"] } }],
    ...(opts.manifestExtras ?? {}),
  };
  const spec = {
    spec_version: 1,
    run_id: run.runId,
    tenant_id: run.tenantId,
    kind: "volume_run",
    created_at: new Date(now).toISOString(),
    regenerates_run_id: null,
    runner: { image: TEST_RUNNER_IMAGE, script_version: TEST_SCRIPT_VERSION, arch: "x64" },
    callback: {
      url_template: `https://fisqua.test/api/pipeline/runs/${run.runId}/volumes/{volume_id}/callback`,
      complete_url: `https://fisqua.test/api/pipeline/runs/${run.runId}/complete`,
      token_expires_at: new Date(run.tokenExpiresAt).toISOString(),
      token: run.token,
    },
    max_review_frac: 1,
    destination: {
      backend: "b2",
      endpoint: "https://s3.test.example",
      tiles_bucket: tilesBucket,
      tiles_prefix: `${slug}/`,
      image_base_url: imageBase,
      ocr_bucket: tilesBucket,
      ocr_prefix: ocrPrefix,
      credentials_ref: `fisqua-pipeline-${run.tenantId}`,
    },
    working: { backend: "b2", endpoint: "https://s3.test.example", bucket: TEST_WORKING_BUCKET, prefix: working },
    jobs: [{ job_index: 0, volume_ids: [v.id] }],
    volumes: [
      {
        volume_id: v.id,
        reference_code: ref,
        description_id: descriptionId,
        tile_root: ref,
        restricted: false,
        expected_count: pageCount,
        pages: v.pageKeys.map((k, i) => ({ seq: i + 1, page_key: k, master_key: `masters/${ref}/${k}.tif` })),
        source: {
          backend: "b2",
          endpoint: "https://s3.example.test",
          bucket: "test-masters",
          prefix: `masters/${ref}/`,
          checksums_key: null,
        },
        recipe,
        manifest,
      },
    ],
  };
  const specText = JSON.stringify(spec);
  await env.SPEC_BUCKET.put(pipelineKey.spec(run.tenantId, run.runId), specText);

  const heldManifest = expectedHeldManifest(
    manifest,
    spec.volumes[0].pages,
    imageBase,
    ref,
    [96, 200],
    v.pageKeys.map(() => ({ ...TEST_CANVAS })),
  ) as Record<string, any>;
  await env.BUCKET.put(manifestKey, JSON.stringify(reverseKeys(heldManifest)));

  const report = {
    spec_version: 1,
    run_id: run.runId,
    volume_id: v.id,
    tile_root: ref,
    stage_summaries: {},
    flags: [],
    pages: v.pageKeys.map((k, i) => ({
      seq: i + 1,
      page_key: k,
      master_key: `masters/${ref}/${k}.tif`,
      ...TEST_CANVAS,
      text_key: ocr ? `${ocrPrefix}${ref}/txt/${k}.txt` : null,
      alto_key: ocr ? `${ocrPrefix}${ref}/alto/${k}.xml` : null,
      text_bytes: ocr ? 12 : 0,
    })),
  };
  await env.BUCKET.put(reportKey, JSON.stringify(report));
  if (ocr) {
    for (const k of v.pageKeys) await env.BUCKET.put(`${ocrPrefix}${ref}/txt/${k}.txt`, `Page text ${k}`);
  }

  await env.DB.prepare(
    "UPDATE pipeline_runs SET spec_sha256 = ?, spec_url_expires_at = ? WHERE id = ?",
  )
    .bind(await sha256Hex(specText), now - 120_000, run.runId)
    .run();
  await env.DB.prepare(
    "UPDATE pipeline_run_volumes SET status = 'prepared', manifest_key = ?, report_key = ?, reported_at = ? WHERE id = ?",
  )
    .bind(manifestKey, reportKey, now, v.runVolumeId)
    .run();
  await env.DB.prepare(
    "UPDATE pipeline_volumes SET state = 'ready', last_run_id = ?, current_tile_root = ?, held_by_run_id = NULL WHERE id = ?",
  )
    .bind(run.runId, ref, v.id)
    .run();
  await seedGatePass(run);

  if (opts.withPreviousCanonical !== undefined) {
    await env.MANIFESTS_BUCKET.put(canonicalKey, opts.withPreviousCanonical);
  }
  const catalogueUrl =
    opts.previousCatalogueUrl ?? (opts.withPreviousCanonical !== undefined ? canonicalUrl : null);
  if (catalogueUrl !== null) {
    await env.DB.prepare("UPDATE descriptions SET iiif_manifest_url = ? WHERE id = ?")
      .bind(catalogueUrl, descriptionId)
      .run();
  }

  return {
    run,
    tenantId: run.tenantId,
    runId: run.runId,
    userId: run.userId,
    volumeId: v.id,
    runVolumeId: v.runVolumeId,
    descriptionId,
    referenceCode: ref,
    pageKeys: v.pageKeys,
    canonicalUrl,
    canonicalKey,
    manifestKey,
    reportKey,
    spec,
    heldManifest,
    report,
    ocr,
  };
}

/** Rewrites the spec object and keeps the run row's digest in step. */
export async function rewriteSpec(seed: ReadyVolume, spec: Record<string, any>): Promise<void> {
  const text = JSON.stringify(spec);
  await env.SPEC_BUCKET.put(pipelineKey.spec(seed.tenantId, seed.runId), text);
  await env.DB.prepare("UPDATE pipeline_runs SET spec_sha256 = ? WHERE id = ?")
    .bind(await sha256Hex(text), seed.runId)
    .run();
}

export interface D1Hooks {
  before?: (sql: string) => void;
  after?: (sql: string) => void;
  batch?: (count: number) => void;
  counter?: { n: number };
}

/** A D1 binding that runs `hooks` around each executed statement and batch. */
export function wrapD1(real: D1Database, hooks: D1Hooks): D1Database {
  const wrapStmt = (stmt: D1PreparedStatement, text: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === "__real") return target;
        if (prop === "bind") return (...args: unknown[]) => wrapStmt(target.bind(...args), text);
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          return async (...args: unknown[]) => {
            if (hooks.counter) hooks.counter.n++;
            hooks.before?.(text);
            const out = await (target as any)[prop](...args);
            hooks.after?.(text);
            return out;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (text: string) => wrapStmt(target.prepare(text), text);
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (hooks.counter) hooks.counter.n++;
          hooks.batch?.(stmts.length);
          return target.batch(stmts.map((x: any) => x.__real ?? x));
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// ---------------------------------------------------------------------------
// The GitHub App
// ---------------------------------------------------------------------------

export const TEST_INSTALLATION_TOKEN = "ghs_test-installation-token";
export const TOKEN_EXCHANGE_PATTERN = /^https:\/\/api\.github\.com\/app\/installations\/[^/]+\/access_tokens$/;

export interface GitHubAppTestKeys {
  pkcs8Pem: string;
  pkcs1Pem: string;
  publicKey: CryptoKey;
}

let appKeys: Promise<GitHubAppTestKeys> | null = null;

function toPem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** One DER element at `offset`: where its content starts and ends. */
function derElement(der: Uint8Array, offset: number): { start: number; end: number } {
  let length = der[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i];
    start += count;
  }
  return { start, end: start + length };
}

/** The PKCS#1 key inside a PKCS#8 PrivateKeyInfo. */
function pkcs8ToPkcs1(der: Uint8Array): Uint8Array {
  const outer = derElement(der, 0);
  const version = derElement(der, outer.start);
  const algorithm = derElement(der, version.end);
  const key = derElement(der, algorithm.end);
  return der.slice(key.start, key.end);
}

export function githubAppTestKeys(): Promise<GitHubAppTestKeys> {
  appKeys ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    );
    return {
      pkcs8Pem: toPem("PRIVATE KEY", pkcs8),
      pkcs1Pem: toPem("RSA PRIVATE KEY", pkcs8ToPkcs1(pkcs8)),
      publicKey: pair.publicKey,
    };
  })();
  return appKeys;
}

export async function githubAppEnv(): Promise<Record<string, string>> {
  return { PIPELINE_GITHUB_APP_PRIVATE_KEY: (await githubAppTestKeys()).pkcs1Pem };
}

export interface TokenExchange {
  url: string;
  headers: Record<string, string>;
  json: Record<string, unknown>;
}

export function withTokenExchange(
  fetchImpl: typeof fetch,
  opts: {
    status?: number;
    reply?: () => Response;
    expiresInMs?: number;
    exchanges?: TokenExchange[];
  } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!TOKEN_EXCHANGE_PATTERN.test(url)) return fetchImpl(input, init);
    opts.exchanges?.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      json: JSON.parse(String(init?.body ?? "{}")),
    });
    if (opts.reply) return opts.reply();
    const status = opts.status ?? 201;
    if (status !== 201) return new Response(JSON.stringify({ message: "refused" }), { status });
    const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString();
    return new Response(JSON.stringify({ token: TEST_INSTALLATION_TOKEN, expires_at: expiresAt }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

// @version v0.8.0
