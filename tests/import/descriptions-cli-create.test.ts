/**
 * Tests — creating descriptions, and the wider field updates, from the command line
 *
 * This suite pins the `create-description` operation of the descriptions
 * change file (`scripts/lib/descriptions-cli/`) and the widening of
 * `update-field` to the description editor's fields. The run is driven
 * end to end against an in-memory `node:sqlite` database holding every
 * column of `descriptions` (`./descriptions-cli-schema.ts`), the
 * repositories, the changelog, the drafts and the full-text index with
 * its insert and update triggers, with D1's expression depth limit of
 * 100; the file it writes is applied as one unit, as `wrangler d1
 * execute --file` applies it. Nothing here reaches D1.
 *
 *   - a create written as the editor's create writes it, the parent's
 *     child count and version moved, and one `create` changelog row in
 *     the import's snapshot form; read back, planned again, run again;
 *   - positions: blank `after` last, `after` in the middle moving the
 *     later siblings down one, and a parent or an `after` created by
 *     another row of the file, in either order;
 *   - one refusal per rule, and the columns of the other operation;
 *   - `update-field` on a field newly open to it, and on one that is not,
 *     and a date bound checked against the other the record will hold;
 *   - the reviewer's `evidence` column, read and never written;
 *   - a change to the parent or a sibling between plan and write aborts
 *     the file whole;
 *   - the legajo 061 file (`fixtures/descriptions-create-061.csv`, the
 *     twelve rows of `aht-new-061-3.csv` without their images) plans and
 *     applies, and the size of its SQL file and of 320 creates;
 *   - the update-field set is the editor's (`UPDATE_FORM_FIELDS`);
 *   - the rerun contract: a done create beside a new update-field row,
 *     and an update-field row replaced on a record the file journaled,
 *     refused at plan with nothing written; an unchanged file of creates
 *     and updates run again writes nothing.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDescriptionChangeFile, FIELDS } from "../../scripts/lib/descriptions-cli/change-file";
import {
  descriptionCreateId,
  descriptionCreateJournalId,
  runDescriptions,
  type DescriptionsReport,
} from "../../scripts/lib/descriptions-cli/run";
import { STATEMENT_BUDGET } from "../../scripts/lib/authority-merges";
import { descriptionsDdl } from "./descriptions-cli-schema";
import { d1Read } from "./d1-limits";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

const TENANT = "t-1";
const FILE = "aht-new-061-create.csv";
const NOW = 1_763_100_000_000;
const REPO = "a1a1a1a1-0000-4000-8000-000000000001";
const REPO_B = "a1a1a1a1-0000-4000-8000-000000000002";
const REPO_OTHER = "a1a1a1a1-0000-4000-8000-000000000009";

const DDL = `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT, disabled_at INTEGER, descriptive_standard TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
  is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
  is_digitization_admin INTEGER DEFAULT 0);
CREATE TABLE repositories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL);
${descriptionsDdl()}
CREATE TABLE drafts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL,
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

// ---------------------------------------------------------------------------
// The tree: a fonds, an empty legajo (061) and a legajo with three items (062)
// ---------------------------------------------------------------------------

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
interface Seed { [column: string]: string | number | null }
const F: Seed = {
  id: uuid(1), reference_code: "co-ahrb-aht", description_level: "fonds", title: "Archivo Histórico de Tunja", parent_id: null,
  depth: 0, root_description_id: uuid(1), path_cache: uuid(1), child_count: 2, position: 0, local_identifier: "AHT",
  date_expression: "1539-1900", extent: "1 fondo", creator_display: "Cabildo", scope_content: "Fondo.",
};
const P: Seed = {
  id: uuid(2), reference_code: "co-ahrb-aht-061", description_level: "file", title: "Legajo 061", parent_id: uuid(1),
  depth: 1, root_description_id: uuid(1), path_cache: `${uuid(1)}/${uuid(2)}`, child_count: 0, position: 0, local_identifier: "AHT-061",
  date_expression: "1625", extent: "672 tomas",
};
const Q: Seed = {
  id: uuid(3), reference_code: "co-ahrb-aht-062", description_level: "file", title: "Legajo 062", parent_id: uuid(1),
  depth: 1, root_description_id: uuid(1), path_cache: `${uuid(1)}/${uuid(3)}`, child_count: 3, position: 1, local_identifier: "AHT-062",
  date_expression: "1626",
};
const item = (n: number, k: number): Seed => ({
  id: uuid(10 + k), reference_code: `co-ahrb-aht-062-d00${k}`, description_level: "item", title: `Documento ${k} del legajo 062`, parent_id: Q.id,
  depth: 2, root_description_id: uuid(1), path_cache: `${Q.path_cache}/${uuid(10 + k)}`, child_count: 0, position: n,
  local_identifier: `AHT-062-d00${k}`, date_expression: "1626",
});
const Q1 = item(0, 1);
const Q2 = item(1, 2);
const Q3 = item(2, 3);
const OTHER: Seed = {
  id: uuid(90), tenant_id: "t-2", reference_code: "co-otro-001", description_level: "file", title: "Legajo ajeno", parent_id: null,
  depth: 0, root_description_id: uuid(90), path_cache: uuid(90), child_count: 0, position: 0,
};
const SEEDS = [F, P, Q, Q1, Q2, Q3, OTHER];

function database(seeds: Seed[] = SEEDS): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  db.exec(`INSERT INTO federations VALUES ('fed-1', 'neogranadina-fed');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', 'fed-1', NULL, 'isadg'), ('t-2', 'other', 'fed-1', NULL, 'isadg');`);
  db.exec(
    `INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1), ` +
      `('user_002', 'reader@example.org', 'Reader', '${TENANT}', 0);`,
  );
  db.exec(
    `INSERT INTO repositories VALUES ('${REPO}', '${TENANT}', 'AHRB', 'Archivo Histórico Regional de Boyacá'), ` +
      `('${REPO_B}', '${TENANT}', 'B', 'Otro'), ('${REPO_OTHER}', 't-2', 'X', 'Ajeno');`,
  );
  for (const s of seeds) {
    const r: Seed = { tenant_id: TENANT, repository_id: s.tenant_id === "t-2" ? REPO_OTHER : REPO, updated_at: 5, created_at: 1, is_published: 1, ...s };
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO descriptions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
  }
  return db;
}

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

const CREATE_HEADER = [
  "op", "reference_code", "parent_code", "description_level", "after", "local_identifier", "title", "scope_content",
  "date_expression", "date_start", "date_end", "extent", "is_published", "rule", "changelog_note",
];
const MIXED_HEADER = ["op", "fisqua_id", "reference_code", "field", "current_value", "new_value", ...CREATE_HEADER.slice(2)];

type Cells = Record<string, string>;
const csvOf = (header: string[], rows: Cells[]) =>
  [header.join(","), ...rows.map((r) => header.map((h) => {
    const v = r[h] ?? "";
    return /[",\n\r]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";

const NOTE = "Creado a partir del índice";
const create = (code: string, over: Partial<Cells> = {}): Cells => ({
  op: "create-description", reference_code: code, parent_code: String(P.reference_code), description_level: "item",
  title: `Documento ${code}`, date_expression: "1625", date_start: "1625-01-01", date_end: "1625-12-31", extent: "ff. 1r-2v",
  is_published: "1", rule: "nuevo registro", changelog_note: NOTE, ...over,
});
const update = (d: Seed, field: string, current: string, next: string): Cells => ({
  op: "update-field", fisqua_id: String(d.id), reference_code: String(d.reference_code), field, current_value: current, new_value: next,
  changelog_note: "Corrección",
});

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

interface Run { report: DescriptionsReport; written: Map<string, string>; applied: string[][] }

async function run(
  db: DatabaseSync,
  rows: Cells[],
  opts: { apply?: boolean; header?: string[]; file?: string; text?: string; newId?: string; beforeApply?: (db: DatabaseSync) => void; actorEmail?: string } = {},
): Promise<Run> {
  const written = new Map<string, string>();
  const applied: string[][] = [];
  const file = opts.file ?? FILE;
  const report = await runDescriptions(
    { file, rows: parseDescriptionChangeFile(opts.text ?? csvOf(opts.header ?? CREATE_HEADER, rows), file) },
    { target: "staging", tenant: "neogranadina", actorEmail: opts.actorEmail ?? "admin@example.org", apply: opts.apply ?? false, confirmProduction: false },
    {
      rows: async (sql) => d1Read(db, sql),
      writeFile: (p, t) => written.set(p, t),
      createFile: (p, t) => {
        if (written.has(p)) throw new Error(`EEXIST: ${p}`);
        written.set(p, t);
      },
      readFile: (p) => written.get(p) ?? "",
      newId: () => opts.newId ?? "0f1e2d3c-0000-4000-8000-000000000000",
      applyFile: (_p, statements) => {
        applied.push(statements);
        opts.beforeApply?.(db);
        applyAsOneUnit(db, statements);
      },
      now: () => NOW,
    },
    () => {},
  );
  return { report, written, applied };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const byCode = (db: DatabaseSync, code: string) => all(db, `SELECT * FROM descriptions WHERE tenant_id = '${TENANT}' AND reference_code = '${code}'`)[0];
const reasons = (r: DescriptionsReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const count = (db: DatabaseSync, sql: string) => Number(all(db, sql)[0].n);

/** The messages of the opening guards of the planned file that fail once `change` has run. */
async function failingGuards(db: DatabaseSync, rows: Cells[], change: (db: DatabaseSync) => void, header?: string[]): Promise<string[]> {
  const { written } = await run(db, rows, { header });
  const sql = [...written].find(([k]) => k.endsWith(".sql"))![1];
  change(db);
  const statements = sql.split("\n");
  const opening = statements.slice(0, statements.findIndex((s) => !s.startsWith("SELECT CASE")));
  return [...new Set(opening.filter((s) => {
    try {
      db.prepare(s).all();
      return false;
    } catch {
      return true;
    }
  }).map((s) => /'ABORT: ((?:[^']|'')*)'/.exec(s)![1].replace(/''/g, "'")))];
}

