/**
 * Tests — seeding a federation's relation vocabulary
 *
 * This suite pins `scripts/lib/vocabulary-seed.ts`, behind
 * `scripts/commands/seed-federation-vocabulary.ts`: the command that
 * seeds one federation's relation roles, link attributes, genders and
 * the role groups they add from a data file
 * (`scripts/data/vocabularies/neogranadina-relations.ts`). The D1 is a
 * `node:sqlite` twin of `vocabulary_values` as migration 0125 leaves it,
 * with D1's expression depth limit of 100; the providers read it, keep
 * files in a map and apply the SQL file as one unit, as
 * `wrangler d1 execute --file` does.
 *
 *   - a plan on a federation that holds only its seven role groups lists
 *     33 relation codes, 9 attributes, 2 genders and 4 groups to insert,
 *     writes the report and the SQL file, and writes nothing to D1;
 *   - the new groups follow the held ones in `position`, and the held
 *     groups are not touched;
 *   - `label_es` and `label_en` of a relation hold its unrecorded form;
 *   - apply writes the rows, reads them back and plans again; a second
 *     run has nothing to write;
 *   - a held row with the same code and other values refuses the run;
 *   - a held row changed between the read and the apply fails the file;
 *   - the data file is checked before any read: a dangling inverse, an
 *     unknown group, a missing form or connector, or an attribute hidden
 *     by an unknown group stops the run;
 *   - an apply to production without `--confirm-production` stops before
 *     anything is read;
 *   - the reader passes only SELECTs, and a plan reads in three;
 *   - the labels in the SQL are the data file's, byte for byte.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  VocabularyStop,
  parseSeedArgs,
  runVocabularySeed,
  validateSet,
  type SeedOptions,
  type SeedReport,
} from "../../scripts/lib/vocabulary-seed";
import { NEOGRANADINA_RELATIONS, type RelationVocabularySet } from "../../scripts/data/vocabularies/neogranadina-relations";
import type { RunProviders } from "../../scripts/lib/cli/run-file";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
const NOW = 1_800_000_000_000;

const DDL = `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
CREATE TABLE vocabulary_values (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id),
  list TEXT NOT NULL
    CHECK (list IN ('entity_type','place_type','entity_role','place_role','role_group','relation_role','link_attribute','gender')),
  code TEXT NOT NULL, label_es TEXT, label_en TEXT, group_code TEXT, position INTEGER NOT NULL DEFAULT 0,
  external_scheme TEXT, external_uri TEXT, external_label TEXT,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','proposed','deprecated')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  connector_es TEXT, connector_en TEXT, inverse_code TEXT, hide_when_group TEXT,
  label_es_female TEXT, label_es_male TEXT, label_es_unrecorded TEXT, label_es_alone TEXT,
  label_en_female TEXT, label_en_male TEXT, label_en_unrecorded TEXT, label_en_alone TEXT
);
CREATE UNIQUE INDEX vocabulary_values_federation_list_code_idx ON vocabulary_values (federation_id, list, code);
CREATE INDEX vocabulary_values_position_idx ON vocabulary_values (federation_id, list, position);
INSERT INTO federations VALUES ('fed-n', 'neogranadina'), ('fed-a', 'ampl');
`;

const SEVEN = ["production", "correspondence", "notarial", "legal", "family", "transactions", "visual"];

function twin(groups = SEVEN): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  const insert = db.prepare(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) VALUES (?, ?, 'role_group', ?, ?, ?, ?, 1, 1)",
  );
  groups.forEach((g, i) => insert.run(`g-${g}`, "fed-n", g, `es ${g}`, `en ${g}`, i + 1));
  // Another federation's rows are never read or written.
  insert.run("g-other", "fed-a", "legal", "x", "x", 1);
  db.prepare(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) VALUES ('e-1', 'fed-n', 'entity_role', 'spouse', 'cónyuge', 'spouse', 3, 1, 1)",
  ).run();
  return db;
}

interface Run {
  files: Map<string, string>;
  reads: string[];
  applied: string[][];
}

function providers(db: DatabaseSync, run: Run, opts: { before?: () => void } = {}): RunProviders {
  let n = 0;
  return {
    rows: async (sql) => {
      run.reads.push(sql);
      return db.prepare(sql).all() as Record<string, unknown>[];
    },
    writeFile: (p, text) => run.files.set(p, text),
    createFile: (p, text) => {
      if (run.files.has(p)) throw new Error(`${p} exists`);
      run.files.set(p, text);
    },
    readFile: (p) => run.files.get(p) ?? "",
    newId: () => `0000000${(++n).toString(16)}-id`.slice(-12),
    applyFile: async (_p, statements) => {
      opts.before?.();
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

const newRun = (): Run => ({ files: new Map(), reads: [], applied: [] });

async function seed(
  db: DatabaseSync,
  over: Partial<SeedOptions> = {},
  opts: { run?: Run; before?: () => void; sets?: Record<string, RelationVocabularySet> } = {},
): Promise<{ report: SeedReport; run: Run }> {
  const run = opts.run ?? newRun();
  const options: SeedOptions = {
    target: "staging",
    federation: "neogranadina",
    set: "neogranadina-relations",
    apply: false,
    confirmProduction: false,
    ...over,
  };
  const report = await runVocabularySeed(options, providers(db, run, { before: opts.before }), () => {}, opts.sets);
  return { report, run };
}

const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const sqlOf = (run: Run) => [...run.files.entries()].find(([p]) => p.endsWith(".sql"))?.[1] ?? "";
const clone = (): RelationVocabularySet => JSON.parse(JSON.stringify(NEOGRANADINA_RELATIONS));

describe("seed-federation-vocabulary: the plan", () => {
  it("lists 33 relation codes, 9 attributes, 2 genders and 4 groups on a federation without them, and writes nothing", async () => {
    const db = twin();
    const before = count(db, "SELECT count(*) AS n FROM vocabulary_values");
    const { report, run } = await seed(db);
    expect(report.outcome).toBe("dry run");
    expect(report.totals.relation_role).toEqual({ insert: 33, unchanged: 0, conflict: 0 });
    expect(report.totals.link_attribute).toEqual({ insert: 9, unchanged: 0, conflict: 0 });
    expect(report.totals.gender).toEqual({ insert: 2, unchanged: 0, conflict: 0 });
    expect(report.totals.role_group).toEqual({ insert: 4, unchanged: 0, conflict: 0 });
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(before);
    expect(run.applied).toHaveLength(0);
    const names = [...run.files.keys()];
    expect(names.some((p) => /^\.import\/vocabulary_neogranadina_staging_.*\.json$/.test(p))).toBe(true);
    expect(names.some((p) => p.endsWith(".md"))).toBe(true);
    expect(names.some((p) => p.endsWith(".sql"))).toBe(true);
  });

  it("reads only SELECTs, three of them, each scoped to the federation where it reads vocabulary values", async () => {
    const { run } = await seed(twin());
    expect(run.reads).toHaveLength(3);
    for (const sql of run.reads) expect(sql.trim()).toMatch(/^SELECT\b/i);
    const values = run.reads.filter((s) => /FROM vocabulary_values/.test(s));
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/federation_id = 'fed-n'/);
  });

  it("refuses a federation the target does not hold", async () => {
    await expect(seed(twin(), { federation: "nowhere" })).rejects.toThrow(VocabularyStop);
  });

  it("refuses a federation without the existing group the set names", async () => {
    const { report, run } = await seed(twin(SEVEN.filter((g) => g !== "legal")));
    expect(report.outcome).toBe("refused");
    expect(report.refusals.join(" ")).toMatch(/legal/);
    expect([...run.files.keys()].some((p) => p.endsWith(".sql"))).toBe(false);
  });
});

describe("seed-federation-vocabulary: apply", () => {
  it("writes the rows, reads them back, and a second run writes nothing", async () => {
    const db = twin();
    const { report } = await seed(db, { apply: true });
    expect(report.outcome).toBe("verified");
    expect(report.applied).toBe(true);
    const n = (list: string) => count(db, `SELECT count(*) AS n FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = '${list}'`);
    expect(n("relation_role")).toBe(33);
    expect(n("link_attribute")).toBe(9);
    expect(n("gender")).toBe(2);
    expect(n("role_group")).toBe(11);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values WHERE federation_id = 'fed-a'")).toBe(1);

    const again = await seed(db, { apply: true });
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.run.applied).toHaveLength(0);
    expect(again.report.totals.relation_role).toEqual({ insert: 0, unchanged: 33, conflict: 0 });
    expect(again.report.totals.role_group).toEqual({ insert: 0, unchanged: 4, conflict: 0 });
  });

  it("puts the new groups after the held ones in position and leaves the held ones as they were", async () => {
    const db = twin();
    const held = db.prepare("SELECT * FROM vocabulary_values WHERE list = 'role_group' ORDER BY id").all();
    await seed(db, { apply: true });
    const groups = db
      .prepare("SELECT code, position FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'role_group' ORDER BY position")
      .all() as Array<{ code: string; position: number }>;
    expect(groups.map((g) => g.code)).toEqual([...SEVEN, "kinship", "executorship_guardianship", "enslavement", "enslaved_ties"]);
    expect(groups.map((g) => g.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const stillHeld = db.prepare(`SELECT * FROM vocabulary_values WHERE id IN (${held.map((h: any) => `'${h.id}'`).join(", ")}) ORDER BY id`).all();
    expect(stillHeld).toEqual(held);
  });

  it("stores the four forms, the connectors, the inverse and the group, and the unrecorded form as label_es and label_en", async () => {
    const db = twin();
    await seed(db, { apply: true });
    const ward = db.prepare("SELECT * FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'relation_role' AND code = 'ward'").get() as Record<string, unknown>;
    expect(ward).toMatchObject({
      label_es: "menor",
      label_en: "ward",
      group_code: "executorship_guardianship",
      inverse_code: "tutor",
      connector_es: "de",
      connector_en: "of",
      label_es_female: "menor",
      label_es_male: "menor",
      label_es_unrecorded: "menor",
      label_es_alone: "menor bajo tutela o curaduría",
      label_en_alone: "minor under guardianship",
      hide_when_group: null,
      status: "approved",
    });
    const parent = db.prepare("SELECT * FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'relation_role' AND code = 'parent'").get() as Record<string, unknown>;
    expect(parent).toMatchObject({ label_es: "madre o padre", label_en: "parent", label_es_alone: null, label_en_alone: null });
    const condition = db.prepare("SELECT * FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'link_attribute' AND code = 'condition'").get() as Record<string, unknown>;
    expect(condition).toMatchObject({ label_es: "Condición", label_en: "Condition", hide_when_group: "enslavement", position: 3 });
    const female = db.prepare("SELECT * FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'gender' AND code = 'female'").get() as Record<string, unknown>;
    expect(female).toMatchObject({ label_es: "Mujer", label_en: "Woman", position: 1 });
  });

  it("fails the whole file when a held row changes between the read and the apply", async () => {
    const db = twin();
    const before = count(db, "SELECT count(*) AS n FROM vocabulary_values");
    await expect(
      seed(db, { apply: true }, { before: () => db.exec("UPDATE vocabulary_values SET label_es = 'otro' WHERE id = 'g-legal'") }),
    ).rejects.toThrow(/ABORT|malformed JSON/);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(before);
  });

  it("fails the whole file when a row of the set is added between the read and the apply", async () => {
    const db = twin();
    const add =
      "INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at) VALUES ('z', 'fed-n', 'gender', 'other', 1, 1)";
    await expect(seed(db, { apply: true }, { before: () => db.exec(add) })).rejects.toThrow(/ABORT|malformed JSON/);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values WHERE list = 'relation_role'")).toBe(0);
  });
});

describe("seed-federation-vocabulary: conflicts", () => {
  it("refuses a held row with the same code and other values, and writes nothing", async () => {
    const db = twin();
    db.exec(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) " +
        "VALUES ('r-1', 'fed-n', 'relation_role', 'parent', 'progenitor', 'parent', 1, 1, 1)",
    );
    const before = count(db, "SELECT count(*) AS n FROM vocabulary_values");
    const { report, run } = await seed(db, { apply: true });
    expect(report.outcome).toBe("refused");
    expect(report.totals.relation_role.conflict).toBe(1);
    expect(report.conflicts[0]).toMatchObject({ list: "relation_role", code: "parent" });
    expect(report.conflicts[0].differences.label_es).toEqual({ held: "progenitor", file: "madre o padre" });
    expect(run.applied).toHaveLength(0);
    expect([...run.files.keys()].some((p) => p.endsWith(".sql"))).toBe(false);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(before);
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values WHERE code = 'parent' AND label_es = 'progenitor'")).toBe(1);
  });

  it("refuses a held new group with other labels", async () => {
    const db = twin([...SEVEN, "kinship"]);
    const { report } = await seed(db);
    expect(report.outcome).toBe("refused");
    expect(report.conflicts.map((c) => `${c.list}:${c.code}`)).toEqual(["role_group:kinship"]);
  });
});

describe("seed-federation-vocabulary: the data file", () => {
  it("accepts Neogranadina's set", () => {
    expect(() => validateSet(NEOGRANADINA_RELATIONS)).not.toThrow();
  });

  it("refuses a dangling inverse before anything is read", async () => {
    const set = clone();
    set.relations.find((r) => r.code === "parent")!.inverse = "progeny";
    const run = newRun();
    await expect(seed(twin(), {}, { run, sets: { "neogranadina-relations": set } })).rejects.toThrow(/parent.*progeny/);
    expect(run.reads).toHaveLength(0);
  });

  it("refuses an unknown group, a missing form, a missing connector and an attribute hidden by an unknown group", () => {
    const unknownGroup = clone();
    unknownGroup.relations[0].group = "lineage";
    expect(() => validateSet(unknownGroup)).toThrow(/lineage/);
    const missingForm = clone();
    missingForm.relations[0].en.male = "";
    expect(() => validateSet(missingForm)).toThrow(/parent/);
    const missingConnector = clone();
    missingConnector.relations[1].es.connector = " ";
    expect(() => validateSet(missingConnector)).toThrow(/child/);
    const hidden = clone();
    hidden.attributes[2].hideWhenGroup = "slavery";
    expect(() => validateSet(hidden)).toThrow(/slavery/);
    const duplicate = clone();
    duplicate.genders.push({ code: "female", es: "Mujer", en: "Woman" });
    expect(() => validateSet(duplicate)).toThrow(/female/);
  });

  it("refuses a set it does not know", async () => {
    await expect(seed(twin(), { set: "nothing" })).rejects.toThrow(VocabularyStop);
  });
});

describe("seed-federation-vocabulary: production and the arguments", () => {
  it("refuses an apply to production without --confirm-production before anything is read", async () => {
    const run = newRun();
    await expect(seed(twin(), { target: "production", apply: true }, { run })).rejects.toThrow(/--confirm-production/);
    expect(run.reads).toHaveLength(0);
  });

  it("parses the arguments", () => {
    expect(parseSeedArgs(["--target", "staging", "--federation", "neogranadina", "--set", "neogranadina-relations"])).toEqual({
      target: "staging", federation: "neogranadina", set: "neogranadina-relations", apply: false, confirmProduction: false,
    });
    expect(parseSeedArgs(["--target", "production", "--federation", "n", "--set", "s", "--apply", "--confirm-production"])).toMatchObject({
      apply: true, confirmProduction: true,
    });
    expect(() => parseSeedArgs(["--target", "local", "--federation", "n", "--set", "s"])).toThrow(/--target/);
    expect(() => parseSeedArgs(["--target", "staging", "--set", "s"])).toThrow(/--federation/);
    expect(() => parseSeedArgs(["--target", "staging", "--federation", "n"])).toThrow(/--set/);
  });
});

describe("seed-federation-vocabulary: the SQL file", () => {
  it("carries the data file's labels byte for byte", async () => {
    const { run } = await seed(twin());
    const sql = sqlOf(run);
    for (const label of ["'persona esclavizada'", "'menor bajo tutela o curaduría'", "'who appointed'", "'que'", "'Albaceazgo, tutela y curaduría'"]) {
      expect(sql).toContain(label);
    }
    const quoted = (s: string) => `'${s.replace(/'/g, "''")}'`;
    for (const r of NEOGRANADINA_RELATIONS.relations) {
      for (const lang of [r.es, r.en]) {
        for (const v of [lang.female, lang.male, lang.unrecorded, lang.connector, lang.alone].filter((x): x is string => !!x)) {
          expect(sql).toContain(quoted(v));
        }
      }
    }
  });
});

// @version v0.9.0
