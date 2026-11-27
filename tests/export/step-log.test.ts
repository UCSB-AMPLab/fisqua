/**
 * Tests — the publish run's step log
 *
 * This suite pins `export_runs.step_log` (migration 0117), the JSON
 * object of `{planStepId: {startedAt, completedAt}}` that
 * `recordStepStart` and `recordStepEnd` keep for the progress panel's
 * durations. It checks that:
 *
 *   - a step's start and end are written under its plan step id;
 *   - a link file's steps fold into the link file, with the start of
 *     the first step and the end of the last;
 *   - a step started again (a retry, or a replay of the step) keeps
 *     every other step's entry, and clears its own stale end;
 *   - `steps_completed` counts each plan step once: an end written
 *     twice, a step retried after it wrote its end (run 86f25c0c
 *     reported 57 of 56), and a link file's steps, whose finishing
 *     step alone counts, however often it ends;
 *   - each call is still the one UPDATE statement it was, so the log
 *     and the count add no D1 statement or subrequest to a step.
 *
 * `Date.now` is stubbed to a counter so every write has a known time.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { recordStepStart, recordStepEnd } from "../../app/lib/export/pipeline.server";

const RUN = "44444444-4444-4444-8444-dddddddddddd";
const USER = "u-step-log-0000-0000-000000000001";

let clock = 0;
function at(t: number) {
  clock = t;
}

async function stepsCompleted(): Promise<number> {
  const row = await env.DB.prepare("SELECT steps_completed FROM export_runs WHERE id = ?")
    .bind(RUN)
    .first<{ steps_completed: number }>();
  return row!.steps_completed;
}

async function stepLog(): Promise<Record<string, { startedAt?: number; completedAt?: number }>> {
  const row = await env.DB.prepare("SELECT step_log FROM export_runs WHERE id = ?")
    .bind(RUN)
    .first<{ step_log: string | null }>();
  return row?.step_log ? JSON.parse(row.step_log) : {};
}

describe("export_runs.step_log", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const db = drizzle(env.DB, { schema });
    const now = Date.now();
    await db.insert(schema.users).values({
      id: USER, tenantId: DEFAULT_TEST_TENANT_ID, email: "log@example.test", isSuperAdmin: true, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.exportRuns).values({
      id: RUN, triggeredBy: USER, tenantId: DEFAULT_TEST_TENANT_ID, status: "running",
      selectedFonds: JSON.stringify(["co-a"]), selectedTypes: JSON.stringify(["descriptions"]),
      stepsCompleted: 0, totalSteps: 6, createdAt: now,
    });
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is null on a run that has not started a step", async () => {
    const row = await env.DB.prepare("SELECT step_log FROM export_runs WHERE id = ?").bind(RUN).first<{ step_log: string | null }>();
    expect(row!.step_log).toBeNull();
  });

  it("records a step's start and end under its plan step id", async () => {
    const db = drizzle(env.DB);
    at(1000);
    await recordStepStart(db, RUN, "descriptions:co-a");
    expect(await stepLog()).toEqual({ "descriptions:co-a": { startedAt: 1000 } });
    at(4000);
    await recordStepEnd(db, RUN, "descriptions:co-a", { "descriptions:co-a": 3 });
    expect(await stepLog()).toEqual({ "descriptions:co-a": { startedAt: 1000, completedAt: 4000 } });
  });

  it("folds a link file's steps into one entry, from the first step's start to the last's end", async () => {
    const db = drizzle(env.DB);
    at(10_000);
    await recordStepStart(db, RUN, "entity_links:0");
    at(20_000);
    await recordStepStart(db, RUN, "entity_links:1");
    at(30_000);
    await recordStepStart(db, RUN, "entity_links:2");
    at(35_000);
    await recordStepEnd(db, RUN, "entity_links:2", {});
    expect(await stepLog()).toEqual({ entity_links: { startedAt: 10_000, completedAt: 35_000 } });
  });

  it("keeps every other step's entry when a step is started again", async () => {
    const db = drizzle(env.DB);
    at(100);
    await recordStepStart(db, RUN, "descriptions:co-a");
    at(200);
    await recordStepEnd(db, RUN, "descriptions:co-a", {});
    at(300);
    await recordStepStart(db, RUN, "children:co-a");
    at(400);
    await recordStepEnd(db, RUN, "children:co-a", {});
    // children:co-a is retried after it wrote its end.
    at(500);
    await recordStepStart(db, RUN, "children:co-a");
    expect(await stepLog()).toEqual({
      "descriptions:co-a": { startedAt: 100, completedAt: 200 },
      "children:co-a": { startedAt: 500 },
    });
  });

  it("counts a step ended twice as one completed step", async () => {
    const db = drizzle(env.DB);
    at(1);
    await recordStepStart(db, RUN, "descriptions:co-a");
    at(2);
    await recordStepEnd(db, RUN, "descriptions:co-a", {});
    at(3);
    await recordStepEnd(db, RUN, "descriptions:co-a", {});
    expect(await stepsCompleted()).toBe(1);
  });

  it("counts a step retried after it wrote its end once", async () => {
    const db = drizzle(env.DB);
    at(1);
    await recordStepStart(db, RUN, "descriptions:co-a");
    at(2);
    await recordStepEnd(db, RUN, "descriptions:co-a", {});
    expect(await stepsCompleted()).toBe(1);
    // The step fails after its end and is retried: while the retry runs
    // the step is not complete, and its end counts it again once.
    at(3);
    await recordStepStart(db, RUN, "descriptions:co-a");
    expect(await stepsCompleted()).toBe(0);
    at(4);
    await recordStepEnd(db, RUN, "descriptions:co-a", {});
    expect(await stepsCompleted()).toBe(1);
  });

  it("counts a link file's steps once, when the finishing step ends, however often it ends", async () => {
    const db = drizzle(env.DB);
    at(1);
    await recordStepStart(db, RUN, "entity_links:0");
    at(2);
    await recordStepStart(db, RUN, "entity_links:1");
    expect(await stepsCompleted()).toBe(0);
    at(3);
    await recordStepEnd(db, RUN, "entity_links:1", {});
    expect(await stepsCompleted()).toBe(1);
    // The finishing step is retried after its end.
    at(4);
    await recordStepStart(db, RUN, "entity_links:1");
    at(5);
    await recordStepEnd(db, RUN, "entity_links:1", {});
    await recordStepEnd(db, RUN, "entity_links:1", {});
    expect(await stepsCompleted()).toBe(1);
  });

  it("counts a link file finished by its first step once when that step is retried", async () => {
    const db = drizzle(env.DB);
    at(1);
    await recordStepStart(db, RUN, "entity_links:0");
    await recordStepEnd(db, RUN, "entity_links:0", {});
    at(2);
    await recordStepStart(db, RUN, "entity_links:0");
    await recordStepEnd(db, RUN, "entity_links:0", {});
    expect(await stepsCompleted()).toBe(1);
  });

  it("counts each step once across a run with a retried step", async () => {
    const db = drizzle(env.DB);
    for (const [i, step] of ["descriptions:co-a", "children:co-a", "entity_links:0", "ead:co-a"].entries()) {
      at(10 * i + 1);
      await recordStepStart(db, RUN, step);
      await recordStepEnd(db, RUN, step, {});
    }
    at(100);
    await recordStepStart(db, RUN, "ead:co-a");
    await recordStepEnd(db, RUN, "ead:co-a", {});
    expect(await stepsCompleted()).toBe(4);
  });

  it("adds no statement to a step: each call is one UPDATE", async () => {
    const statements: string[] = [];
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (q: string) => {
            statements.push(q);
            return target.prepare(q);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const db = drizzle(counting as D1Database);
    at(1);
    await recordStepStart(db, RUN, "entity_links:0");
    await recordStepStart(db, RUN, "entity_links:1");
    await recordStepEnd(db, RUN, "entity_links:1", {});
    expect(statements).toHaveLength(3);
    expect(statements.every((q) => /^update "export_runs"/.test(q))).toBe(true);
  });
});

// @version v0.9.0
