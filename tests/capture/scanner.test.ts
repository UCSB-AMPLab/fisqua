/**
 * Tests — the Scanner screen and its token actions
 *
 * This suite drives the Scanner page's loader and action, and the
 * capture link's `authenticate`, against the Workers test database. It
 * pins:
 *
 *   - access: the digitization capability (a bare 404 from the loader
 *     and the action when off, even for an admin), tenant admins and
 *     federation stewards only (a bare 403 for anyone else, who can
 *     change nothing);
 *   - each token state and transition: none, made (the token returned
 *     once), active, revoked, made again; replace and revoke refused
 *     without the confirmation, and every action refused on a stale page;
 *   - the hash: only the token's SHA-256 is stored, and the token appears
 *     in no table, no loader answer and no audit row;
 *   - replace is one write: the old token is refused by the link at once
 *     and the new one accepted; revoke refuses the link;
 *   - the audit rows: one `scanner_token` row per action that changed the
 *     scanner, naming the actor, their home tenant, the tenant and the
 *     step, and none for a refused or stale action;
 *   - the last call: recorded by the statement that counts the call, with
 *     no write of its own, and not by a refused call;
 *   - the unit's name: asked when Make token creates the scanner, checked
 *     by the command's rule, and not asked again;
 *   - revisions: every token write raises the scanner's revision, a page
 *     from before any of them is stale, and of two revokes on one page
 *     one wins and only it is audited;
 *   - a document post (no JavaScript), through React Router's request
 *     handler: answered with `private, no-store`, and refused before the
 *     action runs when its Origin is another host's.
 *
 * Every value here is a test value: no real tenant, unit or token.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedFederations,
  DEFAULT_TEST_FEDERATION_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { insertRow } from "../helpers/media-pipeline";
import { hashScannerToken } from "../../app/lib/capture/token";
import { authenticate } from "../../app/lib/capture/link.server";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type GrantState,
  type Tenant,
  type User,
} from "../../app/context";
import { loader, action } from "../../app/routes/_auth.admin.capture.scanner";

const T0 = 1_800_000_000_000;
const HOST = "https://neogranadina.fisqua.test";
const UNIT = "rig-1";

async function person(opts: { tenantId?: string; isAdmin?: boolean; name?: string } = {}): Promise<User> {
  const row = await createTestUser({ tenantId: opts.tenantId, isAdmin: opts.isAdmin, name: opts.name });
  return makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: row.isAdmin });
}

function context(user: User, tenant: Tenant, grant: GrantState | null = null): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  ctx.set(grantContext, grant);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env };
  return ctx;
}

const on = (overrides: Partial<Tenant> = {}) => makeTenantContext({ digitizationEnabled: true, ...overrides });

async function status(p: Promise<unknown>): Promise<number> {
  try {
    const value: any = await p;
    return value?.init?.status ?? 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

function load(user: User, tenant: Tenant = on()) {
  return loader({ request: new Request(`${HOST}/admin/capture/scanner`), context: context(user, tenant), params: {} } as any);
}

async function post(
  user: User,
  fields: Record<string, string>,
  opts: { tenant?: Tenant; grant?: GrantState | null } = {},
): Promise<{ status: number; body: any }> {
  const request = new Request(`${HOST}/admin/capture/scanner`, { method: "POST", body: new URLSearchParams(fields) });
  const answer: any = await action({
    request,
    context: context(user, opts.tenant ?? on(), opts.grant ?? null),
    params: {},
  } as any);
  return { status: answer.init?.status ?? 200, body: answer.data };
}

/** Posts an action against the scanner as the page would show it now. */
async function act(user: User, intent: "make" | "replace" | "revoke", opts: { confirm?: boolean; grant?: GrantState | null } = {}) {
  const { scanner, version } = await load(world.admin);
  const fields: Record<string, string> = { intent, seen: version };
  if (intent === "make" && !scanner) fields.name = UNIT;
  if (opts.confirm ?? intent !== "make") fields.confirm = "yes";
  return post(user, fields, { grant: opts.grant });
}

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

const scanners = () => sqlRows("SELECT * FROM capture_scanners WHERE tenant_id = ?", DEFAULT_TEST_TENANT_ID);
const audits = () =>
  sqlRows("SELECT * FROM audit_log WHERE action = 'scanner_token' ORDER BY created_at, rowid");

