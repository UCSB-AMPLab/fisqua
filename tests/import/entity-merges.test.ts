/**
 * Tests — applying the reviewed list of entity merges
 *
 * This suite pins `scripts/lib/entity-merges.ts`, the planning and SQL
 * behind `scripts/commands/entity-merges.ts`. Lists and entities are
 * built here; the SQL runs against in-memory `node:sqlite` databases
 * holding the columns the statements touch, with D1's expression depth
 * limit of 100. Nothing here reaches D1.
 *
 *   - the list: MATCH rows merge; rows whose precondition names a link
 *     to detach, and #2, are held; NOT-MATCH and DOUBTFUL are counted;
 *     a `name_variants_remove` entry loses its annotation;
 *   - refusals: a code not found, codes that are not the row's pair, a
 *     loser listed twice, a loser already merged, a survivor itself
 *     merged, two different ids of one kind, ids to carry, a slip
 *     neither record holds, and variants that differ from the list's;
 *   - names: the review's slips stay out of the survivor's variants,
 *     whether the survivor or the loser holds them, and the survivor's
 *     label is not kept among its own variants;
 *   - the SQL: the statements `pair-merge.server.ts` composes, run
 *     through Drizzle against one database and as the rendered file
 *     against another, leave identical tables; links move or drop on
 *     the same description and role; the loser is merged with its
 *     provenance line; the relabelled survivor keeps its sort name and
 *     leaves its old label, a slip, out of its variants; each pair has
 *     a ledger row; journal before-images are the stored values; an entity or link changed
 *     after the read fails the file; another tenant's links stay on the
 *     loser and its link counts do not trip the guards; 150 merges apply under the depth
 *     limit; long fields are packed under the byte budget, and a row too
 *     long for any statement is reported;
 *   - functions: each loser's `entity_functions` rows of functions its
 *     survivor does not hold move to it with their ids and columns, the
 *     ledger row names them (`movedFunctions`); a row of a function the
 *     survivor holds, case and spacing aside, fills the held row's empty
 *     fields, keeps every field it has, and is deleted, and the ledger
 *     row gives it (`foldedFunctions`); a survivor's row changed after
 *     the read fails the file; the survivor takes the run's `now`, every
 *     merged record's version moves past the one read even when that is
 *     at or after `now`, and a
 *     function row added to or taken from a loser after the read fails
 *     the file.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { resolveCommandActor } from "../../scripts/lib/authority-links";
import { reader, seedActing, stewardMembership } from "./acting-tables";
import { drizzle } from "drizzle-orm/d1";
import {
  buildEntityStatements,
  mergeLinkCollisions,
  junctionRowOf,
  LINK_COLUMNS,
  pointingLinksSql,
  staleNamingSql,
  planEntityMerges,
  readEntityMergeList,
  storedOfEntity,
  type EntityMergeRow,
  type EntityRow,
  type StoredEntity,
} from "../../scripts/lib/entity-merges";
import { STATEMENT_BUDGET, inTenantDescriptions, parseMergeArgs, typed } from "../../scripts/lib/authority-merges";
import type { EntityFunctionRow } from "../../app/lib/entity-functions.server";
import type { JunctionRow } from "../../app/lib/pair-merge.server";

const FED = "fed-1";
/** D1 caps expression depth at 100 (SQLite defaults to 1000); the Node typings in use do not list `limits`. */
const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

const HEADER =
  "pair,score,reason_kind,decision,code_a,name_a,code_b,name_b,survivor_code,loser_code,label_to_keep,label_reason," +
  "name_variants_add,name_variants_remove,ids_to_carry,ids_not_carried,links_moving,precondition,split_flag," +
  "suggested_survivor,survivor_override,reason,evidence_summary,knowledge_not_d1";

