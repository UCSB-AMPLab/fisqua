/**
 * Tests — publish workflow step configuration
 *
 * This suite pins the retry configuration of the fonds descriptions
 * steps. A descriptions step refuses to complete a fonds' file when the
 * fonds changes while the file is written, and relies on the Workflow
 * to try the step again, so each `descriptions:<fonds>` step must be
 * given `DESCRIPTIONS_STEP_CONFIG`.
 *
 * The workflow's `run` is driven with a stand-in for the Workflow
 * step: `load-config` returns a fixed config, the first descriptions
 * step records the config it was given and stops the run, and the
 * failure path's own steps do nothing.
 *
 * A run over a fonds of digitised descriptions, with every step run
 * for real, takes the fonds' four steps (descriptions, children, EAD3,
 * Dublin Core) and the index, so `steps_completed` reaches the
 * `total_steps` that `countPublishSteps` gives. It takes no METS step,
 * records no METS count and never reads a METS bucket from the
 * environment: the site's engine writes the METS files.
 *
 * The workflow walks the current plan and nothing else, whatever the
 * run's `total_steps`: a run of two fonds with descriptions and
 * entities, counted with the authorities capability and published
 * after the capability was turned off, takes exactly the current plan
 * without it, with no METS step, and `load-config` returns no field
 * that chooses another plan. The fonds' own-manifest steps
 * (`manifests:{fonds}:{n}`), which are not in the plan, are left out of
 * that comparison.
 *
 * When the run fails and the run row cannot be written either (as when
 * the invocation has used up its subrequests), the error re-thrown is
 * the one that ended the run, not the failed write's. The write that
 * marks the run failed is its own step, `record-failure`, given
 * `RECORD_FAILURE_STEP_CONFIG`: when D1 refuses the first attempts as
 * overloaded, a later attempt marks the run failed, so the row does not
 * stay `running` and block the next publish.
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
import {
  PublishExportWorkflow,
  DESCRIPTIONS_STEP_CONFIG,
  RECORD_FAILURE_STEP_CONFIG,
} from "../../app/workflows/publish-export";
import { countPublishSteps, planPublishSteps, planStepIdOf } from "../../app/lib/export/publish-steps";

class Stop extends Error {}

describe("publish workflow step configuration", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("passes DESCRIPTIONS_STEP_CONFIG to every fonds descriptions step", async () => {
    const calls: Array<{ name: string; config: unknown }> = [];
    const tenant = { id: "t", federationId: "f", slug: "s", descriptiveStandard: "isadg" };
    const step = {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
        calls.push({ name, config });
        if (name === "load-config") {
          return {
            selectedFonds: ["co-a", "co-b"],
            selectedTypes: ["descriptions"],
            publishTenant: tenant,
            memberTenantIds: ["t"],
            fondsTenants: { "co-a": tenant, "co-b": tenant },
            authoritiesEnabled: false,
          };
        }
        if (name === "descriptions:co-b") throw new Stop();
        if (name.startsWith("descriptions:")) return { recordCount: 0, byteSize: 2 };
        return undefined;
      },
    };
    // The entrypoint's constructor needs a live context; run() needs only env.
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = env;

    await expect(
      workflow.run({ payload: { exportId: "no-such-run" }, timestamp: new Date(), instanceId: "i" } as any, step as any)
    ).rejects.toBeInstanceOf(Stop);

    const descriptionSteps = calls.filter((c) => c.name.startsWith("descriptions:"));
    expect(descriptionSteps.map((c) => c.name)).toEqual(["descriptions:co-a", "descriptions:co-b"]);
    for (const c of descriptionSteps) expect(c.config).toBe(DESCRIPTIONS_STEP_CONFIG);
    expect(DESCRIPTIONS_STEP_CONFIG.retries.limit).toBeGreaterThan(0);
  });
});

describe("publish workflow failure path", () => {
  it("re-throws the step's error when the run row cannot be written", async () => {
    const tenant = { id: "t", federationId: "f", slug: "s", descriptiveStandard: "isadg" };
    const step = {
      async do(name: string) {
        if (name === "load-config") {
          return {
            selectedFonds: ["co-a"],
            selectedTypes: ["descriptions"],
            publishTenant: tenant,
            memberTenantIds: ["t"],
            fondsTenants: { "co-a": tenant },
            authoritiesEnabled: false,
          };
        }
        if (name.startsWith("descriptions:")) throw new Stop();
        return undefined;
      },
    };
    const failingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (q: string) => {
            if (/^update "export_runs"/.test(q)) throw new Error("Too many API requests by single Worker invocation");
            return target.prepare(q);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = { ...env, DB: failingDb };
    await expect(
      workflow.run({ payload: { exportId: "no-such-run" }, timestamp: new Date(), instanceId: "i" } as any, step as any)
    ).rejects.toBeInstanceOf(Stop);
  });

  it("marks the run failed once D1 accepts the write, when it refused the first attempts as overloaded", async () => {
    await applyMigrations();
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    const userId = "u-fail-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: DEFAULT_TEST_TENANT_ID, email: "fail@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const exportId = "44444444-4444-4444-8444-dddddddddddd";
    await db.insert(schema.exportRuns).values({
      id: exportId, triggeredBy: userId, tenantId: DEFAULT_TEST_TENANT_ID, status: "running",
      selectedFonds: JSON.stringify(["co-a"]), selectedTypes: JSON.stringify(["descriptions"]),
      stepsCompleted: 0, totalSteps: 5, createdAt: now,
    });

    const tenant = { id: "t", federationId: "f", slug: "s", descriptiveStandard: "isadg" };
    const configs: Record<string, unknown> = {};
    // A stand-in for Workflows' durable step retries: a step that throws
    // is run again, up to its config's retry limit.
    const step = {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const config = typeof configOrCallback === "function" ? undefined : (configOrCallback as any);
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
        configs[name] = config;
        if (name === "load-config") {
          return {
            selectedFonds: ["co-a"],
            selectedTypes: ["descriptions"],
            publishTenant: tenant,
            memberTenantIds: ["t"],
            fondsTenants: { "co-a": tenant },
            authoritiesEnabled: false,
          };
        }
        if (name.startsWith("descriptions:")) throw new Stop();
        const limit = config?.retries?.limit ?? 0;
        for (let attempt = 0; ; attempt++) {
          try {
            return await callback();
          } catch (err) {
            if (attempt >= limit) throw err;
          }
        }
      },
    };
    // D1 refuses the first three writes to the run as overloaded.
    let refusals = 3;
    const overloadedDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (q: string) => {
            if (/^update "export_runs"/.test(q) && refusals > 0) {
              refusals--;
              throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long. (7429)");
            }
            return target.prepare(q);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = { ...env, DB: overloadedDb };

    await expect(
      workflow.run({ payload: { exportId }, timestamp: new Date(), instanceId: "i" } as any, step as any)
    ).rejects.toBeInstanceOf(Stop);

    expect(refusals).toBe(0);
    const run = await env.DB.prepare("SELECT status, completed_at FROM export_runs WHERE id = ?")
      .bind(exportId)
      .first<{ status: string; completed_at: number | null }>();
    expect(run!.status).toBe("error");
    expect(run!.completed_at).not.toBeNull();
    expect(configs["record-failure"]).toBe(RECORD_FAILURE_STEP_CONFIG);
  });
});

describe("publish workflow without METS", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("publishes a fonds of digitised descriptions without a METS step or a METS bucket", async () => {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    const tenant = {
      id: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      slug: "neogranadina",
      descriptiveStandard: "isadg",
    };
    const userId = "u-mets-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId: tenant.id, email: "mets@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const repoId = "00000000-0000-4000-8000-000000000001";
    const rootId = "00000000-0000-4000-8000-000000000010";
    await db.insert(schema.repositories).values({
      id: repoId, tenantId: tenant.id, code: "co-m", name: "Archivo M", enabled: true, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.descriptions).values({
      id: rootId, tenantId: tenant.id, repositoryId: repoId, parentId: null, rootDescriptionId: rootId,
      descriptionLevel: "fonds", referenceCode: "co-m", title: "Fondo M", isPublished: true, childCount: 5,
      createdAt: now, updatedAt: now,
    });
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
       INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, root_description_id, description_level,
         reference_code, title, has_digital, iiif_manifest_url, is_published, created_at, updated_at)
       SELECT printf('00000000-0000-4000-8000-%012d', 1000 + i), ?1, ?2, ?3, ?3, 'file',
         printf('co-m-f%04d', i), 'Expediente ' || i, 1, 'https://iiif.example.org/' || i, 1, ?4, ?4 FROM n`
    ).bind(tenant.id, repoId, rootId, now).run();

    const config = {
      selectedFonds: ["co-m"],
      selectedTypes: ["descriptions"],
      publishTenant: tenant,
      memberTenantIds: [tenant.id],
      fondsTenants: { "co-m": tenant },
      authoritiesEnabled: false,
    };
    const totalSteps = countPublishSteps(config);
    expect(totalSteps).toBe(5);
    const exportId = "33333333-3333-4333-8333-cccccccccccc";
    await db.insert(schema.exportRuns).values({
      id: exportId, triggeredBy: userId, tenantId: tenant.id, status: "running",
      selectedFonds: JSON.stringify(config.selectedFonds), selectedTypes: JSON.stringify(config.selectedTypes),
      stepsCompleted: 0, totalSteps, createdAt: now,
    });

    const names: string[] = [];
    const step = {
      async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
        names.push(name);
        if (name === "load-config") return config;
        const result = await callback();
        // Workflows keep a step's result as JSON.
        return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      },
    };
    // Records any read of a METS bucket from the environment.
    let metsBucketRead = false;
    const workflowEnv = { ...env } as Record<string, unknown>;
    Object.defineProperty(workflowEnv, "METS_BUCKET", {
      get() {
        metsBucketRead = true;
        return { async put() { return {}; } };
      },
    });
    const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
    (workflow as any).env = workflowEnv;

    await workflow.run({ payload: { exportId }, timestamp: new Date(), instanceId: "i" } as any, step as any);

    expect(names.filter((n) => n.startsWith("mets:"))).toEqual([]);
    expect(metsBucketRead).toBe(false);

    const run = await env.DB.prepare(
      "SELECT status, steps_completed, total_steps, record_counts FROM export_runs WHERE id = ?"
    ).bind(exportId).first<{ status: string; steps_completed: number; total_steps: number; record_counts: string }>();
    expect(run!.status).toBe("complete");
    expect(run!.steps_completed).toBe(run!.total_steps);
    expect(Object.keys(JSON.parse(run!.record_counts)).filter((k) => k.startsWith("mets:"))).toEqual([]);
  });
});

describe("publish workflow walks only the current plan", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("runs the current plan when the authorities capability changed after the run was counted", async () => {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const userId = "u-plan-0000-0000-0000-000000000001";
    await db.insert(schema.users).values({
      id: userId, tenantId, email: "plan@example.com", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    const repoId = "00000000-0000-4000-8000-000000000002";
    await db.insert(schema.repositories).values({
      id: repoId, tenantId, code: "co-p", name: "Archivo P", enabled: true, createdAt: now, updatedAt: now,
    });
    const fonds = ["co-p1", "co-p2"];
    for (const [i, code] of fonds.entries()) {
      const rootId = `00000000-0000-4000-8000-00000000002${i}`;
      await db.insert(schema.descriptions).values({
        id: rootId, tenantId, repositoryId: repoId, parentId: null, rootDescriptionId: rootId,
        descriptionLevel: "fonds", referenceCode: code, title: `Fondo ${code}`, isPublished: true,
        createdAt: now, updatedAt: now,
      });
    }
    const selectedTypes = ["descriptions", "entities"];
    // Counted with the capability: eleven steps, the length the plan
    // with METS steps had without it.
    const totalSteps = countPublishSteps({ selectedFonds: fonds, selectedTypes, authoritiesEnabled: true });
    expect(totalSteps).toBe(11);
    const exportId = "33333333-3333-4333-8333-eeeeeeeeeeee";
    await db.insert(schema.exportRuns).values({
      id: exportId, triggeredBy: userId, tenantId, status: "pending",
      selectedFonds: JSON.stringify(fonds), selectedTypes: JSON.stringify(selectedTypes),
      stepsCompleted: 0, totalSteps, createdAt: now,
    });
    await env.DB.prepare("UPDATE tenants SET authorities_enabled = 0 WHERE id = ?").bind(tenantId).run();

    try {
      const names: string[] = [];
      let loaded: Record<string, unknown> | undefined;
      const step = {
        async do(name: string, configOrCallback: unknown, maybeCallback?: unknown) {
          const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as () => Promise<unknown>;
          names.push(name);
          const result = await callback();
          const json = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
          if (name === "load-config") loaded = json;
          return json;
        },
      };
      const workflow = Object.create(PublishExportWorkflow.prototype) as PublishExportWorkflow;
      (workflow as any).env = env;
      await workflow.run({ payload: { exportId }, timestamp: new Date(), instanceId: "i" } as any, step as any);

      expect(loaded).toBeDefined();
      expect(loaded).not.toHaveProperty("legacyMetsPlan");
      expect(names.filter((n) => n.startsWith("mets:"))).toEqual([]);
      const folded: string[] = [];
      for (const name of names) {
        if (name === "load-config" || name === "institution" || name === "finalize") continue;
        // A fonds' own-manifest steps run before its descriptions step and are not in the plan.
        if (name.startsWith("manifests:")) continue;
        const id = planStepIdOf(name);
        if (folded[folded.length - 1] !== id) folded.push(id);
      }
      expect(folded).toEqual(
        planPublishSteps({ selectedFonds: fonds, selectedTypes, authoritiesEnabled: false }).map((s) => s.id),
      );
      const run = await env.DB.prepare("SELECT status FROM export_runs WHERE id = ?").bind(exportId).first<{ status: string }>();
      expect(run!.status).toBe("complete");
    } finally {
      await env.DB.prepare("UPDATE tenants SET authorities_enabled = 1 WHERE id = ?").bind(tenantId).run();
    }
  });
});

// @version v0.9.0
