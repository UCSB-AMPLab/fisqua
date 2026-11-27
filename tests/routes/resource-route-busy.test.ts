/**
 * Tests — the busy answer on a resource route, through React Router's request handler
 *
 * This suite pins the busy answer on a resource route, through React
 * Router's request handler. On a resource route (a route with no
 * component, such as /api/publish) React Router 7 runs the middleware
 * chain with an error handler that rethrows, so an error thrown by a
 * middleware (the auth middleware's reads after their retries) propagates
 * out of `await next()` in the root `serviceBusyMiddleware`. The router's
 * resource handler then builds its own 500 outside the middleware. The
 * suite pins that the root middleware catches such an error when it is a
 * D1 overload refusal and answers a 503 with `Retry-After` and the
 * `service_busy_503` log line, and lets any other error through to the
 * router's 500.
 *
 * The requests go through the real `createRequestHandler` from
 * react-router, with the real root, `_auth` layout and /api/publish
 * route modules and the app's `handleError`, as children of one another
 * as `app/routes.ts` nests them. What it does not cover: the build the
 * Vite plugin writes (`virtual:react-router/server-build` cannot be
 * resolved in the test pool), so the route tree here is the three
 * routes on the path, not the whole manifest; the Worker entry
 * (`workers/app.ts`) and its same-origin checks; and document
 * rendering, which a resource route never reaches. The D1 binding
 * refuses the auth middleware's user read as overloaded on every
 * attempt, or fails it with another error.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createSessionStorage } from "../../app/sessions.server";
import * as entry from "../../app/entry.server";
import * as rootModule from "../../app/root";
import * as authLayout from "../../app/routes/_auth";
import * as publishRoute from "../../app/routes/api.publish";

const SESSION_SECRET = "test-session-secret";
const OVERLOAD_MESSAGE =
  "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]";
const USER_BY_ID = /from "users" where "users"\."id" = \?/;

/** A D1 binding over the test D1 whose statements matching `pattern` always throw `error()`. */
function failingD1(pattern: RegExp, error: () => Error): D1Database {
  const wrapStatement = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "bind") return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
        if (["raw", "all", "first", "run"].includes(prop as string) && pattern.test(sql)) {
          return async () => {
            throw error();
          };
        }
        return value.bind(target);
      },
    });
  return new Proxy(env.DB as any, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") return (sql: string) => wrapStatement(value.call(target, sql), sql);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** The three routes on the path to /api/publish, nested as app/routes.ts nests them. */
const handler = createRequestHandler(
  {
    entry: { module: entry as any },
    routes: {
      root: { id: "root", path: "", module: rootModule as any },
      "routes/_auth": { id: "routes/_auth", parentId: "root", module: authLayout as any },
      "routes/api.publish": {
        id: "routes/api.publish",
        parentId: "routes/_auth",
        path: "api/publish",
        module: publishRoute as any,
      },
    },
    assets: { version: "test", url: "/assets/manifest.js", entry: { module: "/entry.js", imports: [] }, routes: {} },
    future: { v8_middleware: true, unstable_trailingSlashAwareDataRequests: false } as any,
    basename: "/",
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
  } as any,
  "production",
);

async function publishRequest(db: D1Database, init: RequestInit = {}): Promise<Response> {
  const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  const { getSession, commitSession } = createSessionStorage(SESSION_SECRET);
  const session = await getSession();
  session.set("userId", user.id);
  const cookie = await commitSession(session);
  const request = new Request("https://neogranadina.fisqua.test/api/publish", {
    ...init,
    headers: { Cookie: cookie, "cf-ray": "8f0a1b2c3d4e5f60-BOG", ...(init.headers as Record<string, string>) },
  });
  const context = new RouterContextProvider();
  (context as any).cloudflare = {
    env: { ...env, DB: db, SESSION_SECRET },
    ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
  };
  return handler(request, context);
}

/** Console lines written as JSON objects. */
function jsonLines(spies: Array<ReturnType<typeof vi.spyOn>>): Array<Record<string, any>> {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .filter((args) => typeof args[0] === "string" && args[0].startsWith("{"))
    .map((args) => JSON.parse(args[0] as string));
}

describe("resource route /api/publish when the auth middleware's reads fail", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it.each([["GET"], ["POST"]])("answers %s with a JSON 503 and Retry-After when D1 is overloaded", async (method) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await publishRequest(
        failingD1(USER_BY_ID, () => new Error(OVERLOAD_MESSAGE)),
        method === "POST"
          ? { method, body: "{}", headers: { "Content-Type": "application/json", Origin: "https://neogranadina.fisqua.test" } }
          : { method },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("10");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "service_busy" });
      const busy = jsonLines([warn, error]).filter((l) => l.event === "service_busy_503");
      expect(busy).toEqual([
        expect.objectContaining({
          method,
          path: "/api/publish",
          tenant: "neogranadina",
          reads: ["user_by_session"],
          replaced_status: 500,
          from: "thrown",
        }),
      ]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("leaves the router's 500 for any other error, and writes no busy line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await publishRequest(
        failingD1(USER_BY_ID, () => new Error("D1_ERROR: no such table: users")),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(jsonLines([warn, error]).filter((l) => l.event === "service_busy_503")).toEqual([]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// @version v0.9.0
