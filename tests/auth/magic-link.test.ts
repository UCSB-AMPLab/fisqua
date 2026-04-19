/**
 * Tests — magic link
 *
 * @version v0.3.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  generateMagicLink,
  verifyMagicLink,
} from "../../app/lib/auth.server";

// Mock Resend email sending
vi.mock("../../app/lib/email.server", () => ({
  sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined),
}));

import { sendMagicLinkEmail } from "../../app/lib/email.server";

describe("magic link authentication", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  describe("generateMagicLink", () => {
    it("generates a token and sends email for a known user", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser({ email: "scholar@example.com" });

      const result = await generateMagicLink(
        db,
        "scholar@example.com",
        "http://localhost:5173",
        "test-resend-key"
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify token was stored in DB
      const tokens = await db
        .select()
        .from(schema.magicLinks)
        .where(eq(schema.magicLinks.userId, user.id))
        .all();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].token).toBeTruthy();
      expect(tokens[0].usedAt).toBeNull();

      // Verify email was sent
      expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
      expect(sendMagicLinkEmail).toHaveBeenCalledWith(
        "test-resend-key",
        "scholar@example.com",
        expect.stringContaining("/auth/verify?token="),
        expect.objectContaining({ appName: "Zasqua: Cataloguing", senderEmail: "noreply@example.com" })
      );
    });

    it("returns error for unknown email", async () => {
      const db = drizzle(env.DB, { schema });

      const result = await generateMagicLink(
        db,
        "unknown@example.com",
        "http://localhost:5173",
        "test-resend-key"
      );

      expect(result.error).toBe("No account found for this email.");
      expect(result.success).toBeUndefined();

      // Verify no token was created
      const tokens = await db.select().from(schema.magicLinks).all();
      expect(tokens).toHaveLength(0);

      // Verify no email was sent
      expect(sendMagicLinkEmail).not.toHaveBeenCalled();
    });

    it("generates a token with 15-minute expiry", async () => {
      const db = drizzle(env.DB, { schema });
      await createTestUser({ email: "scholar@example.com" });

      await generateMagicLink(
        db,
        "scholar@example.com",
        "http://localhost:5173",
        "test-resend-key"
      );

      const tokens = await db.select().from(schema.magicLinks).all();
      const token = tokens[0];

      const fifteenMinutes = 15 * 60 * 1000;
      const now = Date.now();
      expect(token.expiresAt).toBeGreaterThan(now);
      expect(token.expiresAt).toBeLessThanOrEqual(now + fifteenMinutes + 1000);
    });
  });

  describe("verifyMagicLink", () => {
    it("returns userId for a valid unused token", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser({ email: "scholar@example.com" });

      const token = crypto.randomUUID();
      await db.insert(schema.magicLinks).values({
        id: crypto.randomUUID(),
        token,
        userId: user.id,
        expiresAt: Date.now() + 15 * 60 * 1000,
        createdAt: Date.now(),
      });

      const result = await verifyMagicLink(db, token);
      expect(result).toBe(user.id);

      // Verify token was marked as used
      const link = await db
        .select()
        .from(schema.magicLinks)
        .where(eq(schema.magicLinks.token, token))
        .get();
      expect(link!.usedAt).not.toBeNull();
    });

    it("returns null for an expired token", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();

      const token = crypto.randomUUID();
      await db.insert(schema.magicLinks).values({
        id: crypto.randomUUID(),
        token,
        userId: user.id,
        expiresAt: Date.now() - 1000, // expired
        createdAt: Date.now() - 16 * 60 * 1000,
      });

      const result = await verifyMagicLink(db, token);
      expect(result).toBeNull();
    });

    it("returns null for an already-used token", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();

      const token = crypto.randomUUID();
      await db.insert(schema.magicLinks).values({
        id: crypto.randomUUID(),
        token,
        userId: user.id,
        expiresAt: Date.now() + 15 * 60 * 1000,
        usedAt: Date.now() - 1000, // already used
        createdAt: Date.now() - 5 * 60 * 1000,
      });

      const result = await verifyMagicLink(db, token);
      expect(result).toBeNull();
    });

    it("returns null for a non-existent token", async () => {
      const db = drizzle(env.DB, { schema });

      const result = await verifyMagicLink(db, "non-existent-token");
      expect(result).toBeNull();
    });
  });
});
