/**
 * Tests — an entity merge carries the merged-away entity's functions
 *
 * This suite pins that an entity merge carries the merged-away entity's
 * functions. When two entities are merged, the function rows of the entity
 * merged away go to the survivor in the merge's own batch. A row of a
 * function the survivor does not hold moves: it keeps its id and every
 * other column and only its `entity_id` changes. A row of a function the
 * survivor holds, or that an earlier row of the loser brought (text
 * compared after trimming, collapsing whitespace and case-folding), is not
 * added a second time: the held row takes the fields it lacks and the
 * loser's row is deleted. The survivor's `updated_at` moves in the same
 * batch, and the merge's ledger row names the rows moved
 * (`movedFunctions`) and gives the rows folded (`foldedFunctions`).
 *
 * Pinned here, against the test D1:
 *
 *   - the decisions surface's merge (`rulePairMerge`) and the merge
 *     workbench's action move the rows of new functions, fold the rows
 *     of held ones, filling only empty fields, bump the survivor's
 *     version and record both in the ledger;
 *   - a merge chain: A into B, then B into C, leaves A's and B's
 *     functions on C, each once, and the second ledger row names them;
 *   - reversing a merge from its ledger rows gives the loser back
 *     exactly the rows moved and folded, columns intact, clears the
 *     fields the folds filled, and leaves the survivor's own;
 *   - a split of the survivor keeps the moved rows, ids intact, on the
 *     original and copies them to the new record; a split of a record
 *     holding a function twice copies it once;
 *   - the move is scoped: statements composed for another federation
 *     move nothing;
 *   - a function-carry ledger row (`carry: "functions"`, written by the
 *     one-off command for earlier merges) does not replace the merge
 *     in the merged-away record's band, the history or the pair view's
 *     count of records absorbed;
 *   - a merge is refused, nothing moved, when either record changes
 *     between the merge's reads and its batch: an editor save, a row
 *     swapped or added without a change of version, either record
 *     merged away; on the workbench, a loser already merged away sends
 *     the reader to its final survivor, and a survivor already merged
 *     away is replaced by its final survivor, or by none when its chain
 *     loops or ends at the loser;
 *     and a save that read a record before a merge or split in the same
 *     millisecond is refused after it.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { rulePairMerge } from "../../app/lib/pair-merge.server";
import { mergeWithEvidence, withEvidence } from "../helpers/merge-evidence";
import {
  composeMergedFunctionsReturn,
  movedEntityFunctions,
} from "../../app/lib/entity-functions.server";
import { groupFunctions } from "../../app/lib/export/entities.server";
import { logAuthorityOperation } from "../../app/lib/authority-operations.server";
import { getOperationActor, getOperationHistory } from "../../app/lib/authority-workbench.server";
import { loadPairContext } from "../../app/lib/pair-context.server";
import { authorityScope } from "../../app/lib/authority-ownership.server";
// Warm the route module graph so the in-test `await import()` resolves
// from cache (see the note in vocab-merge-split-action.test.ts).
import "../../app/routes/_auth.admin.entities.$id.merge";
import "../../app/routes/_auth.admin.entities.$id.split";
import "../../app/routes/_auth.admin.entities.$id";

function db() {
  return drizzle(env.DB, { schema });
}

/**
 * The test D1, with `change` run once just before the first batch that
 * moves function rows: what lands between a merge's reads and its batch.
 */
