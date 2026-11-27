/**
 * Tests — carrying the functions of earlier merges to their survivors
 *
 * This suite pins `scripts/lib/merged-functions-carry.ts`, behind
 * `scripts/commands/carry-merged-functions.ts`: the one-off pass that
 * moves the function rows still held by entities merged away before a
 * merge moved them itself. The D1 is a `node:sqlite` twin holding the
 * columns the command reads and writes, with D1's expression depth limit
 * of 100; the providers read it, write files to a map and apply the SQL
 * file as one unit, as `wrangler d1 execute --file` does.
 *
 *   - the dry run reads, plans and writes only the report: per survivor,
 *     the rows to move and the rows to fold with their function text and
 *     the before and after counts as the export groups them;
 *   - a donor's row of a function the survivor holds, its own or carried
 *     by an earlier row (case and spacing aside), is not carried a second
 *     time: it fills the held row's empty fields, never one it has, and
 *     is deleted, and the ledger row gives it (`foldedFunctions`);
 *   - a merge chain is followed to its end: a record merged into a
 *     record itself merged away gives its rows to the last survivor;
 *   - only the tenant's scope is read: another federation's records and
 *     another tenant's own are left alone;
 *   - `--apply` moves the rows with their ids and columns, sets each
 *     survivor's and each donor's `updated_at` past the value read and
 *     past `now`, writes
 *     one ledger row per record merged away naming the rows moved, and
 *     re-reads what it wrote;
 *   - a second run finds nothing to carry and writes nothing, and an
 *     editor save on a donor from a form loaded before the carry is
 *     refused, so it cannot put rows back for a later run to move again;
 *   - a function row, a survivor or a donor changed between the read
 *     and the apply fails the whole file;
 *   - production needs `--confirm-production`.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  CarryStop,
  carryMergedFunctions,
  type CarryProviders,
} from "../../scripts/lib/merged-functions-carry";
import { parseArgs } from "../../scripts/commands/carry-merged-functions";
import { composer, render } from "../../scripts/lib/authority-merges";
import { entityFunctionsReplacement, type EntityFunctionRow } from "../../app/lib/entity-functions.server";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
const FED = "fed-1";
const NOW = 1_800_000_000_000;

const DDL = `
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL, federation_id TEXT NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, entity_code TEXT,
  display_name TEXT NOT NULL, merged_into TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE entity_functions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, honorific TEXT, function TEXT NOT NULL,
  date_start TEXT, date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE authority_operations (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, record_type TEXT NOT NULL,
  operation TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT, user_id TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
INSERT INTO tenants VALUES ('t-1', 'neogranadina', 'fed-1'), ('t-2', 'other', 'fed-1'), ('t-3', 'far', 'fed-2');
INSERT INTO users VALUES ('user_001');
`;

function entity(db: DatabaseSync, id: string, name: string, over: { mergedInto?: string; fed?: string; tenant?: string; updatedAt?: number } = {}) {
  db.prepare("INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, over.fed ?? FED, over.tenant ?? null, `ne-${id}`, name, over.mergedInto ?? null, over.updatedAt ?? 100,
  );
}

function fn(db: DatabaseSync, id: string, entityId: string, text: string) {
  db.prepare(
    "INSERT INTO entity_functions (id, entity_id, honorific, function, date_start, source, notes, created_at, updated_at) VALUES (?, ?, 'don', ?, '1650', 'AGN', ?, 7, 8)",
  ).run(id, entityId, text, `note ${id}`);
}

/**
 * The fixture: Maestre (s1) absorbed l1 and l2, and l3 was merged into l2
 * (a chain); s1 holds "Maestre de Campo" once, l1 holds it twice in two
 * spellings and "Alcalde", l3 holds "Maestre de Campo". s2 absorbed l4,
 * which holds nothing. x1 (another tenant's own) and f1 (another
 * federation) are merged away with rows the run must not read.
 */
function twin(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  entity(db, "s1", "Maestre", { updatedAt: 100 });
  entity(db, "l1", "Maestre bis", { mergedInto: "s1" });
  entity(db, "l2", "Maestre ter", { mergedInto: "s1" });
  entity(db, "l3", "Maestre quater", { mergedInto: "l2" });
  entity(db, "s2", "Alone", { updatedAt: NOW + 50 });
  entity(db, "l4", "Alone bis", { mergedInto: "s2" });
  entity(db, "xs", "Theirs", { tenant: "t-2" });
  entity(db, "x1", "Theirs bis", { tenant: "t-2", mergedInto: "xs" });
  entity(db, "fs", "Far", { fed: "fed-2" });
  entity(db, "f1", "Far bis", { fed: "fed-2", mergedInto: "fs" });
  fn(db, "f-s1a", "s1", "Maestre de Campo");
  fn(db, "f-l1a", "l1", "Maestre de Campo");
  fn(db, "f-l1b", "l1", "Alcalde");
  fn(db, "f-l1c", "l1", "maestre de campo");
  fn(db, "f-l3a", "l3", "Maestre de Campo");
  fn(db, "f-x1a", "x1", "Regidor");
  fn(db, "f-f1a", "f1", "Regidor");
  return db;
}

