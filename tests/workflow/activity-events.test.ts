/**
 * Tests — activity events
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import type { ActivityEvent } from "../../app/lib/workflow.server";

// Compile-time assertions: the two new events are members of
// the ActivityEvent union. If a refactor drops them, this file stops
// compiling (a stronger signal than any runtime assertion can be).
const _qcRaised: ActivityEvent = "qc_flag_raised";
const _qcResolved: ActivityEvent = "qc_flag_resolved";
void _qcRaised;
void _qcResolved;

type Db = ReturnType<typeof drizzle>;

describe("activity_log.event accepts literals", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("inserts a row with event='qc_flag_raised' without a CHECK rejection", async () => {
    const user = await createTestUser({
      email: `ae-raised-${crypto.randomUUID()}@example.com`,
    });
    const id = crypto.randomUUID();
    await db.insert(schema.activityLog).values({
      id,
      userId: user.id,
      projectId: null,
      volumeId: null,
      event: "qc_flag_raised",
      detail: null,
      createdAt: Date.now(),
    });

    const [row] = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.id, id))
      .all();
    expect(row.event).toBe("qc_flag_raised");
  });

  it("inserts a row with event='qc_flag_resolved' without a CHECK rejection", async () => {
    const user = await createTestUser({
      email: `ae-resolved-${crypto.randomUUID()}@example.com`,
    });
    const id = crypto.randomUUID();
    await db.insert(schema.activityLog).values({
      id,
      userId: user.id,
      projectId: null,
      volumeId: null,
      event: "qc_flag_resolved",
      detail: null,
      createdAt: Date.now(),
    });

    const [row] = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.id, id))
      .all();
    expect(row.event).toBe("qc_flag_resolved");
  });

  it("confirms the ActivityEvent union accepts both literals at compile time", () => {
    // The real assertion runs at compile time via `_qcRaised` / `_qcResolved`
    // above. The runtime body exists so Vitest reports a passing test whose
    // name makes the intent greppable from CI output.
    expect(_qcRaised).toBe("qc_flag_raised");
    expect(_qcResolved).toBe("qc_flag_resolved");
  });
});