function d1Interleaving(change: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const moves = statements.some((s) =>
            /update "entity_functions" set "entity_id"/i.test(String((s as any).statement ?? "")),
          );
          if (moves && !done) {
            done = true;
            await change();
          }
          return target.batch(statements);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The entity editor's save of `functions` on `entityId`, at the version the form read. */
async function editorSave(user: User, entityId: string, displayName: string, functions: string, updatedAt: string) {
  const { action } = await import("../../app/routes/_auth.admin.entities.$id");
  return (await action({
    request: new Request(`http://neogranadina.fisqua.test/admin/entities/${entityId}`, {
      method: "POST",
      body: new URLSearchParams({
        _action: "update",
        displayName,
        sortName: displayName,
        entityType: "person",
        nameVariants: "[]",
        functions,
        _updatedAt: updatedAt,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    context: buildContext(user),
    params: { id: entityId },
  } as any)) as any;
}

function buildContextWith(user: User, DB: D1Database): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env: { ...env, DB } };
  return ctx;
}

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function form(fields: Record<string, string>): Request {
  return new Request("http://neogranadina.fisqua.test/admin/x", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

/** Every column of an entity's function rows, in entry order. */
async function functionRows(entityId: string) {
  return (
    await env.DB.prepare(
      "SELECT rowid AS r, * FROM entity_functions WHERE entity_id = ? ORDER BY rowid",
    )
      .bind(entityId)
      .all<Record<string, unknown>>()
  ).results;
}

async function addRow(
  entityId: string,
  id: string,
  fn: string,
  extra: Partial<{ honorific: string; dateStart: string; source: string; notes: string }> = {},
) {
  await env.DB.prepare(
    "INSERT INTO entity_functions (id, entity_id, honorific, function, date_start, date_end, date_note, certainty, source, notes, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, NULL, NULL, 'probable', ?, ?, 11, 12)",
  )
    .bind(id, entityId, extra.honorific ?? null, fn, extra.dateStart ?? null, extra.source ?? null, extra.notes ?? null)
    .run();
}

async function updatedAt(id: string): Promise<number> {
  const row = await db()
    .select({ updatedAt: schema.entities.updatedAt })
    .from(schema.entities)
    .where(eq(schema.entities.id, id))
    .get();
  return row!.updatedAt;
}

async function mergeLedger() {
  const rows = await db()
    .select()
    .from(schema.authorityOperations)
    .where(eq(schema.authorityOperations.operation, "merge"))
    .all();
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail ?? "null") }));
}

/** Drop the rowid and entity_id: what a moved row must keep. */
const content = (rows: Array<Record<string, unknown>>) =>
  rows.map(({ r: _r, entity_id: _e, ...rest }) => rest);

let admin: User;

describe("entity merges carry the merged-away entity's functions", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const user = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  });

  async function pair() {
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "Survivor" });
    await createTestEntity({ id: "ent-l", entityCode: "ne-l00001", displayName: "Loser" });
    await env.DB.prepare("UPDATE entities SET updated_at = 5 WHERE id IN ('ent-s', 'ent-l')").run();
    await addRow("ent-s", "fs-1", "Maestre de Campo");
    await addRow("ent-l", "fl-1", "Maestre de Campo", { honorific: "don", dateStart: "1650", source: "AGN" });
    await addRow("ent-l", "fl-2", "maestre de campo", { notes: "second spelling" });
    await addRow("ent-l", "fl-3", "Alcalde ordinario");
    return { loserBefore: await functionRows("ent-l") };
  }

  /** What the merge of `pair()` leaves: fs-1 filled from fl-1 and fl-2, which go; fl-3 moved. */
  async function expectFolded(now: number | null, loserBefore: Array<Record<string, unknown>>) {
    expect(await functionRows("ent-l")).toEqual([]);
    const survivorRows = await functionRows("ent-s");
    expect(survivorRows.map((r) => r.id)).toEqual(["fs-1", "fl-3"]);
    // The held row keeps its text and takes only the fields it lacked.
    expect(survivorRows[0]).toMatchObject({
      function: "Maestre de Campo", honorific: "don", date_start: "1650", source: "AGN", notes: "second spelling", created_at: 11,
    });
    if (now !== null) expect(survivorRows[0].updated_at).toBe(now);
    // A moved row keeps every column but entity_id, its own updated_at included.
    expect(content(survivorRows.slice(1))).toEqual(content(loserBefore.slice(2)));
    expect(survivorRows.every((r) => r.entity_id === "ent-s")).toBe(true);
    expect(groupFunctions(survivorRows as Array<{ function: string }>)).toEqual([
      { function: "Alcalde ordinario", count: 1 },
      { function: "Maestre de Campo", count: 1 },
    ]);
    const ledger = await mergeLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].detail.movedFunctions).toEqual(["fl-3"]);
    expect(ledger[0].detail.foldedFunctions).toEqual([
      { row: expect.objectContaining({ id: "fl-1", function: "Maestre de Campo", honorific: "don" }), into: "fs-1", filled: { honorific: "don", dateStart: "1650", source: "AGN" }, conflicts: [] },
      { row: expect.objectContaining({ id: "fl-2", function: "maestre de campo", notes: "second spelling" }), into: "fs-1", filled: { notes: "second spelling" }, conflicts: [] },
    ]);
  }

  it("the decisions surface's merge moves the rows of new functions, folds those the survivor holds, bumps the survivor and records both", async () => {
    const { loserBefore } = await pair();
    const now = Date.UTC(2026, 10, 1, 12);
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", "same person", now);
    await expectFolded(now, loserBefore);
    expect(await updatedAt("ent-s")).toBe(now);
  });

  it("a fold keeps the held row's certainty and records a different one among its conflicts", async () => {
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "Survivor" });
    await createTestEntity({ id: "ent-l", entityCode: "ne-l00001", displayName: "Loser" });
    await addRow("ent-s", "fs-1", "Cura");
    await addRow("ent-l", "fl-1", "cura", { source: "AGN" });
    await env.DB.prepare("UPDATE entity_functions SET certainty = 'certain' WHERE id = 'fl-1'").run();
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 2_000);
    expect((await functionRows("ent-s")).map((r) => [r.id, r.certainty, r.source])).toEqual([["fs-1", "probable", "AGN"]]);
    expect((await mergeLedger())[0].detail.foldedFunctions[0].conflicts).toEqual([{ field: "certainty", held: "probable", incoming: "certain" }]);
  });

  it("a fold never overwrites a field the held row has", async () => {
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "Survivor" });
    await createTestEntity({ id: "ent-l", entityCode: "ne-l00001", displayName: "Loser" });
    await addRow("ent-s", "fs-1", "Cura", { source: "AHRB" });
    await addRow("ent-l", "fl-1", "  cura ", { source: "AGN", dateStart: "1701" });
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 2_000);
    const rows = await functionRows("ent-s");
    expect(rows.map((r) => [r.id, r.function, r.source, r.date_start])).toEqual([["fs-1", "Cura", "AHRB", "1701"]]);
  });

  it("the merge workbench moves and folds the rows, bumps the survivor even without folding names, and records both", async () => {
    const pairBefore = pair().then((p) => p.loserBefore);
    await pairBefore;
    const action = withEvidence((await import("../../app/routes/_auth.admin.entities.$id.merge")).action);
    const res = (await action({
      request: form({
        _action: "merge",
        reason: "same person",
        survivorId: "ent-s",
        linkIds: "[]",
        addVariants: "false",
        _updatedAt: "5",
      }),
      context: buildContext(admin),
      params: { id: "ent-l" },
    } as any)) as Response;
    expect(res.status).toBe(302);

    await expectFolded(null, (await pairBefore)!);
    expect(await updatedAt("ent-s")).toBeGreaterThan(5);
  });

  it("a merge with no functions to move records an empty list", async () => {
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "Survivor" });
    await createTestEntity({ id: "ent-l", entityCode: "ne-l00001", displayName: "Loser" });
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 1_000);
    expect((await mergeLedger())[0].detail.movedFunctions).toEqual([]);
  });

  it("a chain: A into B, then B into C, leaves every row on C and the second ledger row names them all", async () => {
    await createTestEntity({ id: "ent-a", entityCode: "ne-a00001", displayName: "A" });
    await createTestEntity({ id: "ent-b", entityCode: "ne-b00001", displayName: "B" });
    await createTestEntity({ id: "ent-c", entityCode: "ne-c00001", displayName: "C" });
    await addRow("ent-a", "fa-1", "Escribano");
    await addRow("ent-b", "fb-1", "Escribano real");
    await addRow("ent-c", "fc-1", "Escribano");
    // Versions read before the merges' clocks, so each record takes the merge's `now`.
    await env.DB.prepare("UPDATE entities SET updated_at = 1 WHERE id IN ('ent-a', 'ent-b', 'ent-c')").run();

    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-b", "ent-a", null, 2_000);
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-c", "ent-b", null, 3_000);

    expect(await functionRows("ent-a")).toEqual([]);
    expect(await functionRows("ent-b")).toEqual([]);
    // A's "Escribano" is C's own: it folds into fc-1 instead of arriving twice.
    expect((await functionRows("ent-c")).map((r) => r.id)).toEqual(["fb-1", "fc-1"]);
    const ledger = (await mergeLedger()).sort((x, y) => x.createdAt - y.createdAt);
    expect(ledger.map((l) => [l.sourceId, l.targetId, l.detail.movedFunctions, l.detail.foldedFunctions.map((f: any) => `${f.row.id}>${f.into}`)])).toEqual([
      ["ent-a", "ent-b", ["fa-1"], []],
      ["ent-b", "ent-c", ["fb-1"], ["fa-1>fc-1"]],
    ]);
    expect(await updatedAt("ent-c")).toBe(3_000);
  });

  it("reversing a merge gives the loser back exactly the rows moved and folded, and clears what the folds filled", async () => {
    const { loserBefore } = await pair();
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 4_000);
    // The survivor gains a row of its own after the merge; it stays.
    await addRow("ent-s", "fs-2", "Regidor");

    const scope = authorityScope(schema.entities, DEFAULT_TEST_FEDERATION_ID, DEFAULT_TEST_TENANT_ID);
    const statements = await composeMergedFunctionsReturn(db(), {
      federationId: DEFAULT_TEST_FEDERATION_ID,
      loserId: "ent-l",
      survivorId: "ent-s",
      scope,
      now: 5_000,
    });
    await db().batch(statements as any);

    // Folded rows are entered again, so only their rowids differ.
    const byId = (rows: Array<Record<string, unknown>>) =>
      [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(({ r: _r, ...rest }) => rest);
    expect(byId(await functionRows("ent-l"))).toEqual(byId(loserBefore));
    const survivorRows = await functionRows("ent-s");
    expect(survivorRows.map((r) => r.id)).toEqual(["fs-1", "fs-2"]);
    expect(survivorRows[0]).toMatchObject({ honorific: null, date_start: null, source: null, notes: null });
    expect(await updatedAt("ent-l")).toBe(5_000);
    expect(await updatedAt("ent-s")).toBe(5_000);
  });

  it("reversing a merge clears a fill on a loser row that moved, before moving it back", async () => {
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "Survivor" });
    await createTestEntity({ id: "ent-l", entityCode: "ne-l00001", displayName: "Loser" });
    await addRow("ent-l", "fl-1", "Cura");
    await addRow("ent-l", "fl-2", "cura", { source: "AGN" });
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 4_000);
    expect((await functionRows("ent-s")).map((r) => [r.id, r.source])).toEqual([["fl-1", "AGN"]]);
    const scope = authorityScope(schema.entities, DEFAULT_TEST_FEDERATION_ID, DEFAULT_TEST_TENANT_ID);
    await db().batch((await composeMergedFunctionsReturn(db(), {
      federationId: DEFAULT_TEST_FEDERATION_ID, loserId: "ent-l", survivorId: "ent-s", scope, now: 5_000,
    })) as any);
    const back = (await functionRows("ent-l")).map((r) => [r.id, r.source]).sort();
    expect(back).toEqual([["fl-1", null], ["fl-2", "AGN"]]);
    expect(await functionRows("ent-s")).toEqual([]);
  });

  it("a split of the survivor keeps the moved rows on the original and copies them to the new record", async () => {
    await pair();
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 6_000);
    const merged = await functionRows("ent-s");

    const { action } = await import("../../app/routes/_auth.admin.entities.$id.split");
    await action({
      request: form({
        _action: "split",
        reason: "two people after all",
        nameA: "Survivor",
        nameB: "Loser again",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "original",
          viafId: "original",
          dbeId: "original",
          "variant:0": "new",
        }),
        linkIds: "[]",
        _updatedAt: String(await updatedAt("ent-s")),
      }),
      context: buildContext(admin),
      params: { id: "ent-s" },
    } as any);

    expect(await functionRows("ent-s")).toEqual(merged);
    const split = await db()
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.operation, "split"))
      .get();
    const copies = await functionRows(split!.targetId!);
    expect(copies.map((r) => r.function)).toEqual(merged.map((r) => r.function));
    expect(copies.some((r) => merged.some((m) => m.id === r.id))).toBe(false);
  });

  it("a split of a record holding a function twice copies it once, with the fields of both", async () => {
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "Survivor" });
    await addRow("ent-s", "fs-1", "Cura");
    await addRow("ent-s", "fs-2", "cura", { source: "AGN" });
    await addRow("ent-s", "fs-3", "Alcalde");
    const { action } = await import("../../app/routes/_auth.admin.entities.$id.split");
    await action({
      request: form({
        _action: "split",
        reason: "two people",
        nameA: "Survivor",
        nameB: "Survivor bis",
        choices: JSON.stringify({ datesOfExistence: "original", history: "original", wikidataId: "original", viafId: "original", dbeId: "original" }),
        linkIds: "[]",
        _updatedAt: String(await updatedAt("ent-s")),
      }),
      context: buildContext(admin),
      params: { id: "ent-s" },
    } as any);
    // The original keeps its own rows as they were.
    expect((await functionRows("ent-s")).map((r) => r.id)).toEqual(["fs-1", "fs-2", "fs-3"]);
    const split = await db().select().from(schema.authorityOperations).where(eq(schema.authorityOperations.operation, "split")).get();
    const copies = await functionRows(split!.targetId!);
    expect(copies.map((r) => [r.function, r.source])).toEqual([["Cura", "AGN"], ["Alcalde", null]]);
  });

  it("moves nothing when the statements are scoped to another federation", async () => {
    await pair();
    const scope = and(eq(schema.entities.federationId, "another-federation"));
    const statements = movedEntityFunctions(db(), "ent-l", "ent-s", ["fl-1", "fl-2", "fl-3"], scope);
    await db().batch(statements as any);
    expect((await functionRows("ent-l")).map((r) => r.id)).toEqual(["fl-1", "fl-2", "fl-3"]);
  });

  it("a function-carry ledger row does not replace the merge in the merged-away record's band", async () => {
    await pair();
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-s", "ent-l", null, 7_000);
    await db().batch([
      logAuthorityOperation(db(), {
        federationId: DEFAULT_TEST_FEDERATION_ID,
        recordType: "entity",
        operation: "merge",
        sourceId: "ent-l",
        targetId: "ent-s",
        userId: admin.id,
        detail: { carry: "functions", movedFunctions: [] },
        now: 8_000,
      }),
    ] as any);
    const actor = await getOperationActor(db(), {
      recordType: "entity",
      operation: "merge",
      sourceId: "ent-l",
      targetId: "ent-s",
    });
    expect(actor!.createdAt).toBe(7_000);
  });
});

