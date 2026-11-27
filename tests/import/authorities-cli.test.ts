/**
 * Tests — the command line's authority changes
 *
 * This suite pins `scripts/lib/authorities-cli/`, the change file, plan,
 * guards, SQL, report and read-back behind `scripts/fisqua.ts
 * authorities`. The run is driven end to end against an in-memory
 * `node:sqlite` database holding the tables and columns the engine
 * reads and writes, with D1's expression depth limit of 100; the file it
 * writes is applied as one unit, as `wrangler d1 execute --file` applies
 * it. Nothing here reaches D1.
 *
 *   - the change file: one row per operation, an `op` column, reviewer
 *     columns accepted and never written, unknown columns refused;
 *   - the plan and the writes: keep, move (one target keeps the row's id;
 *     several give deterministic ids and delete the source row), copy,
 *     delete, update of record fields, merge as the reviewed merge does
 *     it, coverage; a changelog row per function change in the app's
 *     form (`functions`, old and new text), a new version for every
 *     record whose functions or fields change;
 *   - a target that holds the function by then, case and spacing aside,
 *     its own or brought by an earlier row, does not receive it: a move
 *     or a copy fills the held row's empty fields (a move deletes the
 *     source row), never overwrites one, journals and versions the
 *     target only when it fills, and the report says which ("filled" or
 *     "skipped") and names each field both hold with different values; a
 *     merge folds the loser's rows the same way; a target holding a
 *     spelling that differs only in accents still receives the row;
 *   - a second run writes nothing and reports every row as already done;
 *   - rename-function: a function row's text, and its honorific when
 *     given, set in place, the record versioned and journaled under an id
 *     made from the file; its refusals, "same" without this file's
 *     changelog row and "already renamed" with it;
 *   - one refusal per rule; conflicting rows refused;
 *   - changes between the plan and the write abort the file whole;
 *   - who acts on a member workspace: the lead's admin, also as a
 *     steward of the shared records, and a platform admin may; a user of
 *     the lead who is not its admin, an admin of another member, and the
 *     lead's admin on another federation's or a suspended workspace may
 *     not; the report records how the user acted; the file aborts when
 *     the role, the platform flag, the member's federation or the lead
 *     changes before the apply;
 *   - the ids a file makes (`newRecordId`): no two sets of parts share
 *     one, and the tenant is one of the parts;
 *   - a file of 60,000 update-entity rows, planned, applied and read back,
 *     with no call spreading a list of rows or statements.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseChangeFile } from "../../scripts/lib/authorities-cli/change-file";
import {
  functionRowId,
  parseAuthoritiesArgs,
  runAuthorities,
  type AuthoritiesReport,
} from "../../scripts/lib/authorities-cli/run";
import { newRecordId } from "../../scripts/lib/authority-links";
import { d1Read } from "./d1-limits";

/** D1 caps expression depth at 100 (SQLite defaults to 1000); the Node typings in use do not list `limits`. */
const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "authority-functions-test.csv";
const NOW = 1_763_100_000_000;

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT, shared_authorities_enabled INTEGER,
  entity_code_prefix TEXT, place_code_prefix TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT, disabled_at INTEGER, authorities_enabled INTEGER,
  entity_code_prefix TEXT, place_code_prefix TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
  is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
  is_digitization_admin INTEGER DEFAULT 0);
CREATE TABLE federation_memberships (id TEXT PRIMARY KEY, user_id TEXT, federation_id TEXT, role TEXT);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reference_code TEXT);
CREATE TABLE vocabulary_terms (id TEXT PRIMARY KEY, federation_id TEXT, canonical TEXT, merged_into TEXT, entity_count INTEGER DEFAULT 0,
  updated_at INTEGER);
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, entity_code TEXT, display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT,
  primary_function_id TEXT, name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, history TEXT,
  functions TEXT, sources TEXT, merged_into TEXT, wikidata_id TEXT, viaf_id TEXT, dbe_id TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, gender TEXT,
  known_only_from_relation INTEGER NOT NULL DEFAULT 0, qualified_name TEXT, name_key TEXT);
CREATE UNIQUE INDEX entity_code_idx ON entities (federation_id, entity_code);
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, entity_id TEXT NOT NULL, role TEXT NOT NULL,
  role_note TEXT, role_raw TEXT, sequence INTEGER NOT NULL DEFAULT 0, honorific TEXT, name_as_recorded TEXT,
  created_at INTEGER NOT NULL, related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION, relation_certainty TEXT, attributes TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX de_unique_idx ON description_entities (description_id, entity_id, role, COALESCE(related_to, ''));
CREATE TABLE entity_functions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, honorific TEXT, function TEXT NOT NULL, date_start TEXT,
  date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT,
  diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE TABLE authority_operations (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, record_type TEXT NOT NULL, operation TEXT NOT NULL,
  source_id TEXT NOT NULL, target_id TEXT, user_id TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
`;

interface EntitySeed {
  id: string;
  code: string;
  name: string;
  dates?: string | null;
  tenant?: string | null;
  merged?: string | null;
  variants?: string;
  updatedAt?: number;
}

const A: EntitySeed = { id: "e-a", code: "ne-aaaaaa", name: "Francisco Hernández" };
const B: EntitySeed = { id: "e-b", code: "ne-bbbbbb", name: "Francisco Hernández" };
const C: EntitySeed = { id: "e-c", code: "ne-cccccc", name: "Francisco Hernández" };
const D: EntitySeed = { id: "e-d", code: "ne-dddddd", name: "Pedro de León" };
const LOSER: EntitySeed = { id: "e-m1", code: "ne-mmmmm1", name: "Juan Gil" };
const SURVIVOR: EntitySeed = { id: "e-m2", code: "ne-mmmmm2", name: "Juan Gil de Rojas" };
const U: EntitySeed = { id: "e-u", code: "ne-uuuuuu", name: "Antonio Pérez", dates: "s. XVII", variants: '["Ant. Perez"]' };
const OWN: EntitySeed = { id: "e-own", code: "ot-oooooo", name: "Otro", tenant: "t-2" };
const ENTITIES = [A, B, C, D, LOSER, SURVIVOR, U, OWN];

type FunctionSeed = [id: string, entity: string, text: string];
const FUNCTIONS: FunctionSeed[] = [
  ["f-keep", A.id, "Mercader"],
  ["f-move1", A.id, "Carpintero"],
  ["f-move2", A.id, "Regidor"],
  ["f-copy", A.id, "Alcalde"],
  ["f-del", A.id, "Vecino"],
  ["f-alf", A.id, "Alférez"],
  ["f-b1", B.id, "Sastre"],
  ["f-d1", D.id, "alferez"],
  ["f-m1", LOSER.id, "Escribano"],
];

function database(over: { entities?: EntitySeed[]; functions?: FunctionSeed[] } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl'), ('t-2', 'other', '${FED}', NULL, 1, 'ot', 'op');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(`INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-ahrb-cab-001-d001'), ('d2', '${TENANT}', 'co-ahrb-cab-001-d002');`);
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, dates_of_existence, merged_into, " +
      "name_variants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'person', ?, ?, ?, 1, ?)",
  );
  for (const x of over.entities ?? ENTITIES) {
    e.run(x.id, FED, x.tenant ?? null, x.code, x.name, x.name, x.dates ?? null, x.merged ?? null, x.variants ?? "[]", x.updatedAt ?? 5);
  }
  const f = db.prepare(
    "INSERT INTO entity_functions (id, entity_id, honorific, function, date_start, date_end, date_note, certainty, source, notes, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'certain', ?, ?, ?, ?)",
  );
  // Every row carries metadata of its own, so a row written with another row's columns shows.
  (over.functions ?? FUNCTIONS).forEach(([id, entity, fnText], i) => {
    const [honorific, start, end, dateNote, source, notes, created, updated] = metadataOf(id, i);
    f.run(id, entity, honorific, fnText, start, end, dateNote, source, notes, created, updated);
  });
  db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-m1', 'd1', '${LOSER.id}', 'mentioned', 1);`);
  // The survivor's own link, which the merge row cites as its evidence.
  db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-m2', 'd2', '${SURVIVOR.id}', 'mentioned', 1);`);
  return db;
}

/** A seeded row's honorific, date_start, date_end, date_note, source, notes, created_at, updated_at. */
function metadataOf(id: string, i: number): [string, string, string, string, string, string, number, number] {
  return [`don ${i}`, `${1600 + i}`, `${1610 + i}`, `c. ${i}`, `AHRB ${i}`, `nota de ${id}`, 100 + i, 200 + i];
}
const columnsOf = (id: string) => {
  const i = FUNCTIONS.findIndex((x) => x[0] === id);
  const [honorific, date_start, date_end, date_note, source, notes, created_at, updated_at] = metadataOf(id, i);
  return { honorific, date_start, date_end, date_note, certainty: "certain", source, notes, created_at, updated_at };
};

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

const HEADER = [
  "op", "authority_code", "authority_name", "function_id", "function", "target_codes", "label_to_keep", "name_variants_add",
  "name_variants_remove", "current_name", "current_dates", "current_function", "display_name", "sort_name", "dates_of_existence",
  "changelog_note", "rule", "evidence", "flag", "facts", "evidence_codes",
];

