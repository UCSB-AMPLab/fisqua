/**
 * Tests — the duplicate recheck job
 *
 * This suite pins `runDuplicateRecheck`, the duplicate recheck job. The
 * job reads the entity records marked in `duplicate_recheck`, finds the
 * records whose names match theirs or differ by one edit, computes the
 * facts of each pair for each workspace that can see both records, and
 * stores the qualifying pairs in `duplicate_candidates`. The suite
 * installs the shipped marking triggers of migration 0129 and writes
 * through real SQL, so every mark the job reads is one a trigger made.
 *
 * Two workspaces share the default federation: the default test tenant
 * (workspace A) and a second tenant added here (workspace B). A D1
 * wrapper counts the statements the job runs and keeps their SQL and
 * bound values, so a test can inject an overload refusal, another
 * error, or a concurrent write before a chosen statement, or check which
 * reads were issued. Runs pass a `sleep` that returns at once, and the
 * drain-rate tests pass their own wait and clock, so nothing sleeps.
 * The statement-budget tests measure what a run sends with the wrapper
 * and set `statementBudget` around it, with `chunkSize` lowered to one
 * so that each description costs a statement. The pair-budget tests
 * lower `pairBudget` under a same-name group and read `mostPairs`.
 * The failure tests read the error a run rethrows, a `RecheckStepError`
 * naming the step, its line from `recheckFailureLine`, and the skip line
 * from `console.error`, and check
 * that each names the step, the D1 code and the kind and holds no SQL
 * and no bound value.
 * Records linked to very many descriptions are tested with the limit
 * lowered to two through the `coLinkMaxDescriptions` option.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { applyDuplicateRecheckTriggers } from "../helpers/duplicate-recheck";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestPlace } from "../helpers/places";
import { createTestUser } from "../helpers/auth";
import {
  formatRecheckResult,
  RecheckStepError,
  recheckFailureLine,
  runDuplicateRecheck,
} from "../../app/lib/duplicate-recheck.server";
import { DUPLICATE_LIMITS } from "../../app/lib/duplicate-facts";

const WS_A = DEFAULT_TEST_TENANT_ID;
const WS_B = "b0000000-0000-4000-8000-00000000000b";
const FED = DEFAULT_TEST_FEDERATION_ID;
const NOW = 1_800_000_000_000;

type Row = { id_a: string; id_b: string; tenant_id: string; federation_id: string; facts: string; weight: number };

const run = (q: string, ...binds: unknown[]) => env.DB.prepare(q).bind(...binds).run();
const rows = async (): Promise<Row[]> =>
  (
    await env.DB.prepare(
      "SELECT id_a, id_b, tenant_id, federation_id, facts, weight FROM duplicate_candidates ORDER BY tenant_id, id_a, id_b",
    ).all<Row>()
  ).results;
const markCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM duplicate_recheck").first<{ n: number }>())!.n;

let codeSeq = 0;
const entity = (id: string, name: string, o: { tenantId?: string | null; dateStart?: string; dateEnd?: string } = {}) =>
  run(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, date_start, date_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'person', ?, ?, 1, 1)",
    id, FED, o.tenantId ?? null, `ne-rc-${++codeSeq}`, name, name, o.dateStart ?? null, o.dateEnd ?? null,
  );
const office = (id: string, entityId: string, fn: string) =>
  run("INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES (?, ?, ?, 1, 1)", id, entityId, fn);
const link = (id: string, d: string, e: string, related: string | null = null) =>
  run(
    "INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES (?, ?, ?, ?, 1, ?)",
    id, d, e, related ? "sibling" : "mentioned", related,
  );

let repoA: string;
let repoB: string;
let userId: string;
const description = async (id: string, ws: string, title = `Title ${id}`) =>
  (await createTestDescription({ id, tenantId: ws, repositoryId: ws === WS_A ? repoA : repoB, title })).id;

/**
 * A D1 binding that calls `before(n, sql, args)` ahead of the n-th
 * statement it runs, batch members included, and keeps every statement
 * it ran in `seen`.
 */
function wrapD1(inner: D1Database, before: (n: number, sql: string, args: unknown[]) => Promise<void> | void) {
  let n = 0;
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  const tick = async (q: string, args: unknown[]) => {
    n += 1;
    seen.push({ sql: q, args });
    await before(n, q, args);
  };
  const wrap = (s: D1PreparedStatement, q: string, args: unknown[]): any => ({
    __inner: s,
    __sql: q,
    __args: args,
    bind: (...next: unknown[]) => wrap(s.bind(...next), q, next),
    first: async (col?: string) => (await tick(q, args), col === undefined ? s.first() : s.first(col)),
    all: async () => (await tick(q, args), s.all()),
    run: async () => (await tick(q, args), s.run()),
    raw: async (opts?: any) => (await tick(q, args), s.raw(opts)),
  });
  const db = {
    prepare: (q: string) => wrap(inner.prepare(q), q, []),
    // Each member of a batch counts as one statement.
    batch: async (stmts: any[]) => {
      for (const st of stmts) await tick(st.__sql, st.__args);
      return inner.batch(stmts.map((st) => st.__inner));
    },
    exec: (q: string) => inner.exec(q),
  } as unknown as D1Database;
  return { db: drizzle(db), count: () => n, seen };
}

/** Whether a statement binds `id`, alone or in a JSON list. */
const binds = (args: unknown[], id: string) =>
  args.some((a) => typeof a === "string" && (a === id || a.includes(JSON.stringify(id))));

