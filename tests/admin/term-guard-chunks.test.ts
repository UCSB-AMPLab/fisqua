/**
 * Tests — the vocabulary merge and split guards bind their entities in chunks
 *
 * This suite pins that the vocabulary merge and split guards bind their
 * entities in chunks. A vocabulary merge or split guards every entity it
 * moves, by id and version, in bound JSON parameters. D1 refuses a bound
 * string over 2,000,000 bytes, which one parameter for every entity on a
 * term would pass at about 36,000 entities. The suite pins that the guards
 * and the moves split the entities into chunks of at most
 * `ENTITIES_PER_STATEMENT`, each well under that limit, with the count
 * check for a whole-term merge as a statement of its own, and that the
 * check run after a failed batch reads every chunk.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_FEDERATION_ID } from "../helpers/db";
import { createTestEntity } from "../helpers/entities";
import {
  ENTITIES_PER_STATEMENT,
  entityChunks,
  readEntitiesOnTerm,
  entityIdsRead,
  entitiesOnTermAsReadGuards,
  entitiesOnTermStillAsRead,
  type EntityVersionAsRead,
} from "../../app/lib/entity-functions.server";

const D1_STRING_LIMIT = 2_000_000;

function db() {
  return drizzle(env.DB, { schema });
}

/** `n` entities as read, with UUID ids and millisecond versions. */
function fakeRead(n: number): EntityVersionAsRead[] {
  return Array.from({ length: n }, (_, i) => ({ id: crypto.randomUUID(), version: 1_790_000_000_000 + i }));
}

/** The longest string any of `statements` binds. */
function longestParam(statements: { toSQL(): { params: unknown[] } }[]): number {
  let longest = 0;
  for (const s of statements) {
    for (const p of s.toSQL().params) if (typeof p === "string") longest = Math.max(longest, p.length);
  }
  return longest;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
});

describe("the term guards bind their entities in chunks", () => {
  it("guards 40,000 entities in statements whose every bound string is under D1's limit", () => {
    const read = fakeRead(40_000);
    const whole = eq(schema.entities.federationId, "f");
    const guards = entitiesOnTermAsReadGuards(db(), "term", read, whole) as any[];
    expect(guards).toHaveLength(Math.ceil(40_000 / ENTITIES_PER_STATEMENT) + 1);
    expect(longestParam(guards)).toBeLessThan(D1_STRING_LIMIT / 10);
  });

  it("names the entities to move in chunks that together cover every entity once", () => {
    const read = fakeRead(ENTITIES_PER_STATEMENT * 2 + 1);
    const chunks = entityChunks(read);
    expect(chunks.map((c) => c.length)).toEqual([ENTITIES_PER_STATEMENT, ENTITIES_PER_STATEMENT, 1]);
    expect(chunks.flat()).toEqual(read);
    const moves = chunks.map((c) => db().select().from(schema.entities).where(entityIdsRead(c)));
    expect(longestParam(moves as any[])).toBeLessThan(D1_STRING_LIMIT / 10);
  });

  it("has no guard for no entities unless the merge takes the whole term", () => {
    expect(entitiesOnTermAsReadGuards(db(), "term", [])).toHaveLength(0);
    expect(entitiesOnTermAsReadGuards(db(), "term", [], eq(schema.entities.federationId, "f"))).toHaveLength(1);
  });

  it("reads an id repeated across chunks once", async () => {
    const now = Date.now();
    await db().insert(schema.vocabularyTerms).values({
      id: "term",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Notario",
      category: null,
      status: "approved",
      entityCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    const a = await createTestEntity({ entityCode: "ne-dup001", displayName: "Repeated" });
    await env.DB.prepare("UPDATE entities SET primary_function_id = 'term' WHERE id = ?").bind(a.id).run();
    const read = await readEntitiesOnTerm(db(), "term", undefined, Array(ENTITIES_PER_STATEMENT + 1).fill(a.id));
    expect(read.map((r) => r.id)).toEqual([a.id]);
  });

  it("finds a changed entity in a later chunk when it checks a failed batch", async () => {
    const now = Date.now();
    await db().insert(schema.vocabularyTerms).values({
      id: "term",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Notario",
      category: null,
      status: "approved",
      entityCount: 2,
      createdAt: now,
      updatedAt: now,
    });
    const a = await createTestEntity({ entityCode: "ne-chk001", displayName: "Unchanged" });
    const b = await createTestEntity({ entityCode: "ne-chk002", displayName: "Changed" });
    await env.DB.prepare("UPDATE entities SET primary_function_id = 'term', updated_at = 7 WHERE id IN (?, ?)")
      .bind(a.id, b.id)
      .run();
    // A fills the first chunk; B is the only entity of the second.
    const read = [...Array.from({ length: ENTITIES_PER_STATEMENT }, () => ({ id: a.id, version: 7 })), { id: b.id, version: 7 }];
    expect(entityChunks(read)).toHaveLength(2);
    expect(await entitiesOnTermStillAsRead(db(), "term", read)).toBe(true);
    await env.DB.prepare("UPDATE entities SET updated_at = 8 WHERE id = ?").bind(b.id).run();
    expect(await entitiesOnTermStillAsRead(db(), "term", read)).toBe(false);
  });
});

// @version v0.9.0
