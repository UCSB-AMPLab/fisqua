/**
 * Tests — the per-request tenant and user lookups when D1 is overloaded
 *
 * This suite pins what a request gets when D1 refuses the per-request
 * tenant and user lookups as overloaded (error code 7429). For every
 * request to a workspace host, Fisqua resolves the host to a `tenants` row
 * before it renders a page, and for every request under the signed-in
 * layout it also reads the user row. It pins:
 *
 *   - the tenant-by-slug read is retried with `retryD1Read`'s default
 *     waits, so a refusal that clears within them costs nothing more
 *     than the wait;
 *   - a refusal that outlasts the retries reaches the root
 *     `serviceBusyMiddleware`, which answers 503 with `Retry-After`
 *     and a static bilingual page in place of the 500 the router
 *     rendered;
 *   - any other error is not retried and its 500 is left alone;
 *   - the auth middleware's user read is retried the same way, and its
 *     refusal also ends in the 503 page.
 *
 * The D1 binding is a thin wrapper over the test D1 that throws the
 * overload error for statements whose SQL matches a pattern, a set
 * number of times, and counts how often those statements ran. Each
 * chain below runs the middlewares in the order the router does and,
 * like the router, turns an error thrown under them into a 500
 * response. Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { D1_READ_RETRY_WAITS_MS, isD1Overloaded } from "../../app/lib/d1-overload";
import { resolveRequestTenant } from "../../app/lib/tenant";
import { i18nextMiddleware } from "../../app/middleware/i18next";
import { authMiddleware } from "../../app/middleware/auth.server";
import { serviceBusyMiddleware } from "../../app/middleware/service-busy";
import { userContext } from "../../app/context";
import { handleError } from "../../app/entry.server";
import { resolveGrant } from "../../app/lib/federation.server";
import { findTenantById } from "../../app/lib/tenant";
import { createGrantUser } from "../helpers/auth";
import { createSessionStorage } from "../../app/sessions.server";

const OVERLOAD_MESSAGE =
  "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]";
const TENANT_BY_SLUG = /"tenants"\."slug" = \?/;
const USER_BY_ID = /from "users" where "users"\."id" = \?/;
const SESSION_SECRET = "test-session-secret";
const SIGN_IN = "https://neogranadina.fisqua.test/login";

/**
 * A D1 binding over the test D1 whose statements matching `pattern`
 * throw `error()` on their first `failures` executions (every
 * execution when `failures` is Infinity). `calls()` counts the
 * executions of matching statements, refused ones included.
 */
