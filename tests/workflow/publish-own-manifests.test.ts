/**
 * Tests — publish refreshes a description's own manifest
 *
 * This suite drives `PublishExportWorkflow.run` with a stand-in for the
 * Workflow step that runs every step body for real, over one fonds,
 * against the test D1 and an in-memory S3 bucket (`fakeS3`) that stands
 * in for the federation's manifest bucket. A description's own manifest
 * is the one at its own reference code under the federation's manifest
 * address; it carries the record's title as `label`, its scope and
 * content as `summary`, and the title again as its homepage's label.
 *
 *   - a published description whose title and scope changed since the
 *     last publish has its manifest rewritten: `label`, `summary` and the
 *     homepage label carry the new values, and every other byte of the
 *     manifest, and its stored metadata, is as it was;
 *   - a description whose record did not change since the last publish
 *     has its manifest neither read nor written;
 *   - a description whose manifest URL names another description's
 *     manifest has nothing read or written, even when its record changed;
 *   - a fonds whose descriptions have no own manifest makes no request to
 *     the manifest bucket at all;
 *   - every own manifest whose URL another description also names is
 *     skipped and never read, however many share a URL in one batch (51
 *     here, past the 50 the attribution refresh's report lists);
 *   - a federation with a manifest bucket but without a write secret or
 *     an endpoint fails the step, naming what is missing, when there is a
 *     manifest to refresh, as does one with a bucket and an address of
 *     whitespace alone; one with no manifest bucket, with or without an
 *     address, skips the refresh with a warning and reads nothing;
 *   - destination fields padded with spaces are read trimmed, so a padded
 *     secret prefix whose secrets are set still writes.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { seedTenantDestination, TEST_MANIFEST_BASE, TEST_MANIFEST_BUCKET } from "../helpers/media-pipeline";
import { fakeS3, type FakeS3 } from "../helpers/fake-s3";
import { PublishExportWorkflow } from "../../app/workflows/publish-export";
import { countPublishSteps } from "../../app/lib/export/publish-steps";
import { refreshOwnManifests } from "../../app/lib/export/own-manifests.server";
import { ExportStorage } from "../../app/lib/export/r2-client.server";

const FONDS = "co-own";
const SITE = "https://site.example";
const RIGHTS = "http://creativecommons.org/licenses/by-nc/4.0/";

const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const urlOf = (ref: string) => `${TEST_MANIFEST_BASE}/iiif/${ref}/manifest.json`;
const keyOf = (ref: string) => `iiif/${ref}/manifest.json`;

/** A manifest in the published style: one line, Python's separators, non-ASCII raw. */
function manifestText(ref: string, title: string, scope: string | null): string {
  const id = urlOf(ref);
  return (
    `{"@context": "http://iiif.io/api/presentation/3/context.json", "id": "${id}", "type": "Manifest", ` +
    `"label": {"es": [${JSON.stringify(title)}]}, ` +
    `"metadata": [{"label": {"en": ["Reference"], "es": ["Signatura"]}, "value": {"es": ["${ref}"]}}], ` +
    (scope === null ? "" : `"summary": {"es": [${JSON.stringify(scope)}]}, `) +
    `"requiredStatement": {"label": {"es": ["Atribución"]}, "value": {"es": ["Archivo, Ciudad."]}}, ` +
    `"rights": "${RIGHTS}", ` +
    `"provider": [{"id": "https://provider.example/", "type": "Agent", "label": {"en": ["P"], "es": ["P"]}}], ` +
    `"homepage": [{"id": "${SITE}/${ref}/", "type": "Text", "label": {"es": [${JSON.stringify(title)}]}, "format": "text/html"}], ` +
    `"behavior": ["paged"], ` +
    `"items": [{"id": "${id.replace(/\/manifest\.json$/, "")}/canvas/1", "type": "Canvas", "height": 10, "width": 5}]}`
  );
}

function put(fake: FakeS3, key: string, text: string, meta: Record<string, string> = {}) {
  fake.objects.set(`${TEST_MANIFEST_BUCKET}/${key}`, {
    bytes: new TextEncoder().encode(text),
    etag: `seed-${key}`,
    contentType: "application/json",
    meta,
  });
}