function csv(lines: Array<Partial<Record<string, string>>>): Uint8Array {
  const cols = HEADER.split(",");
  const body = lines.map((f) => cols.map((c) => {
    const v = f[c] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","));
  return new TextEncoder().encode([HEADER, ...body].join("\n") + "\n");
}

function entity(code: string, name: string, over: Partial<EntityRow> = {}): EntityRow {
  return {
    id: `id-${code}`, federationId: FED, tenantId: null, code, displayName: name, sortName: name, nameVariants: "[]",
    mergedInto: null, wikidataId: null, viafId: null, dbeId: null, sources: null, updatedAt: 1, ...over,
  };
}

function row(over: Partial<EntityMergeRow>): EntityMergeRow {
  const base: EntityMergeRow = {
    ref: "#1", pair: "1", codeA: "", codeB: "", survivorCode: "", loserCode: "", labelToKeep: "", add: [], remove: [],
    idsToCarry: "", idsNotCarried: "", precondition: "",
  };
  const r = { ...base, ...over };
  return { ...r, ref: `#${r.pair}`, codeA: r.codeA || r.survivorCode, codeB: r.codeB || r.loserCode };
}

const index = (list: EntityRow[]) => {
  const m = new Map<string, EntityRow[]>();
  for (const e of list) m.set(e.code, [...(m.get(e.code) ?? []), e]);
  return m;
};

function link(id: string, entityId: string, descriptionId: string, over: Partial<JunctionRow> = {}): JunctionRow {
  return {
    id, descriptionId, entityId, role: "mentioned", roleNote: null, roleRaw: null, sequence: 0, honorific: null,
    attributes: "{}", nameAsRecorded: null, createdAt: 1000, relatedTo: null, relationCertainty: null, ...over,
  };
}

// ---------------------------------------------------------------------------
// The fixture: #16 relabels Joseph Escavar to Joseph Escovar and keeps the
// old label, a slip, out of the variants; #15 drops the survivor's slip
// "Gregori0 Paniso"; #129 drops the loser's slip name.
// ---------------------------------------------------------------------------

const escavar = entity("ne-esca01", "Joseph Escavar", { nameVariants: '["Jph. Escavar"]', sources: "" });
const escovar = entity("ne-esco01", "Joseph Escovar", { nameVariants: '["Joseph Escobar"]', sources: "" });
const gregorio = entity("ne-greg01", "Gregorio Paniso", { nameVariants: '["Gregori0 Paniso"]' });
const gregario = entity("ne-grga01", "Gregario Paniso", { nameVariants: '["Gregario Panizo"]', sources: "Libro 3" });
const juana = entity("ne-juan01", "Juana Castaño");
const juanA = entity("ne-juaa01", "Juan A Castaño");
const fixtureEntities = [escavar, escovar, gregorio, gregario, juana, juanA];

const fixtureRows: EntityMergeRow[] = [
  row({ pair: "16", survivorCode: escavar.code, loserCode: escovar.code, labelToKeep: "Joseph Escovar", add: ["Joseph Escavar", "Joseph Escobar"] }),
  row({ pair: "15", survivorCode: gregorio.code, loserCode: gregario.code, labelToKeep: "Gregorio Paniso", add: ["Gregario Paniso", "Gregario Panizo"] }),
  row({ pair: "129", survivorCode: juana.code, loserCode: juanA.code, labelToKeep: "Juana Castaño", add: ["Juan A Castaño"] }),
];

const fixtureLinks = [
  link("de-1", escovar.id, "d1"),
  link("de-2", escovar.id, "d2"),
  link("de-3", escavar.id, "d2"), // Escavar already holds d2 as mentioned: de-2 drops
  link("de-4", juanA.id, "d3", { role: "subject", sequence: 2, nameAsRecorded: "Juan A Castaño", roleNote: "firma" }),
  link("de-5", gregario.id, "d4", { role: "author", honorific: "don", attributes: '{"office":"escribano"}' }),
];

function byEntity(links: JunctionRow[]): Map<string, JunctionRow[]> {
  const m = new Map<string, JunctionRow[]>();
  for (const l of links) m.set(l.entityId as string, [...(m.get(l.entityId as string) ?? []), l]);
  return m;
}

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, entity_code TEXT,
  display_name TEXT NOT NULL, sort_name TEXT NOT NULL, name_variants TEXT DEFAULT '[]', merged_into TEXT, wikidata_id TEXT,
  viaf_id TEXT, dbe_id TEXT, sources TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  role TEXT NOT NULL, role_note TEXT, role_raw TEXT, sequence INTEGER NOT NULL DEFAULT 0, honorific TEXT,
  name_as_recorded TEXT, created_at INTEGER NOT NULL, related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION, relation_certainty TEXT,
  attributes TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX de_unique_idx ON description_entities (description_id, entity_id, role, COALESCE(related_to, ''));
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL,
  note TEXT, diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE TABLE authority_operations (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, record_type TEXT NOT NULL,
  operation TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT, user_id TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
CREATE TABLE entity_functions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, honorific TEXT, function TEXT NOT NULL,
  date_start TEXT, date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- Every description a link names belongs to TENANT unless a test seeds it
-- under another tenant first.
CREATE TRIGGER link_description AFTER INSERT ON description_entities BEGIN
  INSERT OR IGNORE INTO descriptions (id, tenant_id) VALUES (NEW.description_id, 't-1');
END;
`;

function seed(db: DatabaseSync, list: EntityRow[], links: JunctionRow[]): void {
  const ins = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, name_variants, merged_into, " +
      "wikidata_id, viaf_id, dbe_id, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
  );
  for (const e of list) {
    const st = storedOfEntity(e);
    ins.run(e.id, e.federationId, st.tenant_id, st.entity_code, st.display_name, st.sort_name, st.name_variants, st.merged_into,
      st.wikidata_id, st.viaf_id, st.dbe_id, st.sources, st.updated_at);
  }
  const l = db.prepare(
    "INSERT INTO description_entities (id, description_id, entity_id, role, role_note, role_raw, sequence, honorific, attributes, " +
      "name_as_recorded, created_at, related_to, relation_certainty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // related_to is set once every link is in: it is a foreign key to the table.
  for (const x of links) {
    l.run(x.id, x.descriptionId, x.entityId as string, x.role, x.roleNote as string | null, x.roleRaw as string | null,
      x.sequence as number, x.honorific as string | null, x.attributes as string, x.nameAsRecorded as string | null,
      x.createdAt as number, null, x.relationCertainty as string | null);
  }
  const r = db.prepare("UPDATE description_entities SET related_to = ? WHERE id = ?");
  for (const x of links) if (x.relatedTo) r.run(x.relatedTo as string, x.id);
}

function database(list = fixtureEntities, links = fixtureLinks): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  seed(db, list, links);
  return db;
}

/** A D1 binding over node:sqlite, enough for Drizzle to run one statement at a time. */
function d1(db: DatabaseSync): any {
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...p: unknown[]) => statement(sql, p),
    run: async () => {
      const r = db.prepare(sql).run(...(params as any[]));
      return { success: true, results: [], meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...(params as any[])), meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql) };
}

const dump = (db: DatabaseSync) =>
  Object.fromEntries(
    ["entities", "description_entities", "changelog", "authority_operations", "entity_functions"].map((t) => [
      t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all(),
    ]),
  );

/** Run the file as D1 does, as one unit: a failing guard leaves nothing written. */
function applyAsOneUnit(db: DatabaseSync, sql: string[]): void {
  db.exec("BEGIN");
  try {
    db.exec(sql.join("\n"));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const opts = { userId: "user_001", now: 1_761_336_000_000, tenantId: "t-1" };

describe("the list", () => {
  it("merges MATCH rows, holds those waiting on a detached link and #2, and counts the rest", () => {
    const list = readEntityMergeList(csv([
      { pair: "1", decision: "MATCH", code_a: "ne-a", code_b: "ne-b", survivor_code: "ne-a", loser_code: "ne-b", name_variants_add: "B | B2" },
      { pair: "2", decision: "MATCH", code_a: "ne-c", code_b: "ne-d", survivor_code: "ne-c", loser_code: "ne-d" },
      { pair: "27", decision: "MATCH", code_a: "ne-e", code_b: "ne-f", survivor_code: "ne-e", loser_code: "ne-f", precondition: "Detach A's 1662 link first." },
      { pair: "35", decision: "MATCH", code_a: "ne-g", code_b: "ne-h", survivor_code: "ne-g", loser_code: "ne-h", name_variants_remove: "Juan Francisco (now the label)" },
      { pair: "10", decision: "DOUBTFUL" },
      { pair: "24", decision: "NOT-MATCH" },
    ]));
    expect(list.rows.map((r) => r.ref)).toEqual(["#1", "#35"]);
    expect(list.rows[0].add).toEqual(["B", "B2"]);
    expect(list.rows[1].remove).toEqual(["Juan Francisco"]);
    expect(list.held.map((h) => h.ref)).toEqual(["#2", "#27"]);
    expect(list.held[1].why).toContain("Detach A's 1662 link");
    expect(list.skipped).toEqual({ DOUBTFUL: 1, "NOT-MATCH": 1 });
  });
});

describe("refusals", () => {
  const reasons = (rows: EntityMergeRow[], list: EntityRow[]) => planEntityMerges(rows, index(list)).refusals.map((r) => r.reason);

  it("passes the fixture", () => {
    expect(reasons(fixtureRows, fixtureEntities)).toEqual([]);
  });

  it("refuses a code not found, and codes that are not the row's pair", () => {
    expect(reasons([row({ survivorCode: "ne-a", loserCode: "ne-x" })], [entity("ne-a", "A")])).toContain("loser ne-x not found");
    expect(reasons([row({ codeA: "ne-a", codeB: "ne-b", survivorCode: "ne-a", loserCode: "ne-c" })], [entity("ne-a", "A"), entity("ne-c", "C")]))
      .toContain("survivor ne-a and loser ne-c are not the pair ne-a / ne-b");
  });

  it("refuses a loser listed twice, a loser already merged and a survivor itself merged", () => {
    const list = [entity("ne-a", "A", { mergedInto: "id-z" }), entity("ne-b", "B", { mergedInto: "id-y" }), entity("ne-c", "C")];
    const r = reasons([
      row({ survivorCode: "ne-a", loserCode: "ne-b" }),
      row({ pair: "2", survivorCode: "ne-c", loserCode: "ne-b" }),
    ], list);
    expect(r.some((x) => x.startsWith("loser ne-b appears twice"))).toBe(true);
    expect(r).toContain("loser ne-b is already merged (into id-y)");
    expect(r).toContain("survivor ne-a is itself merged (into id-z)");
  });

  it("refuses two different ids of one kind, and ids to carry", () => {
    const list = [entity("ne-a", "A", { viafId: "1" }), entity("ne-b", "B", { viafId: "2" })];
    expect(reasons([row({ survivorCode: "ne-a", loserCode: "ne-b", add: ["B"] })], list)).toContain("ne-a and ne-b hold different viafId (1 / 2)");
    expect(reasons([row({ survivorCode: "ne-a", loserCode: "ne-b", add: ["B"], idsToCarry: "viaf=2" })], [entity("ne-a", "A"), entity("ne-b", "B")]))
      .toContain("the list carries ids (viaf=2); the ruling carries none");
  });

  it("reports an id only the loser holds and leaves it there", () => {
    const plan = planEntityMerges([row({ survivorCode: "ne-a", loserCode: "ne-b", add: ["B"] })], index([entity("ne-a", "A"), entity("ne-b", "B", { wikidataId: "Q1" })]));
    expect(plan.refusals).toEqual([]);
    expect(plan.idsLeftOnLoser).toEqual([{ ref: "#1", loserCode: "ne-b", what: "wikidataId Q1" }]);
  });

  it("refuses a slip neither record holds", () => {
    const rows = fixtureRows.map((r) => (r.pair === "15" ? { ...r } : r));
    const list = fixtureEntities.map((e) => (e === gregorio ? { ...e, nameVariants: "[]" } : e));
    expect(reasons(rows, list)).toContain('the slip "Gregori0 Paniso" is not held by either record');
  });

  it("refuses variants that differ from the list's", () => {
    const rows = fixtureRows.map((r) => (r.pair === "16" ? { ...r, add: ["Joseph Escavar"] } : r));
    expect(reasons(rows, fixtureEntities).some((x) => x.startsWith(`${escavar.code} would gain`))).toBe(true);
  });
});

describe("names", () => {
  it("leaves the review's slips and the survivor's own label out of its variants", () => {
    const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
    const finals = Object.fromEntries(plan.groups.map((g) => [g.survivor.code, g.finalVariants]));
    expect(finals[escavar.code]).toEqual(["Jph. Escavar", "Joseph Escobar"]);
    expect(finals[gregorio.code]).toEqual(["Gregario Paniso", "Gregario Panizo"]);
    expect(finals[juana.code]).toEqual([]);
    expect(plan.exclusions.map((x) => `${x.ref} ${x.name}`)).toEqual(["#16 Joseph Escavar", "#15 Gregori0 Paniso", "#129 Juan A Castaño"]);
  });
});

describe("the SQL", () => {
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));

  it("leaves the same tables through Drizzle and through the rendered file", async () => {
    const viaDrizzle = database();
    const viaFile = database();
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), opts, drizzle(d1(viaDrizzle)));
    for (const s of built.composed) await s.run();
    viaFile.exec(built.sql.join("\n"));
    expect(dump(viaFile)).toEqual(dump(viaDrizzle));
  });

  it("leaves another tenant's links on the loser, and its guards count only this tenant's", () => {
    const db = database();
    // A second tenant's description links the loser, and the survivor
    // already holds the same description and role.
    db.exec("INSERT INTO descriptions (id, tenant_id) VALUES ('other-1', 't-2')");
    db.exec(
      "INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES " +
        `('de-x', 'other-1', '${escovar.id}', 'mentioned', 1000), ('de-y', 'other-1', '${escavar.id}', 'mentioned', 1000)`,
    );
    // The command reads only this tenant's links, so the plan holds none of B's.
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), opts);
    applyAsOneUnit(db, built.sql);
    expect(db.prepare("SELECT id, entity_id FROM description_entities WHERE id IN ('de-x', 'de-y') ORDER BY id").all()).toEqual([
      { id: "de-x", entity_id: escovar.id },
      { id: "de-y", entity_id: escavar.id },
    ]);
    expect(db.prepare("SELECT merged_into FROM entities WHERE id = ?").get(escovar.id)).toEqual({ merged_into: escavar.id });
  });

  it("moves, drops, folds, merges with provenance, relabels and writes the ledger as planned", () => {
    const db = database();
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), opts);
    applyAsOneUnit(db, built.sql);
    expect(built.movedLinks).toBe(3);
    expect(built.droppedLinks).toBe(1);
    expect(db.prepare("SELECT id, entity_id, role, sequence, name_as_recorded FROM description_entities ORDER BY id").all()).toEqual([
      { id: "de-1", entity_id: escavar.id, role: "mentioned", sequence: 0, name_as_recorded: null },
      { id: "de-3", entity_id: escavar.id, role: "mentioned", sequence: 0, name_as_recorded: null },
      { id: "de-4", entity_id: juana.id, role: "subject", sequence: 2, name_as_recorded: "Juan A Castaño" },
      { id: "de-5", entity_id: gregorio.id, role: "author", sequence: 0, name_as_recorded: null },
    ]);
    const rows = Object.fromEntries(
      (db.prepare("SELECT entity_code, display_name, sort_name, name_variants, merged_into, sources FROM entities").all() as any[])
        .map((r) => [r.entity_code, r]),
    );
    expect(rows[escavar.code]).toMatchObject({ display_name: "Joseph Escovar", sort_name: "Joseph Escavar" });
    expect(JSON.parse(rows[escavar.code].name_variants)).toEqual(["Jph. Escavar", "Joseph Escobar"]);
    expect(JSON.parse(rows[gregorio.code].name_variants)).toEqual(["Gregario Paniso", "Gregario Panizo"]);
    expect(JSON.parse(rows[juana.code].name_variants)).toEqual([]);
    expect(rows[escovar.code].merged_into).toBe(escavar.id);
    expect(rows[escovar.code].sources).toBe(`Merged into Joseph Escovar (${escavar.code}) on 2025-10-24`);
    expect(rows[gregario.code].sources).toBe(`Libro 3\nMerged into Gregorio Paniso (${gregorio.code}) on 2025-10-24`);
    for (const [e, s] of built.finalVariants) expect(JSON.parse(s)).toEqual(plan.groups.find((g) => g.survivor.id === e)!.finalVariants);

    const ledger = db.prepare("SELECT source_id, target_id, record_type, detail FROM authority_operations ORDER BY source_id").all() as any[];
    expect(ledger.map((l) => [l.source_id, l.target_id, l.record_type])).toEqual([
      [escovar.id, escavar.id, "entity"], [gregario.id, gregorio.id, "entity"], [juanA.id, juana.id, "entity"],
    ]);
    expect(JSON.parse(ledger[0].detail)).toMatchObject({ movedLinks: 1, listRef: "#16", droppedLinks: [fixtureLinks[1]] });
    expect(built.labelChanges).toEqual([
      { survivorCode: escavar.code, old: "Joseph Escavar", new: "Joseph Escovar", sortName: "Joseph Escavar", oldKept: false },
    ]);
  });

  it("journals stored values as the before-images", () => {
    // Gregorio stores NULL variants; Escovar stores '' sources and '' merged_into.
    const raw = (e: EntityRow, over: Partial<StoredEntity>): EntityRow => ({ ...e, stored: { ...storedOfEntity(e), ...over } });
    const list = fixtureEntities.map((e) =>
      e === gregorio ? raw({ ...e, nameVariants: "[]" }, { name_variants: null }) : e === escovar ? raw(e, { merged_into: "" }) : e,
    );
    const rows = fixtureRows.filter((r) => r.pair !== "15").concat(row({ pair: "15b", survivorCode: gregorio.code, loserCode: gregario.code, labelToKeep: "Gregorio Paniso", add: ["Gregario Paniso", "Gregario Panizo"] }));
    const rawPlan = planEntityMerges(rows, index(list));
    expect(rawPlan.refusals).toEqual([]);
    const db = new DatabaseSync(":memory:", D1_LIMITS);
    db.exec(DDL);
    seed(db, list, fixtureLinks);
    applyAsOneUnit(db, buildEntityStatements(rawPlan, byEntity(fixtureLinks), opts).sql);
    const diffs = (db.prepare("SELECT record_id, diff FROM changelog WHERE kind = 'update' ORDER BY rowid").all() as any[])
      .map((r) => ({ id: r.record_id, diff: JSON.parse(r.diff) }));
    expect(diffs.find((d) => d.id === gregorio.id && d.diff.nameVariants)!.diff.nameVariants.old).toBeNull();
    const escovarDiff = diffs.find((d) => d.id === escovar.id)!.diff;
    expect(escovarDiff.mergedInto.old).toBe("");
    expect(escovarDiff.sources.old).toBe("");
    const relabel = diffs.find((d) => d.id === escavar.id && d.diff.displayName)!.diff;
    expect(relabel.displayName).toEqual({ old: "Joseph Escavar", new: "Joseph Escovar" });
  });

  function failsAfter(change: (db: DatabaseSync) => void): void {
    const db = database();
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), opts);
    change(db);
    const before = dump(db);
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(dump(db)).toEqual(before);
  }

  it("fails the file when an entity changed after the read, whatever its updated_at", () => {
    failsAfter((db) => db.prepare("UPDATE entities SET tenant_id = 'tenant-a' WHERE id = ?").run(escovar.id));
    failsAfter((db) => db.prepare("UPDATE entities SET sources = 'x' WHERE id = ?").run(gregario.id));
    failsAfter((db) => db.prepare("UPDATE entities SET sort_name = 'Escavar, Joseph' WHERE id = ?").run(escavar.id));
    failsAfter((db) => db.prepare("UPDATE entities SET viaf_id = '9' WHERE id = ?").run(juana.id));
    failsAfter((db) => db.prepare("UPDATE entities SET updated_at = 2 WHERE id = ?").run(juana.id));
  });

  it("fails the file when a survivor's federation changed after the read, even when the fold changes nothing", () => {
    // A survivor that already holds its loser's name gains nothing from the
    // fold, so only the opening guard can see it leave the federation.
    const survivor = entity("ne-surv01", "Juan de Vargas", { nameVariants: '["Joan de Vargas"]' });
    const loser = entity("ne-lose01", "Joan de Vargas");
    const quiet = planEntityMerges([row({ pair: "3000", survivorCode: survivor.code, loserCode: loser.code })], index([survivor, loser]));
    expect(quiet.refusals).toEqual([]);
    const db = database([survivor, loser], []);
    const built = buildEntityStatements(quiet, new Map(), opts);
    db.prepare("UPDATE entities SET federation_id = 'fed-2' WHERE id = ?").run(survivor.id);
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(db.prepare("SELECT merged_into FROM entities WHERE id = ?").get(loser.id)).toEqual({ merged_into: null });
  });

  it("fails the file when an entity code changed after the read", () => {
    failsAfter((db) => db.prepare("UPDATE entities SET entity_code = 'ne-other1' WHERE id = ?").run(escavar.id));
  });

  it("fails the file when an UPDATE in it touches no row", () => {
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_link BEFORE UPDATE ON description_entities WHEN OLD.id = 'de-1' BEGIN SELECT RAISE(IGNORE); END;`));
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_drop BEFORE DELETE ON description_entities WHEN OLD.id = 'de-2' BEGIN SELECT RAISE(IGNORE); END;`));
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_loser BEFORE UPDATE ON entities WHEN OLD.id = '${gregario.id}' BEGIN SELECT RAISE(IGNORE); END;`));
    failsAfter((db) => db.exec(`CREATE TRIGGER skip_survivor BEFORE UPDATE ON entities WHEN OLD.id = '${juana.id}' BEGIN SELECT RAISE(IGNORE); END;`));
  });

  it("fails the file when a link changed after the read", () => {
    failsAfter((db) => db.prepare("UPDATE description_entities SET role = 'subject' WHERE id = 'de-2'").run());
    failsAfter((db) => db.prepare("UPDATE description_entities SET sequence = 5 WHERE id = 'de-4'").run());
    failsAfter((db) => db.prepare("UPDATE description_entities SET name_as_recorded = 'Juana' WHERE id = 'de-4'").run());
    failsAfter((db) => db.prepare("UPDATE description_entities SET description_id = 'd9' WHERE id = 'de-3'").run());
  });

  it("applies 150 merges under D1's expression depth limit of 100", () => {
    const survivors = Array.from({ length: 150 }, (_, i) => entity(`ne-s${i}`, `S${i}`));
    const losers = Array.from({ length: 150 }, (_, i) => entity(`ne-l${i}`, `L${i}`));
    const rows = losers.map((l, i) => row({ pair: `${1000 + i}`, survivorCode: `ne-s${i}`, loserCode: l.code, add: [`L${i}`] }));
    const bulk = planEntityMerges(rows, index([...survivors, ...losers]));
    expect(bulk.refusals).toEqual([]);
    const links = losers.map((l, i) => link(`de-l${i}`, l.id, `d${i}`));
    const db = database([...survivors, ...losers], links);
    applyAsOneUnit(db, buildEntityStatements(bulk, byEntity(links), opts).sql);
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE merged_into IS NOT NULL").get()).toEqual({ n: 150 });
  });

  it("packs guards by size when links and entities carry long fields, and the file applies", () => {
    const note = "é".repeat(1000);
    const variants = JSON.stringify(["ñ".repeat(4000)]);
    const survivors = Array.from({ length: 30 }, (_, i) => entity(`ne-s${i}`, `S${i}`, { nameVariants: variants }));
    const losers = Array.from({ length: 30 }, (_, i) => entity(`ne-l${i}`, `L${i}`, { sources: "ö".repeat(2000) }));
    const rows = losers.map((l, i) => row({ pair: `${2000 + i}`, survivorCode: `ne-s${i}`, loserCode: l.code, add: [`L${i}`] }));
    const longPlan = planEntityMerges(rows, index([...survivors, ...losers]));
    expect(longPlan.refusals).toEqual([]);
    const links = Array.from({ length: 100 }, (_, i) => link(`de-${i}`, losers[i % 30].id, `d${i}`, { roleNote: note }));
    const built = buildEntityStatements(longPlan, byEntity(links), opts);
    expect(Math.max(...built.sql.map((s) => Buffer.byteLength(s)))).toBeLessThanOrEqual(STATEMENT_BUDGET);
    expect(built.oversized).toEqual([]);
    expect(built.sql.filter((s) => s.includes("a link has changed since it was read")).length).toBeGreaterThan(1);
    expect(built.sql.filter((s) => s.includes("an entity in the list has changed since it was read")).length).toBeGreaterThan(1);
    const db = database([...survivors, ...losers], links);
    applyAsOneUnit(db, built.sql);
    expect(db.prepare("SELECT count(*) AS n FROM entities WHERE merged_into IS NOT NULL").get()).toEqual({ n: 30 });
  });

  it("reports a statement no batching can bring under the budget", () => {
    const huge = entity("ne-huge", "Huge", { sources: "x".repeat(STATEMENT_BUDGET) });
    const p = planEntityMerges([row({ survivorCode: "ne-s", loserCode: huge.code, add: ["Huge"] })], index([entity("ne-s", "S"), huge]));
    const built = buildEntityStatements(p, new Map(), opts);
    expect(built.oversized.length).toBeGreaterThan(0);
    expect(built.oversized.every((o) => o.bytes > STATEMENT_BUDGET)).toBe(true);
  });
});

