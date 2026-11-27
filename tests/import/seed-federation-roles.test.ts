/**
 * Tests — seeding a federation's document and place roles
 *
 * This suite pins the role sets of `scripts/lib/vocabulary-seed.ts`,
 * behind `scripts/commands/seed-federation-vocabulary.ts`: the
 * Neogranadina set (`scripts/data/vocabularies/neogranadina-roles.ts`)
 * and the starter set (`scripts/data/vocabularies/starter-roles.ts`).
 * The D1 is a `node:sqlite` twin of `vocabulary_values` as migration
 * 0125 leaves it, with the tenants, descriptions and the two link
 * tables reduced to the columns the codes-in-use read names.
 *
 *   - the Neogranadina set holds the rows the institution-records fill
 *     wrote, and the starter set holds the same rows as the Neogranadina
 *     set for its six codes;
 *   - a plan on a federation with no roles lists 7 groups, 33 entity
 *     roles and 7 place roles to insert and writes nothing; on a
 *     federation the fill seeded, all 47 are unchanged;
 *   - apply writes the rows and reads them back; a second run has
 *     nothing to write;
 *   - a held row with other labels refuses the run and reports both;
 *   - the data file is checked before any read: duplicate codes or
 *     positions, a group neither in the file nor named as existing, and
 *     a missing label stop the run;
 *   - a code held by a link of the federation and in none of its
 *     `entity_role`, `relation_role` or `place_role` lists, nor in the
 *     set, refuses the run with its count; another federation's links
 *     are not counted;
 *   - the role groups take positions 1 to 7, and the relation set's
 *     groups follow them as they do after the fill; a held group at one
 *     of those positions refuses the run, whether or not the set names
 *     it as existing;
 *   - a plan reads in five SELECTs, each scoped to the federation.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runVocabularySeed, validateSet, VocabularyStop, type SeedOptions, type SeedReport, type VocabularySet } from "../../scripts/lib/vocabulary-seed";
import { NEOGRANADINA_ROLES, type RoleVocabularySet } from "../../scripts/data/vocabularies/neogranadina-roles";
import { STARTER_ROLES } from "../../scripts/data/vocabularies/starter-roles";
import { vocabularyEntries, vocabularySeed } from "../../scripts/lib/institution-records-fill";
import type { RunProviders } from "../../scripts/lib/cli/run-file";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
const NOW = 1_800_000_000_000;
const ROLE_LISTS = ["entity_role", "place_role", "role_group"];

const DDL = `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
CREATE TABLE tenants (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL REFERENCES federations(id));
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id));
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id), role TEXT NOT NULL);
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id), role TEXT NOT NULL);
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
INSERT INTO tenants VALUES ('t-n', 'fed-n'), ('t-a', 'fed-a');
INSERT INTO descriptions VALUES ('d-n', 't-n'), ('d-a', 't-a');
`;

function twin(): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec(DDL);
  return db;
}

/** The fill's rows for the three role lists, as it wrote them on every federation. */
function fillRoles(db: DatabaseSync, federationId = "fed-n"): void {
  let n = 0;
  const insert = db.prepare(
    "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, group_code, position, external_scheme, external_uri, external_label, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of vocabularySeed(federationId, 1, () => `fill-${federationId}-${++n}`)) {
    if (!ROLE_LISTS.includes(r.list)) continue;
    insert.run(r.id, r.federationId, r.list, r.code, r.labelEs, r.labelEn, r.groupCode, r.position, r.externalScheme, r.externalUri, r.externalLabel, r.status, r.createdAt, r.updatedAt);
  }
}

function link(db: DatabaseSync, table: "description_entities" | "description_places", role: string, description = "d-n"): void {
  const id = `${table}-${role}-${description}-${Math.random()}`;
  db.prepare(`INSERT INTO ${table} (id, description_id, role) VALUES (?, ?, ?)`).run(id, description, role);
}

interface Run {
  files: Map<string, string>;
  reads: string[];
  applied: string[][];
}

// Ids run on across runs, so two runs on one twin never mint the same id.
let n = 0;