describe("publish refreshes a description's own manifest", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  async function setUp(withManifests: boolean) {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const seeded = Date.now() - 60_000;
    const tenant = {
      id: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      slug: "neogranadina",
      descriptiveStandard: "isadg",
    };
    await seedTenantDestination();
    await env.DB.prepare("UPDATE tenants SET public_site_url = ?, public_site_name = 'Site' WHERE id = ?")
      .bind(SITE, tenant.id)
      .run();
    const userId = "u-own-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: tenant.id, email: "own@example.com", isSuperAdmin: true, createdAt: seeded, updatedAt: seeded,
    });
    const repoId = "00000000-0000-4000-8000-00000000e001";
    await db.insert(schema.repositories).values({
      id: repoId, tenantId: tenant.id, code: "co-own-repo", name: "Archivo", city: "Ciudad", manifestRights: RIGHTS,
      enabled: true, createdAt: seeded, updatedAt: seeded,
    });
    const rootId = ids(100);
    const row = (id: string, ref: string, title: string, scope: string | null, manifestUrl: string | null, level: "file" | "fonds" = "file") => ({
      id, tenantId: tenant.id, repositoryId: repoId, parentId: id === rootId ? null : rootId, rootDescriptionId: rootId,
      descriptionLevel: level, referenceCode: ref, title, scopeContent: scope, isPublished: true,
      iiifManifestUrl: manifestUrl, createdAt: seeded, updatedAt: seeded,
    });
    await db.insert(schema.descriptions).values(row(rootId, FONDS, "Fondo", null, null, "fonds"));
    if (withManifests) {
      // 1: its own manifest, edited later; 2: its own manifest, never
      // edited; 3: a document whose URL names volume 9's manifest.
      await db.insert(schema.descriptions).values([
        row(ids(1), "co-own-001", "Cédula real de 1650", "Alcance viejo.", urlOf("co-own-001")),
        row(ids(2), "co-own-002", "Cédula real de 1700", "Alcance.", urlOf("co-own-002")),
        row(ids(3), "co-own-003", "Documento suelto", null, urlOf("co-own-vol-9")),
      ]);
    } else {
      await db.insert(schema.descriptions).values([row(ids(1), "co-own-001", "Expediente", null, null)]);
    }

    const config = {
      selectedFonds: [FONDS],
      selectedTypes: ["descriptions"],
      publishTenant: tenant,
      memberTenantIds: [tenant.id],
      fondsTenants: { [FONDS]: tenant },
      authoritiesEnabled: false,
    };
    const totalSteps = countPublishSteps(config);
    const step = {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
        if (name === "load-config") return config;
        const result = await callback();
        return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      },
    };
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = env;
    (workflow as any).manifestFetcher = () => fake.fetch;

    async function publish(exportId: string, createdAt: number) {
      await db.insert(schema.exportRuns).values({
        id: exportId, triggeredBy: userId, tenantId: tenant.id, status: "running",
        selectedFonds: JSON.stringify(config.selectedFonds), selectedTypes: JSON.stringify(config.selectedTypes),
        stepsCompleted: 0, totalSteps, createdAt,
      });
      await workflow.run({ payload: { exportId }, timestamp: new Date(), instanceId: "i" } as any, step as any);
      const run = await env.DB.prepare("SELECT status, record_counts AS recordCounts FROM export_runs WHERE id = ?")
        .bind(exportId)
        .first<{ status: string; recordCounts: string }>();
      return { status: run!.status, counts: JSON.parse(run!.recordCounts) };
    }
    return { db, fake, publish, seeded };
  }

  it("rewrites the label, summary and homepage label of a changed description, and nothing else", async () => {
    const { fake, publish, seeded } = await setUp(true);
    const before1 = manifestText("co-own-001", "Cédula real de 1650", "Alcance viejo.");
    const before2 = manifestText("co-own-002", "Cédula real de 1700", "Alcance.");
    const volume = manifestText("co-own-vol-9", "Volumen 9", "Alcance del volumen.");
    put(fake, keyOf("co-own-001"), before1, { sha256: "0".repeat(64), other: "kept" });
    put(fake, keyOf("co-own-002"), before2);
    put(fake, keyOf("co-own-vol-9"), volume);

    const first = await publish("55555555-5555-4555-8555-000000000001", seeded + 1_000);
    expect(first.status).toBe("complete");
    // Every manifest already holds its record's fields: nothing written.
    expect(fake.requests.filter((r) => r.method === "PUT")).toEqual([]);

    // The record changes after the first publish.
    const edited = seeded + 10_000;
    await env.DB.prepare("UPDATE descriptions SET title = ?, scope_content = ?, updated_at = ? WHERE id = ?")
      .bind("Real cédula de 1650", "Alcance nuevo, con «comillas».", edited, ids(1))
      .run();
    await env.DB.prepare("UPDATE descriptions SET title = ?, updated_at = ? WHERE id = ?")
      .bind("Documento suelto, revisado", edited, ids(3))
      .run();
    fake.requests.length = 0;

    const second = await publish("55555555-5555-4555-8555-000000000002", seeded + 20_000);
    expect(second.status).toBe("complete");

    const expected = before1
      .replace('"label": {"es": ["Cédula real de 1650"]}, "metadata"', '"label": {"es": ["Real cédula de 1650"]}, "metadata"')
      .replace('"summary": {"es": ["Alcance viejo."]}', '"summary": {"es": ["Alcance nuevo, con «comillas»."]}')
      .replace(
        `"label": {"es": ["Cédula real de 1650"]}, "format": "text/html"`,
        `"label": {"es": ["Real cédula de 1650"]}, "format": "text/html"`,
      );
    expect(expected).not.toBe(before1);
    expect(fake.text(TEST_MANIFEST_BUCKET, keyOf("co-own-001"))).toBe(expected);
    const stored = fake.objects.get(`${TEST_MANIFEST_BUCKET}/${keyOf("co-own-001")}`)!;
    expect(stored.contentType).toBe("application/json");
    expect(stored.meta.other).toBe("kept");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)));
    expect(stored.meta.sha256).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(second.counts[`manifests:${FONDS}`]).toBe(1);

    // The unchanged description's manifest is neither read nor written.
    expect(fake.requests.filter((r) => r.key === keyOf("co-own-002"))).toEqual([]);
    expect(fake.text(TEST_MANIFEST_BUCKET, keyOf("co-own-002"))).toBe(before2);
    // The document that names another description's manifest touches nothing.
    expect(fake.requests.filter((r) => r.key === keyOf("co-own-vol-9"))).toEqual([]);
    expect(fake.text(TEST_MANIFEST_BUCKET, keyOf("co-own-vol-9"))).toBe(volume);
    // Only the changed manifest was read and written.
    expect([...new Set(fake.requests.map((r) => r.key))]).toEqual([keyOf("co-own-001")]);
  });

  it("makes no request to the manifest bucket for a fonds without own manifests", async () => {
    const { fake, publish, seeded } = await setUp(false);
    const run = await publish("55555555-5555-4555-8555-000000000003", seeded + 1_000);
    expect(run.status).toBe("complete");
    expect(fake.requests).toEqual([]);
  });
});

