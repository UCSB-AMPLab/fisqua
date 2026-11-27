/**
 * Tests — signing a platform admin in on a workspace that is not theirs
 *
 * This suite pins the platform admin's place in the check that guards
 * signing in on a workspace that is not the person's own. The magic-link
 * verify route (`app/routes/auth.verify.tsx`) and the GitHub handoff
 * (`app/routes/auth.github.handoff.tsx`) refuse to mint a session on a
 * workspace other than the person's stored one, unless a federation grant
 * admits them. The suite pins:
 *
 *   - a platform admin with no home row on the host's workspace gets a
 *     session there, by magic link and by GitHub;
 *   - the email is unique, so the session is for the same user row;
 *   - without the flag, the same person is still sent to the
 *     wrong-workspace page, with no session;
 *   - the platform tenant and a disabled workspace still mint nothing,
 *     and neither does an operator's row with the flag.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  getTestDb,
  seedDisabledTenant,
  DEFAULT_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_SLUG,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import * as schema from "../../app/db/schema";
import { insertHandoff } from "../../app/lib/oauth-handoff.server";
import { createSessionStorage } from "../../app/sessions.server";

function makeLoaderArgs(url: string) {
  return {
    request: new Request(url),
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
          RESEND_API_KEY: "test-resend-key",
          GITHUB_CLIENT_ID: "test-github-id",
          GITHUB_CLIENT_SECRET: "test-github-secret",
        },
      },
    },
    params: {},
  };
}

async function setPlatformAdmin(userId: string, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE users SET is_platform_admin = ? WHERE id = ?").bind(on ? 1 : 0, userId).run();
}

async function seedMagicToken(userId: string): Promise<string> {
  const token = crypto.randomUUID();
  await drizzle(env.DB).insert(schema.magicLinks).values({
    id: crypto.randomUUID(),
    token,
    userId,
    expiresAt: Date.now() + 15 * 60 * 1000,
    createdAt: Date.now(),
  });
  return token;
}

async function call(loader: (args: any) => Promise<unknown>, url: string): Promise<Response> {
  try {
    const result = await loader(makeLoaderArgs(url) as any);
    if (result instanceof Response) return result;
    throw new Error("loader returned non-Response");
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

async function sessionUserId(response: Response): Promise<string | undefined> {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("__session="));
  if (!cookie) return undefined;
  const { getSession } = createSessionStorage("test-session-secret");
  const session = await getSession(cookie.split(";")[0]);
  return session.get("userId");
}

async function verify(url: string) {
  const { loader } = await import("../../app/routes/auth.verify");
  return call(loader, url);
}

async function handoff(email: string, slug: string, host: string) {
  const id = `handoff-${crypto.randomUUID()}`;
  await insertHandoff(getTestDb(), {
    id,
    email,
    githubId: `gh-${crypto.randomUUID()}`,
    githubLogin: "octo",
    returnToSlug: slug,
    now: Date.now(),
  });
  const { loader } = await import("../../app/routes/auth.github.handoff");
  return call(loader, `https://${host}/auth/github/handoff?t=${id}`);
}

describe("platform admin sign-in on another workspace", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("magic link: mints a session for the same user row", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const token = await seedMagicToken(pa.id);
    const r = await verify(`https://neogranadina.fisqua.test/auth/verify?token=${token}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard");
    expect(await sessionUserId(r)).toBe(pa.id);
  });

  it("magic link: without the flag, still the wrong-workspace page and no session", async () => {
    const user = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    const token = await seedMagicToken(user.id);
    const r = await verify(`https://neogranadina.fisqua.test/auth/verify?token=${token}`);
    expect(r.headers.get("Location")).toBe("/wrong-workspace?home=second-tenant");
    expect(await sessionUserId(r)).toBeUndefined();
  });

  it("magic link: a disabled workspace mints nothing", async () => {
    await seedDisabledTenant();
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const token = await seedMagicToken(pa.id);
    const r = await verify(`https://${DISABLED_TEST_TENANT_SLUG}.fisqua.test/auth/verify?token=${token}`);
    expect(r.status).toBe(404);
    expect(await sessionUserId(r)).toBeUndefined();
  });

  it("magic link: the platform tenant mints nothing", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID });
    await setPlatformAdmin(pa.id, true);
    const token = await seedMagicToken(pa.id);
    const r = await verify(`https://platform.fisqua.test/auth/verify?token=${token}`);
    expect(await sessionUserId(r)).toBeUndefined();
  });

  it("magic link and GitHub: an operator with the flag gets no session on a workspace", async () => {
    const { PLATFORM_TENANT_ID } = await import("../../app/lib/tenant");
    const operator = await createTestUser({ tenantId: PLATFORM_TENANT_ID, email: "op@example.com" });
    await setPlatformAdmin(operator.id, true);
    const token = await seedMagicToken(operator.id);
    const byLink = await verify(`https://neogranadina.fisqua.test/auth/verify?token=${token}`);
    expect(await sessionUserId(byLink)).toBeUndefined();
    const byGitHub = await handoff("op@example.com", "neogranadina", "neogranadina.fisqua.test");
    expect(await sessionUserId(byGitHub)).toBeUndefined();
  });

  it("GitHub handoff: mints a session for the same user row", async () => {
    const pa = await createTestUser({ tenantId: SECOND_TEST_TENANT_ID, email: "pa@example.com" });
    await setPlatformAdmin(pa.id, true);
    const r = await handoff("pa@example.com", "neogranadina", "neogranadina.fisqua.test");
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/dashboard");
    expect(await sessionUserId(r)).toBe(pa.id);
    const rows = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind("pa@example.com").all();
    expect(rows.results).toEqual([{ id: pa.id }]);
  });

  it("GitHub handoff: without the flag, still the wrong-workspace page and no session", async () => {
    await createTestUser({ tenantId: SECOND_TEST_TENANT_ID, email: "plain@example.com" });
    const r = await handoff("plain@example.com", "neogranadina", "neogranadina.fisqua.test");
    expect(r.headers.get("Location")).toBe("/wrong-workspace?home=second-tenant");
    expect(await sessionUserId(r)).toBeUndefined();
  });

  it("GitHub handoff: a platform admin on their stored workspace still signs in", async () => {
    const pa = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, email: "home@example.com" });
    await setPlatformAdmin(pa.id, true);
    const r = await handoff("home@example.com", "neogranadina", "neogranadina.fisqua.test");
    expect(await sessionUserId(r)).toBe(pa.id);
  });
});

// @version v0.9.0
