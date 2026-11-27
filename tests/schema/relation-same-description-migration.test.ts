/**
 * Tests — migration 0126 under D1
 *
 * This suite runs migration 0126 under workerd's D1, the engine production
 * uses. `tests/import/relation-same-description-migration.test.ts` pins
 * what migration 0126 does under Node's SQLite; this suite runs the same
 * file statement by statement on the test mirror with its copies of the
 * four triggers dropped, and pins that:
 *
 *   - every statement runs, and the triggers it creates are, word for
 *     word, the ones the mirror in `tests/helpers/db.ts` creates, so the
 *     mirror the other suites use cannot drift from the file;
 *   - D1 refuses, through the triggers, a link naming a link on another
 *     description, the other tenant's included, in either direction;
 *   - D1 takes a relation written as `add-relation` writes it.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, seedFederations, seedTenants, DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { runMigrationFile } from "../helpers/migration-file";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { createTestEntity } from "../helpers/entities";

const TRIGGERS = [
  "description_entities_id_fixed",
  "description_entities_related_to_insert",
  "description_entities_related_to_move",
  "description_entities_related_to_update",
];

async function triggers(): Promise<Array<{ name: string; sql: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'description_entities' ORDER BY name",
  ).all<{ name: string; sql: string }>();
  return results.map((r) => ({ name: r.name, sql: r.sql.replace(/\s+/g, " ").trim() }));
}

const refused = /a relation side must name a link on its own description/;
const run = (sql: string) => env.DB.prepare(sql).run();
const link = (id: string, d: string, e: string, role: string, related: string | null) =>
  env.DB.prepare("INSERT INTO description_entities (id, description_id, entity_id, role, created_at, related_to) VALUES (?, ?, ?, ?, 1, ?)")
    .bind(id, d, e, role, related)
    .run();

describe("migration 0126 under D1", () => {
  let d1: string;
  let far: string;
  let e1: string;
  let e2: string;
  let mirror: Array<{ name: string; sql: string }>;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedFederations();
    await seedTenants();
    mirror = await triggers();
    for (const t of TRIGGERS) await run(`DROP TRIGGER IF EXISTS ${t}`);
    await runMigrationFile("0126_relation_same_description.sql");
    const repo = await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: "repo-0126" });
    d1 = (await createTestDescription({ tenantId: DEFAULT_TEST_TENANT_ID, repositoryId: repo.id })).id;
    const farRepo = await createTestRepository({ tenantId: SECOND_TEST_TENANT_ID, code: "repo-0126-far" });
    far = (await createTestDescription({ tenantId: SECOND_TEST_TENANT_ID, repositoryId: farRepo.id })).id;
    e1 = (await createTestEntity({ entityCode: "ne-0126-a" })).id;
    e2 = (await createTestEntity({ entityCode: "ne-0126-b" })).id;
  });

  it("creates the four triggers, word for word as the test mirror has them", async () => {
    const created = await triggers();
    expect(created.map((t) => t.name)).toEqual(TRIGGERS);
    expect(created).toEqual(mirror);
  });

  it("takes a relation written as add-relation writes it", async () => {
    await link("a-0126", d1, e1, "sibling", "a-0126");
    await link("b-0126", d1, e2, "sibling", "a-0126");
    await run("UPDATE description_entities SET related_to = 'b-0126' WHERE id = 'a-0126' AND related_to = 'a-0126'");
    const row = await env.DB.prepare("SELECT related_to FROM description_entities WHERE id = 'a-0126'").first<{ related_to: string }>();
    expect(row?.related_to).toBe("b-0126");
  });

  it("refuses a link naming a link on another tenant's description, in either direction", async () => {
    // Each test runs on storage of its own: the relation is written here again.
    await link("a-0126", d1, e1, "sibling", "a-0126");
    await link("b-0126", d1, e2, "sibling", "a-0126");
    await run("UPDATE description_entities SET related_to = 'b-0126' WHERE id = 'a-0126'");
    await link("x-0126", far, e1, "spouse", "x-0126");
    const outcome = async (write: () => Promise<unknown>) =>
      write().then(
        () => "written",
        (e) => (refused.test(String(e?.message)) ? "refused" : `failed: ${e?.message}`),
      );
    expect({
      outgoing: await outcome(() => link("out-0126", d1, e2, "spouse", "x-0126")),
      incoming: await outcome(() => link("in-0126", far, e2, "child", "a-0126")),
      repoint: await outcome(() => run("UPDATE description_entities SET related_to = 'a-0126' WHERE id = 'x-0126'")),
      move: await outcome(() => run(`UPDATE description_entities SET description_id = '${far}' WHERE id = 'b-0126'`)),
    }).toEqual({ outgoing: "refused", incoming: "refused", repoint: "refused", move: "refused" });
  });
});

// @version v0.9.0