// ---------------------------------------------------------------------------
// A create
// ---------------------------------------------------------------------------

describe("a create", () => {
  it("plans without writing, and applies as the editor's create writes, with one create changelog row", async () => {
    const db = database();
    const dry = await run(db, [create("co-ahrb-aht-061-d001")]);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.outcome).toBe("dry run");
    expect(dry.report.totals).toMatchObject({ rows: 1, create: 1, alreadyCreated: 0, refused: 0 });
    expect(byCode(db, "co-ahrb-aht-061-d001")).toBeUndefined();

    const { report } = await run(db, [create("co-ahrb-aht-061-d001")], { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");

    const id = await descriptionCreateId(TENANT, FILE, "co-ahrb-aht-061-d001");
    const d = byCode(db, "co-ahrb-aht-061-d001");
    expect(d).toMatchObject({
      id, tenant_id: TENANT, repository_id: REPO, parent_id: P.id, position: 0, root_description_id: F.id, depth: 2, child_count: 0,
      path_cache: `${P.path_cache}/${id}`, description_level: "item", reference_code: "co-ahrb-aht-061-d001",
      local_identifier: "AHT-061-d001", title: "Documento co-ahrb-aht-061-d001", date_expression: "1625", date_start: "1625-01-01",
      date_end: "1625-12-31", extent: "ff. 1r-2v", scope_content: null, is_published: 1, has_digital: 0, genre: "[]", legacy_ids: "[]",
      created_by: "user_001", updated_by: "user_001", created_at: NOW, updated_at: NOW,
    });
    // The parent: one more child, its version moved, its other columns as they were.
    const p = byCode(db, String(P.reference_code));
    expect(p).toMatchObject({ child_count: 1, updated_at: NOW, updated_by: null, title: P.title });

    const logs = all(db, "SELECT * FROM changelog");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      id: await descriptionCreateJournalId(TENANT, FILE, "co-ahrb-aht-061-d001"), record_id: id, record_type: "description",
      user_id: "user_001", note: NOTE, kind: "create", run_id: null, created_at: NOW,
    });
    const diff = JSON.parse(logs[0].diff);
    expect(Object.values(diff).every((e: any) => e.old === null)).toBe(true);
    expect(diff).toMatchObject({
      id: { new: id }, tenantId: { new: TENANT }, repositoryId: { new: REPO }, parentId: { new: P.id }, position: { new: 0 },
      rootDescriptionId: { new: F.id }, depth: { new: 2 }, childCount: { new: 0 }, pathCache: { new: `${P.path_cache}/${id}` },
      descriptionLevel: { new: "item" }, referenceCode: { new: "co-ahrb-aht-061-d001" }, localIdentifier: { new: "AHT-061-d001" },
      title: { new: "Documento co-ahrb-aht-061-d001" }, isPublished: { new: true }, createdBy: { new: "user_001" },
      updatedBy: { new: "user_001" }, createdAt: { new: NOW }, updatedAt: { new: NOW },
    });
    expect(diff.scopeContent).toBeUndefined();

    // Findable through the full-text index.
    const hits = all(db, `SELECT d.reference_code FROM descriptions_fts f JOIN descriptions d ON d.rowid = f.rowid WHERE descriptions_fts MATCH '"co ahrb aht 061 d001"'`);
    expect(hits.map((h) => h.reference_code)).toContain("co-ahrb-aht-061-d001");
  });

  it("records acted_as on the create changelog row: platform-admin for a platform admin, NULL for a member", async () => {
    const db = database();
    db.exec("ALTER TABLE tenants ADD COLUMN kind TEXT NOT NULL DEFAULT 'tenant'");
    db.exec("ALTER TABLE tenants ADD COLUMN status TEXT");
    db.exec("ALTER TABLE federations ADD COLUMN status TEXT");
    db.exec("ALTER TABLE federations ADD COLUMN lead_tenant_id TEXT");
    db.exec("ALTER TABLE users ADD COLUMN is_platform_admin INTEGER DEFAULT 0");
    db.exec("INSERT INTO users (id, email, name, tenant_id, is_platform_admin) VALUES ('user_platform', 'platform@example.org', 'Platform', 't-2', 1)");
    const { report } = await run(db, [create("co-ahrb-aht-061-d001")], { apply: true, actorEmail: "platform@example.org" });
    expect(report.outcome).toBe("verified");
    expect(all(db, "SELECT user_id, kind, acted_as FROM changelog")).toEqual([{ user_id: "user_platform", kind: "create", acted_as: "platform-admin" }]);
    const home = database();
    expect((await run(home, [create("co-ahrb-aht-061-d001")], { apply: true })).report.outcome).toBe("verified");
    expect(all(home, "SELECT acted_as FROM changelog")).toEqual([{ acted_as: null }]);
  });

  it("writes nothing when run again, and reports the row already created on this file's changelog row", async () => {
    const db = database();
    await run(db, [create("co-ahrb-aht-061-d001")], { apply: true });
    const before = all(db, "SELECT id, updated_at, child_count, position FROM descriptions ORDER BY id");
    const again = await run(db, [create("co-ahrb-aht-061-d001")], { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already created"]);
    expect(again.applied).toHaveLength(0);
    expect(all(db, "SELECT id, updated_at, child_count, position FROM descriptions ORDER BY id")).toEqual(before);
    expect(count(db, "SELECT count(*) AS n FROM changelog")).toBe(1);
  });

  it("refuses a code this file's changelog row records with other values, and a code created under another file's name", async () => {
    const db = database();
    await run(db, [create("co-ahrb-aht-061-d001")], { apply: true });
    const changed = await run(db, [create("co-ahrb-aht-061-d001", { title: "Otro título" })], { newId: "2f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(changed.report)).toMatch(/line 2: co-ahrb-aht-061-d001 is already a description of neogranadina \(.*\); this file's create changelog row records other values: title/);
    const renamed = await run(db, [create("co-ahrb-aht-061-d001")], { file: "other.csv", newId: "3f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(renamed.report)).toMatch(/line 2: co-ahrb-aht-061-d001 is already a description of neogranadina \(.*\), not one this file created/);
  });

  it("takes the local identifier from the row when it gives one, and the repository always from the parent", async () => {
    const db = database([F, { ...P, repository_id: REPO_B }]);
    const { report } = await run(db, [create("co-ahrb-aht-061-d001", { local_identifier: "AHT-061-001" })], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(byCode(db, "co-ahrb-aht-061-d001")).toMatchObject({ local_identifier: "AHT-061-001", repository_id: REPO_B });
  });

  it("refuses a file with a repository_id column whole", () => {
    expect(() => parseDescriptionChangeFile(csvOf([...CREATE_HEADER, "repository_id"], [create("co-ahrb-aht-061-d001", { repository_id: REPO_B })]), FILE))
      .toThrow(/refused whole: unknown columns repository_id/);
  });

  it("leaves the local identifier NULL when the parent has none", async () => {
    const db = database([F, { ...P, local_identifier: null }]);
    const { report } = await run(db, [create("co-ahrb-aht-061-d001")], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(byCode(db, "co-ahrb-aht-061-d001").local_identifier).toBeNull();
  });

  it("writes is_published 0 or blank as unpublished", async () => {
    const db = database();
    await run(db, [create("co-ahrb-aht-061-d001", { is_published: "0" }), create("co-ahrb-aht-061-d002", { is_published: "" })], { apply: true });
    expect(byCode(db, "co-ahrb-aht-061-d001").is_published).toBe(0);
    expect(byCode(db, "co-ahrb-aht-061-d002").is_published).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

describe("positions", () => {
  it("puts a create with a blank after last, counting the file's earlier creates under the parent", async () => {
    const db = database();
    const { report } = await run(db, [
      create("co-ahrb-aht-062-d004", { parent_code: "co-ahrb-aht-062" }),
      create("co-ahrb-aht-062-d005", { parent_code: "co-ahrb-aht-062" }),
    ], { apply: true });
    expect(report.outcome).toBe("verified");
    expect(byCode(db, "co-ahrb-aht-062-d004").position).toBe(3);
    expect(byCode(db, "co-ahrb-aht-062-d005").position).toBe(4);
    expect(byCode(db, "co-ahrb-aht-062")).toMatchObject({ child_count: 5, updated_at: NOW });
    // No sibling moved.
    expect([Q1, Q2, Q3].map((q) => byCode(db, String(q.reference_code)).updated_at)).toEqual([5, 5, 5]);
  });

  it("puts a create with a blank after past the highest position when the positions have a gap and a repeat", async () => {
    // Children of 062 at positions 0, 4 and 4: three children, highest position 4.
    const db = database([F, P, Q, Q1, { ...Q2, position: 4 }, { ...Q3, position: 4 }]);
    const { report } = await run(db, [
      create("co-ahrb-aht-062-d004", { parent_code: "co-ahrb-aht-062" }),
      create("co-ahrb-aht-062-d005", { parent_code: "co-ahrb-aht-062" }),
    ], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(byCode(db, "co-ahrb-aht-062-d004").position).toBe(5);
    expect(byCode(db, "co-ahrb-aht-062-d005").position).toBe(6);
    expect(report.moves).toEqual([]);
  });

  it("puts a create after the sibling it names, and moves every later sibling down one with a new version", async () => {
    const db = database();
    const { report } = await run(db, [create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) })], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(byCode(db, "co-ahrb-aht-062-d001a").position).toBe(1);
    expect(byCode(db, String(Q1.reference_code))).toMatchObject({ position: 0, updated_at: 5 });
    expect(byCode(db, String(Q2.reference_code))).toMatchObject({ position: 2, updated_at: NOW, updated_by: null });
    expect(byCode(db, String(Q3.reference_code))).toMatchObject({ position: 3, updated_at: NOW, updated_by: null });
    expect(report.moves).toEqual([
      { code: Q2.reference_code, id: Q2.id, from: 1, to: 2 },
      { code: Q3.reference_code, id: Q3.id, from: 2, to: 3 },
    ]);
    // Run again: nothing moves a second time.
    const again = await run(db, [create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) })],
      { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(again.report.outcome).toBe("nothing to write");
    expect(byCode(db, String(Q3.reference_code)).position).toBe(3);
  });

  it("orders two creates after one sibling and after each other", async () => {
    const db = database();
    const { report } = await run(db, [
      create("co-ahrb-aht-062-d001b", { parent_code: "co-ahrb-aht-062", after: "co-ahrb-aht-062-d001a" }),
      create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) }),
    ], { apply: true });
    expect(reasons(report)).toBe("");
    const order = all(db, `SELECT reference_code FROM descriptions WHERE parent_id = '${Q.id}' ORDER BY position`).map((r) => r.reference_code);
    expect(order).toEqual([Q1.reference_code, "co-ahrb-aht-062-d001a", "co-ahrb-aht-062-d001b", Q2.reference_code, Q3.reference_code]);
    expect(all(db, `SELECT position FROM descriptions WHERE parent_id = '${Q.id}' ORDER BY position`).map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it("applies two creates after the same sibling, verifies them and runs again clean", async () => {
    const db = database();
    const rows = [
      create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) }),
      create("co-ahrb-aht-062-d001b", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) }),
    ];
    const { report } = await run(db, rows, { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const order = all(db, `SELECT reference_code FROM descriptions WHERE parent_id = '${Q.id}' ORDER BY position`).map((r) => r.reference_code);
    expect(order).toEqual([Q1.reference_code, "co-ahrb-aht-062-d001b", "co-ahrb-aht-062-d001a", Q2.reference_code, Q3.reference_code]);
    // The after each row gave is in its create changelog row.
    const [log] = all(db, `SELECT diff FROM changelog WHERE id = '${await descriptionCreateJournalId(TENANT, FILE, "co-ahrb-aht-062-d001a")}'`);
    expect(JSON.parse(log.diff).after).toEqual({ old: null, new: Q1.reference_code });
    const again = await run(db, rows, { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already created", "already created"]);
  });

  it("refuses a rerun whose after is not the one the file was applied with, blank included", async () => {
    const db = database();
    const row = create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) });
    await run(db, [row], { apply: true });
    const id = byCode(db, "co-ahrb-aht-062-d001a").id;
    const other = await run(db, [{ ...row, after: String(Q2.reference_code) }], { newId: "2f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(other.report)).toBe(
      `${FILE} line 2: co-ahrb-aht-062-d001a is already a description of neogranadina (${id}); ` +
        `it was created by this file with a different after (${JSON.stringify(Q1.reference_code)}, not ${JSON.stringify(Q2.reference_code)})`,
    );
    const blankAfter = await run(db, [{ ...row, after: "" }], { newId: "3f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(blankAfter.report)).toMatch(/created by this file with a different after \("co-ahrb-aht-062-d001", not ""\)$/);
    // Applied with a blank after, run again with one.
    const db2 = database();
    const appended = create("co-ahrb-aht-062-d004", { parent_code: "co-ahrb-aht-062" });
    await run(db2, [appended], { apply: true });
    const filled = await run(db2, [{ ...appended, after: String(Q3.reference_code) }], { newId: "4f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(filled.report)).toMatch(/created by this file with a different after \("", not "co-ahrb-aht-062-d003"\)$/);
  });

  it("is not affected on a rerun by a reorder of the sibling or the record after the apply", async () => {
    const db = database();
    const row = create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) });
    await run(db, [row], { apply: true });
    db.exec(`UPDATE descriptions SET position = 7, updated_at = 9 WHERE id = '${Q1.id}'`);
    db.exec(`UPDATE descriptions SET position = 9, updated_at = 9 WHERE reference_code = 'co-ahrb-aht-062-d001a'`);
    const again = await run(db, [row], { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(reasons(again.report)).toBe("");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already created"]);
    expect(again.applied).toHaveLength(0);
  });

  for (const order of ["parent first", "child first"] as const) {
    it(`creates under a parent the file creates, ${order}`, async () => {
      const db = database();
      const parent = create("co-ahrb-aht-063", { parent_code: String(F.reference_code), description_level: "file", title: "Legajo 063", date_expression: "1627" });
      const children = [
        create("co-ahrb-aht-063-d001", { parent_code: "co-ahrb-aht-063" }),
        create("co-ahrb-aht-063-d002", { parent_code: "co-ahrb-aht-063" }),
      ];
      const rows = order === "parent first" ? [parent, ...children] : [...children, parent];
      const { report } = await run(db, rows, { apply: true });
      expect(reasons(report)).toBe("");
      expect(report.outcome).toBe("verified");
      const pid = await descriptionCreateId(TENANT, FILE, "co-ahrb-aht-063");
      expect(byCode(db, "co-ahrb-aht-063")).toMatchObject({
        id: pid, parent_id: F.id, depth: 1, root_description_id: F.id, path_cache: `${F.id}/${pid}`, position: 2, child_count: 2,
        local_identifier: "AHT-063",
      });
      const c1 = byCode(db, "co-ahrb-aht-063-d001");
      expect(c1).toMatchObject({ parent_id: pid, depth: 2, root_description_id: F.id, path_cache: `${F.id}/${pid}/${c1.id}`, position: 0, local_identifier: "AHT-063-d001" });
      expect(byCode(db, "co-ahrb-aht-063-d002")).toMatchObject({ parent_id: pid, position: 1 });
      expect(byCode(db, String(F.reference_code))).toMatchObject({ child_count: 3, updated_at: NOW });
      expect(count(db, "SELECT count(*) AS n FROM changelog WHERE kind = 'create'")).toBe(3);
      const again = await run(db, rows, { apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
      expect(again.report.rows.map((r) => r.status)).toEqual(["already created", "already created", "already created"]);
    });
  }
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("refusals", () => {
  it("refuses a parent that is not a description of the tenant, or blank", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-099-d001", { parent_code: "co-ahrb-aht-099" }),
      create("co-otro-001-d001", { parent_code: String(OTHER.reference_code) }),
      create("co-ahrb-aht-061-d001", { parent_code: "" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: parent_code co-ahrb-aht-099 is not a description of neogranadina`,
      `${FILE} line 3: parent_code co-otro-001 is not a description of neogranadina`,
      `${FILE} line 4: parent_code is blank: a description is created under a parent`,
    ].join("\n"));
  });

  it("refuses a level the parent's level does not allow, and an unknown level", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-061-d001", { description_level: "series" }),
      create("co-ahrb-aht-061-d002", { description_level: "legajo" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: series is not a level allowed under co-ahrb-aht-061 (file)`,
      `${FILE} line 3: description_level "legajo" is not one of fonds, subfonds, series, subseries, file, item, collection, section, volume`,
    ].join("\n"));
  });

  it("refuses a code already in the tenant, a code twice in the file, a malformed code and a code outside its parent's", async () => {
    const { report } = await run(database(), [
      create(String(Q1.reference_code), { parent_code: String(Q.reference_code) }),
      create("co-ahrb-aht-061-d001"),
      create("co-ahrb-aht-061-d001"),
      create("co-ahrb-aht-061-d 02"),
      create("co-ahrb-aht-062-d009"),
      create("co-ahrb-aht-0612"),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: ${Q1.reference_code} is already a description of neogranadina (${Q1.id}), not one this file created`,
      `${FILE} line 4: co-ahrb-aht-061-d001 is created again (line 3)`,
      `${FILE} line 5: reference code "co-ahrb-aht-061-d 02" does not match the reference-code pattern (letters, digits and hyphens, 1 to 50 characters)`,
      `${FILE} line 6: co-ahrb-aht-062-d009 does not start with its parent's code co-ahrb-aht-061-`,
      `${FILE} line 7: co-ahrb-aht-0612 does not start with its parent's code co-ahrb-aht-061-`,
    ].join("\n"));
  });

  it("refuses a row that names its own code as its parent or as the sibling it follows", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-061-d001", { parent_code: "co-ahrb-aht-061-d001" }),
      create("co-ahrb-aht-061-d002", { after: "co-ahrb-aht-061-d002" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: co-ahrb-aht-061-d001 names itself as its parent`,
      `${FILE} line 3: co-ahrb-aht-061-d002 names itself as the sibling it follows`,
    ].join("\n"));
  });

  it("refuses a date bound that is not a day or month of the calendar, before the order check", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-061-d001", { date_start: "1625-99-99", date_end: "1625-12-31" }),
      create("co-ahrb-aht-061-d002", { date_start: "1625-02-31" }),
      create("co-ahrb-aht-061-d003", { date_start: "1625-01-01", date_end: "1625-13" }),
      create("co-ahrb-aht-061-d004", { date_start: "1623-02-29", date_end: "1623-12-31" }),
      create("co-ahrb-aht-061-d005", { date_start: "1624-02-29", date_end: "1624-12-31" }),
      create("co-ahrb-aht-061-d006", { date_start: "1626-02-30", date_end: "1625-12-31" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: co-ahrb-aht-061-d001: date_start 1625-99-99 is not a date of the calendar`,
      `${FILE} line 3: co-ahrb-aht-061-d002: date_start 1625-02-31 is not a date of the calendar`,
      `${FILE} line 4: co-ahrb-aht-061-d003: date_end 1625-13 is not a date of the calendar`,
      `${FILE} line 5: co-ahrb-aht-061-d004: date_start 1623-02-29 is not a date of the calendar`,
      `${FILE} line 7: co-ahrb-aht-061-d006: date_start 1626-02-30 is not a date of the calendar`,
    ].join("\n"));
  });

  it("refuses a create missing a field the standard requires at its level, a malformed date and a start after the end", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-061-d001", { date_expression: "" }),
      create("co-ahrb-aht-061-d002", { title: "" }),
      create("co-ahrb-aht-061-d003", { date_start: "1625-1-1" }),
      create("co-ahrb-aht-061-d004", { date_start: "1626", date_end: "1625-12-31" }),
      create("co-ahrb-aht-061-d005", { date_start: "1625-06", date_end: "1625" }),
    ]);
    const r = reasons(report).split("\n");
    expect(r).toHaveLength(4);
    expect(r[0]).toBe(`${FILE} line 2: co-ahrb-aht-061-d001: the editor refuses these values (date_expression: field_required)`);
    expect(r[1]).toBe(`${FILE} line 3: co-ahrb-aht-061-d002: the editor refuses these values (title: field_required)`);
    expect(r[2]).toMatch(/^.* line 4: co-ahrb-aht-061-d003: the editor refuses these values \(date_start: /);
    expect(r[3]).toBe(`${FILE} line 5: co-ahrb-aht-061-d004: date_start 1626 is after date_end 1625-12-31`);
  });

  it("refuses an unknown field column, refusing the file whole", () => {
    expect(() => parseDescriptionChangeFile(csvOf([...CREATE_HEADER, "colour"], [create("co-ahrb-aht-061-d001")]), FILE)).toThrow(/refused whole: unknown columns colour/);
  });

  it("refuses an after that is not a child of the parent", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-061-d001"),
      create("co-ahrb-aht-061-d002", { after: String(Q1.reference_code) }),
      create("co-ahrb-aht-061-d003", { after: "co-ahrb-aht-061-d009" }),
      create("co-ahrb-aht-062-d004", { parent_code: String(Q.reference_code), after: "co-ahrb-aht-061-d001" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 3: after ${Q1.reference_code} is not a child of co-ahrb-aht-061`,
      `${FILE} line 4: after co-ahrb-aht-061-d009 is not a child of co-ahrb-aht-061`,
      `${FILE} line 5: after co-ahrb-aht-061-d001 is not a child of co-ahrb-aht-062`,
    ].join("\n"));
  });

  it("refuses a create whose parent or after is refused, and rows that depend on each other", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-064", { parent_code: String(F.reference_code), description_level: "file", title: "", date_expression: "1627" }),
      create("co-ahrb-aht-064-d001", { parent_code: "co-ahrb-aht-064" }),
      create("co-ahrb-aht-061-d001", { after: "co-ahrb-aht-061-d002" }),
      create("co-ahrb-aht-061-d002", { after: "co-ahrb-aht-061-d001" }),
    ]);
    const r = reasons(report);
    expect(r).toMatch(/line 2: co-ahrb-aht-064: the editor refuses these values \(title: field_required\)/);
    expect(r).toMatch(/line 3: the parent co-ahrb-aht-064 is created by line 2, which is refused/);
    expect(r).toMatch(/line 4: co-ahrb-aht-061-d001 depends on itself through parent_code or after/);
    expect(r).toMatch(/line 5: co-ahrb-aht-061-d002 depends on itself through parent_code or after/);
  });

  for (const [field, current, next] of [["repository_id", REPO, REPO_B], ["local_identifier", "AHT-061", "AHT-61"]] as const) {
    it(`refuses a create under a parent the same file updates on ${field}`, async () => {
      const { report } = await run(database(), [
        create("co-ahrb-aht-061-d001"),
        update(P, field, current, next),
      ], { header: MIXED_HEADER });
      expect(reasons(report)).toBe(
        `${FILE} line 2: the parent co-ahrb-aht-061 has an update-field row on ${field} in this file (line 3), ` +
          `which a create under it would not see; put the update and the creates in separate files`,
      );
    });
  }

  it("refuses the update-field columns on a create row, the create columns on an update row, and an is_published other than 0 or 1", async () => {
    const { report } = await run(database(), [
      { ...create("co-ahrb-aht-061-d001"), field: "title" },
      { ...update(P, "extent", "672 tomas", "673 tomas"), parent_code: String(F.reference_code) },
      create("co-ahrb-aht-061-d003", { is_published: "yes" }),
    ], { header: MIXED_HEADER });
    expect(reasons(report)).toBe([
      `${FILE} line 2: a create-description row leaves fisqua_id, field, current_value and new_value blank; this one gives field`,
      `${FILE} line 3: an update-field row leaves the create-description columns blank; this one gives parent_code`,
      `${FILE} line 4: is_published is 0 or 1, not "yes"`,
    ].join("\n"));
  });

  it("writes nothing when any row is refused", async () => {
    const db = database();
    const { report, applied } = await run(db, [create("co-ahrb-aht-061-d001"), create("co-ahrb-aht-061-d002", { parent_code: "nope" })], { apply: true });
    expect(report.outcome).toBe("refused");
    expect(applied).toHaveLength(0);
    expect(byCode(db, "co-ahrb-aht-061-d001")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// update-field, widened
// ---------------------------------------------------------------------------

describe("update-field on the editor's fields", () => {
  it("changes extent and date_start as the editor's save does, checking current_value", async () => {
    const db = database();
    const { report } = await run(db, [
      update(P, "extent", "672 tomas", "673 tomas"),
      update(P, "date_start", "", "1625-01-22"),
    ], { header: MIXED_HEADER, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(byCode(db, String(P.reference_code))).toMatchObject({ extent: "673 tomas", date_start: "1625-01-22", date_end: null, updated_by: "user_001", updated_at: NOW });
    const [log] = all(db, "SELECT * FROM changelog");
    expect(JSON.parse(log.diff)).toEqual({ dateStart: { old: null, new: "1625-01-22" }, extent: { old: "672 tomas", new: "673 tomas" } });
    const wrong = await run(database(), [update(P, "extent", "670 tomas", "673 tomas")], { header: MIXED_HEADER });
    expect(reasons(wrong.report)).toMatch(/extent of co-ahrb-aht-061 is not current_value/);
  });

  it("refuses description_level, has_digital other than 0 or 1, a malformed date, and a repository of another tenant", async () => {
    const { report } = await run(database(), [
      update(P, "description_level", "file", "volume"),
      update(P, "has_digital", "0", "true"),
      update(P, "date_end", "", "1625/12/31"),
      update(P, "repository_id", REPO, REPO_OTHER),
    ], { header: MIXED_HEADER });
    const r = reasons(report).split("\n");
    expect(r[0]).toBe(`${FILE} line 2: field "description_level" is not one of the editor's fields that update-field changes`);
    expect(r[1]).toBe(`${FILE} line 3: has_digital is written 0 or 1; new_value is "true"`);
    expect(r[2]).toMatch(/line 4: date_end of co-ahrb-aht-061: the editor refuses this value/);
    expect(r[3]).toBe(`${FILE} line 5: repository_id of co-ahrb-aht-061: ${REPO_OTHER} is not a repository of neogranadina`);
  });

  it("refuses a date bound that would fall outside the other bound the record holds", async () => {
    const db = database([F, { ...P, date_start: "1625-01-01", date_end: "1625-12-31" }]);
    const { report } = await run(db, [update({ ...P, date_start: "1625-01-01" }, "date_start", "1625-01-01", "1626")], { header: MIXED_HEADER });
    expect(reasons(report)).toBe(`${FILE} line 2: co-ahrb-aht-061: date_start 1626 would be after date_end 1625-12-31`);
    const both = await run(db, [update(P, "date_start", "1625-01-01", "1626"), update(P, "date_end", "1625-12-31", "1626-12-31")], { header: MIXED_HEADER });
    expect(reasons(both.report)).toBe("");
  });

  it("reads the evidence column and writes nothing of it", async () => {
    const db = database();
    const { report } = await run(db, [create("co-ahrb-aht-061-d001", { evidence: "índice, tomo 1, entrada a" })], { header: [...CREATE_HEADER, "evidence"], apply: true });
    expect(report.outcome).toBe("verified");
    expect(JSON.stringify(all(db, "SELECT * FROM changelog"))).not.toContain("índice, tomo 1");
    expect(JSON.stringify(byCode(db, "co-ahrb-aht-061-d001"))).not.toContain("índice, tomo 1");
  });

  it("takes 29 February as the Julian calendar does before 1583 and the Gregorian from 1583", async () => {
    const { report } = await run(database(), [
      create("co-ahrb-aht-061-d001", { date_start: "1500-02-29", date_end: "1500-12-31" }),
      create("co-ahrb-aht-061-d002", { date_start: "1501-02-29", date_end: "1501-12-31" }),
      create("co-ahrb-aht-061-d003", { date_start: "1700-02-29", date_end: "1700-12-31" }),
      create("co-ahrb-aht-061-d004", { date_start: "1600-02-29", date_end: "1600-12-31" }),
      create("co-ahrb-aht-061-d005", { date_start: "1300-02-29", date_end: "1300-12-31" }),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 3: co-ahrb-aht-061-d002: date_start 1501-02-29 is not a date of the calendar`,
      `${FILE} line 4: co-ahrb-aht-061-d003: date_start 1700-02-29 is not a date of the calendar`,
    ].join("\n"));
  });

  it("refuses an update to a date bound that is not a day or month of the calendar", async () => {
    const { report } = await run(database(), [
      update(P, "date_start", "", "1625-02-29"),
      update(P, "date_end", "", "1625-00"),
      update(Q, "date_start", "", "1624-02-29"),
    ], { header: MIXED_HEADER });
    expect(reasons(report)).toBe([
      `${FILE} line 2: date_start of co-ahrb-aht-061: 1625-02-29 is not a date of the calendar`,
      `${FILE} line 3: date_end of co-ahrb-aht-061: 1625-00 is not a date of the calendar`,
    ].join("\n"));
  });

  it("updates a sibling the file also moves, in one write", async () => {
    const db = database();
    const { report } = await run(db, [
      create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) }),
      update(Q2, "extent", "", "ff. 3r-4v"),
    ], { header: MIXED_HEADER, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(byCode(db, String(Q2.reference_code))).toMatchObject({ position: 2, extent: "ff. 3r-4v", updated_by: "user_001", updated_at: NOW });
  });

  it("names every field of the editor's update form but the level and the digital flag", () => {
    const route = fs.readFileSync(path.join(__dirname, "../../app/routes/_auth.admin.descriptions.$id.tsx"), "utf8");
    const list = /const UPDATE_FORM_FIELDS = \[([\s\S]*?)\] as const;/.exec(route)![1];
    const keys = [...list.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(FIELDS.map((f) => f.key)).toEqual(keys);
    expect(FIELDS.map((f) => f.field)).not.toContain("description_level");
    expect(FIELDS.map((f) => f.field)).not.toContain("has_digital");
  });
});

// ---------------------------------------------------------------------------
// The rerun contract
// ---------------------------------------------------------------------------

describe("a file run again", () => {
  const CODE = "co-ahrb-aht-061-d001";
  const byCodeOnly = (code: string, field: string, current: string, next: string): Cells => ({
    op: "update-field", reference_code: code, field, current_value: current, new_value: next, changelog_note: "Corrección",
  });
  const everything = (db: DatabaseSync) => JSON.stringify([all(db, "SELECT * FROM descriptions ORDER BY id"), all(db, "SELECT * FROM changelog ORDER BY id")]);

  it("refuses at plan, nothing written, a done create beside an update-field on the record it created", async () => {
    const db = database();
    expect((await run(db, [create(CODE)], { header: MIXED_HEADER, apply: true })).report.outcome).toBe("verified");
    const before = everything(db);
    const { report, applied } = await run(db, [create(CODE), byCodeOnly(CODE, "extent", "ff. 1r-2v", "ff. 1r-3v")], { header: MIXED_HEADER, apply: true });
    expect(applied).toEqual([]);
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toBe(
      `${FILE}: this file was applied before and has changed since: put new changes in a new file (line 2 is already created; line 3 would update)`,
    );
    expect(everything(db)).toBe(before);
  });

  it("refuses at plan, nothing written, an update-field row replaced by another on the same record", async () => {
    const db = database();
    expect((await run(db, [update(P, "extent", "672 tomas", "673 tomas")], { header: MIXED_HEADER, apply: true })).report.outcome).toBe("verified");
    const before = everything(db);
    const { report, applied } = await run(db, [update(P, "title", "Legajo 061", "Legajo 061 bis")], { header: MIXED_HEADER, apply: true });
    expect(applied).toEqual([]);
    expect(reasons(report)).toMatch(new RegExp(`^${FILE} line 2: line 2 was applied before and has changed since: put new changes in a new file \\(part of its effect is present`));
    expect(everything(db)).toBe(before);
  });

  it("writes nothing when an unchanged file of creates and updates runs again", async () => {
    const db = database();
    const rows = [create(CODE), update(Q2, "extent", "", "ff. 3r-4v"), update(F, "extent", "1 fondo", "2 fondos")];
    expect((await run(db, rows, { header: MIXED_HEADER, apply: true })).report.outcome).toBe("verified");
    const before = everything(db);
    const again = await run(db, rows, { header: MIXED_HEADER, apply: true });
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already created", "already updated", "already updated"]);
    expect(again.applied).toEqual([]);
    expect(everything(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Between the plan and the write
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Former reference codes
// ---------------------------------------------------------------------------

describe("descriptions that record a created code as a former one", () => {
  const holds = (code: string) => JSON.stringify([{ provider: "former-reference-code", id: code }]);

  it("take one new version, the parent among them, however many reasons the file has to write it", async () => {
    const H: Seed = { ...Q3, legacy_ids: holds("co-ahrb-aht-061-d001") };
    const db = database([F, { ...P, legacy_ids: holds("co-ahrb-aht-061-d001") }, Q, Q1, Q2, H]);
    const { report } = await run(db, [create("co-ahrb-aht-061-d001")], { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    // The parent: child count and holder, one advance from 5 to the clock.
    expect(byCode(db, String(P.reference_code))).toMatchObject({ child_count: 1, updated_at: NOW });
    // A holder the file does not otherwise write: one advance.
    expect(byCode(db, String(H.reference_code)).updated_at).toBe(NOW);
    // A description that holds nothing: unmoved.
    expect(byCode(db, String(Q2.reference_code)).updated_at).toBe(5);
  });
});

describe("between the plan and the write", () => {
  const rows = () => [create("co-ahrb-aht-062-d001a", { parent_code: "co-ahrb-aht-062", after: String(Q1.reference_code) })];

  for (const [what, change, message] of [
    ["the parent changes", `UPDATE descriptions SET title = 'Legajo 62' WHERE id = '${Q.id}'`, "a description the file reads has changed since it was read"],
    ["a sibling the file moves changes", `UPDATE descriptions SET updated_at = 6 WHERE id = '${Q3.id}'`, "a child of a parent the file creates under has changed since it was read"],
    ["a child is added to the parent", `INSERT INTO descriptions (id, tenant_id, repository_id, reference_code, description_level, title, parent_id, position, updated_at, created_at) VALUES ('${uuid(50)}', '${TENANT}', '${REPO}', 'co-ahrb-aht-062-d009', 'item', 'x', '${Q.id}', 3, 6, 6)`, "a child of a parent the file creates under has changed since it was read"],
    ["the code is taken", `INSERT INTO descriptions (id, tenant_id, repository_id, reference_code, description_level, title, updated_at, created_at) VALUES ('${uuid(51)}', '${TENANT}', '${REPO}', 'co-ahrb-aht-062-d001a', 'item', 'x', 6, 6)`, "a description the file creates, or its code, is already there"],
  ] as const) {
    it(`aborts the file whole, nothing written, when ${what}`, async () => {
      const db = database();
      await expect(run(db, rows(), { apply: true, beforeApply: (d) => d.exec(change) })).rejects.toThrow(/ABORT|malformed JSON/);
      expect(count(db, "SELECT count(*) AS n FROM changelog")).toBe(0);
      expect(byCode(db, String(Q3.reference_code)).position).toBe(2);
      expect(await failingGuards(database(), rows(), (d) => d.exec(change))).toEqual([message]);
    });
  }

  it("aborts when a repository an update-field row names leaves the tenant", async () => {
    const change = `UPDATE repositories SET tenant_id = 't-2' WHERE id = '${REPO_B}'`;
    expect(await failingGuards(database(), [update(P, "repository_id", REPO, REPO_B)], (d) => d.exec(change), MIXED_HEADER))
      .toEqual(["a repository the file names has changed since it was read"]);
  });
});

// ---------------------------------------------------------------------------
// The legajo 061 file, and the size of a large one
// ---------------------------------------------------------------------------

const FIXTURE_061 = fs.readFileSync(path.join(__dirname, "fixtures/descriptions-create-061.csv"), "utf8");

describe("the legajo 061 file", () => {
  it("plans and applies its twelve creates in order, and a second run writes nothing", async () => {
    const db = database();
    const { report, written } = await run(db, [], { text: FIXTURE_061, file: "aht-new-061-3.csv", apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(report.totals.create).toBe(12);
    const made = all(db, `SELECT reference_code, position, local_identifier, is_published, language FROM descriptions WHERE parent_id = '${P.id}' ORDER BY position`);
    expect(made.map((m) => m.reference_code)).toEqual(Array.from({ length: 12 }, (_, i) => `co-ahrb-aht-061-d${String(i + 1).padStart(3, "0")}`));
    expect(made.map((m) => m.position)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(made[0]).toMatchObject({ local_identifier: "AHT-061-d001", is_published: 1, language: "192" });
    expect(byCode(db, "co-ahrb-aht-061-d001")).toMatchObject({
      title: "Probanza de Juan Sarmiento en la causa con doña María de Mayorga y otras por tierras en Vélez", extent: "ff. 001r-034v",
      date_expression: "1625", date_start: "1625-01-01", date_end: "1625-12-31",
    });
    expect(byCode(db, String(P.reference_code)).child_count).toBe(12);
    const sql = [...written].find(([k]) => k.endsWith(".sql"))![1];
    console.log(`061 file: ${report.totals.statements} statements, ${Buffer.byteLength(sql)} bytes, largest ${report.totals.largestStatement} (budget ${STATEMENT_BUDGET})`);
    expect(report.totals.largestStatement).toBeLessThanOrEqual(STATEMENT_BUDGET);
    const again = await run(db, [], { text: FIXTURE_061, file: "aht-new-061-3.csv", apply: true, newId: "1f1e2d3c-0000-4000-8000-000000000000" });
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.totals.alreadyCreated).toBe(12);
  });

  it("keeps 320 creates under one parent within the statement budget", async () => {
    const db = database();
    const long = "Juicio civil por tierras en Vélez, con inventario de bienes, testimonios y autos del alcalde ordinario. ".repeat(6);
    const rows = Array.from({ length: 320 }, (_, i) => create(`co-ahrb-aht-061-d${String(i + 1).padStart(3, "0")}`, { scope_content: long }));
    const { report, written } = await run(db, rows, { header: CREATE_HEADER, apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const sql = [...written].find(([k]) => k.endsWith(".sql"))![1];
    console.log(`320 creates: ${report.totals.statements} statements, ${Buffer.byteLength(sql)} bytes, largest ${report.totals.largestStatement} (budget ${STATEMENT_BUDGET})`);
    expect(report.totals.largestStatement).toBeLessThanOrEqual(STATEMENT_BUDGET);
    expect(count(db, `SELECT count(*) AS n FROM descriptions WHERE parent_id = '${P.id}'`)).toBe(320);
  });
});

// @version v0.9.0