describe("relation sides", () => {
  // In d5: Escavar (#16's survivor) is a parent of Juana (s-k <-> o-k).
  // Escovar, the loser, is the same parent (l-k -> o-k, and o-k names
  // l-k, so Escovar's side is the copy), and is a relation side with the
  // role creator (l-r), which Escavar holds as a document role (s-c).
  const links = [
    ...fixtureLinks,
    link("o-k", juana.id, "d5", { role: "child", relatedTo: "l-k" }),
    link("s-k", escavar.id, "d5", { role: "parent", relatedTo: "o-k" }),
    link("l-k", escovar.id, "d5", { role: "parent", relatedTo: "o-k" }),
    link("s-c", escavar.id, "d5", { role: "creator" }),
    link("l-r", escovar.id, "d5", { role: "creator", relatedTo: "o-k" }),
  ];
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
  // The other sides, keyed by the link they name, as the command reads them.
  const pointing = new Map<string, JunctionRow[]>();
  for (const l of links) if (l.relatedTo) pointing.set(l.relatedTo as string, [...(pointing.get(l.relatedTo as string) ?? []), l]);
  const withPointing = { ...opts, pointing };
  const sides = (db: DatabaseSync) =>
    db.prepare("SELECT id, entity_id, related_to FROM description_entities WHERE description_id = 'd5' ORDER BY id").all();

  it("moves a side that only shares a role with a document-role link, and repoints the partner of a dropped side", () => {
    const db = database(fixtureEntities, links);
    applyAsOneUnit(db, buildEntityStatements(plan, byEntity(links), withPointing).sql);
    expect(sides(db)).toEqual([
      { id: "l-r", entity_id: escavar.id, related_to: "o-k" },
      { id: "o-k", entity_id: juana.id, related_to: "s-k" },
      { id: "s-c", entity_id: escavar.id, related_to: null },
      { id: "s-k", entity_id: escavar.id, related_to: "o-k" },
    ]);
    // The repoint is journaled as a moved link is: the content before, then after.
    const journal = (db.prepare("SELECT kind, diff FROM changelog WHERE record_id = 'd5' ORDER BY rowid").all() as any[])
      .map((r) => ({ kind: r.kind, ...JSON.parse(r.diff) }))
      .filter((r) => r.id === "o-k");
    expect(journal.map((j) => [j.kind, j.relatedTo])).toEqual([["unlink", "l-k"], ["link", "s-k"]]);
  });

  it("fails the file when a drop is named by a link the plan was not given", () => {
    const db = database(fixtureEntities, links);
    const before = dump(db);
    expect(() => applyAsOneUnit(db, buildEntityStatements(plan, byEntity(links), opts).sql)).toThrow(/malformed JSON/);
    expect(dump(db)).toEqual(before);
  });

  it("fails the file when a link comes to point at the dropped side after the read", () => {
    const db = database(fixtureEntities, links);
    const built = buildEntityStatements(plan, byEntity(links), withPointing);
    // A link the plan did not read names the side the file drops.
    db.exec("INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES ('late', 'd5', 'x', 'witness', 1, 'l-k')");
    const before = dump(db);
    expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
    expect(dump(db)).toEqual(before);
  });
});