function providers(db: DatabaseSync, run: Run): RunProviders {
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
    newId: () => (++n).toString(16).padStart(12, "0"),
    applyFile: async (_p, statements) => {
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
  opts: { run?: Run; sets?: Record<string, VocabularySet> } = {},
): Promise<{ report: SeedReport; run: Run }> {
  const run = opts.run ?? newRun();
  const options: SeedOptions = {
    target: "staging",
    federation: "neogranadina",
    set: "neogranadina-roles",
    apply: false,
    confirmProduction: false,
    ...over,
  };
  const report = await runVocabularySeed(options, providers(db, run), () => {}, opts.sets);
  return { report, run };
}

const count = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const clone = (set: RoleVocabularySet = NEOGRANADINA_ROLES): RoleVocabularySet => JSON.parse(JSON.stringify(set));

describe("role sets: the data files", () => {
  it("hold the rows the institution-records fill wrote, with the same codes, groups, positions and labels", () => {
    const fill = vocabularyEntries()
      .filter((e) => ROLE_LISTS.includes(e.list))
      .map((e) => ({ list: e.list, code: e.code, es: e.labelEs, en: e.labelEn, group: e.groupCode, position: e.position }));
    const file = [
      ...NEOGRANADINA_ROLES.groups.map((g) => ({ list: "role_group", code: g.code, es: g.es, en: g.en, group: null, position: g.position })),
      ...NEOGRANADINA_ROLES.entityRoles.map((r) => ({ list: "entity_role", code: r.code, es: r.es, en: r.en, group: r.group, position: r.position })),
      ...NEOGRANADINA_ROLES.placeRoles.map((r) => ({ list: "place_role", code: r.code, es: r.es, en: r.en, group: null, position: r.position })),
    ];
    const key = (r: { list: string; code: string }) => `${r.list}:${r.code}`;
    const sort = <T extends { list: string; code: string }>(rows: T[]) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    expect(sort(file)).toEqual(sort(fill));
    expect(NEOGRANADINA_ROLES.groups).toHaveLength(7);
    expect(NEOGRANADINA_ROLES.entityRoles).toHaveLength(33);
    expect(NEOGRANADINA_ROLES.placeRoles).toHaveLength(7);
  });

  it("give the starter set creator, subject and mentioned, each row as the Neogranadina set holds it", () => {
    expect(STARTER_ROLES.entityRoles.map((r) => r.code).sort()).toEqual(["creator", "mentioned", "subject"]);
    expect(STARTER_ROLES.placeRoles.map((r) => r.code).sort()).toEqual(["created", "mentioned", "subject"]);
    for (const r of STARTER_ROLES.entityRoles) expect(NEOGRANADINA_ROLES.entityRoles).toContainEqual(r);
    for (const r of STARTER_ROLES.placeRoles) expect(NEOGRANADINA_ROLES.placeRoles).toContainEqual(r);
    for (const g of STARTER_ROLES.groups) expect(NEOGRANADINA_ROLES.groups).toContainEqual(g);
    expect(STARTER_ROLES.groups.map((g) => g.code)).toEqual(["production"]);
  });

  it("accept both sets", () => {
    expect(() => validateSet(NEOGRANADINA_ROLES)).not.toThrow();
    expect(() => validateSet(STARTER_ROLES)).not.toThrow();
  });

  it("refuse a duplicate code, a duplicate position, an unknown group and a missing label", () => {
    const dupCode = clone();
    dupCode.entityRoles.push({ ...dupCode.entityRoles[0], position: 99 });
    expect(() => validateSet(dupCode)).toThrow(/entity_role: creator appears twice/);
    const dupPlace = clone();
    dupPlace.placeRoles.push({ ...dupPlace.placeRoles[1], position: 99 });
    expect(() => validateSet(dupPlace)).toThrow(/place_role: subject appears twice/);
    const dupGroup = clone();
    dupGroup.existingGroups = ["legal"];
    expect(() => validateSet(dupGroup)).toThrow(/role_group: legal appears twice/);
    const dupPosition = clone();
    dupPosition.entityRoles.find((r) => r.code === "author")!.position = 1;
    expect(() => validateSet(dupPosition)).toThrow(/production.*position 1/);
    const unknownGroup = clone();
    unknownGroup.entityRoles[0].group = "making";
    expect(() => validateSet(unknownGroup)).toThrow(/creator.*making/);
    const noLabel = clone();
    noLabel.placeRoles[0].en = " ";
    expect(() => validateSet(noLabel)).toThrow(/place_role created: a label is missing/);
    const noGroupLabel = clone();
    noGroupLabel.groups[1].es = "";
    expect(() => validateSet(noGroupLabel)).toThrow(/role_group correspondence: a label is missing/);
  });

  it("refuse a broken set before anything is read", async () => {
    const set = clone();
    set.entityRoles[0].es = "";
    const run = newRun();
    await expect(seed(twin(), {}, { run, sets: { "neogranadina-roles": set } })).rejects.toThrow(VocabularyStop);
    expect(run.reads).toHaveLength(0);
  });
});

describe("role sets: the plan", () => {
  it("lists 7 groups, 33 entity roles and 7 place roles on a federation with none, and writes nothing", async () => {
    const db = twin();
    const { report, run } = await seed(db);
    expect(report.outcome).toBe("dry run");
    expect(report.totals).toEqual({
      entity_role: { insert: 33, unchanged: 0, conflict: 0 },
      place_role: { insert: 7, unchanged: 0, conflict: 0 },
      role_group: { insert: 7, unchanged: 0, conflict: 0 },
    });
    expect(count(db, "SELECT count(*) AS n FROM vocabulary_values")).toBe(0);
    expect(run.applied).toHaveLength(0);
    expect([...run.files.keys()].some((p) => p.endsWith(".sql"))).toBe(true);
  });

  it("finds all 47 rows unchanged on a federation the fill seeded, and leaves the relation groups alone", async () => {
    const db = twin();
    fillRoles(db);
    const relationGroups = db.prepare(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) VALUES (?, 'fed-n', 'role_group', ?, ?, ?, ?, 1, 1)",
    );
    ["kinship", "executorship_guardianship", "enslavement", "enslaved_ties"].forEach((g, i) => relationGroups.run(`rg-${g}`, g, g, g, 8 + i));
    const { report, run } = await seed(db);
    expect(report.outcome).toBe("nothing to write");
    expect(report.totals).toEqual({
      entity_role: { insert: 0, unchanged: 33, conflict: 0 },
      place_role: { insert: 0, unchanged: 7, conflict: 0 },
      role_group: { insert: 0, unchanged: 7, conflict: 0 },
    });
    expect(report.others.map((o) => o.code)).toEqual(["kinship", "executorship_guardianship", "enslavement", "enslaved_ties"]);
    expect([...run.files.keys()].some((p) => p.endsWith(".sql"))).toBe(false);
  });

  it("lists 1 group, 3 entity roles and 3 place roles for the starter set", async () => {
    const { report } = await seed(twin(), { set: "starter-roles" });
    expect(report.totals).toEqual({
      entity_role: { insert: 3, unchanged: 0, conflict: 0 },
      place_role: { insert: 3, unchanged: 0, conflict: 0 },
      role_group: { insert: 1, unchanged: 0, conflict: 0 },
    });
  });

  it("reads only SELECTs, five of them, each scoped to the federation where it reads its rows", async () => {
    const { run } = await seed(twin());
    expect(run.reads).toHaveLength(5);
    for (const sql of run.reads) expect(sql.trim()).toMatch(/^SELECT\b/i);
    for (const sql of run.reads.filter((s) => /FROM vocabulary_values|description_entities/.test(s))) {
      expect(sql).toMatch(/federation_id = 'fed-n'/);
    }
  });

  it("refuses a federation without an existing group the set names", async () => {
    const set = clone(STARTER_ROLES);
    set.groups = [];
    set.existingGroups = ["production"];
    const { report } = await seed(twin(), { set: "starter-roles" }, { sets: { "starter-roles": set } });
    expect(report.outcome).toBe("refused");
    expect(report.refusals.join(" ")).toMatch(/role_group production: the set names it as existing/);
  });
});

