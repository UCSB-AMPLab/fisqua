/**
 * Tests — relation sides in the command line's merges and link drops
 *
 * This suite pins two behaviours of `scripts/lib/authorities-cli/` that
 * concern links holding `related_to`. The run is driven end to end
 * against an in-memory `node:sqlite` database with the tables and
 * columns the engine reads and writes, through `runFile`, whose reads
 * go through `d1Read` and so meet D1's limit on result columns. Nothing
 * here reaches D1.
 *
 *   - a `merge-entity` row whose repoint would give one entity two links
 *     to a description in one role naming the same link is refused at
 *     plan time, naming the description, the entity and the role, and
 *     nothing is written; so is a file whose merge and move rows make
 *     such a pair together, each sound alone;
 *   - a `drop-link` row rerun after a relation side of the same record,
 *     description and role is added is still "already dropped link": the
 *     rerun compares the links found with the dropped link's key under
 *     the unique index, as the changelog's `unlink` row records it, and a
 *     document link found again in that role still refuses the row.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthoritiesReport } from "../../scripts/lib/authorities-cli/run";
import { D1_LIMITS, PLACES_DDL, runFile } from "./authorities-cli-places-helpers";

const FED = "fed-1";
const TENANT = "t-1";
const FILE = "relations-test.csv";
const NOW = 1_763_500_000_000;

const VOCABULARY: Array<[string, string, string | null]> = [
  ["entity_type", "person", null],
  ["entity_role", "witness", null],
  ["relation_role", "parent", "child"], ["relation_role", "child", "parent"],
];

const AA = { id: "e-a", code: "ne-aaaaaa", name: "Juana Díaz" };
const BB = { id: "e-b", code: "ne-bbbbbb", name: "Diego Díaz" };
const CC = { id: "e-c", code: "ne-cccccc", name: "Ana Ruiz" };
const DD = { id: "e-d", code: "ne-dddddd", name: "Pedro Ruiz" };

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(PLACES_DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina-fed', 'active', '${TENANT}', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', '${FED}', NULL, 1, 'ne', 'nl'), ('t-2', 'other', '${FED}', NULL, 1, 'ot', 'op');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.exec(`INSERT INTO descriptions VALUES ('d1', '${TENANT}', 'co-test-001-d001'), ('d2', '${TENANT}', 'co-test-001-d002'), ('d9', 't-2', 'co-other-d009');`);
  const v = db.prepare("INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at, inverse_code) VALUES (?, ?, ?, ?, 1, 1, ?)");
  VOCABULARY.forEach(([list, code, inverse], i) => v.run(`v-${i}`, FED, list, code, inverse));
  const e = db.prepare(
    "INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, 'person', 1, 5)",
  );
  for (const x of [AA, BB, CC, DD]) e.run(x.id, FED, x.code, x.name, x.name);
  return db;
}

/**
 * Inserts links in order. `related_to` is a foreign key to the table, so
 * a link naming one already in is inserted naming it, and the rest are
 * given theirs once every link is in.
 */
function links(db: DatabaseSync, rows: Array<[string, string, string, string, string | null]>) {
  const ins = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, sequence, created_at, related_to) VALUES (?, ?, ?, ?, 0, 3, ?)");
  const has = db.prepare("SELECT 1 AS found FROM description_entities WHERE id = ?");
  const later: Array<[string, string]> = [];
  for (const [id, d, entity, role, related] of rows) {
    const now = related !== null && has.get(related) !== undefined;
    ins.run(id, d, entity, role, now ? related : null);
    if (related !== null && !now) later.push([id, related]);
  }
  const rel = db.prepare("UPDATE description_entities SET related_to = ? WHERE id = ?");
  for (const [id, related] of later) rel.run(related, id);
}

const HEADER = [
  "op", "authority_code", "authority_name", "target_codes", "label_to_keep", "name_variants_add", "description_code", "role", "changelog_note",
  "facts", "evidence_codes",
];

