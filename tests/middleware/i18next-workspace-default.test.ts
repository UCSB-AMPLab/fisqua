/**
 * Tests — the workspace's default interface language
 *
 * This suite pins how the server picks the interface language when a
 * workspace names a default (`tenants.default_locale`). The server picks
 * the language from `?lang=`, then the `lang` cookie, then the workspace
 * default, then Accept-Language, then Spanish. The suite runs the i18next
 * middleware against the test D1 with the seeded Neogranadina workspace
 * (slug `neogranadina`) and the second test workspace (slug
 * `second-tenant`), and pins:
 *
 *   1. `?lang=` wins over the cookie and the workspace default.
 *   2. The `lang` cookie wins over the workspace default.
 *   3. The workspace default wins over Accept-Language.
 *   4. A workspace with no default falls through to Accept-Language,
 *      then to Spanish.
 *   5. The apex host, which has no workspace, keeps Accept-Language.
 *   6. An unknown or soft-disabled workspace, a request with no D1
 *      binding, and a D1 that fails all fall back to Accept-Language
 *      instead of failing the request.
 *   7. The workspace row read for the language is kept on the request
 *      context, and `resolveRequestTenant` hands the auth middleware
 *      that same lookup; no lookup is made when `?lang=` or the cookie
 *      decides.
 *   8. A route that renders no page (`/api/`, the sign-in redirects)
 *      makes no tenant read for its language, and the sign-in page
 *      reads the tenant once for the middleware and its loader
 *      together.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { i18nextMiddleware, getLocale, rendersNoPage } from "../../app/middleware/i18next";
import { serializeLanguageCookie } from "../../app/lib/language-cookie.server";
import { requestTenantContext } from "../../app/context";
import { NEOGRANADINA_TENANT_ID, resolveRequestTenant } from "../../app/lib/tenant";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";

const WORKSPACE = "https://neogranadina.fisqua.test/login";
const NO_DEFAULT = "https://second-tenant.fisqua.test/login";

// The seeded rows outlive `cleanDatabase`, so each test starts from
// and leaves them with no default and not disabled.
async function resetTenants(): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET default_locale = NULL, disabled_at = NULL").run();
}

async function setDefault(id: string, locale: "en" | "es" | null): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET default_locale = ? WHERE id = ?").bind(locale, id).run();
}

async function run(
  url: string,
  headers: Record<string, string> = {},
  binding: unknown = env,
): Promise<RouterContextProvider> {
  const request = new Request(url, { headers });
  const context = new RouterContextProvider();
  if (binding) (context as any).cloudflare = { env: binding };
  await i18nextMiddleware(
    { request, context, params: {} } as any,
    async () => new Response("ok"),
  );
  return context;
}

async function cookie(lang: "en" | "es", url: string): Promise<string> {
  const setCookie = await serializeLanguageCookie(lang, new Request(url));
  return setCookie.split(";")[0];
}

describe("workspace default language in the detection order", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await resetTenants();
    await setDefault(NEOGRANADINA_TENANT_ID, "es");
  });

  afterAll(resetTenants);

  it("prefers ?lang= over the cookie and the workspace default", async () => {
    const context = await run(`${WORKSPACE}?lang=en`, {
      Cookie: await cookie("es", WORKSPACE),
      "Accept-Language": "es",
    });
    expect(getLocale(context)).toBe("en");
  });

  it("prefers the lang cookie over the workspace default", async () => {
    const context = await run(WORKSPACE, {
      Cookie: await cookie("en", WORKSPACE),
      "Accept-Language": "es",
    });
    expect(getLocale(context)).toBe("en");
  });

  it("prefers the workspace default over Accept-Language", async () => {
    const context = await run(WORKSPACE, { "Accept-Language": "en-US,en;q=0.9" });
    expect(getLocale(context)).toBe("es");
  });

  it("applies an English default over a Spanish browser", async () => {
    await setDefault(NEOGRANADINA_TENANT_ID, "en");
    const context = await run(WORKSPACE, { "Accept-Language": "es-CO,es;q=0.9" });
    expect(getLocale(context)).toBe("en");
  });

  it("falls through to Accept-Language when the workspace has no default", async () => {
    const context = await run(NO_DEFAULT, { "Accept-Language": "en-US,en;q=0.9" });
    expect(getLocale(context)).toBe("en");
  });

  it("falls back to Spanish when the workspace has no default and the browser names no supported language", async () => {
    const context = await run(NO_DEFAULT, { "Accept-Language": "fr-FR" });
    expect(getLocale(context)).toBe("es");
  });

  it("leaves the apex host on Accept-Language", async () => {
    const context = await run("https://fisqua.test/", { "Accept-Language": "en" });
    expect(getLocale(context)).toBe("en");
  });

  it("falls back to Accept-Language for an unknown workspace", async () => {
    const context = await run("https://no-such-workspace.fisqua.test/login", {
      "Accept-Language": "en",
    });
    expect(getLocale(context)).toBe("en");
  });

  it("falls back to Accept-Language for a soft-disabled workspace", async () => {
    await env.DB.prepare("UPDATE tenants SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), NEOGRANADINA_TENANT_ID)
      .run();
    const context = await run(WORKSPACE, { "Accept-Language": "en" });
    expect(getLocale(context)).toBe("en");
  });

  it("falls back to Accept-Language when the request has no D1 binding", async () => {
    const context = await run(WORKSPACE, { "Accept-Language": "en" }, null);
    expect(getLocale(context)).toBe("en");
  });

  it("falls back to Accept-Language when the D1 read fails", async () => {
    const failing = {
      DB: {
        prepare() {
          throw new Error("D1 unavailable");
        },
      },
    };
    const context = await run(WORKSPACE, { "Accept-Language": "en" }, failing);
    expect(getLocale(context)).toBe("en");
  });
});

describe("the workspace row shared through the request context", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await resetTenants();
    await setDefault(NEOGRANADINA_TENANT_ID, "es");
  });

  afterAll(resetTenants);

  it("keeps the row it read, and resolveRequestTenant returns the same lookup", async () => {
    const request = new Request(WORKSPACE, { headers: { "Accept-Language": "en" } });
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env };
    await i18nextMiddleware({ request, context, params: {} } as any, async () => new Response("ok"));

    const pending = context.get(requestTenantContext);
    expect(pending).not.toBeNull();
    expect((await pending!).id).toBe(NEOGRANADINA_TENANT_ID);

    const shared = resolveRequestTenant(context, drizzle(env.DB), request);
    expect(shared).toBe(pending);
  });

  it("makes no lookup when ?lang= or the cookie decides", async () => {
    const byParam = await run(`${WORKSPACE}?lang=en`, { "Accept-Language": "es" });
    expect(byParam.get(requestTenantContext)).toBeNull();
    const byCookie = await run(WORKSPACE, { Cookie: await cookie("en", WORKSPACE) });
    expect(byCookie.get(requestTenantContext)).toBeNull();
  });

  it("resolves the row itself when nothing has looked it up", async () => {
    const request = new Request(`https://second-tenant.fisqua.test/dashboard`);
    const context = new RouterContextProvider();
    const tenant = await resolveRequestTenant(context, drizzle(env.DB), request);
    expect(tenant.id).toBe(SECOND_TEST_TENANT_ID);
    expect(tenant.defaultLocale).toBeNull();
    expect(context.get(requestTenantContext)).not.toBeNull();
  });

  it("rejects with the resolver's bare 404 for an unknown host, on every call", async () => {
    const request = new Request("https://no-such-workspace.fisqua.test/dashboard");
    const context = new RouterContextProvider();
    const db = drizzle(env.DB);
    for (let i = 0; i < 2; i++) {
      const thrown = await resolveRequestTenant(context, db, request).catch((e) => e);
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
    }
  });
});

/**
 * A D1 binding that counts the statements that read `tenants`, passed
 * through to the test database.
 */