describe("role sets: apply", () => {
  it("writes the rows, reads them back, and a second run writes nothing", async () => {
    const db = twin();
    const { report } = await seed(db, { apply: true });
    expect(report.outcome).toBe("verified");
    const n = (list: string) => count(db, `SELECT count(*) AS n FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = '${list}'`);
    expect([n("role_group"), n("entity_role"), n("place_role")]).toEqual([7, 33, 7]);
    const fiador = db.prepare("SELECT * FROM vocabulary_values WHERE list = 'entity_role' AND code = 'fiador'").get() as Record<string, unknown>;
    expect(fiador).toMatchObject({ label_es: "Fiador", label_en: "Surety", group_code: "legal", position: 6, status: "approved", inverse_code: null, label_es_unrecorded: null });
    const again = await seed(db, { apply: true });
    expect(again.report.outcome).toBe("nothing to write");
    expect(again.run.applied).toHaveLength(0);
  });

  it("writes the same rows the fill wrote, apart from ids and clocks", async () => {
    const seeded = twin();
    await seed(seeded, { apply: true });
    const filled = twin();
    fillRoles(filled);
    const rows = (db: DatabaseSync) =>
      db.prepare(
        "SELECT list, code, label_es, label_en, group_code, position, external_scheme, external_uri, external_label, status FROM vocabulary_values ORDER BY list, code",
      ).all();
    expect(rows(seeded)).toEqual(rows(filled));
  });
});

describe("role sets: conflicts", () => {
  it("refuses a held row with other labels, reports both, and writes nothing", async () => {
    const db = twin();
    fillRoles(db);
    db.exec("UPDATE vocabulary_values SET label_en = 'Guarantor' WHERE list = 'entity_role' AND code = 'fiador'");
    const { report, run } = await seed(db, { apply: true });
    expect(report.outcome).toBe("refused");
    expect(report.totals.entity_role).toEqual({ insert: 0, unchanged: 32, conflict: 1 });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]).toMatchObject({ list: "entity_role", code: "fiador" });
    expect(report.conflicts[0].differences).toEqual({ label_en: { held: "Guarantor", file: "Surety" } });
    expect(run.applied).toHaveLength(0);
    const md = [...run.files.entries()].find(([p]) => p.endsWith(".md"))![1];
    expect(md).toContain('label_en: held "Guarantor", file "Surety"');
  });
});