describe("a repoint that would collide under the unique index", () => {
  // In d7: both sides of one relation are recorded twice. Escavar's s-p
  // and Escovar's l-p are parents naming Juana's child c-1, and Juana
  // holds a second child side c-2 naming l-p. The merge drops l-p (s-p
  // holds its key) and would repoint c-2 to s-p, giving Juana two child
  // links naming s-p.
  const links = [
    ...fixtureLinks,
    link("c-1", juana.id, "d7", { role: "child", relatedTo: "s-p" }),
    link("c-2", juana.id, "d7", { role: "child", relatedTo: "l-p" }),
    link("s-p", escavar.id, "d7", { role: "parent", relatedTo: "c-1" }),
    link("l-p", escovar.id, "d7", { role: "parent", relatedTo: "c-1" }),
  ];
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
  const pointing = new Map<string, JunctionRow[]>();
  for (const l of links) if (l.relatedTo) pointing.set(l.relatedTo as string, [...(pointing.get(l.relatedTo as string) ?? []), l]);

  it("is found before the statements, with the loser whose merge makes it", () => {
    expect(mergeLinkCollisions(plan, byEntity(links), pointing)).toEqual([
      { descriptionId: "d7", entityId: juana.id, role: "child", relatedTo: "s-p", linkIds: ["c-1", "c-2"], loserId: escovar.id },
    ]);
  });

  it("refuses the statements, naming the description, the entity and the role", () => {
    expect(() => buildEntityStatements(plan, byEntity(links), { ...opts, pointing })).toThrow(
      `the merge would leave ${juana.id} with two links to d7 as child that name the same link`,
    );
  });
});

