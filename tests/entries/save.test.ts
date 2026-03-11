import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { loadEntries, saveEntries } from "../../app/lib/entries.server";
import type { Entry } from "../../app/lib/boundary-types";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: crypto.randomUUID(),
    volumeId: "vol-1",
    parentId: null,
    position: 0,
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    type: null,
    title: null,
    note: null,
    noteUpdatedBy: null,
    noteUpdatedAt: null,
    reviewerComment: null,
    reviewerCommentUpdatedBy: null,
    reviewerCommentUpdatedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("entry persistence (loadEntries / saveEntries)", () => {
  let projectId: string;
  let volumeId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();

    const user = await createTestUser({ isAdmin: false });
    const db = drizzle(env.DB, { schema });
    const now = Date.now();

    projectId = crypto.randomUUID();
    volumeId = crypto.randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      name: "Test Project",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: user.id,
      role: "lead",
      createdAt: now,
    });

    await db.insert(schema.volumes).values({
      id: volumeId,
      projectId,
      name: "Test Volume",
      referenceCode: "co-test-vol001",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 10,
      status: "unstarted",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("returns a default auto-entry for a volume with no entries", async () => {
    const db = drizzle(env.DB, { schema });
    const result = await loadEntries(db, volumeId);

    expect(result).toHaveLength(1);
    expect(result[0].volumeId).toBe(volumeId);
    expect(result[0].startPage).toBe(1);
    expect(result[0].position).toBe(0);
    expect(result[0].parentId).toBeNull();
    expect(result[0].type).toBeNull();
    expect(result[0].title).toBeNull();
  });

  it("saves entries and loads them back (roundtrip)", async () => {
    const db = drizzle(env.DB, { schema });

    const entriesToSave: Entry[] = [
      makeEntry({ id: "e1", volumeId, position: 0, startPage: 1 }),
      makeEntry({ id: "e2", volumeId, position: 1, startPage: 5, type: "item", title: "First item" }),
      makeEntry({ id: "e3", volumeId, position: 2, startPage: 8, type: "blank" }),
    ];

    await saveEntries(db, volumeId, entriesToSave);

    const loaded = await loadEntries(db, volumeId);

    expect(loaded).toHaveLength(3);
    expect(loaded[0].id).toBe("e1");
    expect(loaded[0].startPage).toBe(1);
    expect(loaded[1].id).toBe("e2");
    expect(loaded[1].startPage).toBe(5);
    expect(loaded[1].type).toBe("item");
    expect(loaded[1].title).toBe("First item");
    expect(loaded[2].id).toBe("e3");
    expect(loaded[2].type).toBe("blank");
  });

  it("overwrites previous entries on re-save", async () => {
    const db = drizzle(env.DB, { schema });

    // First save: 3 entries
    await saveEntries(db, volumeId, [
      makeEntry({ id: "e1", volumeId, position: 0, startPage: 1 }),
      makeEntry({ id: "e2", volumeId, position: 1, startPage: 5 }),
      makeEntry({ id: "e3", volumeId, position: 2, startPage: 8 }),
    ]);

    // Second save: only 2 entries
    await saveEntries(db, volumeId, [
      makeEntry({ id: "e4", volumeId, position: 0, startPage: 1 }),
      makeEntry({ id: "e5", volumeId, position: 1, startPage: 3 }),
    ]);

    const loaded = await loadEntries(db, volumeId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("e4");
    expect(loaded[1].id).toBe("e5");
  });

  it("preserves nested entries with parentId and endPage", async () => {
    const db = drizzle(env.DB, { schema });

    const entriesToSave: Entry[] = [
      makeEntry({ id: "parent", volumeId, position: 0, startPage: 1 }),
      makeEntry({
        id: "child1",
        volumeId,
        parentId: "parent",
        position: 0,
        startPage: 2,
        endPage: 4,
        type: "item",
        title: "Nested item",
      }),
    ];

    await saveEntries(db, volumeId, entriesToSave);
    const loaded = await loadEntries(db, volumeId);

    expect(loaded).toHaveLength(2);
    const child = loaded.find((e) => e.id === "child1");
    expect(child).toBeDefined();
    expect(child!.parentId).toBe("parent");
    expect(child!.endPage).toBe(4);
    expect(child!.type).toBe("item");
    expect(child!.title).toBe("Nested item");
  });

  it("rejects entries with mismatched volumeId", async () => {
    const db = drizzle(env.DB, { schema });

    await expect(
      saveEntries(db, volumeId, [
        makeEntry({ id: "e1", volumeId: "wrong-vol", position: 0, startPage: 1 }),
      ])
    ).rejects.toThrow("entry volumeId must match");
  });

  it("rejects entries with invalid type", async () => {
    const db = drizzle(env.DB, { schema });

    await expect(
      saveEntries(db, volumeId, [
        makeEntry({ id: "e1", volumeId, position: 0, startPage: 1, type: "invalid" as any }),
      ])
    ).rejects.toThrow("invalid entry type");
  });

  it("saves and loads entries with startY and endY (y-position roundtrip)", async () => {
    const db = drizzle(env.DB, { schema });

    const entriesToSave: Entry[] = [
      makeEntry({ id: "e1", volumeId, position: 0, startPage: 1, startY: 0 }),
      makeEntry({ id: "e2", volumeId, position: 1, startPage: 3, startY: 0.45 }),
      makeEntry({
        id: "e3",
        volumeId,
        parentId: "e2",
        position: 0,
        startPage: 3,
        startY: 0.5,
        endPage: 4,
        endY: 0.75,
        type: "item",
      }),
    ];

    await saveEntries(db, volumeId, entriesToSave);
    const loaded = await loadEntries(db, volumeId);

    expect(loaded).toHaveLength(3);

    const e1 = loaded.find((e) => e.id === "e1")!;
    const e2 = loaded.find((e) => e.id === "e2")!;
    const e3 = loaded.find((e) => e.id === "e3")!;

    expect(e1.startY).toBe(0);
    expect(e1.endY).toBeNull();
    expect(e2.startY).toBe(0.45);
    expect(e3.startY).toBe(0.5);
    expect(e3.endY).toBe(0.75);
  });

  it("default auto-entry has startY=0 and endY=null", async () => {
    const db = drizzle(env.DB, { schema });
    const result = await loadEntries(db, volumeId);

    expect(result).toHaveLength(1);
    expect(result[0].startY).toBe(0);
    expect(result[0].endY).toBeNull();
  });

  it("rejects entries with startPage < 1", async () => {
    const db = drizzle(env.DB, { schema });

    await expect(
      saveEntries(db, volumeId, [
        makeEntry({ id: "e1", volumeId, position: 0, startPage: 0 }),
      ])
    ).rejects.toThrow("positive startPage");
  });

  it("saves and loads entries with note and reviewerComment (roundtrip)", async () => {
    const db = drizzle(env.DB, { schema });
    const now = Date.now();

    // Create additional users for note/comment attribution
    const catUser = await createTestUser({ email: "cat@test.com" });
    const revUser = await createTestUser({ email: "rev@test.com" });

    const entriesToSave: Entry[] = [
      makeEntry({
        id: "e1",
        volumeId,
        position: 0,
        startPage: 1,
        note: "Handwriting difficult to read",
        noteUpdatedBy: catUser.id,
        noteUpdatedAt: now,
        reviewerComment: "Please verify boundary",
        reviewerCommentUpdatedBy: revUser.id,
        reviewerCommentUpdatedAt: now,
      }),
      makeEntry({
        id: "e2",
        volumeId,
        position: 1,
        startPage: 5,
        note: null,
        reviewerComment: null,
      }),
    ];

    await saveEntries(db, volumeId, entriesToSave);
    const loaded = await loadEntries(db, volumeId);

    expect(loaded).toHaveLength(2);

    const e1 = loaded.find((e) => e.id === "e1")!;
    expect(e1.note).toBe("Handwriting difficult to read");
    expect(e1.noteUpdatedBy).toBe(catUser.id);
    expect(e1.noteUpdatedAt).toBe(now);
    expect(e1.reviewerComment).toBe("Please verify boundary");
    expect(e1.reviewerCommentUpdatedBy).toBe(revUser.id);
    expect(e1.reviewerCommentUpdatedAt).toBe(now);

    const e2 = loaded.find((e) => e.id === "e2")!;
    expect(e2.note).toBeNull();
    expect(e2.reviewerComment).toBeNull();
  });

  it("accept-corrections clears reviewer comments at data layer", async () => {
    const db = drizzle(env.DB, { schema });
    const now = Date.now();

    // Create additional users for note/comment attribution
    const catUser = await createTestUser({ email: "cat2@test.com" });
    const revUser = await createTestUser({ email: "rev2@test.com" });

    // Save entries with reviewer comments
    await saveEntries(db, volumeId, [
      makeEntry({
        id: "e1",
        volumeId,
        position: 0,
        startPage: 1,
        note: "Cataloguer note preserved",
        noteUpdatedBy: catUser.id,
        noteUpdatedAt: now,
        reviewerComment: "Fix this boundary",
        reviewerCommentUpdatedBy: revUser.id,
        reviewerCommentUpdatedAt: now,
        modifiedBy: revUser.id,
      }),
    ]);

    // Simulate what handleAcceptCorrections does at the data layer
    const { eq, and, isNotNull } = await import("drizzle-orm");
    await db
      .update(schema.entries)
      .set({
        modifiedBy: null,
        reviewerComment: null,
        reviewerCommentUpdatedBy: null,
        reviewerCommentUpdatedAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(schema.entries.volumeId, volumeId),
          isNotNull(schema.entries.modifiedBy)
        )
      );

    const loaded = await loadEntries(db, volumeId);
    const e1 = loaded.find((e) => e.id === "e1")!;

    // Reviewer comments should be cleared
    expect(e1.reviewerComment).toBeNull();
    expect(e1.reviewerCommentUpdatedBy).toBeNull();
    expect(e1.reviewerCommentUpdatedAt).toBeNull();
    expect(e1.modifiedBy).toBeNull();

    // Cataloguer note should be preserved
    expect(e1.note).toBe("Cataloguer note preserved");
    expect(e1.noteUpdatedBy).toBe(catUser.id);
  });

  it("handles saving an empty entries array (clears all entries)", async () => {
    const db = drizzle(env.DB, { schema });

    // First save some entries
    await saveEntries(db, volumeId, [
      makeEntry({ id: "e1", volumeId, position: 0, startPage: 1 }),
    ]);

    // Save empty array
    await saveEntries(db, volumeId, []);

    // loadEntries returns auto-entry for empty volume
    const loaded = await loadEntries(db, volumeId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].startPage).toBe(1);
    // The auto-entry should have a new id (not "e1")
    expect(loaded[0].id).not.toBe("e1");
  });
});
