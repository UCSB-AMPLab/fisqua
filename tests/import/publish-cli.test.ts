/**
 * Tests — the command line's publish
 *
 * This suite pins `scripts/lib/publish-cli/`, behind `scripts/fisqua.ts
 * publish start` and `publish status`. The run is driven through an
 * injected D1 runner that answers by the statement it is given and
 * records every statement, an injected workflow trigger, and an injected
 * clock, wait, sign-in fetch, interrupt flag and file writer, so nothing
 * here reaches wrangler, D1, Workflows or the network.
 *
 *   - the arguments: `--fonds` or `--all-fonds`, `--types` or
 *     `--all-types`, a run id for `status`;
 *   - the gate, before anything is written: the tenant exists, is not
 *     disabled and has the publish capability; the actor is a super
 *     admin at home in the tenant or admitted to it as a platform admin,
 *     and the lead's admin on a member is refused, as their steward's
 *     flags never make a super admin;
 *     the fonds are the tenant's publishable fonds; the types are the
 *     route's; entities and places count only with authorities;
 *   - the insert: the route's own statement and values, inlined, and the
 *     route's message when it writes no row;
 *   - the trigger: the workflow of the target, the run id as the
 *     instance id, the route's parameters; a failed trigger closes the
 *     run as the route closes it;
 *   - the follow: one read every 30 s, a line only when the step or
 *     count changes, the sign-in page every 10 reads, stopping on a
 *     terminal status, a 7429, the sign-in page down or Ctrl-C;
 *   - production: `--confirm-production` first, and refused while any
 *     run on production is live;
 *   - `status`: a run of another tenant is not found;
 *   - the summary: the keys written, from the run's record counts.
 *
 * @version v0.9.0
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INSERT_PUBLISH_RUN_ANY_TENANT_SQL,
  INSERT_PUBLISH_RUN_SQL,
  insertPublishRunBinds,
  PUBLISH_IN_PROGRESS_MESSAGE,
  PUBLISH_STALE_AFTER_MS,
} from "../../app/lib/export/publish-run";
import {
  FOLLOW_INTERVAL_MS,
  inlineBinds,
  InterruptGate,
  keysWritten,
  LOGIN_EVERY_READS,
  parsePublishArgs,
  PUBLISH_WORKFLOWS,
  publishExitCode,
  runPublishStart,
  runPublishStatus,
  type PublishProviders,
  type PublishStartArgs,
  type PublishStatusArgs,
} from "../../scripts/lib/publish-cli/run";
import { publishWrangler } from "../../scripts/lib/publish-cli/wrangler";

type Row = Record<string, unknown>;

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const PLATFORM = "0391baa2-0bab-44ae-ac08-9fa7eb7c6145";

interface World {
  tenant: Row | null;
  user: Row | null;
  leadTenantId: string | null;
  members: Row[];
  fonds: string[];
  insertChanges: number | null;
  /** The insert throws this, after it has (or has not) been applied. */
  insertError: string | null;
  updateError: string | null;
  liveRuns: Row[];
  /** The rows the run read returns, one per read; the last repeats. */
  runRows: Row[];
  runTenant: string;
  /** Errors the run read throws, by read number (1-based). */
  runErrors: Record<number, string>;
  triggerError: string | null;
  describeAnswer: "exists" | "absent" | "unknown";
  /** Ctrl-C pressed as the insert is sent. */
  interruptAtInsert: boolean;
  loginStatus: (check: number) => number;
  interruptAfterReads: number | null;
}

function world(over: Partial<World> = {}): World {
  return {
    tenant: {
      id: "t-lead",
      slug: "lead",
      kind: "tenant",
      federation_id: "fed-1",
      descriptive_standard: "isadg",
      publish_pipeline_enabled: 1,
      authorities_enabled: 1,
      disabled_at: null,
    },
    user: { id: "u-1", email: "actor@example.org", tenant_id: "t-lead", is_super_admin: 1, is_platform_admin: 0 },
    leadTenantId: "t-lead",
    members: [
      { id: "t-lead", slug: "lead", descriptive_standard: "isadg" },
      { id: "t-member", slug: "member", descriptive_standard: "isadg" },
    ],
    fonds: ["fa", "fb", "fc"],
    insertChanges: 1,
    insertError: null,
    updateError: null,
    liveRuns: [],
    runRows: [runRow({ status: "complete", steps_completed: 5, total_steps: 5 })],
    runTenant: "t-lead",
    runErrors: {},
    triggerError: null,
    describeAnswer: "absent",
    interruptAtInsert: false,
    loginStatus: () => 200,
    interruptAfterReads: null,
    ...over,
  };
}

function runRow(over: Row = {}): Row {
  return {
    id: "00000000-aaaa-4bbb-8ccc-000000000001",
    tenant_id: "t-lead",
    status: "pending",
    selected_fonds: '["fa"]',
    selected_types: '["descriptions"]',
    current_step: null,
    steps_completed: 0,
    total_steps: 5,
    record_counts: null,
    error_message: null,
    started_at: null,
    completed_at: null,
    last_heartbeat_at: null,
    created_at: NOW,
    ...over,
  };
}