describe("a merge is refused when a side changes between its reads and its batch", () => {
  // The editor's form validation wants uuids.
  const S = "11111111-1111-4111-8111-111111111111";
  const L = "22222222-2222-4222-8222-222222222222";
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const user = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  });

  async function pair() {
    await createTestEntity({ id: S, entityCode: "ne-s00001", displayName: "Survivor" });
    await createTestEntity({ id: L, entityCode: "ne-l00001", displayName: "Loser" });
    await env.DB.prepare("UPDATE entities SET updated_at = 5 WHERE id IN (?, ?)").bind(S, L).run();
    await addRow(S, "fs-1", "Maestre de Campo");
    await addRow(L, "fl-1", "Maestre de Campo");
    await addRow(L, "fl-2", "Alcalde ordinario");
  }

  /** The editor replaces "Alcalde ordinario" on the loser: fl-2 goes, a new row comes. */
  const editLoser = async () => {
    const res = await editorSave(admin, L, "Loser", "Maestre de Campo\nAlcalde mayor", "5");
    expect(res).toMatchObject({ ok: true });
  };

  async function expectNothingMerged(loserRows: string[]) {
    expect((await functionRows(L)).map((r) => r.function)).toEqual(loserRows);
    expect((await functionRows(S)).map((r) => r.id)).toEqual(["fs-1"]);
    expect(await mergeLedger()).toEqual([]);
    const loser = await db().select().from(schema.entities).where(eq(schema.entities.id, L)).get();
    expect(loser!.mergedInto).toBeNull();
  }

  it("the decisions surface's merge: an editor replacement on the loser rejects it with a 409 and nothing moves", async () => {
    await pair();
    const racing = drizzle(d1Interleaving(editLoser), { schema });
    const err = await mergeWithEvidence(racing, admin, makeTenantContext(), "entity", S, L, null, 9_000).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(409);
    await expectNothingMerged(["Maestre de Campo", "Alcalde mayor"]);
    const decisions = await db().select().from(schema.pendingDecisions).all();
    expect(decisions.every((d) => d.status === "open")).toBe(true);
  });

  it("the decisions surface's merge: an edit of the survivor rejects it with a 409 and nothing moves", async () => {
    await pair();
    const racing = drizzle(
      d1Interleaving(() => editorSave(admin, S, "Survivor", "Maestre de Campo\nRegidor", "5")),
      { schema },
    );
    const err = await mergeWithEvidence(racing, admin, makeTenantContext(), "entity", S, L, null, 9_000).then(
      () => null,
      (e) => e,
    );
    expect((err as Response).status).toBe(409);
    expect((await functionRows(L)).map((r) => r.id)).toEqual(["fl-1", "fl-2"]);
    expect((await functionRows(S)).map((r) => r.function)).toEqual(["Maestre de Campo", "Regidor"]);
    expect(await mergeLedger()).toEqual([]);
  });

  it("the merge workbench: an editor replacement on the loser returns the conflict and nothing moves", async () => {
    await pair();
    const action = withEvidence((await import("../../app/routes/_auth.admin.entities.$id.merge")).action);
    const res = (await action({
      request: form({
        _action: "merge",
        reason: "same person",
        survivorId: S,
        linkIds: "[]",
        addVariants: "true",
        _updatedAt: "5",
      }),
      context: buildContextWith(admin, d1Interleaving(editLoser)),
      params: { id: L },
    } as any)) as any;
    expect(res).toMatchObject({ ok: false, error: "conflict" });
    expect(res.modifiedAt).toBe(await updatedAt(L));
    await expectNothingMerged(["Maestre de Campo", "Alcalde mayor"]);
  });

  /**
   * A save in the same millisecond as the version read: fl-2 is replaced
   * by a new row, the count and `updated_at` stay as they were.
   */
  const swapLoserRow = async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM entity_functions WHERE id = 'fl-2'"),
      env.DB.prepare(
        "INSERT INTO entity_functions (id, entity_id, function, certainty, created_at, updated_at) VALUES ('fl-x', ?, 'Alcalde mayor', 'probable', 5, 5)",
      ).bind(L),
    ]);
  };

  it("the decisions surface's merge: a same-millisecond swap of a loser row rejects it with a 409 and nothing moves", async () => {
    await pair();
    const racing = drizzle(d1Interleaving(swapLoserRow), { schema });
    const err = await mergeWithEvidence(racing, admin, makeTenantContext(), "entity", S, L, null, 9_000).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(409);
    expect(await updatedAt(L)).toBe(5);
    expect((await functionRows(L)).map((r) => r.id)).toEqual(["fl-1", "fl-x"]);
    await expectNothingMerged(["Maestre de Campo", "Alcalde mayor"]);
  });

  it("the merge workbench: a same-millisecond swap of a loser row returns the conflict and nothing moves", async () => {
    await pair();
    const action = withEvidence((await import("../../app/routes/_auth.admin.entities.$id.merge")).action);
    const res = (await action({
      request: form({
        _action: "merge",
        reason: "same person",
        survivorId: S,
        linkIds: "[]",
        addVariants: "true",
        _updatedAt: "5",
      }),
      context: buildContextWith(admin, d1Interleaving(swapLoserRow)),
      params: { id: L },
    } as any)) as any;
    expect(res).toMatchObject({ ok: false, error: "conflict", modifiedAt: 5 });
    await expectNothingMerged(["Maestre de Campo", "Alcalde mayor"]);
  });

  it("the decisions surface's merge at the clock of the version read: a stale editor save on the loser is refused", async () => {
    await pair();
    // The merge commits in the same millisecond as the version the
    // editor read; the editor's batch comes after it.
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", S, L, null, 5);
    expect(await updatedAt(L)).toBeGreaterThan(5);
    expect(await updatedAt(S)).toBeGreaterThan(5);
    const stale = await editorSave(admin, L, "Loser", "Maestre de Campo\nAlcalde mayor", "5");
    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect(await functionRows(L)).toEqual([]);
    // fl-1 is a function S holds: it folded into fs-1.
    expect((await functionRows(S)).map((r) => r.id)).toEqual(["fs-1", "fl-2"]);
  });

  it("the merge workbench at the clock of the version read: a stale editor save on the loser is refused", async () => {
    await pair();
    const action = withEvidence((await import("../../app/routes/_auth.admin.entities.$id.merge")).action);
    const clock = vi.spyOn(Date, "now").mockReturnValue(5);
    try {
      const res = (await action({
        request: form({
          _action: "merge",
          reason: "same person",
          survivorId: S,
          linkIds: "[]",
          addVariants: "false",
          _updatedAt: "5",
        }),
        context: buildContext(admin),
        params: { id: L },
      } as any)) as Response;
      expect(res.status).toBe(302);
    } finally {
      clock.mockRestore();
    }
    expect(await updatedAt(L)).toBeGreaterThan(5);
    expect(await updatedAt(S)).toBeGreaterThan(5);
    const stale = await editorSave(admin, L, "Loser", "Maestre de Campo\nAlcalde mayor", "5");
    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect(await functionRows(L)).toEqual([]);
  });

  it("a split at the clock of the version read: a stale editor save on the original is refused", async () => {
    await pair();
    const { action } = await import("../../app/routes/_auth.admin.entities.$id.split");
    const clock = vi.spyOn(Date, "now").mockReturnValue(5);
    try {
      await action({
        request: form({
          _action: "split",
          reason: "two people",
          nameA: "Survivor",
          nameB: "Survivor bis",
          choices: JSON.stringify({
            datesOfExistence: "original",
            history: "original",
            wikidataId: "original",
            viafId: "original",
            dbeId: "original",
          }),
          linkIds: "[]",
          _updatedAt: "5",
        }),
        context: buildContext(admin),
        params: { id: S },
      } as any);
    } finally {
      clock.mockRestore();
    }
    expect(await updatedAt(S)).toBeGreaterThan(5);
    const stale = await editorSave(admin, S, "Survivor", "Regidor", "5");
    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect((await functionRows(S)).map((r) => r.id)).toEqual(["fs-1"]);
  });

  /** The workbench's merge of L into S, on `DB`. */
  async function workbenchMerge(DB: D1Database = env.DB) {
    const action = withEvidence((await import("../../app/routes/_auth.admin.entities.$id.merge")).action);
    return (await action({
      request: form({
        _action: "merge",
        reason: "same person",
        survivorId: S,
        linkIds: "[]",
        addVariants: "true",
        _updatedAt: "5",
      }),
      context: buildContextWith(admin, DB),
      params: { id: L },
    } as any)) as any;
  }

  async function expectNothingMoved() {
    expect((await functionRows(L)).map((r) => r.id)).toEqual(["fl-1", "fl-2"]);
    expect((await functionRows(S)).map((r) => r.id)).toEqual(["fs-1"]);
    expect(await mergeLedger()).toEqual([]);
  }

  /** The workbench's loader for L, with `survivor` in the URL. */
  async function workbenchLoad(loserId: string, survivor?: string) {
    const { loader } = await import("../../app/routes/_auth.admin.entities.$id.merge");
    const url = `http://neogranadina.fisqua.test/admin/entities/${loserId}/merge${survivor ? `?survivor=${survivor}` : ""}`;
    return loader({ request: new Request(url), context: buildContext(admin), params: { id: loserId } } as any).then(
      (data) => data as any,
      (thrown) => thrown,
    );
  }

  const T = "33333333-3333-4333-8333-333333333333";
  const U = "44444444-4444-4444-8444-444444444444";
  const third = () => createTestEntity({ id: T, entityCode: "ne-t00001", displayName: "Third" });
  const mergedInto = (id: string, into: string) =>
    env.DB.prepare("UPDATE entities SET merged_into = ? WHERE id = ?").bind(into, id).run();

  it("the merge workbench, when the survivor was merged away, reopens on its final survivor, where the merge works", async () => {
    await pair();
    await third();
    await createTestEntity({ id: U, entityCode: "ne-u00001", displayName: "Fourth" });
    await env.DB.prepare("UPDATE entities SET updated_at = 5 WHERE id IN (?, ?)").bind(T, U).run();
    // S was merged into T, and T into U, while the workbench was open.
    await mergedInto(S, T);
    await mergedInto(T, U);
    const res = await workbenchMerge();
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("Location")).toBe(`/admin/entities/${L}/merge?survivor=${U}`);
    await expectNothingMoved();

    // The page it lands on offers U, and the merge into U goes through.
    const page = await workbenchLoad(L, U);
    expect(page.survivor.id).toBe(U);
    const action = withEvidence((await import("../../app/routes/_auth.admin.entities.$id.merge")).action);
    const merged = (await action({
      request: form({ _action: "merge", reason: "same person", survivorId: U, linkIds: "[]", addVariants: "true", _updatedAt: "5" }),
      context: buildContext(admin),
      params: { id: L },
    } as any)) as Response;
    expect(merged.headers.get("Location")).toBe(`/admin/entities/${U}`);
    expect((await functionRows(U)).map((r) => r.id)).toEqual(["fl-1", "fl-2"]);
  });

  it("the merge workbench, when the survivor was merged into the loser, reopens without a survivor and merges nothing", async () => {
    await pair();
    await mergedInto(S, L);
    const res = (await workbenchMerge()) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/entities/${L}/merge`);
    expect((await functionRows(L)).map((r) => r.id)).toEqual(["fl-1", "fl-2"]);
    expect(await mergeLedger()).toEqual([]);
  });

  it("the merge workbench, when the loser was merged away, goes to the loser's final survivor", async () => {
    await pair();
    await third();
    await mergedInto(L, T);
    const res = (await workbenchMerge()) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/entities/${T}`);
    await expectNothingMoved();
  });

  it("the workbench's loader follows a merged survivor to its final survivor, and sends a merged loser to its own", async () => {
    await pair();
    await third();
    await mergedInto(S, T);
    expect((await workbenchLoad(L, S)).survivor.id).toBe(T);
    // A chain that loops, or ends at the loser, offers no survivor.
    await mergedInto(T, S);
    expect((await workbenchLoad(L, S)).survivor).toBeNull();
    await mergedInto(T, L);
    expect((await workbenchLoad(L, S)).survivor).toBeNull();

    await mergedInto(L, T);
    await env.DB.prepare("UPDATE entities SET merged_into = NULL WHERE id = ?").bind(T).run();
    const sent = (await workbenchLoad(L, S)) as Response;
    expect(sent.status).toBe(302);
    expect(sent.headers.get("Location")).toBe(`/admin/entities/${T}`);
  });

  /** Another merge takes `id` away between the reads and the batch, its version unchanged. */
  const mergeAway = (id: string) => async () => {
    await createTestEntity({ id: "ent-t", entityCode: "ne-t00001", displayName: "Third" });
    await env.DB.prepare("UPDATE entities SET merged_into = 'ent-t' WHERE id = ?").bind(id).run();
  };

  it("both web merges refuse, in the batch, a survivor or loser merged away between the reads and the batch", async () => {
    for (const away of [S, L]) {
      await cleanDatabase();
      const user = await createTestUser({ isAdmin: true });
      admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
      await pair();
      const err = await mergeWithEvidence(
        drizzle(d1Interleaving(mergeAway(away)), { schema }), admin, makeTenantContext(), "entity", S, L, null, 9_000,
      ).then(() => null, (e) => e);
      expect((err as Response).status).toBe(409);
      await expectNothingMoved();

      await cleanDatabase();
      const user2 = await createTestUser({ isAdmin: true });
      admin = makeUserContext({ id: user2.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
      await pair();
      expect(await workbenchMerge(d1Interleaving(mergeAway(away)))).toMatchObject({ ok: false, error: "conflict" });
      await expectNothingMoved();
    }
  });

  it("the decisions surface's merge: a function row added to the loser between the reads and the batch, version unchanged, rejects it", async () => {
    await pair();
    const addRaw = () =>
      env.DB.prepare(
        "INSERT INTO entity_functions (id, entity_id, function, certainty, created_at, updated_at) VALUES ('fl-new', ?, 'Regidor', 'probable', 5, 5)",
      ).bind(L).run();
    const err = await mergeWithEvidence(
      drizzle(d1Interleaving(addRaw), { schema }), admin, makeTenantContext(), "entity", S, L, null, 9_000,
    ).then(() => null, (e) => e);
    expect((err as Response).status).toBe(409);
    expect((await functionRows(L)).map((r) => r.id)).toEqual(["fl-1", "fl-2", "fl-new"]);
    expect((await functionRows(S)).map((r) => r.id)).toEqual(["fs-1"]);
    expect(await mergeLedger()).toEqual([]);
  });

  it("moves every row across the chunk boundary of the move", async () => {
    for (const n of [80, 81]) {
      await cleanDatabase();
      const user = await createTestUser({ isAdmin: true });
      admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
      await createTestEntity({ id: S, entityCode: "ne-s00001", displayName: "Survivor" });
      await createTestEntity({ id: L, entityCode: "ne-l00001", displayName: "Loser" });
      const ids = Array.from({ length: n }, (_, i) => `fl-${String(i).padStart(3, "0")}`);
      for (const id of ids) await addRow(L, id, `Regidor ${id}`);
      await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", S, L, null, 10_000);
      expect(await functionRows(L)).toEqual([]);
      expect((await functionRows(S)).map((r) => r.id)).toEqual(ids);
      expect((await mergeLedger())[0].detail.movedFunctions).toEqual(ids);
    }
  });

  it("folds every row of a held function across the chunk boundary of the delete", async () => {
    for (const n of [80, 81]) {
      await cleanDatabase();
      const user = await createTestUser({ isAdmin: true });
      admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
      await createTestEntity({ id: S, entityCode: "ne-s00001", displayName: "Survivor" });
      await createTestEntity({ id: L, entityCode: "ne-l00001", displayName: "Loser" });
      await addRow(S, "fs-1", "Regidor");
      const ids = Array.from({ length: n }, (_, i) => `fl-${String(i).padStart(3, "0")}`);
      for (const id of ids) await addRow(L, id, "Regidor");
      await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", S, L, null, 10_000);
      expect(await functionRows(L)).toEqual([]);
      expect((await functionRows(S)).map((r) => r.id)).toEqual(["fs-1"]);
      const detail = (await mergeLedger())[0].detail;
      expect(detail.movedFunctions).toEqual([]);
      expect(detail.foldedFunctions.map((f: any) => f.row.id)).toEqual(ids);
    }
  });
});

