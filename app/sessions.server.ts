// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { createCookieSessionStorage } from "react-router";

type SessionData = {
  userId: string;
};

type SessionFlashData = {
  error: string;
  success: string;
};

/**
 * Factory for creating cookie session storage.
 * Must be called per-request because the secret comes from env.
 */
export function createSessionStorage(sessionSecret: string) {
  return createCookieSessionStorage<SessionData, SessionFlashData>({
    cookie: {
      name: "__session",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
      sameSite: "lax",
      secrets: [sessionSecret],
      secure: true,
    },
  });
}
