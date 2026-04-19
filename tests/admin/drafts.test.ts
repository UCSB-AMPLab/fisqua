/**
 * Tests — drafts
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

import {
  saveDraft,
  getDraft,
  getConflictDraft,
  deleteDraft,
} from "../../app/lib/drafts.server";
import {
  computeDiff,
  createChangelogEntry,
} from "../../app/lib/changelog.server";

describe("drafts and changelog", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // -----------------------------------------------------------------------
  // Draft utilities
  // -----------------------------------------------------------------------

  describe("saveDraft", () => {
    it("creates a draft record and upserts on same recordId+recordType", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      // Create initial draft
      await saveDraft(db, "rec-1", "description", user.id, '{"title":"A"}');

      const first = await db
        .select()
        .from(schema.drafts)
        .where(
          and(
            eq(schema.drafts.recordId, "rec-1"),
            eq(schema.drafts.recordType, "description")
          )
        )
        .get();

      expect(first).toBeTruthy();
      expect(first!.snapshot).toBe('{"title":"A"}');
      expect(first!.userId).toBe(user.id);

      // Upsert with new snapshot
      await saveDraft(db, "rec-1", "description", user.id, '{"title":"B"}');

      const all = await db
        .select()
        .from(schema.drafts)
        .where(
          and(
            eq(schema.drafts.recordId, "rec-1"),
            eq(schema.drafts.recordType, "description")
          )
        )
        .all();

      // Should still be exactly one draft
      expect(all).toHaveLength(1);
      expect(all[0].snapshot).toBe('{"title":"B"}');
    });
  });

  describe("getDraft", () => {
    it("returns null when no draft exists", async () => {
      const db = drizzle(env.DB);
      const result = await getDraft(db, "nonexistent", "description");
      expect(result).toBeNull();
    });

    it("returns the draft when it exists", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });
      await saveDraft(db, "rec-2", "entity", user.id, '{"name":"X"}');

      const result = await getDraft(db, "rec-2", "entity");
      expect(result).toBeTruthy();
      expect(result!.userId).toBe(user.id);
      expect(result!.snapshot).toBe('{"name":"X"}');
      expect(result!.updatedAt).toBeGreaterThan(0);
    });
  });

  describe("getConflictDraft", () => {
    it("returns null when no other user has a draft", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      // Same user's draft should not count as conflict
      await saveDraft(db, "rec-3", "repository", user.id, '{"code":"X"}');

      const result = await getConflictDraft(
        db,
        "rec-3",
        "repository",
        user.id
      );
      expect(result).toBeNull();
    });

    it("returns the draft when another user has one", async () => {
      const db = drizzle(env.DB);
      const userA = await createTestUser({ isAdmin: true, name: "User A" });
      const userB = await createTestUser({ isAdmin: true, name: "User B" });

      await saveDraft(db, "rec-4", "place", userA.id, '{"label":"Y"}');

      const result = await getConflictDraft(db, "rec-4", "place", userB.id);
      expect(result).toBeTruthy();
      expect(result!.userId).toBe(userA.id);
      expect(result!.updatedAt).toBeGreaterThan(0);
    });
  });

  describe("deleteDraft", () => {
    it("removes the draft for a record", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });
      await saveDraft(db, "rec-5", "description", user.id, '{"title":"Z"}');

      // Verify draft exists
      const before = await getDraft(db, "rec-5", "description");
      expect(before).toBeTruthy();

      await deleteDraft(db, "rec-5", "description");

      const after = await getDraft(db, "rec-5", "description");
      expect(after).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Changelog utilities
  // -----------------------------------------------------------------------

  describe("computeDiff", () => {
    it("returns null when no fields changed", () => {
      const original = { title: "A", notes: "B" };
      const updated = { title: "A", notes: "B" };
      expect(computeDiff(original, updated)).toBeNull();
    });

    it("returns { field: { old, new } } for changed fields", () => {
      const original = { title: "A", notes: "B", extent: "10" };
      const updated = { title: "X", notes: "B", extent: "20" };
      const diff = computeDiff(original, updated);

      expect(diff).toEqual({
        title: { old: "A", new: "X" },
        extent: { old: "10", new: "20" },
      });
    });

    it("detects changes in array/object fields via JSON comparison", () => {
      const original = { genre: ["a", "b"] };
      const updated = { genre: ["a", "c"] };
      const diff = computeDiff(original, updated);

      expect(diff).toEqual({
        genre: { old: ["a", "b"], new: ["a", "c"] },
      });
    });
  });

  describe("createChangelogEntry", () => {
    it("stores the diff with all required fields", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      const diff = { title: { old: "A", new: "B" } };
      await createChangelogEntry(
        db,
        "rec-6",
        "description",
        user.id,
        diff,
        "Fixed title"
      );

      const entries = await db
        .select()
        .from(schema.changelog)
        .where(
          and(
            eq(schema.changelog.recordId, "rec-6"),
            eq(schema.changelog.recordType, "description")
          )
        )
        .all();

      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(user.id);
      expect(entries[0].note).toBe("Fixed title");
      expect(JSON.parse(entries[0].diff)).toEqual(diff);
      expect(entries[0].createdAt).toBeGreaterThan(0);
    });

    it("stores null note when none provided", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      const diff = { notes: { old: "X", new: "Y" } };
      await createChangelogEntry(db, "rec-7", "entity", user.id, diff);

      const entries = await db
        .select()
        .from(schema.changelog)
        .where(eq(schema.changelog.recordId, "rec-7"))
        .all();

      expect(entries).toHaveLength(1);
      expect(entries[0].note).toBeNull();
    });
  });
});