interface Harness {
  p: PublishProviders;
  statements: string[];
  triggers: Array<{ workflow: string; params: string; id: string }>;
  sleeps: number[];
  logins: string[];
  lines: string[];
  files: Record<string, string>;
  runReads: () => number;
  /** What happened, in order: statements by their first word, triggers, describes, and the hold's bounds. */
  events: string[];
}

function harness(w: World): Harness {
  const statements: string[] = [];
  const triggers: Harness["triggers"] = [];
  const sleeps: number[] = [];
  const logins: string[] = [];
  const lines: string[] = [];
  const files: Record<string, string> = {};
  let reads = 0;
  let ids = 0;
  let pressed = false;
  const events: string[] = [];
  let clock = NOW;
  const d1 = async (sql: string) => {
    statements.push(sql);
    if (/^(INSERT|UPDATE)/.test(sql)) events.push(sql.split(" ")[0]);
    if (/^INSERT/.test(sql) && w.interruptAtInsert) pressed = true;
    const one = (r: Row | null) => ({ results: r ? [r] : [], changes: 0 });
    if (/FROM tenants WHERE slug = /.test(sql)) return one(w.tenant);
    if (/FROM users WHERE lower\(email\) = /.test(sql)) return one(w.user);
    if (/FROM federations f, tenants h WHERE/.test(sql)) {
      return one({ status: "active", lead_tenant_id: w.leadTenantId, home_disabled_at: null });
    }
    if (/^select "lead_tenant_id" from "federations"/.test(sql)) return one(w.leadTenantId ? { lead_tenant_id: w.leadTenantId } : null);
    if (/^select "authorities_enabled" from "tenants"/.test(sql)) {
      return one(w.tenant ? { authorities_enabled: w.tenant.authorities_enabled } : null);
    }
    if (/^select "id", "slug", "descriptive_standard" from "tenants"/.test(sql)) return { results: w.members, changes: 0 };
    if (/^select "reference_code" from "descriptions"/.test(sql)) {
      return { results: w.fonds.map((f) => ({ reference_code: f })), changes: 0 };
    }
    if (/^INSERT INTO export_runs/.test(sql)) {
      if (w.insertError) throw new Error(w.insertError);
      return { results: [], changes: w.insertChanges };
    }
    if (/^UPDATE export_runs/.test(sql)) {
      if (w.updateError) throw new Error(w.updateError);
      return { results: [], changes: 1 };
    }
    if (/FROM export_runs WHERE status IN/.test(sql)) return { results: w.liveRuns, changes: 0 };
    if (/FROM export_runs WHERE id = /.test(sql)) {
      reads++;
      if (w.runErrors[reads]) throw new Error(w.runErrors[reads]);
      if (!sql.includes(`tenant_id = '${w.runTenant}'`)) return { results: [], changes: 0 };
      return one(w.runRows[Math.min(reads, w.runRows.length) - 1]);
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  const p: PublishProviders = {
    d1,
    trigger: async (workflow, params, id) => {
      triggers.push({ workflow, params, id });
      events.push("trigger");
      if (w.triggerError) throw new Error(w.triggerError);
      return `Workflow instance "${id}" has been queued successfully`;
    },
    fetch: async (url) => {
      logins.push(url);
      return { status: w.loginStatus(logins.length) };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    describe: async (workflow, id) => {
      events.push(`describe ${workflow} ${id}`);
      return w.describeAnswer;
    },
    interrupted: () => pressed || (w.interruptAfterReads !== null && reads >= w.interruptAfterReads),
    hold: async (fn) => {
      events.push("hold");
      try {
        return await fn();
      } finally {
        events.push("release");
      }
    },
    now: () => clock,
    newId: () => `00000000-aaaa-4bbb-8ccc-${String(++ids).padStart(12, "0")}`,
    writeFile: (path, text) => {
      files[path] = text;
    },
    log: (line) => lines.push(line),
  };
  return { p, statements, triggers, sleeps, logins, lines, files, runReads: () => reads, events };
}

function startArgs(over: Partial<PublishStartArgs> = {}): PublishStartArgs {
  return {
    command: "start",
    target: "staging",
    tenant: "lead",
    actorEmail: "actor@example.org",
    fonds: ["fa"],
    types: ["descriptions"],
    force: false,
    confirmProduction: false,
    ...over,
  };
}

function statusArgs(over: Partial<PublishStatusArgs> = {}): PublishStatusArgs {
  return { command: "status", runId: "00000000-aaaa-4bbb-8ccc-000000000001", target: "staging", tenant: "lead", follow: false, ...over };
}

const writes = (h: Harness) => h.statements.filter((s) => /^(INSERT|UPDATE)/.test(s));

describe("publish arguments", () => {
  it("reads start with lists, and with the all flags", () => {
    const a = parsePublishArgs([
      "publish", "start", "--target", "staging", "--tenant", "lead", "--actor-email", "a@x.org",
      "--fonds", "fa,fb", "--types", "descriptions,entities", "--force",
    ]);
    expect(a).toEqual({
      command: "start", target: "staging", tenant: "lead", actorEmail: "a@x.org",
      fonds: ["fa", "fb"], types: ["descriptions", "entities"], force: true, confirmProduction: false,
    });
    const b = parsePublishArgs([
      "publish", "start", "--target", "production", "--tenant", "lead", "--actor-email", "a@x.org",
      "--all-fonds", "--all-types", "--confirm-production",
    ]);
    expect(b).toMatchObject({ fonds: null, types: null, confirmProduction: true });
  });

  it("needs one of --fonds and --all-fonds, and one of --types and --all-types", () => {
    const base = ["publish", "start", "--target", "staging", "--tenant", "lead", "--actor-email", "a@x.org"];
    expect(() => parsePublishArgs([...base, "--all-types"])).toThrow(/--fonds <codes> or --all-fonds/);
    expect(() => parsePublishArgs([...base, "--all-fonds"])).toThrow(/--types <list> or --all-types/);
    expect(() => parsePublishArgs([...base, "--all-fonds", "--fonds", "fa", "--all-types"])).toThrow(/not both/);
    expect(() => parsePublishArgs([...base, "--all-fonds", "--all-types", "--types", "places"])).toThrow(/not both/);
  });

  it("reads status with a run id and --follow", () => {
    expect(parsePublishArgs(["publish", "status", "r-1", "--target", "staging", "--tenant", "lead", "--follow"])).toEqual({
      command: "status", runId: "r-1", target: "staging", tenant: "lead", follow: true,
    });
    expect(() => parsePublishArgs(["publish", "status", "--target", "staging", "--tenant", "lead"])).toThrow(/run id/);
  });
});

describe("publish start: the gate", () => {
  it("refuses production without --confirm-production before reading anything", async () => {
    const h = harness(world());
    await expect(runPublishStart(startArgs({ target: "production" }), h.p)).rejects.toThrow(/--confirm-production/);
    expect(h.statements).toHaveLength(0);
  });

  it("refuses an unknown tenant", async () => {
    const h = harness(world({ tenant: null }));
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/No tenant has the slug lead/);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses a disabled tenant", async () => {
    const w = world();
    w.tenant!.disabled_at = NOW - 1000;
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/lead is disabled/);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses a tenant without the publish capability", async () => {
    const w = world();
    w.tenant!.publish_pipeline_enabled = 0;
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/does not have publishing on/);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses an actor who is not a super admin", async () => {
    const w = world();
    w.user!.is_super_admin = 0;
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/is not a super admin/);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses an unknown actor", async () => {
    const h = harness(world({ user: null }));
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/No user has the email actor@example.org/);
  });

  it("refuses a super admin of another tenant who is not a platform admin", async () => {
    const w = world();
    w.user!.tenant_id = "t-other";
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/may not act in lead/);
    expect(writes(h)).toHaveLength(0);
  });

  it("admits a platform admin stored in another tenant, as the page does", async () => {
    const w = world();
    w.user!.tenant_id = "t-other";
    w.user!.is_platform_admin = 1;
    const h = harness(w);
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("complete");
    expect(writes(h)[0]).toContain("'u-1'");
  });

  it("admits a platform admin whose stored row is not a super admin, as the page does", async () => {
    const w = world();
    w.user!.tenant_id = "t-other";
    w.user!.is_platform_admin = 1;
    w.user!.is_super_admin = 0;
    const h = harness(w);
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("complete");
    expect(writes(h)[0]).toContain("'u-1'");
  });

  it("admits a platform admin at home whose stored row is not a super admin", async () => {
    const w = world();
    w.user!.is_platform_admin = 1;
    w.user!.is_super_admin = 0;
    const h = harness(w);
    expect((await runPublishStart(startArgs(), h.p)).outcome).toBe("complete");
  });

  it("refuses the lead's admin on a member: they act there with a steward's flags, which never make a super admin", async () => {
    const w = world();
    w.tenant = { ...w.tenant!, id: "t-member", slug: "member" };
    w.user!.is_admin = 1;
    const h = harness(w);
    await expect(runPublishStart(startArgs({ tenant: "member" }), h.p)).rejects.toThrow(
      /actor@example.org acts in member as the admin of the lead workspace of its federation, which does not make them a super admin there/,
    );
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses a plain user of another tenant", async () => {
    const w = world();
    w.user!.tenant_id = "t-other";
    w.user!.is_super_admin = 0;
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/may not act in lead/);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses a platform admin whose row is on the platform tenant", async () => {
    const w = world();
    w.user!.tenant_id = PLATFORM;
    w.user!.is_platform_admin = 1;
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/may not act in lead/);
  });

  it("refuses a fonds that is not in the tenant's publishable list", async () => {
    const h = harness(world());
    await expect(runPublishStart(startArgs({ fonds: ["fa", "zz"] }), h.p)).rejects.toThrow(/zz.*Invalid fonds code|Invalid fonds code.*zz/s);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses a type the route does not take", async () => {
    const h = harness(world());
    await expect(runPublishStart(startArgs({ types: ["descriptions", "mets"] }), h.p)).rejects.toThrow(/selectedTypes/);
    expect(writes(h)).toHaveLength(0);
  });

  it("refuses a tenant without a descriptive standard", async () => {
    const w = world();
    w.tenant!.descriptive_standard = null;
    const h = harness(w);
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/has no descriptive standard/);
  });

  it("takes the whole publishable list and every type with the all flags", async () => {
    const h = harness(world());
    await runPublishStart(startArgs({ fonds: null, types: null }), h.p);
    const insert = writes(h)[0];
    expect(insert).toContain(`'["fa","fb","fc"]'`);
    expect(insert).toContain(`'["descriptions","repositories","entities","places"]'`);
    // 3 fonds × 4 + index + repositories + entities + places + 2 link files.
    expect(insert).toMatch(/, 18, /);
  });

  it("counts entities and places only with the authorities capability", async () => {
    const w = world();
    w.tenant!.authorities_enabled = 0;
    const h = harness(w);
    await runPublishStart(startArgs({ fonds: ["fa"], types: ["descriptions", "entities", "places"] }), h.p);
    expect(writes(h)[0]).toMatch(/, 5, /);
  });
});