function refusingD1(pattern: RegExp, failures: number, error: () => Error = () => new Error(OVERLOAD_MESSAGE)) {
  let calls = 0;
  const wrapStatement = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "bind") {
          return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
        }
        if (["raw", "all", "first", "run"].includes(prop as string) && pattern.test(sql)) {
          return async (...args: unknown[]) => {
            calls += 1;
            if (calls <= failures) throw error();
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  const binding = new Proxy(env.DB as any, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sql: string) => wrapStatement(value.call(target, sql), sql);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { binding: binding as D1Database, calls: () => calls };
}

function contextWith(db: D1Database): any {
  const context = new RouterContextProvider();
  (context as any).cloudflare = { env: { ...env, DB: db, SESSION_SECRET } };
  return context;
}

/**
 * Runs `inner` the way the router runs a route: a thrown Response is the
 * answer; any other error goes to the app's `handleError` (as the
 * router's error handling does) and becomes a 500 HTML page, as a
 * document request's error does.
 */
async function asRouter(args: any, inner: () => Promise<unknown>): Promise<Response> {
  try {
    await inner();
    return new Response("page", { status: 200 });
  } catch (err) {
    if (err instanceof Response) return err;
    handleError(err, args);
    return new Response(`error page: ${String(err)}`, {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

/**
 * A D1 binding over the test D1 with one rule per pattern: a statement
 * matching a rule's pattern throws the overload error on that rule's
 * first `failures` executions. `calls(i)` counts rule i's executions.
 */
function countingD1(rules: Array<{ pattern: RegExp; failures: number }>) {
  const counts = rules.map(() => 0);
  const wrapStatement = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "bind") return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
        const i = rules.findIndex((r) => r.pattern.test(sql));
        if (["raw", "all", "first", "run"].includes(prop as string) && i !== -1) {
          return async (...args: unknown[]) => {
            counts[i] += 1;
            if (counts[i] <= rules[i].failures) throw new Error(OVERLOAD_MESSAGE);
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  const binding = new Proxy(env.DB as any, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") return (sql: string) => wrapStatement(value.call(target, sql), sql);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { binding: binding as D1Database, calls: (i: number) => counts[i] };
}

/** The root middlewares and then the /login loader, as a document request runs them. */
async function requestSignInPage(db: D1Database): Promise<Response> {
  const request = new Request(SIGN_IN);
  const context = contextWith(db);
  const args = { request, context, params: {} } as any;
  const { loader } = await import("../../app/routes/login");
  return (await serviceBusyMiddleware(args, async () =>
    (await i18nextMiddleware(args, () => asRouter(args, () => loader(args)))) as Response,
  )) as Response;
}

async function sessionCookie(userId: string): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(SESSION_SECRET);
  const session = await getSession();
  session.set("userId", userId);
  return commitSession(session);
}

describe("tenant lookup under D1 overload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("retries the tenant read and resolves once D1 accepts it", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, D1_READ_RETRY_WAITS_MS.length);
    const context = contextWith(d1.binding);
    const tenant = await resolveRequestTenant(context, drizzle(d1.binding), new Request(SIGN_IN));
    expect(tenant.id).toBe(DEFAULT_TEST_TENANT_ID);
    expect(d1.calls()).toBe(D1_READ_RETRY_WAITS_MS.length + 1);
  });

  it("gives up after the retries and rethrows the refusal", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity);
    const context = contextWith(d1.binding);
    await expect(
      resolveRequestTenant(context, drizzle(d1.binding), new Request(SIGN_IN)),
    ).rejects.toSatisfy(isD1Overloaded);
    expect(d1.calls()).toBe(D1_READ_RETRY_WAITS_MS.length + 1);
  });

  it("does not retry any other error", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity, () => new Error("D1_ERROR: no such table: tenants"));
    const context = contextWith(d1.binding);
    await expect(
      resolveRequestTenant(context, drizzle(d1.binding), new Request(SIGN_IN)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("no such table") } });
    expect(d1.calls()).toBe(1);
  });

  it("answers the sign-in page with a static 503 when the read stays refused", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity);
    const response = await requestSignInPage(d1.binding);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain("Fisqua is busy right now");
    expect(body).toContain("Try again in a few seconds.");
    expect(body).toContain("Fisqua está ocupado en este momento");
    expect(body).toContain("Intenta de nuevo en unos segundos.");
    expect(body).not.toMatch(/overloaded|7429|error page/i);
    // The i18next middleware and the loader share one lookup.
    expect(d1.calls()).toBe(D1_READ_RETRY_WAITS_MS.length + 1);
  });

  it("logs each refusal of the tenant read and the busy page it served", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await requestSignInPage(d1.binding);
      const logged = [...warn.mock.calls, ...error.mock.calls]
        .filter((args) => typeof args[0] === "string" && args[0].startsWith("{"))
        .map((args) => JSON.parse(String(args[0])));
      const reads = logged.filter((l) => l.event === "d1_overload");
      expect(reads.map((l) => [l.read, l.outcome, l.attempt, l.tenant, l.path])).toEqual([
        ["tenant_by_slug", "retry", 1, "neogranadina", "/login"],
        ["tenant_by_slug", "retry", 2, "neogranadina", "/login"],
        ["tenant_by_slug", "gave_up", 3, "neogranadina", "/login"],
      ]);
      expect(logged.filter((l) => l.event === "service_busy_503")).toEqual([
        expect.objectContaining({ reads: ["tenant_by_slug"], replaced_status: 500, path: "/login" }),
      ]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps an unrelated 500 after a swallowed overload of the language lookup", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity);
    const request = new Request(SIGN_IN);
    const context = contextWith(d1.binding);
    const args = { request, context, params: {} } as any;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The i18next middleware's lookup gives up and is swallowed; the
      // route then fails for a reason of its own.
      const response = (await serviceBusyMiddleware(args, async () =>
        (await i18nextMiddleware(args, () =>
          asRouter(args, async () => {
            throw new Error("D1_ERROR: no such column: unrelated");
          }),
        )) as Response,
      )) as Response;
      expect(d1.calls()).toBe(D1_READ_RETRY_WAITS_MS.length + 1);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("no such column");
      const busyLines = error.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("service_busy_503"),
      );
      expect(busyLines).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("leaves the 500 of any other error alone", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity, () => new Error("D1_ERROR: no such table: tenants"));
    const response = await requestSignInPage(d1.binding);
    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("leaves a page that rendered alone, even after a refused read", async () => {
    const d1 = refusingD1(TENANT_BY_SLUG, Infinity);
    const request = new Request(SIGN_IN);
    const context = contextWith(d1.binding);
    const args = { request, context, params: {} } as any;
    // The i18next middleware reads the workspace default and swallows
    // the refusal; the page under it needs no tenant and renders.
    const response = (await serviceBusyMiddleware(args, async () =>
      (await i18nextMiddleware(args, async () => new Response("page", { status: 200 }))) as Response,
    )) as Response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page");
  });
});

