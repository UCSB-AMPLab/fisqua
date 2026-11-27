/**
 * Tests — the command line's description field updates
 *
 * This suite pins `scripts/lib/descriptions-cli/`, the change file, plan,
 * guards, SQL, report and read-back behind `scripts/fisqua.ts
 * descriptions`. The run is driven end to end against an in-memory
 * `node:sqlite` database holding every column of `descriptions`
 * (`./descriptions-cli-schema.ts`), the changelog, the drafts and the
 * full-text index with the trigger that keeps it, with D1's expression depth limit of 100; the
 * file it writes is applied as one unit, as `wrangler d1 execute --file`
 * applies it. Nothing here reaches D1.
 *
 *   - the change file: the reviewed columns, `op` optional, unknown
 *     columns refused, `current_value` and `new_value` read untrimmed;
 *   - the writes: the description editor's save for `title` and
 *     `scope_content` (the fields that change, `updated_by`, the next
 *     version, one changelog row per record in the editor's diff form,
 *     the row's note), and the search index follows;
 *   - resolution by `fisqua_id` or by `reference_code`, and both agreeing;
 *   - `current_value` compared exactly; `same` and already done apart, the
 *     latter only on this file's changelog row;
 *   - the editor's validation of the two fields, and none of a value the
 *     record already holds (a required field held blank is "same");
 *   - one refusal per rule, and any refusal writes nothing;
 *   - a change between the plan and the write aborts the file whole;
 *   - who acts on a member workspace: the lead's admin and a platform
 *     admin may, a user of the lead who is not its admin and an admin of
 *     another member may not, the report records how the user acted,
 *     and the file aborts when the lead's admin loses the role before
 *     the apply;
 *   - the report's compact before and after;
 *   - the digital flag, `has_digital`: written `0` or `1`, any other
 *     value refused at plan; compared, written, journaled as a boolean,
 *     read back and run again as the other fields are.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseDescriptionChangeFile } from "../../scripts/lib/descriptions-cli/change-file";
import {
  descriptionJournalId,
  parseDescriptionsArgs,
  runDescriptions,
  type DescriptionsReport,
} from "../../scripts/lib/descriptions-cli/run";
import { changedSpan } from "../../scripts/lib/descriptions-cli/plan";
import { readChangeFile } from "../../scripts/lib/cli/run-file";
import { descriptionsDdl } from "./descriptions-cli-schema";
import { d1Read } from "./d1-limits";

/** D1 caps expression depth at 100 (SQLite defaults to 1000); the Node typings in use do not list `limits`. */
const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

const TENANT = "t-1";
const FILE = "aht-real-cedula-test.csv";
const NOW = 1_763_100_000_000;

const DDL = `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, status TEXT, lead_tenant_id TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT, disabled_at INTEGER, descriptive_standard TEXT,
  kind TEXT NOT NULL DEFAULT 'tenant', status TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
  is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
  is_digitization_admin INTEGER DEFAULT 0, is_platform_admin INTEGER DEFAULT 0);
${descriptionsDdl()}CREATE TABLE drafts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL,
  snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT,
  diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE VIRTUAL TABLE descriptions_fts USING fts5(reference_code, title, scope_content, notes, legacy_ids, tokenize='unicode61');
CREATE TRIGGER descriptions_fts_ai AFTER INSERT ON descriptions BEGIN
  INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
  VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids);
END;
CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
  VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids);
END;
`;

const LONG_SCOPE =
  "Cabildo del 2 de enero de 1548, en el que se reúnen los señores capitulares para tratar los asuntos del real servicio. " +
  "El señor gobernador ordena el nombramiento de los alcaldes ordinarios, dando cumplimiento a la cédula real que los contempla. " +
  "Así mismo se debe elegir a un procurador general, quien tiene que velar por los asuntos de la república.";

interface DescriptionSeed {
  id: string;
  code: string;
  title: string;
  scope: string | null;
  level?: string;
  updatedAt?: number;
  tenant?: string;
}

const D1: DescriptionSeed = {
  id: "d-1", code: "co-ahrb-aht-003-d012",
  title: "Cédula real para que los escribanos den testimonio",
  scope: "Cédula real para que los escribanos den testimonio de lo que ante ellos pasare.",
};
const D2: DescriptionSeed = { id: "d-2", code: "co-ahrb-cab-001-d009", title: "Cabildo del 2 de enero de 1548", scope: LONG_SCOPE };
const D3: DescriptionSeed = { id: "d-3", code: "co-ahrb-aht-003-d013", title: "Cédula real sobre los indios", scope: null };
const OTHER: DescriptionSeed = { id: "d-x", code: "co-otro-001", title: "Cédula real ajena", scope: null, tenant: "t-2" };
const SEEDS = [D1, D2, D3, OTHER];

