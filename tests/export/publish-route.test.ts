/**
 * Tests — publish route schema + auth gate
 *
 * This suite pins the request-shape validation and authorisation
 * gate behind the `api.publish` route. The route's
 * `PublishRequestSchema` is built dynamically at runtime against the
 * DB-derived fonds list, so this file rebuilds an equivalent schema
 * with a sample list and exercises the same constraints: a publish
 * request must name at least one selected fonds, every fonds must
 * exist in the tenant's fonds list, and the `types` array must be
 * a subset of the four export kinds (`descriptions`, `repositories`,
 * `entities`, `places`).
 *
 * The auth gate is exercised through `requireSuperAdmin` — only a
 * superadmin can trigger a publish run, because the action writes
 * to R2 (the public CDN bucket) and a misfire would push the wrong
 * tenant's data live.
 *
 * The run's step count (`countPublishSteps`, stored as `total_steps`)
 * must match what the workflow runs: with the authorities capability
 * off, entities, places and their two link files are not counted.
 *
 * The action allows one publish in flight per tenant: a second POST
 * while a run of the same tenant is pending or running, and has
 * written a heartbeat within the staleness window, gets a 409 and
 * creates neither a row nor a workflow. A run past the window, a
 * finished or failed run, and another tenant's running publish do not
 * block.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { tenantContext, userContext } from "../../app/context";
import {
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import {
  action as publishAction,
  PUBLISH_STALE_AFTER_MS,
} from "../../app/routes/api.publish";
import { requireSuperAdmin } from "../../app/lib/superadmin.server";
import { countPublishSteps } from "../../app/lib/export/publish-steps";

/**
 * Recreate the PublishRequestSchema from api.publish.tsx — the original
 * is module-scoped and built dynamically from DB-derived fonds list,
 * so we rebuild it with a sample list to validate the same constraints.
 */
const VALID_TYPES = [
  "descriptions",
  "repositories",
  "entities",
  "places",
] as const;

// Simulates the DB-derived fonds list that the route fetches at runtime
const SAMPLE_FONDS = ["co-ahr-gob", "co-ahr-not", "pe-bn-man"];

const PublishRequestSchema = z.object({
  selectedFonds: z
    .array(
      z.string().refine((val) => SAMPLE_FONDS.includes(val), {
        message: "Invalid fonds code",
      })
    )
    .nonempty("selectedFonds must contain at least one fonds code"),
  selectedTypes: z
    .array(z.enum(VALID_TYPES))
    .nonempty("selectedTypes must contain at least one type"),
});

describe("requireSuperAdmin", () => {
  it("throws redirect for non-superadmin user", () => {
    const user = { id: "u1", isSuperAdmin: false, isAdmin: true };
    expect(() => requireSuperAdmin(user)).toThrow();
  });

  it("does not throw for superadmin user", () => {
    const user = { id: "u2", isSuperAdmin: true, isAdmin: true };
    expect(() => requireSuperAdmin(user)).not.toThrow();
  });
});

