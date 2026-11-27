/**
 * Tests — a replayed publish workflow keeps its record counts
 *
 * This suite pins that a replayed publish workflow keeps its record
 * counts. Cloudflare Workflows may run a workflow's `run()` again from the
 * top (after the instance is evicted, or while a step waits for a retry).
 * A step that already completed is not run again: `step.do` returns the
 * result it stored. The workflow's per-step record counts must therefore
 * come from what each step returns, not only from inside its body, or a
 * replay forgets them and the next step writes `record_counts` without
 * them.
 *
 * The suite runs a publish of one fonds with descriptions and
 * repositories for real, keeping each step's stored result, then
 * replays the run: every step returns its stored result without
 * running, except `repositories` and `finalize`, which run again and
 * write the counts. The counts written must be the ones the first run
 * wrote. The first run's step log must hold a start and an end for
 * every step of the plan.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { PublishExportWorkflow } from "../../app/workflows/publish-export";
import { countPublishSteps, planPublishSteps } from "../../app/lib/export/publish-steps";

describe("publish workflow replay", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("keeps every step's record count when completed steps are replayed", async () => {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    const tenant = {
      id: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      slug: "neogranadina",
      descriptiveStandard: "isadg",
    };
    const userId = "u-replay-000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: tenant.id, email: "replay@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const repoId = "00000000-0000-4000-8000-000000000101";
    const rootId = "00000000-0000-4000-8000-000000000110";
    await db.insert(schema.repositories).values({
      id: repoId, tenantId: tenant.id, code: "co-r", name: "Archivo R", enabled: true, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.descriptions).values({
      id: rootId, tenantId: tenant.id, repositoryId: repoId, parentId: null, rootDescriptionId: rootId,
      descriptionLevel: "fonds", referenceCode: "co-r", title: "Fondo R", isPublished: true, childCount: 3,
      createdAt: now, updatedAt: now,
    });
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
       INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, root_description_id, description_level,
         reference_code, title, has_digital, iiif_manifest_url, is_published, created_at, updated_at)
       SELECT printf('00000000-0000-4000-8000-%012d', 2000 + i), ?1, ?2, ?3, ?3, 'file',
         printf('co-r-f%04d', i), 'Expediente ' || i, 1, 'https://iiif.example.org/' || i, 1, ?4, ?4 FROM n`
    ).bind(tenant.id, repoId, rootId, now).run();

    const config = {
      selectedFonds: ["co-r"],
      selectedTypes: ["descriptions", "repositories"],
      publishTenant: tenant,
      memberTenantIds: [tenant.id],
      fondsTenants: { "co-r": tenant },
      authoritiesEnabled: false,
    };
    const exportId = "55555555-5555-4555-8555-eeeeeeeeeeee";
    await db.insert(schema.exportRuns).values({
      id: exportId, triggeredBy: userId, tenantId: tenant.id, status: "running",
      selectedFonds: JSON.stringify(config.selectedFonds), selectedTypes: JSON.stringify(config.selectedTypes),
      stepsCompleted: 0, totalSteps: countPublishSteps(config), createdAt: now,
    });
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = env;
    const event = { payload: { exportId }, timestamp: new Date(now), instanceId: "i" } as any;
    const read = () =>
      env.DB.prepare("SELECT record_counts, step_log FROM export_runs WHERE id = ?")
        .bind(exportId)
        .first<{ record_counts: string; step_log: string | null }>();

    // First run: every step runs; its result is stored as JSON.
    const stored = new Map<string, unknown>();
    await workflow.run(event, {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
        if (name === "load-config") return config;
        const result = await callback();
        const json = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        stored.set(name, json);
        return json;
      },
    } as any);
    const first = await read();
    const firstCounts = JSON.parse(first!.record_counts);
    expect(Object.keys(firstCounts).sort()).toEqual(
      ["children:co-r", "dc:co-r", "descriptions:co-r", "descriptions:index", "ead:co-r", "repositories"],
    );

    // Replay: completed steps return their stored result without running.
    await workflow.run(event, {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
        if (name === "load-config") return config;
        if (name === "repositories" || name === "finalize") return callback();
        return stored.get(name);
      },
    } as any);
    const replayed = await read();
    expect(JSON.parse(replayed!.record_counts)).toEqual(firstCounts);

    // The step log holds a start and an end for every step of the plan.
    const log = JSON.parse(first!.step_log ?? "{}");
    expect(Object.keys(log).sort()).toEqual(planPublishSteps(config).map((s) => s.id).sort());
    for (const entry of Object.values(log) as Array<{ startedAt: number; completedAt: number }>) {
      expect(typeof entry.startedAt).toBe("number");
      expect(entry.completedAt).toBeGreaterThanOrEqual(entry.startedAt);
    }
  });
});

// @version v0.9.0