describe("publish start: the insert", () => {
  it("sends the route's statement with the route's values", async () => {
    const h = harness(world());
    await runPublishStart(startArgs({ fonds: ["fa", "fb"], types: ["descriptions", "repositories"] }), h.p);
    const exportId = "00000000-aaaa-4bbb-8ccc-000000000001";
    const binds = insertPublishRunBinds({
      exportId,
      triggeredBy: "u-1",
      tenantId: "t-lead",
      selectedFonds: ["fa", "fb"],
      selectedTypes: ["descriptions", "repositories"],
      federationId: "fed-1",
      totalSteps: 10,
      now: NOW,
    });
    expect(binds).toEqual([
      exportId, "u-1", '["fa","fb"]', '["descriptions","repositories"]', "fed-1", 10, NOW, "t-lead", NOW - PUBLISH_STALE_AFTER_MS,
    ]);
    expect(writes(h)[0]).toBe(inlineBinds(INSERT_PUBLISH_RUN_SQL, binds));
  });

  it("is the statement the route prepares", () => {
    const route = readFileSync(new URL("../../app/routes/api.publish.tsx", import.meta.url), "utf8");
    expect(route).toContain(".prepare(INSERT_PUBLISH_RUN_SQL)");
    expect(route).toContain("insertPublishRunBinds(");
    expect(route).not.toMatch(/INSERT INTO export_runs/);
  });

  it("inlines numbered binds as SQL literals", () => {
    expect(inlineBinds("SELECT ?1, ?2, ?10, ?3, ?1", ["a'b", null, 7, 4, 5, 6, 7, 8, 9, "ten"])).toBe(
      "SELECT 'a''b', NULL, 'ten', 7, 'a''b'",
    );
    expect(() => inlineBinds("SELECT ?3", [1])).toThrow(/\?3/);
  });

  it("stops with the route's message when another run of the tenant is live", async () => {
    const h = harness(world({ insertChanges: 0 }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toBe(PUBLISH_IN_PROGRESS_MESSAGE);
    expect(h.triggers).toHaveLength(0);
    expect(publishExitCode(r)).toBe(1);
  });
});

describe("publish start: the trigger", () => {
  it("starts the target's workflow with the run id as the instance id", async () => {
    const h = harness(world());
    const r = await runPublishStart(startArgs(), h.p);
    const id = "00000000-aaaa-4bbb-8ccc-000000000001";
    expect(h.triggers).toEqual([{ workflow: "publish-export-staging", params: JSON.stringify({ exportId: id }), id }]);
    expect(r.runId).toBe(id);
  });

  it("passes force only when asked", async () => {
    const h = harness(world());
    await runPublishStart(startArgs({ force: true }), h.p);
    const id = "00000000-aaaa-4bbb-8ccc-000000000001";
    expect(h.triggers[0].params).toBe(JSON.stringify({ exportId: id, force: true }));
  });

  it("names the production and staging workflows", () => {
    expect(PUBLISH_WORKFLOWS).toEqual({ production: "publish-export", staging: "publish-export-staging" });
  });

  it("closes the run as an error when the trigger fails, as the route does", async () => {
    const h = harness(world({
      triggerError: "Workflow not found",
      runRows: [runRow({ status: "error", error_message: "workflow create failed: Workflow not found", completed_at: NOW })],
    }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("error");
    const close = writes(h)[1];
    expect(close).toBe(
      "UPDATE export_runs SET status = 'error', error_message = 'workflow create failed: Workflow not found', " +
        `completed_at = ${NOW} WHERE id = '00000000-aaaa-4bbb-8ccc-000000000001'`,
    );
    // The one read is the read-back after the close; nothing is followed.
    expect(h.runReads()).toBe(1);
    expect(r.summary?.status).toBe("error");
    expect(h.lines.join("\n")).toMatch(/is closed as an error/);
    expect(publishExitCode(r)).toBe(1);
    expect(h.events).toContain("describe publish-export-staging 00000000-aaaa-4bbb-8ccc-000000000001");
    expect(h.events.indexOf("describe publish-export-staging 00000000-aaaa-4bbb-8ccc-000000000001")).toBeLessThan(h.events.indexOf("UPDATE"));
  });

  it("follows the run instead of closing it when the failed trigger's instance exists", async () => {
    const h = harness(world({ triggerError: "fetch failed", describeAnswer: "exists" }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(writes(h)).toHaveLength(1);
    expect(h.lines.join("\n")).toMatch(/trigger reported an error.*exists; the run is not closed and is followed/);
    expect(h.runReads()).toBe(1);
    expect(r.outcome).toBe("complete");
  });

  it("leaves the run as it is when wrangler cannot say whether the instance exists", async () => {
    const h = harness(world({ triggerError: "fetch failed", describeAnswer: "unknown" }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(writes(h)).toHaveLength(1);
    expect(h.runReads()).toBe(0);
    expect(r.outcome).toBe("error");
    expect(r.reason).toMatch(/could not be read, so the run is left as it is/);
    expect(publishExitCode(r)).toBe(1);
  });
});

describe("publish start: a close that does not hold", () => {
  it("records the row as read back when the close fails, and names a run still pending", async () => {
    const h = harness(world({ triggerError: "boom", updateError: "D1 refused the write", runRows: [runRow({ status: "pending" })] }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("error");
    expect(r.summary?.status).toBe("pending");
    expect(r.reason).toMatch(/closing the run failed: D1 refused the write; the run is still pending/);
    expect(h.lines.join("\n")).toMatch(/still pending: it blocks the tenant's publishing until it goes stale\. Run id: 00000000-aaaa-4bbb-8ccc-000000000001/);
    const json = JSON.parse(Object.entries(h.files).find(([k]) => k.endsWith(".json"))![1]);
    expect(json.status).toBe("pending");
    expect(publishExitCode(r)).toBe(1);
  });

  it("says so when the row cannot be read back after the close", async () => {
    const h = harness(world({ triggerError: "boom", runErrors: { 1: "wrangler d1 execute failed [code: 7429]: overloaded" } }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.summary?.status).toBe("unknown (not read back)");
    expect(r.reason).toMatch(/could not be read back/);
    expect(publishExitCode(r)).toBe(1);
  });
});

describe("publish start: an insert whose answer is lost", () => {
  const pendingAfterInsert = runRow({ status: "pending", started_at: null });

  it("starts the workflow when the run was written and is pending", async () => {
    const h = harness(world({
      insertError: "fetch failed",
      runRows: [pendingAfterInsert, runRow({ status: "complete", steps_completed: 5 })],
    }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(h.lines.join("\n")).toMatch(/reported an error \(.*fetch failed\), but the run was written and is pending; starting its workflow/);
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0].id).toBe("00000000-aaaa-4bbb-8ccc-000000000001");
    expect(r.outcome).toBe("complete");
    expect(h.statements.filter((s) => /FROM export_runs WHERE id = /.test(s))[0]).toContain("AND tenant_id = 't-lead'");
  });

  it("reads back too when wrangler does not say how many rows changed", async () => {
    const h = harness(world({ insertChanges: null, runRows: [pendingAfterInsert, runRow({ status: "complete" })] }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(h.triggers).toHaveLength(1);
    expect(r.outcome).toBe("complete");
  });

  it("stops as a failed insert when the run was not written", async () => {
    const h = harness(world({ insertError: "fetch failed", runRows: [] }));
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/insert of run 00000000-aaaa-4bbb-8ccc-000000000001 failed and the run was not written: fetch failed/);
    expect(h.triggers).toHaveLength(0);
  });

  it("does not start a run that is no longer pending", async () => {
    const h = harness(world({ insertError: "fetch failed", runRows: [runRow({ status: "running", started_at: NOW })] }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(h.triggers).toHaveLength(0);
    expect(r.outcome).toBe("error");
    expect(publishExitCode(r)).toBe(1);
  });

  it("prints the run id and the status command when the read back fails", async () => {
    const h = harness(world({ insertError: "fetch failed", runErrors: { 1: "wrangler d1 execute failed [code: 7429]: overloaded" } }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(h.triggers).toHaveLength(0);
    expect(r.outcome).toBe("error");
    expect(r.runId).toBe("00000000-aaaa-4bbb-8ccc-000000000001");
    expect(h.lines.join("\n")).toContain(
      "Check it with: npx tsx scripts/fisqua.ts publish status 00000000-aaaa-4bbb-8ccc-000000000001 --target staging --tenant lead",
    );
    expect(publishExitCode(r)).toBe(1);
  });
});

describe("publish start: Ctrl-C between the insert and the trigger", () => {
  it("holds Ctrl-C from before the insert until the trigger has returned", async () => {
    const h = harness(world());
    await runPublishStart(startArgs(), h.p);
    expect(h.events.slice(0, 4)).toEqual(["hold", "INSERT", "trigger", "release"]);
  });

  it("holds it through a failed trigger, its check and the close", async () => {
    const h = harness(world({ triggerError: "boom" }));
    await runPublishStart(startArgs(), h.p);
    expect(h.events).toEqual(["hold", "INSERT", "trigger", "describe publish-export-staging 00000000-aaaa-4bbb-8ccc-000000000001", "UPDATE", "release"]);
  });

  it("starts the workflow after a press during the insert, then stops following without reading", async () => {
    const h = harness(world({ interruptAtInsert: true }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(h.triggers).toHaveLength(1);
    expect(r.outcome).toBe("interrupted");
    expect(h.runReads()).toBe(0);
    expect(writes(h)).toHaveLength(1);
    expect(h.lines.join("\n")).toMatch(/publish status 00000000-aaaa-4bbb-8ccc-000000000001 --target staging --tenant lead --follow/);
  });

  it("the gate defers every press while held, and exits on a second press otherwise", async () => {
    const gate = new InterruptGate();
    let during: string[] = [];
    await gate.hold(async () => {
      during = [gate.press(), gate.press(), gate.press()];
    });
    expect(during).toEqual(["deferred", "deferred", "deferred"]);
    expect(gate.interrupted()).toBe(true);
    expect(gate.press()).toBe("exit");
    const fresh = new InterruptGate();
    expect(fresh.interrupted()).toBe(false);
    expect(fresh.press()).toBe("stop");
    expect(fresh.press()).toBe("exit");
  });
});

describe("the wrangler providers", () => {
  const cli = "/w/cli.js";
  const record = () => {
    const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
    const exec = async (command: string, args: string[], env: Record<string, string | undefined>) => {
      calls.push({ command, args, env });
      return '[{"results":[{"a":1}],"success":true,"meta":{"changes":1}}]';
    };
    return { calls, exec };
  };

  it("triggers staging's workflow with the staging environment", async () => {
    const { calls, exec } = record();
    await publishWrangler("staging", exec, cli).trigger("publish-export-staging", '{"exportId":"r"}', "r");
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual([
      "--no-warnings", "--experimental-vm-modules", cli,
      "workflows", "trigger", "publish-export-staging", '{"exportId":"r"}', "--id", "r", "--env", "staging",
    ]);
  });

  it("triggers production's workflow with no environment", async () => {
    const { calls, exec } = record();
    await publishWrangler("production", exec, cli).trigger("publish-export", '{"exportId":"r"}', "r");
    expect(calls[0].args).toEqual([
      "--no-warnings", "--experimental-vm-modules", cli, "workflows", "trigger", "publish-export", '{"exportId":"r"}', "--id", "r",
    ]);
  });

  it("refuses a workflow that is not the target's", async () => {
    const { exec } = record();
    await expect(publishWrangler("production", exec, cli).trigger("publish-export-staging", "{}", "r")).rejects.toThrow(/not production's/);
  });

  it("describes the instance by name and id, with the staging environment", async () => {
    const { calls, exec } = record();
    expect(await publishWrangler("staging", exec, cli).describe("publish-export-staging", "r")).toBe("exists");
    expect(calls[0].args).toEqual([
      "--no-warnings", "--experimental-vm-modules", cli,
      "workflows", "instances", "describe", "publish-export-staging", "r", "--env", "staging",
    ]);
  });

  it("reads a describe failure as absent only when wrangler says the instance is not found", async () => {
    const failing = (stderr: string) => async () => {
      throw Object.assign(new Error("Command failed"), { stdout: "", stderr });
    };
    // What wrangler 4.71.0 prints on staging for an id that does not exist.
    const notFound =
      "\n ⛅️ wrangler 4.71.0\n───────────────────\n" +
      "✘ [ERROR] A request to the Cloudflare API (/accounts/a/workflows/publish-export-staging/instances/00000000-0000-0000-0000-000000000000) failed.\n" +
      "  workflows.api.error.instance.not_found [code: 10400]\n";
    const staging = publishWrangler("staging", failing(notFound), cli);
    expect(await staging.describe("publish-export-staging", "00000000-0000-0000-0000-000000000000")).toBe("absent");
    const unknown = await publishWrangler("production", failing("✘ [ERROR] fetch failed"), cli).describe("publish-export", "r");
    expect(unknown).toBe("unknown");
    // Wording that only resembles it is not an answer.
    const near = await publishWrangler("production", failing("✘ [ERROR] Instance not found"), cli).describe("publish-export", "r");
    expect(near).toBe("unknown");
  });

  it("reads the not-found answer through terminal colour codes", async () => {
    const coloured =
      "\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare API failed.\u001b[0m\n" +
      "  workflows.api.error.instance\u001b[0m.not_found \u001b[2m[code: 10400]\u001b[0m\n";
    const exec = async () => {
      throw Object.assign(new Error("Command failed"), { stdout: "", stderr: coloured });
    };
    expect(await publishWrangler("staging", exec, cli).describe("publish-export-staging", "r")).toBe("absent");
    const codeOnly = async () => {
      throw Object.assign(new Error("Command failed"), { stdout: "", stderr: "\u001b[2m[code: 10400]\u001b[0m" });
    };
    expect(await publishWrangler("staging", codeOnly, cli).describe("publish-export-staging", "r")).toBe("absent");
  });

  it("sends a statement to the target's database and reads its rows and changes", async () => {
    const { calls, exec } = record();
    const out = await publishWrangler("staging", exec, cli).d1("SELECT 1");
    expect(out).toEqual({ results: [{ a: 1 }], changes: 1 });
    expect(calls[0].args).toEqual([
      "--no-warnings", "--experimental-vm-modules", cli,
      "d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote", "--json", "--command", "SELECT 1",
    ]);
    expect(calls[0].env.CLOUDFLARE_ENV).toBeUndefined();
  });

  it("reports wrangler's code on a failure", async () => {
    const exec = async () => {
      throw Object.assign(new Error("Command failed"), { stdout: '{"error":{"text":"D1 DB is overloaded","code":7429}}', stderr: "" });
    };
    await expect(publishWrangler("production", exec, cli).d1("SELECT 1")).rejects.toThrow(/\[code: 7429\]/);
  });
});

describe("publish start: the follow", () => {
  const steps = [
    runRow({ status: "pending" }),
    runRow({ status: "running", current_step: "descriptions:fa", steps_completed: 0 }),
    runRow({ status: "running", current_step: "descriptions:fa", steps_completed: 0 }),
    runRow({ status: "running", current_step: "descriptions:index", steps_completed: 2 }),
    runRow({
      status: "complete",
      current_step: "dc:fa",
      steps_completed: 5,
      record_counts: JSON.stringify({ "descriptions:fa": 40, "descriptions:index": 40, "children:fa": 12, "ead:fa": 40, "dc:fa": 40 }),
      completed_at: NOW + 120_000,
    }),
  ];

  it("reads every 30 s, prints a line only on a change, and stops on a terminal status", async () => {
    const h = harness(world({ runRows: steps }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("complete");
    expect(h.runReads()).toBe(5);
    expect(h.sleeps).toEqual([FOLLOW_INTERVAL_MS, FOLLOW_INTERVAL_MS, FOLLOW_INTERVAL_MS, FOLLOW_INTERVAL_MS]);
    expect(FOLLOW_INTERVAL_MS).toBe(30_000);
    const progress = h.lines.filter((l) => /^\d\d:\d\d:\d\dZ /.test(l));
    expect(progress).toHaveLength(4);
    expect(progress[3]).toContain("complete");
    expect(publishExitCode(r)).toBe(0);
  });

  it("checks the sign-in page before the first read and every 10 reads", async () => {
    const rows = [...Array.from({ length: 11 }, () => runRow({ status: "running" })), runRow({ status: "complete" })];
    const h = harness(world({ runRows: rows }));
    await runPublishStart(startArgs({ target: "production", confirmProduction: true }), h.p);
    expect(LOGIN_EVERY_READS).toBe(10);
    expect(h.logins).toEqual(["https://neogranadina.fisqua.org/login", "https://neogranadina.fisqua.org/login"]);
  });

  it("stops following, leaving the run, when the sign-in page does not answer 200", async () => {
    const rows = Array.from({ length: 20 }, () => runRow({ status: "running" }));
    const h = harness(world({ runRows: rows, loginStatus: (n) => (n === 2 ? 500 : 200) }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("following stopped");
    expect(r.reason).toMatch(/sign-in page .* answered 500/);
    expect(h.runReads()).toBe(10);
    expect(writes(h)).toHaveLength(1);
    expect(h.lines.join("\n")).toMatch(/The run continues/);
    expect(h.lines.join("\n")).toMatch(/publish status 00000000-aaaa-4bbb-8ccc-000000000001 --target staging --tenant lead --follow/);
    expect(publishExitCode(r)).toBe(1);
  });

  it("stops following on a 7429, leaving the run", async () => {
    const rows = Array.from({ length: 5 }, () => runRow({ status: "running" }));
    const h = harness(world({ runRows: rows, runErrors: { 3: "wrangler d1 execute failed [code: 7429]: D1 DB is overloaded" } }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("following stopped");
    expect(r.reason).toMatch(/7429/);
    expect(h.runReads()).toBe(3);
    expect(writes(h)).toHaveLength(1);
  });

  it("stops following on Ctrl-C without touching the run, and says how to resume", async () => {
    const rows = Array.from({ length: 5 }, () => runRow({ status: "running" }));
    const h = harness(world({ runRows: rows, interruptAfterReads: 2 }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("interrupted");
    expect(h.runReads()).toBe(2);
    expect(writes(h)).toHaveLength(1);
    expect(h.lines.join("\n")).toMatch(/publish status 00000000-aaaa-4bbb-8ccc-000000000001 --target staging --tenant lead --follow/);
    expect(publishExitCode(r)).toBe(130);
  });

  it("writes nothing when interrupted before the insert", async () => {
    const h = harness(world({ interruptAfterReads: 0 }));
    await expect(runPublishStart(startArgs(), h.p)).rejects.toThrow(/Interrupted before the run was inserted/);
    expect(writes(h)).toHaveLength(0);
  });

  it("writes the summary to the run's report files", async () => {
    const h = harness(world({ runRows: steps }));
    const r = await runPublishStart(startArgs(), h.p);
    const names = Object.keys(h.files).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\.import\/publish_staging_20261120T120\d\d\dZ-[0-9a-f]{8}\.json$/);
    expect(names[1]).toBe(names[0].replace(/\.json$/, ".md"));
    const json = JSON.parse(h.files[names[0]]);
    expect(json).toMatchObject({ runId: r.runId, status: "complete", stepsCompleted: 5, totalSteps: 5 });
    expect(json.keys).toContain("lead/descriptions-fa.json");
    expect(h.files[names[1]]).toContain("lead/ead/fa.xml");
  });
});

describe("publish start: production", () => {
  it("is refused while any run on production is live, whatever its tenant", async () => {
    const h = harness(world({ liveRuns: [{ id: "r-other", tenant_id: "t-elsewhere", status: "running" }] }));
    await expect(runPublishStart(startArgs({ target: "production", confirmProduction: true }), h.p)).rejects.toThrow(
      /r-other.*t-elsewhere/,
    );
    expect(writes(h)).toHaveLength(0);
    const live = h.statements.find((s) => /FROM export_runs WHERE status IN/.test(s))!;
    expect(live).toBe(
      "SELECT id, tenant_id, status FROM export_runs WHERE status IN ('pending', 'running') " +
        `AND COALESCE(last_heartbeat_at, started_at, created_at) > ${NOW - PUBLISH_STALE_AFTER_MS}`,
    );
  });

  it("checks every tenant's live runs inside the insert itself", async () => {
    const h = harness(world());
    await runPublishStart(startArgs({ target: "production", confirmProduction: true }), h.p);
    const binds = insertPublishRunBinds({
      exportId: "00000000-aaaa-4bbb-8ccc-000000000001",
      triggeredBy: "u-1",
      tenantId: "t-lead",
      selectedFonds: ["fa"],
      selectedTypes: ["descriptions"],
      federationId: "fed-1",
      totalSteps: 5,
      now: NOW,
    });
    expect(writes(h)[0]).toBe(inlineBinds(INSERT_PUBLISH_RUN_ANY_TENANT_SQL, binds));
    expect(INSERT_PUBLISH_RUN_ANY_TENANT_SQL).toBe(INSERT_PUBLISH_RUN_SQL.replace("r.tenant_id = ?8\n         AND ", ""));
    expect(INSERT_PUBLISH_RUN_ANY_TENANT_SQL).not.toMatch(/r\.tenant_id/);
    expect(INSERT_PUBLISH_RUN_ANY_TENANT_SQL).toContain(
      "WHERE r.status IN ('pending', 'running')\n         AND COALESCE(r.last_heartbeat_at, r.started_at, r.created_at) > ?9",
    );
  });

  it("keeps the route's statement scoped to the tenant", () => {
    expect(INSERT_PUBLISH_RUN_SQL).toContain("WHERE r.tenant_id = ?8\n         AND r.status IN ('pending', 'running')");
  });

  it("stops on production when the insert finds a live run of any tenant", async () => {
    const h = harness(world({ insertChanges: 0 }));
    const r = await runPublishStart(startArgs({ target: "production", confirmProduction: true }), h.p);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toContain(PUBLISH_IN_PROGRESS_MESSAGE);
    expect(r.reason).toMatch(/any tenant/);
    expect(h.triggers).toHaveLength(0);
  });

  it("uses the route's statement on staging", async () => {
    const h = harness(world());
    await runPublishStart(startArgs(), h.p);
    expect(writes(h)[0]).toContain("WHERE r.tenant_id = 't-lead'");
  });

  it("does not read the live runs of other tenants on staging", async () => {
    const h = harness(world({ liveRuns: [{ id: "r-other", tenant_id: "t-elsewhere", status: "running" }] }));
    const r = await runPublishStart(startArgs(), h.p);
    expect(r.outcome).toBe("complete");
    expect(h.statements.some((s) => /FROM export_runs WHERE status IN/.test(s))).toBe(false);
  });
});

describe("publish status", () => {
  it("prints the summary of a run of the tenant from one read", async () => {
    const h = harness(world({ runRows: [runRow({ status: "running", steps_completed: 2 })] }));
    const r = await runPublishStatus(statusArgs(), h.p);
    expect(r.outcome).toBe("running");
    expect(h.runReads()).toBe(1);
    expect(h.sleeps).toHaveLength(0);
    expect(writes(h)).toHaveLength(0);
    expect(publishExitCode(r)).toBe(0);
  });

  it("does not find a run of another tenant", async () => {
    const h = harness(world({ runTenant: "t-elsewhere" }));
    const r = await runPublishStatus(statusArgs(), h.p);
    expect(r.outcome).toBe("not found");
    expect(h.statements.find((s) => /FROM export_runs WHERE id = /.test(s))).toContain("AND tenant_id = 't-lead'");
    expect(publishExitCode(r)).toBe(1);
  });

  it("follows with --follow as start does", async () => {
    const h = harness(world({ runRows: [runRow({ status: "running" }), runRow({ status: "error", error_message: "boom" })] }));
    const r = await runPublishStatus(statusArgs({ follow: true }), h.p);
    expect(r.outcome).toBe("error");
    expect(h.runReads()).toBe(2);
    expect(h.lines.join("\n")).toContain("boom");
  });
});

describe("the keys a run wrote", () => {
  it("are the main file of each counted step not skipped, and the institution files of a complete run", () => {
    const keys = keysWritten("lead", {
      status: "complete",
      recordCounts: {
        "descriptions:co-a.b": 10,
        "descriptions:index": 10,
        "children:co-a.b": 4,
        "ead:co-a.b": 10,
        "dc:co-a.b": 10,
        repositories: 2,
        entities: 5,
        places: 3,
        entity_links: 7,
        place_links: 6,
        skipped: ["ead:co-a.b"],
      },
    });
    expect(keys).toEqual([
      "lead/descriptions-co-a.b.json",
      "lead/descriptions-index.json",
      "lead/children/<reference code>.json for each of the 4 parents in co-a.b",
      "lead/dc/co-a.b.xml",
      "lead/repositories.json",
      "lead/entities.json",
      "lead/places.json",
      "lead/entity_links.json",
      "lead/place_links.json",
      "lead/publisher.json",
      "lead/vocabulary.json",
    ]);
  });

  it("leave out the institution files of a run that did not complete", () => {
    expect(keysWritten("lead", { status: "error", recordCounts: { repositories: 2 } })).toEqual(["lead/repositories.json"]);
  });
});

// @version v0.9.0