describe("the own-manifest step's checks", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  const tenant = {
    id: DEFAULT_TEST_TENANT_ID,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    slug: "neogranadina",
    descriptiveStandard: "isadg" as const,
  };
  const repoId = "00000000-0000-4000-8000-00000000e101";
  const rootId = ids(200);

  /** A fonds with `n` descriptions, each with its own manifest, all changed. */
  async function seed(n: number) {
    await cleanDatabase();
    await seedTenantDestination();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    await db.insert(schema.repositories).values({
      id: repoId, tenantId: tenant.id, code: "co-chk-repo", name: "Archivo", manifestRights: RIGHTS,
      enabled: true, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.descriptions).values({
      id: rootId, tenantId: tenant.id, repositoryId: repoId, parentId: null, rootDescriptionId: rootId,
      descriptionLevel: "fonds", referenceCode: "co-chk", title: "Fondo", isPublished: true,
      createdAt: now, updatedAt: now,
    });
    for (let i = 1; i <= n; i++) {
      const ref = `co-chk-${String(i).padStart(3, "0")}`;
      await db.insert(schema.descriptions).values({
        id: ids(200 + i), tenantId: tenant.id, repositoryId: repoId, parentId: rootId, rootDescriptionId: rootId,
        descriptionLevel: "file", referenceCode: ref, title: `Nuevo ${i}`, isPublished: true,
        iiifManifestUrl: urlOf(ref), createdAt: now, updatedAt: now,
      });
    }
    return db;
  }

  function deps(fake: FakeS3, extraEnv: Record<string, unknown> = {}) {
    return {
      db: drizzle(env.DB, { schema }),
      env: { ...env, ...extraEnv },
      storage: new ExportStorage(env.EXPORT_BUCKET),
      fetchImpl: fake.fetch,
      sleep: async () => {},
    };
  }

  it("skips every own manifest whose URL another description names, past fifty in a batch", async () => {
    const db = await seed(51);
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    for (let i = 1; i <= 51; i++) {
      const ref = `co-chk-${String(i).padStart(3, "0")}`;
      put(fake, keyOf(ref), manifestText(ref, `Viejo ${i}`, null));
      // Another description, not this one, names the same manifest.
      await db.insert(schema.descriptions).values({
        id: ids(400 + i), tenantId: tenant.id, repositoryId: repoId, parentId: rootId, rootDescriptionId: rootId,
        descriptionLevel: "item", referenceCode: `${ref}-d`, title: "Documento", isPublished: true,
        iiifManifestUrl: urlOf(ref), createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
    const state = await refreshOwnManifests(deps(fake), tenant, "co-chk", { force: true, batchSize: 200 });
    expect(state.done).toBe(true);
    expect(state.counts).toEqual({ skipped: 51 });
    expect(fake.requests).toEqual([]);
  });

  it("fails, naming what is missing, when the federation has a bucket but no write secret", async () => {
    await seed(1);
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    const withoutSecret = deps(fake, { TEST_TENANT_MANIFEST_WRITE_SECRET_KEY: undefined });
    await expect(refreshOwnManifests(withoutSecret, tenant, "co-chk", { force: true })).rejects.toThrow(
      /secret:MANIFEST_WRITE_SECRET_KEY/,
    );
    expect(fake.requests).toEqual([]);
  });

  it("fails, naming what is missing, when the federation has a bucket but no endpoint", async () => {
    await seed(1);
    await env.DB.prepare("UPDATE federations SET manifest_endpoint = NULL WHERE id = ?").bind(tenant.federationId).run();
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    await expect(refreshOwnManifests(deps(fake), tenant, "co-chk", { force: true })).rejects.toThrow(/manifest_endpoint/);
    expect(fake.requests).toEqual([]);
  });

  it("skips the refresh when the federation has no manifest bucket", async () => {
    await seed(1);
    await env.DB.prepare("UPDATE federations SET manifest_bucket = NULL WHERE id = ?").bind(tenant.federationId).run();
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    const state = await refreshOwnManifests(deps(fake), tenant, "co-chk", { force: true });
    expect(state.done).toBe(true);
    expect(state.counts.written).toBeUndefined();
    expect(fake.requests).toEqual([]);
  });

  it("fails when the federation has a bucket and an address of whitespace alone", async () => {
    await seed(1);
    await env.DB.prepare("UPDATE federations SET manifest_base_url = '   ' WHERE id = ?").bind(tenant.federationId).run();
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    await expect(refreshOwnManifests(deps(fake), tenant, "co-chk", { force: true })).rejects.toThrow(/manifest_base_url/);
    expect(fake.requests).toEqual([]);
  });

  it("skips with the no-bucket warning when the federation has neither a bucket nor an address", async () => {
    await seed(1);
    await env.DB.prepare("UPDATE federations SET manifest_bucket = NULL, manifest_base_url = NULL WHERE id = ?")
      .bind(tenant.federationId)
      .run();
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = await refreshOwnManifests(deps(fake), tenant, "co-chk", { force: true });
      expect(state.done).toBe(true);
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        "publish: co-chk's own manifests are not refreshed; the federation has no manifest bucket",
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(fake.requests).toEqual([]);
  });

  it("reads padded destination fields trimmed, so a padded secret prefix still writes", async () => {
    await seed(1);
    await env.DB.prepare(
      "UPDATE federations SET storage_secret_prefix = ' TEST_TENANT ', manifest_endpoint = ' ' || manifest_endpoint || ' ', " +
        "manifest_bucket = ' ' || manifest_bucket || ' ' WHERE id = ?",
    ).bind(tenant.federationId).run();
    const fake = fakeS3([TEST_MANIFEST_BUCKET]);
    put(fake, keyOf("co-chk-001"), manifestText("co-chk-001", "Viejo 1", null));
    const state = await refreshOwnManifests(deps(fake), tenant, "co-chk", { force: true });
    expect(state.counts).toEqual({ written: 1 });
    expect(JSON.parse(fake.text(TEST_MANIFEST_BUCKET, keyOf("co-chk-001"))!).label).toEqual({ es: ["Nuevo 1"] });
  });
});

// @version v0.9.0
