/**
 * Tests — FTS5 forms under D1's defensive mode
 *
 * This suite records which full-text index forms the D1 engine accepts
 * for the OCR page table. The record index uses a regular FTS5 table,
 * which stores every word of the text a second time; an external-content
 * table stores only the index and reads text from its source table, but
 * its documented sync idiom was rejected inside triggers on regular
 * tables. Each case below runs one form end to end — insert, update,
 * delete, then a MATCH and a snippet — so the choice of form rests on
 * what the engine does rather than on what the SQLite documentation
 * allows.
 *
 * The page index is built in form (b), external-content with
 * 'delete'-command triggers. The same statements were run against the
 * remote staging database, where they passed and FTS5's integrity check
 * found the index consistent. Cases (a) and (b) therefore assert the
 * exact outcome, so a change in the engine fails here before it fails in
 * search. Case (c) is recorded only, since nothing uses it.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

const SRC = `CREATE TABLE probe_src (id TEXT PRIMARY KEY NOT NULL, text TEXT NOT NULL)`;

async function reset() {
  for (const s of [
    "DROP TRIGGER IF EXISTS probe_ai", "DROP TRIGGER IF EXISTS probe_ad",
    "DROP TRIGGER IF EXISTS probe_au", "DROP TABLE IF EXISTS probe_fts",
    "DROP TABLE IF EXISTS probe_src",
  ]) await env.DB.prepare(s).run();
  await env.DB.prepare(SRC).run();
}

async function exercise(viaTriggers: boolean, external: boolean) {
  const db = env.DB;
  await db.prepare("INSERT INTO probe_src (id, text) VALUES ('a', 'cabildo de lima')").run();
  const rowid = (await db.prepare("SELECT rowid AS r FROM probe_src WHERE id = 'a'").first<{ r: number }>())!.r;
  if (!viaTriggers) {
    await db.prepare("INSERT INTO probe_fts(rowid, text) VALUES (?, 'cabildo de lima')").bind(rowid).run();
  }
  await db.prepare("UPDATE probe_src SET text = 'cabildo de quito' WHERE id = 'a'").run();
  if (!viaTriggers) {
    await db.prepare("INSERT INTO probe_fts(probe_fts, rowid, text) VALUES ('delete', ?, 'cabildo de lima')").bind(rowid).run();
    await db.prepare("INSERT INTO probe_fts(rowid, text) VALUES (?, 'cabildo de quito')").bind(rowid).run();
  }
  const lima = await db.prepare("SELECT count(*) AS n FROM probe_fts WHERE probe_fts MATCH 'lima'").first<{ n: number }>();
  const quito = await db.prepare(
    "SELECT snippet(probe_fts, 0, '[', ']', '…', 8) AS s FROM probe_fts WHERE probe_fts MATCH 'quito'",
  ).first<{ s: string | null }>();
  await db.prepare("DELETE FROM probe_src WHERE id = 'a'").run();
  if (!viaTriggers) {
    await db.prepare("INSERT INTO probe_fts(probe_fts, rowid, text) VALUES ('delete', ?, 'cabildo de quito')").bind(rowid).run();
  }
  const after = await db.prepare("SELECT count(*) AS n FROM probe_fts WHERE probe_fts MATCH 'quito'").first<{ n: number }>();
  return { lima: lima!.n, snippet: quito?.s ?? null, afterDelete: after!.n, external };
}

describe("FTS5 forms under D1", () => {
  beforeEach(reset);

  it("(a) regular FTS5 with direct-delete triggers works (the 0075 shape)", async () => {
    await env.DB.prepare("CREATE VIRTUAL TABLE probe_fts USING fts5(text, tokenize='unicode61')").run();
    await env.DB.prepare("CREATE TRIGGER probe_ai AFTER INSERT ON probe_src BEGIN INSERT INTO probe_fts(rowid, text) VALUES (new.rowid, new.text); END").run();
    await env.DB.prepare("CREATE TRIGGER probe_ad AFTER DELETE ON probe_src BEGIN DELETE FROM probe_fts WHERE rowid = old.rowid; END").run();
    await env.DB.prepare("CREATE TRIGGER probe_au AFTER UPDATE ON probe_src BEGIN DELETE FROM probe_fts WHERE rowid = old.rowid; INSERT INTO probe_fts(rowid, text) VALUES (new.rowid, new.text); END").run();
    const r = await exercise(true, false);
    expect(r).toEqual({ lima: 0, snippet: "cabildo de [quito]", afterDelete: 0, external: false });
  });

  it("(b) external-content FTS5 with 'delete'-command triggers works (the page index shape)", async () => {
    await env.DB.prepare("CREATE VIRTUAL TABLE probe_fts USING fts5(text, content='probe_src', content_rowid='rowid', tokenize='unicode61')").run();
    await env.DB.prepare("CREATE TRIGGER probe_ai AFTER INSERT ON probe_src BEGIN INSERT INTO probe_fts(rowid, text) VALUES (new.rowid, new.text); END").run();
    await env.DB.prepare("CREATE TRIGGER probe_ad AFTER DELETE ON probe_src BEGIN INSERT INTO probe_fts(probe_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END").run();
    await env.DB.prepare("CREATE TRIGGER probe_au AFTER UPDATE ON probe_src BEGIN INSERT INTO probe_fts(probe_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO probe_fts(rowid, text) VALUES (new.rowid, new.text); END").run();
    const r = await exercise(true, true);
    expect(r).toEqual({ lima: 0, snippet: "cabildo de [quito]", afterDelete: 0, external: true });
  });

  it("(c) external-content FTS5 synced by plain statements, no triggers", async () => {
    await env.DB.prepare("CREATE VIRTUAL TABLE probe_fts USING fts5(text, content='probe_src', content_rowid='rowid', tokenize='unicode61')").run();
    let outcome: unknown;
    try { outcome = await exercise(false, true); } catch (e) { outcome = { error: String(e) }; }
    console.log("PROBE (c)", JSON.stringify(outcome));
    expect(outcome).toBeDefined();
  });
});