describe("a link on another tenant's description naming a loser's link", () => {
  // f-far is on dfar, a description of another tenant, and names Escovar's
  // de-1 on d1: stale data the merge must neither read nor write.
  const far = link("f-far", juana.id, "dfar", { role: "child", relatedTo: "de-1", nameAsRecorded: "Secreto Privado" });
  const links = [...fixtureLinks, far];
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
  const entityIds = fixtureEntities.map((e) => e.id);
  function farDatabase(): DatabaseSync {
    const db = new DatabaseSync(":memory:", D1_LIMITS);
    db.exec(DDL);
    db.exec("INSERT INTO descriptions (id, tenant_id) VALUES ('dfar', 't-2')");
    seed(db, fixtureEntities, links);
    return db;
  }
  const foreign = /f-far|dfar|Secreto/;

  it("is not among the links naming a merged record's links, and is reported only by the local link it names", () => {
    const db = farDatabase();
    const pointing = db.prepare(pointingLinksSql(entityIds, "t-1", typed(LINK_COLUMNS))).all() as Array<Record<string, unknown>>;
    expect(pointing.map((r) => r.id)).toEqual([]);
    expect(db.prepare(staleNamingSql(entityIds, "t-1")).all()).toEqual([{ id: "de-1" }]);
  });

  it("refuses the statements, naming no identifier of the other tenant's, whether read in pointing or as stale", () => {
    const unscoped = new Map<string, JunctionRow[]>([["de-1", [far]]]);
    expect(() => buildEntityStatements(plan, byEntity(fixtureLinks), { ...opts, pointing: unscoped })).toThrow(
      "link de-1 of ne-esco01 is named by a link outside its description, which is stale data: the merge is refused",
    );
    let message = "";
    try {
      buildEntityStatements(plan, byEntity(fixtureLinks), { ...opts, pointing: new Map(), staleNamed: new Set(["de-1"]) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("link de-1 of ne-esco01 is named by a link outside its description, which is stale data: the merge is refused");
    expect(message).not.toMatch(foreign);
  });
});

describe("a link repointed and moved in the same file", () => {
  // In d6: Escavar (#16's survivor) and Escovar (the loser) both hold
  // creator (k-c kept, d-c the copy, dropped); Escovar's own p-c names
  // d-c, so p-c is repointed to k-c and then moves to Escavar.
  const links = [
    ...fixtureLinks,
    link("k-c", escavar.id, "d6", { role: "creator" }),
    link("d-c", escovar.id, "d6", { role: "creator" }),
    link("p-c", escovar.id, "d6", { role: "parent", relatedTo: "d-c" }),
  ];
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
  const pointing = new Map<string, JunctionRow[]>();
  for (const l of links) if (l.relatedTo) pointing.set(l.relatedTo as string, [...(pointing.get(l.relatedTo as string) ?? []), l]);

  it("journals p-c as one continuous chain ending at the stored row", () => {
    const db = database(fixtureEntities, links);
    applyAsOneUnit(db, buildEntityStatements(plan, byEntity(links), { ...opts, pointing }).sql);
    const entries = (db.prepare("SELECT kind, diff FROM changelog WHERE record_id = 'd6' ORDER BY rowid").all() as any[])
      .map((r) => ({ kind: r.kind as string, content: JSON.parse(r.diff) }))
      .filter((e) => e.content.id === "p-c");
    expect(entries.map((e) => e.kind)).toEqual(["unlink", "link", "unlink", "link"]);
    for (let i = 1; i < entries.length; i++) if (entries[i].kind === "unlink") expect(entries[i].content).toEqual(entries[i - 1].content);
    const stored = db.prepare("SELECT * FROM description_entities WHERE id = 'p-c'").get() as Record<string, unknown>;
    const v = (c: string) => stored[c];
    expect(entries[entries.length - 1].content).toEqual(junctionRowOf(v));
    expect(stored).toMatchObject({ entity_id: escavar.id, related_to: "k-c" });
  });
});

describe("functions", () => {
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
  type Fn = { id: string; entityId: string; function: string; source?: string | null; notes?: string | null };
  const fns: Fn[] = [
    { id: "ef-1", entityId: escovar.id, function: "Maestre de Campo" },
    { id: "ef-2", entityId: escovar.id, function: "Alcalde" },
    { id: "ef-3", entityId: escavar.id, function: "Maestre de Campo" },
    { id: "ef-4", entityId: gregario.id, function: "Escribano" },
  ];
  /** Each record's rows in full, as the command reads them. */
  const functionsByEntity = (rows: Fn[] = fns) => {
    const m = new Map<string, EntityFunctionRow[]>();
    for (const f of rows) {
      const full: EntityFunctionRow = {
        id: f.id, entityId: f.entityId, honorific: "don", function: f.function, dateStart: "1650", dateEnd: null, dateNote: null,
        certainty: "probable", source: f.source === undefined ? "AGN" : f.source, notes: f.notes === undefined ? "n" : f.notes, createdAt: 7, updatedAt: 8,
      };
      m.set(f.entityId, [...(m.get(f.entityId) ?? []), full]);
    }
    return m;
  };
  const withFunctions = (rows: Fn[] = fns) => {
    const db = database();
    const ins = db.prepare(
      "INSERT INTO entity_functions (id, entity_id, honorific, function, date_start, certainty, source, notes, created_at, updated_at) VALUES (?, ?, 'don', ?, '1650', 'probable', ?, ?, 7, 8)",
    );
    for (const f of rows) ins.run(f.id, f.entityId, f.function, f.source === undefined ? "AGN" : f.source, f.notes === undefined ? "n" : f.notes);
    return db;
  };
  const fopts = (rows: Fn[] = fns) => ({ ...opts, functionsByEntity: functionsByEntity(rows) });

  it("moves each loser's rows of new functions to its survivor, columns kept, folds those it holds, records both and bumps the survivor", () => {
    const db = withFunctions();
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), fopts());
    applyAsOneUnit(db, built.sql);
    expect(built.movedFunctions).toBe(2);
    // ef-1 is a function Escavar holds (ef-3): it is not added a second time.
    expect(db.prepare("SELECT id, entity_id, honorific, function, date_start, source, notes, created_at, updated_at FROM entity_functions ORDER BY rowid").all()).toEqual([
      { id: "ef-2", entity_id: escavar.id, honorific: "don", function: "Alcalde", date_start: "1650", source: "AGN", notes: "n", created_at: 7, updated_at: 8 },
      { id: "ef-3", entity_id: escavar.id, honorific: "don", function: "Maestre de Campo", date_start: "1650", source: "AGN", notes: "n", created_at: 7, updated_at: 8 },
      { id: "ef-4", entity_id: gregorio.id, honorific: "don", function: "Escribano", date_start: "1650", source: "AGN", notes: "n", created_at: 7, updated_at: 8 },
    ]);
    const ledger = Object.fromEntries(
      (db.prepare("SELECT source_id, detail FROM authority_operations").all() as any[]).map((l) => [l.source_id, JSON.parse(l.detail)]),
    );
    expect(ledger[escovar.id].movedFunctions).toEqual(["ef-2"]);
    expect(ledger[escovar.id].foldedFunctions).toEqual([
      { row: expect.objectContaining({ id: "ef-1", function: "Maestre de Campo", source: "AGN" }), into: "ef-3", filled: {}, conflicts: [] },
    ]);
    expect(built.foldedFunctions.map((f) => [f.row.id, f.into, f.loserCode, f.survivorCode])).toEqual([["ef-1", "ef-3", escovar.code, escavar.code]]);
    expect(ledger[gregario.id].movedFunctions).toEqual(["ef-4"]);
    expect(ledger[juanA.id].movedFunctions).toEqual([]);
    expect(db.prepare("SELECT updated_at FROM entities WHERE id = ?").get(gregorio.id)).toEqual({ updated_at: opts.now });
  });

  it("fills only the empty fields of the survivor's row, and reports a field both hold with different values", () => {
    const rows: Fn[] = [
      { id: "ef-1", entityId: escovar.id, function: "  maestre de campo", source: "AHRB", notes: "del cabildo" },
      { id: "ef-3", entityId: escavar.id, function: "Maestre de Campo", source: "AGN", notes: null },
    ];
    const db = withFunctions(rows);
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), fopts(rows));
    applyAsOneUnit(db, built.sql);
    expect(db.prepare("SELECT id, entity_id, function, source, notes, updated_at FROM entity_functions").all()).toEqual([
      { id: "ef-3", entity_id: escavar.id, function: "Maestre de Campo", source: "AGN", notes: "del cabildo", updated_at: opts.now },
    ]);
    expect(built.foldedFunctions).toEqual([
      expect.objectContaining({ into: "ef-3", filled: { notes: "del cabildo" }, conflicts: [{ field: "source", held: "AGN", incoming: "AHRB" }] }),
    ]);
  });

  it("fails the file when a survivor's function rows changed after the read", () => {
    for (const change of [
      (db: DatabaseSync) => db.prepare("UPDATE entity_functions SET notes = NULL WHERE id = 'ef-3'").run(),
      (db: DatabaseSync) => db.prepare("INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('ef-9', ?, 'Alcalde', 1, 1)").run(escavar.id),
    ]) {
      const db = withFunctions();
      const built = buildEntityStatements(plan, byEntity(fixtureLinks), fopts());
      change(db);
      const before = dump(db);
      expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
      expect(dump(db)).toEqual(before);
    }
  });

  it("leaves the same tables through Drizzle and through the rendered file", async () => {
    const viaDrizzle = withFunctions();
    const viaFile = withFunctions();
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), fopts(), drizzle(d1(viaDrizzle)));
    for (const s of built.composed) await s.run();
    viaFile.exec(built.sql.join("\n"));
    expect(dump(viaFile)).toEqual(dump(viaDrizzle));
  });

  it("moves each loser's and each survivor's updated_at past the value read, even at or after the run's now", () => {
    const atNow = fixtureEntities.map((e) => ({ ...e, updatedAt: e.id === gregorio.id ? opts.now + 10 : opts.now }));
    const p = planEntityMerges(fixtureRows, index(atNow));
    const db = database(atNow);
    applyAsOneUnit(db, buildEntityStatements(p, byEntity(fixtureLinks), opts).sql);
    const version = (id: string) => (db.prepare("SELECT updated_at FROM entities WHERE id = ?").get(id) as { updated_at: number }).updated_at;
    for (const e of [escavar, escovar, gregario, juana, juanA]) expect(version(e.id)).toBe(opts.now + 1);
    expect(version(gregorio.id)).toBe(opts.now + 11);
  });

  it("fails the file when a loser's function rows changed after the read", () => {
    for (const change of [
      (db: DatabaseSync) => db.prepare("INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('ef-9', ?, 'Regidor', 1, 1)").run(escovar.id),
      (db: DatabaseSync) => db.prepare("DELETE FROM entity_functions WHERE id = 'ef-4'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE entity_functions SET entity_id = ? WHERE id = 'ef-2'").run(juana.id),
    ]) {
      const db = withFunctions();
      const built = buildEntityStatements(plan, byEntity(fixtureLinks), fopts());
      change(db);
      const before = dump(db);
      expect(() => applyAsOneUnit(db, built.sql)).toThrow(/malformed JSON/);
      expect(dump(db)).toEqual(before);
    }
  });
});

