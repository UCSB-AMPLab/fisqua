/**
 * Authentication Server Helpers
 *
 * This module deals with the two server-side primitives that underlie
 * sign-in: minting and verifying magic-link tokens, and fetching the
 * authenticated user from D1 for the middleware to hand into the
 * request context.
 *
 * `generateMagicLink` looks up a user by email, mints a one-time token,
 * stores it in the `magic_links` table with a fifteen-minute expiry,
 * builds the verification URL, and sends it through Resend. It returns
 * a `{ success }` shape on the happy path and a stable `{ error }`
 * token (`"no_account"`) when the email is not associated with any
 * user -- the login form maps the token to a translated message at
 * the render boundary, never the raw token. The email is written in
 * the user's saved `users.locale`, else in the default language of
 * the workspace the link signs them into, else in the language of the
 * request that asked for it, else in Spanish (`chooseEmailLocale`).
 * The workspace is `workspaceId` when the caller knows it (the login
 * page passes the workspace its host resolves to, which for a
 * federation grant holder is not their home workspace) and the user's
 * home workspace otherwise. Callers pass the request's language as
 * `requestLocale`; the operator's new-workspace action and the
 * user-admin invite pass theirs, so a bootstrap or invited user with
 * no saved language and a workspace with no default gets the mail in
 * the language the inviter was using.
 *
 * `verifyMagicLink` takes the token from the callback query string and
 * returns the user id if the token is valid (exists, unused, and not
 * past its expiry), or `null` otherwise. On success it marks the token
 * as used so it cannot be replayed; the 15-minute window plus
 * single-use semantics are the core of the magic-link security model.
 *
 * `requireUser` fetches the user row keyed by id and returns the full
 * role-flag snapshot that `_auth.tsx` needs to populate
 * `userContext`, with the four area-admin flags and the platform-admin
 * flag (`isPlatformAdmin`, read fresh on every request so clearing it
 * takes effect on the next one). It mirrors the shape of the `User` type defined in
 * `app/context.ts` so loaders further down the tree can rely on every
 * role flag being present. The returned shape includes `tenantId`:
 * the source of truth that `authMiddleware`
 * asserts against the resolved tenant (`user.tenantId === tenant.id`)
 * before letting any loader run, and downstream loaders read it from
 * `userContext` to scope domain-table queries. Its read is retried
 * while D1 refuses it as overloaded, as the sign-in reads are.
 *
 * @version v0.9.0
 */

import { eq, and, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users, magicLinks } from "../db/schema";
import { sendMagicLinkEmail } from "./email.server";
import { getAppConfig } from "./config.server";
import {
  chooseEmailLocale,
  workspaceDefaultLocale,
} from "./email-locale.server";
import { retryD1Read, runD1Write, type D1Site } from "./d1-overload";

/**
 * Generates a magic link for the given email address.
 * Returns { success: true } if the email was sent, or a stable error
 * token ({ error: "no_account" }) if the email is not associated with
 * any user; callers translate the token, never render it.
 *
 * The user and workspace reads are retried while D1 refuses them as
 * overloaded (`retryD1Read`); `readRetry.waitsMs` and `readRetry.sleep`
 * set the waits and the sleep, and callers leave them out. The
 * `magic_links` insert gets one attempt (`runD1Write`), because a
 * refused write may still have been applied; its refusal reaches the
 * caller, which can tell it apart with `isD1Overloaded`. Every
 * refusal writes a `d1_overload` log line (`user_by_email`,
 * `workspace_locale`, `magic_link_insert`) for `readRetry.request`,
 * the request that asked for the link, when the caller passes it.
 */
export async function generateMagicLink(
  db: DrizzleD1Database<any>,
  email: string,
  origin: string,
  resendApiKey: string,
  env: { APP_NAME?: string; SENDER_EMAIL?: string } = {},
  requestLocale?: string | null,
  workspaceId?: string | null,
  readRetry: {
    waitsMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    request?: Request;
  } = {}
): Promise<{ success?: boolean; error?: string }> {
  const read = <T>(name: string, run: () => Promise<T>) =>
    retryD1Read(run, readRetry.waitsMs, readRetry.sleep, {
      read: name,
      request: readRetry.request,
    });

  // Look up user by email
  const user = await read("user_by_email", () =>
    db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .get()
  );

  if (!user) {
    return { error: "no_account" };
  }

  // Generate token
  const token = crypto.randomUUID();
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;

  await runD1Write(
    () =>
      db.insert(magicLinks).values({
        id: crypto.randomUUID(),
        token,
        userId: user.id,
        expiresAt: now + fifteenMinutes,
        createdAt: now,
      }),
    { read: "magic_link_insert", request: readRetry.request }
  );

  // Build verification URL
  const verifyUrl = new URL("/auth/verify", origin);
  verifyUrl.searchParams.set("token", token);

  const locale = chooseEmailLocale({
    userLocale: user.locale,
    workspaceLocale: user.locale
      ? null
      : await read("workspace_locale", () =>
          workspaceDefaultLocale(db, workspaceId ?? user.tenantId)
        ),
    requestLocale,
  });

  const appConfig = getAppConfig(env);
  await sendMagicLinkEmail(
    resendApiKey,
    email,
    verifyUrl.toString(),
    appConfig,
    locale
  );

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
 * Fetches a user by ID and returns the full role-flag snapshot that
 * `userContext` is populated with, or null if the user is missing.
 * The auth middlewares call it on every signed-in request, so the read
 * is retried while D1 refuses it as overloaded (`retryD1Read`); `site`
 * gives the request and context its `user_by_session` log lines name.
 */
export async function requireUser(
  db: DrizzleD1Database<any>,
  userId: string,
  site: Omit<D1Site, "read"> = {}
): Promise<{
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
  isRecordsAdmin: boolean;
  isAuthoritiesAdmin: boolean;
  isImportsAdmin: boolean;
  isDigitizationAdmin: boolean;
  isPlatformAdmin: boolean;
  lastActiveAt: number | null;
  githubId: string | null;
} | null> {
  const user = await retryD1Read(
    () =>
      db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .get(),
    undefined,
    undefined,
    { ...site, read: "user_by_session" }
  );

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin as unknown as boolean,
    isSuperAdmin: user.isSuperAdmin as unknown as boolean,
    isCollabAdmin: user.isCollabAdmin as unknown as boolean,
    isArchiveUser: user.isArchiveUser as unknown as boolean,
    isUserManager: user.isUserManager as unknown as boolean,
    isCataloguer: user.isCataloguer as unknown as boolean,
    isRecordsAdmin: user.isRecordsAdmin as unknown as boolean,
    isAuthoritiesAdmin: user.isAuthoritiesAdmin as unknown as boolean,
    isImportsAdmin: user.isImportsAdmin as unknown as boolean,
    isDigitizationAdmin: user.isDigitizationAdmin as unknown as boolean,
    // Read from the row on every request, never from the session; only
    // exactly `true` counts (app/lib/platform-admin.server.ts).
    isPlatformAdmin: user.isPlatformAdmin === true,
    lastActiveAt: user.lastActiveAt ?? null,
    githubId: user.githubId ?? null,
  };
}

// @version v0.9.0
