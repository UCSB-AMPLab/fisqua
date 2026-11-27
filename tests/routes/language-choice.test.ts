/**
 * Tests — choosing a language persists it in the `lang` cookie
 *
 * This suite pins the two server routes that record a signed-in user's
 * language in the `lang` cookie the i18next middleware reads on the
 * next request.
 *
 * Coverage:
 *   1. The `/configuracion` `updateLocale` action saves `users.locale`
 *      and answers with a `lang` Set-Cookie for the chosen language;
 *      that cookie sent back makes the next request Spanish even when
 *      the browser asks for English.
 *   2. An unsupported locale saves nothing and sets no cookie.
 *   3. Magic-link sign-in writes the cookie from the user's saved
 *      `users.locale` alongside `__session`; it writes none when the
 *      user has no saved locale, and leaves an existing `lang` cookie
 *      alone.
 *   4. Accepting a project invite, which also signs the invitee in,
 *      writes the cookie from the invitee's saved locale.
 *   5. A sign-in URL that carries an explicit `?lang=` writes no
 *      saved-locale cookie, so the i18next middleware records the
 *      explicit language instead (checked through the middleware for
 *      magic link and invite acceptance; the GitHub handoff is in
 *      `tests/auth/github-handoff.test.ts`).
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeUserContext } from "../helpers/context";
import { userContext } from "../../app/context";
import * as schema from "../../app/db/schema";
import { i18nextMiddleware, getLocale } from "../../app/middleware/i18next";
import { serializeLanguageCookie } from "../../app/lib/language-cookie.server";

const HOST = "https://neogranadina.fisqua.test";

/** The `lang=...` Set-Cookie value among a response's headers, or null. */
function langSetCookie(headers: Headers): string | null {
  return headers.getSetCookie().find((c) => c.startsWith("lang=")) ?? null;
}

async function localeFor(cookie: string, acceptLanguage: string) {
  const context = new RouterContextProvider();
  await i18nextMiddleware(
    {
      request: new Request(`${HOST}/configuracion`, {
        headers: { Cookie: cookie.split(";")[0], "Accept-Language": acceptLanguage },
      }),
      context,
      params: {},
    } as any,
    async () => new Response("ok"),
  );
  return getLocale(context);
}

async function submitLocale(userId: string, locale: string) {
  const { action } = await import("../../app/routes/_auth.configuracion");
  const row = await drizzle(env.DB)
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  const ctx = new RouterContextProvider();
  ctx.set(
    userContext,
    makeUserContext({
      id: row!.id,
      tenantId: row!.tenantId,
      email: row!.email,
      name: row!.name,
      isAdmin: row!.isAdmin,
    }),
  );
  (ctx as any).cloudflare = { env };
  const body = new FormData();
  body.set("_action", "updateLocale");
  body.set("locale", locale);
  return action({
    request: new Request(`${HOST}/configuracion`, { method: "POST", body }),
    context: ctx,
    params: {},
  } as any);
}

async function savedLocale(userId: string) {
  const row = await drizzle(env.DB)
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  return row?.locale ?? null;
}

async function seedMagicToken(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  await drizzle(env.DB).insert(schema.magicLinks).values({
    id: crypto.randomUUID(),
    token,
    userId,
    expiresAt: Date.now() + 15 * 60 * 1000,
    usedAt: null,
    createdAt: Date.now(),
  });
  return token;
}

/**
 * Runs a sign-in loader behind the i18next middleware, as the server
 * does, and returns the redirect it ends in.
 */
async function throughMiddleware(
  request: Request,
  loader: (args: any) => Promise<unknown>,
): Promise<Response> {
  const context = new RouterContextProvider();
  return (await i18nextMiddleware(
    { request, context, params: {} } as any,
    async () => {
      try {
        await loader({
          request,
          context: {
            cloudflare: { env: { DB: env.DB, SESSION_SECRET: "test-session-secret" } },
          },
          params: {},
        });
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      }
      throw new Error("loader should have thrown a redirect");
    },
  )) as Response;
}

async function seedInvite(inviteeEmail: string) {
  const db = drizzle(env.DB);
  const lead = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Test Project",
    createdBy: lead.id,
    createdAt: now,
    updatedAt: now,
  });
  const token = crypto.randomUUID();
  await db.insert(schema.projectInvites).values({
    id: crypto.randomUUID(),
    projectId,
    email: inviteeEmail,
    roles: JSON.stringify(["cataloguer"]),
    invitedBy: lead.id,
    token,
    expiresAt: now + 60 * 60 * 1000,
    createdAt: now,
  });
  return { projectId, token };
}

