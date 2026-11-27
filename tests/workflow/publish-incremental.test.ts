/**
 * Tests — the publish workflow skips unchanged fonds
 *
 * This suite drives `PublishExportWorkflow.run` with a stand-in for the
 * Workflow step that runs every step body for real, over one fonds,
 * three times. The first run writes every per-fonds file. The second,
 * with nothing changed, skips the fonds' four steps: it still records
 * each step's start and end, so `steps_completed` reaches
 * `total_steps`, the record counts keep each step's count, list the
 * skipped steps under `skipped`, and the descriptions index keeps the
 * fonds' record count. The progress panel reads those counts without
 * error. The third, started with `force: true`, runs every step.
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
import { countPublishSteps } from "../../app/lib/export/publish-steps";
import { deriveStepGroups } from "../../app/components/publish/export-progress";

const FONDS = "co-inc";
const PER_FONDS = ["descriptions", "children", "ead", "dc"].map((k) => `${k}:${FONDS}`);

describe("publish workflow skips an unchanged fonds", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("skips the fonds' steps on a second run, keeps the counts, and runs them all when forced", async () => {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    const tenant = {
      id: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      slug: "neogranadina",
      descriptiveStandard: "isadg",
    };
    const userId = "u-incr-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: tenant.id, email: "incr@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const repoId = "00000000-0000-4000-8000-000000000301";
    const rootId = "00000000-0000-4000-8000-000000000310";
    await db.insert(schema.repositories).values({
      id: repoId, tenantId: tenant.id, code: "co-inc-repo", name: "Archivo I", enabled: true, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.descriptions).values({
      id: rootId, tenantId: tenant.id, repositoryId: repoId, parentId: null, rootDescriptionId: rootId,
      descriptionLevel: "fonds", referenceCode: FONDS, title: "Fondo I", isPublished: true, childCount: 4,
      createdAt: now, updatedAt: now,
    });
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4)
       INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, root_description_id, description_level,
         reference_code, title, is_published, position, created_at, updated_at)
       SELECT printf('00000000-0000-4000-8000-%012d', 3000 + i), ?1, ?2, ?3, ?3, 'file',
         printf('co-inc-f%04d', i), 'Expediente ' || i, 1, i, ?4, ?4 FROM n`
    ).bind(tenant.id, repoId, rootId, now).run();

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
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = env;

    async function publish(exportId: string, force?: boolean) {
      await db.insert(schema.exportRuns).values({
        id: exportId, triggeredBy: userId, tenantId: tenant.id, status: "running",
        selectedFonds: JSON.stringify(config.selectedFonds), selectedTypes: JSON.stringify(config.selectedTypes),
        stepsCompleted: 0, totalSteps, createdAt: now,
      });
      await workflow.run(
        { payload: force === undefined ? { exportId } : { exportId, force }, timestamp: new Date(), instanceId: "i" } as any,
        step as any
      );
      const run = await env.DB.prepare(
        `SELECT id, status, selected_fonds AS selectedFonds, selected_types AS selectedTypes, current_step AS currentStep,
           steps_completed AS stepsCompleted, total_steps AS totalSteps, record_counts AS recordCounts,
           step_log AS stepLog, current_step_completed_at AS currentStepCompletedAt
         FROM export_runs WHERE id = ?`
      ).bind(exportId).first<any>();
      const index = await env.EXPORT_BUCKET.get(`${tenant.slug}/descriptions-index.json`);
      return { run, counts: JSON.parse(run.recordCounts), index: JSON.parse(await index!.text()) };
    }

    const first = await publish("44444444-4444-4444-8444-000000000001");
    expect(first.run.status).toBe("complete");
    expect(first.counts.skipped).toBeUndefined();

    const second = await publish("44444444-4444-4444-8444-000000000002");
    expect(second.run.status).toBe("complete");
    expect(second.run.stepsCompleted).toBe(totalSteps);
    expect([...second.counts.skipped].sort()).toEqual([...PER_FONDS].sort());
    for (const id of [...PER_FONDS, "descriptions:index"]) expect(second.counts[id]).toBe(first.counts[id]);
    expect(second.counts[`descriptions:${FONDS}`]).toBe(5);
    const { generated_at: _a, ...firstIndex } = first.index;
    const { generated_at: _b, ...secondIndex } = second.index;
    expect(secondIndex).toEqual(firstIndex);
    expect(Object.keys(JSON.parse(second.run.stepLog)).sort()).toEqual(
      Object.keys(JSON.parse(first.run.stepLog)).sort()
    );
    const groups = deriveStepGroups(second.run);
    expect(groups.every((g) => g.state === "completed")).toBe(true);
    expect(groups.find((g) => g.kind === "descriptions")!.rows[0].count).toBe(5);

    const forced = await publish("44444444-4444-4444-8444-000000000003", true);
    expect(forced.run.status).toBe("complete");
    expect(forced.counts.skipped).toBeUndefined();
    expect(forced.run.stepsCompleted).toBe(totalSteps);
  });
});

// @version v0.9.0
