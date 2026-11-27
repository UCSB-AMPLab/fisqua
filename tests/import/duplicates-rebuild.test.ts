/**
 * Tests — the duplicates rebuild command
 *
 * This suite pins the duplicates rebuild command. `duplicates rebuild`
 * marks every live entity record in `duplicate_recheck`, in batches by id,
 * so that the five-minute job refills the candidate table. The suite runs
 * its statements against an in-memory SQLite database through the injected
 * exec, so no wrangler process starts and nothing waits. It checks the
 * statements and the cursor each batch sends, that merged records are
 * skipped, that a batch of records already marked does not end the
 * rebuild, and that production is refused without `--confirm-production`.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseDuplicatesArgs, runDuplicatesRebuild } from "../../scripts/lib/duplicates-cli/run";
import type { D1Exec } from "../../scripts/lib/d1-cli";

function database(ids: Array<[string, string | null]>) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, merged_into TEXT);
    CREATE TABLE duplicate_recheck (seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
      description_id TEXT NOT NULL DEFAULT '', marked_at INTEGER NOT NULL, UNIQUE (entity_id, description_id));`);
  for (const [id, merged] of ids) db.prepare("INSERT INTO entities (id, merged_into) VALUES (?, ?)").run(id, merged);
  const commands: string[] = [];
  const argvs: string[][] = [];
  const exec: D1Exec = (_command, args) => {
    argvs.push(args);
    const sql = args[args.indexOf("--command") + 1];
    commands.push(sql);
    if (/^\s*SELECT/i.test(sql)) return JSON.stringify([{ results: db.prepare(sql).all(), success: true }]);
    const info = db.prepare(sql).run();
    return JSON.stringify([{ results: [], success: true, meta: { changes: Number(info.changes) } }]);
  };
  return { db, exec, commands, argvs };
}

const READ = "SELECT max(id) AS last FROM (SELECT id FROM entities WHERE merged_into IS NULL AND id > '%C' ORDER BY id LIMIT %N)";
const WRITE = "INSERT OR IGNORE INTO duplicate_recheck (entity_id, description_id, marked_at) SELECT id, '', %T FROM entities WHERE merged_into IS NULL AND id > '%C' AND id <= '%L'";
const read = (c: string, n: number) => READ.replace("%C", c).replace("%N", String(n));
const write = (t: number, c: string, l: string) => WRITE.replace("%T", String(t)).replace("%C", c).replace("%L", l);

const options = (exec: D1Exec, waits: number[], lines: string[] = []) => ({
  target: "staging" as const,
  confirmProduction: false,
  batch: 2,
  exec,
  wait: (ms: number) => void waits.push(ms),
  now: () => 1_700_000_000_000,
  log: (l: string) => void lines.push(l),
});

describe("duplicates rebuild", () => {
  it("marks in id order in batches until none is left", async () => {
    const t = database([["a", null], ["b", null], ["c", null], ["d", null], ["e", null]]);
    const waits: number[] = [];
    const lines: string[] = [];
    const result = await runDuplicatesRebuild(options(t.exec, waits, lines));
    expect(t.commands).toEqual([
      read("", 2), write(1_700_000_000_000, "", "b"),
      read("b", 2), write(1_700_000_000_000, "b", "d"),
      read("d", 2), write(1_700_000_000_000, "d", "e"),
      read("e", 2),
    ]);
    expect(result).toEqual({ batches: 3, marked: 5 });
    expect(t.db.prepare("SELECT entity_id FROM duplicate_recheck ORDER BY seq").all().map((r) => r.entity_id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(waits).toEqual([2000, 2000]);
    expect(lines.join("\n")).toMatch(/3 batches/);
    expect(lines.join("\n")).toMatch(/5 records marked/);
  });

  it("skips merged records", async () => {
    const t = database([["a", null], ["b", "a"], ["c", null]]);
    const result = await runDuplicatesRebuild(options(t.exec, []));
    expect(t.db.prepare("SELECT entity_id FROM duplicate_recheck ORDER BY seq").all().map((r) => r.entity_id)).toEqual(["a", "c"]);
    expect(result.marked).toBe(2);
  });

  it("does not end the rebuild when a batch holds only records already marked", async () => {
    const t = database([["a", null], ["b", null], ["c", null], ["d", null]]);
    t.db.exec("INSERT INTO duplicate_recheck (entity_id, description_id, marked_at) VALUES ('a', '', 1), ('b', '', 1)");
    const result = await runDuplicatesRebuild(options(t.exec, []));
    expect(t.db.prepare("SELECT entity_id FROM duplicate_recheck ORDER BY entity_id").all().map((r) => r.entity_id)).toEqual(["a", "b", "c", "d"]);
    expect(result).toEqual({ batches: 2, marked: 2 });
  });

  it("makes no write when no record is live", async () => {
    const t = database([["a", "b"]]);
    const result = await runDuplicatesRebuild(options(t.exec, []));
    expect(t.commands).toEqual([read("", 2)]);
    expect(result).toEqual({ batches: 0, marked: 0 });
  });

  it("sends each statement to the target's database", async () => {
    const t = database([["a", null]]);
    await runDuplicatesRebuild(options(t.exec, []));
    expect(t.argvs[0].slice(0, 6)).toEqual(["wrangler", "d1", "execute", "fisqua-staging-db", "--env", "staging"]);
  });

  it("refuses production without --confirm-production, before anything is sent", async () => {
    const t = database([["a", null]]);
    await expect(runDuplicatesRebuild({ ...options(t.exec, []), target: "production" })).rejects.toThrow(/--confirm-production/);
    expect(t.commands).toEqual([]);
  });

  it("escapes a quote in the cursor", async () => {
    const t = database([["o'a", null], ["p", null]]);
    await runDuplicatesRebuild({ ...options(t.exec, []), batch: 1 });
    expect(t.commands[2]).toContain("id > 'o''a'");
  });
});

describe("duplicates rebuild arguments", () => {
  it("reads the target, the confirmation and the batch size", () => {
    expect(parseDuplicatesArgs(["duplicates", "rebuild", "--target", "production", "--confirm-production", "--batch", "500"])).toEqual({
      target: "production",
      confirmProduction: true,
      batch: 500,
    });
    expect(parseDuplicatesArgs(["duplicates", "rebuild", "--target", "staging"]).batch).toBe(1000);
  });

  it("refuses a missing or unknown target, a bad batch, and other verbs", () => {
    expect(() => parseDuplicatesArgs(["duplicates", "rebuild"])).toThrow(/--target/);
    expect(() => parseDuplicatesArgs(["duplicates", "rebuild", "--target", "local"])).toThrow(/--target/);
    expect(() => parseDuplicatesArgs(["duplicates", "rebuild", "--target", "staging", "--batch", "0"])).toThrow(/--batch/);
    expect(() => parseDuplicatesArgs(["duplicates", "plan", "--target", "staging"])).toThrow(/rebuild/);
    expect(() => parseDuplicatesArgs(["duplicates", "rebuild", "--target", "staging", "--x"])).toThrow(/Unknown argument/);
  });
});

// @version v0.9.0