describe("function-carry ledger rows are not merges", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const user = await createTestUser({ isAdmin: true });
    admin = makeUserContext({ id: user.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  });

  /** A carry ledger row as the one-off command writes it. */
  const carryRow = (sourceId: string, targetId: string, now: number) =>
    logAuthorityOperation(db(), {
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "merge",
      sourceId,
      targetId,
      userId: admin.id,
      detail: { reason: "carried", carry: "functions", movedLinks: 0, droppedLinks: [], movedFunctions: ["f-1"] },
      now,
    });

  async function chain() {
    await createTestEntity({ id: "ent-a", entityCode: "ne-a00001", displayName: "A" });
    await createTestEntity({ id: "ent-b", entityCode: "ne-b00001", displayName: "B" });
    await createTestEntity({ id: "ent-c", entityCode: "ne-c00001", displayName: "C" });
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-b", "ent-a", null, 2_000);
    await mergeWithEvidence(db(), admin, makeTenantContext(), "entity", "ent-c", "ent-b", null, 3_000);
    // The carry for a chain: A's rows go to C, the end of the chain.
    await db().batch([carryRow("ent-a", "ent-c", 9_000), carryRow("ent-b", "ent-c", 9_000)] as any);
  }

  const history = (recordId: string) =>
    getOperationHistory(db(), { federationId: DEFAULT_TEST_FEDERATION_ID, recordType: "entity", recordId });

  it("the history of each record in a chain shows its real merges only", async () => {
    await chain();
    const a = await history("ent-a");
    expect(a.total).toBe(1);
    expect(a.rows.map((r) => [r.operation, r.direction, r.counterpartId, r.createdAt])).toEqual([
      ["merge", "source", "ent-b", 2_000],
    ]);
    const c = await history("ent-c");
    expect(c.total).toBe(1);
    expect(c.rows.map((r) => [r.direction, r.counterpartId, r.createdAt])).toEqual([["target", "ent-b", 3_000]]);
    const b = await history("ent-b");
    expect(b.total).toBe(2);
    expect(b.rows.map((r) => r.counterpartId)).toEqual(["ent-c", "ent-a"]);
  });

  it("the pair view counts the records a survivor absorbed without the carry rows", async () => {
    await chain();
    const context = await loadPairContext(db(), {
      kind: "entities",
      tenantId: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      seeds: [
        { id: "ent-c", createdAt: 1, legacyIds: null },
        { id: "ent-b", createdAt: 1, legacyIds: null },
      ],
    });
    expect(context["ent-c"].origin.absorbed).toEqual({ count: 1, latestAt: 3_000 });
    expect(context["ent-b"].origin.absorbed).toEqual({ count: 1, latestAt: 2_000 });
  });
});

/* @version v0.9.0 */
