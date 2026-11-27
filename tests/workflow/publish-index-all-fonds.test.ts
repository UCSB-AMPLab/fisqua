/**
 * Tests — the descriptions index lists every published fonds
 *
 * This suite drives `PublishExportWorkflow.run` with a stand-in for the
 * Workflow step that runs every step body for real, against D1 and the
 * export bucket, over a tenant of three fonds. zasqua.org builds only
 * the fonds `descriptions-index.json` lists, so a publish of some fonds
 * must keep the others in it.
 *
 * A publish of all three writes the index from scratch. A publish of
 * one keeps the other two with their stored counts, and the total is
 * the sum. A fonds whose root description is unpublished leaves the
 * index on the next publish. When the stored index is missing or cannot
 * be parsed, a publish of one fonds fails the run with a reason naming
 * the index, and the index is left as it was; so does a stored index
 * that leaves out a published fonds whose file is in storage, with a
 * reason naming the fonds. A publish of every
 * published fonds rebuilds it.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { PublishExportWorkflow } from "../../app/workflows/publish-export";
import { countPublishSteps } from "../../app/lib/export/publish-steps";

const FONDS = ["co-ixa", "co-ixb", "co-ixc"];
// Records per fonds: the root and its files.
const FILES = { "co-ixa": 1, "co-ixb": 2, "co-ixc": 3 } as Record<string, number>;

describe("the descriptions index lists every published fonds", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("keeps unselected fonds, drops unpublished ones, and refuses an unreadable stored index", async () => {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    const tenant = {
      id: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      slug: "neogranadina",
      descriptiveStandard: "isadg",
    };
    const indexKey = `${tenant.slug}/descriptions-index.json`;
    const userId = "u-index-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: tenant.id, email: "index@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const repoId = "00000000-0000-4000-8000-000000000401";
    await db.insert(schema.repositories).values({
      id: repoId, tenantId: tenant.id, code: "co-ix-repo", name: "Archivo X", enabled: true, createdAt: now, updatedAt: now,
    });
    const rootIds: Record<string, string> = {};
    for (const [n, code] of FONDS.entries()) {
      const rootId = `00000000-0000-4000-8000-00000000041${n}`;
      rootIds[code] = rootId;
      await db.insert(schema.descriptions).values({
        id: rootId, tenantId: tenant.id, repositoryId: repoId, parentId: null, rootDescriptionId: rootId,
        descriptionLevel: "fonds", referenceCode: code, title: `Fondo ${code}`, isPublished: true,
        childCount: FILES[code], createdAt: now, updatedAt: now,
      });
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?5)
         INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, root_description_id, description_level,
           reference_code, title, is_published, position, created_at, updated_at)
         SELECT printf('00000000-0000-4000-8000-%012d', ?6 + i), ?1, ?2, ?3, ?3, 'file',
           ?7 || printf('-f%04d', i), 'Expediente ' || i, 1, i, ?4, ?4 FROM n`
      ).bind(tenant.id, repoId, rootId, now, FILES[code], 4000 + 100 * n, code).run();
    }

    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = env;

    let runNo = 0;
    async function publish(selectedFonds: string[]) {
      const config = {
        selectedFonds,
        selectedTypes: ["descriptions"],
        publishTenant: tenant,
        memberTenantIds: [tenant.id],
        fondsTenants: Object.fromEntries(selectedFonds.map((f) => [f, tenant])),
        authoritiesEnabled: false,
      };
      const step = {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          if (name === "load-config") return config;
          const result = await callback();
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
      };
      const exportId = `55555555-5555-4555-8555-00000000000${++runNo}`;
      await db.insert(schema.exportRuns).values({
        id: exportId, triggeredBy: userId, tenantId: tenant.id, status: "running",
        selectedFonds: JSON.stringify(selectedFonds), selectedTypes: JSON.stringify(config.selectedTypes),
        stepsCompleted: 0, totalSteps: countPublishSteps(config), createdAt: now,
      });
      let thrown: unknown;
      try {
        await workflow.run({ payload: { exportId }, timestamp: new Date(), instanceId: "i" } as any, step as any);
      } catch (err) {
        thrown = err;
      }
      const run = await env.DB.prepare(
        `SELECT status, error_message AS errorMessage FROM export_runs WHERE id = ?`
      ).bind(exportId).first<{ status: string; errorMessage: string | null }>();
      const stored = await env.EXPORT_BUCKET.get(indexKey);
      const text = stored ? await stored.text() : null;
      return { run: run!, thrown, text };
    }
    const entriesOf = (text: string | null) =>
      (JSON.parse(text!) as { fonds: Array<{ fonds_code: string; record_count: number }> }).fonds.map(
        (e) => [e.fonds_code, e.record_count]
      );

    // A full publish builds the index from scratch.
    const full = await publish(FONDS);
    expect(full.run.status).toBe("complete");
    expect(entriesOf(full.text)).toEqual([["co-ixa", 2], ["co-ixb", 3], ["co-ixc", 4]]);
    expect(JSON.parse(full.text!).total_record_count).toBe(9);

    // A publish of one fonds keeps the other two with their stored counts.
    const one = await publish(["co-ixb"]);
    expect(one.run.status).toBe("complete");
    expect(entriesOf(one.text)).toEqual([["co-ixa", 2], ["co-ixb", 3], ["co-ixc", 4]]);
    expect(JSON.parse(one.text!).total_record_count).toBe(9);

    // An unpublished fonds leaves the index on the next publish.
    await db.update(schema.descriptions).set({ isPublished: false }).where(eq(schema.descriptions.id, rootIds["co-ixc"]));
    const dropped = await publish(["co-ixa"]);
    expect(dropped.run.status).toBe("complete");
    expect(entriesOf(dropped.text)).toEqual([["co-ixa", 2], ["co-ixb", 3]]);
    expect(JSON.parse(dropped.text!).total_record_count).toBe(5);

    // A stored index that leaves out a published fonds whose file is in
    // storage fails a publish of one fonds and stays as it was.
    const partial = JSON.stringify({
      version: 1, generated_at: new Date(now).toISOString(), total_record_count: 2,
      fonds: [{ fonds_code: "co-ixa", key: "neogranadina/descriptions-co-ixa.json", record_count: 2 }],
    });
    await env.EXPORT_BUCKET.put(indexKey, partial);
    const unlisted = await publish(["co-ixa"]);
    expect(unlisted.run.status).toBe("error");
    expect(unlisted.run.errorMessage).toContain("co-ixb");
    expect(unlisted.run.errorMessage).toContain("full publish");
    expect(unlisted.text).toBe(partial);

    // An unparseable stored index fails a publish of one fonds and stays as it was.
    await env.EXPORT_BUCKET.put(indexKey, "{ not json");
    const unparseable = await publish(["co-ixa"]);
    expect(unparseable.thrown).toBeInstanceOf(Error);
    expect(unparseable.run.status).toBe("error");
    expect(unparseable.run.errorMessage).toContain(indexKey);
    expect(unparseable.text).toBe("{ not json");

    // A missing stored index fails a publish of one fonds and none is written.
    await env.EXPORT_BUCKET.delete(indexKey);
    const missing = await publish(["co-ixa"]);
    expect(missing.run.status).toBe("error");
    expect(missing.run.errorMessage).toContain(indexKey);
    expect(missing.text).toBeNull();

    // A publish of every published fonds rebuilds it. (A fonds whose root
    // is unpublished cannot be selected: its EAD3 step has no root.)
    const rebuilt = await publish(["co-ixa", "co-ixb"]);
    expect(rebuilt.run.errorMessage).toBeNull();
    expect(rebuilt.run.status).toBe("complete");
    expect(entriesOf(rebuilt.text)).toEqual([["co-ixa", 2], ["co-ixb", 3]]);
  });
});

// @version v0.9.0
