/**
 * Tests — the manifest attribution refresh, the run
 *
 * This suite runs the refresh of one federation's published manifests
 * against the test D1 and an in-memory S3 bucket (`fakeS3`), which
 * stands in for the federation's manifest bucket:
 *
 *   - the dry run reads every manifest of the federation's tenants that
 *     has a manifest URL, reports what would change, what is already
 *     current, what is refused (a repository without rights), skipped
 *     (a URL outside the manifest address, a manifest whose id is not
 *     its URL) or missing, and writes nothing;
 *   - apply writes the three fields with the read etag as condition,
 *     keeps the content type and custom metadata (a recorded SHA-256 is
 *     brought up to date), and reads each write back; a second apply
 *     writes nothing, every manifest now `unchanged`;
 *   - a write refused by its condition is a `conflict` and the object is
 *     left as the other writer left it; a 503 is retried; a 403 fails
 *     the manifest without retry; a write whose answer was lost, retried
 *     and refused, counts as written when the object holds its bytes;
 *   - another federation's descriptions are never read;
 *   - an apply run releases its federation's lock when its report is
 *     written, after success and after failure, and each of its batches
 *     fails (`lock_not_held`) before any read or write when the lock is
 *     released or held by another instance;
 *   - a batch whose descriptions share a manifest URL with another
 *     description, as after a change made while the run was going, fails
 *     (`duplicate_manifest_url`) before any write;
 *   - a federation in which two descriptions share a manifest URL fails
 *     the run before any batch, dry run or apply, with the URLs in the
 *     report;
 *   - a run repeated after an attempt was cut off decides from its own
 *     record and the object's digest and etag, one test per row of the
 *     decision table: a pending record whose write landed is written;
 *     one whose write never landed and whose object nobody changed is
 *     written now; one whose object someone else changed, whatever its
 *     fields, is a conflict with no write; a written, failed or conflict
 *     record is reported as recorded, even when the fields are now
 *     current; and a run that fails after a batch wrote reports those
 *     writes;
 *   - a tenant without a provider never empties a manifest's provider:
 *     such a manifest is `refused` (`provider_unset`), and one with no
 *     provider or an empty one keeps it as it is;
 *   - `limit` takes the first descriptions by reference code, across
 *     batches, and `repository` only that repository's; the report
 *     records both; instances chained on `after` (reference code and id)
 *     cover one unbounded pass exactly, through equal reference codes;
 *   - the workflow walks the descriptions in batches, accumulates the
 *     report from the batch results, with counts and one sample per
 *     repository, and writes it to `BUCKET` under `reports/`.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { DACS_TEST_TENANT_ID } from "../../app/lib/tenant";
import { createTestDescription } from "../helpers/descriptions";
import {
  seedTenantDestination,
  TEST_MANIFEST_BASE,
  TEST_MANIFEST_BUCKET,
  TEST_MANIFEST_ENDPOINT,
} from "../helpers/media-pipeline";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import {
  REFRESH_BATCH_SIZE,
  loadRefreshConfig,
  manifestWriteMissing,
  refreshBatch,
  refreshReportKey,
  refreshRecords,
  refreshRecordKey,
  refreshLockKey,
  refreshLockHeld,
  REFRESH_REPORT_PREFIX,
  s3ManifestObjectStore,
  newRefreshReport,
  addRefreshBatch,
  type RefreshConfig,
  type RefreshCursor,
  type RefreshReport,
} from "../../app/lib/pipeline/manifest-refresh-run.server";
import { ManifestRefreshWorkflow } from "../../app/workflows/manifest-refresh";
import { spliceRefreshFields } from "../../app/lib/pipeline/manifest-refresh";

const db = () => drizzle(env.DB, { schema });
const RIGHTS = "http://creativecommons.org/licenses/by-nc/4.0/";
const TARGET = {
  endpoint: TEST_MANIFEST_ENDPOINT,
  bucket: TEST_MANIFEST_BUCKET,
  keyId: "test_tenant-manifest-key-id",
  secretKey: "test_tenant-manifest-secret",
};

const OLD_STATEMENT =
  '{"label": {"en": ["Attribution"], "es": ["Atribución"]}, "value": {"en": ["Old line."], "es": ["Línea vieja."]}}';
const OLD_PROVIDER = '[{"id": "https://old.example/", "type": "Agent", "label": {"en": ["Old"], "es": ["Old"]}}]';

function url(ref: string): string {
  return `${TEST_MANIFEST_BASE}/iiif/${ref}/manifest.json`;
}

function legacyText(id: string, provider: string | null = OLD_PROVIDER): string {
  return (
    `{"@context": "http://iiif.io/api/presentation/3/context.json", "id": "${id}", "type": "Manifest", ` +
    `"label": {"es": ["Título"]}, "metadata": [{"label": {"en": ["Date"], "es": ["Fecha"]}, "value": {"es": ["1877"]}}], ` +
    `"requiredStatement": ${OLD_STATEMENT}, "rights": "${RIGHTS}", ` +
    (provider === null ? "" : `"provider": ${provider}, `) +
    `"behavior": ["paged"], "items": [{"id": "${id}/canvas/1", "type": "Canvas", "height": 10, "width": 5}]}`
  );
}

const EXPECTED_STATEMENT = {
  label: { en: ["Attribution"], es: ["Atribución"] },
  value: {
    en: ["Archivo A, Ciudad A, Colombia. Credit A. Hosted here. CC BY-NC 4.0."],
    es: ["Archivo A, Ciudad A, Colombia. Crédito A. Alojado aquí. CC BY-NC 4.0."],
  },
};
const EXPECTED_PROVIDER = [
  {
    id: "https://provider.example/",
    type: "Agent",
    label: { en: ["Provider"], es: ["Provider"] },
    homepage: [
      { id: "https://site.example/", type: "Text", label: { en: ["Site"], es: ["Site"] }, format: "text/html" },
    ],
  },
];

function put(fake: FakeS3, key: string, text: string, meta: Record<string, string> = {}, etag = `seed-${key}`) {
  fake.objects.set(`${TEST_MANIFEST_BUCKET}/${key}`, {
    bytes: new TextEncoder().encode(text),
    etag,
    contentType: "application/json",
    meta,
  });
}

function object(fake: FakeS3, key: string) {
  return fake.objects.get(`${TEST_MANIFEST_BUCKET}/${key}`);
}

const REPO_A = "00000000-0000-4000-8000-00000000a001";
const REPO_B = "00000000-0000-4000-8000-00000000b001";
const REPO_OTHER = "00000000-0000-4000-8000-00000000c001";
const REPO_D = "00000000-0000-4000-8000-00000000d001";

async function repository(id: string, tenantId: string, code: string, name: string, rights: string | null) {
  const now = Date.now();
  await db().insert(schema.repositories).values({
    id,
    tenantId,
    code,
    name,
    city: "Ciudad A",
    country: "Colombia",
    countryCode: "CO",
    manifestRights: rights,
    creditStatementEs: "Crédito A.",
    creditStatementEn: "Credit A.",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function description(id: string, repositoryId: string, ref: string, manifestUrl: string | null, tenantId = DEFAULT_TEST_TENANT_ID) {
  await createTestDescription({ id, tenantId, repositoryId, referenceCode: ref, title: `Título ${ref}`, descriptionLevel: "file" });
  await env.DB.prepare("UPDATE descriptions SET iiif_manifest_url = ? WHERE id = ?").bind(manifestUrl, id).run();
}

const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function seedFederationRows(fake: FakeS3) {
  await seedTenantDestination();
  await env.DB.prepare(
    "UPDATE federations SET hosting_statement_es = 'Alojado aquí.', hosting_statement_en = 'Hosted here.' WHERE id = ?",
  ).bind(DEFAULT_TEST_FEDERATION_ID).run();
  await env.DB.prepare(
    "UPDATE tenants SET provider_name = 'Provider', provider_url = 'https://provider.example/', " +
      "public_site_url = 'https://site.example', public_site_name = 'Site' WHERE id = ?",
  ).bind(DEFAULT_TEST_TENANT_ID).run();
  await repository(REPO_A, DEFAULT_TEST_TENANT_ID, "co-a", "Archivo A", RIGHTS);
  await repository(REPO_B, DEFAULT_TEST_TENANT_ID, "co-b", "Archivo B", null);
  await repository(REPO_OTHER, SECOND_TEST_TENANT_ID, "co-o", "Archivo O", RIGHTS);

  // 1: an old attribution; 2: a pipeline object with a recorded digest;
  // 3: no object; 4: outside the manifest address; 5: an id that is not
  // its URL; 6: a repository without rights; 7: no manifest URL;
  // 8: another federation's tenant.
  await description(ids(1), REPO_A, "co-a-001", url("co-a-001"));
  await description(ids(2), REPO_A, "co-a-002", url("co-a-002"));
  await description(ids(3), REPO_A, "co-a-003", url("co-a-003"));
  await description(ids(4), REPO_A, "co-a-004", "https://elsewhere.example/iiif/co-a-004/manifest.json");
  await description(ids(5), REPO_A, "co-a-005", url("co-a-005"));
  await description(ids(6), REPO_B, "co-b-001", url("co-b-001"));
  await description(ids(7), REPO_A, "co-a-007", null);
  await description(ids(8), REPO_OTHER, "co-o-001", url("co-o-001"), SECOND_TEST_TENANT_ID);

  put(fake, "iiif/co-a-001/manifest.json", legacyText(url("co-a-001")));
  put(fake, "iiif/co-a-002/manifest.json", legacyText(url("co-a-002")), { sha256: "0".repeat(64), other: "kept" });
  put(fake, "iiif/co-a-005/manifest.json", legacyText(url("co-a-999")));
  put(fake, "iiif/co-b-001/manifest.json", legacyText(url("co-b-001")));
  put(fake, "iiif/co-o-001/manifest.json", legacyText(url("co-o-001")));
}

const noSleep = async () => {};

/** Puts the federation's apply lock in `instanceId`'s name, as the route does. */
async function holdLock(instanceId: string, extra: Record<string, unknown> = {}) {
  await env.BUCKET.put(refreshLockKey("neogranadina"), JSON.stringify({ instance_id: instanceId, started_at: 1, ...extra }));
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runAll(
  config: RefreshConfig,
  fetchImpl: typeof fetch,
  batchSize = REFRESH_BATCH_SIZE,
  sleep: (ms: number) => Promise<void> = noSleep,
  instanceId: string = crypto.randomUUID(),
): Promise<RefreshReport> {
  let report = newRefreshReport(config, instanceId, 0);
  const records = config.mode === "apply" ? refreshRecords(env.BUCKET, config.federationSlug, instanceId) : null;
  if (config.mode === "apply") await holdLock(instanceId);
  const lock = config.mode === "apply" ? () => refreshLockHeld(env.BUCKET, config.federationSlug, instanceId) : null;
  let cursor: RefreshCursor | null = null;
  for (;;) {
    const result = await refreshBatch(
      { db: db(), store: s3ManifestObjectStore(TARGET, fetchImpl), sleep, records, lock },
      config,
      cursor,
      batchSize,
    );
    report = addRefreshBatch(report, result);
    if (result.done) return report;
    cursor = result.cursor;
  }
}

describe("the manifest refresh run", () => {
  let fake: FakeS3;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    fake = fakeS3([TEST_MANIFEST_BUCKET]);
    await seedFederationRows(fake);
  });

  it("needs the federation's manifest bucket, address and write key", async () => {
    const fed = await db().select().from(schema.federations).all();
    const neo = fed.find((f) => f.id === DEFAULT_TEST_FEDERATION_ID)!;
    expect(manifestWriteMissing(neo, env)).toEqual([]);
    expect(manifestWriteMissing({ ...neo, manifestBucket: null }, env)).toEqual(["manifest_bucket"]);
    expect(manifestWriteMissing(neo, {})).toEqual(["secret:MANIFEST_WRITE_KEY_ID", "secret:MANIFEST_WRITE_SECRET_KEY"]);
  });

  it("reports in a dry run and writes nothing", async () => {
    const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run");
    const before = new Map([...fake.objects].map(([k, v]) => [k, v.etag]));
    const report = await runAll(config, fake.fetch, 2);

    expect(fake.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(new Map([...fake.objects].map(([k, v]) => [k, v.etag]))).toEqual(before);
    expect(fake.requests.some((r) => r.key.includes("co-o-001"))).toBe(false);
    expect((await env.BUCKET.list({ prefix: REFRESH_REPORT_PREFIX })).objects).toEqual([]);

    expect(report.counts).toEqual({ would_change: 2, refused: 1, skipped: 2, missing: 1 });
    const outcome = (ref: string) => report.items.find((i) => i.reference_code === ref);
    expect(outcome("co-a-001")).toMatchObject({ outcome: "would_change", fields: ["provider", "requiredStatement"] });
    expect(outcome("co-a-003")).toMatchObject({ outcome: "missing" });
    expect(outcome("co-a-004")).toMatchObject({ outcome: "skipped", reason: "outside_manifest_base" });
    expect(outcome("co-a-005")).toMatchObject({ outcome: "skipped", reason: "id_mismatch" });
    expect(outcome("co-b-001")).toMatchObject({ outcome: "refused", reason: "repository_rights_unset" });
    expect(outcome("co-a-007")).toBeUndefined();

    const a = report.repositories["co-a"];
    expect(a.counts).toEqual({ would_change: 2, skipped: 2, missing: 1 });
    expect(a.sample).toMatchObject({ reference_code: "co-a-001", changed: true });
    expect(a.sample!.before.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
    expect(a.sample!.after).toEqual({ provider: EXPECTED_PROVIDER, rights: RIGHTS, requiredStatement: EXPECTED_STATEMENT });
    expect(report.repositories["co-b"].counts).toEqual({ refused: 1 });
    expect(report.repositories["co-b"].sample).toBeNull();
  });

  it("writes in place on the read etag, keeps metadata, verifies, and a second apply writes nothing", async () => {
    const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "apply");
    const original = fake.text(TEST_MANIFEST_BUCKET, "iiif/co-a-001/manifest.json")!;
    const instance = "33333333-3333-4333-8333-333333333333";
    const report = await runAll(config, fake.fetch, REFRESH_BATCH_SIZE, noSleep, instance);
    expect(report.counts).toEqual({ written: 2, refused: 1, skipped: 2, missing: 1 });

    const puts = fake.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => [r.key, r.headers["if-match"]]).sort()).toEqual([
      ["iiif/co-a-001/manifest.json", '"seed-iiif/co-a-001/manifest.json"'],
      ["iiif/co-a-002/manifest.json", '"seed-iiif/co-a-002/manifest.json"'],
    ]);

    const written = fake.text(TEST_MANIFEST_BUCKET, "iiif/co-a-001/manifest.json")!;
    const doc = JSON.parse(written);
    expect(doc.requiredStatement).toEqual(EXPECTED_STATEMENT);
    expect(doc.provider).toEqual(EXPECTED_PROVIDER);
    // Everything outside the two changed values is the original text.
    const head = original.slice(0, original.indexOf('"requiredStatement": ') + '"requiredStatement": '.length);
    const tail = original.slice(original.indexOf(', "behavior": '));
    expect(written.startsWith(head)).toBe(true);
    expect(written.endsWith(tail)).toBe(true);
    expect(written).toContain(', "rights": "' + RIGHTS + '", "provider": [{"id": "https://provider.example/", "type": "Agent"');

    const one = object(fake, "iiif/co-a-001/manifest.json")!;
    expect(one.contentType).toBe("application/json");
    expect(one.meta).toEqual({});
    const two = object(fake, "iiif/co-a-002/manifest.json")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(two.bytes)));
    expect(two.meta).toEqual({ sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""), other: "kept" });
    expect(object(fake, "iiif/co-b-001/manifest.json")!.etag).toBe("seed-iiif/co-b-001/manifest.json");

    // Each write left a record of the fields before and after it.
    const record = await env.BUCKET.get(await refreshRecordKey("neogranadina", instance, "iiif/co-a-001/manifest.json"));
    const kept = JSON.parse(await record!.text());
    expect(kept).toMatchObject({
      key: "iiif/co-a-001/manifest.json",
      reference_code: "co-a-001",
      status: "written",
      before_etag: "seed-iiif/co-a-001/manifest.json",
      before_sha256: await sha(new TextEncoder().encode(original)),
      after: { provider: EXPECTED_PROVIDER, rights: RIGHTS, requiredStatement: EXPECTED_STATEMENT },
    });
    expect(kept.before.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
    const writtenItem = report.items.find((i) => i.reference_code === "co-a-001")!;
    expect(writtenItem.before!.provider).toEqual(JSON.parse(OLD_PROVIDER));
    expect(writtenItem.before_etag).toBe("seed-iiif/co-a-001/manifest.json");

    fake.requests.length = 0;
    const again = await runAll(config, fake.fetch);
    expect(again.counts).toEqual({ unchanged: 2, refused: 1, skipped: 2, missing: 1 });
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([]);
    expect(again.repositories["co-a"].sample).toMatchObject({ reference_code: "co-a-001", changed: false });
  });

  it("records a conflict when another writer gets there first", async () => {
    const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "apply");
    const key = "iiif/co-a-001/manifest.json";
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "PUT" && request.url.includes(key)) {
        put(fake, key, legacyText(url("co-a-001")), {}, "someone-else");
      }
      return fake.fetch(request);
    }) as typeof fetch;
    const report = await runAll(config, racing);
    expect(report.items.find((i) => i.reference_code === "co-a-001")).toMatchObject({ outcome: "conflict" });
    expect(object(fake, key)!.etag).toBe("someone-else");
    expect(report.counts.written).toBe(1);
  });

  it("retries a transient answer and fails a refusal without retrying", async () => {
    const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "apply");
    let busy = 2;
    let refusedPuts = 0;
    const sleeps: number[] = [];
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes("co-a-001") && request.method === "GET" && busy > 0) {
        busy--;
        return new Response("SlowDown", { status: 503 });
      }
      if (request.url.includes("co-a-002") && request.method === "PUT") {
        refusedPuts++;
        return new Response("AccessDenied", { status: 403 });
      }
      return fake.fetch(request);
    }) as typeof fetch;
    const report = await runAll(config, flaky, REFRESH_BATCH_SIZE, async (ms) => {
      sleeps.push(ms);
    });
    expect(report.items.find((i) => i.reference_code === "co-a-001")).toMatchObject({ outcome: "written" });
    expect(sleeps.length).toBe(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    expect(report.items.find((i) => i.reference_code === "co-a-002")).toMatchObject({
      outcome: "failed",
      reason: "store_403",
    });
    expect(refusedPuts).toBe(1);
  });

  it("counts a write as made when its answer was lost and the retry finds its own bytes", async () => {
    const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "apply");
    let lost = 1;
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fake.fetch(request);
      if (request.method === "PUT" && request.url.includes("co-a-001") && lost > 0) {
        lost--;
        return new Response("InternalError", { status: 500 });
      }
      return response;
    }) as typeof fetch;
    const report = await runAll(config, lossy);
    expect(report.items.find((i) => i.reference_code === "co-a-001")).toMatchObject({ outcome: "written" });
    expect(fake.requests.filter((r) => r.method === "PUT" && r.key.includes("co-a-001")).length).toBe(2);
  });

  it("refuses to empty a provider, and leaves an absent or empty one as it is", async () => {
    await env.DB.prepare("UPDATE tenants SET provider_name = NULL, provider_url = NULL WHERE id = ?")
      .bind(DEFAULT_TEST_TENANT_ID)
      .run();
    put(fake, "iiif/co-a-002/manifest.json", legacyText(url("co-a-002"), null));
    put(fake, "iiif/co-a-003/manifest.json", legacyText(url("co-a-003"), "[]"));
    const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "apply");
    const report = await runAll(config, fake.fetch);
    const outcome = (ref: string) => report.items.find((i) => i.reference_code === ref);
    expect(outcome("co-a-001")).toMatchObject({ outcome: "refused", reason: "provider_unset" });
    expect(object(fake, "iiif/co-a-001/manifest.json")!.etag).toBe("seed-iiif/co-a-001/manifest.json");
    expect(outcome("co-a-002")).toMatchObject({ outcome: "written", fields: ["requiredStatement"] });
    expect(outcome("co-a-003")).toMatchObject({ outcome: "written", fields: ["requiredStatement"] });
    const two = JSON.parse(fake.text(TEST_MANIFEST_BUCKET, "iiif/co-a-002/manifest.json")!);
    expect("provider" in two).toBe(false);
    const three = JSON.parse(fake.text(TEST_MANIFEST_BUCKET, "iiif/co-a-003/manifest.json")!);
    expect(three.provider).toEqual([]);
  });

  it("takes the first descriptions by reference code up to the limit, and one repository's", async () => {
    // Read last by id, first by reference code.
    await description(ids(9), REPO_A, "co-a-000", url("co-a-000"));
    const limited = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run", { limit: 3 });
    const report = await runAll(limited, fake.fetch, 2);
    expect(report.items.map((i) => i.reference_code)).toEqual(["co-a-000", "co-a-001", "co-a-002"]);
    expect(report.limit).toBe(3);
    expect(report.repository).toBeNull();

    const one = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run", { repository: "co-b" });
    const only = await runAll(one, fake.fetch, 2);
    expect(only.items.map((i) => i.reference_code)).toEqual(["co-b-001"]);
    expect(only.repository).toBe("co-b");
    expect(only.limit).toBeNull();
  });

  describe("deciding from the record", () => {
    const KEY = "iiif/co-a-001/manifest.json";
    const INSTANCE = "55555555-5555-4555-8555-555555555555";
    const VALUES = { provider: EXPECTED_PROVIDER, rights: RIGHTS, requiredStatement: EXPECTED_STATEMENT };
    const intended = () => spliceRefreshFields(legacyText(url("co-a-001")), VALUES);

    async function recordOf(key = KEY) {
      const obj = await env.BUCKET.get(await refreshRecordKey("neogranadina", INSTANCE, key));
      return obj === null ? null : JSON.parse(await obj.text());
    }
    async function setStatus(status: string, key = KEY) {
      const record = await recordOf(key);
      await env.BUCKET.put(await refreshRecordKey("neogranadina", INSTANCE, key), JSON.stringify({ ...record, status }));
    }
    async function apply(fetchImpl: typeof fetch = fake.fetch) {
      const config = await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "apply", { limit: 1500 });
      return runAll(config, fetchImpl, REFRESH_BATCH_SIZE, noSleep, INSTANCE);
    }
    const putsTo = (key: string) => fake.requests.filter((r) => r.method === "PUT" && r.key === key).length;
    const item = (report: RefreshReport) => report.items.find((i) => i.key === KEY);
    const refuseFirstPut = (() => {
      let refused = false;
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (!refused && request.method === "PUT" && request.url.includes(KEY)) {
          refused = true;
          return new Response("AccessDenied", { status: 403 });
        }
        return fake.fetch(request);
      }) as typeof fetch;
    });

    it("pending, write landed: written, with no second write", async () => {
      await apply();
      await setStatus("pending");
      fake.requests.length = 0;
      const report = await apply();
      expect(item(report)).toMatchObject({ outcome: "written" });
      expect(item(report)!.before!.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
      expect(putsTo(KEY)).toBe(0);
      expect((await recordOf()).status).toBe("written");
    });

    it("pending, write landed, then another writer changed the object: conflict, no write", async () => {
      await apply();
      await setStatus("pending");
      put(fake, KEY, legacyText(url("co-a-001")), {}, "other-writer");
      fake.requests.length = 0;
      const report = await apply();
      expect(item(report)).toMatchObject({ outcome: "conflict", reason: "changed_by_other_writer" });
      expect(item(report)!.before!.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
      expect(putsTo(KEY)).toBe(0);
      expect(object(fake, KEY)!.etag).toBe("other-writer");
      const record = await recordOf();
      expect(record.before.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
      expect(record.before_etag).toBe(`seed-${KEY}`);
    });

    it("pending, write never made, object untouched: the intended bytes are written now", async () => {
      await apply(refuseFirstPut());
      await setStatus("pending");
      fake.requests.length = 0;
      const report = await apply();
      expect(item(report)).toMatchObject({ outcome: "written" });
      expect(putsTo(KEY)).toBe(1);
      expect(fake.text(TEST_MANIFEST_BUCKET, KEY)).toBe(intended());
      expect((await recordOf()).status).toBe("written");
    });

    it("pending, write never made, another writer set the right fields with other canvases: conflict", async () => {
      await apply(refuseFirstPut());
      await setStatus("pending");
      const theirs = intended().replace('"height": 10', '"height": 11');
      put(fake, KEY, theirs, {}, "other-writer");
      fake.requests.length = 0;
      const report = await apply();
      expect(item(report)).toMatchObject({ outcome: "conflict", reason: "changed_by_other_writer" });
      expect(putsTo(KEY)).toBe(0);
      expect(fake.text(TEST_MANIFEST_BUCKET, KEY)).toBe(theirs);
    });

    it("failed or conflict record, fields now current: reported as recorded", async () => {
      await apply(refuseFirstPut());
      expect((await recordOf()).status).toBe("failed");
      put(fake, KEY, intended(), {}, "made-current");
      const failed = await apply();
      expect(item(failed)).toMatchObject({ outcome: "failed", reason: "store_403" });

      await setStatus("conflict");
      fake.requests.length = 0;
      const conflict = await apply();
      expect(item(conflict)).toMatchObject({ outcome: "conflict" });
      expect(fake.requests.filter((r) => r.key === KEY)).toEqual([]);
    });
  });

  it("reports the writes of a batch whose retries ran out", async () => {
    const workflow = Object.create(ManifestRefreshWorkflow.prototype) as ManifestRefreshWorkflow;
    (workflow as any).env = env;
    (workflow as any).fetcher = () => fake.fetch;
    const instanceId = "66666666-6666-4666-8666-666666666666";
    await holdLock(instanceId);
    await expect(
      workflow.run(
        { payload: { federationId: DEFAULT_TEST_FEDERATION_ID, federationSlug: "neogranadina", mode: "apply", limit: 1500 }, timestamp: new Date(1000), instanceId } as any,
        {
          async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
            const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
            const result = await callback();
            if (name === "batch:1") throw new Error("retries exhausted");
            return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          },
        } as any,
      ),
    ).rejects.toThrow("retries exhausted");
    const report = JSON.parse(await (await env.BUCKET.get(refreshReportKey("neogranadina", instanceId)))!.text());
    expect(report.status).toBe("failed");
    expect(report.counts).toEqual({ written: 2 });
    const written = report.items.filter((i: { outcome: string }) => i.outcome === "written");
    expect(written.map((i: { reference_code: string }) => i.reference_code).sort()).toEqual(["co-a-001", "co-a-002"]);
    for (const w of written) expect(w.before.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
    expect(report.repositories["co-a"].counts).toEqual({ written: 2 });
  });

  describe("the workflow's preconditions", () => {
    function step(steps: string[], failOn?: string) {
      return {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          steps.push(name);
          const result = await callback();
          if (name === failOn) throw new Error("retries exhausted");
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      } as any;
    }
    function workflow() {
      const w = Object.create(ManifestRefreshWorkflow.prototype) as ManifestRefreshWorkflow;
      (w as any).env = env;
      (w as any).fetcher = () => fake.fetch;
      return w;
    }
    const event = (instanceId: string, mode: "apply" | "dry_run") =>
      ({
        payload: { federationId: DEFAULT_TEST_FEDERATION_ID, federationSlug: "neogranadina", mode, limit: 1500 },
        timestamp: new Date(1000),
        instanceId,
      }) as any;
    const lockKey = refreshLockKey("neogranadina");
    const lockOf = async () => JSON.parse(await (await env.BUCKET.get(lockKey))!.text());

    it("releases the lock after an apply succeeds and after one fails", async () => {
      const ok = "77777777-7777-4777-8777-777777777777";
      await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: ok, started_at: 1 }));
      await workflow().run(event(ok, "apply"), step([]));
      expect(await lockOf()).toMatchObject({ instance_id: ok, released_at: expect.any(Number) });

      const bad = "88888888-8888-4888-8888-888888888888";
      await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: bad, started_at: 1 }));
      await expect(workflow().run(event(bad, "apply"), step([], "batch:1"))).rejects.toThrow("retries exhausted");
      expect(await lockOf()).toMatchObject({ instance_id: bad, released_at: expect.any(Number) });
    });

    it("leaves another instance's lock alone", async () => {
      await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: "someone-else", started_at: 1 }));
      await workflow().run(event("99999999-9999-4999-8999-999999999999", "dry_run"), step([]));
      expect(await lockOf()).toEqual({ instance_id: "someone-else", started_at: 1 });
    });

    it("fails a batch before any read or write when the lock is released or another's", async () => {
      for (const [instanceId, lock] of [
        ["bbbbbbbb-0000-4000-8000-000000000001", { instance_id: "bbbbbbbb-0000-4000-8000-000000000001", started_at: 1, released_at: 2 }],
        ["bbbbbbbb-0000-4000-8000-000000000002", { instance_id: "someone-else", started_at: 1 }],
      ] as const) {
        await env.BUCKET.put(lockKey, JSON.stringify(lock));
        fake.requests.length = 0;
        const steps: string[] = [];
        await expect(workflow().run(event(instanceId, "apply"), step(steps))).rejects.toThrow("lock_not_held");
        expect(steps).toContain("batch:1");
        expect(fake.requests).toEqual([]);
        expect(await lockOf()).toEqual(lock);
      }
      await env.BUCKET.delete(lockKey);
      fake.requests.length = 0;
      await expect(
        workflow().run(event("bbbbbbbb-0000-4000-8000-000000000003", "apply"), step([])),
      ).rejects.toThrow("lock_not_held");
      expect(fake.requests).toEqual([]);
    });

    it("fails a batch before any write when its URLs were made shared after check-urls", async () => {
      const instanceId = "cccccccc-0000-4000-8000-000000000001";
      await holdLock(instanceId);
      const steps: string[] = [];
      const changing = {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          steps.push(name);
          const result = await callback();
          if (name === "batch:1") {
            // co-a-003, read by the second batch, now names co-a-001's manifest.
            await env.DB.prepare("UPDATE descriptions SET iiif_manifest_url = ? WHERE id = ?").bind(url("co-a-001"), ids(3)).run();
          }
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      } as any;
      const run = workflow().run(
        {
          payload: { federationId: DEFAULT_TEST_FEDERATION_ID, federationSlug: "neogranadina", mode: "apply", limit: 1500, batchSize: 2 },
          timestamp: new Date(1000),
          instanceId,
        } as any,
        changing,
      );
      await expect(run).rejects.toThrow("duplicate_manifest_url");
      expect(steps).toContain("batch:2");
      expect(fake.requests.filter((r) => r.method === "PUT").map((r) => r.key).sort()).toEqual([
        "iiif/co-a-001/manifest.json",
        "iiif/co-a-002/manifest.json",
      ]);
      const report = JSON.parse(await (await env.BUCKET.get(refreshReportKey("neogranadina", instanceId)))!.text());
      expect(report.status).toBe("failed");
      expect(report.error).toContain(url("co-a-001"));
    });

    it("fails before any batch when two descriptions share a manifest URL", async () => {
      await description(ids(12), REPO_A, "co-a-012", url("co-a-001"));
      for (const mode of ["dry_run", "apply"] as const) {
        const instanceId = mode === "apply" ? "aaaaaaaa-0000-4000-8000-000000000001" : "aaaaaaaa-0000-4000-8000-000000000002";
        if (mode === "apply") await env.BUCKET.put(lockKey, JSON.stringify({ instance_id: instanceId, started_at: 1 }));
        const steps: string[] = [];
        await expect(workflow().run(event(instanceId, mode), step(steps))).rejects.toThrow("duplicate_manifest_url");
        expect(steps.some((n) => n.startsWith("batch:"))).toBe(false);
        expect(fake.requests).toEqual([]);
        const report = JSON.parse(await (await env.BUCKET.get(refreshReportKey("neogranadina", instanceId)))!.text());
        expect(report).toMatchObject({
          status: "failed",
          error: "duplicate_manifest_url",
          duplicate_manifest_urls: [url("co-a-001")],
        });
        if (mode === "apply") expect(await lockOf()).toMatchObject({ released_at: expect.any(Number) });
      }
    });
  });

  it("runs as a workflow in batches and writes the report to BUCKET", async () => {
    const workflow = Object.create(ManifestRefreshWorkflow.prototype) as ManifestRefreshWorkflow;
    (workflow as any).env = env;
    (workflow as any).fetcher = () => fake.fetch;
    const steps: string[] = [];
    const instanceId = "11111111-1111-4111-8111-111111111111";
    const output = await workflow.run(
      {
        payload: { federationId: DEFAULT_TEST_FEDERATION_ID, federationSlug: "neogranadina", mode: "dry_run", batchSize: 2, limit: 1500 },
        timestamp: new Date(1000),
        instanceId,
      } as any,
      {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          steps.push(name);
          const result = await callback();
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      } as any,
    );
    // Six descriptions of the federation have a manifest URL: three batches of two, then an empty one.
    expect(steps).toEqual(["load-config", "check-urls", "batch:1", "batch:2", "batch:3", "batch:4", "write-report"]);
    const key = refreshReportKey("neogranadina", instanceId);
    expect(output).toMatchObject({ report_key: key, counts: { would_change: 2, refused: 1, skipped: 2, missing: 1 } });
    const stored = await env.BUCKET.get(key);
    const report = JSON.parse(await stored!.text());
    expect(report).toMatchObject({
      instance_id: instanceId,
      mode: "dry_run",
      status: "complete",
      federation: { id: DEFAULT_TEST_FEDERATION_ID, slug: "neogranadina" },
      counts: { would_change: 2, refused: 1, skipped: 2, missing: 1 },
    });
    expect(stored!.httpMetadata?.contentType).toBe("application/json");
    await env.BUCKET.delete(key);
  });

  it("reports writes made by a batch attempt whose result was lost, with their before-values", async () => {
    const workflow = Object.create(ManifestRefreshWorkflow.prototype) as ManifestRefreshWorkflow;
    (workflow as any).env = env;
    (workflow as any).fetcher = () => fake.fetch;
    const instanceId = "44444444-4444-4444-8444-444444444444";
    await holdLock(instanceId);
    let attempts = 0;
    const output = await workflow.run(
      { payload: { federationId: DEFAULT_TEST_FEDERATION_ID, federationSlug: "neogranadina", mode: "apply", limit: 1500 }, timestamp: new Date(1000), instanceId } as any,
      {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          if (name === "batch:1") {
            // The first attempt writes and then fails before its result is kept.
            attempts++;
            await callback();
            expect(fake.requests.filter((r) => r.method === "PUT").length).toBe(2);
          }
          const result = await callback();
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      } as any,
    );
    expect(attempts).toBe(1);
    expect(fake.requests.filter((r) => r.method === "PUT").length).toBe(2);
    expect(output.counts).toMatchObject({ written: 2 });
    expect(output.counts.unchanged).toBeUndefined();
    const report = JSON.parse(await (await env.BUCKET.get(output.report_key))!.text());
    const written = report.items.filter((i: { outcome: string }) => i.outcome === "written");
    expect(written.map((i: { reference_code: string }) => i.reference_code).sort()).toEqual(["co-a-001", "co-a-002"]);
    for (const item of written) {
      expect(item.before.requiredStatement).toEqual(JSON.parse(OLD_STATEMENT));
      expect(item.before.provider).toEqual(JSON.parse(OLD_PROVIDER));
      expect(item.before_etag).toBe(`seed-${item.key}`);
    }
  });

  it("covers one unbounded pass exactly with instances chained on `after`", async () => {
    // A second tenant of the federation holds a description with the same reference code.
    await env.DB.prepare("UPDATE tenants SET federation_id = ? WHERE id = ?")
      .bind(DEFAULT_TEST_FEDERATION_ID, DACS_TEST_TENANT_ID)
      .run();
    await repository(REPO_D, DACS_TEST_TENANT_ID, "co-d", "Archivo D", RIGHTS);
    const sameRef = `${TEST_MANIFEST_BASE}/dacs-test/iiif/co-a-002/manifest.json`;
    await description(ids(11), REPO_D, "co-a-002", sameRef, DACS_TEST_TENANT_ID);
    put(fake, "dacs-test/iiif/co-a-002/manifest.json", legacyText(sameRef));

    const all = await runAll(await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run"), fake.fetch, 2);
    const order = all.items.map((i) => i.description_id);
    expect(order.slice(1, 3)).toEqual([ids(2), ids(11)]);
    expect(all.next_after).toBeNull();

    // The first instance stops between the two equal reference codes.
    const first = await runAll(
      await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run", { limit: 2 }),
      fake.fetch,
      2,
    );
    expect(first.next_after).toEqual({ reference_code: "co-a-002", id: ids(2) });
    const second = await runAll(
      await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run", { limit: 4, after: first.next_after! }),
      fake.fetch,
      3,
    );
    expect(second.after).toEqual(first.next_after);
    const third = await runAll(
      await loadRefreshConfig(db(), env, DEFAULT_TEST_FEDERATION_ID, "dry_run", { limit: 4, after: second.next_after! }),
      fake.fetch,
      3,
    );
    expect(third.next_after).toBeNull();
    const chained = [...first.items, ...second.items, ...third.items].map((i) => i.description_id);
    expect(chained).toEqual(order);
    expect(new Set(chained).size).toBe(chained.length);
  });

  it("stops the workflow at the limit", async () => {
    const workflow = Object.create(ManifestRefreshWorkflow.prototype) as ManifestRefreshWorkflow;
    (workflow as any).env = env;
    (workflow as any).fetcher = () => fake.fetch;
    const steps: string[] = [];
    const instanceId = "22222222-2222-4222-8222-222222222222";
    const output = await workflow.run(
      {
        payload: { federationId: DEFAULT_TEST_FEDERATION_ID, federationSlug: "neogranadina", mode: "dry_run", batchSize: 2, limit: 3 },
        timestamp: new Date(1000),
        instanceId,
      } as any,
      {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          steps.push(name);
          const result = await callback();
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      } as any,
    );
    expect(steps).toEqual(["load-config", "check-urls", "batch:1", "batch:2", "write-report"]);
    const report = JSON.parse(await (await env.BUCKET.get(output.report_key))!.text());
    expect(report.items.map((i: { reference_code: string }) => i.reference_code)).toEqual([
      "co-a-001",
      "co-a-002",
      "co-a-003",
    ]);
    expect(report.limit).toBe(3);
    await env.BUCKET.delete(output.report_key);
  });
});