const overloadError = () => new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long. [code: 7429]");

const db = () => drizzle(env.DB);

/** Options for a run that never waits between batches. */
const noPause = { now: NOW, sleep: async () => {} };

/** Runs the job until no mark is left. */
async function runAll(d = db()) {
  for (let i = 0; i < 20; i++) {
    const r = await runDuplicateRecheck(d, noPause);
    expect(r.stopped).toBe("done");
    if ((await markCount()) === 0) return;
  }
  throw new Error("marks never cleared");
}

const facts = (r: Row) => JSON.parse(r.facts);

describe("runDuplicateRecheck", () => {
  beforeAll(async () => {
    await applyMigrations();
    await applyDuplicateRecheckTriggers();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
    await run(
      "INSERT INTO tenants (id, slug, name, kind, descriptive_standard, status, federation_id, created_at, updated_at) VALUES (?, 'ws-b', 'Workspace B', 'tenant', 'isadg', 'active', ?, 1, 1)",
      WS_B, FED,
    );
    userId = (await createTestUser({ email: `recheck-${crypto.randomUUID()}@example.test` })).id;
    repoA = (await createTestRepository({ tenantId: WS_A, code: "rc-a" })).id;
    repoB = (await createTestRepository({ tenantId: WS_B, code: "rc-b" })).id;
    await run("DELETE FROM duplicate_recheck");
  });

  it("lists a same-name pair that shares an office, for every workspace that can see both", async () => {
    await entity("e1", "Juan Pérez");
    await entity("e2", "juan perez");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", " escribano ");
    await runAll();
    const r = await rows();
    expect(r.map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual(
      [[WS_A, "e1", "e2"], [WS_B, "e1", "e2"]].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    );
    for (const x of r) {
      expect(x.federation_id).toBe(FED);
      expect(facts(x).offices).toEqual(["Escribano"]);
      expect(x.weight).toBe(4);
    }
    // The job filled each record's name key.
    const key = await env.DB.prepare("SELECT name_key FROM entities WHERE id = 'e1'").first<{ name_key: string }>();
    expect(key!.name_key).toBe("juan perez");
  });

  it("does not list a name-only pair", async () => {
    await entity("e1", "Pedro Gómez");
    await entity("e2", "Pedro Gomez");
    await runAll();
    expect(await rows()).toEqual([]);
  });

  it("lists a near-spelling pair that shares an associate", async () => {
    await entity("e1", "Manuel Fortuni");
    await entity("e2", "Manuel Fortuny");
    await entity("x", "Ignacio Sanz");
    const d1 = await description("d1", WS_A);
    const d2 = await description("d2", WS_A);
    await link("l1", d1, "e1");
    await link("l2", d1, "x");
    await link("l3", d2, "e2");
    await link("l4", d2, "x");
    await runAll();
    const r = await rows();
    expect(r.map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual([[WS_A, "e1", "e2"]]);
    const f = facts(r[0]);
    expect(f.associates).toEqual([{ id: "x", name: "Ignacio Sanz", code: expect.stringMatching(/^ne-rc-/) }]);
    expect(f.documents).toEqual([]);
    expect(f.offices).toEqual([]);
  });

  it("does not pair two one-word names one letter apart, even with a shared office", async () => {
    await entity("e1", "Juan");
    await entity("e2", "Juana");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    await runAll();
    expect(await rows()).toEqual([]);
  });

  it("pairs two names one letter apart when one has two words and they share an office", async () => {
    await entity("e1", "Juan Sánchez");
    await entity("e2", "Juana Sánchez");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    await runAll();
    expect((await rows()).map((x) => [x.id_a, x.id_b])).toContainEqual(["e1", "e2"]);
  });

  it("computes document and associate facts per workspace", async () => {
    await entity("e1", "Ana Ruiz");
    await entity("e2", "Ana Ruiz");
    const d1 = await description("d1", WS_A, "Testamento");
    // A description in workspace B names only one of them.
    const d2 = await description("d2", WS_B);
    await link("l1", d1, "e1");
    await link("l2", d1, "e2");
    await link("l3", d2, "e1");
    await runAll();
    const r = await rows();
    expect(r.map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual([[WS_A, "e1", "e2"]]);
    const f = facts(r[0]);
    expect(f.warning).toBe("same-document");
    expect(f.documents).toEqual([{ id: "d1", title: "Testamento" }]);
  });

  it("a record owned by one workspace pairs only in that workspace", async () => {
    await entity("e1", "Luis Vega", { tenantId: WS_A });
    await entity("e2", "Luis Vega");
    await entity("e3", "Luis Vega", { tenantId: WS_B });
    for (const e of ["e1", "e2", "e3"]) await office(`f-${e}`, e, "Alcalde");
    await runAll();
    expect((await rows()).map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual(
      [[WS_A, "e1", "e2"], [WS_B, "e2", "e3"]].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    );
  });

  it("drops a pair when its only fact is removed", async () => {
    await entity("e1", "Juan Pérez");
    await entity("e2", "Juan Pérez");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    await runAll();
    expect((await rows()).length).toBe(2);
    await run("DELETE FROM entity_functions WHERE id = 'f1'");
    await runAll();
    expect(await rows()).toEqual([]);
  });

  it("a link added to a description rechecks the other records linked there", async () => {
    await entity("e1", "Ana Ruiz");
    await entity("e2", "Ana Ruiz");
    await entity("x", "Ignacio Sanz");
    const d1 = await description("d1", WS_A);
    const d2 = await description("d2", WS_A);
    await link("l1", d1, "e1");
    await link("l2", d1, "x");
    await link("l3", d2, "e2");
    await runAll();
    expect(await rows()).toEqual([]);
    // Only x is edited: a link of x on d2, where e2 is linked.
    await link("l4", d2, "x");
    const first = await runDuplicateRecheck(db(), noPause);
    expect(first.expanded).toBe(1);
    await runAll();
    const r = await rows();
    expect(r.map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual([[WS_A, "e1", "e2"]]);
    expect(facts(r[0]).associates.map((a: { id: string }) => a.id)).toEqual(["x"]);
  });

  it("a merge removes the loser's pairs and recomputes the survivor's", async () => {
    await entity("e1", "Luis Vega");
    await entity("e2", "Luis Vega");
    await entity("e3", "Luis Vega");
    await entity("x", "Ignacio Sanz");
    await office("f1", "e1", "Alcalde");
    await office("f2", "e2", "Alcalde");
    const d1 = await description("d1", WS_A);
    const d2 = await description("d2", WS_A);
    await link("l1", d1, "e2");
    await link("l2", d1, "x");
    await link("l3", d2, "e3");
    await link("l4", d2, "x");
    await runAll();
    expect((await rows()).filter((x) => x.tenant_id === WS_A).map((x) => [x.id_a, x.id_b])).toEqual([
      ["e1", "e2"],
      ["e2", "e3"],
    ]);
    // Merge e2 into e1: its link moves, it points at the survivor, and the
    // operation is recorded.
    await run("UPDATE description_entities SET entity_id = 'e1' WHERE id = 'l1'");
    await run("UPDATE entities SET merged_into = 'e1' WHERE id = 'e2'");
    await run(
      "INSERT INTO authority_operations (id, federation_id, record_type, operation, source_id, target_id, user_id, created_at) VALUES ('op-m', ?, 'entity', 'merge', 'e2', 'e1', ?, 1)",
      FED, userId,
    );
    await runAll();
    const r = await rows();
    expect(r.some((x) => x.id_a === "e2" || x.id_b === "e2")).toBe(false);
    expect(r.map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual([[WS_A, "e1", "e3"]]);
    expect(facts(r[0]).associates.map((a: { id: string }) => a.id)).toEqual(["x"]);
    const deletions = await env.DB.prepare("SELECT count(*) AS n FROM duplicate_name_deletions WHERE entity_id = 'e2'").first<{ n: number }>();
    expect(deletions!.n).toBe(0);
  });

  it("a separate operation removes the pair", async () => {
    await entity("e1", "Juan Pérez");
    await entity("e2", "Juan Pérez");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    await runAll();
    expect((await rows()).length).toBe(2);
    await run(
      "INSERT INTO authority_operations (id, federation_id, record_type, operation, source_id, target_id, user_id, created_at) VALUES ('op-s', ?, 'entity', 'separate', 'e2', 'e1', ?, 1)",
      FED, userId,
    );
    await runAll();
    expect(await rows()).toEqual([]);
  });

  it("records related in a description are not listed", async () => {
    await entity("e1", "Juan Pérez");
    await entity("e2", "Juan Pérez");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    const d1 = await description("d1", WS_A);
    await link("r1", d1, "e1");
    await link("r2", d1, "e2", "r1");
    await run("UPDATE description_entities SET related_to = 'r2', role = 'sibling' WHERE id = 'r1'");
    await runAll();
    expect(await rows()).toEqual([]);
  });

  it("shows a shared place but never lists a pair for it alone", async () => {
    await entity("e1", "Ana Ruiz");
    await entity("e2", "Ana Ruiz");
    const p = (await createTestPlace({ id: "p1", placeCode: "nl-rc-1", displayName: "Tunja" })).id;
    const d1 = await description("d1", WS_A);
    const d2 = await description("d2", WS_A);
    await link("l1", d1, "e1");
    await link("l2", d2, "e2");
    for (const [id, d] of [["dp1", d1], ["dp2", d2]]) {
      await run("INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES (?, ?, ?, 'mentioned', 1)", id, d, p);
    }
    await runAll();
    expect(await rows()).toEqual([]);
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    await runAll();
    const r = await rows();
    expect(r.length).toBe(2);
    const inA = facts(r.find((x) => x.tenant_id === WS_A)!);
    expect(inA.places).toEqual([{ id: "p1", name: "Tunja" }]);
    const inB = facts(r.find((x) => x.tenant_id === WS_B)!);
    expect(inB.places).toEqual([]);
  });

  it("never copies a place private to another workspace into a workspace's facts", async () => {
    await entity("e1", "Ana Ruiz");
    await entity("e2", "Ana Ruiz");
    await office("f1", "e1", "Escribano");
    await office("f2", "e2", "Escribano");
    const shared = (await createTestPlace({ id: "p-shared", placeCode: "nl-rc-s", displayName: "Tunja" })).id;
    const secret = (await createTestPlace({ id: "p-secret", placeCode: "nl-rc-p", displayName: "Secret Hacienda" })).id;
    // The place was shared when A linked it, and is now private to B.
    await run("UPDATE places SET tenant_id = ? WHERE id = ?", WS_B, secret);
    for (const [d, e] of [["dpa1", "e1"], ["dpa2", "e2"]]) {
      await description(d, WS_A);
      await link(`l-${d}`, d, e);
      for (const p of [shared, secret]) {
        await run("INSERT INTO description_places (id, description_id, place_id, role, created_at) VALUES (?, ?, ?, 'mentioned', 1)", `${d}-${p}`, d, p);
      }
    }
    await runAll();
    const inA = (await rows()).find((x) => x.tenant_id === WS_A)!;
    expect(facts(inA).places).toEqual([{ id: "p-shared", name: "Tunja" }]);
    for (const r of await rows()) expect(r.facts).not.toMatch(/Secret Hacienda|p-secret/);
  });

  it("a full batch issues a bounded number of statements", async () => {
    // Four same-name clusters of 50 records, each cluster sharing an office.
    const names = ["Juan Pérez", "Manuel Fortuny", "Ana Ruiz", "Luis Vega"];
    for (let i = 0; i < 200; i++) {
      const id = `b${String(i).padStart(3, "0")}`;
      await entity(id, names[i % 4]);
      await office(`fb${i}`, id, `Office ${i % 4}`);
    }
    expect(await markCount()).toBe(200);
    const counter = wrapD1(env.DB, () => {});
    const r = await runDuplicateRecheck(counter.db, noPause);
    expect(r.stopped).toBe("done");
    expect(r.handled).toBe(200);
    // 4 clusters x C(50, 2) pairs, in each of the two workspaces.
    expect(r.pairsWritten).toBe(4 * 1225 * 2);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM duplicate_candidates").first<{ n: number }>())!.n).toBe(9800);
    expect(await markCount()).toBe(0);
    expect(counter.count()).toBeLessThanOrEqual(60);
  });

  it("a full batch with links issues a bounded number of statements", async () => {
    // Four same-name clusters of 50 records; each record is linked to its own
    // description with one associate of its cluster, so every pair shares it.
    const names = ["Juan Pérez", "Manuel Fortuny", "Ana Ruiz", "Luis Vega"];
    for (let c = 0; c < 4; c++) await entity(`x${c}`, `Associate ${c}`);
    for (let i = 0; i < 196; i++) {
      const id = `b${String(i).padStart(3, "0")}`;
      await entity(id, names[i % 4]);
      const d = await description(`dl${i}`, WS_A);
      await link(`lb${i}`, d, id);
      await link(`lx${i}`, d, `x${i % 4}`);
    }
    await run("DELETE FROM duplicate_recheck");
    await run("INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT id, '', 1 FROM entities ORDER BY id");
    expect(await markCount()).toBe(200);
    const counter = wrapD1(env.DB, () => {});
    const r = await runDuplicateRecheck(counter.db, noPause);
    expect(r.stopped).toBe("done");
    expect(r.handled).toBe(200);
    // 4 clusters x C(49, 2) pairs, in workspace A only.
    expect(r.pairsWritten).toBe(4 * 1176);
    expect(await markCount()).toBe(0);
    expect(counter.count()).toBeLessThanOrEqual(60);
  });

  describe("records linked to very many descriptions", () => {
    it("pairs on a shared office without reading the record's associates", async () => {
      await entity("e1", "Felipe Quinto");
      await entity("e2", "Felipe Quinto");
      await entity("x", "Ignacio Sanz");
      await office("f1", "e1", "Rey");
      await office("f2", "e2", "Rey");
      // e1 is linked to three descriptions of workspace A, over the limit of two.
      for (const d of ["dh1", "dh2", "dh3"]) {
        await description(d, WS_A);
        await link(`l-${d}-e1`, d, "e1");
        await link(`l-${d}-x`, d, "x");
      }
      const dLight = await description("dh4", WS_A);
      await link("l-dh4-e2", dLight, "e2");
      await link("l-dh4-x", dLight, "x");
      const dB = await description("dh5", WS_B);
      await link("l-dh5-e1", dB, "e1");
      await link("l-dh5-e2", dB, "e2");
      const counter = wrapD1(env.DB, () => {});
      for (let i = 0; i < 5 && (await markCount()) > 0; i++) {
        await runDuplicateRecheck(counter.db, { ...noPause, coLinkMaxDescriptions: 2 });
      }
      expect(await markCount()).toBe(0);
      const r = await rows();
      const inA = r.find((x) => x.tenant_id === WS_A && x.id_a === "e1" && x.id_b === "e2")!;
      expect(facts(inA).offices).toEqual(["Rey"]);
      expect(facts(inA).associates).toEqual([]);
      expect(facts(inA).documents).toEqual([]);
      // In workspace B, e1 is under the limit and its document counts.
      const inB = r.find((x) => x.tenant_id === WS_B && x.id_a === "e1" && x.id_b === "e2")!;
      expect(facts(inB).documents.map((d: { id: string }) => d.id)).toEqual(["dh5"]);
      // The associate and place reads never named a description e1 has in
      // workspace A; they did name e2's.
      const coLinkReads = counter.seen.filter(
        (st) => /FROM description_entities\s+WHERE description_id IN|WHERE dp\.description_id IN/.test(st.sql),
      );
      for (const d of ["dh1", "dh2", "dh3"]) expect(coLinkReads.filter((st) => binds(st.args, d))).toEqual([]);
      expect(coLinkReads.filter((st) => binds(st.args, "dh4")).length).toBeGreaterThan(0);
    });

    it("draws the line at the place threshold of 2,000 descriptions", () => {
      expect(DUPLICATE_LIMITS.recordMaxDescriptions).toBe(DUPLICATE_LIMITS.placeMaxDescriptions);
      expect(DUPLICATE_LIMITS.recordMaxDescriptions).toBe(2000);
    });
  });

  describe("drain rate", () => {
    const records = async (n: number) => {
      for (let i = 0; i < n; i++) await entity(`q${String(i).padStart(2, "0")}`, `Name ${i}`);
    };

    it("drains batches one after another, pausing a second between them", async () => {
      await records(5);
      const pauses: number[] = [];
      const r = await runDuplicateRecheck(db(), { now: NOW, batchSize: 2, sleep: async (ms) => void pauses.push(ms) });
      expect(r).toMatchObject({ stopped: "done", handled: 5, batches: 3 });
      expect(pauses).toEqual([1000, 1000]);
      expect(await markCount()).toBe(0);
    });

    it("stops after ten batches", async () => {
      await records(12);
      const pauses: number[] = [];
      const r = await runDuplicateRecheck(db(), { now: NOW, batchSize: 1, sleep: async (ms) => void pauses.push(ms) });
      expect(r).toMatchObject({ stopped: "batches", handled: 10, batches: 10 });
      expect(pauses).toHaveLength(9);
      expect(await markCount()).toBe(2);
    });

    it("stops once about two minutes have passed since the run began", async () => {
      await records(10);
      let t = 0;
      const r = await runDuplicateRecheck(db(), {
        now: NOW,
        batchSize: 1,
        clock: () => t,
        sleep: async () => {
          t += 50_000;
        },
      });
      // Batches start at 0, 50 and 100 seconds; the pause after the third ends at 150.
      expect(r).toMatchObject({ stopped: "time", handled: 3, batches: 3 });
      expect(await markCount()).toBe(7);
    });

    it("takes the batch count, the pause and the time budget as options", async () => {
      await records(6);
      const pauses: number[] = [];
      const r = await runDuplicateRecheck(db(), {
        now: NOW,
        batchSize: 1,
        maxBatches: 4,
        pauseMs: 5,
        timeBudgetMs: 60_000,
        sleep: async (ms) => void pauses.push(ms),
      });
      expect(r).toMatchObject({ handled: 4, batches: 4 });
      expect(pauses).toEqual([5, 5, 5]);
    });

    it("stops on an overload in a later batch and leaves its marks", async () => {
      await records(4);
      let paused = false;
      const failing = wrapD1(env.DB, () => {
        if (paused) throw overloadError();
      });
      const r = await runDuplicateRecheck(failing.db, {
        now: NOW,
        batchSize: 2,
        sleep: async () => {
          paused = true;
        },
      });
      expect(r).toMatchObject({ stopped: "overload", handled: 2, batches: 1 });
      expect(await markCount()).toBe(2);
    });

    it("reads once and does not pause when the queue is empty", async () => {
      const counter = wrapD1(env.DB, () => {});
      const pauses: number[] = [];
      const r = await runDuplicateRecheck(counter.db, { now: NOW, sleep: async (ms) => void pauses.push(ms) });
      expect(r).toMatchObject({ stopped: "done", handled: 0, batches: 0 });
      expect(pauses).toEqual([]);
      expect(counter.count()).toBe(1);
    });

    it("does not pause after a batch that took the whole queue", async () => {
      await records(3);
      const pauses: number[] = [];
      const r = await runDuplicateRecheck(db(), { now: NOW, sleep: async (ms) => void pauses.push(ms) });
      expect(r).toMatchObject({ handled: 3, batches: 1 });
      expect(pauses).toEqual([]);
    });

    it("reports totals across batches in the log line", () => {
      expect(
        formatRecheckResult({
          handled: 400,
          pairsWritten: 12,
          pairsRemoved: 3,
          expanded: 5,
          skipped: 1,
          batches: 2,
          statements: 77,
          mostPairs: 9,
          stopped: "budget",
        }),
      ).toBe(
        "duplicate recheck: handled=400 written=12 removed=3 expanded=5 skipped=1 batches=2 statements=77 stopped=budget",
      );
    });
  });

  describe("statement budget", () => {
    /** Clears the job's output and marks `ids` again, as if never rechecked. */
    async function remark(ids: string[]) {
      await run("DELETE FROM duplicate_candidates");
      await run("DELETE FROM duplicate_name_deletions");
      await run("UPDATE entities SET name_key = NULL");
      await run("DELETE FROM duplicate_recheck");
      for (const id of ids) await run("INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES (?, '', 1)", id);
    }

    /** Two same-name pairs, each named together in forty descriptions of workspace A. */
    async function heavyPairs() {
      await entity("e1", "Juan Pérez");
      await entity("e2", "Juan Pérez");
      await entity("e3", "Ana Ruiz");
      await entity("e4", "Ana Ruiz");
      for (const [p, pair] of [["a", ["e1", "e2"]], ["b", ["e3", "e4"]]] as const) {
        for (let i = 0; i < 40; i++) {
          const d = await description(`dp-${p}${i}`, WS_A);
          for (const e of pair) await link(`l-${d}-${e}`, d, e);
        }
      }
      return ["e1", "e2", "e3", "e4"];
    }

    /** The statements of one unbudgeted run over the current marks, and the rows it leaves. */
    async function measure(opts: Record<string, unknown>) {
      const counter = wrapD1(env.DB, () => {});
      const r = await runDuplicateRecheck(counter.db, { ...noPause, ...opts });
      expect(r.stopped).toBe("done");
      expect(await markCount()).toBe(0);
      return { statements: counter.count(), rows: await rows() };
    }

    it("stops with budget before passing it and leaves the remaining marks", async () => {
      for (let i = 0; i < 8; i++) await entity(`s${i}`, `Distinct ${"abcdefgh"[i].repeat(i + 3)}`);
      const counter = wrapD1(env.DB, () => {});
      const r = await runDuplicateRecheck(counter.db, { ...noPause, batchSize: 2, statementBudget: 20 });
      expect(r.stopped).toBe("budget");
      expect(r.handled).toBeGreaterThan(0);
      expect(counter.count()).toBeLessThanOrEqual(20);
      expect(r.statements).toBe(counter.count());
      expect(await markCount()).toBe(8 - r.handled);
      await runAll();
      expect(await markCount()).toBe(0);
    });

    it("splits a batch that could never fit one run and handles all its records across runs", async () => {
      const ids = await heavyPairs();
      await remark(ids);
      const full = await measure({ chunkSize: 1 });
      expect(full.rows.length).toBe(2);
      await remark(ids);
      const budget = full.statements - 1;
      let first: number | null = null;
      for (let i = 0; i < 10 && (await markCount()) > 0; i++) {
        const counter = wrapD1(env.DB, () => {});
        const r = await runDuplicateRecheck(counter.db, { ...noPause, chunkSize: 1, statementBudget: budget });
        expect(counter.count()).toBeLessThanOrEqual(budget);
        expect(r.skipped).toBe(0);
        first ??= r.handled;
      }
      // The whole batch does not fit, so only a split lets the first run handle a record.
      expect(first).toBeGreaterThan(0);
      expect(await markCount()).toBe(0);
      expect(await rows()).toEqual(full.rows);
    });

    it("handles a single heavy record within the budget it needs", async () => {
      await heavyPairs();
      await remark(["e1"]);
      const alone = await measure({ chunkSize: 1 });
      await remark(["e1"]);
      const counter = wrapD1(env.DB, () => {});
      const r = await runDuplicateRecheck(counter.db, { ...noPause, chunkSize: 1, statementBudget: alone.statements + 2 });
      expect(r).toMatchObject({ stopped: "done", handled: 1, skipped: 0 });
      expect(await rows()).toEqual(alone.rows);
    });

    it("skips a single record that could never fit one run", async () => {
      await heavyPairs();
      await remark(["e1"]);
      const alone = await measure({ chunkSize: 1 });
      await remark(["e1"]);
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
      let r;
      try {
        r = await runDuplicateRecheck(db(), { ...noPause, chunkSize: 1, statementBudget: Math.floor(alone.statements / 2) });
      } finally {
        spy.mockRestore();
      }
      expect(r).toMatchObject({ stopped: "done", handled: 0, skipped: 1 });
      expect(errors).toEqual(["duplicate recheck skipped: entity=e1 budget"]);
      expect(await markCount()).toBe(0);
    });

    it("skips the head record when it fits a run but not what a split leaves, so every run makes progress", async () => {
      const ids = await heavyPairs();
      await remark(["e1"]);
      const alone = await measure({ chunkSize: 1 });
      await remark(ids);
      const full = await measure({ chunkSize: 1 });
      const budget = alone.statements + 2;
      expect(full.statements).toBeGreaterThan(budget);
      await remark(ids);
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
      const runs = [];
      try {
        for (let i = 0; i < 2; i++) {
          const counter = wrapD1(env.DB, () => {});
          const r = await runDuplicateRecheck(counter.db, { ...noPause, chunkSize: 1, statementBudget: budget });
          expect(counter.count()).toBeLessThanOrEqual(budget);
          runs.push(r);
        }
      } finally {
        spy.mockRestore();
      }
      // The first run cannot fit e1 after the split, so it skips it.
      expect(runs[0].skipped).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toBe("duplicate recheck skipped: entity=e1 budget");
      // Each run handles or skips at least one record.
      for (const r of runs) expect(r.handled + r.skipped).toBeGreaterThan(0);
      const left = (await env.DB.prepare("SELECT DISTINCT entity_id FROM duplicate_recheck ORDER BY entity_id").all<{ entity_id: string }>()).results;
      expect(left.map((x) => x.entity_id)).not.toContain("e1");
      expect(left.length).toBeLessThan(3);
    });

    it("does not mark again the records of the batch a one-record retry has still to take", async () => {
      await entity("e1", "Juan Pérez");
      await entity("e2", "Ana Ruiz");
      const d = await description("dr1", WS_A);
      await run("DELETE FROM duplicate_recheck");
      await link("l1", d, "e1");
      await link("l2", d, "e2");
      // Both link marks are in one batch; the first statement fails once.
      const failing = wrapD1(env.DB, (n) => {
        if (n === 2) throw new Error("no such column: nope");
      });
      const r = await runDuplicateRecheck(failing.db, { ...noPause, maxBatches: 1 });
      expect(r.stopped).toBe("done");
      expect(r.expanded).toBe(0);
      expect(await markCount()).toBe(0);
    });

    it("a one-record retry stops once the time budget has passed", async () => {
      await entity("e1", "Juan Pérez");
      await entity("e2", "Ana Ruiz");
      let t = 0;
      const failing = wrapD1(env.DB, (n) => {
        if (n === 2) {
          t = 130_000;
          throw new Error("no such column: nope");
        }
      });
      const r = await runDuplicateRecheck(failing.db, { ...noPause, clock: () => t });
      expect(r).toMatchObject({ stopped: "time", handled: 0, skipped: 0 });
      expect(await markCount()).toBe(2);
    });
  });

  describe("pair budget", () => {
    /** A same-name group of `n` records sharing an office, all marked. */
    async function group(n: number) {
      for (let i = 0; i < n; i++) {
        const id = `g${String(i).padStart(3, "0")}`;
        await entity(id, "Juan Pérez");
        await office(`fg${i}`, id, "Escribano");
      }
    }

    it("splits a batch whose candidate pairs pass the pair budget, stays within it and handles every record", async () => {
      await group(60);
      const runs = [];
      for (let i = 0; i < 20 && (await markCount()) > 0; i++) {
        runs.push(await runDuplicateRecheck(db(), { ...noPause, pairBudget: 200 }));
      }
      expect(await markCount()).toBe(0);
      for (const r of runs) {
        expect(r.mostPairs).toBeLessThanOrEqual(200);
        expect(r.skipped).toBe(0);
        expect(r.handled).toBeGreaterThan(0);
      }
      // C(60, 2) pairs in each of the two workspaces.
      expect((await rows()).length).toBe(1770 * 2);
    });

    it("builds a full batch at once under the default pair budget", async () => {
      await group(60);
      const r = await runDuplicateRecheck(db(), noPause);
      expect(r).toMatchObject({ stopped: "done", handled: 60, batches: 1 });
      expect(r.mostPairs).toBe(1770);
    });

    it("skips a record whose candidates alone pass the pair budget", async () => {
      await group(5);
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
      let r;
      try {
        r = await runDuplicateRecheck(db(), { ...noPause, pairBudget: 2 });
      } finally {
        spy.mockRestore();
      }
      expect(r.skipped).toBe(5);
      expect(r.mostPairs).toBeLessThanOrEqual(2);
      expect(errors[0]).toBe("duplicate recheck skipped: entity=g000 pairs");
      expect(await markCount()).toBe(0);
    });
  });

  describe("interruptions", () => {
    /** Records, links and functions that give pairs of every kind, and a pending link expansion. */
    async function fixture() {
      await entity("e1", "Juan Pérez");
      await entity("e2", "Juan Perez");
      await entity("e3", "Manuel Fortuni");
      await entity("e4", "Manuel Fortuny");
      await entity("e5", "Ana Ruiz", { tenantId: WS_A });
      await entity("e6", "Ana Ruiz");
      await entity("x", "Ignacio Sanz");
      await office("f1", "e1", "Escribano");
      await office("f2", "e2", "Escribano");
      const d1 = await description("d1", WS_A);
      const d2 = await description("d2", WS_A);
      const d3 = await description("d3", WS_A);
      await link("l1", d1, "e3");
      await link("l2", d1, "x");
      await link("l3", d2, "e4");
      await link("l4", d2, "x");
      await link("l5", d3, "e5");
      await link("l6", d3, "e6");
    }

    it("stops on overload and finishes on the next run", async () => {
      await fixture();
      // The uninterrupted result, and the statements its first run takes.
      const counter = wrapD1(env.DB, () => {});
      await runDuplicateRecheck(counter.db, { ...noPause, chunkSize: 2 });
      const statements = counter.count();
      expect(statements).toBeGreaterThan(10);
      await runAll();
      const expected = await rows();
      expect(expected.length).toBeGreaterThan(0);

      for (let fail = 1; fail <= statements; fail++) {
        await run("DELETE FROM duplicate_candidates");
        await run("DELETE FROM duplicate_name_deletions");
        await run("UPDATE entities SET name_key = NULL");
        await run("DELETE FROM duplicate_recheck");
        await run("INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT id, '', 1 FROM entities ORDER BY id");
        await run(
          "INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT entity_id, description_id, 1 FROM description_entities ORDER BY id",
        );
        const failing = wrapD1(env.DB, (n) => {
          if (n === fail) throw overloadError();
        });
        const first = await runDuplicateRecheck(failing.db, { ...noPause, chunkSize: 2 });
        expect(first.stopped, `failure at statement ${fail}`).toBe("overload");
        expect(await markCount()).toBeGreaterThan(0);
        const second = await runDuplicateRecheck(db(), { ...noPause, chunkSize: 2 });
        expect(second.stopped).toBe("done");
        await runAll();
        expect(await rows(), `failure at statement ${fail}`).toEqual(expected);
      }
    });

    it("rethrows an error reading the marks that is not an overload", async () => {
      await fixture();
      const failing = wrapD1(env.DB, (n) => {
        if (n === 1) throw new Error("no such column: nope");
      });
      const err = await runDuplicateRecheck(failing.db, noPause).then(() => null, (e: unknown) => e);
      // The run's wrapper names the step; drizzle's error is its cause, and the driver's is drizzle's.
      expect(err).toBeInstanceOf(RecheckStepError);
      expect((err as RecheckStepError).step).toBe("marks");
      const drizzleErr = (err as RecheckStepError).cause as Error & { cause?: Error };
      expect(String(drizzleErr.cause?.message)).toMatch(/nope/);
    });

    it("logs a failed marks read with its step, code and kind, and nothing of the query", async () => {
      await fixture();
      const failing = wrapD1(env.DB, (n) => {
        if (n === 1) {
          throw new Error(
            "D1_ERROR: Network connection lost. SELECT email FROM users WHERE email = 'secret@example.org' [code: 7500]",
          );
        }
      });
      const err = await runDuplicateRecheck(failing.db, noPause).then(() => null, (e: unknown) => e);
      const line = recheckFailureLine(err);
      expect(line).toBe("duplicate recheck failed: Error step=marks code=7500 kind=connection");
      expect(line).not.toMatch(/SELECT|secret@example\.org/);
    });

    it("logs a failed clearing of a skipped record's marks with step=clear", async () => {
      await entity("bad", "Zacarías Quiñones");
      const failing = wrapD1(env.DB, (_n, q, args) => {
        if (binds(args, "bad")) throw new Error("boom: SELECT ... 'bad'");
        if (/^\s*DELETE FROM duplicate_recheck/i.test(q)) throw new Error("boom: DELETE ... 'bad'");
      });
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      let err: unknown;
      try {
        err = await runDuplicateRecheck(failing.db, noPause).then(() => null, (e: unknown) => e);
      } finally {
        spy.mockRestore();
      }
      expect(err).toBeInstanceOf(RecheckStepError);
      expect((err as RecheckStepError).step).toBe("clear");
      expect(errors).toEqual([]);
      const line = recheckFailureLine(err);
      expect(line).toBe("duplicate recheck failed: Error step=clear kind=unknown");
      expect(line).not.toMatch(/boom|bad/);
    });

    it("logs a failure no step claims as step=other", () => {
      expect(recheckFailureLine(new RangeError("boom"))).toBe("duplicate recheck failed: RangeError step=other kind=unknown");
    });

    it("retries a batch one record at a time after an error that is not an overload", async () => {
      await fixture();
      await runAll();
      const expected = await rows();
      await run("DELETE FROM duplicate_candidates");
      await run("INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT id, '', 1 FROM entities ORDER BY id");
      const failing = wrapD1(env.DB, (n) => {
        if (n === 2) throw new Error("no such column: nope");
      });
      const r = await runDuplicateRecheck(failing.db, noPause);
      expect(r.stopped).toBe("done");
      expect(r.skipped).toBe(0);
      await runAll();
      expect(await rows()).toEqual(expected);
    });

    it("skips a record that keeps failing and handles the records after it in the same run", async () => {
      // The failing record is marked first, so it heads the batch.
      await entity("bad", "Zacarías Quiñones");
      await entity("e1", "Juan Pérez");
      await entity("e2", "Juan Pérez");
      await office("f1", "e1", "Escribano");
      await office("f2", "e2", "Escribano");
      let renamed = false;
      const failing = wrapD1(env.DB, async (_n, _sql, args) => {
        if (!binds(args, "bad")) return;
        // A mark of the failing record made after the run read its marks.
        if (!renamed) {
          renamed = true;
          await run("UPDATE entities SET display_name = 'Zacarías Quiñónez' WHERE id = 'bad'");
        }
        throw new Error("boom: SELECT ... 'bad'");
      });
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      let r;
      try {
        r = await runDuplicateRecheck(failing.db, noPause);
      } finally {
        spy.mockRestore();
      }
      expect(r.stopped).toBe("done");
      expect(r.skipped).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("duplicate recheck skipped: entity=bad Error step=unit kind=unknown");
      expect(errors[0]).not.toMatch(/boom/);
      expect((await rows()).map((x) => [x.tenant_id, x.id_a, x.id_b])).toEqual(
        [[WS_A, "e1", "e2"], [WS_B, "e1", "e2"]].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      );
      // The marks read were cleared by seq; the mark made after the read is kept.
      const left = (await env.DB.prepare("SELECT entity_id, description_id FROM duplicate_recheck").all()).results;
      expect(left).toEqual([{ entity_id: "bad", description_id: "" }]);
    });

    it("stops on an overload during the one-record retry", async () => {
      await entity("bad", "Zacarías Quiñones");
      await entity("e1", "Juan Pérez");
      let failures = 0;
      const failing = wrapD1(env.DB, (_n, _sql, args) => {
        if (!binds(args, "bad")) return;
        failures += 1;
        throw failures === 1 ? new Error("no such column: nope") : overloadError();
      });
      const r = await runDuplicateRecheck(failing.db, noPause);
      expect(r.stopped).toBe("overload");
      expect(r.skipped).toBe(0);
      expect(await markCount()).toBe(2);
    });

    it("a mark added during the run survives the clearing", async () => {
      await entity("e1", "Juan Pérez");
      await entity("e2", "Juan Pérez");
      await office("f1", "e1", "Escribano");
      // After the job has read the marks, e2 gains the same office.
      const writer = wrapD1(env.DB, async (n) => {
        if (n === 2) await office("f2", "e2", "Escribano");
      });
      const first = await runDuplicateRecheck(writer.db, { ...noPause, maxBatches: 1 });
      expect(first.stopped).toBe("done");
      const left = (await env.DB.prepare("SELECT entity_id, description_id FROM duplicate_recheck").all()).results;
      expect(left).toEqual([{ entity_id: "e2", description_id: "" }]);
      await runAll();
      expect((await rows()).map((x) => [x.tenant_id, x.id_a, x.id_b]).length).toBe(2);
    });
  });
});

// @version v0.9.0