function database(seeds: DescriptionSeed[] = SEEDS): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  db.exec(`INSERT INTO federations VALUES ('fed-1', 'neogranadina-fed', 'active', '${TENANT}');`);
  db.exec(
    "INSERT INTO tenants (id, slug, federation_id, disabled_at, descriptive_standard) VALUES " +
      `('${TENANT}', 'neogranadina', 'fed-1', NULL, 'isadg'), ('t-2', 'other', 'fed-1', NULL, 'isadg');`,
  );
  db.exec(
    `INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1), ` +
      `('user_002', 'reader@example.org', 'Reader', '${TENANT}', 0);`,
  );
  const d = db.prepare(
    "INSERT INTO descriptions (id, tenant_id, reference_code, description_level, title, scope_content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const s of seeds) d.run(s.id, s.tenant ?? TENANT, s.code, s.level ?? "item", s.title, s.scope, s.updatedAt ?? 5);
  return db;
}

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

const HEADER = ["fisqua_id", "reference_code", "field", "current_value", "new_value", "rule", "changelog_note"];

type Cells = Record<string, string>;
const csvOf = (header: string[], rows: Cells[]) =>
  [header.join(","), ...rows.map((r) => header.map((h) => {
    const v = r[h] ?? "";
    return /[",\n\r]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";

const NOTE = "Real cédula, no Cédula real (regla de catalogación)";
const row = (d: DescriptionSeed, field: "title" | "scope_content", next: string, over: Partial<Cells> = {}): Cells => ({
  fisqua_id: d.id, reference_code: d.code, field, current_value: (field === "title" ? d.title : d.scope) ?? "", new_value: next,
  rule: "real-cedula", changelog_note: NOTE, ...over,
});
const realCedula = (v: string) => v.replace("Cédula real", "Real cédula").replace("cédula real", "real cédula");

const baseRows = (): Cells[] => [
  row(D1, "title", realCedula(D1.title)),
  row(D1, "scope_content", realCedula(D1.scope!)),
  row(D2, "scope_content", realCedula(LONG_SCOPE), { fisqua_id: "" }),
  row(D3, "title", realCedula(D3.title)),
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
  report: DescriptionsReport;
  written: Map<string, string>;
  applied: string[][];
  log: string[];
}

async function run(
  db: DatabaseSync,
  rows: Cells[],
  opts: {
    apply?: boolean; now?: number; target?: "staging" | "production"; confirmProduction?: boolean; header?: string[]; file?: string;
    actorEmail?: string; tenant?: string; newId?: string; beforeApply?: (db: DatabaseSync) => void; beforeApplyFile?: (written: Map<string, string>) => void;
    onRead?: (sql: string, db: DatabaseSync) => void;
  } = {},
): Promise<Run> {
  const written = new Map<string, string>();
  const applied: string[][] = [];
  const log: string[] = [];
  const file = opts.file ?? FILE;
  const report = await runDescriptions(
    { file, rows: parseDescriptionChangeFile(csvOf(opts.header ?? HEADER, rows), file) },
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

/** The messages of the opening guards of the planned file that fail once `change` has run (node:sqlite reports a guard's abort as malformed JSON). */
async function failingGuards(db: DatabaseSync, change: (db: DatabaseSync) => void): Promise<string[]> {
  const { written } = await run(db, baseRows());
  const sql = [...written].find(([k]) => k.endsWith(".sql"))![1];
  change(db);
  const statements = sql.split("\n");
  const opening = statements.slice(0, statements.findIndex((s) => !s.startsWith("SELECT CASE")));
  return opening.filter((s) => {
    try {
      db.prepare(s).all();
      return false;
    } catch {
      return true;
    }
  }).map((s) => /'ABORT: ((?:[^']|'')*)'/.exec(s)![1].replace(/''/g, "'"));
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const reasons = (r: DescriptionsReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const desc = (db: DatabaseSync, id: string) => all(db, `SELECT * FROM descriptions WHERE id = '${id}'`)[0];

describe("the change file", () => {
  it("reads the reviewed columns, with op optional, and refuses an unknown column whole", () => {
    expect(parseDescriptionChangeFile(csvOf(HEADER, baseRows()), FILE)).toHaveLength(4);
    expect(parseDescriptionChangeFile(csvOf(["op", ...HEADER], baseRows().map((r) => ({ ...r, op: "update-field" }))), FILE)).toHaveLength(4);
    expect(() => parseDescriptionChangeFile(csvOf([...HEADER, "colour"], baseRows()), FILE)).toThrow(/unknown columns colour/);
    expect(() => parseDescriptionChangeFile(csvOf(HEADER.filter((h) => h !== "new_value"), baseRows()), FILE)).toThrow(/missing columns new_value/);
  });

  it("keeps current_value and new_value as written, spaces included", () => {
    const [r] = parseDescriptionChangeFile(csvOf(HEADER, [row(D1, "title", " Real cédula ", { current_value: "  x" })]), FILE);
    expect(r.cells.new_value).toBe(" Real cédula ");
    expect(r.cells.current_value).toBe("  x");
  });
});

describe("reading the file", () => {
  it("refuses a file that is not valid UTF-8 before anything is planned", () => {
    const latin1 = Buffer.concat([Buffer.from("fisqua_id,reference_code,field,current_value,new_value\nd-1,c,title,Cedula real,Real c"), Buffer.from([0xe9]), Buffer.from("dula\n")]);
    expect(() => readChangeFile("latin1.csv", () => latin1)).toThrow(/latin1\.csv is not valid UTF-8/);
    expect(readChangeFile("utf8.csv", () => Buffer.from("\ufeffa,b\nc,d\n"))).toBe("a,b\nc,d\n");
  });

  it("refuses a new_value holding U+FFFD or NUL", async () => {
    const { report } = await run(database(), [row(D1, "title", "Real c\ufffddula para que"), row(D3, "title", "Real c\u0000dula")]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: new_value holds U+FFFD (the replacement character) or NUL, the trace of a file read in the wrong encoding`,
      `${FILE} line 3: new_value holds U+FFFD (the replacement character) or NUL, the trace of a file read in the wrong encoding`,
    ].join("\n"));
  });
});

describe("the writes", () => {
  it("plans every row and writes nothing to D1", async () => {
    const db = database();
    const { report, written, applied } = await run(db, baseRows());
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("dry run");
    expect(report.totals).toMatchObject({ rows: 4, update: 4, alreadyUpdated: 0, same: 0, refused: 0, descriptionsVersioned: 3 });
    expect(applied).toHaveLength(0);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
    expect([...written.keys()].filter((k) => /^\.import\/descriptions_staging_.*\.(json|md|sql)$/.test(k))).toHaveLength(3);
  });

  it("writes each record as the editor's save does: fields, updated_by, next version, one changelog row", async () => {
    const db = database();
    const { report } = await run(db, baseRows(), { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");

    const d1 = desc(db, D1.id);
    expect(d1.title).toBe("Real cédula para que los escribanos den testimonio");
    expect(d1.scope_content).toBe(realCedula(D1.scope!));
    expect(d1.updated_by).toBe("user_001");
    expect(d1.updated_at).toBe(NOW);
    expect(desc(db, D2.id).scope_content).toBe(realCedula(LONG_SCOPE));
    expect(desc(db, D3.id).title).toBe("Real cédula sobre los indios");
    expect(desc(db, D3.id).scope_content).toBeNull();
    expect(desc(db, OTHER.id).title).toBe(OTHER.title);

    // One changelog row per record, the two fields of D1 in one diff, under the editor's keys.
    const logs = all(db, "SELECT * FROM changelog ORDER BY record_id");
    expect(logs.map((l) => l.record_id)).toEqual([D1.id, D2.id, D3.id]);
    const l1 = logs[0];
    expect(l1).toMatchObject({ record_type: "description", user_id: "user_001", note: NOTE, kind: "update", run_id: null, created_at: NOW });
    expect(l1.id).toBe(await descriptionJournalId(TENANT, FILE, D1.id));
    expect(JSON.parse(l1.diff)).toEqual({
      title: { old: D1.title, new: realCedula(D1.title) },
      scopeContent: { old: D1.scope, new: realCedula(D1.scope!) },
    });
    expect(Object.keys(JSON.parse(l1.diff))).toEqual(["title", "scopeContent"]);
  });

  it("keeps the search index in step with the new title and scope", async () => {
    const db = database();
    await run(db, baseRows(), { apply: true });
    const hits = all(db, `SELECT d.id FROM descriptions_fts f JOIN descriptions d ON d.rowid = f.rowid WHERE descriptions_fts MATCH '"real cédula"' ORDER BY d.id`);
    expect(hits.map((h) => h.id)).toEqual([D1.id, D2.id, D3.id]);
  });

  it("clears scope_content with a blank new_value, as the editor stores a blank: NULL", async () => {
    const db = database();
    const { report } = await run(db, [row(D1, "scope_content", "")], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(desc(db, D1.id).scope_content).toBeNull();
    expect(JSON.parse(all(db, "SELECT diff FROM changelog")[0].diff)).toEqual({ scopeContent: { old: D1.scope, new: null } });
  });

  it("writes a null note when the rows give none, and joins two notes of one record", async () => {
    const db = database();
    await run(db, [row(D1, "title", realCedula(D1.title), { changelog_note: "" }), row(D3, "title", realCedula(D3.title), { changelog_note: "" })], { apply: true });
    expect(all(db, "SELECT note FROM changelog").map((l) => l.note)).toEqual([null, null]);
    const db2 = database();
    await run(db2, [row(D1, "title", realCedula(D1.title), { changelog_note: "one" }), row(D1, "scope_content", realCedula(D1.scope!), { changelog_note: "two" })], { apply: true });
    expect(all(db2, "SELECT note FROM changelog")[0].note).toBe("one\ntwo");
  });

  it("takes one past the version read when the clock has not moved past it", async () => {
    const db = database([{ ...D1, updatedAt: NOW + 10 }]);
    await run(db, [row(D1, "title", realCedula(D1.title))], { apply: true });
    expect(desc(db, D1.id).updated_at).toBe(NOW + 11);
  });

  it("leaves an autosaved draft alone and reports it", async () => {
    const db = database();
    db.exec(`INSERT INTO drafts VALUES ('dr-1', '${TENANT}', '${D1.id}', 'description', 'user_002', '{}', 77)`);
    const { report } = await run(db, [row(D1, "title", realCedula(D1.title))], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(report.drafts).toEqual([{ code: D1.code, id: D1.id, userId: "user_002", updatedAt: 77 }]);
    expect(all(db, "SELECT count(*) AS n FROM drafts")[0].n).toBe(1);
  });
});

describe("resolving the description", () => {
  it("resolves a blank fisqua_id by reference_code within the tenant", async () => {
    const { report } = await run(database(), [row(D2, "title", "Cabildo de 1548", { fisqua_id: "" })]);
    expect(reasons(report)).toBe("");
    expect(report.rows[0]).toMatchObject({ id: D2.id, status: "update" });
  });

  it("refuses a reference_code no description of the tenant holds", async () => {
    const { report } = await run(database(), [row(OTHER, "title", "Real cédula ajena", { fisqua_id: "" })]);
    expect(reasons(report)).toBe(`${FILE} line 2: no description of neogranadina has the reference code ${OTHER.code}`);
  });

  it("refuses an id of another tenant, an unknown id, and an id and a code that name two records", async () => {
    const { report } = await run(database(), [
      row(OTHER, "title", "Real cédula ajena"),
      row(D1, "title", realCedula(D1.title), { fisqua_id: "d-none" }),
      row(D1, "title", realCedula(D1.title), { reference_code: D3.code }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: no description of neogranadina has the id ${OTHER.id}`,
      `${FILE} line 3: no description of neogranadina has the id d-none`,
      `${FILE} line 4: fisqua_id ${D1.id} is ${D1.code}, not ${D3.code}`,
    ].join("\n"));
  });

  it("refuses a row with neither fisqua_id nor reference_code", async () => {
    const { report } = await run(database(), [row(D1, "title", "x", { fisqua_id: "", reference_code: "" })]);
    expect(reasons(report)).toBe(`${FILE} line 2: the row names neither fisqua_id nor reference_code`);
  });
});

describe("refusals", () => {
  it("refuses a field outside the allowlist and an unknown op", async () => {
    const { report } = await run(database(), [
      row(D1, "title", "x", { field: "description_level" }),
      { ...row(D1, "scope_content", "y"), op: "delete-field" },
    ], { header: ["op", ...HEADER] });
    expect(reasons(report)).toBe([
      `${FILE} line 2: field "description_level" is not one of the editor's fields that update-field changes`,
      `${FILE} line 3: op "delete-field" is not update-field, create-description, set-images, add-former-code, delete-description`,
    ].join("\n"));
  });

  it("refuses two rows for the same record and field", async () => {
    const { report } = await run(database(), [row(D1, "title", "a"), row(D1, "title", "b", { fisqua_id: "" })]);
    expect(reasons(report)).toBe(`${FILE} line 3: ${D1.code} title is named again (line 2)`);
  });

  it("refuses a current_value that is not the stored value exactly, and says when only spacing or normalisation differs", async () => {
    const { report, written } = await run(database(), [
      row(D1, "title", realCedula(D1.title), { current_value: `${D1.title} ` }),
      row(D2, "scope_content", "x", { current_value: LONG_SCOPE.replace("servicio. El", "servicio.  El") }),
      row(D3, "title", "Real cédula", { current_value: "Cedula real sobre los indios" }),
      row(D3, "scope_content", "Algo", { current_value: "algo" }),
    ]);
    expect(report.outcome).toBe("refused");
    expect(report.totals.refused).toBe(4);
    expect(report.totals.nearMisses).toBe(2);
    const r = reasons(report).split("\n");
    expect(r[0]).toMatch(/line 2: title of co-ahrb-aht-003-d012 is not current_value: .*it would match after trimming or collapsing whitespace/);
    expect(r[1]).toMatch(/line 3: scope_content of co-ahrb-cab-001-d009 is not current_value: .*it would match after trimming or collapsing whitespace/);
    expect(r[2]).toMatch(/line 4: title of co-ahrb-aht-003-d013 is not current_value/);
    expect(r[2]).not.toMatch(/would match/);
    expect(r[3]).toBe(`${FILE} line 5: scope_content of co-ahrb-aht-003-d013 is not current_value: stored NULL, current_value "algo"`);
    // Nothing to write is planned, and no SQL file is made.
    expect([...written.keys()].some((k) => k.endsWith(".sql"))).toBe(false);
  });

  it("reads an empty current_value as a stored NULL or ''", async () => {
    const db = database([{ ...D3, scope: "" }, D1]);
    const { report } = await run(db, [row(D3, "scope_content", "Real cédula", { current_value: "" }), row(D1, "scope_content", "x", { current_value: "" })]);
    expect(reasons(report)).toBe(`${FILE} line 3: scope_content of ${D1.code} is not current_value: stored ${JSON.stringify(D1.scope)}, current_value ""`);
  });

  it("reads \\r\\n in the file as \\n when the stored value has \\n line breaks", async () => {
    const db = database([{ ...D1, scope: "Primera línea\nSegunda línea" }]);
    const { report } = await run(db, [row(D1, "scope_content", "Primera\r\nSegunda", { current_value: "Primera línea\r\nSegunda línea" })], { apply: true });
    expect(reasons(report)).toBe("");
    expect(desc(db, D1.id).scope_content).toBe("Primera\nSegunda");
  });

  it("applies the editor's validation: a title is required and at most 2000 characters, a new value is saved trimmed", async () => {
    const { report } = await run(database(), [
      row(D1, "title", ""),
      row(D2, "title", "x".repeat(2001)),
      row(D3, "title", " Real cédula sobre los indios"),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: title of ${D1.code}: the editor refuses this value (field_required)`,
      `${FILE} line 3: title of ${D2.code}: the editor refuses this value (Too big: expected string to have <=2000 characters)`,
      `${FILE} line 4: new_value has leading or trailing whitespace, which the editor's save trims`,
    ].join("\n"));
  });

  it("refuses clearing scope_content where the standard requires it at the record's level", async () => {
    const db = database([{ ...D2, level: "fonds" }]);
    const { report } = await run(db, [row(D2, "scope_content", "")]);
    expect(reasons(report)).toBe(`${FILE} line 2: scope_content of ${D2.code}: the editor refuses this value (field_required)`);
  });

  it("reads a clear of a required field that the record already holds blank as same, not refused", async () => {
    // ISAD(G) requires date_expression at item level; d-1 holds it as NULL and d-3 as ''.
    const db = database();
    db.exec(`UPDATE descriptions SET date_expression = '' WHERE id = '${D3.id}'`);
    const clear = (d: DescriptionSeed): Cells => ({
      fisqua_id: d.id, reference_code: d.code, field: "date_expression", current_value: "1565", new_value: "",
      rule: "clear-date", changelog_note: NOTE,
    });
    const { report, applied } = await run(db, [clear(D1), clear(D3)], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.rows.map((r) => r.status)).toEqual(["same", "same"]);
    expect(report.outcome).toBe("nothing to write");
    expect(applied).toHaveLength(0);
  });

  it("still refuses clearing a required field that the record holds a value in", async () => {
    const db = database();
    db.exec(`UPDATE descriptions SET date_expression = '1565' WHERE id = '${D1.id}'`);
    const { report } = await run(db, [{
      fisqua_id: D1.id, reference_code: D1.code, field: "date_expression", current_value: "1565", new_value: "",
      rule: "clear-date", changelog_note: NOTE,
    }]);
    expect(reasons(report)).toBe(`${FILE} line 2: date_expression of ${D1.code}: the editor refuses this value (field_required)`);
  });

  it("refuses an actor who may not work in records, and an actor of another tenant", async () => {
    await expect(run(database(), baseRows(), { actorEmail: "reader@example.org" })).rejects.toThrow(/may not work in records/);
    const db = database();
    db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_003', 'other@example.org', 'O', 't-2', 1)`);
    await expect(run(db, baseRows(), { actorEmail: "other@example.org" })).rejects.toThrow(
      /other@example.org may not act in neogranadina: a user of other, not a platform admin, and not an admin of the lead workspace of neogranadina's federation/,
    );
  });

  it("writes nothing when any row is refused", async () => {
    const db = database();
    const { report, applied } = await run(db, [...baseRows(), row(D3, "scope_content", "x", { current_value: "wrong" })], { apply: true });
    expect(report.outcome).toBe("refused");
    expect(applied).toHaveLength(0);
    expect(desc(db, D1.id).title).toBe(D1.title);
  });
});

describe("a run made again", () => {
  it("writes nothing and reports every written row as already updated, on this file's changelog row", async () => {
    const db = database();
    await run(db, baseRows(), { apply: true });
    const again = await run(db, baseRows(), { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already updated", "already updated", "already updated", "already updated"]);
    expect(again.applied).toHaveLength(0);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(3);
  });

  it("reports a record that already holds new_value without this file's changelog row as same, not done", async () => {
    const db = database([{ ...D1, title: realCedula(D1.title) }]);
    const { report } = await run(db, [row(D1, "title", realCedula(D1.title), { current_value: D1.title })], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.rows[0].status).toBe("same");
    expect(report.outcome).toBe("nothing to write");
  });

  it("finds no evidence under another file name: the rows are same", async () => {
    const db = database();
    await run(db, baseRows(), { apply: true });
    const { report } = await run(db, baseRows(), { file: "renamed.csv", newId: "2f1e2d3c-0000-4000-8000-000000000000" });
    expect(report.rows.map((r) => r.status)).toEqual(["same", "same", "same", "same"]);
  });

  it("does not take a changelog row of this file that records another change of the field as done: refused", async () => {
    const id = await descriptionJournalId(TENANT, FILE, D1.id);
    const done = realCedula(D1.title);
    for (const [diff, why] of [
      [{ title: { old: "Otro título", new: done } }, "old"],
      [{ title: { old: D1.title, new: "Otro título" } }, "new"],
    ] as const) {
      const db = database([{ ...D1, title: done }]);
      db.exec(`INSERT INTO changelog VALUES ('${id}', '${D1.id}', 'description', 'user_001', NULL, '${JSON.stringify(diff)}', NULL, 'update', 1, NULL)`);
      const { report } = await run(db, [row(D1, "title", done)]);
      expect(report.rows[0].status, why).toBe("refused");
      expect(reasons(report), why).toBe(
        `${FILE} line 2: this file's changelog row for ${D1.code} records title other than from current_value to new_value`,
      );
    }
  });

  it("reports a field this file's changelog row does not record as same", async () => {
    const id = await descriptionJournalId(TENANT, FILE, D1.id);
    const db = database([{ ...D1, title: realCedula(D1.title) }]);
    const diff = { scopeContent: { old: D1.scope, new: "x" } };
    db.exec(`INSERT INTO changelog VALUES ('${id}', '${D1.id}', 'description', 'user_001', NULL, '${JSON.stringify(diff)}', NULL, 'update', 1, NULL)`);
    const { report } = await run(db, [row(D1, "title", realCedula(D1.title))]);
    expect(reasons(report)).toBe("");
    expect(report.rows[0].status).toBe("same");
  });

  it("refuses a row to write on a record this file has already journaled", async () => {
    const db = database();
    await run(db, [row(D1, "title", realCedula(D1.title))], { apply: true });
    const { report } = await run(db, [row(D1, "title", realCedula(D1.title)), row(D1, "scope_content", realCedula(D1.scope!))],
      { newId: "3f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(report)).toBe(
      `${FILE} line 3: line 3 was applied before and has changed since: put new changes in a new file ` +
        `(part of its effect is present: this file's changelog row for ${D1.code} is already written, and the row would write more)`,
    );
  });
});

describe("the digital flag", () => {
  /** The seeds, D1 and D2 marked as having images. */
  const flagged = () => {
    const db = database();
    db.exec(`UPDATE descriptions SET has_digital = 1 WHERE id IN ('${D1.id}', '${D2.id}')`);
    return db;
  };
  const flag = (d: DescriptionSeed, current: string, next: string, over: Partial<Cells> = {}): Cells => ({
    fisqua_id: d.id, reference_code: d.code, field: "has_digital", current_value: current, new_value: next,
    rule: "no-images", changelog_note: "Sin imágenes ni manifiesto", ...over,
  });

  it("plans has_digital 1 to 0 as one change, writes it with a changelog row, and reads it back", async () => {
    const db = flagged();
    const dry = await run(db, [flag(D1, "1", "0")]);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.totals).toMatchObject({ rows: 1, update: 1, refused: 0, descriptionsVersioned: 1 });
    expect(desc(db, D1.id).has_digital).toBe(1);

    const { report } = await run(db, [flag(D1, "1", "0")], { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");
    expect(desc(db, D1.id)).toMatchObject({ has_digital: 0, updated_by: "user_001", updated_at: NOW });
    expect(desc(db, D2.id).has_digital).toBe(1);
    const logs = all(db, "SELECT * FROM changelog");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: await descriptionJournalId(TENANT, FILE, D1.id), record_id: D1.id, record_type: "description", user_id: "user_001",
      note: "Sin imágenes ni manifiesto", kind: "update", run_id: null, created_at: NOW,
    });
    // The editor's diff records the flag as a boolean.
    expect(JSON.parse(logs[0].diff)).toEqual({ hasDigital: { old: true, new: false } });
  });

  it("writes the flag and a field of the same record in one write and one changelog row", async () => {
    const db = flagged();
    const { report } = await run(db, [row(D1, "title", realCedula(D1.title)), flag(D1, "1", "0")], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(desc(db, D1.id)).toMatchObject({ has_digital: 0, title: realCedula(D1.title) });
    expect(JSON.parse(all(db, "SELECT diff FROM changelog")[0].diff)).toEqual({
      title: { old: D1.title, new: realCedula(D1.title) },
      hasDigital: { old: true, new: false },
    });
  });

  it("refuses a current_value that is not the stored flag", async () => {
    const { report, written } = await run(flagged(), [flag(D1, "0", "0")]);
    expect(reasons(report)).toBe(`${FILE} line 2: has_digital of ${D1.code} is not current_value: stored "1", current_value "0"`);
    expect([...written.keys()].some((k) => k.endsWith(".sql"))).toBe(false);
  });

  it("refuses at plan time a current_value or new_value other than 0 or 1", async () => {
    const { report } = await run(flagged(), [
      flag(D1, "1", "true"),
      flag(D2, "1", "yes"),
      flag(D3, "0", ""),
      flag(D1, "true", "0", { fisqua_id: "" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: has_digital is written 0 or 1; new_value is "true"`,
      `${FILE} line 3: has_digital is written 0 or 1; new_value is "yes"`,
      `${FILE} line 4: has_digital is written 0 or 1; new_value is ""`,
      `${FILE} line 5: has_digital is written 0 or 1; current_value is "true"`,
    ].join("\n"));
  });

  it("reads a record that already holds new_value without this file's changelog row as same", async () => {
    const { report, written } = await run(database(), [flag(D3, "1", "0")]);
    expect(reasons(report)).toBe("");
    expect(report.rows.map((r) => r.status)).toEqual(["same"]);
    expect([...written.keys()].some((k) => k.endsWith(".sql"))).toBe(false);
  });

  it("writes nothing when the applied file is run again", async () => {
    const db = flagged();
    await run(db, [flag(D1, "1", "0"), flag(D2, "1", "0")], { apply: true });
    const again = await run(db, [flag(D1, "1", "0"), flag(D2, "1", "0")], { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already updated", "already updated"]);
    expect(again.applied).toHaveLength(0);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(2);
  });
});

describe("between the plan and the write", () => {
  it("aborts the file whole when a description changes after it was read", async () => {
    const db = database();
    await expect(run(db, baseRows(), {
      apply: true,
      beforeApply: (d) => d.exec(`UPDATE descriptions SET scope_content = 'otro' WHERE id = '${D3.id}'`),
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(desc(db, D1.id).title).toBe(D1.title);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
    expect(await failingGuards(database(), (d) => d.exec(`UPDATE descriptions SET scope_content = 'otro' WHERE id = '${D3.id}'`)))
      .toEqual(["a description the file reads has changed since it was read"]);
  });

  it("aborts when the tenant's descriptive standard changes", async () => {
    const db = database();
    await expect(run(db, baseRows(), { apply: true, beforeApply: (d) => d.exec(`UPDATE tenants SET descriptive_standard = 'dacs' WHERE id = '${TENANT}'`) }))
      .rejects.toThrow(/ABORT|malformed JSON/);
    expect(desc(db, D1.id).title).toBe(D1.title);
    expect(await failingGuards(database(), (d) => d.exec(`UPDATE tenants SET descriptive_standard = 'dacs' WHERE id = '${TENANT}'`)))
      .toEqual(["the tenant's descriptive standard has changed since it was read"]);
  });

  for (const [what, change] of [
    ["the tenant is disabled", `UPDATE tenants SET disabled_at = 1 WHERE id = '${TENANT}'`],
    ["the actor moves to another tenant", "UPDATE users SET tenant_id = 't-2' WHERE id = 'user_001'"],
    ["the actor loses the records permission", "UPDATE users SET is_admin = 0 WHERE id = 'user_001'"],
  ] as const) {
    it(`aborts when ${what} between the plan and the write`, async () => {
      const db = database();
      await expect(run(db, baseRows(), { apply: true, beforeApply: (d) => d.exec(change) })).rejects.toThrow(/ABORT|malformed JSON/);
      expect(desc(db, D1.id).title).toBe(D1.title);
      expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
      expect(await failingGuards(database(), (d) => d.exec(change))).toEqual(["the acting user's access has changed since it was read"]);
    });
  }

  it("never writes over an edit made between two of the plan's reads of one description", async () => {
    // Scope named by code first, title by id second; an editor saves a new
    // title (version 5 to 6) just after the plan's first read of descriptions.
    const db = database();
    const editorTitle = "Título del editor";
    let saved = false;
    const rows = [row(D1, "scope_content", realCedula(D1.scope!), { fisqua_id: "" }), row(D1, "title", realCedula(D1.title))];
    const result = await run(db, rows, {
      apply: true,
      onRead: (sql, d) => {
        if (saved || !/FROM descriptions\b/.test(sql)) return;
        saved = true;
        d.exec(`UPDATE descriptions SET title = '${editorTitle}', updated_by = 'user_002', updated_at = 6 WHERE id = '${D1.id}'`);
      },
    }).then((r) => r.report, (err: Error) => err);
    expect(saved).toBe(true);
    expect(desc(db, D1.id).title).toBe(editorTitle);
    expect(desc(db, D1.id).scope_content).toBe(D1.scope);
    expect(desc(db, D1.id).updated_at).toBe(6);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
    // Refused at plan time, before any SQL file is made: the title is not current_value.
    expect(result).not.toBeInstanceOf(Error);
    const report = result as DescriptionsReport;
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/line 3: title of co-ahrb-aht-003-d012 is not current_value/);
  });

  it("refuses a code that names another description by the time the plan reads it", async () => {
    const db = database();
    let moved = false;
    const { report } = await run(db, [row(D2, "title", "Cabildo de 1548", { fisqua_id: "" })], {
      onRead: (sql, d) => {
        if (moved || !/FROM descriptions\b/.test(sql)) return;
        moved = true;
        d.exec(`UPDATE descriptions SET reference_code = 'co-ahrb-cab-001-d999' WHERE id = '${D2.id}'`);
      },
    });
    expect(reasons(report)).toBe(`${FILE} line 2: the description of reference code ${D2.code} changed while the plan read it; plan again`);
  });

  it("aborts when a changelog row the file writes appears", async () => {
    const id = await descriptionJournalId(TENANT, FILE, D1.id);
    expect(await failingGuards(database(), (d) => d.exec(`INSERT INTO changelog VALUES ('${id}', '${D1.id}', 'description', 'user_001', NULL, '{}', NULL, 'update', 1, NULL)`)))
      .toEqual(["a changelog row the file writes is already there"]);
  });

  it("applies nothing when the SQL file on disk is not the SQL planned", async () => {
    const db = database();
    await expect(run(db, baseRows(), {
      apply: true,
      beforeApplyFile: (w) => { for (const k of w.keys()) if (k.endsWith(".sql")) w.set(k, "DELETE FROM descriptions;\n"); },
    })).rejects.toThrow(/does not hold the SQL this run planned/);
    expect(all(db, "SELECT count(*) AS n FROM descriptions")[0].n).toBe(4);
  });
});

describe("the command", () => {
  it("parses its arguments", () => {
    const base = ["descriptions", "plan", "f.csv", "--target", "staging", "--tenant", "neogranadina", "--actor-email", "a@b.org"];
    expect(parseDescriptionsArgs(base)).toEqual({
      command: "plan", file: "f.csv", target: "staging", tenant: "neogranadina", actorEmail: "a@b.org", confirmProduction: false,
    });
    expect(() => parseDescriptionsArgs(["authorities", ...base.slice(1)])).toThrow(/descriptions/);
  });

  it("refuses an apply to production without --confirm-production, before anything is read", async () => {
    const db = database();
    await expect(run(db, baseRows(), { apply: true, target: "production" })).rejects.toThrow(/--confirm-production/);
  });
});

describe("the report", () => {
  it("shows a long field's change as the changed span with a little context", async () => {
    const { report, written } = await run(database(), baseRows());
    const u = report.updates.find((x) => x.code === D2.code)!;
    expect(u.before.length).toBeLessThan(LONG_SCOPE.length);
    expect(u.before).toContain("[cédula real]");
    expect(u.after).toContain("[real cédula]");
    const md = [...written].find(([k]) => k.endsWith(".md"))![1];
    expect(md).toContain("[real cédula]");
    expect(md).toContain("| Line | Description | Field | Rule | Status |");
  });

  it("gives a short field whole", () => {
    expect(changedSpan("Cédula real", "Real cédula")).toEqual({ before: "[Cédula real]", after: "[Real cédula]" });
    expect(changedSpan("a".repeat(100) + "X" + "b".repeat(100), "a".repeat(100) + "Y" + "b".repeat(100))).toEqual({
      before: `…${"a".repeat(40)}[X]${"b".repeat(40)}…`, after: `…${"a".repeat(40)}[Y]${"b".repeat(40)}…`,
    });
  });
});

// ---------------------------------------------------------------------------
// Who acts on a member workspace of the federation
// ---------------------------------------------------------------------------

describe("who acts on a member workspace", () => {
  // `neogranadina` (t-1) leads fed-1; `other` (t-2) and `third` (t-3) are its members.
  const federationDb = () => {
    const db = database();
    db.exec("INSERT INTO tenants (id, slug, federation_id, descriptive_standard) VALUES ('t-3', 'third', 'fed-1', 'isadg')");
    db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin, is_records_admin, is_platform_admin) VALUES
      ('user_lead', 'lead-cataloguer@example.org', 'Lead cataloguer', '${TENANT}', 0, 1, 0),
      ('user_third', 'third-admin@example.org', 'Third admin', 't-3', 1, 0, 0),
      ('user_platform', 'platform@example.org', 'Platform admin', 't-3', 0, 0, 1)`);
    return db;
  };
  const memberRows = () => [row(OTHER, "title", "Real cédula ajena")];

  it("lets the lead's admin plan and apply on a member, and reports that they acted as the lead's admin", async () => {
    const db = federationDb();
    const plan = await run(db, memberRows(), { tenant: "other" });
    expect(reasons(plan.report)).toBe("");
    expect(plan.report.actor).toEqual({ id: "user_001", email: "admin@example.org", actedAs: "lead-admin", homeTenant: "neogranadina" });
    const { report } = await run(db, memberRows(), { tenant: "other", apply: true, now: NOW + 1000 });
    expect(report.outcome).toBe("verified");
    expect(desc(db, OTHER.id).title).toBe("Real cédula ajena");
    expect(all(db, `SELECT user_id, acted_as FROM changelog WHERE record_id = '${OTHER.id}'`)).toEqual([{ user_id: "user_001", acted_as: "lead-admin" }]);
  });

  it("writes acted_as NULL for a member", async () => {
    const db = federationDb();
    expect((await run(db, baseRows(), { apply: true })).report.outcome).toBe("verified");
    expect(new Set(all(db, "SELECT acted_as FROM changelog").map((r) => r.acted_as))).toEqual(new Set([null]));
  });

  it("refuses a user of the lead who is not its admin, and an admin of another member", async () => {
    await expect(run(federationDb(), memberRows(), { tenant: "other", actorEmail: "lead-cataloguer@example.org" })).rejects.toThrow(
      /lead-cataloguer@example.org may not act in other: a user of neogranadina, not a platform admin, and not an admin of the lead workspace/,
    );
    await expect(run(federationDb(), memberRows(), { tenant: "other", actorEmail: "third-admin@example.org" })).rejects.toThrow(
      /third-admin@example.org may not act in other: a user of third/,
    );
  });

  it("lets a platform admin act on a member", async () => {
    const db = federationDb();
    const { report } = await run(db, memberRows(), { tenant: "other", actorEmail: "platform@example.org", apply: true });
    expect(report.outcome).toBe("verified");
    expect(report.actor).toEqual({ id: "user_platform", email: "platform@example.org", actedAs: "platform-admin", homeTenant: "third" });
    expect(all(db, "SELECT acted_as FROM changelog")).toEqual([{ acted_as: "platform-admin" }]);
  });

  it("aborts the file when the lead's admin loses the admin role between the plan and the apply", async () => {
    const db = federationDb();
    await expect(run(db, memberRows(), {
      tenant: "other", apply: true, beforeApply: (d) => d.exec("UPDATE users SET is_admin = 0 WHERE id = 'user_001'"),
    })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(desc(db, OTHER.id).title).toBe(OTHER.title);
    expect(all(db, "SELECT count(*) AS n FROM changelog")[0].n).toBe(0);
  });
});

// @version v0.9.0
