/**
 * Tests — the busy answer when the signed-in layout's reads are refused
 *
 * This suite pins the busy answer when the signed-in layout's reads are
 * refused. The `_auth` layout's loader reads the sidebar payload: whether
 * the person holds a project membership on this workspace, what kind of
 * member they are (`memberAccess`), who they are to capture work
 * (`captureAccess`), the pending-decision counts on the duplicates
 * worklist, and the workspaces the switcher offers. The suite pins that a
 * page under the layout answers 503 with `Retry-After`, and writes one
 * `gave_up` line naming the read and one `service_busy_503` line, when D1
 * refuses one of those reads as overloaded on every attempt; and that it
 * answers 200, with a `retry` and a `recovered` line, when D1 refuses the
 * read once and then serves it.
 *
 * The requests go through the real `createRequestHandler` from
 * react-router, with the real root and `_auth` layout modules and the
 * app's `handleError`, under stub child pages at /dashboard and
 * /admin/decisions/duplicates whose loaders read nothing, so the only
 * reads are the middleware's and the layout's. Each case is asked for
 * as a document and as a client navigation (`.data`). Pages render no
 * scripts here, since the server build is a virtual module the test
 * pool cannot resolve (see `tests/routes/resource-route-busy.test.ts`).
 * The person is a workspace admin, whom `memberAccess` sorts without
 * reading, except in the member-access case, where a cataloguer on one
 * of the workspace's projects is asked for.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createSessionStorage } from "../../app/sessions.server";
import { SERVICE_BUSY_MARKER } from "../../app/lib/service-busy-marker";
import * as entry from "../../app/entry.server";
import * as rootModule from "../../app/root";
import * as authLayout from "../../app/routes/_auth";

const SESSION_SECRET = "test-session-secret";
const OVERLOAD_MESSAGE =
  "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]";

type Case = {
  /** The read's name in the overload log. */
  read: string;
  /** A pattern on the refused statement's SQL. */
  sql: RegExp;
  path: string;
  /** Who asks: a workspace admin, or a cataloguer on one project. */
  who?: "admin" | "member";
  digitization?: boolean;
};

const DUPLICATES = "/admin/decisions/duplicates";

const CASES: Case[] = [
  { read: "layout_project_membership", sql: /from "project_members" inner join "projects"/, path: "/dashboard" },
  { read: "layout_platform_admin", sql: /select "is_platform_admin" from "users"/, path: "/dashboard" },
  { read: "layout_federation_grants", sql: /select "federation_id" from "federation_memberships"/, path: "/dashboard" },
  { read: "member_federation_membership", sql: /select "id" from "federation_memberships"/, path: "/dashboard", who: "member" },
  { read: "capture_reviewer_assignment", sql: /from "capture_qc_reviewers"/, path: "/dashboard", digitization: true },
  { read: "duplicate_badge_stored", sql: /FROM duplicate_candidates/, path: DUPLICATES },
  { read: "duplicate_badge_place_groups", sql: /GROUP BY lower/, path: DUPLICATES },
  { read: "pending_authority_proposals", sql: /from "pending_decisions"/, path: DUPLICATES },
  { read: "pending_vocabulary_proposals", sql: /from "vocabulary_terms"/, path: DUPLICATES },
];

/**
 * A D1 binding over the test D1 whose statements matching `pattern`
 * throw an overload refusal the first `times` times they run.
 */
function refusingD1(pattern: RegExp, times: number): D1Database {
  let refused = 0;
  const wrapStatement = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "bind") return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
        if (["raw", "all", "first", "run"].includes(prop as string) && pattern.test(sql)) {
          return async (...args: unknown[]) => {
            if (refused < times) {
              refused += 1;
              throw new Error(OVERLOAD_MESSAGE);
            }
            return value.apply(target, args);
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

/** A page under the layout whose loader reads nothing. */
const pageStub = {
  loader: () => ({ ok: true }),
  default: () => null,
};

const handler = createRequestHandler(
  {
    entry: { module: entry as any },
    routes: {
      root: { id: "root", path: "", module: rootModule as any },
      "routes/_auth": { id: "routes/_auth", parentId: "root", module: authLayout as any },
      "routes/_auth.admin.decisions.duplicates": {
        id: "routes/_auth.admin.decisions.duplicates",
        parentId: "routes/_auth",
        path: "admin/decisions/duplicates",
        module: pageStub as any,
      },
      "routes/_auth.dashboard": {
        id: "routes/_auth.dashboard",
        parentId: "routes/_auth",
        path: "dashboard",
        module: pageStub as any,
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

/** A cataloguer on one of the default workspace's projects, who is staff to `memberAccess` only by that membership. */
async function createProjectMember(): Promise<{ id: string }> {
  const user = await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: false });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO projects (id, tenant_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(projectId, DEFAULT_TEST_TENANT_ID, "Test project", user.id, now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO project_members (id, project_id, user_id, role, created_at) VALUES (?, ?, ?, 'cataloguer', ?)",
  )
    .bind(crypto.randomUUID(), projectId, user.id, now)
    .run();
  return user;
}

async function pageRequest(db: D1Database, path: string, c: Case): Promise<Response> {
  if (c.digitization) {
    await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?")
      .bind(DEFAULT_TEST_TENANT_ID)
      .run();
  }
  const user =
    c.who === "member"
      ? await createProjectMember()
      : await createTestUser({ tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
  const { getSession, commitSession } = createSessionStorage(SESSION_SECRET);
  const session = await getSession();
  session.set("userId", user.id);
  const cookie = await commitSession(session);
  const request = new Request(`https://neogranadina.fisqua.test${path}`, {
    headers: {
      Cookie: cookie,
      "cf-ray": "8f0a1b2c3d4e5f60-BOG",
      Accept: "text/html",
      "Sec-Fetch-Dest": path.endsWith(".data") ? "empty" : "document",
    },
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

describe("a page under the signed-in layout when the layout's reads are refused", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  const runs = CASES.flatMap((c) => [
    [`${c.read} (document)`, c, c.path] as const,
    [`${c.read} (.data)`, c, `${c.path}.data`] as const,
  ]);

  it.each(runs)("answers 503 when %s is refused on every attempt", async (_label, c, path) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await pageRequest(refusingD1(c.sql, Number.POSITIVE_INFINITY), path, c);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("10");
      const body = await response.text();
      if (path.endsWith(".data")) expect(body).toBe(SERVICE_BUSY_MARKER);
      else expect(body).toContain("<!DOCTYPE html>");
      const lines = jsonLines([warn, error]);
      expect(
        lines.filter((l) => l.event === "d1_overload" && l.outcome === "gave_up").map((l) => l.read),
      ).toEqual([c.read]);
      expect(lines.filter((l) => l.event === "service_busy_503")).toEqual([
        expect.objectContaining({ reads: [c.read], replaced_status: 500 }),
      ]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it.each(runs)("answers 200 when %s is refused once and then served", async (_label, c, path) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await pageRequest(refusingD1(c.sql, 1), path, c);
      expect(response.status).toBe(200);
      const lines = jsonLines([warn, error]).filter((l) => l.event === "d1_overload");
      expect(lines.map((l) => [l.read, l.outcome])).toEqual([
        [c.read, "retry"],
        [c.read, "recovered"],
      ]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// @version v0.9.0