type Cells = Record<string, string>;
const csvOf = (header: string[], rows: Cells[]) =>
  [header.join(","), ...rows.map((r) => header.map((h) => {
    const v = r[h] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";

const of = (e: EntitySeed) => ({ authority_code: e.code, authority_name: e.name });
const fn = (op: string, e: EntitySeed, id: string, text: string, targets: EntitySeed[] = [], note = ""): Cells => ({
  op, ...of(e), function_id: id, function: text, target_codes: targets.map((t) => t.code).join(" "), changelog_note: note,
  evidence: "co-ahrb-cab-003-d116 'el carpintero'", flag: "reviewer flag",
});

const UPDATE: Cells = {
  op: "update-entity", ...of(U), current_name: U.name, current_dates: U.dates!, display_name: "Antonio Pérez de Arce",
  dates_of_existence: "fl. 1600", name_variants_add: "Antonio Perez", changelog_note: "The full name, from the cabildo books.",
};
const MERGE: Cells = {
  op: "merge-entity", ...of(LOSER), target_codes: SURVIVOR.code, label_to_keep: SURVIVOR.name, name_variants_add: LOSER.name,
  changelog_note: "One man under two spellings.", facts: "office matter", evidence_codes: "co-ahrb-cab-001-d001 co-ahrb-cab-001-d002",
};

const baseRows = (): Cells[] => [
  fn("keep-function", A, "f-keep", "Mercader"),
  fn("move-function", A, "f-move1", "Carpintero", [B], "Carpintero is B's."),
  fn("move-function", A, "f-move2", "Regidor", [B, C], "Regidor is B's and C's."),
  fn("copy-function", A, "f-copy", "Alcalde", [C, D], "All three were alcaldes."),
  fn("delete-function", A, "f-del", "Vecino", [], "Not an office."),
  fn("move-function", A, "f-alf", "Alférez", [D], "Alférez is D's."),
  UPDATE,
  MERGE,
  { op: "cover-functions", ...of(A) },
];

// ---------------------------------------------------------------------------
// The run, against node:sqlite
// ---------------------------------------------------------------------------

function applyAsOneUnit(db: DatabaseSync, statements: string[]): void {
  db.exec("BEGIN");
  try {
    db.exec(statements.join("\n"));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

interface Run {
  report: AuthoritiesReport;
  written: Map<string, string>;
  applied: string[][];
  log: string[];
}

async function run(
  db: DatabaseSync,
  rows: Cells[],
  opts: { apply?: boolean; now?: number; target?: "staging" | "production"; confirmProduction?: boolean; beforeApply?: (db: DatabaseSync) => void; header?: string[]; onRead?: (sql: string, db: DatabaseSync) => void; file?: string;
    newId?: string; written?: Map<string, string>; beforeApplyFile?: (written: Map<string, string>) => void; tenant?: string; actorEmail?: string } = {},
): Promise<Run> {
  const written = opts.written ?? new Map<string, string>();
  const applied: string[][] = [];
  const log: string[] = [];
  const report = await runAuthorities(
    { file: opts.file ?? FILE, rows: parseChangeFile(csvOf(opts.header ?? HEADER, rows), opts.file ?? FILE) },
    {
      target: opts.target ?? "staging",
      tenant: opts.tenant ?? "neogranadina",
      actorEmail: opts.actorEmail ?? "admin@example.org",
      apply: opts.apply ?? false,
      confirmProduction: opts.confirmProduction ?? false,
    },
    {
      rows: async (sql) => {
        const found = d1Read(db, sql);
        // A change another session makes between two of the plan's reads.
        opts.onRead?.(sql, db);
        return found;
      },
      writeFile: (path, text) => written.set(path, text),
      createFile: (path, text) => {
        if (written.has(path)) throw new Error(`EEXIST: ${path} already exists`);
        written.set(path, text);
      },
      readFile: (path) => {
        // Another run writing to the same path between this run's write and its apply.
        opts.beforeApplyFile?.(written);
        return written.get(path) ?? "";
      },
      newId: () => opts.newId ?? "0f1e2d3c-0000-4000-8000-000000000000",
      applyFile: (_path, statements) => {
        applied.push(statements);
        opts.beforeApply?.(db);
        applyAsOneUnit(db, statements);
      },
      now: () => opts.now ?? NOW,
    },
    (line) => log.push(line),
  );
  return { report, written, applied, log };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const functionsOf = (db: DatabaseSync, id: string) =>
  all(db, `SELECT id, function FROM entity_functions WHERE entity_id = '${id}' ORDER BY rowid`).map((r) => `${r.id} ${r.function}`);

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

describe("the change file", () => {
  it("accepts the reviewer columns and refuses an unknown column whole", () => {
    expect(parseChangeFile(csvOf(HEADER, baseRows()), FILE)).toHaveLength(9);
    expect(() => parseChangeFile(csvOf([...HEADER, "colour"], baseRows()), FILE)).toThrow(/unknown columns colour/);
    expect(() => parseChangeFile(csvOf(HEADER.filter((h) => h !== "op"), baseRows()), FILE)).toThrow(/missing columns op/);
  });

  it("reads a file with only the columns its operations use", async () => {
    const header = ["op", "authority_code", "authority_name", "function_id", "function", "target_codes"];
    const { report } = await run(database(), [fn("move-function", A, "f-move1", "Carpintero", [B])], { header });
    expect(reasons(report)).toBe("");
    expect(report.totals).toMatchObject({ rows: 1, move: 1 });
  });
});

// ---------------------------------------------------------------------------
// The plan and the writes
// ---------------------------------------------------------------------------

describe("the plan", () => {
  it("plans every operation and writes nothing to D1", async () => {
    const db = database();
    const { report, written, applied } = await run(db, baseRows());
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("dry run");
    expect(report.totals).toMatchObject({
      rows: 9, keep: 1, move: 3, copy: 1, delete: 1, update: 1, merge: 1, cover: 1, alreadyDone: 0, refused: 0,
      functionRowsMoved: 2, functionRowsInserted: 4, functionRowsDeleted: 2, functionRowsMovedByMerges: 1,
    });
    expect(applied).toHaveLength(0);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
    expect([...written.keys()].some((k) => /^\.import\/authorities_staging_.*\.json$/.test(k))).toBe(true);
    expect([...written.keys()].some((k) => /^\.import\/authorities_staging_.*\.md$/.test(k))).toBe(true);
    expect([...written.keys()].some((k) => /^\.import\/authorities_staging_.*\.sql$/.test(k))).toBe(true);
    // The records whose versions change.
    expect(report.versions.map((v) => v.code).sort()).toEqual([A.code, B.code, C.code, D.code, LOSER.code, SURVIVOR.code, U.code].sort());
  });

  it("reports a target holding a spelling that differs only in accents, and the row still arrives", async () => {
    const db = database();
    const { report } = await run(db, baseRows(), { apply: true });
    expect(report.outcome).toBe("verified");
    expect(report.alreadyHas).toEqual([
      expect.objectContaining({ line: 7, functionId: "f-alf", function: "Alférez", target: D.code, held: "alferez", outcome: "arrives" }),
    ]);
    expect(functionsOf(db, D.id)).toContain("f-alf Alférez");
    expect(functionsOf(db, D.id)).toContain("f-d1 alferez");
  });
});

describe("the writes", () => {
  it("moves, copies and deletes function rows, updates fields and merges, as planned", async () => {
    const db = database();
    const { report } = await run(db, baseRows(), { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");

    const move2B = await functionRowId(FED, TENANT, "f-move2", B.id);
    const move2C = await functionRowId(FED, TENANT, "f-move2", C.id);
    const copyC = await functionRowId(FED, TENANT, "f-copy", C.id);
    const copyD = await functionRowId(FED, TENANT, "f-copy", D.id);
    // A single target keeps the row's id; several take ids made from the row and the target, and the source row goes.
    expect(functionsOf(db, A.id)).toEqual(["f-keep Mercader", "f-copy Alcalde"]);
    expect(functionsOf(db, B.id)).toEqual(["f-move1 Carpintero", "f-b1 Sastre", `${move2B} Regidor`]);
    expect(functionsOf(db, C.id)).toEqual([`${move2C} Regidor`, `${copyC} Alcalde`]);
    expect(functionsOf(db, D.id)).toEqual(["f-alf Alférez", "f-d1 alferez", `${copyD} Alcalde`]);
    expect(all(db, "SELECT count(*) AS n FROM entity_functions WHERE id IN ('f-move2', 'f-del')")[0].n).toBe(0);
    // Every other column of the row is kept: each row carries its own source row's columns.
    for (const [id, source] of [["f-move1", "f-move1"], [move2B, "f-move2"], [move2C, "f-move2"], [copyC, "f-copy"], [copyD, "f-copy"]]) {
      expect(all(db, `SELECT honorific, date_start, date_end, date_note, certainty, source, notes, created_at, updated_at FROM entity_functions WHERE id = '${id}'`)[0]).toEqual(columnsOf(source));
    }

    // Every record whose functions or fields change takes a new version.
    for (const e of [A, B, C, D, U, LOSER, SURVIVOR]) {
      expect(all(db, `SELECT updated_at FROM entities WHERE id = '${e.id}'`)[0].updated_at).toBe(NOW);
    }

    // The function changes are journaled as the editor journals them: an entity update with the functions as text.
    const journal = all(db, "SELECT record_id, kind, note, diff FROM changelog WHERE record_type = 'entity' ORDER BY rowid");
    const ofFunctions = journal.filter((j) => "functions" in JSON.parse(j.diff));
    expect(ofFunctions.map((j) => `${j.record_id} ${j.note}`)).toEqual([
      `${A.id} Carpintero is B's.`,
      `${B.id} Carpintero is B's.`,
      `${A.id} Regidor is B's and C's.`,
      `${B.id} Regidor is B's and C's.`,
      `${C.id} Regidor is B's and C's.`,
      `${C.id} All three were alcaldes.`,
      `${D.id} All three were alcaldes.`,
      `${A.id} Not an office.`,
      `${A.id} Alférez is D's.`,
      `${D.id} Alférez is D's.`,
    ]);
    expect(JSON.parse(ofFunctions[0].diff)).toEqual({
      functions: { old: "Mercader\nCarpintero\nRegidor\nAlcalde\nVecino\nAlférez", new: "Mercader\nRegidor\nAlcalde\nVecino\nAlférez" },
    });
    expect(JSON.parse(ofFunctions[1].diff)).toEqual({ functions: { old: "Sastre", new: "Carpintero\nSastre" } });
    expect(JSON.parse(ofFunctions[4].diff)).toEqual({ functions: { old: null, new: "Regidor" } });

    // The field update, with the editor's form of a changelog row.
    const u = all(db, `SELECT * FROM entities WHERE id = '${U.id}'`)[0];
    expect(u).toMatchObject({ display_name: "Antonio Pérez de Arce", dates_of_existence: "fl. 1600", name_variants: '["Ant. Perez","Antonio Perez"]' });
    const uj = journal.filter((j) => j.record_id === U.id);
    expect(uj).toHaveLength(1);
    expect(JSON.parse(uj[0].diff)).toMatchObject({ displayName: { old: U.name, new: "Antonio Pérez de Arce" } });
    expect(uj[0].note).toBe("The full name, from the cabildo books.");

    // The merge, as the reviewed merge does it: links, functions, variants, ledger.
    expect(all(db, `SELECT merged_into FROM entities WHERE id = '${LOSER.id}'`)[0].merged_into).toBe(SURVIVOR.id);
    expect(all(db, "SELECT entity_id FROM description_entities WHERE id = 'l-m1'")[0].entity_id).toBe(SURVIVOR.id);
    expect(functionsOf(db, SURVIVOR.id)).toEqual(["f-m1 Escribano"]);
    expect(all(db, `SELECT name_variants FROM entities WHERE id = '${SURVIVOR.id}'`)[0].name_variants).toBe('["Juan Gil"]');
    const ledger = all(db, "SELECT operation, source_id, target_id, detail FROM authority_operations");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ operation: "merge", source_id: LOSER.id, target_id: SURVIVOR.id });
    expect(JSON.parse(ledger[0].detail)).toMatchObject({ movedFunctions: ["f-m1"], movedLinks: 1, file: FILE, line: 9 });
  });

  it("takes one past the version read when that is at or after the clock", async () => {
    const db = database({ entities: ENTITIES.map((e) => (e === B ? { ...B, updatedAt: NOW + 10 } : e)) });
    const { report } = await run(db, baseRows(), { apply: true });
    expect(report.outcome).toBe("verified");
    expect(all(db, `SELECT updated_at FROM entities WHERE id = '${B.id}'`)[0].updated_at).toBe(NOW + 11);
  });

  it("writes nothing on a second run and reports every row as already done", async () => {
    const db = database();
    expect((await run(db, baseRows(), { apply: true })).report.outcome).toBe("verified");
    const count = () => all(db, "SELECT (SELECT count(*) FROM changelog) AS c, (SELECT count(*) FROM authority_operations) AS o, (SELECT count(*) FROM entity_functions) AS f")[0];
    const before = count();
    const second = await run(db, baseRows(), { apply: true, now: NOW + 60_000 });
    expect(reasons(second.report)).toBe("");
    expect(second.report.outcome).toBe("nothing to write");
    expect(second.applied).toHaveLength(0);
    expect(second.report.rows.map((r) => r.status)).toEqual([
      "keep", "already moved", "already moved", "already copied", "already deleted", "already moved", "already updated", "already merged", "cover",
    ]);
    expect(count()).toEqual(before);
  });

  it("does not write the reviewer columns anywhere", async () => {
    const db = database();
    await run(db, baseRows(), { apply: true });
    const text = JSON.stringify([all(db, "SELECT * FROM changelog"), all(db, "SELECT * FROM authority_operations"), all(db, "SELECT * FROM entities"), all(db, "SELECT * FROM entity_functions")]);
    expect(text).not.toContain("el carpintero");
    expect(text).not.toContain("reviewer flag");
  });
});

// ---------------------------------------------------------------------------
// A target that holds the function
// ---------------------------------------------------------------------------

describe("a target that holds the function", () => {
  /** A on its own with "f-cura" (" cura", every field set), B holding "f-held" ("Cura", only notes set), C with nothing. */
  const holding = (extra: FunctionSeed[] = []) => {
    const db = database({ functions: [["f-cura", A.id, " cura"], ["f-held", B.id, "Cura"], ...extra] });
    db.exec("UPDATE entity_functions SET honorific = NULL, date_start = NULL, date_end = NULL, date_note = NULL, source = NULL, notes = 'propia' WHERE id = 'f-held'");
    return db;
  };
  const row = (id: string) => all(holdingDb!, `SELECT * FROM entity_functions WHERE id = '${id}'`)[0];
  let holdingDb: DatabaseSync | null = null;

  it("fills the held row instead of adding one when a move lands on it, and deletes the source row", async () => {
    const db = (holdingDb = holding());
    const { report } = await run(db, [fn("move-function", A, "f-cura", "cura", [B], "Cura is B's.")], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(functionsOf(db, A.id)).toEqual([]);
    expect(functionsOf(db, B.id)).toEqual(["f-held Cura"]);
    // The held row takes what it lacked and keeps what it had.
    const [honorific, start, end, dateNote, source] = metadataOf("f-cura", 0);
    expect(row("f-held")).toMatchObject({ honorific, date_start: start, date_end: end, date_note: dateNote, source, notes: "propia", updated_at: NOW });
    expect(report.totals).toMatchObject({ move: 1, functionRowsMoved: 0, functionRowsInserted: 0, functionRowsDeleted: 1, functionRowsFilled: 1 });
    expect(report.alreadyHas).toEqual([
      expect.objectContaining({
        line: 2, functionId: "f-cura", target: B.code, held: "Cura", heldId: "f-held", outcome: "filled",
        filled: ["honorific", "date_start", "date_end", "date_note", "source"],
        conflicts: [{ field: "notes", held: "propia", incoming: "nota de f-cura" }],
      }),
    ]);
    // Both records take a new version; B's change is journaled as a change of the row's fields.
    for (const e of [A, B]) expect(all(db, `SELECT updated_at FROM entities WHERE id = '${e.id}'`)[0].updated_at).toBe(NOW);
    const journal = all(db, `SELECT diff FROM changelog WHERE record_id = '${B.id}'`).map((j) => JSON.parse(j.diff));
    expect(journal).toEqual([{
      functionFields: {
        old: { id: "f-held", function: "Cura", honorific: null, dateStart: null, dateEnd: null, dateNote: null, source: null },
        new: { id: "f-held", function: "Cura", honorific, dateStart: start, dateEnd: end, dateNote: dateNote, source },
      },
    }]);
    // A second run finds the move done.
    const second = await run(db, [fn("move-function", A, "f-cura", "cura", [B], "Cura is B's.")], { apply: true, now: NOW + 1000 });
    expect(reasons(second.report)).toBe("");
    expect(second.report.outcome).toBe("nothing to write");
    expect(second.report.rows.map((r) => r.status)).toEqual(["already moved"]);
  });

  it("keeps the held row's certainty and reports a different one", async () => {
    const db = (holdingDb = holding());
    db.exec("UPDATE entity_functions SET certainty = 'probable' WHERE id = 'f-held'");
    const { report } = await run(db, [fn("move-function", A, "f-cura", "cura", [B])], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(row("f-held").certainty).toBe("probable");
    expect(report.alreadyHas[0].conflicts).toContainEqual({ field: "certainty", held: "probable", incoming: "certain" });
  });

  it("skips a held row that lacks nothing: the target takes no new version and no changelog row", async () => {
    const db = (holdingDb = holding());
    db.exec("UPDATE entity_functions SET honorific = 'h', date_start = '1', date_end = '2', date_note = 'n', source = 's' WHERE id = 'f-held'");
    const { report } = await run(db, [fn("move-function", A, "f-cura", "cura", [B])], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(functionsOf(db, B.id)).toEqual(["f-held Cura"]);
    expect(row("f-held")).toMatchObject({ source: "s", updated_at: 201 });
    expect(report.alreadyHas[0]).toMatchObject({ outcome: "skipped", filled: [] });
    expect(report.versions.map((v) => v.code)).toEqual([A.code]);
    expect(all(db, `SELECT count(*) AS n FROM changelog WHERE record_id = '${B.id}'`)[0].n).toBe(0);
    expect(all(db, `SELECT updated_at FROM entities WHERE id = '${B.id}'`)[0].updated_at).toBe(5);
    const md = [...(await run(db, [fn("move-function", A, "f-cura", "cura", [B])], { now: NOW + 1000 })).written.entries()]
      .find(([k]) => k.endsWith(".md"))![1];
    expect(md).toContain("Nothing to write");
  });

  it("fills the held row on a copy and inserts nothing; a rerun reads as same", async () => {
    const db = (holdingDb = holding());
    const { report, written } = await run(db, [fn("copy-function", A, "f-cura", "cura", [B, C])], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const copyC = await functionRowId(FED, TENANT, "f-cura", C.id);
    expect(functionsOf(db, A.id)).toEqual(["f-cura  cura"]);
    expect(functionsOf(db, B.id)).toEqual(["f-held Cura"]);
    expect(functionsOf(db, C.id)).toEqual([`${copyC}  cura`]);
    expect(row("f-held")).toMatchObject({ source: metadataOf("f-cura", 0)[4], notes: "propia" });
    const md = [...written.entries()].find(([k]) => k.endsWith(".md"))![1];
    expect(md).toMatch(/line 2: f-cura  cura → ne-bbbbbb, which holds Cura \(f-held\): filled honorific, date_start, date_end, date_note, source; kept the held notes "propia" \(the row has "nota de f-cura"\)/);
    const second = await run(db, [fn("copy-function", A, "f-cura", "cura", [B, C])], { apply: true, now: NOW + 1000 });
    expect(second.report.outcome).toBe("nothing to write");
    expect(second.report.rows.map((r) => r.status)).toEqual(["already copied"]);
    const onlyB = await run(db, [fn("copy-function", A, "f-cura", "cura", [B])], { apply: true, now: NOW + 2000, file: "third.csv" });
    expect(onlyB.report.rows.map((r) => r.status)).toEqual(["same"]);
    expect(onlyB.report.alreadyHas[0]).toMatchObject({ outcome: "skipped" });
  });

  it("refuses two rows of one function moved onto one target in one file, and takes them in two files", async () => {
    // The Vista Florida split: two records' "Diputado" moved onto one new holder.
    const db = (holdingDb = holding([["f-dip1", A.id, "Diputado"], ["f-dip2", C.id, "diputado "]]));
    db.exec("UPDATE entity_functions SET source = NULL WHERE id = 'f-dip1'");
    const first = fn("move-function", A, "f-dip1", "Diputado", [D]);
    const second = fn("move-function", C, "f-dip2", "diputado", [D]);
    const together = await run(db, [first, second], { apply: true });
    expect(together.report.outcome).toBe("refused");
    expect(reasons(together.report)).toMatch(/line 3: function row f-dip1, which this row would fill on ne-dddddd, is moved there by line 2 of the same file: put the two lines in two files, applied one after the other/);
    expect(together.applied).toHaveLength(0);
    // In two files, one after the other.
    expect((await run(db, [first], { apply: true, file: "one.csv" })).report.outcome).toBe("verified");
    const b = await run(db, [second], { apply: true, file: "two.csv", now: NOW + 1000 });
    expect(reasons(b.report)).toBe("");
    expect(b.report.outcome).toBe("verified");
    expect(functionsOf(db, D.id)).toEqual(["f-dip1 Diputado"]);
    expect(row("f-dip1").source).toBe(metadataOf("f-dip2", 3)[4]);
    for (const [r, file] of [[first, "one.csv"], [second, "two.csv"]] as const) {
      const again = await run(db, [r], { apply: true, file, now: NOW + 2000 });
      expect(reasons(again.report)).toBe("");
      expect(again.report.outcome).toBe("nothing to write");
    }
  });

  it("refuses a fill into a row another row of the file makes, moves to several targets or fills", async () => {
    const onC = await functionRowId(FED, TENANT, "f-c", D.id);
    // A copy's row, filled by a later row.
    let r = await run(database({ functions: [["f-c", A.id, "Cura"], ["f-x", B.id, "cura"]] }), [fn("copy-function", A, "f-c", "Cura", [D]), fn("move-function", B, "f-x", "cura", [D])], { apply: true });
    expect(reasons(r.report)).toMatch(new RegExp(`line 3: function row ${onC}, which this row would fill on ne-dddddd, is created by line 2 of the same file: ${"put the two lines in two files, applied one after the other"}`));
    // A move to several targets, one of whose rows a later row fills.
    const onD = await functionRowId(FED, TENANT, "f-c", D.id);
    r = await run(database({ functions: [["f-c", A.id, "Cura"], ["f-x", B.id, "cura"]] }), [fn("move-function", A, "f-c", "Cura", [C, D]), fn("move-function", B, "f-x", "cura", [D])], { apply: true });
    expect(reasons(r.report)).toMatch(new RegExp(`line 3: function row ${onD}, which this row would fill on ne-dddddd, is created by line 2`));
    // Two rows filling one held row.
    r = await run(database({ functions: [["f-h", C.id, "Cura"], ["f-x", A.id, "cura"], ["f-z", B.id, "CURA"]] }), [fn("move-function", A, "f-x", "cura", [C]), fn("move-function", B, "f-z", "CURA", [C])], { apply: true });
    expect(reasons(r.report)).toMatch(/line 2: function row f-h, which this row would fill on ne-cccccc, is filled by line 3 of the same file/);
    expect(reasons(r.report)).toMatch(/line 3: function row f-h, which this row would fill on ne-cccccc, is filled by line 2 of the same file/);
  });
  it("moves to several targets, inserting on those without the function and filling the one that holds it", async () => {
    const db = (holdingDb = holding());
    const rows = [fn("move-function", A, "f-cura", "cura", [B, C])];
    const { report } = await run(db, rows, { apply: true });
    expect(report.outcome).toBe("verified");
    const onC = await functionRowId(FED, TENANT, "f-cura", C.id);
    expect(functionsOf(db, A.id)).toEqual([]);
    expect(functionsOf(db, B.id)).toEqual(["f-held Cura"]);
    expect(functionsOf(db, C.id)).toEqual([`${onC}  cura`]);
    const second = await run(db, rows, { apply: true, now: NOW + 1000 });
    expect(reasons(second.report)).toBe("");
    expect(second.report.rows.map((r) => r.status)).toEqual(["already moved"]);
  });

  it("does not read a folded move as done on another target that holds the function", async () => {
    const db = (holdingDb = holding([["f-other", C.id, "CURA"]]));
    expect((await run(db, [fn("move-function", A, "f-cura", "cura", [B])], { apply: true })).report.outcome).toBe("verified");
    const elsewhere = await run(db, [fn("move-function", A, "f-cura", "cura", [C])], { apply: true, now: NOW + 1000 });
    expect(elsewhere.report.outcome).toBe("refused");
    expect(reasons(elsewhere.report)).toMatch(/no changelog row of this file records its fold into a row of ne-cccccc/);
  });

  it("moves onto two targets that each hold the function, filling both", async () => {
    const db = (holdingDb = holding([["f-held2", C.id, "CURA"]]));
    db.exec("UPDATE entity_functions SET source = NULL WHERE id = 'f-held2'");
    const rows = [fn("move-function", A, "f-cura", "cura", [B, C])];
    const { report } = await run(db, rows, { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");
    expect(functionsOf(db, B.id)).toEqual(["f-held Cura"]);
    expect(functionsOf(db, C.id)).toEqual(["f-held2 CURA"]);
    const second = await run(db, rows, { apply: true, now: NOW + 1000 });
    expect(reasons(second.report)).toBe("");
    expect(second.report.rows.map((r) => r.status)).toEqual(["already moved"]);
  });

  it("refuses a copy onto a holder that lacks nothing when another line deletes the holder, in either order", async () => {
    const db = (holdingDb = holding());
    db.exec("UPDATE entity_functions SET honorific = 'h', date_start = '1', date_end = '2', date_note = 'n', source = 's' WHERE id = 'f-held'");
    const copy = fn("copy-function", A, "f-cura", "cura", [B]);
    const del = fn("delete-function", B, "f-held", "Cura");
    for (const [rows, line, other] of [[[copy, del], 2, 3], [[del, copy], 3, 2]] as const) {
      const r = await run(db, [...rows], { apply: true });
      expect(r.report.outcome).toBe("refused");
      expect(reasons(r.report)).toMatch(new RegExp(`line ${line}: function row f-held, which this row would fill on ne-bbbbbb, is deleted by line ${other} of the same file`));
    }
  });

  it("refuses a copy of a row another line of the file fills, in either order", async () => {
    // B's held row is copied to C while A's "cura" folds into it and fills its empty source.
    const db = (holdingDb = holding());
    const copy = fn("copy-function", B, "f-held", "Cura", [C]);
    const fold = fn("move-function", A, "f-cura", "cura", [B]);
    for (const [rows, line, other] of [[[copy, fold], 2, 3], [[fold, copy], 3, 2]] as const) {
      const r = await run(db, [...rows], { apply: true });
      expect(r.report.outcome).toBe("refused");
      expect(reasons(r.report)).toMatch(new RegExp(`line ${line}: function row f-held, which this row copies, is filled by line ${other} of the same file: put the two lines in two files, applied one after the other`));
    }
  });

  it("refuses a row that would fill a row another row of the file deletes", async () => {
    const db = (holdingDb = holding());
    const r = await run(db, [fn("move-function", A, "f-cura", "cura", [B]), fn("delete-function", B, "f-held", "Cura")], { apply: true });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/line 2: function row f-held, which this row would fill on ne-bbbbbb, is deleted by line 3 of the same file: put the two lines in two files, applied one after the other/);
  });
  it("refuses two merges into one survivor whose losers hold the same function, and takes them in two files", async () => {
    const db = (holdingDb = database({ functions: [["f-m1", LOSER.id, "Escribano"], ["f-c1", C.id, "escribano "]] }));
    db.exec(`UPDATE entities SET display_name = 'Juan Gil' WHERE id = '${C.id}'`);
    db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES ('l-c1', 'd2', '${C.id}', 'mentioned', 1)`);
    const other: Cells = { ...MERGE, authority_code: C.code, authority_name: "Juan Gil", name_variants_add: "", evidence_codes: "co-ahrb-cab-001-d002" };
    const together = await run(db, [MERGE, other], { apply: true });
    expect(together.report.outcome).toBe("refused");
    expect(reasons(together.report)).toMatch(/line 3: function row f-c1 of ne-cccccc would fold on ne-mmmmm2 with function row f-m1, which line 2 merges there: put the two lines in two files, applied one after the other/);
    expect((await run(db, [MERGE], { apply: true, file: "one.csv" })).report.outcome).toBe("verified");
    const b = await run(db, [other], { apply: true, file: "two.csv", now: NOW + 1000 });
    expect(reasons(b.report)).toBe("");
    expect(b.report.outcome).toBe("verified");
    expect(functionsOf(db, SURVIVOR.id)).toEqual(["f-m1 Escribano"]);
  });

  it("folds a merge loser's row of a function its survivor holds, and the report says so", async () => {
    const db = (holdingDb = database({ functions: [["f-m1", LOSER.id, "Escribano"], ["f-s1", SURVIVOR.id, "escribano"]] }));
    db.exec("UPDATE entity_functions SET source = NULL WHERE id = 'f-s1'");
    const { report, written } = await run(db, [MERGE], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(functionsOf(db, SURVIVOR.id)).toEqual(["f-s1 escribano"]);
    expect(row("f-s1").source).toBe(metadataOf("f-m1", 0)[4]);
    expect(report.totals).toMatchObject({ functionRowsMovedByMerges: 0, functionRowsFoldedByMerges: 1 });
    expect(report.mergeFolded).toEqual([expect.objectContaining({ loserCode: LOSER.code, survivorCode: SURVIVOR.code, functionId: "f-m1", into: "f-s1", filled: ["source"] })]);
    const md = [...written.entries()].find(([k]) => k.endsWith(".md"))![1];
    expect(md).toMatch(/merge of ne-mmmmm1 into ne-mmmmm2: f-m1 Escribano folds into f-s1: filled source; kept the held/);
    const second = await run(db, [MERGE], { apply: true, now: NOW + 1000 });
    expect(second.report.rows.map((r) => r.status)).toEqual(["already merged"]);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

async function refused(rows: Cells[], db = database()): Promise<string> {
  const { report, applied } = await run(db, rows, { apply: true });
  expect(report.outcome).toBe("refused");
  expect(applied).toHaveLength(0);
  expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
  return reasons(report);
}

describe("refusals", () => {
  it("refuses an unknown operation", async () => {
    expect(await refused([{ op: "split-function", ...of(A) }])).toMatch(/line 2: op "split-function" is not one of/);
  });

  it("refuses a row whose authority is not as stored", async () => {
    expect(await refused([fn("keep-function", { ...A, name: "Francisco Hernandes" }, "f-keep", "Mercader")])).toMatch(
      /authority_name "Francisco Hernandes" is not the stored name "Francisco Hernández"/,
    );
    expect(await refused([fn("keep-function", { ...A, code: "ne-zzzzzz" }, "f-keep", "Mercader")])).toMatch(/no entity has the code ne-zzzzzz/);
  });

  it("refuses a function row whose text, owner or id is not as stored", async () => {
    expect(await refused([fn("keep-function", A, "f-keep", "Mercader de lienzos")])).toMatch(
      /function row f-keep is "Mercader", not "Mercader de lienzos"/,
    );
    expect(await refused([fn("move-function", A, "f-b1", "Sastre", [C])])).toMatch(/function row f-b1 belongs to ne-bbbbbb, not ne-aaaaaa/);
    expect(await refused([fn("delete-function", A, "f-none", "Vecino")])).toMatch(/no function row has the id f-none/);
  });

  it("refuses a function row named twice", async () => {
    expect(await refused([fn("keep-function", A, "f-keep", "Mercader"), fn("delete-function", A, "f-keep", "Mercader")])).toMatch(
      /line 3: function row f-keep is named again \(line 2\)/,
    );
  });

  it("refuses a row of the wrong shape", async () => {
    expect(await refused([fn("copy-function", A, "f-copy", "Alcalde")])).toMatch(/copy-function names one or more target_codes/);
    expect(await refused([fn("keep-function", A, "f-keep", "Mercader", [B])])).toMatch(/keep-function carries no target_codes/);
    expect(await refused([fn("move-function", A, "f-move1", "Carpintero", [A])])).toMatch(/target ne-aaaaaa is the row's own authority/);
    expect(await refused([fn("move-function", A, "f-move1", "Carpintero", [B, B])])).toMatch(/target ne-bbbbbb is named twice/);
    expect(await refused([fn("move-function", A, "f-move1", "Carpintero", [{ ...B, code: "ne-yyyyyy" }])])).toMatch(/no entity has the code ne-yyyyyy/);
    expect(await refused([{ ...UPDATE, function_id: "f-keep" }])).toMatch(/update-entity carries no function_id/);
  });

  it("refuses a target outside the tenant's scope or merged away", async () => {
    expect(await refused([fn("copy-function", A, "f-copy", "Alcalde", [OWN])])).toMatch(/ot-oooooo is owned by another tenant/);
    const db = database({ entities: ENTITIES.map((e) => (e === C ? { ...C, merged: B.id } : e)) });
    expect(await refused([fn("copy-function", A, "f-copy", "Alcalde", [C])], db)).toMatch(/ne-cccccc is merged into e-b/);
  });

  it("refuses a field update the record cannot take, as the originals file of a split does", async () => {
    expect(await refused([{ ...UPDATE, display_name: "NULL" }])).toMatch(/display_name cannot be NULL/);
    expect(await refused([{ ...UPDATE, current_dates: "1600" }])).toMatch(/current_dates "1600" is not the stored "s. XVII"/);
    expect(await refused([{ ...UPDATE, name_variants_remove: "Nunca" }])).toMatch(/name_variants_remove names "Nunca"/);
    expect(await refused([UPDATE, { ...UPDATE, dates_of_existence: "" }])).toMatch(/ne-uuuuuu has another update-entity row \(line 2\)/);
  });

  it("refuses a record a merge names when another row names it too", async () => {
    expect(await refused([MERGE, fn("keep-function", LOSER, "f-m1", "Escribano")])).toMatch(
      /ne-mmmmm1 is merged by line 2, so no other row may name it/,
    );
    expect(await refused([MERGE, fn("copy-function", A, "f-copy", "Alcalde", [SURVIVOR])])).toMatch(
      /ne-mmmmm2 is merged by line 2, so no other row may name it/,
    );
  });

  it("refuses a move or copy of a function onto a record the file merges, in either order, naming both lines", async () => {
    // The merge's folds read the survivor as stored; a function brought by another row would arrive beside them.
    const onto = [
      fn("move-function", A, "f-move1", "Carpintero", [SURVIVOR]),
      fn("copy-function", A, "f-copy", "Alcalde", [SURVIVOR]),
      fn("move-function", A, "f-move1", "Carpintero", [LOSER]),
    ];
    for (const row of onto) {
      const code = row.target_codes;
      expect(await refused([MERGE, row])).toMatch(new RegExp(`line 3: ${code} is merged by line 2, so no other row may name it`));
      expect(await refused([row, MERGE])).toMatch(new RegExp(`line 2: ${code} is merged by line 3, so no other row may name it`));
    }
  });

  it("refuses a merge whose variants differ from the file's, as the reviewed merge does", async () => {
    expect(await refused([{ ...MERGE, name_variants_add: "" }])).toMatch(/would gain \["Juan Gil"\]; the list adds \[\]/);
  });

  it("refuses a file that leaves out a function row of an authority it covers", async () => {
    const rows = baseRows().filter((r) => r.function_id !== "f-del");
    expect(await refused(rows)).toMatch(/ne-aaaaaa: the file covers its functions and does not name its function row f-del \(Vecino\)/);
  });

  it("counts a row refused for its shape as naming its function row, so coverage does not report it again", async () => {
    const rows = baseRows().map((r) => (r.function_id === "f-copy" ? { ...r, target_codes: "" } : r));
    expect((await refused(rows)).split("\n")).toEqual([`${FILE} line 5: copy-function names one or more target_codes`]);
  });
});

// ---------------------------------------------------------------------------
// Changes between the plan and the write
// ---------------------------------------------------------------------------

async function aborts(change: (db: DatabaseSync) => void): Promise<void> {
  const db = database();
  const snapshot = (d: DatabaseSync) => JSON.stringify([all(d, "SELECT * FROM entity_functions ORDER BY id"), all(d, "SELECT * FROM changelog"), all(d, "SELECT * FROM entities ORDER BY id")]);
  let before = "";
  await expect(
    run(db, baseRows(), { apply: true, beforeApply: (d) => { change(d); before = snapshot(d); } }),
  ).rejects.toThrow(/ABORT|malformed JSON/);
  expect(snapshot(db)).toBe(before);
}

describe("what was read, as read", () => {
  it("aborts the file when a function row's text changes, the version unchanged", async () => {
    await aborts((d) => d.exec("UPDATE entity_functions SET function = 'Carpintero mayor' WHERE id = 'f-move1'"));
  });
  it("aborts the file when a target gains a function row", async () => {
    await aborts((d) => d.exec(`INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-new', '${C.id}', 'Alcalde', 1, 1)`));
  });
  it("aborts the file when a record's version changes", async () => {
    await aborts((d) => d.exec(`UPDATE entities SET updated_at = 6 WHERE id = '${D.id}'`));
  });
  it("refuses, before anything is written, a file whose done rows sit beside a row to write", async () => {
    const db = database();
    expect((await run(db, baseRows(), { apply: true })).report.outcome).toBe("verified");
    // A second file whose plan finds f-del gone, but a row of that id appears, on a record the file does not read, before the write.
    const rows = [fn("delete-function", A, "f-del", "Vecino"), fn("copy-function", A, "f-keep", "Mercader", [B])];
    // The file holds a row done and a row to write: it was applied and has changed since, and is refused at plan.
    const { report, applied } = await run(db, rows, { apply: true, now: NOW + 1000 });
    expect(applied).toEqual([]);
    expect(report.refusals.map((f) => f.reason).join("\n")).toMatch(/this file was applied before and has changed since: put new changes in a new file/);
  });
  it("aborts the file when the tenant is disabled", async () => {
    await aborts((d) => d.exec(`UPDATE tenants SET disabled_at = 1 WHERE id = '${TENANT}'`));
  });
  it("aborts the file when the actor moves to another tenant", async () => {
    await aborts((d) => d.exec("UPDATE users SET tenant_id = 't-2' WHERE id = 'user_001'"));
  });
  it("aborts the file when the actor loses the permission read", async () => {
    await aborts((d) => d.exec("UPDATE users SET is_admin = 0, is_records_admin = 1 WHERE id = 'user_001'"));
  });
  it("aborts the file when the tenant's authorities are turned off", async () => {
    await aborts((d) => d.exec(`UPDATE tenants SET authorities_enabled = 0 WHERE id = '${TENANT}'`));
  });
  it("aborts the file when the actor stops being a steward of the federation", async () => {
    await aborts((d) => d.exec(`UPDATE federations SET status = 'suspended' WHERE id = '${FED}'`));
  });
  it("aborts the file when an id a copy would make is taken by a row elsewhere", async () => {
    const copyC = await functionRowId(FED, TENANT, "f-copy", C.id);
    await aborts((d) => d.exec(`INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('${copyC}', '${OWN.id}', 'Alcalde', 1, 1)`));
  });
});


// ---------------------------------------------------------------------------
// Second review: rows read, rows relied on, and what a rerun may accept
// ---------------------------------------------------------------------------

describe("every function row the plan holds, as read", () => {
  it("refuses a plan whose function rows change between its own reads", async () => {
    // f-copy moves away after the lookup by id and before the read of A's rows.
    let moved = false;
    const db = database();
    const { report, applied } = await run(db, baseRows(), {
      apply: true,
      onRead: (sql, d) => {
        if (!moved && /FROM entity_functions WHERE id IN/.test(sql)) {
          moved = true;
          d.exec(`UPDATE entity_functions SET entity_id = '${OWN.id}' WHERE id = 'f-copy'`);
        }
      },
    });
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/function row f-copy changed while the plan read it/);
    expect(applied).toHaveLength(0);
  });

  it("aborts the file when a merge loser's function row changes in any column", async () => {
    await aborts((d) => d.exec("UPDATE entity_functions SET notes = 'otra nota' WHERE id = 'f-m1'"));
  });

  it("aborts the file when a function row's rowid changes, which orders the changelog's text", async () => {
    await aborts((d) => d.exec("UPDATE entity_functions SET rowid = 1000 WHERE id = 'f-keep'"));
  });
});

describe("a target row counts as done only when it is the row this operation makes", () => {
  it("refuses a move onto copies whose columns no longer match the source", async () => {
    const db = database();
    expect((await run(db, [fn("copy-function", A, "f-copy", "Alcalde", [B, C])], { apply: true })).report.outcome).toBe("verified");
    db.exec("UPDATE entity_functions SET notes = 'nota nueva', date_end = '1650' WHERE id = 'f-copy'");
    const { report, applied } = await run(db, [fn("move-function", A, "f-copy", "Alcalde", [B, C])], { apply: true, now: NOW + 1000, file: "second.csv" });
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/the row f-copy makes on ne-bbbbbb, does not hold f-copy's columns \(date_end, notes\)/);
    expect(applied).toHaveLength(0);
    expect(functionsOf(db, A.id)).toContain("f-copy Alcalde");
  });

  it("refuses a copy whose made row has lost a field the source holds", async () => {
    const db = database();
    const rows = [fn("copy-function", A, "f-copy", "Alcalde", [B])];
    expect((await run(db, rows, { apply: true })).report.outcome).toBe("verified");
    const copyB = await functionRowId(FED, TENANT, "f-copy", B.id);
    db.exec(`UPDATE entity_functions SET source = NULL WHERE id = '${copyB}'`);
    const again = await run(db, rows, { apply: true, now: NOW + 1000 });
    expect(again.report.outcome).toBe("refused");
    expect(reasons(again.report)).toMatch(/does not hold f-copy's columns \(source\)/);
  });

  it("refuses a delete of a row that never existed, whatever the changelog says of its text", async () => {
    const db = database();
    expect((await run(db, baseRows(), { apply: true })).report.outcome).toBe("verified");
    const r = await run(db, [fn("delete-function", A, "f-typo", "Vecino")], { apply: true, now: NOW + 1000 });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/no function row has the id f-typo, and no changelog row of this file records its removal from ne-aaaaaa/);
  });

  it("refuses a move of a row its target always held", async () => {
    const r = await run(database(), [fn("move-function", A, "f-b1", "Sastre", [B])], { apply: true });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/function row f-b1 is on ne-bbbbbb, and no changelog row of this file records its move from ne-aaaaaa/);
  });

  it("refuses to change a function text that holds a line break, which the editor's one-per-line text cannot show", async () => {
    const db = database({ functions: [...FUNCTIONS, ["f-multi", A.id, "Uno\nDos"]] });
    const r = await run(db, [fn("delete-function", A, "f-multi", "Uno\nDos")], { apply: true });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/function row f-multi holds a line break/);
  });
});

describe("rows that rely on one another", () => {
  it("refuses a file one of whose rows touches a row another row relies on", async () => {
    const db = database();
    expect((await run(db, [fn("copy-function", A, "f-copy", "Alcalde", [B])], { apply: true })).report.outcome).toBe("verified");
    const copyB = await functionRowId(FED, TENANT, "f-copy", B.id);
    // The copy finds its row already made on B, as a move to several targets would; a move that found it on
    // one target and not another is partly present, and is refused for that before this check.
    const r = await run(db, [fn("copy-function", A, "f-copy", "Alcalde", [B]), fn("delete-function", B, copyB, "Alcalde")], { apply: true, now: NOW + 1000, file: "second.csv" });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(new RegExp(`line 3: function row ${copyB} is relied on by line 2`));
    expect(r.applied).toHaveLength(0);
  });

  it("closes the file with a guard on every row it expects to remain, kept rows among them", async () => {
    const { applied } = await run(database(), baseRows(), { apply: true });
    const statements = applied[0];
    const lastWrite = statements.map((x, i) => (/^(insert|update|delete)/i.test(x) ? i : -1)).reduce((a, b) => Math.max(a, b));
    expect(statements.slice(lastWrite + 1).some((x) => x.includes("'f-keep'") && x.includes("'f-b1'") && x.includes("'f-d1'"))).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Third review: the file applied is the file planned; reruns match the text
// ---------------------------------------------------------------------------

describe("the SQL file applied", () => {
  it("names every run's files with its stamp and a random suffix", async () => {
    const { written } = await run(database(), baseRows(), { newId: "abcdef12-3456-4789-8abc-def012345678" });
    expect([...written.keys()].filter((k) => k.endsWith(".sql"))).toEqual([expect.stringMatching(/^\.import\/authorities_staging_\d{8}T\d{6}Z-abcdef12\.sql$/)]);
  });

  it("refuses to write its SQL file over one that exists", async () => {
    const written = new Map<string, string>();
    await run(database(), baseRows(), { written });
    await expect(run(database(), baseRows(), { written, apply: true })).rejects.toThrow(/already exists/);
  });

  it("applies nothing when the file on disk is not the SQL this run planned", async () => {
    const db = database();
    let applied = 0;
    await expect(
      run(db, baseRows(), {
        apply: true,
        beforeApply: () => { applied++; },
        beforeApplyFile: (w) => {
          for (const k of w.keys()) if (k.endsWith(".sql")) w.set(k, "DELETE FROM entity_functions WHERE id = 'f-alf';\n");
        },
      }),
    ).rejects.toThrow(/does not hold the SQL this run planned/);
    expect(applied).toBe(0);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
  });
});

describe("a rerun names the row's text", () => {
  it("refuses a rerun of a delete that names another text", async () => {
    const db = database();
    expect((await run(db, baseRows(), { apply: true })).report.outcome).toBe("verified");
    const r = await run(db, [fn("delete-function", A, "f-del", "Carpintero")], { apply: true, now: NOW + 1000 });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/the changelog row of this file for f-del does not show "Carpintero" leaving ne-aaaaaa/);
  });

  it("refuses a rerun of a move or a copy that names another text", async () => {
    const db = database();
    expect((await run(db, baseRows(), { apply: true })).report.outcome).toBe("verified");
    const again = (row: Cells) => run(db, [row], { apply: true, now: NOW + 1000 });
    expect(reasons((await again(fn("move-function", A, "f-move1", "Sastre", [B]))).report)).toMatch(/function row f-move1 is "Carpintero", not "Sastre"/);
    expect(reasons((await again(fn("move-function", A, "f-move2", "Alcalde", [B, C]))).report)).toMatch(/the row f-move2 makes on ne-bbbbbb, is not as planned/);
    expect(reasons((await again(fn("copy-function", A, "f-copy", "Mercader", [C, D]))).report)).toMatch(/function row f-copy is "Alcalde", not "Mercader"/);
  });
});

// ---------------------------------------------------------------------------
// Renaming a function row
// ---------------------------------------------------------------------------

const RENAME_HEADER = [...HEADER, "new_function", "new_honorific"];
const OLD = "Alcalde de la hermandad";
const NEW = "Alcalde de la Santa Hermandad";
/** B gains a row with the old form of the office, as the tenth seeded row (honorific "don 9"). */
const renameDb = (over: { entities?: EntitySeed[] } = {}) => {
  const db = database({ ...over, functions: [...FUNCTIONS, ["f-her", B.id, OLD]] });
  db.exec(`UPDATE entities SET primary_function = '${OLD}' WHERE id = '${B.id}'`);
  return db;
};
const rename = (e: EntitySeed, id: string, from: string, to: string, extra: Cells = {}): Cells => ({
  op: "rename-function", ...of(e), function_id: id, function: from, new_function: to, changelog_note: "The Santa Hermandad, as ruled.", ...extra,
});
const renameRun = (db: DatabaseSync, rows: Cells[], opts: Parameters<typeof run>[2] = {}) => run(db, rows, { header: RENAME_HEADER, ...opts });
const rowOf = (db: DatabaseSync, id: string) => all(db, `SELECT rowid AS rid, * FROM entity_functions WHERE id = '${id}'`)[0];

describe("rename-function", () => {
  it("reads the row's new text and honorific, and refuses them on another operation", async () => {
    const [row] = parseChangeFile(csvOf(RENAME_HEADER, [rename(B, "f-her", OLD, NEW, { new_honorific: "don" })]), FILE);
    expect(row.cells).toMatchObject({ op: "rename-function", function_id: "f-her", function: OLD, new_function: NEW, new_honorific: "don" });
    expect(reasons((await renameRun(renameDb(), [{ ...fn("keep-function", B, "f-b1", "Sastre"), new_function: NEW }])).report)).toMatch(
      /keep-function carries no new_function/,
    );
    expect(reasons((await renameRun(renameDb(), [rename(B, "f-her", OLD, NEW, { target_codes: C.code })])).report)).toMatch(
      /rename-function carries no target_codes/,
    );
  });

  it("sets the row's text, gives the record a new version and a changelog row, and reads it back", async () => {
    const db = renameDb();
    const before = rowOf(db, "f-her");
    const { report, log, written } = await renameRun(db, [rename(B, "f-her", OLD, NEW)], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(report.totals).toMatchObject({ rows: 1, rename: 1, functionRowsRenamed: 1, entitiesVersioned: 1, alreadyDone: 0, same: 0 });
    // The row keeps its id, rowid, owner and every other column; its text and updated_at change.
    const after = rowOf(db, "f-her");
    expect(after).toEqual({ ...before, function: NEW, updated_at: NOW });
    expect(functionsOf(db, B.id)).toEqual(["f-b1 Sastre", `f-her ${NEW}`]);
    // The record takes a new version; its primary function is not touched.
    expect(all(db, `SELECT updated_at, primary_function FROM entities WHERE id = '${B.id}'`)[0]).toEqual({ updated_at: NOW, primary_function: OLD });
    // One changelog row, under the id made from the file, the row and the record, with the file's note.
    const journal = all(db, "SELECT id, record_id, record_type, kind, note, diff, acted_as FROM changelog");
    expect(journal).toEqual([{
      id: await newRecordId(FED, TENANT, FILE, `rename|f-her|${B.id}`, "entity-function-journal"), record_id: B.id, record_type: "entity",
      kind: "update", note: "The Santa Hermandad, as ruled.", diff: JSON.stringify({ functions: { old: `Sastre\n${OLD}`, new: `Sastre\n${NEW}` } }), acted_as: null,
    }]);
    // The summary line, the markdown and the JSON report count it beside the other function rows.
    expect(log.find((l) => /rows:/.test(l))).toMatch(/0 delete, 1 rename, 0 update/);
    expect(log.find((l) => /function rows:/.test(l))).toMatch(/0 deleted, 1 renamed,/);
    const md = [...written].find(([k]) => k.endsWith(".md"))![1];
    expect(md).toContain("| Move / copy / delete / rename | 0 / 0 / 0 / 1 |");
    expect(md).toContain("| Function rows moved / inserted / deleted / renamed | 0 / 0 / 0 / 1 |");
    expect(md).toContain(`| f-her | ${OLD} → ${NEW} |`);
    const json = JSON.parse([...written].find(([k]) => k.endsWith(".json"))![1]) as AuthoritiesReport;
    expect(json.rows[0]).toMatchObject({ op: "rename-function", status: "rename", functionId: "f-her", function: OLD, newFunction: NEW });
  });

  it("sets the honorific when the row gives one, and clears it on NULL", async () => {
    const db = renameDb();
    expect((await renameRun(db, [rename(B, "f-her", OLD, NEW, { new_honorific: "don Pedro" })], { apply: true })).report.outcome).toBe("verified");
    expect(rowOf(db, "f-her")).toMatchObject({ function: NEW, honorific: "don Pedro" });
    expect(JSON.parse(all(db, "SELECT diff FROM changelog")[0].diff)).toEqual({
      functions: { old: `Sastre\n${OLD}`, new: `Sastre\n${NEW}` }, functionHonorific: { old: "don 9", new: "don Pedro" },
    });
    // The honorific alone: the functions text does not change, and the record still takes a new version.
    const cleared = await renameRun(db, [rename(B, "f-her", NEW, NEW, { new_honorific: "NULL" })], { apply: true, now: NOW + 1000, file: "second.csv" });
    expect(reasons(cleared.report)).toBe("");
    expect(cleared.report.outcome).toBe("verified");
    expect(rowOf(db, "f-her")).toMatchObject({ function: NEW, honorific: null });
    expect(JSON.parse(all(db, "SELECT diff FROM changelog ORDER BY created_at DESC")[0].diff)).toEqual({ functionHonorific: { old: "don Pedro", new: null } });
    expect(all(db, `SELECT updated_at FROM entities WHERE id = '${B.id}'`)[0].updated_at).toBe(NOW + 1000);
  });

  it("reads a second run of the file as already renamed and writes nothing", async () => {
    const db = renameDb();
    const rows = [rename(B, "f-her", OLD, NEW, { new_honorific: "don Pedro" })];
    expect((await renameRun(db, rows, { apply: true })).report.outcome).toBe("verified");
    const snapshot = () => JSON.stringify([all(db, "SELECT * FROM changelog"), all(db, "SELECT * FROM entity_functions ORDER BY id"), all(db, "SELECT * FROM entities ORDER BY id")]);
    const held = snapshot();
    const second = await renameRun(db, rows, { apply: true, now: NOW + 1000 });
    expect(reasons(second.report)).toBe("");
    expect(second.report.outcome).toBe("nothing to write");
    expect(second.report.rows.map((r) => r.status)).toEqual(["already renamed"]);
    expect(second.report.totals).toMatchObject({ alreadyDone: 1, same: 0, rename: 0 });
    expect(second.applied).toHaveLength(0);
    expect(snapshot()).toBe(held);
  });

  it("reads a row whose function row already holds the new text, with no changelog row of this file, as same", async () => {
    const db = renameDb();
    db.exec(`UPDATE entity_functions SET function = '${NEW}' WHERE id = 'f-her'`);
    const r = await renameRun(db, [rename(B, "f-her", OLD, NEW), rename(B, "f-b1", "Sastre", "Sastre", { new_honorific: "don 6" })], { apply: true });
    expect(reasons(r.report)).toBe("");
    expect(r.report.outcome).toBe("nothing to write");
    expect(r.report.rows.map((x) => x.status)).toEqual(["same", "same"]);
    expect(r.report.totals).toMatchObject({ same: 2, alreadyDone: 0, rename: 0 });
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
    // The same text with another honorific is a write, not same.
    const h = await renameRun(db, [rename(B, "f-her", NEW, NEW, { new_honorific: "don Pedro" })]);
    expect(h.report.rows.map((x) => x.status)).toEqual(["rename"]);
  });

  it("refuses a row whose function row is not on the entity, or not there at all", async () => {
    expect(reasons((await renameRun(renameDb(), [rename(A, "f-her", OLD, NEW)])).report)).toMatch(/function row f-her belongs to ne-bbbbbb, not ne-aaaaaa/);
    expect(reasons((await renameRun(renameDb(), [rename(B, "f-none", OLD, NEW)])).report)).toMatch(/no function row has the id f-none/);
  });

  it("refuses a row whose current text is not the stored text", async () => {
    const { report, applied } = await renameRun(renameDb(), [rename(B, "f-her", "Alcalde de la Hermandad vieja", NEW)], { apply: true });
    expect(report.outcome).toBe("refused");
    expect(applied).toHaveLength(0);
    expect(reasons(report)).toMatch(/function row f-her is "Alcalde de la hermandad", not "Alcalde de la Hermandad vieja"/);
  });

  it("refuses a row on an entity merged away", async () => {
    const db = renameDb({ entities: ENTITIES.map((e) => (e === B ? { ...B, merged: C.id } : e)) });
    expect(reasons((await renameRun(db, [rename(B, "f-her", OLD, NEW)])).report)).toMatch(/ne-bbbbbb is merged into e-c/);
  });

  it("refuses a new text that is blank after trimming, or holds a line break", async () => {
    expect(reasons((await renameRun(renameDb(), [rename(B, "f-her", OLD, "   ")])).report)).toMatch(/rename-function names no new_function/);
    expect(reasons((await renameRun(renameDb(), [rename(B, "f-her", OLD, "Alcalde\nde la Santa Hermandad")])).report)).toMatch(/function row f-her holds a line break/);
  });

  it("refuses a function row a rename names when another row names it too, and counts it for coverage", async () => {
    expect(reasons((await renameRun(renameDb(), [rename(B, "f-her", OLD, NEW), fn("delete-function", B, "f-her", OLD)])).report)).toMatch(
      /line 3: function row f-her is named again \(line 2\)/,
    );
    const covered = await renameRun(renameDb(), [rename(B, "f-her", OLD, NEW), fn("keep-function", B, "f-b1", "Sastre"), { op: "cover-functions", ...of(B) }]);
    expect(reasons(covered.report)).toBe("");
    expect(covered.report.totals).toMatchObject({ rename: 1, keep: 1, cover: 1 });
  });

  it("refuses a rerun whose row has changed since the file was applied", async () => {
    const db = renameDb();
    expect((await renameRun(db, [rename(B, "f-her", OLD, NEW)], { apply: true })).report.outcome).toBe("verified");
    // The same file now also gives an honorific: its changelog row exists, and the row would write more.
    expect(reasons((await renameRun(db, [rename(B, "f-her", OLD, NEW, { new_honorific: "don Pedro" })], { now: NOW + 1000 })).report)).toMatch(
      /line 2 was applied before and has changed since: put new changes in a new file \(part of its effect is present: a changelog row of this file records a rename of f-her/,
    );
  });

  it("refuses a rerun whose changelog row does not record the change the row gives", async () => {
    const db = renameDb();
    expect((await renameRun(db, [rename(B, "f-her", OLD, NEW, { new_honorific: "don Pedro" })], { apply: true })).report.outcome).toBe("verified");
    // The row now gives no honorific, though the changelog row records one.
    expect(reasons((await renameRun(db, [rename(B, "f-her", OLD, NEW)], { now: NOW + 1000 })).report)).toMatch(
      /the changelog row of this file for f-her records a change of the honorific, which the row does not give/,
    );
    // The row names another old text than the one the changelog row shows leaving.
    expect(reasons((await renameRun(db, [rename(B, "f-her", "Alcalde ordinario", NEW, { new_honorific: "don Pedro" })], { now: NOW + 1000 })).report)).toMatch(
      /does not show "Alcalde ordinario" becoming "Alcalde de la Santa Hermandad" on ne-bbbbbb/,
    );
  });

  it("aborts the file when the row's text or honorific changes between the plan and the write", async () => {
    for (const change of [
      `UPDATE entity_functions SET function = 'Alcalde de la hermandad vieja' WHERE id = 'f-her'`,
      `UPDATE entity_functions SET honorific = 'otro' WHERE id = 'f-her'`,
    ]) {
      const db = renameDb();
      await expect(renameRun(db, [rename(B, "f-her", OLD, NEW)], { apply: true, beforeApply: (d) => d.exec(change) })).rejects.toThrow(/ABORT|malformed JSON/);
      expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
      expect(all(db, `SELECT updated_at FROM entities WHERE id = '${B.id}'`)[0].updated_at).toBe(5);
    }
  });
});

describe("rename-function onto a function the record holds", () => {
  /** B holds "f-new" (the new form, only notes set) beside "f-her" (the old form, every field set). */
  const holderDb = () => {
    const db = database({ functions: [...FUNCTIONS, ["f-her", B.id, OLD], ["f-new", B.id, NEW.toLowerCase()]] });
    db.exec("UPDATE entity_functions SET honorific = NULL, date_start = NULL, date_end = NULL, date_note = NULL, source = NULL, notes = 'propia' WHERE id = 'f-new'");
    return db;
  };

  it("fills the held row from the renamed one and deletes the renamed row; a rerun finds it done", async () => {
    const db = holderDb();
    const rows = [rename(B, "f-her", OLD, NEW, { new_honorific: "don Pedro" })];
    const { report, written } = await renameRun(db, rows, { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(functionsOf(db, B.id)).toEqual(["f-b1 Sastre", `f-new ${NEW.toLowerCase()}`]);
    const [, start, end, dateNote, source] = metadataOf("f-her", 9);
    // The honorific the row gives is the one the held row takes.
    expect(rowOf(db, "f-new")).toMatchObject({ honorific: "don Pedro", date_start: start, date_end: end, date_note: dateNote, source, notes: "propia", updated_at: NOW });
    expect(report.totals).toMatchObject({ rename: 1, functionRowsRenamed: 0, functionRowsDeleted: 1, functionRowsFilled: 1 });
    expect(report.alreadyHas).toEqual([expect.objectContaining({
      line: 2, functionId: "f-her", target: B.code, heldId: "f-new", outcome: "filled",
      conflicts: [{ field: "notes", held: "propia", incoming: "nota de f-her" }],
    })]);
    expect([...written.entries()].find(([k]) => k.endsWith(".md"))![1]).toMatch(/line 2: f-her .* → ne-bbbbbb, which holds .* \(f-new\): filled honorific, date_start/);
    const journal = all(db, `SELECT diff FROM changelog WHERE record_id = '${B.id}'`).map((j) => JSON.parse(j.diff));
    expect(journal).toHaveLength(1);
    expect(journal[0].functions).toEqual({ old: `Sastre\n${OLD}\n${NEW.toLowerCase()}`, new: `Sastre\n${NEW.toLowerCase()}` });
    expect(journal[0].functionFields.new).toMatchObject({ id: "f-new", honorific: "don Pedro", source });
    const second = await renameRun(db, rows, { apply: true, now: NOW + 1000 });
    expect(reasons(second.report)).toBe("");
    expect(second.report.rows.map((r) => r.status)).toEqual(["already renamed"]);
  });

  it("refuses two renames onto one new text in one file, and takes them in two files", async () => {
    const db = database({ functions: [...FUNCTIONS, ["f-r1", B.id, "Regidor"], ["f-r2", B.id, "Alcalde"]] });
    db.exec("UPDATE entity_functions SET source = NULL WHERE id = 'f-r1'");
    const first = rename(B, "f-r1", "Regidor", "Cura");
    const second = rename(B, "f-r2", "Alcalde", "cura");
    const together = await renameRun(db, [first, second], { apply: true });
    expect(together.report.outcome).toBe("refused");
    expect(reasons(together.report)).toMatch(/line 3: function row f-r1, which this row would fill on ne-bbbbbb, is renamed by line 2 of the same file: put the two lines in two files, applied one after the other/);
    expect((await renameRun(db, [first], { apply: true, file: "one.csv" })).report.outcome).toBe("verified");
    const b = await renameRun(db, [second], { apply: true, file: "two.csv", now: NOW + 1000 });
    expect(reasons(b.report)).toBe("");
    expect(b.report.outcome).toBe("verified");
    expect(functionsOf(db, B.id)).toEqual(["f-b1 Sastre", "f-r1 Cura"]);
    expect(rowOf(db, "f-r1").source).toBe(metadataOf("f-r2", 10)[4]);
    for (const [r, file] of [[first, "one.csv"], [second, "two.csv"]] as const) {
      const again = await renameRun(db, [r], { apply: true, file, now: NOW + 2000 });
      expect(reasons(again.report)).toBe("");
      expect(again.report.outcome).toBe("nothing to write");
    }
  });

  it("refuses a fold into a row whose honorific another rename of the file sets", async () => {
    const db = holderDb();
    const r = await renameRun(db, [rename(B, "f-new", NEW.toLowerCase(), NEW.toLowerCase(), { new_honorific: "don Luis" }), rename(B, "f-her", OLD, NEW)], { apply: true });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/line 3: function row f-new, which this row would fill on ne-bbbbbb, is renamed by line 2 of the same file/);
  });
  it("refuses a fold into a row another line renames to what it holds, in either order", async () => {
    // A rename that changes nothing plans as "same"; it still reads the row the fold fills.
    const db = holderDb();
    const keep = rename(B, "f-new", NEW.toLowerCase(), NEW.toLowerCase(), { new_honorific: "NULL" });
    const fold = rename(B, "f-her", OLD, NEW);
    for (const [rows, line, other] of [[[keep, fold], 3, 2], [[fold, keep], 2, 3]] as const) {
      const r = await renameRun(db, [...rows], { apply: true });
      expect(r.report.outcome).toBe("refused");
      expect(reasons(r.report)).toMatch(new RegExp(`line ${line}: function row f-new, which this row would fill on ne-bbbbbb, is renamed by line ${other} of the same file`));
    }
  });

  it("refuses a fold into a row a later rename gives another text", async () => {
    const db = database({ functions: [...FUNCTIONS, ["f-cura", A.id, "Cura"], ["f-h", B.id, "cura"]] });
    const r = await renameRun(db, [fn("move-function", A, "f-cura", "Cura", [B]), rename(B, "f-h", "cura", "Regidor")], { apply: true });
    expect(r.report.outcome).toBe("refused");
    expect(reasons(r.report)).toMatch(/line 2: function row f-h, which this row would fill on ne-bbbbbb, is renamed by line 3 of the same file: put the two lines in two files, applied one after the other/);
  });
  it("does not read a folded rename as done for another text the record holds", async () => {
    const db = holderDb();
    db.exec(`INSERT INTO entity_functions (id, entity_id, function, created_at, updated_at) VALUES ('f-third', '${B.id}', 'Regidor', 1, 1)`);
    expect((await renameRun(db, [rename(B, "f-her", OLD, NEW)], { apply: true })).report.outcome).toBe("verified");
    const other = await renameRun(db, [rename(B, "f-her", OLD, "Regidor")], { apply: true, now: NOW + 1000 });
    expect(other.report.outcome).toBe("refused");
    expect(reasons(other.report)).toMatch(/no changelog row of this file records its fold into a row of ne-bbbbbb holding "Regidor"/);
  });

  it("deletes the renamed row without a fill when the held row lacks nothing", async () => {
    const db = holderDb();
    db.exec("UPDATE entity_functions SET honorific = 'h', date_start = '1', date_end = '2', date_note = 'n', source = 's' WHERE id = 'f-new'");
    const { report } = await renameRun(db, [rename(B, "f-her", OLD, NEW)], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(functionsOf(db, B.id)).toEqual(["f-b1 Sastre", `f-new ${NEW.toLowerCase()}`]);
    expect(report.alreadyHas[0]).toMatchObject({ outcome: "skipped" });
    expect(all(db, `SELECT count(*) AS n FROM changelog WHERE record_id = '${B.id}'`)[0].n).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Who acts on a member workspace of the federation
// ---------------------------------------------------------------------------

/**
 * `neogranadina` (t-1) leads fed-1; `other` (t-2) and `third` (t-3) are
 * its members. `admin@example.org` is the lead's admin.
 */
function federationDb(): DatabaseSync {
  const db = database();
  db.exec("ALTER TABLE tenants ADD COLUMN kind TEXT NOT NULL DEFAULT 'tenant'");
  db.exec("ALTER TABLE tenants ADD COLUMN status TEXT");
  db.exec("ALTER TABLE users ADD COLUMN is_platform_admin INTEGER DEFAULT 0");
  db.exec(`INSERT INTO tenants (id, slug, federation_id, disabled_at, authorities_enabled, entity_code_prefix, place_code_prefix)
    VALUES ('t-3', 'third', '${FED}', NULL, 1, 'th', 'tp')`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin, is_records_admin, is_authorities_admin, is_platform_admin) VALUES
    ('user_lead', 'lead-cataloguer@example.org', 'Lead cataloguer', '${TENANT}', 0, 1, 1, 0),
    ('user_third', 'third-admin@example.org', 'Third admin', 't-3', 1, 0, 0, 0),
    ('user_platform', 'platform@example.org', 'Platform admin', 't-3', 0, 0, 0, 1)`);
  // The member's own descriptions under the codes the merge row cites, linked to both records.
  db.exec("INSERT INTO descriptions VALUES ('o1', 't-2', 'co-ahrb-cab-001-d001'), ('o2', 't-2', 'co-ahrb-cab-001-d002')");
  db.exec(`INSERT INTO description_entities (id, description_id, entity_id, role, created_at) VALUES
    ('l-o1', 'o1', '${LOSER.id}', 'mentioned', 1), ('l-o2', 'o2', '${SURVIVOR.id}', 'mentioned', 1)`);
  return db;
}

/** A field change on the member's own entity, which needs no steward. */
const MEMBER_UPDATE: Cells = {
  op: "update-entity", ...of(OWN), current_name: OWN.name, current_dates: "", display_name: "Otro de Tal",
  changelog_note: "The full name.",
};

/** The messages of the opening guards of the planned file that fail once `change` has run (node:sqlite reports a guard's abort as malformed JSON). */
async function failingGuards(db: DatabaseSync, rows: Cells[], tenant: string, actorEmail: string, change: (db: DatabaseSync) => void): Promise<string[]> {
  const { written } = await run(db, rows, { tenant, actorEmail });
  const sql = [...written].find(([k]) => k.endsWith(".sql"))![1];
  change(db);
  const statements = sql.split("\n");
  const opening = statements.slice(0, statements.findIndex((x) => !x.startsWith("SELECT CASE")));
  return opening.filter((x) => {
    try {
      db.prepare(x).all();
      return false;
    } catch {
      return true;
    }
  }).map((x) => /'ABORT: ((?:[^']|'')*)'/.exec(x)![1].replace(/''/g, "'"));
}

describe("who acts on a member workspace", () => {
  it("lets the lead's admin plan and apply on a member, and reports that they acted as the lead's admin", async () => {
    const db = federationDb();
    const plan = await run(db, [MEMBER_UPDATE], { tenant: "other" });
    expect(reasons(plan.report)).toBe("");
    expect(plan.report.outcome).toBe("dry run");
    expect(plan.report.actor).toEqual({ id: "user_001", email: "admin@example.org", actedAs: "lead-admin", homeTenant: "neogranadina" });
    const { report } = await run(db, [MEMBER_UPDATE], { tenant: "other", apply: true, now: NOW + 1000 });
    expect(report.outcome).toBe("verified");
    expect(all(db, `SELECT display_name FROM entities WHERE id = '${OWN.id}'`)[0].display_name).toBe("Otro de Tal");
    expect(all(db, `SELECT user_id FROM changelog WHERE record_id = '${OWN.id}'`)).toEqual([{ user_id: "user_001" }]);
  });

  it("refuses the lead's admin a change to the federation's shared records from a member: as in the app, they are no steward there", async () => {
    const db = federationDb();
    await expect(run(db, [UPDATE], { tenant: "other", apply: true })).rejects.toThrow(
      /admin@example.org is not a steward of neogranadina-fed, whose shared records the file changes/,
    );
    await expect(run(federationDb(), [MERGE], { tenant: "other" })).rejects.toThrow(/is not a steward of neogranadina-fed/);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
  });

  it("lets the lead's admin change shared records from a member when they hold a steward membership, as the app does", async () => {
    const db = federationDb();
    db.exec(`INSERT INTO federation_memberships VALUES ('m-1', 'user_001', '${FED}', 'steward')`);
    const { report } = await run(db, [UPDATE], { tenant: "other", apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
  });

  it("aborts the file when the lead's admin's steward membership is removed before the apply", async () => {
    const db = federationDb();
    db.exec(`INSERT INTO federation_memberships VALUES ('m-1', 'user_001', '${FED}', 'steward')`);
    await expect(run(db, [UPDATE], { tenant: "other", apply: true, beforeApply: (d) => d.exec("DELETE FROM federation_memberships") }))
      .rejects.toThrow(/ABORT|malformed JSON/);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
  });

  it("refuses a user of the lead who is not its admin", async () => {
    await expect(run(federationDb(), [MEMBER_UPDATE], { tenant: "other", actorEmail: "lead-cataloguer@example.org" })).rejects.toThrow(
      /lead-cataloguer@example.org may not act in other: a user of neogranadina, not a platform admin, and not an admin of the lead workspace of other's federation/,
    );
  });

  it("refuses an admin of another member workspace", async () => {
    await expect(run(federationDb(), [MEMBER_UPDATE], { tenant: "other", actorEmail: "third-admin@example.org" })).rejects.toThrow(
      /third-admin@example.org may not act in other: a user of third/,
    );
  });

  it("refuses the lead's admin on a workspace of another federation", async () => {
    const db = federationDb();
    db.exec("INSERT INTO federations (id, slug, status, lead_tenant_id, shared_authorities_enabled) VALUES ('fed-2', 'otra', 'active', 't-9', 1)");
    db.exec("INSERT INTO tenants (id, slug, federation_id, authorities_enabled) VALUES ('t-9', 'ajena', 'fed-2', 1)");
    await expect(run(db, [MEMBER_UPDATE], { tenant: "ajena" })).rejects.toThrow(/admin@example.org may not act in ajena/);
  });

  it("refuses the lead's admin on a suspended member, and while the federation is suspended", async () => {
    const db = federationDb();
    db.exec("UPDATE tenants SET status = 'suspended' WHERE id = 't-2'");
    await expect(run(db, [MEMBER_UPDATE], { tenant: "other" })).rejects.toThrow(/may not act in other/);
    const fed = federationDb();
    fed.exec(`UPDATE federations SET status = 'suspended' WHERE id = '${FED}'`);
    await expect(run(fed, [MEMBER_UPDATE], { tenant: "other" })).rejects.toThrow(/may not act in other/);
  });

  it("lets a platform admin act on a member, and reports that they acted as a platform admin", async () => {
    const db = federationDb();
    const { report } = await run(db, [MEMBER_UPDATE], { tenant: "other", actorEmail: "platform@example.org", apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(report.actor).toEqual({ id: "user_platform", email: "platform@example.org", actedAs: "platform-admin", homeTenant: "third" });
  });

  it("reports a user of the tenant as acting as a member", async () => {
    const { report } = await run(database(), [UPDATE]);
    expect(report.actor).toEqual({ id: "user_001", email: "admin@example.org", actedAs: "member", homeTenant: "neogranadina" });
  });

  it("writes acted_as lead-admin on every changelog row of the lead's admin's apply on a member", async () => {
    const db = federationDb();
    // A steward membership lets the base file change the shared records it names.
    db.exec(`INSERT INTO federation_memberships VALUES ('m-1', 'user_001', '${FED}', 'steward')`);
    const { report } = await run(db, baseRows(), { tenant: "other", apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const rows = all(db, "SELECT kind, record_type, acted_as FROM changelog");
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.acted_as))).toEqual(new Set(["lead-admin"]));
  });

  it("writes acted_as platform-admin for a platform admin, and NULL for a member", async () => {
    const db = federationDb();
    expect((await run(db, [MEMBER_UPDATE], { tenant: "other", actorEmail: "platform@example.org", apply: true })).report.outcome).toBe("verified");
    expect(all(db, "SELECT acted_as FROM changelog")).toEqual([{ acted_as: "platform-admin" }]);
    const home = database();
    expect((await run(home, baseRows(), { apply: true })).report.outcome).toBe("verified");
    expect(new Set(all(home, "SELECT acted_as FROM changelog").map((r) => r.acted_as))).toEqual(new Set([null]));
  });

  it("reverts a lead admin's change with a second file, each change recorded as the lead's admin", async () => {
    const db = federationDb();
    expect((await run(db, [MEMBER_UPDATE], { tenant: "other", apply: true })).report.outcome).toBe("verified");
    const back: Cells = {
      op: "update-entity", ...of(OWN), authority_name: "Otro de Tal", current_name: "Otro de Tal", current_dates: "", display_name: OWN.name,
      changelog_note: "Back to the name as catalogued.",
    };
    const { report } = await run(db, [back], { tenant: "other", apply: true, now: NOW + 1000, file: "revert.csv" });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(all(db, `SELECT display_name FROM entities WHERE id = '${OWN.id}'`)[0].display_name).toBe(OWN.name);
    const journal = all(db, `SELECT diff, acted_as FROM changelog WHERE record_id = '${OWN.id}' ORDER BY created_at`);
    expect(journal.map((r) => [JSON.parse(r.diff).displayName, r.acted_as])).toEqual([
      [{ old: OWN.name, new: "Otro de Tal" }, "lead-admin"],
      [{ old: "Otro de Tal", new: OWN.name }, "lead-admin"],
    ]);
  });

  it("aborts the file when the lead's admin loses the admin role between the plan and the apply", async () => {
    const db = federationDb();
    const snapshot = () => JSON.stringify([all(db, "SELECT * FROM entities ORDER BY id"), all(db, "SELECT * FROM changelog")]);
    let held = "";
    await expect(
      run(db, [MEMBER_UPDATE], {
        tenant: "other",
        apply: true,
        beforeApply: (d) => { d.exec("UPDATE users SET is_admin = 0 WHERE id = 'user_001'"); held = snapshot(); },
      }),
    ).rejects.toThrow(/ABORT|malformed JSON/);
    expect(snapshot()).toBe(held);
    expect(await failingGuards(federationDb(), [MEMBER_UPDATE], "other", "admin@example.org", (d) => d.exec("UPDATE users SET is_admin = 0 WHERE id = 'user_001'")))
      .toEqual(["the acting user's access has changed since it was read"]);
  });

  it("aborts the file when the member leaves the federation, or the lead changes, between the plan and the apply", async () => {
    for (const change of [
      "UPDATE tenants SET federation_id = 'fed-x' WHERE id = 't-2'",
      `UPDATE federations SET lead_tenant_id = 't-3' WHERE id = '${FED}'`,
      "UPDATE tenants SET disabled_at = 1 WHERE id = 't-1'",
    ]) {
      const db = federationDb();
      await expect(run(db, [MEMBER_UPDATE], { tenant: "other", apply: true, beforeApply: (d) => d.exec(change) })).rejects.toThrow(/ABORT|malformed JSON/);
      expect(all(db, `SELECT display_name FROM entities WHERE id = '${OWN.id}'`)[0].display_name).toBe(OWN.name);
    }
  });

  it("aborts the file when the platform admin loses the flag between the plan and the apply", async () => {
    const change = (d: DatabaseSync) => d.exec("UPDATE users SET is_platform_admin = 0 WHERE id = 'user_platform'");
    const db = federationDb();
    await expect(run(db, [MEMBER_UPDATE], { tenant: "other", actorEmail: "platform@example.org", apply: true, beforeApply: change }))
      .rejects.toThrow(/ABORT|malformed JSON/);
    expect(all(db, `SELECT display_name FROM entities WHERE id = '${OWN.id}'`)[0].display_name).toBe(OWN.name);
    expect(await failingGuards(federationDb(), [MEMBER_UPDATE], "other", "platform@example.org", change))
      .toEqual(["the acting user's access has changed since it was read"]);
  });
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

describe("arguments", () => {
  const base = ["authorities", "plan", "f.csv", "--target", "staging", "--tenant", "neogranadina", "--actor-email", "a@b.org"];
  it("reads plan and apply", () => {
    expect(parseAuthoritiesArgs(base)).toEqual({
      command: "plan", file: "f.csv", target: "staging", tenant: "neogranadina", actorEmail: "a@b.org", confirmProduction: false,
    });
    expect(parseAuthoritiesArgs(base.map((a) => (a === "plan" ? "apply" : a))).command).toBe("apply");
    expect(() => parseAuthoritiesArgs(base.filter((a) => a !== "--tenant" && a !== "neogranadina"))).toThrow(/--tenant/);
    expect(() => parseAuthoritiesArgs(["places", ...base.slice(1)])).toThrow(/authorities/);
  });
  it("refuses an apply to production without --confirm-production, before anything is read", async () => {
    const db = database();
    await expect(run(db, baseRows(), { apply: true, target: "production" })).rejects.toThrow(/--confirm-production/);
  });
});

describe("the ids a file makes", () => {
  it("makes an id from its parts unambiguously, as a version 8 UUID of their SHA-256", async () => {
    expect(await newRecordId("f", "t", "a.csv", "new:b.csv:new:x", "ns")).not.toBe(await newRecordId("f", "t", "a.csv:new:b.csv", "new:x", "ns"));
    expect(await newRecordId("f", "t", "links.csv", "k", "ns")).not.toBe(await newRecordId("f", "t-2", "links.csv", "k", "ns"));
    expect(await newRecordId("f", "t", "links.csv", "k", "ns")).not.toBe(await newRecordId("f", "t", "links.csv", "k", "other"));
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["ns", "f", "t", "a.csv", "k"])))).slice(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(await newRecordId("f", "t", "a.csv", "k", "ns")).toBe(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`);
  });
});

describe("a file of 60,000 rows", () => {
  it("plans and applies 60,000 update-entity rows", async () => {
    const N = 60_000;
    const entities: EntitySeed[] = Array.from({ length: N }, (_, i) => ({
      id: `e-big-${i}`, code: `ne-b${String(i).padStart(6, "0")}`, name: `Persona ${i}`, dates: "s. XVII", variants: '["Per. Sona"]',
    }));
    const rows: Cells[] = entities.map((e) => ({
      op: "update-entity", ...of(e), current_name: e.name, current_dates: "s. XVII", display_name: `${e.name} de Prueba`,
      dates_of_existence: "fl. 1600", primary_function: "Escribano", honorific: "don", gender: "", name_variants_add: `Variante ${e.name}`, changelog_note: "A fuller name.",
    }));
    const db = database({ entities, functions: [] });
    db.exec(`INSERT INTO vocabulary_terms (id, federation_id, canonical, entity_count, updated_at) VALUES ('vt-esc', '${FED}', 'Escribano', 0, 1);`);
    const planned = await run(db, rows);
    expect(reasons(planned.report)).toBe("");
    expect(planned.report.totals).toMatchObject({ rows: N });
    const applied = await run(db, rows, { apply: true });
    expect(reasons(applied.report)).toBe("");
    expect(applied.report.problems).toEqual([]);
    expect(applied.report.outcome).toBe("verified");
    expect(all(db, "SELECT COUNT(*) AS n FROM entities WHERE display_name LIKE '% de Prueba'")[0].n).toBe(N);
  }, 120_000);
});

// @version v0.9.0