describe("role sets: codes in use", () => {
  it("refuses a code held by the federation's links that no list holds, with its count", async () => {
    const db = twin();
    fillRoles(db);
    link(db, "description_entities", "creator");
    link(db, "description_entities", "godfather");
    link(db, "description_entities", "godfather");
    link(db, "description_places", "harbour");
    const { report } = await seed(db);
    expect(report.outcome).toBe("refused");
    expect(report.unlisted).toEqual([
      { table: "description_entities", code: "godfather", links: 2 },
      { table: "description_places", code: "harbour", links: 1 },
    ]);
    expect(report.refusals).toContain(
      "description_entities godfather: held by 2 links, and in none of entity_role, relation_role or place_role",
    );
    expect(report.refusals).toContain(
      "description_places harbour: held by 1 link, and in none of entity_role, relation_role or place_role",
    );
  });

  it("accepts a code of the relation list, of the other role list, or of the set's own inserts", async () => {
    const db = twin();
    db.exec(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, created_at, updated_at) VALUES ('r-1', 'fed-n', 'relation_role', 'parent', 1, 1), " +
        "('r-2', 'fed-n', 'entity_role', 'patron', 1, 1)",
    );
    link(db, "description_entities", "parent");
    link(db, "description_entities", "witness");
    link(db, "description_places", "patron");
    const { report } = await seed(db);
    expect(report.outcome).toBe("dry run");
    expect(report.unlisted).toEqual([]);
    expect(report.codesInUse).toEqual([
      { table: "description_entities", code: "parent", links: 1 },
      { table: "description_entities", code: "witness", links: 1 },
      { table: "description_places", code: "patron", links: 1 },
    ]);
  });

  it("does not count another federation's links", async () => {
    const db = twin();
    fillRoles(db);
    link(db, "description_entities", "godfather", "d-a");
    const { report } = await seed(db);
    expect(report.outcome).toBe("nothing to write");
    expect(report.codesInUse).toEqual([]);
  });

  it("refuses the starter set where the links hold codes beyond it", async () => {
    const db = twin();
    link(db, "description_entities", "witness");
    const { report } = await seed(db, { set: "starter-roles" });
    expect(report.outcome).toBe("refused");
    expect(report.unlisted).toEqual([{ table: "description_entities", code: "witness", links: 1 }]);
  });
});

describe("role sets: group positions", () => {
  it("place the relation set's groups after the role groups, as they follow the fill's", async () => {
    const db = twin();
    await seed(db, { apply: true });
    const relations = await seed(db, { apply: true, set: "neogranadina-relations" });
    expect(relations.report.outcome).toBe("verified");
    const groups = db
      .prepare("SELECT code, position FROM vocabulary_values WHERE federation_id = 'fed-n' AND list = 'role_group' ORDER BY position")
      .all() as Array<{ code: string; position: number }>;
    expect(groups.map((g) => g.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(groups.slice(0, 7).map((g) => g.code)).toEqual(NEOGRANADINA_ROLES.groups.map((g) => g.code));
    expect(groups.slice(7).map((g) => g.code)).toEqual(["kinship", "executorship_guardianship", "enslavement", "enslaved_ties"]);
    // A role run after the relation run still finds its groups unchanged.
    const again = await seed(db);
    expect(again.report.outcome).toBe("nothing to write");
  });

  it("refuses a new group at the position of a held group the set names as existing", async () => {
    const db = twin();
    db.exec(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) VALUES ('g-l', 'fed-n', 'role_group', 'legal', 'Procedimientos judiciales', 'Legal proceedings', 1, 1, 1)",
    );
    const set = clone(STARTER_ROLES);
    set.existingGroups = ["legal"];
    const { report, run } = await seed(db, { set: "starter-roles", apply: true }, { sets: { "starter-roles": set } });
    expect(report.outcome).toBe("refused");
    expect(report.refusals.join(" ")).toMatch(/role_group legal: held at position 1, which the set gives to production/);
    expect(run.applied).toHaveLength(0);
  });

  it("refuses a held group that the set does not name at a position the set gives", async () => {
    const db = twin();
    db.exec(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) VALUES ('g-k', 'fed-n', 'role_group', 'kinship', 'Parentesco', 'Kinship', 3, 1, 1)",
    );
    const { report } = await seed(db);
    expect(report.outcome).toBe("refused");
    expect(report.refusals.join(" ")).toMatch(/role_group kinship: held at position 3, which the set gives to notarial/);
  });
});

// @version v0.9.0
