/**
 * Tests — reading a federation's role lists
 *
 * This suite pins `readRoleVocabulary` in `app/lib/vocabulary.server.ts`,
 * which reads one federation's `entity_role`, `place_role` and
 * `role_group` lists:
 *
 *   - approved entity roles come in group order, then in their order
 *     within the group, and two groups at one position stay apart, in
 *     code order; groups hold every approved code once, with the
 *     codes that name no held group last, under a null group;
 *   - deprecated codes are listed apart, and proposed codes in neither
 *     list; labels cover every row, in both languages;
 *   - the relation roles are read into a list of their own, and neither
 *     another federation's rows nor the other relation lists are read;
 *   - a federation with no rows gets empty lists;
 *   - the Neogranadina set, seeded from its data file, reads back in the
 *     fill's order;
 *   - the read is one statement, scoped to the federation and the four
 *     lists.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_FEDERATION_ID, SECOND_TEST_FEDERATION_ID } from "../helpers/db";
import { roleSetRows, seedRoleLists, type RoleListRow } from "../helpers/vocabulary";
import { readRoleVocabulary } from "../../app/lib/vocabulary.server";
import { NEOGRANADINA_ROLES } from "../../scripts/data/vocabularies/neogranadina-roles";

const FED = DEFAULT_TEST_FEDERATION_ID;

const ROWS: RoleListRow[] = [
  { list: "role_group", code: "letters", es: "Cartas", en: "Letters", position: 2 },
  { list: "role_group", code: "making", es: "Producción", en: "Making", position: 1 },
  { list: "role_group", code: "old", es: "Antiguo", en: "Old", position: 3, status: "deprecated" },
  { list: "entity_role", code: "recipient", es: "Destinatario", en: "Recipient", group: "letters", position: 2 },
  { list: "entity_role", code: "sender", es: "Remitente", en: "Sender", group: "letters", position: 1 },
  { list: "entity_role", code: "subject", es: "Tema", en: "Subject", group: "making", position: 2 },
  { list: "entity_role", code: "creator", es: "Creador", en: "Creator", group: "making", position: 1 },
  { list: "entity_role", code: "loose", es: "Suelto", en: null, group: null, position: 1 },
  { list: "entity_role", code: "author", es: "Autor", en: "Author", group: "making", position: 3, status: "deprecated" },
  { list: "entity_role", code: "guess", es: "Propuesto", en: "Proposed", group: "making", position: 4, status: "proposed" },
  { list: "place_role", code: "mentioned", es: "Mencionado", en: "Mentioned", position: 2 },
  { list: "place_role", code: "created", es: "Creado", en: "Created", position: 1 },
  { list: "place_role", code: "venue", es: "Lugar", en: "Venue", position: 3, status: "deprecated" },
];

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
});

describe("readRoleVocabulary", () => {
  it("orders approved entity roles by group, then by position, and groups them", async () => {
    await seedRoleLists(FED, ROWS);
    const v = await readRoleVocabulary(drizzle(env.DB, { schema }), FED);
    expect(v.entityRoles.approved).toEqual(["creator", "subject", "sender", "recipient", "loose"]);
    expect(v.entityRoles.deprecated).toEqual(["author"]);
    expect(v.entityRoles.groups).toEqual([
      { code: "making", roles: ["creator", "subject"] },
      { code: "letters", roles: ["sender", "recipient"] },
      { code: null, roles: ["loose"] },
    ]);
    expect(v.entityRoles.labels.creator).toEqual({ es: "Creador", en: "Creator" });
    expect(v.entityRoles.labels.loose).toEqual({ es: "Suelto", en: null });
    expect(v.entityRoles.labels.author).toEqual({ es: "Autor", en: "Author" });
    expect(v.entityRoles.labels.guess).toEqual({ es: "Propuesto", en: "Proposed" });
  });

  it("keeps each group's roles together when two groups share a position, in the group list's order", async () => {
    await seedRoleLists(FED, [
      { list: "role_group", code: "beta", es: "Beta", en: "Beta", position: 1 },
      { list: "role_group", code: "alpha", es: "Alfa", en: "Alpha", position: 1 },
      { list: "entity_role", code: "a", es: "A", en: "A", group: "alpha", position: 1 },
      { list: "entity_role", code: "b", es: "B", en: "B", group: "beta", position: 2 },
      { list: "entity_role", code: "c", es: "C", en: "C", group: "alpha", position: 3 },
    ]);
    const v = await readRoleVocabulary(drizzle(env.DB, { schema }), FED);
    expect(v.roleGroups.approved).toEqual(["alpha", "beta"]);
    expect(v.entityRoles.groups).toEqual([
      { code: "alpha", roles: ["a", "c"] },
      { code: "beta", roles: ["b"] },
    ]);
    expect(v.entityRoles.approved).toEqual(["a", "c", "b"]);
  });

  it("lists place roles and role groups in position order, with their deprecated codes apart", async () => {
    await seedRoleLists(FED, ROWS);
    const v = await readRoleVocabulary(drizzle(env.DB, { schema }), FED);
    expect(v.placeRoles.approved).toEqual(["created", "mentioned"]);
    expect(v.placeRoles.deprecated).toEqual(["venue"]);
    expect(v.placeRoles.groups).toEqual([{ code: null, roles: ["created", "mentioned"] }]);
    expect(v.placeRoles.labels.venue).toEqual({ es: "Lugar", en: "Venue" });
    expect(v.roleGroups.approved).toEqual(["making", "letters"]);
    expect(v.roleGroups.deprecated).toEqual(["old"]);
    expect(v.roleGroups.labels.letters).toEqual({ es: "Cartas", en: "Letters" });
  });

  it("reads the relation roles into their own list, and neither another federation's rows nor the other relation lists", async () => {
    await seedRoleLists(FED, ROWS);
    await seedRoleLists(SECOND_TEST_FEDERATION_ID, [
      { list: "entity_role", code: "witness", es: "Testigo", en: "Witness", group: "making", position: 9 },
    ]);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, group_code, position, created_at, updated_at) " +
        "VALUES ('rel-1', ?, 'relation_role', 'parent', 'madre o padre', 'parent', 'making', 1, ?, ?)",
    ).bind(FED, now, now).run();
    await env.DB.prepare(
      "INSERT INTO vocabulary_values (id, federation_id, list, code, label_es, label_en, position, created_at, updated_at) " +
        "VALUES ('att-1', ?, 'link_attribute', 'office', 'Cargo', 'Office', 1, ?, ?)",
    ).bind(FED, now, now).run();
    const v = await readRoleVocabulary(drizzle(env.DB, { schema }), FED);
    expect(v.entityRoles.labels.witness).toBeUndefined();
    expect(v.entityRoles.labels.parent).toBeUndefined();
    expect(v.entityRoles.approved).not.toContain("witness");
    expect(v.relationRoles.approved).toEqual(["parent"]);
    expect(v.relationRoles.labels.parent).toEqual({ es: "madre o padre", en: "parent" });
    for (const list of [v.entityRoles, v.placeRoles, v.roleGroups, v.relationRoles]) {
      expect(list.labels.office).toBeUndefined();
    }
  });

  it("gives a federation with no rows empty lists", async () => {
    const v = await readRoleVocabulary(drizzle(env.DB, { schema }), SECOND_TEST_FEDERATION_ID);
    for (const list of [v.entityRoles, v.placeRoles, v.roleGroups, v.relationRoles]) {
      expect(list).toEqual({ approved: [], deprecated: [], labels: {}, groups: [] });
    }
  });

  it("reads the Neogranadina set, seeded from its data file, in the fill's order", async () => {
    await seedRoleLists(FED, roleSetRows(NEOGRANADINA_ROLES));
    const v = await readRoleVocabulary(drizzle(env.DB, { schema }), FED);
    expect(v.roleGroups.approved).toEqual(["production", "correspondence", "notarial", "legal", "family", "transactions", "visual"]);
    expect(v.entityRoles.approved).toHaveLength(33);
    expect(v.entityRoles.groups.map((g) => g.code)).toEqual(v.roleGroups.approved);
    expect(v.entityRoles.groups[0].roles).toEqual(["creator", "author", "editor", "publisher", "mentioned", "subject", "official"]);
    expect(v.placeRoles.approved).toEqual(["created", "subject", "mentioned", "sent_from", "sent_to", "published", "venue"]);
    expect(v.entityRoles.labels.fiador).toEqual({ es: "Fiador", en: "Surety" });
  });

  it("reads in one statement, scoped to the federation and the four lists", async () => {
    await seedRoleLists(FED, ROWS);
    const queries: Array<{ query: string; params: unknown[] }> = [];
    const db = drizzle(env.DB, { schema, logger: { logQuery: (query, params) => queries.push({ query, params }) } });
    await readRoleVocabulary(db, FED);
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toMatch(/from "vocabulary_values" where \("vocabulary_values"\."federation_id" = \? and "vocabulary_values"\."list" in \(\?, \?, \?, \?\)\)/);
    expect(queries[0].params).toEqual([FED, "entity_role", "place_role", "role_group", "relation_role"]);
  });
});

// @version v0.9.0
