/**
 * Tests for Fonds List Lookup
 *
 * @version v0.3.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { applyMigrations, cleanDatabase } from "../../../tests/helpers/db";
import { getFondsList } from "./fonds-list.server";

describe("getFondsList", () => {
  let db: ReturnType<typeof drizzle>;
  let repositoryId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    repositoryId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: repositoryId,
      code: "test-repo",
      name: "Test Repository",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  it("returns reference codes of root descriptions (parentId IS NULL) sorted alphabetically", async () => {
    const now = Date.now();

    // Insert root descriptions (parentId = null)
    await db.insert(schema.descriptions).values([
      {
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: "co-ahr-not",
        localIdentifier: "003",
        title: "Notariales",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: "co-ahr-gob",
        localIdentifier: "001",
        title: "Gobierno",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: "co-ahr-jud",
        localIdentifier: "002",
        title: "Judicial",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await getFondsList(db);
    expect(result).toEqual(["co-ahr-gob", "co-ahr-jud", "co-ahr-not"]);
  });

  it("returns empty array when no root descriptions exist", async () => {
    const result = await getFondsList(db);
    expect(result).toEqual([]);
  });

  it("excludes descriptions that have a parentId", async () => {
    const now = Date.now();
    const rootId = crypto.randomUUID();

    // Insert a root description
    await db.insert(schema.descriptions).values({
      id: rootId,
      repositoryId,
      descriptionLevel: "fonds",
      referenceCode: "co-ahr-gob",
      localIdentifier: "001",
      title: "Gobierno",
      createdAt: now,
      updatedAt: now,
    });

    // Insert a child description (has parentId)
    await db.insert(schema.descriptions).values({
      id: crypto.randomUUID(),
      repositoryId,
      parentId: rootId,
      descriptionLevel: "series",
      referenceCode: "co-ahr-gob-s1",
      localIdentifier: "001-s1",
      title: "Serie 1",
      createdAt: now,
      updatedAt: now,
    });

    const result = await getFondsList(db);
    expect(result).toEqual(["co-ahr-gob"]);
  });
});