const run = (db: DatabaseSync, rows: Array<Record<string, string>>, apply = false) =>
  runFile(db, rows, { header: HEADER, file: FILE, now: NOW, apply });

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const reasons = (r: AuthoritiesReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const snapshot = (db: DatabaseSync) =>
  JSON.stringify(["entities", "description_entities", "changelog", "authority_operations"].map((t) => all(db, `SELECT * FROM ${t} ORDER BY rowid`)));

describe("merge-entity: a repoint that would collide under the unique index", () => {
  it("is refused at plan time, naming the description, the entity and the role, with nothing written", async () => {
    const db = database();
    // Both sides of one relation are recorded twice: BB's k-1 and AA's d-1
    // are parents naming CC's child x-1, and CC holds a second child side
    // x-2 naming d-1. Merging AA into BB drops d-1 (k-1 holds its key) and
    // would repoint x-2 to k-1, giving CC two child links naming k-1.
    links(db, [
      ["k-1", "d1", BB.id, "parent", "x-1"],
      ["d-1", "d1", AA.id, "parent", "x-1"],
      ["x-1", "d1", CC.id, "child", "k-1"],
      ["x-2", "d1", CC.id, "child", "d-1"],
    ]);
    const before = snapshot(db);
    const { report, applied } = await run(db, [
      { op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, label_to_keep: BB.name, name_variants_add: AA.name,
        facts: "kin", evidence_codes: "co-test-001-d001" },
    ], true);
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toBe(
      `${FILE} line 2: the merge would leave ne-cccccc with two links to co-test-001-d001 as child that name the same link`,
    );
    expect(applied).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it("is refused when a move of another row of the file makes the collision with the merge's repoint", async () => {
    const db = database();
    // BB's k-1 and AA's d-1 are parents naming x-1; CC's child x-1 names
    // d-1 and DD's child q-1 names k-1. The merge drops d-1 and repoints
    // x-1 to k-1; the move gives q-1 to CC. Each row alone is sound; the
    // two together would give CC two child links naming k-1.
    links(db, [
      ["k-1", "d1", BB.id, "parent", "x-1"],
      ["d-1", "d1", AA.id, "parent", "x-1"],
      ["x-1", "d1", CC.id, "child", "d-1"],
      ["q-1", "d1", DD.id, "child", "k-1"],
    ]);
    const before = snapshot(db);
    const { report, applied } = await run(db, [
      { op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, label_to_keep: BB.name, name_variants_add: AA.name,
        facts: "kin", evidence_codes: "co-test-001-d001" },
      { op: "move-link", authority_code: DD.code, authority_name: DD.name, description_code: "co-test-001-d001", role: "child", target_codes: CC.code },
    ], true);
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toBe(
      `${FILE} line 3: this row and line 2 together would leave ne-cccccc with two links to co-test-001-d001 as child that name the same link`,
    );
    expect(applied).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it("still merges when the repoint collides with nothing", async () => {
    const db = database();
    // As above, without the second child side: d-1 is dropped and nothing names it.
    links(db, [
      ["k-1", "d1", BB.id, "parent", "x-1"],
      ["d-1", "d1", AA.id, "parent", "x-1"],
      ["x-1", "d1", CC.id, "child", "k-1"],
    ]);
    const { report } = await run(db, [
      { op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, label_to_keep: BB.name, name_variants_add: AA.name,
        facts: "kin", evidence_codes: "co-test-001-d001" },
    ], true);
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    expect(all(db, "SELECT id FROM description_entities WHERE id = 'd-1'")).toEqual([]);
  });
});

describe("merge-entity: a link on another tenant's description naming a loser's link", () => {
  it("is refused, naming only the local link, with no identifier of the other tenant's in the report or the files", async () => {
    const db = database();
    // f-1 is on d9, another tenant's description, and names AA's a-1 on d1: stale data.
    links(db, [["a-1", "d1", AA.id, "witness", null], ["f-1", "d9", CC.id, "child", "a-1"], ["b-2", "d2", BB.id, "witness", null]]);
    db.exec("UPDATE description_entities SET name_as_recorded = 'Secreto Privado' WHERE id = 'f-1'");
    const before = snapshot(db);
    const merge = {
      op: "merge-entity", authority_code: AA.code, authority_name: AA.name, target_codes: BB.code, label_to_keep: BB.name, name_variants_add: AA.name,
      facts: "dates", evidence_codes: "co-test-001-d001 co-test-001-d002",
    };
    const dry = await run(db, [merge]);
    expect(reasons(dry.report)).toBe(
      `${FILE} line 2: link a-1 of ne-aaaaaa is named by a link outside its description, which is stale data: the merge is refused`,
    );
    const foreign = /\bf-1\b|['"]d9['"]|co-other-d009|Secreto/;
    expect(JSON.stringify(dry.report)).not.toMatch(foreign);
    for (const text of dry.written.values()) expect(text).not.toMatch(foreign);
    const applied = await run(db, [merge], true);
    expect(applied.applied).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });
});

describe("drop-link rerun", () => {
  const drop = { op: "drop-link", authority_code: AA.code, authority_name: AA.name, description_code: "co-test-001-d001", role: "parent" };

  /** AA's document link in d1 as parent, dropped by the file. */
  function applied(): DatabaseSync {
    const db = database();
    links(db, [["doc-1", "d1", AA.id, "parent", null]]);
    return db;
  }

  it("is already dropped when the record has since become a relation side in the same role", async () => {
    const db = applied();
    const first = await run(db, [drop], true);
    expect(reasons(first.report)).toBe("");
    expect(first.report.outcome).toBe("verified");
    // Later, a relation is recorded: AA is a parent of CC in d1.
    links(db, [["rel-a", "d1", AA.id, "parent", "rel-c"], ["rel-c", "d1", CC.id, "child", "rel-a"]]);
    const again = await run(db, [drop], true);
    expect(reasons(again.report)).toBe("");
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.report.rows.map((r) => r.status)).toEqual(["already dropped link"]);
    expect(again.applied).toEqual([]);
  });

  it("still refuses the row when the record holds a document link in that role again", async () => {
    const db = applied();
    await run(db, [drop], true);
    links(db, [["doc-2", "d1", AA.id, "parent", null]]);
    const again = await run(db, [drop]);
    expect(reasons(again.report)).toMatch(/line 2: the changelog of this file records the removal of link doc-1, and ne-aaaaaa holds a link to co-test-001-d001 as parent again/);
  });
});

// @version v0.9.0
