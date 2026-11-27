/**
 * Tests — the duplicate pair page's context for each record
 *
 * This suite pins the context that the pair page at /admin/decisions/pair
 * shows for each of the two records: the descriptions that name it, the
 * entities and places those descriptions also name, and where the record
 * came from. It pins:
 *
 *   - the loader returns that context for both sides: a record with
 *     linked descriptions (title, code, dates, roles, the name as
 *     recorded, the total beyond the listed ten) beside one with none;
 *   - the origin: a record created by an import run (run message, date,
 *     uploaded file), one created by hand (the user and date), one the
 *     entity pipeline resolved and split, with merges into it, and one
 *     with nothing recorded beyond its row;
 *   - the statement count is fixed: the same for a pair with no links
 *     as for a pair with dozens;
 *   - tenant scoping: another tenant's descriptions, and the records
 *     only they name, never appear, and a record owned by another
 *     tenant is never named as a neighbour or a split parent;
 *   - place pairs get the analogous context;
 *   - each record's origin is read per record: its first pipeline
 *     record and its own capped splits and journal entries, however
 *     many earlier ledger or journal rows the other record has;
 *   - the ledger and journal reads go through the endpoint indexes
 *     (EXPLAIN QUERY PLAN), never the federation-wide ledger index.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  seedTenants,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { loader } from "../../app/routes/_auth.admin.decisions.pair";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  pairContextStatements,
  SPLIT_LIMIT,
} from "../../app/lib/pair-context.server";

const A = DEFAULT_TEST_TENANT_ID;
const B = SECOND_TEST_TENANT_ID;

function db() {
  return drizzle(env.DB, { schema });
}

let admin: User;
let adminName: string;
let repoA: string;
let repoB: string;

/** The D1 binding with a count of the statements prepared on it. */
function countingDb() {
  const counter = { statements: 0 };
  const d1 = env.DB;
  const wrapped = {
    prepare: (query: string) => {
      counter.statements++;
      return d1.prepare(query);
    },
    batch: (stmts: D1PreparedStatement[]) => d1.batch(stmts),
    exec: (query: string) => d1.exec(query),
    dump: () => d1.dump(),
    withSession: (c?: string) => d1.withSession(c),
  };
  return { wrapped, counter };
}

async function load(
  kind: "entities" | "places",
  a: string,
  b: string,
): Promise<{ data: any; statements: number }> {
  const { wrapped, counter } = countingDb();
  const ctx = new RouterContextProvider();
  ctx.set(userContext, admin);
  ctx.set(tenantContext, makeTenantContext({ id: A }));
  (ctx as any).cloudflare = { env: { ...env, DB: wrapped } };
  const data = await loader({
    request: new Request(
      `http://neogranadina.fisqua.test/admin/decisions/pair?type=${kind}&a=${a}&b=${b}`,
    ),
    context: ctx,
    params: {},
  } as any);
  return { data, statements: counter.statements };
}

let linkSeq = 0;
async function linkEntity(
  descriptionId: string,
  entityId: string,
  role: (typeof schema.descriptionEntities.$inferInsert)["role"] = "mentioned",
  nameAsRecorded: string | null = null,
) {
  await db().insert(schema.descriptionEntities).values({
    id: `de-${++linkSeq}`,
    descriptionId,
    entityId,
    role,
    sequence: 0,
    nameAsRecorded,
    createdAt: Date.now(),
  });
}
async function linkPlace(descriptionId: string, placeId: string) {
  await db().insert(schema.descriptionPlaces).values({
    id: `dp-${++linkSeq}`,
    descriptionId,
    placeId,
    role: "mentioned",
    createdAt: Date.now(),
  });
}

async function description(
  tenantId: string,
  referenceCode: string,
  title: string,
  dateStart: string | null = null,
) {
  const d = await createTestDescription({
    tenantId,
    repositoryId: tenantId === A ? repoA : repoB,
    referenceCode,
    title,
  });
  if (dateStart) {
    await db()
      .update(schema.descriptions)
      .set({ dateStart, dateExpression: dateStart.slice(0, 4) })
      .where(eq(schema.descriptions.id, d.id));
  }
  return d.id;
}