function countingEnv(): { env: any; tenantReads: () => number } {
  let reads = 0;
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (/from\s+"?tenants"?/i.test(sql)) reads++;
          return target.prepare(sql);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB }, tenantReads: () => reads };
}

describe("routes that render no page, and the sign-in page", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await resetTenants();
    await setDefault(NEOGRANADINA_TENANT_ID, "es");
  });

  afterAll(resetTenants);

  it("knows the routes that render no page", () => {
    const at = (path: string) => rendersNoPage(new Request(`https://neogranadina.fisqua.test${path}`));
    for (const path of [
      "/api/capture/v1/queue",
      "/api/pipeline/runs/r-1/complete",
      "/api/comments",
      "/auth/verify",
      "/auth/verify/",
      "/auth/github/handoff",
      "/auth/logout",
      "/handoff/impersonation",
      "/end-impersonation",
      "/invite/accept",
    ]) {
      expect(at(path), path).toBe(true);
    }
    for (const path of ["/", "/login", "/wrong-workspace", "/dashboard", "/apiary", "/auth/verify-later"]) {
      expect(at(path), path).toBe(false);
    }
  });

  it("makes no tenant read for the language of an /api/ request", async () => {
    const counting = countingEnv();
    const context = await run(
      "https://neogranadina.fisqua.test/api/capture/v1/queue",
      { "Accept-Language": "en" },
      counting.env,
    );
    expect(getLocale(context)).toBe("en");
    expect(context.get(requestTenantContext)).toBeNull();
    expect(counting.tenantReads()).toBe(0);
  });

  it("makes no tenant read for the language of the magic-link redirect", async () => {
    const counting = countingEnv();
    const context = await run(
      "https://neogranadina.fisqua.test/auth/verify?token=t",
      { "Accept-Language": "en" },
      counting.env,
    );
    expect(getLocale(context)).toBe("en");
    expect(counting.tenantReads()).toBe(0);
  });

  it("reads the tenant once for the sign-in page's language and its loader", async () => {
    const counting = countingEnv();
    const testEnv = { ...counting.env, SESSION_SECRET: "test-session-secret" };
    const request = new Request(WORKSPACE, { headers: { "Accept-Language": "en" } });
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env: testEnv };
    const { loader } = await import("../../app/routes/login");
    let data: any;
    await i18nextMiddleware({ request, context, params: {} } as any, async () => {
      data = await loader({ request, context, params: {} } as any);
      return new Response("ok");
    });
    expect(getLocale(context)).toBe("es");
    expect(data).toMatchObject({ lang: "es", tenantSlug: "neogranadina" });
    expect(counting.tenantReads()).toBe(1);
  });
});

// @version v0.9.0
