import { eq, and, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users, magicLinks } from "../db/schema";
import { sendMagicLinkEmail } from "./email.server";
import { getAppConfig } from "./config.server";

/**
 * Generates a magic link for the given email address.
 * Returns { success: true } if the email was sent, or { error: string } if
 * the email is not associated with any user.
 */
export async function generateMagicLink(
  db: DrizzleD1Database<any>,
  email: string,
  origin: string,
  resendApiKey: string,
  env: { APP_NAME?: string; SENDER_EMAIL?: string } = {}
): Promise<{ success?: boolean; error?: string }> {
  // Look up user by email
  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .get();

  if (!user) {
    return { error: "No account found for this email." };
  }

  // Generate token
  const token = crypto.randomUUID();
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;

  await db.insert(magicLinks).values({
    id: crypto.randomUUID(),
    token,
    userId: user.id,
    expiresAt: now + fifteenMinutes,
    createdAt: now,
  });

  // Build verification URL
  const verifyUrl = new URL("/auth/verify", origin);
  verifyUrl.searchParams.set("token", token);

  // Send email
  const appConfig = getAppConfig(env);
  await sendMagicLinkEmail(resendApiKey, email, verifyUrl.toString(), appConfig);

  return { success: true };
}

/**
 * Verifies a magic link token. Returns the userId if the token is valid
 * (exists, not expired, not already used), or null otherwise.
 * Marks the token as used on success.
 */
export async function verifyMagicLink(
  db: DrizzleD1Database<any>,
  token: string
): Promise<string | null> {
  const link = await db
    .select()
    .from(magicLinks)
    .where(
      and(eq(magicLinks.token, token), isNull(magicLinks.usedAt))
    )
    .get();

  if (!link) {
    return null;
  }

  // Check expiry
  if (link.expiresAt < Date.now()) {
    return null;
  }

  // Mark as used
  await db
    .update(magicLinks)
    .set({ usedAt: Date.now() })
    .where(eq(magicLinks.id, link.id));

  return link.userId;
}

/**
 * Fetches a user by ID. Returns the user or null if not found.
 */
export async function requireUser(
  db: DrizzleD1Database<any>,
  userId: string
): Promise<{
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
} | null> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin as unknown as boolean,
  };
}
