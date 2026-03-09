// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { createSessionStorage } from "../sessions.server";
import { requireUser } from "../lib/auth.server";
import { users } from "../db/schema";

import type { unstable_MiddlewareFunction as MiddlewareFunction } from "react-router";

/** Throttle lastActiveAt writes to once every 5 minutes. */
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Authentication middleware for protected routes.
 * Reads the session cookie, looks up the user in D1, and populates
 * userContext. Redirects to /login if no valid session.
 *
 * Also throttle-updates lastActiveAt on the user row (only if the
 * current value is more than 5 minutes old, to avoid write amplification).
 */
export const authMiddleware: MiddlewareFunction = async ({
  request,
  context,
}) => {
  const env = context.cloudflare.env;
  const { getSession } = createSessionStorage(env.SESSION_SECRET);

  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");

  if (!userId) {
    throw redirect("/login");
  }

  const db = drizzle(env.DB);
  const user = await requireUser(db, userId);

  if (!user) {
    throw redirect("/login");
  }

  context.set(userContext, user);

  // Throttle-update lastActiveAt
  const now = Date.now();
  const [userRow] = await db
    .select({ lastActiveAt: users.lastActiveAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();

  if (
    userRow &&
    (!userRow.lastActiveAt ||
      now - userRow.lastActiveAt > LAST_ACTIVE_THROTTLE_MS)
  ) {
    await db
      .update(users)
      .set({ lastActiveAt: now })
      .where(eq(users.id, userId));
  }
};
