// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { redirect } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { createSessionStorage } from "../sessions.server";
import { requireUser } from "../lib/auth.server";

import type { unstable_MiddlewareFunction as MiddlewareFunction } from "react-router";

/**
 * Authentication middleware for protected routes.
 * Reads the session cookie, looks up the user in D1, and populates
 * userContext. Redirects to /login if no valid session.
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
};