/** The link's authentication of a call with this token, as the unit makes it. */
async function call(token: string, opts: { now?: number; db?: any } = {}): Promise<number> {
  const request = new Request(`${HOST}/api/capture/v1/volumes/status?refs=co-test-001`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await authenticate(
    {
      db: opts.db ?? drizzle(env.DB),
      env: {},
      fetch: async () => new Response(null, { status: 599 }),
      now: () => opts.now ?? T0,
      newId: () => crypto.randomUUID(),
    },
    request,
  );
  return result instanceof Response ? result.status : 200;
}

interface World {
  admin: User;
  steward: User;
  outsider: User;
}

let world: World;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  const admin = await person({ isAdmin: true, name: "Test Admin" });
  const outsider = await person({ name: "Test Outsider" });
  // A steward of the default tenant's federation whose home is another tenant.
  const steward = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Steward" });
  await insertRow("federation_memberships", {
    id: crypto.randomUUID(),
    user_id: steward.id,
    federation_id: DEFAULT_TEST_FEDERATION_ID,
    role: "steward",
    created_at: T0,
  });
  world = { admin, steward, outsider };
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("access", () => {
  it("404s the page and the action when the capability is off, even for an admin, and writes nothing", async () => {
    const off = makeTenantContext({ digitizationEnabled: false });
    expect(await status(load(world.admin, off))).toBe(404);
    expect(await status(post(world.admin, { intent: "make", seen: "none" }, { tenant: off }))).toBe(404);
    expect(await scanners()).toEqual([]);
  });

  it("opens the page to admins and stewards, and 403s anyone else", async () => {
    expect(await status(load(world.admin))).toBe(200);
    expect(await status(load(world.steward))).toBe(200);
    expect(await status(load(world.outsider))).toBe(403);
  });

  it("refuses the action to anyone else, and writes nothing", async () => {
    expect(await status(post(world.outsider, { intent: "make", seen: "none" }))).toBe(403);
    expect(await scanners()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("lets a steward make the token", async () => {
    const made = await act(world.steward, "make", {
      grant: { role: "steward", federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID },
    });
    expect(made.status).toBe(200);
    expect(made.body.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// States and transitions
// ---------------------------------------------------------------------------

describe("token states", () => {
  it("shows no scanner before the first token", async () => {
    const page = await load(world.admin);
    expect(page).toEqual({ scanner: null, version: "none", workspace: "Neogranadina" });
  });

  it("make creates the scanner with the unit's name, and returns the token once", async () => {
    const made = await act(world.admin, "make");
    expect(made).toEqual({ status: 200, body: { ok: true, step: "create", token: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const [row] = await scanners();
    expect(row.name).toBe(UNIT);
    expect(row.revision).toBe(1);

    const page = await load(world.admin);
    expect(page.scanner).toMatchObject({
      name: UNIT,
      tokenState: "active",
      deviceState: "waiting",
      lastSeenAt: null,
      revokedAt: null,
    });
    expect(page.scanner!.tokenCreatedAt).toEqual(expect.any(Number));
  });

  it("goes from waiting to linked on the unit's first call", async () => {
    const { body } = await act(world.admin, "make");
    expect(await call(body.token, { now: T0 + 1000 })).toBe(200);
    const page = await load(world.admin);
    expect(page.scanner).toMatchObject({ tokenState: "active", deviceState: "linked", lastSeenAt: T0 + 1000 });
  });

  it("refuses make while the token is live", async () => {
    await act(world.admin, "make");
    const again = await act(world.admin, "make");
    expect(again).toEqual({ status: 409, body: { ok: false, error: "live_token" } });
  });

  it("refuses replace and revoke without the confirmation", async () => {
    await act(world.admin, "make");
    const before = await scanners();
    expect(await act(world.admin, "replace", { confirm: false })).toEqual({
      status: 400,
      body: { ok: false, error: "unconfirmed" },
    });
    expect(await act(world.admin, "revoke", { confirm: false })).toEqual({
      status: 400,
      body: { ok: false, error: "unconfirmed" },
    });
    expect(await scanners()).toEqual(before);
  });

  it("refuses an action taken on a stale page, and writes nothing", async () => {
    const stale = (await load(world.admin)).version;
    await act(world.admin, "make");
    const before = await scanners();
    const answer = await post(world.admin, { intent: "replace", seen: stale, confirm: "yes" });
    expect(answer).toEqual({ status: 409, body: { ok: false, error: "changed" } });
    expect(await scanners()).toEqual(before);
    expect(await audits()).toHaveLength(1);
  });

  it("refuses replace and revoke when there is no live token", async () => {
    expect((await act(world.admin, "replace")).body).toEqual({ ok: false, error: "no_scanner" });
    await act(world.admin, "make");
    await act(world.admin, "revoke");
    expect((await act(world.admin, "replace")).body).toEqual({ ok: false, error: "no_live_token" });
    expect((await act(world.admin, "revoke")).body).toEqual({ ok: false, error: "no_live_token" });
  });

  it("refuses an unknown intent", async () => {
    expect(await post(world.admin, { intent: "delete", seen: "none" })).toEqual({
      status: 400,
      body: { ok: false, error: "invalid_request" },
    });
  });

  it("revoke keeps the hash, refuses the link and shows the revoked state; make gives a new token", async () => {
    const { body } = await act(world.admin, "make");
    await call(body.token, { now: T0 + 1000 });
    const revoked = await act(world.admin, "revoke");
    expect(revoked).toEqual({ status: 200, body: { ok: true, step: "revoke" } });

    const [row] = await scanners();
    expect(row.token_sha256).toBe(await hashScannerToken(body.token));
    expect(row.revoked_at).toEqual(expect.any(Number));
    expect(await call(body.token)).toBe(403);

    const page = await load(world.admin);
    expect(page.scanner).toMatchObject({ tokenState: "revoked", deviceState: "revoked", lastSeenAt: T0 + 1000 });
    expect(page.scanner!.revokedAt).toBe(row.revoked_at);

    const again = await act(world.admin, "make");
    expect(again.body).toMatchObject({ ok: true, step: "issue" });
    expect(await call(again.body.token)).toBe(200);
    expect(await call(body.token)).toBe(401);
    expect((await load(world.admin)).scanner).toMatchObject({ tokenState: "active" });
  });
});

// ---------------------------------------------------------------------------
// Replace
// ---------------------------------------------------------------------------

describe("replace", () => {
  it("puts the new hash in place of the old in one write: the old token is refused at once, the new one accepted", async () => {
    const first = (await act(world.admin, "make")).body.token as string;
    expect(await call(first, { now: T0 + 1000 })).toBe(200);
    const replaced = await act(world.admin, "replace");
    expect(replaced.body).toEqual({ ok: true, step: "replace", token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const second = replaced.body.token as string;
    expect(second).not.toBe(first);

    expect(await call(first)).toBe(401);
    expect(await call(second)).toBe(200);
    const rows = await scanners();
    expect(rows).toHaveLength(1);
    expect(rows[0].token_sha256).toBe(await hashScannerToken(second));
    expect(rows[0].revoked_at).toBeNull();
  });

  it("clears the last call, which belonged to the old token", async () => {
    const first = (await act(world.admin, "make")).body.token as string;
    await call(first, { now: T0 + 1000 });
    await act(world.admin, "replace");
    expect((await load(world.admin)).scanner).toMatchObject({ deviceState: "waiting", lastSeenAt: null });
  });
});

// ---------------------------------------------------------------------------
// The hash, and nothing else
// ---------------------------------------------------------------------------

describe("what is kept", () => {
  it("stores only the token's hash; the token is in no table, loader answer or audit row", async () => {
    const tokens: string[] = [];
    tokens.push((await act(world.admin, "make")).body.token);
    tokens.push((await act(world.admin, "replace")).body.token);
    await act(world.admin, "revoke");
    tokens.push((await act(world.admin, "make")).body.token);

    const [row] = await scanners();
    expect(row.token_sha256).toBe(await hashScannerToken(tokens[2]));

    const tables = await sqlRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
    for (const { name } of tables) {
      let rows: Array<Record<string, any>>;
      try {
        rows = await sqlRows(`SELECT * FROM "${name}"`);
      } catch {
        continue; // virtual-table shadows that cannot be read whole
      }
      const text = JSON.stringify(rows);
      for (const token of tokens) expect(text.includes(token), `${name} holds a token`).toBe(false);
    }

    const page = JSON.stringify(await load(world.admin));
    for (const token of tokens) expect(page.includes(token)).toBe(false);
    expect(page.includes(row.token_sha256)).toBe(false);

    const audit = JSON.stringify(await audits());
    for (const token of tokens) expect(audit.includes(token)).toBe(false);
    for (const token of tokens) expect(audit.includes(await hashScannerToken(token))).toBe(false);
  });

  it("answers with no-store, so no cache keeps the token", async () => {
    const request = new Request(`${HOST}/admin/capture/scanner`, {
      method: "POST",
      body: new URLSearchParams({ intent: "make", seen: "none", name: UNIT }),
    });
    const answer: any = await action({ request, context: context(world.admin, on()), params: {} } as any);
    expect(answer.data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Headers(answer.init.headers).get("Cache-Control")).toBe("private, no-store");
  });
});

// ---------------------------------------------------------------------------
// The audit rows
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("records each action that changed the scanner, with the actor, the tenant and the step", async () => {
    await act(world.admin, "make");
    await act(world.admin, "make"); // refused: live token
    await act(world.admin, "replace");
    await act(world.steward, "revoke", {
      grant: { role: "steward", federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID },
    });
    const [scanner] = await scanners();
    const rows = await audits();
    expect(rows.map((r) => [r.actor_user_id, r.actor_user_id_text, r.actor_tenant_id, JSON.parse(r.details)])).toEqual([
      [world.admin.id, world.admin.email, DEFAULT_TEST_TENANT_ID, { step: "create", name: UNIT }],
      [world.admin.id, world.admin.email, DEFAULT_TEST_TENANT_ID, { step: "replace", name: UNIT }],
      [world.steward.id, world.steward.email, SECOND_TEST_TENANT_ID, { step: "revoke", name: UNIT }],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({
        action: "scanner_token",
        target_tenant_id: DEFAULT_TEST_TENANT_ID,
        target_object_kind: "capture_scanner",
        target_object_id: scanner.id,
        impersonation_session_id: null,
      });
      expect(r.created_at).toEqual(expect.any(Number));
    }
  });

  it("records nothing for a refused action", async () => {
    await post(world.admin, { intent: "revoke", seen: "none", confirm: "yes" });
    await post(world.admin, { intent: "replace", seen: "none" });
    await post(world.outsider, { intent: "make", seen: "none" }).catch(() => undefined);
    expect(await audits()).toEqual([]);
  });

  it("records nothing when the scanner changed between the read and the write", async () => {
    // A second Make racing the first: both read no scanner; the INSERT's
    // guard lets one in, and the other's audit row has nothing to stand on.
    const [a, b] = await Promise.all([
      post(world.admin, { intent: "make", seen: "none", name: UNIT }),
      post(world.admin, { intent: "make", seen: "none", name: UNIT }),
    ]);
    const winners = [a, b].filter((x) => x.body.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(await scanners()).toHaveLength(1);
    expect(await audits()).toHaveLength(winners.length);
    for (const loser of [a, b].filter((x) => !x.body.ok)) {
      expect(loser.body.token).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The last call
// ---------------------------------------------------------------------------

describe("the last call", () => {
  it("is recorded on every authenticated call by the statement that counts it, with no write of its own", async () => {
    const token = (await act(world.admin, "make")).body.token as string;
    const writes: string[] = [];
    const logged = drizzle(env.DB, {
      logger: { logQuery: (query: string) => (/^\s*update\b/i.test(query) ? writes.push(query) : undefined) },
    });

    expect(await call(token, { now: T0 + 1000, db: logged })).toBe(200);
    expect(await call(token, { now: T0 + 31_000, db: logged })).toBe(200);
    expect(writes).toHaveLength(2);
    for (const q of writes) {
      expect(q).toMatch(/"last_seen_at"/);
      expect(q).toMatch(/"rate_window_calls"/);
    }
    const [row] = await scanners();
    expect(row.last_seen_at).toBe(T0 + 31_000);
    expect(row.rate_window_calls).toBe(2);
  });

  it("is not recorded by a refused call", async () => {
    const token = (await act(world.admin, "make")).body.token as string;
    await act(world.admin, "revoke");
    expect(await call(token, { now: T0 + 1000 })).toBe(403);
    expect(await call("0".repeat(64), { now: T0 + 2000 })).toBe(401);
    const [row] = await scanners();
    expect(row.last_seen_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The unit's name
// ---------------------------------------------------------------------------

describe("the unit's name", () => {
  it("is required, by the command's rule, when Make token creates the scanner", async () => {
    for (const name of [undefined, "", "Rig_1", "a".repeat(33)]) {
      const fields: Record<string, string> = { intent: "make", seen: "none" };
      if (name !== undefined) fields.name = name;
      expect(await post(world.admin, fields)).toEqual({ status: 400, body: { ok: false, error: "invalid_name" } });
    }
    expect(await scanners()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("is not asked again once the scanner exists; one sent is ignored", async () => {
    await act(world.admin, "make");
    await act(world.admin, "revoke");
    const { version } = await load(world.admin);
    const again = await post(world.admin, { intent: "make", seen: version, name: "other-unit" });
    expect(again.body).toMatchObject({ ok: true, step: "issue" });
    expect((await scanners())[0].name).toBe(UNIT);
  });
});

// ---------------------------------------------------------------------------
// Revisions and races
// ---------------------------------------------------------------------------

describe("revisions", () => {
  it("raises the revision on every token write, so a page from before any of them is stale", async () => {
    await act(world.admin, "make");
    const first = (await load(world.admin)).version;
    await act(world.admin, "replace");
    await act(world.admin, "revoke");
    const [row] = await scanners();
    expect(row.revision).toBe(3);
    expect((await load(world.admin)).version).toBe(`${row.id}:3`);
    expect(await post(world.admin, { intent: "make", seen: first })).toEqual({
      status: 409,
      body: { ok: false, error: "changed" },
    });
  });

  it("lets one of two revokes on the same page win, and audits only that one", async () => {
    await act(world.admin, "make");
    const { version } = await load(world.admin);
    const answers = await Promise.all([
      post(world.admin, { intent: "revoke", seen: version, confirm: "yes" }),
      post(world.admin, { intent: "revoke", seen: version, confirm: "yes" }),
    ]);
    expect(answers.map((a) => a.body).sort((a, b) => Number(b.ok) - Number(a.ok))).toEqual([
      { ok: true, step: "revoke" },
      { ok: false, error: "changed" },
    ]);
    const revokes = (await audits()).filter((r) => JSON.parse(r.details).step === "revoke");
    expect(revokes).toHaveLength(1);
    expect((await scanners())[0].revision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A document post, through React Router's request handler
// ---------------------------------------------------------------------------

/**
 * A server build holding a bare root and the Scanner route, whose
 * document entry answers with the action's data as JSON and the headers
 * React Router gives the document, so a post made without JavaScript can
 * be driven end to end.
 */
async function documentPost(fields: Record<string, string>, origin: string | null) {
  const { createRequestHandler } = await import("react-router");
  const route = await import("../../app/routes/_auth.admin.capture.scanner");
  const build: any = {
    entry: {
      module: {
        default: (_request: Request, status: number, headers: Headers, routerContext: any) =>
          new Response(JSON.stringify(routerContext.staticHandlerContext.actionData ?? null), { status, headers }),
      },
    },
    routes: {
      root: { id: "root", path: "", module: { default: () => null } },
      scanner: { id: "scanner", parentId: "root", path: "admin/capture/scanner", module: route },
    },
    assets: { entry: { module: "/entry.js", imports: [] }, routes: {}, url: "/manifest.js", version: "test" },
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    future: { v8_middleware: true },
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
  };
  const handler = createRequestHandler(build, "production");
  const headers: Record<string, string> = { Host: new URL(HOST).host, "Content-Type": "application/x-www-form-urlencoded" };
  if (origin) headers.Origin = origin;
  const request = new Request(`${HOST}/admin/capture/scanner`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
  return handler(request, context(world.admin, on()));
}

describe("a document post", () => {
  it("answers with private, no-store, though its HTML would hold the new token", async () => {
    const res = await documentPost({ intent: "make", seen: "none", name: UNIT }, HOST);
    const body = (await res.json()) as Record<string, any>;
    const token = Object.values(body)[0]?.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("is refused before the action runs when its Origin is another host's", async () => {
    const res = await documentPost({ intent: "make", seen: "none", name: UNIT }, "https://second-tenant.fisqua.test");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await scanners()).toEqual([]);
    expect(await audits()).toEqual([]);
  });
});

// @version v0.8.0