async function verify(token: string, cookie?: string): Promise<Response> {
  const { loader } = await import("../../app/routes/auth.verify");
  try {
    await loader({
      request: new Request(`${HOST}/auth/verify?token=${token}`, {
        headers: cookie ? { Cookie: cookie } : {},
      }),
      context: {
        cloudflare: { env: { DB: env.DB, SESSION_SECRET: "test-session-secret" } },
      },
      params: {},
    } as any);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error("loader should have thrown a redirect");
}

async function setSavedLocale(userId: string, locale: "en" | "es" | null) {
  await drizzle(env.DB)
    .update(schema.users)
    .set({ locale })
    .where(eq(schema.users.id, userId));
}

describe("language choice on /configuracion", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("saves the locale and sets the lang cookie, which the next request honours", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const result: any = await submitLocale(user.id, "es");

    expect(result.data).toEqual({ ok: true, intent: "updateLocale" });
    expect(await savedLocale(user.id)).toBe("es");

    const setCookie = langSetCookie(new Headers(result.init.headers));
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");

    // The refresh: the browser asks for English, the cookie says Spanish.
    expect(await localeFor(setCookie!, "en-US,en;q=0.9")).toBe("es");
  });

  it("rejects an unsupported locale without saving or setting a cookie", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const result: any = await submitLocale(user.id, "fr");
    expect(result).toEqual({ ok: false });
    expect(await savedLocale(user.id)).toBeNull();
  });
});

describe("magic-link sign-in and the lang cookie", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("writes the saved locale into the lang cookie", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    await setSavedLocale(user.id, "en");
    const response = await verify(await seedMagicToken(user.id));

    expect(response.headers.get("Location")).toBe("/dashboard");
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__session="))).toBe(true);
    const lang = langSetCookie(response.headers);
    expect(lang).not.toBeNull();
    expect(await localeFor(lang!, "es")).toBe("en");
  });

  it("writes no lang cookie when the user has no saved locale", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const response = await verify(await seedMagicToken(user.id));
    expect(response.headers.get("Location")).toBe("/dashboard");
    expect(langSetCookie(response.headers)).toBeNull();
  });

  it("leaves a lang cookie this browser already carries", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    await setSavedLocale(user.id, "en");
    const existing = (
      await serializeLanguageCookie("es", new Request(HOST))
    ).split(";")[0];
    const response = await verify(await seedMagicToken(user.id), existing);
    expect(response.headers.get("Location")).toBe("/dashboard");
    expect(langSetCookie(response.headers)).toBeNull();
  });

  it("records an explicit ?lang= instead of the saved locale", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    await setSavedLocale(user.id, "en");
    const token = await seedMagicToken(user.id);
    const { loader } = await import("../../app/routes/auth.verify");
    const response = await throughMiddleware(
      new Request(`${HOST}/auth/verify?token=${token}&lang=es`),
      loader,
    );

    expect(response.headers.get("Location")).toBe("/dashboard");
    const langCookies = response.headers
      .getSetCookie()
      .filter((c) => c.startsWith("lang="));
    expect(langCookies).toHaveLength(1);
    expect(await localeFor(langCookies[0], "en")).toBe("es");
  });
});

describe("invite acceptance and the lang cookie", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("writes the invitee's saved locale into the lang cookie", async () => {
    const db = drizzle(env.DB);
    const lead = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    const invitee = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    await setSavedLocale(invitee.id, "en");
    const now = Date.now();
    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: lead.id,
      createdAt: now,
      updatedAt: now,
    });
    const token = crypto.randomUUID();
    await db.insert(schema.projectInvites).values({
      id: crypto.randomUUID(),
      projectId,
      email: invitee.email,
      roles: JSON.stringify(["cataloguer"]),
      invitedBy: lead.id,
      token,
      expiresAt: now + 60 * 60 * 1000,
      createdAt: now,
    });

    const { loader } = await import("../../app/routes/invite.accept");
    let response: Response | null = null;
    try {
      await loader({
        request: new Request(`${HOST}/invite/accept?token=${token}`),
        context: {
          cloudflare: { env: { DB: env.DB, SESSION_SECRET: "test-session-secret" } },
        },
        params: {},
      } as any);
    } catch (thrown) {
      if (!(thrown instanceof Response)) throw thrown;
      response = thrown;
    }

    expect(response?.headers.get("Location")).toBe(`/projects/${projectId}`);
    const lang = langSetCookie(response!.headers);
    expect(lang).not.toBeNull();
    expect(await localeFor(lang!, "es")).toBe("en");
  });

  it("records an explicit ?lang= instead of the invitee's saved locale", async () => {
    const invitee = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID });
    await setSavedLocale(invitee.id, "en");
    const { projectId, token } = await seedInvite(invitee.email);
    const { loader } = await import("../../app/routes/invite.accept");
    const response = await throughMiddleware(
      new Request(`${HOST}/invite/accept?token=${token}&lang=es`),
      loader,
    );

    expect(response.headers.get("Location")).toBe(`/projects/${projectId}`);
    const langCookies = response.headers
      .getSetCookie()
      .filter((c) => c.startsWith("lang="));
    expect(langCookies).toHaveLength(1);
    expect(await localeFor(langCookies[0], "en")).toBe("es");
  });
});

// @version v0.9.0
