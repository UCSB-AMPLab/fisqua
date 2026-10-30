/**
 * Tests — migration 0105 and the carry-gate-passes command
 *
 * This suite builds an in-memory SQLite from every file in `drizzle/`
 * up to 0104, with foreign keys on, puts gate passes on v1.0.0 and on
 * v1.1.0 beside them, applies 0105 and pins:
 *
 *   - every existing pass is kept with every column, and gains `note`
 *     and `carried_from`, null;
 *   - each v1.0.0 pass whose declaration has no v1.1.0 pass is copied to
 *     v1.1.0 with a new id, the same tenant, declaration, sample run,
 *     `passed_by` and `passed_at`, the approved note, and `carried_from`
 *     the original's id; a declaration that already has a v1.1.0 pass
 *     keeps it;
 *   - the shared statement (`CARRY_GATE_PASSES_SQL`) copies nothing more
 *     when run again, and copies a v1.0.0 pass recorded after the
 *     migration;
 *   - the command counts on a dry run and writes nothing, copies on
 *     `--apply`, copies nothing on a second run, and needs
 *     `--confirm-production` to apply to production.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CARRY_GATE_PASSES_SQL, GATE_PASS_CARRY_NOTE } from "../../scripts/lib/gate-pass-carry";
import { parseArgs, runCarryGatePasses } from "../../scripts/commands/carry-gate-passes";

const DRIZZLE = fileURLToPath(new URL("../../drizzle/", import.meta.url));
const TENANT = "tenant-1";

function apply(db: DatabaseSync, name: string): void {
  for (const statement of readFileSync(`${DRIZZLE}${name}`, "utf8").split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function chainUpTo(last: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(DRIZZLE).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    if (file.slice(0, 4) > last) break;
    apply(db, file);
  }
  return db;
}

type Row = Record<string, unknown>;

function insert(db: DatabaseSync, table: string, row: Row): void {
  const full: Row = { ...row };
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, any>>;
  for (const c of columns) {
    if (c.name in full || !c.notnull || c.dflt_value !== null || c.pk) continue;
    full[c.name] = /INT|REAL/i.test(c.type) ? 1 : `${c.name}-x`;
  }
  const names = Object.keys(full);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
    ...(names.map((n) => full[n]) as any[]),
  );
}

function declaration(db: DatabaseSync, id: string, version: number): void {
  insert(db, "pipeline_recipe_declarations", {
    id, tenant_id: TENANT, scope_description_id: "desc-1", version, platen: "v", background: "dark",
    output_class: "tonal", tone_preset: "default", created_by: "user-1", created_at: 1,
  });
}

function pass(db: DatabaseSync, id: string, declarationId: string, scriptVersion: string, passedAt: number): void {
  insert(db, "pipeline_gate_passes", {
    id, tenant_id: TENANT, declaration_id: declarationId, script_version: scriptVersion,
    sample_run_id: `run-${id}`, passed_by: "user-1", passed_at: passedAt,
  });
}

function seeded(): DatabaseSync {
  const db = chainUpTo("0104");
  insert(db, "tenants", { id: TENANT, slug: "test-tenant", name: "Test", kind: "tenant", descriptive_standard: "isadg" });
  insert(db, "users", { id: "user-1", email: "user@example.test", tenant_id: TENANT });
  insert(db, "users", { id: "user-2", email: "other@example.test", tenant_id: TENANT });
  insert(db, "repositories", { id: "repo-1", tenant_id: TENANT, code: "repo-1" });
  insert(db, "descriptions", {
    id: "desc-1", tenant_id: TENANT, repository_id: "repo-1", description_level: "fonds",
    reference_code: "co-1", title: "Fonds", created_at: 1, updated_at: 1,
  });
  for (const [id, v] of [["decl-1", 1], ["decl-2", 2], ["decl-3", 3], ["decl-4", 4]] as const) declaration(db, id, v);
  pass(db, "pass-1", "decl-1", "v1.0.0", 100);
  pass(db, "pass-2", "decl-2", "v1.0.0", 200);
  // decl-2 already has its own v1.1.0 pass, by someone else.
  insert(db, "pipeline_gate_passes", {
    id: "pass-3", tenant_id: TENANT, declaration_id: "decl-2", script_version: "v1.1.0",
    sample_run_id: "run-own", passed_by: "user-2", passed_at: 300,
  });
  pass(db, "pass-4", "decl-3", "v0.9.0", 50);
  return db;
}

const rows = (db: DatabaseSync, where = "1") =>
  db.prepare(`SELECT * FROM pipeline_gate_passes WHERE ${where} ORDER BY declaration_id, script_version`).all() as Row[];

describe("migration 0105", () => {
  it("keeps every pass and carries each v1.0.0 pass without a v1.1.0 one forward", () => {
    const db = seeded();
    const before = rows(db);
    apply(db, "0105_gate_pass_carry_forward.sql");

    for (const r of before) {
      expect(rows(db, `id = '${r.id}'`)).toEqual([{ ...r, note: null, carried_from: null }]);
    }
    const carried = rows(db, "carried_from IS NOT NULL");
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      tenant_id: TENANT,
      declaration_id: "decl-1",
      script_version: "v1.1.0",
      sample_run_id: "run-pass-1",
      passed_by: "user-1",
      passed_at: 100,
      note: GATE_PASS_CARRY_NOTE,
      carried_from: "pass-1",
    });
    expect(carried[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // decl-2 keeps its own v1.1.0 pass; v0.9.0 is not carried.
    expect(rows(db, "declaration_id = 'decl-2' AND script_version = 'v1.1.0'")).toEqual([
      expect.objectContaining({ id: "pass-3", passed_by: "user-2", carried_from: null }),
    ]);
    expect(rows(db, "declaration_id = 'decl-3'")).toHaveLength(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("copies nothing more when run again, and copies a v1.0.0 pass recorded later", () => {
    const db = seeded();
    apply(db, "0105_gate_pass_carry_forward.sql");
    const after = rows(db);
    db.exec(CARRY_GATE_PASSES_SQL);
    db.exec(CARRY_GATE_PASSES_SQL);
    expect(rows(db)).toEqual(after);

    pass(db, "pass-5", "decl-4", "v1.0.0", 500);
    db.exec(CARRY_GATE_PASSES_SQL);
    expect(rows(db, "declaration_id = 'decl-4' AND script_version = 'v1.1.0'")).toEqual([
      expect.objectContaining({ passed_at: 500, carried_from: "pass-5", note: GATE_PASS_CARRY_NOTE }),
    ]);
  });
});

describe("the carry-gate-passes command", () => {
  const query = (db: DatabaseSync) => (sql: string) => {
    const statement = db.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return statement.all() as Row[];
    statement.run();
    return [];
  };

  it("counts on a dry run, copies on --apply, and copies nothing a second time", async () => {
    const db = seeded();
    apply(db, "0105_gate_pass_carry_forward.sql");
    pass(db, "pass-5", "decl-4", "v1.0.0", 500);
    const lines: string[] = [];
    const before = rows(db);

    expect(await runCarryGatePasses({ target: "staging", apply: false }, query(db), (l) => lines.push(l))).toEqual({
      pending: 1,
      carried: 0,
    });
    expect(rows(db)).toEqual(before);
    expect(await runCarryGatePasses({ target: "staging", apply: true }, query(db), (l) => lines.push(l))).toEqual({
      pending: 1,
      carried: 1,
    });
    expect(await runCarryGatePasses({ target: "staging", apply: true }, query(db), (l) => lines.push(l))).toEqual({
      pending: 0,
      carried: 0,
    });
    expect(rows(db, "carried_from = 'pass-5'")).toHaveLength(1);
  });

  it("needs a target, and --confirm-production to apply to production", () => {
    expect(() => parseArgs([])).toThrow(/--target/);
    expect(() => parseArgs(["--target", "production", "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs(["--target", "production", "--apply", "--confirm-production"])).toEqual({
      target: "production",
      apply: true,
    });
    expect(parseArgs(["--target", "staging"])).toEqual({ target: "staging", apply: false });
  });
});

// @version v0.8.0