interface Run {
  files: Map<string, string>;
  applied: string[][];
}

function providers(db: DatabaseSync, run: Run, before?: () => void): CarryProviders {
  return {
    rows: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    writeFile: (path, text) => run.files.set(path, text),
    applyFile: async (_path, statements) => {
      before?.();
      run.applied.push(statements);
      db.exec("BEGIN");
      try {
        db.exec(statements.join("\n"));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    now: () => NOW,
  };
}

async function command(db: DatabaseSync, apply: boolean, before?: () => void) {
  const run: Run = { files: new Map(), applied: [] };
  const lines: string[] = [];
  const report = await carryMergedFunctions(
    { tenant: "neogranadina", target: "staging", apply },
    providers(db, run, before),
    (l) => lines.push(l),
  );
  return { report, run, lines };
}

/**
 * The entity editor's save of `lines` from a form loaded at `formVersion`,
 * as its action makes it: the form's version against the stored one, then
 * the function replacement and the entity update, both conditional on the
 * stored version.
 */
function editorSave(db: DatabaseSync, entityId: string, lines: string[], formVersion: number): "saved" | "conflict" {
  const stored = (db.prepare("SELECT updated_at FROM entities WHERE id = ?").get(entityId) as { updated_at: number }).updated_at;
  if (String(stored) !== String(formVersion)) return "conflict";
  const existing = (db.prepare("SELECT * FROM entity_functions WHERE entity_id = ? ORDER BY rowid").all(entityId) as any[]).map(
    (r): EntityFunctionRow => ({
      id: r.id, entityId: r.entity_id, honorific: r.honorific, function: r.function, dateStart: r.date_start,
      dateEnd: r.date_end, dateNote: r.date_note, certainty: r.certainty, source: r.source, notes: r.notes,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }),
  );
  const { functionStatements, touch } = entityFunctionsReplacement(composer(), entityId, lines, existing, stored, NOW + 1_000);
  db.exec([...functionStatements, touch].map((s) => render(s as any)).join("\n"));
  return "saved";
}

const rows = (db: DatabaseSync) =>
  db.prepare("SELECT rowid AS r, * FROM entity_functions ORDER BY rowid").all() as Array<Record<string, unknown>>;

describe("the dry run", () => {
  it("plans per survivor, following chains, within the tenant's scope, and writes only the report", async () => {
    const db = twin();
    const before = rows(db);
    const { report, run, lines } = await command(db, false);

    expect(rows(db)).toEqual(before);
    expect(run.applied).toEqual([]);
    expect([...run.files.keys()].every((k) => /carry-merged-functions_staging_.*\.(json|md)$/.test(k))).toBe(true);

    expect(report.refusals).toEqual([]);
    expect(report.counts).toMatchObject({ mergedRecords: 4, losersWithFunctions: 2, rowsToMove: 1, rowsToFold: 3, survivors: 1 });
    const s1 = report.survivors[0];
    expect(s1.survivorCode).toBe("ne-s1");
    // s1 holds "Maestre de Campo": every carried spelling of it folds into f-s1a.
    expect(s1.moves.map((m) => [m.loserCode, m.chain, m.rows.map((r) => r.function), m.folded.map((f) => `${f.id}>${f.into}`)])).toEqual([
      ["ne-l1", ["ne-l1", "ne-s1"], ["Alcalde"], ["f-l1a>f-s1a", "f-l1c>f-s1a"]],
      ["ne-l3", ["ne-l3", "ne-l2", "ne-s1"], [], ["f-l3a>f-s1a"]],
    ]);
    expect(s1.moves[0].folded[0]).toMatchObject({ filled: [], conflicts: [{ field: "notes", held: "note f-s1a", incoming: "note f-l1a" }] });
    expect(s1.before).toEqual([{ function: "Maestre de Campo", count: 1 }]);
    expect(s1.after).toEqual([
      { function: "Alcalde", count: 1 },
      { function: "Maestre de Campo", count: 1 },
    ]);
    const text = lines.join("\n");
    expect(text).toContain("ne-s1 Maestre: 4 row(s) from 2 merged record(s)");
    expect(text).toContain("before: Maestre de Campo 1");
    expect(text).toContain("after:  Alcalde 1; Maestre de Campo 1");
    expect(text).toContain("from ne-l3 (via ne-l2) Maestre quater: (none moved)");
    expect(text).toContain("f-l3a Maestre de Campo folds into f-s1a: skipped, nothing to fill");
  });
});

describe("--apply", () => {
  it("moves the rows with their columns, bumps each survivor, writes the ledger and re-reads", async () => {
    const db = twin();
    const before = Object.fromEntries(rows(db).map((r) => [r.id, r]));
    const { report, run, lines } = await command(db, true);

    expect(run.applied).toHaveLength(1);
    expect([...run.files.keys()].some((k) => k.endsWith(".sql"))).toBe(true);
    expect(rows(db).find((r) => r.id === "f-l1b")!).toEqual({ ...before["f-l1b"], entity_id: "s1" });
    // The rows of a function s1 holds are not carried a second time.
    expect(rows(db).filter((r) => r.entity_id === "s1").map((r) => r.id)).toEqual(["f-s1a", "f-l1b"]);
    expect(rows(db).find((r) => r.id === "f-s1a")!).toEqual(before["f-s1a"]);
    // Out of scope: untouched.
    expect(rows(db).find((r) => r.id === "f-x1a")!.entity_id).toBe("x1");
    expect(rows(db).find((r) => r.id === "f-f1a")!.entity_id).toBe("f1");

    expect(db.prepare("SELECT updated_at FROM entities WHERE id = 's1'").get()).toEqual({ updated_at: NOW });
    // Each donor's updated_at moves too, so a form loaded before the
    // carry cannot write functions back onto it; l2 gave nothing.
    expect(db.prepare("SELECT id, updated_at FROM entities WHERE id IN ('l1', 'l2', 'l3') ORDER BY id").all()).toEqual([
      { id: "l1", updated_at: NOW },
      { id: "l2", updated_at: 100 },
      { id: "l3", updated_at: NOW },
    ]);
    // s2 gained nothing, so it is not touched.
    expect(db.prepare("SELECT updated_at FROM entities WHERE id = 's2'").get()).toEqual({ updated_at: NOW + 50 });

    const ledger = (db.prepare("SELECT * FROM authority_operations ORDER BY source_id").all() as any[]).map((l) => ({
      ...l, detail: JSON.parse(l.detail),
    }));
    expect(ledger.map((l) => [l.operation, l.record_type, l.source_id, l.target_id, l.user_id, l.created_at, l.federation_id])).toEqual([
      ["merge", "entity", "l1", "s1", "user_001", NOW, FED],
      ["merge", "entity", "l3", "s1", "user_001", NOW, FED],
    ]);
    expect(ledger[0].detail).toMatchObject({ carry: "functions", movedFunctions: ["f-l1b"], movedLinks: 0, droppedLinks: [] });
    expect(ledger[0].detail.foldedFunctions.map((f: any) => [f.row.id, f.into])).toEqual([["f-l1a", "f-s1a"], ["f-l1c", "f-s1a"]]);
    expect(ledger[1].detail.movedFunctions).toEqual([]);
    expect(ledger[1].detail.foldedFunctions.map((f: any) => f.row.id)).toEqual(["f-l3a"]);

    expect(report.applied).toBe(true);
    expect(report.verified).toBe(true);
    expect(lines.join("\n")).toContain("[ok] ne-s1");
  });

  it("fills the survivor's row of a carried function where it is empty, and never where it is not", async () => {
    const db = twin();
    db.prepare("UPDATE entity_functions SET source = NULL, notes = NULL WHERE id = 'f-s1a'").run();
    db.prepare("UPDATE entity_functions SET source = 'AHRB' WHERE id = 'f-l1c'").run();
    const { report } = await command(db, true);
    expect(report.verified).toBe(true);
    expect(rows(db).find((r) => r.id === "f-s1a")).toMatchObject({ entity_id: "s1", source: "AGN", notes: "note f-l1a", updated_at: NOW });
    const folded = report.survivors[0].moves[0].folded;
    expect(folded.map((f) => [f.id, f.filled])).toEqual([["f-l1a", ["source", "notes"]], ["f-l1c", []]]);
    expect(folded[1].conflicts).toEqual([
      { field: "source", held: "AGN", incoming: "AHRB" },
      { field: "notes", held: "note f-l1a", incoming: "note f-l1c" },
    ]);
  });

  it("leaves a survivor's version alone when every carried row folds without filling", async () => {
    const db = twin();
    db.prepare("DELETE FROM entity_functions WHERE id = 'f-l1b'").run();
    const { report } = await command(db, true);
    expect(report.verified).toBe(true);
    expect(rows(db).filter((r) => r.entity_id === "s1").map((r) => r.id)).toEqual(["f-s1a"]);
    expect(db.prepare("SELECT updated_at FROM entities WHERE id = 's1'").get()).toEqual({ updated_at: 100 });
    // The donors gave their rows up, so they still take a new version.
    expect(db.prepare("SELECT id, updated_at FROM entities WHERE id IN ('l1', 'l3') ORDER BY id").all()).toEqual([
      { id: "l1", updated_at: NOW },
      { id: "l3", updated_at: NOW },
    ]);
  });

  it("sets a survivor's updated_at past the value read when that is already at or after now", async () => {
    const db = twin();
    db.prepare("UPDATE entities SET updated_at = ? WHERE id = 's1'").run(NOW + 10);
    await command(db, true);
    expect(db.prepare("SELECT updated_at FROM entities WHERE id = 's1'").get()).toEqual({ updated_at: NOW + 11 });
  });

  it("sets a donor's updated_at past the value read when that is already at or after now", async () => {
    const db = twin();
    db.prepare("UPDATE entities SET updated_at = ? WHERE id = 'l1'").run(NOW + 3);
    await command(db, true);
    expect(db.prepare("SELECT updated_at FROM entities WHERE id = 'l1'").get()).toEqual({ updated_at: NOW + 4 });
  });

  it("finds nothing to carry on a second run, and writes nothing", async () => {
    const db = twin();
    await command(db, true);
    const after = rows(db);
    const ledger = db.prepare("SELECT count(*) AS n FROM authority_operations").get();
    const { report, run, lines } = await command(db, true);
    expect(report.counts.rowsToMove).toBe(0);
    expect(run.applied).toEqual([]);
    expect(rows(db)).toEqual(after);
    expect(db.prepare("SELECT count(*) AS n FROM authority_operations").get()).toEqual(ledger);
    expect(lines.join("\n")).toContain("Nothing to carry.");
  });

  it("refuses a stale editor save on a donor after the carry, and a second run moves nothing", async () => {
    const db = twin();
    // The editor form on l1 was loaded before the carry, at version 100.
    const formVersion = 100;
    await command(db, true);
    const after = rows(db);
    expect(editorSave(db, "l1", ["Maestre de Campo", "Alcalde", "maestre de campo"], formVersion)).toBe("conflict");
    expect(rows(db)).toEqual(after);
    const { report, run } = await command(db, true);
    expect(report.counts.rowsToMove).toBe(0);
    expect(run.applied).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM entity_functions WHERE entity_id = 's1'").get()).toEqual({ n: 2 });
  });

  it("fails the whole file when a function row changed between the read and the apply", async () => {
    for (const change of [
      (db: DatabaseSync) => fn(db, "f-new", "l1", "Regidor"),
      (db: DatabaseSync) => db.prepare("DELETE FROM entity_functions WHERE id = 'f-l3a'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE entities SET updated_at = 5 WHERE id = 's1'").run(),
      (db: DatabaseSync) => db.prepare("UPDATE entities SET updated_at = 7 WHERE id = 'l1'").run(),
    ]) {
      const db = twin();
      const snapshot = () => ({ f: rows(db), e: db.prepare("SELECT * FROM entities ORDER BY id").all() });
      let expected: unknown;
      await expect(command(db, true, () => { change(db); expected = snapshot(); })).rejects.toThrow(/malformed JSON/);
      expect(snapshot()).toEqual(expected);
      expect(db.prepare("SELECT count(*) AS n FROM authority_operations").get()).toEqual({ n: 0 });
    }
  });

  it("refuses a chain that loops, and writes nothing", async () => {
    const db = twin();
    db.prepare("UPDATE entities SET merged_into = 'l3' WHERE id = 'l2'").run();
    const run: Run = { files: new Map(), applied: [] };
    await expect(
      carryMergedFunctions({ tenant: "neogranadina", target: "staging", apply: true }, providers(db, run), () => {}),
    ).rejects.toBeInstanceOf(CarryStop);
    expect(run.applied).toEqual([]);
  });
});

describe("the arguments", () => {
  it("dry-runs by default and needs --confirm-production to apply to production", () => {
    expect(parseArgs(["--target", "production", "--tenant", "neogranadina"])).toMatchObject({ apply: false, target: "production" });
    expect(() => parseArgs(["--target", "production", "--tenant", "neogranadina", "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs(["--target", "staging", "--tenant", "neogranadina", "--apply"])).toMatchObject({ apply: true });
    expect(() => parseArgs(["--target", "local", "--tenant", "neogranadina"])).toThrow(/staging or production/);
    expect(() => parseArgs(["--target", "staging"])).toThrow(/--tenant/);
  });
});

// @version v0.9.0