describe("the arguments", () => {
  it("requires the tenant whose links the merge moves", () => {
    expect(() => parseMergeArgs(["--target", "staging", "--list", "x.csv"], "x.csv")).toThrow(/--tenant <slug> is required/);
    expect(parseMergeArgs(["--target", "staging", "--tenant", "neogranadina", "--list", "x.csv"], "x.csv")).toMatchObject({
      target: "staging",
      tenant: "neogranadina",
    });
  });

  it("keeps a junction read to the tenant's descriptions", () => {
    expect(inTenantDescriptions("t'1")).toBe("description_id IN (SELECT id FROM descriptions WHERE tenant_id = 't''1')");
  });
});

describe("who merges, on a member workspace", () => {
  const plan = planEntityMerges(fixtureRows, index(fixtureEntities));
  const actingDb = (steward = true) => {
    const db = database();
    seedActing(db);
    if (steward) stewardMembership(db);
    return db;
  };

  it("writes acted_as lead-admin on every changelog row of the lead's admin's merges on a member", async () => {
    const db = actingDb();
    const acting = await resolveCommandActor(reader(db), "user_001", "ahr", { shared: true });
    const built = buildEntityStatements(plan, byEntity(fixtureLinks), { ...opts, actedAs: acting.actedAs });
    applyAsOneUnit(db, [...acting.guards, ...built.sql]);
    const rows = db.prepare("SELECT acted_as FROM changelog").all() as Array<{ acted_as: string | null }>;
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.acted_as))).toEqual(new Set(["lead-admin"]));
  });

  it("writes acted_as NULL when the user merges on their own workspace", async () => {
    const db = actingDb();
    db.exec("UPDATE users SET tenant_id = 't-1' WHERE id = 'user_001'");
    const acting = await resolveCommandActor(reader(db), "user_001", "ahr", { shared: true });
    expect(acting.actedAs).toBeNull();
  });

  it("aborts the file when the basis changes between the plan and the apply", async () => {
    for (const change of ["UPDATE users SET is_admin = 0 WHERE id = 'user_001'", "DELETE FROM federation_memberships"]) {
      const db = actingDb();
      const acting = await resolveCommandActor(reader(db), "user_001", "ahr", { shared: true });
      const built = buildEntityStatements(plan, byEntity(fixtureLinks), { ...opts, actedAs: acting.actedAs });
      db.exec(change);
      expect(() => applyAsOneUnit(db, [...acting.guards, ...built.sql])).toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM changelog").get()).toEqual({ n: 0 });
    }
  });

  it("refuses the lead's admin shared merges on a member without a steward membership", async () => {
    await expect(resolveCommandActor(reader(actingDb(false)), "user_001", "ahr", { shared: true })).rejects.toThrow(
      /lead@example.org is not a steward of neogranadina, whose shared records the run changes/,
    );
  });
});

// @version v0.9.0