describe("auth middleware user read under D1 overload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("retries the user read and admits the request once D1 accepts it", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
    const d1 = refusingD1(USER_BY_ID, 1);
    const request = new Request("https://neogranadina.fisqua.test/dashboard", {
      headers: { Cookie: await sessionCookie(user.id) },
    });
    const context = contextWith(d1.binding);
    await authMiddleware({ request, context, params: {} } as any, async () => undefined);
    expect(context.get(userContext).id).toBe(user.id);
  });

  it("answers 503 when the user read stays refused", async () => {
    const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
    const d1 = refusingD1(USER_BY_ID, Infinity);
    const request = new Request("https://neogranadina.fisqua.test/dashboard?lang=en", {
      headers: { Cookie: await sessionCookie(user.id) },
    });
    const context = contextWith(d1.binding);
    const args = { request, context, params: {} } as any;
    const response = (await serviceBusyMiddleware(args, async () =>
      (await i18nextMiddleware(args, () =>
        asRouter(args, async () => authMiddleware(args, async () => new Response("page"))),
      )) as Response,
    )) as Response;
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(d1.calls()).toBeGreaterThanOrEqual(D1_READ_RETRY_WAITS_MS.length + 1);
  });
});

describe("grant resolution under D1 overload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("retries the refused membership read without reading the federation again", async () => {
    const user = await createGrantUser("staff");
    const tenant = await findTenantById(drizzle(env.DB), DEFAULT_TEST_TENANT_ID);
    const d1 = countingD1([
      { pattern: /from "federations"/, failures: 0 },
      { pattern: /from "federation_memberships"/, failures: 2 },
    ]);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const grant = await resolveGrant(drizzle(d1.binding), user, tenant!);
      expect(grant?.role).toBe("staff");
    } finally {
      quiet.mockRestore();
    }
    expect(d1.calls(0)).toBe(1);
    expect(d1.calls(1)).toBe(3);
  });
});

describe("the app's handleError", () => {
  it("logs the error as React Router's default handler does, and records only an overload", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const request = new Request(SIGN_IN);
      const other = new RouterContextProvider();
      const unrelated = new Error("unrelated");
      handleError(unrelated, { request, params: {}, context: other } as any);
      expect(error).toHaveBeenCalledWith(unrelated);
    } finally {
      error.mockRestore();
    }
  });
});

// @version v0.9.0