describe("PublishRequestSchema", () => {
  it("accepts valid input with known fonds and types", () => {
    const input = {
      selectedFonds: ["co-ahr-gob"],
      selectedTypes: ["descriptions"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts all sample fonds and all types", () => {
    const input = {
      selectedFonds: [...SAMPLE_FONDS],
      selectedTypes: [...VALID_TYPES],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects invalid fonds code", () => {
    const input = {
      selectedFonds: ["invalid-fonds"],
      selectedTypes: ["descriptions"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects empty selectedFonds array", () => {
    const input = {
      selectedFonds: [],
      selectedTypes: ["descriptions"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects empty selectedTypes array", () => {
    const input = {
      selectedFonds: ["co-ahr-gob"],
      selectedTypes: [],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects invalid type", () => {
    const input = {
      selectedFonds: ["co-ahr-gob"],
      selectedTypes: ["invalid-type"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("countPublishSteps", () => {
  const selectedFonds = ["co-ahr-gob", "co-ahr-not"];
  const allTypes = [...VALID_TYPES];

  it("counts entities, places and both link files with authorities on", () => {
    // 2 fonds x 5 + index, repositories, entities, places, two link files.
    expect(
      countPublishSteps({ selectedFonds, selectedTypes: allTypes, authoritiesEnabled: true })
    ).toBe(11 + 1 + 2 + 2);
  });

  it("leaves out entities, places and both link files with authorities off", () => {
    expect(
      countPublishSteps({ selectedFonds, selectedTypes: allTypes, authoritiesEnabled: false })
    ).toBe(11 + 1);
  });

  it("counts nothing for authority types alone with authorities off", () => {
    expect(
      countPublishSteps({
        selectedFonds,
        selectedTypes: ["entities", "places"],
        authoritiesEnabled: false,
      })
    ).toBe(0);
    expect(
      countPublishSteps({
        selectedFonds,
        selectedTypes: ["entities"],
        authoritiesEnabled: true,
      })
    ).toBe(2);
  });
});

describe("POST /api/publish: one publish in flight per tenant", () => {
  const NEO_USER = "u-neo-0000-0000-0000-000000000001";
  const SECOND_USER = "u-sec-0000-0000-0000-000000000002";
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    const now = Date.now();
    await db.insert(schema.users).values([
      {
        id: NEO_USER,
        tenantId: DEFAULT_TEST_TENANT_ID,
        email: "neo-superadmin@example.com",
        isAdmin: true,
        isSuperAdmin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: SECOND_USER,
        tenantId: SECOND_TEST_TENANT_ID,
        email: "second-superadmin@example.com",
        isAdmin: true,
        isSuperAdmin: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const repoId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: repoId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      code: "neo-repo",
      name: "Neogranadina Repo",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      id: descId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: repoId,
      parentId: null,
      rootDescriptionId: descId,
      descriptionLevel: "fonds",
      referenceCode: "co-neo-fonds",
      localIdentifier: "NEO-001",
      title: "Neogranadina Fonds",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  /** Seed an existing run of the given user; times default to now. */
  async function seedRun(
    triggeredBy: string,
    status: "pending" | "running" | "complete" | "error",
    times: { createdAt?: number; startedAt?: number | null; lastHeartbeatAt?: number | null } = {}
  ) {
    const now = Date.now();
    const id = crypto.randomUUID();
    await db.insert(schema.exportRuns).values({
      id,
      triggeredBy,
      status,
      selectedFonds: JSON.stringify(["co-neo-fonds"]),
      selectedTypes: JSON.stringify(["descriptions"]),
      stepsCompleted: 0,
      totalSteps: 6,
      createdAt: times.createdAt ?? now,
      startedAt: times.startedAt === undefined ? now : times.startedAt,
      lastHeartbeatAt: times.lastHeartbeatAt === undefined ? now : times.lastHeartbeatAt,
    });
    return id;
  }

  /** Call the action as Neogranadina's superadmin; records workflow creates. */
  async function postPublish() {
    const created: Array<{ id: string }> = [];
    const pending: Promise<unknown>[] = [];
    const ctx = new RouterContextProvider();
    ctx.set(
      userContext,
      makeUserContext({ id: NEO_USER, tenantId: DEFAULT_TEST_TENANT_ID, isSuperAdmin: true, isAdmin: true })
    );
    ctx.set(tenantContext, makeTenantContext({ id: DEFAULT_TEST_TENANT_ID }));
    (ctx as any).cloudflare = {
      env: {
        DB: env.DB,
        PUBLISH_EXPORT: {
          create: async (opts: { id: string }) => {
            created.push(opts);
            return {};
          },
        },
      },
      ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
    };
    const response = await publishAction({
      request: new Request("https://example.com/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedFonds: ["co-neo-fonds"], selectedTypes: ["descriptions"] }),
      }),
      context: ctx,
      params: {},
    } as any);
    await Promise.all(pending);
    return { response, created };
  }

  async function runCount() {
    return (await db.select().from(schema.exportRuns).all()).length;
  }

  it("starts a publish when the tenant has none in flight", async () => {
    const { response, created } = await postPublish();
    expect(response.status).toBe(202);
    const { exportId } = (await response.json()) as { exportId: string };
    expect(created.map((c) => c.id)).toEqual([exportId]);
    const row = await db.select().from(schema.exportRuns).get();
    expect(row?.id).toBe(exportId);
    expect(row?.status).toBe("pending");
    expect(row?.triggeredBy).toBe(NEO_USER);
  });

  it("refuses a second publish with 409 while one is running", async () => {
    await seedRun(NEO_USER, "running");
    const { response, created } = await postPublish();
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/in progress/);
    expect(created).toEqual([]);
    expect(await runCount()).toBe(1);
  });

  it("refuses a second publish while one is pending and has no heartbeat yet", async () => {
    await seedRun(NEO_USER, "pending", { startedAt: null, lastHeartbeatAt: null });
    const { response, created } = await postPublish();
    expect(response.status).toBe(409);
    expect(created).toEqual([]);
  });

  it("refuses back-to-back POSTs: the first starts, the second gets 409", async () => {
    const first = await postPublish();
    const second = await postPublish();
    expect(first.response.status).toBe(202);
    expect(second.response.status).toBe(409);
    expect(second.created).toEqual([]);
    expect(await runCount()).toBe(1);
  });

  it("does not block on a running row silent for longer than the window", async () => {
    const old = Date.now() - PUBLISH_STALE_AFTER_MS - 60_000;
    await seedRun(NEO_USER, "running", { createdAt: old, startedAt: old, lastHeartbeatAt: old });
    const { response, created } = await postPublish();
    expect(response.status).toBe(202);
    expect(created).toHaveLength(1);
  });

  it("blocks on an old run whose heartbeat is recent", async () => {
    const old = Date.now() - PUBLISH_STALE_AFTER_MS - 60_000;
    await seedRun(NEO_USER, "running", { createdAt: old, startedAt: old, lastHeartbeatAt: Date.now() });
    const { response } = await postPublish();
    expect(response.status).toBe(409);
  });

  it("does not block on a finished or failed run", async () => {
    await seedRun(NEO_USER, "complete");
    await seedRun(NEO_USER, "error");
    const { response, created } = await postPublish();
    expect(response.status).toBe(202);
    expect(created).toHaveLength(1);
  });

  it("does not block on another tenant's running publish", async () => {
    await seedRun(SECOND_USER, "running");
    const { response, created } = await postPublish();
    expect(response.status).toBe(202);
    expect(created).toHaveLength(1);
  });
});