describe("duplicate pair page: record context", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    adminName = "Ana Archivista";
    const row = await createTestUser({ isAdmin: true, name: adminName });
    admin = makeUserContext({ id: row.id, tenantId: A, isAdmin: true });
    repoA = (await createTestRepository({ tenantId: A, code: "repo-a" })).id;
    repoB = (await createTestRepository({ tenantId: B, code: "repo-b" })).id;
  });

  it("returns descriptions, neighbours and totals for a linked side and an empty side", async () => {
    const left = await createTestEntity({ entityCode: "ne-left1", displayName: "Juan de Mosquera" });
    const right = await createTestEntity({ entityCode: "ne-right1", displayName: "Juan Mosquera" });
    const witness = await createTestEntity({ entityCode: "ne-wit1", displayName: "Pedro Testigo" });
    const notary = await createTestEntity({ entityCode: "ne-not1", displayName: "Diego Escribano" });
    const popayan = await createTestPlace({ placeCode: "nl-pop1", displayName: "Popayán" });

    // Twelve descriptions name the left record: ten are listed, two more
    // are counted. The witness shares all twelve, the notary two.
    for (let i = 1; i <= 12; i++) {
      const code = `co-a-${String(i).padStart(2, "0")}`;
      const d = await description(A, code, `Pleito ${i}`, `17${String(10 + i)}-01-01`);
      await linkEntity(d, left.id, "plaintiff", i === 1 ? "Ju.o de Mosquera" : null);
      if (i === 1) await linkEntity(d, left.id, "witness");
      await linkEntity(d, witness.id);
      if (i <= 2) await linkEntity(d, notary.id, "notary");
      if (i <= 3) await linkPlace(d, popayan.id);
    }

    const { data } = await load("entities", left.id, right.id);
    const l = data.left.context;
    const r = data.right.context;

    expect(l.descriptionTotal).toBe(12);
    expect(l.descriptions).toHaveLength(10);
    // Oldest first: the first listed is Pleito 1 (1711).
    expect(l.descriptions[0]).toMatchObject({
      title: "Pleito 1",
      referenceCode: "co-a-01",
      dateStart: "1711-01-01",
      dateExpression: "1711",
      roles: ["plaintiff", "witness"],
      nameAsRecorded: "Ju.o de Mosquera",
    });
    expect(l.entities.map((e: any) => [e.name, e.count])).toEqual([
      ["Pedro Testigo", 12],
      ["Diego Escribano", 2],
    ]);
    // The record itself is never its own neighbour.
    expect(l.entities.find((e: any) => e.id === left.id)).toBeUndefined();
    expect(l.places).toEqual([
      { id: popayan.id, name: "Popayán", code: "nl-pop1", count: 3 },
    ]);

    expect(r.descriptions).toEqual([]);
    expect(r.descriptionTotal).toBe(0);
    expect(r.entities).toEqual([]);
    expect(r.places).toEqual([]);
  });

  it("reports an import origin and a manual origin", async () => {
    const left = await createTestEntity({ entityCode: "ne-imp1" });
    const right = await createTestEntity({ entityCode: "ne-man1" });
    const runAt = Date.UTC(2026, 5, 2);
    await db().insert(schema.stewardshipRuns).values({
      id: "run-1",
      tenantId: A,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      kind: "import",
      message: "Archivo Central del Cauca, signatura 1",
      userId: admin.id,
      status: "complete",
      createdAt: runAt,
    });
    await db().insert(schema.importUploads).values({
      id: "up-1",
      tenantId: A,
      userId: admin.id,
      filename: "acc-signatura-1.csv",
      artifactKey: "staging/up-1.csv",
      byteSize: 10,
      status: "committed",
      runId: "run-1",
      createdAt: runAt,
      updatedAt: runAt,
    });
    await db().insert(schema.changelog).values([
      {
        id: "cl-1",
        recordId: left.id,
        recordType: "entity",
        userId: admin.id,
        diff: "{}",
        runId: "run-1",
        kind: "create",
        createdAt: runAt,
      },
      {
        id: "cl-2",
        recordId: right.id,
        recordType: "entity",
        userId: admin.id,
        diff: "{}",
        note: "Minted from pending decision d-1 (import)",
        kind: "create",
        createdAt: Date.UTC(2026, 6, 3),
      },
    ]);

    const { data } = await load("entities", left.id, right.id);
    expect(data.left.context.origin.journal).toEqual({
      userName: adminName,
      note: null,
      createdAt: runAt,
      run: {
        visible: true,
        message: "Archivo Central del Cauca, signatura 1",
        createdAt: runAt,
        filename: "acc-signatura-1.csv",
      },
    });
    expect(data.right.context.origin.journal).toEqual({
      userName: adminName,
      note: "Minted from pending decision d-1 (import)",
      createdAt: Date.UTC(2026, 6, 3),
      run: null,
    });
  });

  it("reports the pipeline record, a split, merges and legacy ids, and nothing where nothing is recorded", async () => {
    const parent = await createTestEntity({ entityCode: "ne-par1", displayName: "Padre Dividido" });
    const left = await createTestEntity({ entityCode: "ne-pip1" });
    const right = await createTestEntity({ entityCode: "ne-bare1" });
    await db()
      .update(schema.entities)
      .set({
        legacyIds: JSON.stringify([
          { provider: "django-zasqua", id: 801088 },
          { provider: "zasqua-2026-04", id: "ne-h4kwt" },
        ]),
      })
      .where(eq(schema.entities.id, left.id));
    const at = Date.UTC(2026, 3, 16);
    await db().insert(schema.authorityOperations).values([
      {
        id: "op-resolve",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        recordType: "entity",
        operation: "resolve",
        sourceId: left.id,
        targetId: null,
        userId: admin.id,
        detail: JSON.stringify({
          origin: "pipeline-backfill",
          decisionSource: "agent",
          decisionRule: null,
          reasoning: "Same given name and surname, overlapping dates.",
          mentionCount: 48,
          pipelineEntityId: "acc-00002",
        }),
        createdAt: at,
      },
      {
        id: "op-split",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        recordType: "entity",
        operation: "split",
        sourceId: parent.id,
        targetId: left.id,
        userId: admin.id,
        createdAt: at + 1,
      },
      {
        id: "op-merge-1",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        recordType: "entity",
        operation: "merge",
        sourceId: "gone-1",
        targetId: left.id,
        userId: admin.id,
        createdAt: at + 2,
      },
      {
        id: "op-merge-2",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        recordType: "entity",
        operation: "merge",
        sourceId: "gone-2",
        targetId: left.id,
        userId: admin.id,
        createdAt: at + 3,
      },
    ]);

    const { data } = await load("entities", left.id, right.id);
    const o = data.left.context.origin;
    expect(o.pipeline).toEqual({
      createdAt: at,
      decisionSource: "agent",
      decisionRule: null,
      reasoning: "Same given name and surname, overlapping dates.",
      mentionCount: 48,
      pipelineEntityId: "acc-00002",
    });
    expect(o.splitFrom).toEqual([
      {
        createdAt: at + 1,
        userName: adminName,
        sourceId: parent.id,
        sourceName: "Padre Dividido",
        sourceCode: "ne-par1",
      },
    ]);
    expect(o.absorbed).toEqual({ count: 2, latestAt: at + 3 });
    expect(o.legacyIds).toEqual([
      { provider: "django-zasqua", id: "801088" },
      { provider: "zasqua-2026-04", id: "ne-h4kwt" },
    ]);

    const bare = data.right.context.origin;
    expect(bare).toMatchObject({
      legacyIds: [],
      journal: null,
      pipeline: null,
      splitFrom: [],
      absorbed: null,
    });
    expect(typeof bare.createdAt).toBe("number");
  });

  it("prepares the same number of statements with no links as with many", async () => {
    const e1 = await createTestEntity({ entityCode: "ne-c1" });
    const e2 = await createTestEntity({ entityCode: "ne-c2" });
    const empty = await load("entities", e1.id, e2.id);

    const others = [];
    for (let i = 0; i < 5; i++) {
      others.push(await createTestEntity({ entityCode: `ne-o${i}`, displayName: `Otro ${i}` }));
    }
    const place = await createTestPlace({ placeCode: "nl-c1" });
    for (let i = 0; i < 30; i++) {
      const d = await description(A, `cnt-${i}`, `Doc ${i}`);
      await linkEntity(d, i % 2 ? e1.id : e2.id);
      await linkEntity(d, others[i % 5].id);
      await linkPlace(d, place.id);
    }
    const full = await load("entities", e1.id, e2.id);

    expect(full.data.left.context.descriptionTotal).toBe(15);
    expect(full.statements).toBe(empty.statements);
    // The pair read, the decision row, the link counts, the six context
    // statements and the federation's role lists: nothing else.
    expect(full.statements).toBe(10);
  });

  it("keeps another tenant's descriptions and owned records out", async () => {
    const left = await createTestEntity({ entityCode: "ne-sc1" });
    const right = await createTestEntity({ entityCode: "ne-sc2" });
    const onlyB = await createTestEntity({ entityCode: "ne-sb1", displayName: "Solo en B" });
    const ownedByB = await createTestEntity({ entityCode: "ne-ob1", displayName: "Propio de B" });
    await db()
      .update(schema.entities)
      .set({ tenantId: B })
      .where(eq(schema.entities.id, ownedByB.id));
    const placeB = await createTestPlace({ placeCode: "nl-sb1", displayName: "Lugar de B" });

    // B's description names the shared left record alongside a record
    // only B names, and a place.
    const dB = await description(B, "b-1", "Documento de B");
    await linkEntity(dB, left.id);
    await linkEntity(dB, onlyB.id);
    await linkPlace(dB, placeB.id);
    // A's description names the left record alongside a record B owns.
    const dA = await description(A, "a-1", "Documento de A");
    await linkEntity(dA, left.id);
    await linkEntity(dA, ownedByB.id);
    // B split its own record into the left one: the parent is not A's to see.
    await db().insert(schema.authorityOperations).values({
      id: "op-split-b",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "split",
      sourceId: ownedByB.id,
      targetId: left.id,
      userId: admin.id,
      createdAt: Date.now(),
    });

    const { data } = await load("entities", left.id, right.id);
    const l = data.left.context;
    expect(l.descriptionTotal).toBe(1);
    expect(l.descriptions.map((d: any) => d.title)).toEqual(["Documento de A"]);
    expect(l.entities).toEqual([]);
    expect(l.places).toEqual([]);
    expect(l.origin.splitFrom).toEqual([
      expect.objectContaining({
        sourceId: ownedByB.id,
        sourceName: null,
        sourceCode: null,
      }),
    ]);
  });

  it("reads each record's origin on its own, whatever the other record carries", async () => {
    const left = await createTestEntity({ entityCode: "ne-many1" });
    const right = await createTestEntity({ entityCode: "ne-few1" });
    const base = Date.UTC(2026, 0, 1);
    const op = (
      id: string,
      operation: "resolve" | "split",
      sourceId: string,
      targetId: string | null,
      createdAt: number,
      detail?: Record<string, unknown>,
    ) => ({
      id,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity" as const,
      operation,
      sourceId,
      targetId,
      userId: admin.id,
      detail: detail ? JSON.stringify(detail) : null,
      createdAt,
    });
    // The left record: two pipeline records and twelve splits, all older
    // than anything the right record has.
    const rows = [
      op("r-l1", "resolve", left.id, null, base, { pipelineEntityId: "acc-1" }),
      op("r-l2", "resolve", left.id, null, base + 1, { pipelineEntityId: "acc-2" }),
    ];
    for (let i = 0; i < 12; i++) {
      rows.push(op(`s-l${i}`, "split", `pipe-${i}`, left.id, base + 10 + i));
    }
    rows.push(op("r-r1", "resolve", right.id, null, base + 100, { pipelineEntityId: "acc-9" }));
    rows.push(op("s-r1", "split", "pipe-r", right.id, base + 101));
    // One row per insert: D1 binds at most 100 parameters a statement.
    for (const row of rows) {
      await db().insert(schema.authorityOperations).values(row);
    }
    // Five creation entries for the left record before the right one's.
    const journal = [];
    for (let i = 0; i < 5; i++) {
      journal.push({
        id: `cl-l${i}`,
        recordId: left.id,
        recordType: "entity",
        userId: admin.id,
        diff: "{}",
        note: `left ${i}`,
        kind: "create" as const,
        createdAt: base + i,
      });
    }
    journal.push({
      id: "cl-r",
      recordId: right.id,
      recordType: "entity",
      userId: admin.id,
      diff: "{}",
      note: "right",
      kind: "create" as const,
      createdAt: base + 100,
    });
    await db().insert(schema.changelog).values(journal);

    const { data } = await load("entities", left.id, right.id);
    const l = data.left.context.origin;
    const r = data.right.context.origin;
    expect(l.pipeline.pipelineEntityId).toBe("acc-1");
    expect(l.splitFrom).toHaveLength(SPLIT_LIMIT);
    expect(l.splitFrom[0].sourceId).toBe("pipe-0");
    expect(l.journal.note).toBe("left 0");
    expect(r.pipeline.pipelineEntityId).toBe("acc-9");
    expect(r.splitFrom.map((x: any) => x.sourceId)).toEqual(["pipe-r"]);
    expect(r.journal.note).toBe("right");
  });

  it("reads the ledger and the journal through the endpoint indexes", async () => {
    const dialect = new SQLiteAsyncDialect();
    const statements = pairContextStatements({
      kind: "entities",
      tenantId: A,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      ids: ["id-a", "id-b"],
    });
    const plan = async (i: number) => {
      const q = dialect.sqlToQuery(statements[i]);
      const res = await env.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
        .bind(...q.params)
        .all<{ detail: string }>();
      return res.results.map((row) => row.detail).join("\n");
    };
    const journal = await plan(3);
    const resolve = await plan(4);
    const targets = await plan(5);
    expect(journal).toContain("changelog_record_idx");
    expect(resolve).toContain("authority_operations_source_idx");
    expect(targets).toContain("authority_operations_target_idx");
    for (const p of [resolve, targets]) {
      expect(p).not.toContain("authority_operations_federation_idx");
      expect(p).not.toMatch(/SCAN ao\b/);
    }
  });

  it("gives place pairs the same context", async () => {
    const left = await createTestPlace({ placeCode: "nl-pl1", displayName: "Santa Fe" });
    const right = await createTestPlace({ placeCode: "nl-pl2", displayName: "Santafé" });
    const other = await createTestPlace({ placeCode: "nl-pl3", displayName: "Honda" });
    const person = await createTestEntity({ entityCode: "ne-pp1", displayName: "Virrey Solís" });
    const d = await description(A, "pl-1", "Carta del virrey", "1755-03-01");
    await linkPlace(d, left.id);
    await linkPlace(d, other.id);
    await linkEntity(d, person.id, "sender");

    const { data } = await load("places", left.id, right.id);
    const l = data.left.context;
    expect(l.descriptions).toEqual([
      expect.objectContaining({
        title: "Carta del virrey",
        referenceCode: "pl-1",
        roles: ["mentioned"],
        nameAsRecorded: null,
      }),
    ]);
    expect(l.entities).toEqual([
      { id: person.id, name: "Virrey Solís", code: "ne-pp1", count: 1 },
    ]);
    expect(l.places).toEqual([
      { id: other.id, name: "Honda", code: "nl-pl3", count: 1 },
    ]);
    expect(data.right.context.descriptions).toEqual([]);
  });
});

/* @version v0.9.0 */
