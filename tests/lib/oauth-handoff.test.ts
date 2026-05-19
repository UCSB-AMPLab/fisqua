/**
 * Tests — oauth-handoff helpers
 *
 * This suite is the single-use atomic-consume regression net. The handoff route's security
 * depends on `consumeHandoff` issuing a single UPDATE … RETURNING
 * that flips `consumed = 0` to `consumed = 1` only when the row
 * exists, has not been consumed, and has not expired. Any future
 * refactor that replaces the atomic update with a SELECT-then-UPDATE
 * pattern would be racy; the replay-attack and expiry tests below
 * pin the property at the helper layer.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import {
  OAUTH_HANDOFF_TTL_MS,
  insertHandoff,
  consumeHandoff,
} from "../../app/lib/oauth-handoff.server";

describe("oauth-handoff helpers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("inserts a row and consumes it on the happy path", async () => {
    const db = getTestDb();
    const now = Date.now();
    await insertHandoff(db, {
      id: "id-happy-1",
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now,
    });
    const consumed = await consumeHandoff(db, "id-happy-1", now + 1);
    expect(consumed).not.toBeNull();
    expect(consumed?.email).toBe("scholar@example.com");
    expect(consumed?.githubId).toBe("12345");
    expect(consumed?.returnToSlug).toBe("neogranadina");
  });

  it("returns null when the id does not exist", async () => {
    const db = getTestDb();
    const result = await consumeHandoff(db, "not-a-real-id", Date.now());
    expect(result).toBeNull();
  });

  it("returns null on the second consume (single-use replay defence)", async () => {
    const db = getTestDb();
    const now = Date.now();
    await insertHandoff(db, {
      id: "id-replay-1",
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now,
    });
    const first = await consumeHandoff(db, "id-replay-1", now + 1);
    expect(first).not.toBeNull();
    const second = await consumeHandoff(db, "id-replay-1", now + 2);
    expect(second).toBeNull();
  });

  it("returns null when the row has expired", async () => {
    const db = getTestDb();
    const now = Date.now();
    await insertHandoff(db, {
      id: "id-expired-1",
      email: "scholar@example.com",
      githubId: "12345",
      githubLogin: "octocat",
      returnToSlug: "neogranadina",
      now,
    });
    // Consume "after" the TTL window — pass a now value past expires_at.
    const consumed = await consumeHandoff(
      db,
      "id-expired-1",
      now + OAUTH_HANDOFF_TTL_MS + 1,
    );
    expect(consumed).toBeNull();
  });

  it("the TTL constant is 30 seconds", () => {
    expect(OAUTH_HANDOFF_TTL_MS).toBe(30_000);
  });
});
