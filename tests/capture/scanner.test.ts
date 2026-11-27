/**
 * Tests — the Scanner screen and its token actions
 *
 * This suite drives the Scanner page's loader and action, and the
 * capture link's `authenticate`, against the Workers test database. It
 * pins:
 *
 *   - access: the digitization capability (a bare 404 from the loader
 *     and the action when off, even for an admin); the page to tenant
 *     admins, federation stewards and federation staff grants, the
 *     token's controls (`canManage`) and actions to admins and stewards
 *     only; a staff grant reads the page and changes nothing (a bare
 *     403); a bare 403 for anyone else, who can change nothing;
 *   - the linked unit's name and device id in the scanner the loader
 *     gives, null until the scanner holds them; the stored keys' state
 *     only to those who manage;
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
 *   - the appliance id: asked when Make token creates the scanner, checked
 *     by the command's rule, and not asked again;
 *   - revisions: every token write raises the scanner's revision, a page
 *     from before any of them is stale, and of two revokes on one page
 *     one wins and only it is audited;
 *   - pairing a unit by its code: looking a code up shows the unit's
 *     name, device id and reported workspace, and whether approving cuts
 *     off a linked unit; approving binds the code to the workspace and is
 *     audited; both are refused to a staff grant, without stored keys,
 *     for a code that is unknown, expired or approved elsewhere; past
 *     five wrong entries by one user in ten minutes, or twenty in the
 *     workspace in an hour, every entry, right or wrong, lookup or
 *     approval, is refused without looking the code up, and the code
 *     stays waiting; a wrong approval counts against the user and the
 *     workspace as a wrong lookup does; of several wrong entries sent at
 *     once past a count of four, one is answered with its own error and
 *     the rest `pair_limited`; a refused entry, alone or sent at once
 *     with others, leaves the user's and the workspace's counts as they
 *     were; a right entry, and re-entering
 *     a code this workspace approved, leave the counts as they were;
 *     stored keys that do not open, no private key, or a pairing
 *     environment other than exactly production or staging, are
 *     `pair_keys_unreadable`
 *     (503), with nothing written or counted and a fixed log line; an
 *     approval whose guarded write did not land is not audited;
 *   - revoke reasons and erasing the stored keys: a revoke needs a
 *     reason; a compromised revoke erases the stored keys in its own
 *     batch, only where the revoke landed, including keys stored again
 *     between the read and the batch; `erase_keys` erases without
 *     touching the scanner; each erasure is audited only where it
 *     landed, and the answer says whether keys were erased;
 *   - the notice: after every landed compromised revoke, whether or not
 *     it erased anything, and after every erasure, each operator (a user
 *     of the platform tenant, or a platform admin of any tenant), once
 *     per distinct address, and no workspace's super admin who is
 *     neither, is sent
 *     the B2 key pairs to revoke, in their language, whatever happens to
 *     the scanner afterwards: the pair named for the scanner's name, and
 *     the erased keys' pair when their appliance id differs, after a
 *     revoke; the stored keys' pair alone after `erase_keys`; a failed
 *     send, a failed read of the operators, or no operator at all is
 *     logged with a fixed line and changes nothing else, and the answer
 *     says whether any operator was told (`operatorsNotified`);
 *   - a document post (no JavaScript), through React Router's request
 *     handler: answered with `private, no-store`, and refused before the
 *     action runs when its Origin is another host's.
 *
 * Every value here is a test value: no real tenant, unit or token.
 *
 * @version v0.9.0
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
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { createGrantUser, createTestUser } from "../helpers/auth";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { insertRow } from "../helpers/media-pipeline";
import { hashScannerToken, sha256Hex } from "../../app/lib/capture/token";
import {
  scannerTokenAction,
  type KeysErasedNotice,
  type ScannerActionDeps,
} from "../../app/lib/capture/scanner.server";
import { authenticate } from "../../app/lib/capture/link.server";
import { generatePairingKeyPair, sealKeys } from "../../app/lib/capture/pairing-seal";
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

function context(user: User, tenant: Tenant, grant: GrantState | null = null, envOverrides: Record<string, unknown> = {}): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  ctx.set(grantContext, grant);
  ctx.set(impersonationContext, null);
  (ctx as any).cloudflare = { env: { ...env, CAPTURE_KEYS_PRIVATE_JWK: privateJwkText, ...envOverrides } };
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
  opts: { tenant?: Tenant; grant?: GrantState | null; env?: Record<string, unknown> } = {},
): Promise<{ status: number; body: any }> {
  const request = new Request(`${HOST}/admin/capture/scanner`, { method: "POST", body: new URLSearchParams(fields) });
  const answer: any = await action({
    request,
    context: context(user, opts.tenant ?? on(), opts.grant ?? null, opts.env),
    params: {},
  } as any);
  return { status: answer.init?.status ?? 200, body: answer.data };
}

/** Posts an action against the scanner as the page would show it now. */
async function act(
  user: User,
  intent: "make" | "replace" | "revoke",
  opts: { confirm?: boolean; grant?: GrantState | null; reason?: string } = {},
) {
  const { scanner, version } = await load(world.admin);
  const fields: Record<string, string> = { intent, seen: version };
  if (intent === "make" && !scanner) fields.name = UNIT;
  if (intent === "revoke") fields.reason = opts.reason ?? "replaced";
  if (opts.confirm ?? intent !== "make") fields.confirm = "yes";
  return post(user, fields, { grant: opts.grant });
}

const sqlRows = async (query: string, ...binds: unknown[]) =>
  (await env.DB.prepare(query).bind(...binds).all()).results as Array<Record<string, any>>;

const scanners = () => sqlRows("SELECT * FROM capture_scanners WHERE tenant_id = ?", DEFAULT_TEST_TENANT_ID);
interface SentNotice {
  to: string;
  locale: string;
  notice: KeysErasedNotice;
}

/** The action's dependencies against the test database; mail goes to `sent`, never out. */
function actionDeps(overrides: Partial<ScannerActionDeps> & { sent?: SentNotice[] } = {}): ScannerActionDeps {
  const { sent, ...rest } = overrides;
  return {
    d1: env.DB,
    db: drizzle(env.DB),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    environment: "production",
    keysPrivateJwk: privateJwkText,
    keysEnvironment: "production",
    sendKeysErased: async (to, locale, notice) => {
      sent?.push({ to, locale, notice });
    },
    ...rest,
  };
}

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

/** The test key pair's private half, as the Worker secret holds it, and keys sealed with its public half. */
let privateJwkText = "";
let SEALED = "";
/** Keys sealed with a key pair the action is not given. */
let SEALED_ELSEWHERE = "";

beforeAll(async () => {
  await applyMigrations();
  const made = { writeKey: { keyId: "0001-write-test", applicationKey: "K001writeMadeUp" }, readKey: { keyId: "0001-read-test", applicationKey: "K001readMadeUp" } };
  const pair = await generatePairingKeyPair();
  privateJwkText = JSON.stringify(pair.privateJwk);
  SEALED = await sealKeys(pair.publicJwk, made, { tenantId: DEFAULT_TEST_TENANT_ID, environment: "production" });
  const other = await generatePairingKeyPair();
  SEALED_ELSEWHERE = await sealKeys(other.publicJwk, made, { tenantId: DEFAULT_TEST_TENANT_ID, environment: "production" });
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

  it("opens the page to a federation staff grant without the token's controls, and refuses its actions", async () => {
    const staff = await createGrantUser("staff", { name: "Test Staff" });
    const grant = { role: "staff" as const, federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID };
    const page = await load(staff);
    expect(page.canManage).toBe(false);
    expect((await load(world.admin)).canManage).toBe(true);
    expect((await load(world.steward)).canManage).toBe(true);
    expect(await status(post(staff, { intent: "make", seen: page.version, name: UNIT }, { grant }))).toBe(403);
    expect(await scanners()).toEqual([]);
    const made = await act(world.admin, "make");
    expect(made.status).toBe(200);
    expect(await status(act(staff, "revoke", { grant }))).toBe(403);
    expect(await status(act(staff, "replace", { grant }))).toBe(403);
    expect((await scanners())[0].revoked_at ?? null).toBeNull();
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
    expect(page).toEqual({
      scanner: null,
      version: "none",
      workspace: "Neogranadina",
      canManage: true,
      storedKeys: null,
    });
  });

  it("gives the linked unit's name and device id in the scanner once the scanner holds them", async () => {
    await act(world.admin, "make");
    expect((await load(world.admin)).scanner).toMatchObject({ unitName: null, deviceId: null });
    await env.DB.prepare("UPDATE capture_scanners SET unit_name = ?, device_id = ? WHERE name = ?").bind("Reading room", "dev-7", UNIT).run();
    expect((await load(world.admin)).scanner).toMatchObject({ unitName: "Reading room", deviceId: "dev-7" });
  });

  it("keeps the linked unit through Revoke, and forgets it on Make token and Replace token", async () => {
    const linked = () =>
      env.DB.prepare("UPDATE capture_scanners SET unit_name = ?, device_id = ? WHERE name = ?").bind("Reading room", "dev-7", UNIT).run();
    await act(world.admin, "make");
    await linked();
    await act(world.admin, "revoke");
    expect((await load(world.admin)).scanner).toMatchObject({ unitName: "Reading room", deviceId: "dev-7" });
    await act(world.admin, "make");
    expect((await load(world.admin)).scanner).toMatchObject({ unitName: null, deviceId: null });
    await linked();
    await act(world.admin, "replace");
    expect((await load(world.admin)).scanner).toMatchObject({ unitName: null, deviceId: null });
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
    expect(revoked).toEqual({ status: 200, body: { ok: true, step: "revoke", keysErased: false } });

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
      [world.steward.id, world.steward.email, SECOND_TEST_TENANT_ID, { step: "revoke", name: UNIT, reason: "replaced" }],
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
    await post(world.admin, { intent: "revoke", seen: "none", confirm: "yes", reason: "replaced" });
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
      post(world.admin, { intent: "revoke", seen: version, confirm: "yes", reason: "replaced" }),
      post(world.admin, { intent: "revoke", seen: version, confirm: "yes", reason: "replaced" }),
    ]);
    expect(answers.map((a) => a.body).sort((a, b) => Number(b.ok) - Number(a.ok))).toEqual([
      { ok: true, step: "revoke", keysErased: false },
      { ok: false, error: "changed" },
    ]);
    const revokes = (await audits()).filter((r) => JSON.parse(r.details).step === "revoke");
    expect(revokes).toHaveLength(1);
    expect((await scanners())[0].revision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pairing a unit by its code
// ---------------------------------------------------------------------------

const CODE = "7KQ4MZ";
const SECRET = "ab".repeat(32);
const STAFF_GRANT = { role: "staff" as const, federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID };

async function seedKeys(
  opts: { erased?: boolean; tenantId?: string; revision?: number; applianceId?: string; sealed?: string } = {},
) {
  await insertRow("capture_scanner_keys", {
    tenant_id: opts.tenantId ?? DEFAULT_TEST_TENANT_ID,
    appliance_id: opts.applianceId ?? UNIT,
    bucket: "test-masters",
    sealed: opts.erased ? null : (opts.sealed ?? SEALED),
    age_recipient: "age1testrecipient",
    revision: opts.revision ?? 1,
    stored_at: T0,
    erased_at: opts.erased ? T0 : null,
  });
}

async function seedCode(
  opts: {
    code?: string;
    state?: "waiting" | "approved" | "collected" | "void";
    expiresAt?: number;
    tenantId?: string | null;
    currentTenant?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow("capture_pairing_codes", {
    id,
    code_sha256: await sha256Hex(opts.code ?? CODE),
    collect_secret_sha256: await sha256Hex(SECRET),
    unit_name: "Test unit",
    device_id: "test-device-1",
    current_tenant: opts.currentTenant === undefined ? "other-test-workspace" : opts.currentTenant,
    state: opts.state ?? "waiting",
    created_at: Date.now(),
    expires_at: opts.expiresAt ?? Date.now() + 120_000,
    tenant_id: opts.tenantId ?? null,
  });
  return id;
}

const codes = () => sqlRows("SELECT * FROM capture_pairing_codes");

async function lookup(user: User, code: string, grant: GrantState | null = null) {
  return post(user, { intent: "pair_lookup", code }, { grant });
}

/** Approves a code against the scanner and keys as the page would show them now. */
async function approve(user: User, code: string, opts: { grant?: GrantState | null; confirm?: string | null } = {}) {
  const page = await load(world.admin);
  const fields: Record<string, string> = {
    intent: "pair_approve",
    code,
    seen: page.version,
    keysSeen: String(page.storedKeys?.revision ?? 0),
  };
  if (opts.confirm !== null) fields.confirm = opts.confirm ?? "yes";
  return post(user, fields, { grant: opts.grant ?? null });
}

/** A clock aligned to the hour, so no entry in a test straddles a window. */
const NOW = 500_000 * 3_600_000;

/** Calls the action directly with a fixed clock (the route reads Date.now()). */
async function direct(user: User, fields: Record<string, string>, now: number, homeTenantId = user.tenantId): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return scannerTokenAction(
    actionDeps({ now: () => now }),
    form,
    on(),
    { user, homeTenantId, impersonationSessionId: null },
  );
}

describe("pairing a unit by its code", () => {
  it("shows the stored keys' state on the page, without key material", async () => {
    await seedKeys({ revision: 3 });
    const page = await load(world.admin);
    expect(page.storedKeys).toEqual({ applianceId: UNIT, usable: true, erasedAt: null, revision: 3 });
    expect(JSON.stringify(page).includes(SEALED)).toBe(false);
  });

  it("gives a worker who does not manage no stored keys' state", async () => {
    await seedKeys({ revision: 3 });
    const staff = await createGrantUser("staff", { name: "Test Staff" });
    const page = await load(staff);
    expect(page.canManage).toBe(false);
    expect(page.storedKeys).toBeNull();
  });

  it("looks up a waiting code: the unit's name, device id and reported workspace", async () => {
    await seedKeys();
    await seedCode();
    const found = await lookup(world.admin, "7kq-4mz");
    expect(found).toEqual({
      status: 200,
      body: {
        ok: true,
        step: "pair_lookup",
        pairing: {
          code: "7KQ-4MZ",
          unitName: "Test unit",
          deviceId: "test-device-1",
          currentTenant: "other-test-workspace",
          replacesLinkedUnit: false,
        },
      },
    });
    const [row] = await codes();
    expect(JSON.stringify(found).includes(row.id)).toBe(false);
    expect(JSON.stringify(found).includes(row.code_sha256)).toBe(false);
    expect(row.state).toBe("waiting");
  });

  it("says that approving replaces the linked unit when the scanner has a live token", async () => {
    await seedKeys();
    await seedCode({ currentTenant: null });
    await act(world.admin, "make");
    const found = await lookup(world.admin, CODE);
    expect(found.body.pairing).toMatchObject({ currentTenant: null, replacesLinkedUnit: true });
    await act(world.admin, "revoke");
    expect((await lookup(world.admin, CODE)).body.pairing.replacesLinkedUnit).toBe(false);
  });

  it("approves a waiting code: binds it to the workspace and audits it", async () => {
    await seedKeys({ revision: 2 });
    await seedCode();
    await act(world.admin, "make");
    const before = Date.now();
    const approved = await approve(world.admin, "7KQ 4MZ");
    expect(approved).toEqual({ status: 200, body: { ok: true, step: "pair_approve" } });
    const [row] = await codes();
    const [scanner] = await scanners();
    expect(row).toMatchObject({
      state: "approved",
      tenant_id: DEFAULT_TEST_TENANT_ID,
      approved_by: world.admin.id,
      scanner_revision_seen: scanner.revision,
      keys_revision_seen: 2,
    });
    expect(row.approved_at).toBeGreaterThanOrEqual(before);
    expect(row.collect_by).toBe(row.approved_at + 120_000);
    const pairings = (await audits()).filter((r) => JSON.parse(r.details).step === "pair_approved");
    expect(pairings).toHaveLength(1);
    expect(pairings[0]).toMatchObject({
      action: "scanner_token",
      actor_user_id: world.admin.id,
      actor_tenant_id: DEFAULT_TEST_TENANT_ID,
      target_tenant_id: DEFAULT_TEST_TENANT_ID,
      target_object_kind: "capture_pairing_code",
      target_object_id: row.id,
    });
    expect(JSON.parse(pairings[0].details)).toEqual({ step: "pair_approved", unitName: "Test unit", deviceId: "test-device-1" });
  });

  it("records a scanner revision of 0 when the workspace has no scanner", async () => {
    await seedKeys();
    await seedCode();
    expect((await approve(world.admin, CODE)).body).toEqual({ ok: true, step: "pair_approve" });
    expect((await codes())[0].scanner_revision_seen).toBe(0);
  });

  it("refuses lookup and approval without stored keys, or with erased keys, and leaves the code waiting", async () => {
    await seedCode();
    expect(await lookup(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_no_keys" } });
    expect(await approve(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_no_keys" } });
    await seedKeys({ erased: true });
    expect(await approve(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_no_keys" } });
    expect((await codes())[0]).toMatchObject({ state: "waiting", tenant_id: null, approved_by: null });
    expect(await audits()).toEqual([]);
    expect(await sqlRows("SELECT * FROM capture_pairing_limits")).toEqual([]);
  });

  it("refuses lookup and approval with 503 when the stored keys do not open with this key pair; writes and counts nothing", async () => {
    await seedKeys({ sealed: SEALED_ELSEWHERE });
    await seedCode();
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      expect(await lookup(world.admin, CODE)).toEqual({ status: 503, body: { ok: false, error: "pair_keys_unreadable" } });
      expect(await approve(world.admin, CODE)).toEqual({ status: 503, body: { ok: false, error: "pair_keys_unreadable" } });
    } finally {
      console.error = original;
    }
    expect((await codes())[0]).toMatchObject({ state: "waiting", tenant_id: null, approved_by: null });
    expect(await audits()).toEqual([]);
    expect((await sqlRows("SELECT count FROM capture_pairing_limits")).map((r) => r.count)).toEqual([0, 0]);
    expect(lines).toEqual([
      ["scanner pairing: stored keys could not be opened: Error"],
      ["scanner pairing: stored keys could not be opened: Error"],
    ]);
    expect(JSON.stringify(lines)).not.toContain(SEALED_ELSEWHERE);
  });

  it("refuses lookup and approval when the private key is not set", async () => {
    await seedKeys();
    await seedCode();
    const original = console.error;
    console.error = () => {};
    try {
      for (const fields of [
        { intent: "pair_lookup", code: CODE },
        { intent: "pair_approve", code: CODE, seen: "none", keysSeen: "1", confirm: "yes" },
      ]) {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.set(k, v);
        const result = await scannerTokenAction(actionDeps({ keysPrivateJwk: undefined }), form, on(), {
          user: world.admin,
          homeTenantId: DEFAULT_TEST_TENANT_ID,
          impersonationSessionId: null,
        });
        expect(result).toEqual({ ok: false, error: "pair_keys_unreadable" });
      }
    } finally {
      console.error = original;
    }
    expect((await codes())[0].state).toBe("waiting");
  });

  it("refuses a code another workspace approved, and tells nothing about it", async () => {
    await seedKeys();
    await seedCode({ state: "approved", tenantId: SECOND_TEST_TENANT_ID });
    expect(await lookup(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_not_waiting" } });
    expect(await approve(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_not_waiting" } });
    expect((await codes())[0].tenant_id).toBe(SECOND_TEST_TENANT_ID);
    expect(await audits()).toEqual([]);
  });

  it("refuses an expired code", async () => {
    await seedKeys();
    await seedCode({ expiresAt: Date.now() - 1 });
    expect(await lookup(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_not_waiting" } });
    expect(await approve(world.admin, CODE)).toEqual({ status: 409, body: { ok: false, error: "pair_not_waiting" } });
    expect((await codes())[0].state).toBe("waiting");
  });

  it("refuses an unknown code, and a field that is not a code", async () => {
    await seedKeys();
    expect(await lookup(world.admin, "ZZZ-ZZZ")).toEqual({ status: 404, body: { ok: false, error: "pair_unknown" } });
    expect(await lookup(world.admin, "not a code")).toEqual({ status: 404, body: { ok: false, error: "pair_unknown" } });
    expect(await post(world.admin, { intent: "pair_lookup" })).toEqual({ status: 400, body: { ok: false, error: "invalid_request" } });
  });

  it("answers the sixth wrong entry by one user in ten minutes with pair_limited", async () => {
    await seedKeys();
    await seedCode({ expiresAt: NOW + 120_000 });
    for (let i = 0; i < 5; i++) {
      expect((await direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW + i)).error).toBe("pair_unknown");
    }
    const sixth = await direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW + 5);
    expect(sixth).toEqual({ ok: false, error: "pair_limited", retryAfterSeconds: 600 });
    // Another user in the same workspace still has entries left.
    expect((await direct(world.steward, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW + 6, SECOND_TEST_TENANT_ID)).error).toBe(
      "pair_unknown",
    );
  });

  it("refuses even a correct entry past the user's limit, and does not look the code up", async () => {
    await seedKeys();
    await seedCode({ expiresAt: NOW + 120_000 });
    for (let i = 0; i < 5; i++) await direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW + i);
    expect(await direct(world.admin, { intent: "pair_lookup", code: CODE }, NOW + 10)).toEqual({
      ok: false,
      error: "pair_limited",
      retryAfterSeconds: 600,
    });
    expect(
      await direct(
        world.admin,
        { intent: "pair_approve", code: CODE, seen: "none", keysSeen: "1", confirm: "yes" },
        NOW + 11,
      ),
    ).toEqual({ ok: false, error: "pair_limited", retryAfterSeconds: 600 });
    expect((await codes())[0]).toMatchObject({ state: "waiting", tenant_id: null, approved_by: null });
    expect(await audits()).toEqual([]);
    // A refused entry is counted and then given back, so the count stays at the limit.
    const [user] = await sqlRows("SELECT count FROM capture_pairing_limits WHERE key = ?", `entry-user:${world.admin.id}`);
    expect(user.count).toBe(5);
  });

  it("refuses a correct entry past the workspace's limit, whoever makes it", async () => {
    await seedKeys();
    await seedCode({ expiresAt: NOW + 3_600_000 });
    let t = NOW;
    for (let u = 0; u < 4; u++) {
      const admin = await person({ isAdmin: true, name: `Test Admin ${u}` });
      for (let i = 0; i < 5; i++) {
        expect((await direct(admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, t++)).error).toBe("pair_unknown");
      }
    }
    const fresh = await person({ isAdmin: true, name: "Test Admin Fresh" });
    expect(await direct(fresh, { intent: "pair_lookup", code: CODE }, t++)).toEqual({
      ok: false,
      error: "pair_limited",
      retryAfterSeconds: 3600,
    });
    expect((await codes())[0].state).toBe("waiting");
  });

  it("refuses a correct approval past the workspace's limit, spread over several managers, and leaves the code waiting", async () => {
    await seedKeys();
    await seedCode({ expiresAt: NOW + 3_600_000 });
    let t = NOW;
    for (let u = 0; u < 4; u++) {
      const admin = await person({ isAdmin: true, name: `Test Admin ${u}` });
      for (let i = 0; i < 5; i++) {
        expect((await direct(admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, t++)).error).toBe("pair_unknown");
      }
    }
    const [tenantCount] = await sqlRows("SELECT count FROM capture_pairing_limits WHERE key = ?", `entry-tenant:${DEFAULT_TEST_TENANT_ID}`);
    expect(tenantCount.count).toBe(20);
    const fresh = await person({ isAdmin: true, name: "Test Admin Fresh" });
    expect(
      await direct(fresh, { intent: "pair_approve", code: CODE, seen: "none", keysSeen: "1", confirm: "yes" }, t++),
    ).toEqual({ ok: false, error: "pair_limited", retryAfterSeconds: 3600 });
    expect((await codes())[0]).toMatchObject({ state: "waiting", tenant_id: null, approved_by: null });
    expect(await audits()).toEqual([]);
  });

  it("counts a wrong approval against the user and the workspace", async () => {
    await seedKeys();
    await seedCode({ expiresAt: NOW + 120_000 });
    expect(
      await direct(world.admin, { intent: "pair_approve", code: "ZZZ-ZZZ", seen: "none", keysSeen: "1", confirm: "yes" }, NOW),
    ).toEqual({ ok: false, error: "pair_unknown" });
    const counts = await sqlRows("SELECT key, count FROM capture_pairing_limits ORDER BY key");
    expect(counts).toEqual([
      { key: `entry-tenant:${DEFAULT_TEST_TENANT_ID}`, count: 1 },
      { key: `entry-user:${world.admin.id}`, count: 1 },
    ]);
    expect((await codes())[0].state).toBe("waiting");
  });

  it("counts no entry for a correct code", async () => {
    await seedKeys();
    await seedCode();
    for (let i = 0; i < 6; i++) expect((await lookup(world.admin, CODE)).body.ok).toBe(true);
    const counts = await sqlRows("SELECT count FROM capture_pairing_limits");
    expect(counts.map((r) => r.count)).toEqual([0, 0]);
  });

  /** Sets the user's and the workspace's wrong-entry counts in the windows `NOW` falls in. */
  async function seedEntryCounts(user: number, workspace: number) {
    await insertRow("capture_pairing_limits", {
      key: `entry-user:${world.admin.id}`,
      window_start: Math.floor(NOW / 600_000) * 600_000,
      count: user,
    });
    await insertRow("capture_pairing_limits", {
      key: `entry-tenant:${DEFAULT_TEST_TENANT_ID}`,
      window_start: Math.floor(NOW / 3_600_000) * 3_600_000,
      count: workspace,
    });
  }

  const entryCounts = async () =>
    Object.fromEntries((await sqlRows("SELECT key, count FROM capture_pairing_limits")).map((r) => [r.key, r.count]));

  it("lets one of several wrong entries sent at once past a count of four, and refuses the rest", async () => {
    await seedKeys();
    await seedEntryCounts(4, 4);
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW)),
    );
    const errors = answers.map((a) => a.error).sort();
    expect(errors).toEqual(["pair_limited", "pair_limited", "pair_limited", "pair_limited", "pair_limited", "pair_unknown"]);
  });

  it("leaves both counts as they were for entries sent at once by a user at their limit, with the workspace one short of its own", async () => {
    await seedKeys();
    await seedEntryCounts(5, 19);
    const answers = await Promise.all(
      Array.from({ length: 4 }, () => direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW)),
    );
    expect(answers.map((a) => a.error)).toEqual(["pair_limited", "pair_limited", "pair_limited", "pair_limited"]);
    expect(await entryCounts()).toEqual({ [`entry-user:${world.admin.id}`]: 5, [`entry-tenant:${DEFAULT_TEST_TENANT_ID}`]: 19 });
  });

  it("refuses a fresh user's entry when the workspace is at its limit, and leaves both counts as they were", async () => {
    await seedKeys();
    await insertRow("capture_pairing_limits", {
      key: `entry-tenant:${DEFAULT_TEST_TENANT_ID}`,
      window_start: Math.floor(NOW / 3_600_000) * 3_600_000,
      count: 20,
    });
    const fresh = await person({ isAdmin: true, name: "Test Admin Fresh" });
    expect(await direct(fresh, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW)).toEqual({
      ok: false,
      error: "pair_limited",
      retryAfterSeconds: 3600,
    });
    expect(await entryCounts()).toEqual({ [`entry-user:${fresh.id}`]: 0, [`entry-tenant:${DEFAULT_TEST_TENANT_ID}`]: 20 });
  });

  it("gives the workspace back the entries a user makes past their own limit", async () => {
    await seedKeys();
    for (let i = 0; i < 5; i++) await direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW + i);
    for (let i = 0; i < 10; i++) {
      expect((await direct(world.admin, { intent: "pair_lookup", code: "ZZZ-ZZZ" }, NOW + 10 + i)).error).toBe("pair_limited");
    }
    expect((await entryCounts())[`entry-tenant:${DEFAULT_TEST_TENANT_ID}`]).toBe(5);
  });

  it("refuses lookup and approval when the pairing environment is not exactly production or staging", async () => {
    await seedKeys();
    await seedCode();
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      for (const setting of ["prod", undefined]) {
        const env = { CAPTURE_PAIRING_ENVIRONMENT: setting };
        expect(await post(world.admin, { intent: "pair_lookup", code: CODE }, { env })).toEqual({
          status: 503,
          body: { ok: false, error: "pair_keys_unreadable" },
        });
        const page = await load(world.admin);
        const fields = { intent: "pair_approve", code: CODE, seen: page.version, keysSeen: "1", confirm: "yes" };
        expect((await post(world.admin, fields, { env })).body).toEqual({ ok: false, error: "pair_keys_unreadable" });
      }
    } finally {
      console.error = original;
    }
    expect((await codes())[0].state).toBe("waiting");
    expect(lines.flat().every((l) => l === "scanner pairing: no pairing environment configured")).toBe(true);
  });

  it("leaves both counts as they were after a right entry under the limit", async () => {
    await seedKeys();
    await seedCode({ expiresAt: NOW + 120_000 });
    await seedEntryCounts(2, 3);
    expect((await direct(world.admin, { intent: "pair_lookup", code: CODE }, NOW)).ok).toBe(true);
    expect(await entryCounts()).toEqual({ [`entry-user:${world.admin.id}`]: 2, [`entry-tenant:${DEFAULT_TEST_TENANT_ID}`]: 3 });
  });

  it("does not count re-entering a code this workspace already approved", async () => {
    await seedKeys();
    await seedCode({ state: "approved", tenantId: DEFAULT_TEST_TENANT_ID, expiresAt: NOW + 120_000 });
    await seedEntryCounts(2, 3);
    expect(await direct(world.admin, { intent: "pair_lookup", code: CODE }, NOW)).toEqual({ ok: false, error: "pair_not_waiting" });
    expect(
      await direct(world.admin, { intent: "pair_approve", code: CODE, seen: "none", keysSeen: "1", confirm: "yes" }, NOW),
    ).toEqual({ ok: false, error: "pair_not_waiting" });
    expect(await entryCounts()).toEqual({ [`entry-user:${world.admin.id}`]: 2, [`entry-tenant:${DEFAULT_TEST_TENANT_ID}`]: 3 });
  });

  it("refuses a federation staff grant (a worker who does not manage) with a bare 403", async () => {
    await seedKeys();
    await seedCode();
    const staff = await createGrantUser("staff", { name: "Test Staff" });
    expect(await status(lookup(staff, CODE, STAFF_GRANT))).toBe(403);
    expect(await status(approve(staff, CODE, { grant: STAFF_GRANT }))).toBe(403);
    expect((await codes())[0].state).toBe("waiting");
    expect(await sqlRows("SELECT * FROM capture_pairing_limits")).toEqual([]);
  });

  it("refuses approval without the confirmation", async () => {
    await seedKeys();
    await seedCode();
    expect(await approve(world.admin, CODE, { confirm: null })).toEqual({ status: 400, body: { ok: false, error: "unconfirmed" } });
    expect(await approve(world.admin, CODE, { confirm: "no" })).toEqual({ status: 400, body: { ok: false, error: "unconfirmed" } });
    expect((await codes())[0].state).toBe("waiting");
  });

  it("refuses approval from a stale page: the scanner or the stored keys changed", async () => {
    await seedKeys({ revision: 1 });
    await seedCode();
    const page = await load(world.admin);
    await act(world.admin, "make");
    expect(
      await post(world.admin, { intent: "pair_approve", code: CODE, seen: page.version, keysSeen: "1", confirm: "yes" }),
    ).toEqual({ status: 409, body: { ok: false, error: "changed" } });
    const now = await load(world.admin);
    await env.DB.prepare("UPDATE capture_scanner_keys SET revision = 2").run();
    expect(
      await post(world.admin, { intent: "pair_approve", code: CODE, seen: now.version, keysSeen: "1", confirm: "yes" }),
    ).toEqual({ status: 409, body: { ok: false, error: "changed" } });
    expect((await codes())[0].state).toBe("waiting");
    expect((await audits()).filter((r) => JSON.parse(r.details).step === "pair_approved")).toEqual([]);
  });

  it("lets one of two approvals of the same code win, and audits only that one", async () => {
    await seedKeys();
    await seedCode();
    const answers = await Promise.all([
      approve(world.admin, CODE),
      approve(world.steward, CODE, {
        grant: { role: "steward", federationId: DEFAULT_TEST_FEDERATION_ID, homeTenantId: SECOND_TEST_TENANT_ID },
      }),
    ]);
    expect(answers.filter((a) => a.body.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.body.ok).map((a) => a.body.error)).toEqual(["pair_not_waiting"]);
    expect(await audits()).toHaveLength(1);
  });

  it("audits nothing when the guarded write did not land, even if the row now looks approved by this approver", async () => {
    await seedKeys();
    const id = await seedCode();
    const now = Date.now();
    // Between the lookup and the write, the code is approved by the same
    // person at the same instant: only the write's own change may count.
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare(
                "UPDATE capture_pairing_codes SET state = 'approved', tenant_id = ?, approved_by = ?, approved_at = ?, collect_by = ? WHERE id = ?",
              )
              .bind(DEFAULT_TEST_TENANT_ID, world.admin.id, now, now + 120_000, id)
              .run();
            return target.batch(statements);
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const form = new FormData();
    for (const [k, v] of Object.entries({ intent: "pair_approve", code: CODE, seen: "none", keysSeen: "1", confirm: "yes" })) {
      form.set(k, v);
    }
    const result = await scannerTokenAction(
      actionDeps({ d1, now: () => now }),
      form,
      on(),
      { user: world.admin, homeTenantId: DEFAULT_TEST_TENANT_ID, impersonationSessionId: null },
    );
    expect(result).toEqual({ ok: false, error: "pair_not_waiting" });
    expect(await audits()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Revoke reasons and erasing the stored keys
// ---------------------------------------------------------------------------

const KEY_NAMES = { write: `fisqua-${"neogranadina"}-appliance-${UNIT}`, read: `fisqua-${"neogranadina"}-appliance-${UNIT}-read` };

/** An operator: a user of the platform tenant, or a platform admin of any tenant, with a saved language. */
async function operator(name: string, locale: "en" | "es" | null): Promise<User> {
  const u = await person({ name, tenantId: PLATFORM_TENANT_ID });
  await env.DB.prepare("UPDATE users SET locale = ? WHERE id = ?").bind(locale, u.id).run();
  return u;
}

/** A platform admin: a user of an ordinary workspace whose row has `is_platform_admin = 1`. */
async function platformAdmin(name: string, tenantId: string, locale: "en" | "es" | null, email?: string): Promise<User> {
  const u = await person({ name, tenantId });
  if (email) await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, u.id).run();
  await env.DB.prepare("UPDATE users SET is_platform_admin = 1, locale = ? WHERE id = ?").bind(locale, u.id).run();
  return { ...u, email: email ?? u.email } as User;
}

/** A super admin of a workspace, who is not an operator. */
async function workspaceSuperAdmin(name: string, tenantId: string): Promise<User> {
  const u = await person({ name, tenantId });
  await env.DB.prepare("UPDATE users SET is_super_admin = 1 WHERE id = ?").bind(u.id).run();
  return u;
}

const storedKeys = async () =>
  (await sqlRows("SELECT * FROM capture_scanner_keys WHERE tenant_id = ?", DEFAULT_TEST_TENANT_ID))[0];

/** Calls the action directly, with mail captured in `sent`. */
async function run(
  user: User,
  fields: Record<string, string>,
  opts: { sent?: SentNotice[]; d1?: D1Database; sendKeysErased?: ScannerActionDeps["sendKeysErased"]; grant?: boolean } = {},
): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const deps = actionDeps({ sent: opts.sent, ...(opts.d1 ? { d1: opts.d1 } : {}) });
  if (opts.sendKeysErased) deps.sendKeysErased = opts.sendKeysErased;
  return scannerTokenAction(deps, form, on(), {
    user,
    homeTenantId: opts.grant ? SECOND_TEST_TENANT_ID : user.tenantId,
    impersonationSessionId: null,
  });
}

/** The fields of a confirmed revoke against the scanner as the page shows it now. */
async function revokeFields(reason?: string): Promise<Record<string, string>> {
  const { version } = await load(world.admin);
  const fields: Record<string, string> = { intent: "revoke", seen: version, confirm: "yes" };
  if (reason !== undefined) fields.reason = reason;
  return fields;
}

/** The fields of a confirmed erase against the stored keys as the page shows them now. */
async function eraseFields(): Promise<Record<string, string>> {
  const page = await load(world.admin);
  return { intent: "erase_keys", keysSeen: String(page.storedKeys?.revision ?? 0), confirm: "yes" };
}

/** A database whose batches are recorded, by the number of statements in each. */
function recordingD1(batches: number[], before?: () => Promise<void>): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (before) await before();
          batches.push(statements.length);
          return target.batch(statements);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("revoke reasons", () => {
  it("refuses a revoke without a reason, or with an unknown one, and writes nothing", async () => {
    await act(world.admin, "make");
    const before = await scanners();
    for (const reason of [undefined, "lost", ""]) {
      expect(await run(world.admin, await revokeFields(reason))).toEqual({ ok: false, error: "invalid_request" });
    }
    expect(await scanners()).toEqual(before);
    expect(await audits()).toHaveLength(1);
  });

  it("revokes as replaced: the token is revoked, the stored keys stay, and the reason is audited", async () => {
    await seedKeys({ revision: 4 });
    await act(world.admin, "make");
    const sent: SentNotice[] = [];
    await operator("Test Operator", "en");
    expect(await run(world.admin, await revokeFields("replaced"), { sent })).toEqual({ ok: true, step: "revoke", keysErased: false });
    expect((await scanners())[0].revoked_at).toEqual(expect.any(Number));
    expect(await storedKeys()).toMatchObject({ sealed: SEALED, erased_at: null, revision: 4 });
    const details = (await audits()).map((r) => JSON.parse(r.details));
    expect(details.at(-1)).toEqual({ step: "revoke", name: UNIT, reason: "replaced" });
    expect(sent).toEqual([]);
  });

  it("revokes as compromised: the token is revoked and the stored keys erased in one batch, each audited", async () => {
    await seedKeys({ revision: 4 });
    await act(world.admin, "make");
    const batches: number[] = [];
    const result = await run(world.admin, await revokeFields("compromised"), { d1: recordingD1(batches) });
    expect(result).toEqual({ ok: true, step: "revoke", keysErased: true, operatorsNotified: false });
    expect(batches).toEqual([4]);
    expect((await scanners())[0].revoked_at).toEqual(expect.any(Number));
    const keys = await storedKeys();
    expect(keys).toMatchObject({ sealed: null, revision: 5, erased_by: world.admin.id, appliance_id: UNIT });
    expect(keys.erased_at).toEqual(expect.any(Number));
    const rows = await audits();
    expect(rows.slice(-2).map((r) => [r.target_object_kind, JSON.parse(r.details)])).toEqual([
      ["capture_scanner", { step: "revoke", name: UNIT, reason: "compromised" }],
      ["capture_scanner_keys", { step: "keys_erased", reason: "compromised" }],
    ]);
    expect(rows.at(-1)).toMatchObject({ actor_user_id: world.admin.id, target_tenant_id: DEFAULT_TEST_TENANT_ID });
    expect((await load(world.admin)).storedKeys).toMatchObject({ usable: false, revision: 5 });
  });

  it("revokes as compromised with no stored keys, or erased ones: erases nothing, and tells the operators the unit's keys", async () => {
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const sent: SentNotice[] = [];
    expect(await run(world.admin, await revokeFields("compromised"), { sent })).toMatchObject({
      ok: true,
      step: "revoke",
      keysErased: false,
      operatorsNotified: true,
    });
    await act(world.admin, "make");
    await seedKeys({ erased: true, revision: 2 });
    expect(await run(world.admin, await revokeFields("compromised"), { sent })).toMatchObject({
      ok: true,
      step: "revoke",
      keysErased: false,
      operatorsNotified: true,
    });
    expect(await storedKeys()).toMatchObject({ revision: 2, erased_at: T0 });
    expect(sent.map((s) => s.notice)).toEqual([
      { workspace: on().name, slug: on().slug, erased: false, keys: [KEY_NAMES] },
      { workspace: on().name, slug: on().slug, erased: false, keys: [KEY_NAMES] },
    ]);
    expect((await audits()).filter((r) => JSON.parse(r.details).step === "keys_erased")).toEqual([]);
  });

  it("names the unit's keys and the erased keys when the stored keys carry another appliance id", async () => {
    await seedKeys({ applianceId: "rig-2" });
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const sent: SentNotice[] = [];
    expect(await run(world.admin, await revokeFields("compromised"), { sent })).toMatchObject({ keysErased: true });
    expect(sent.map((s) => s.notice)).toEqual([
      {
        workspace: on().name,
        slug: on().slug,
        erased: true,
        keys: [KEY_NAMES, { write: "fisqua-neogranadina-appliance-rig-2", read: "fisqua-neogranadina-appliance-rig-2-read" }],
      },
    ]);
  });

  it("names one pair when the stored keys carry the scanner's own appliance id", async () => {
    await seedKeys();
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const sent: SentNotice[] = [];
    await run(world.admin, await revokeFields("compromised"), { sent });
    expect(sent.map((s) => s.notice)).toEqual([{ workspace: on().name, slug: on().slug, erased: true, keys: [KEY_NAMES] }]);
  });

  it("revokes as compromised: erases keys stored again between the read and the batch, and tells the operators", async () => {
    await seedKeys({ revision: 4 });
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const fields = await revokeFields("compromised");
    // Between the read and the batch, an operator stores the keys again.
    const d1 = recordingD1([], async () => {
      await env.DB.prepare("UPDATE capture_scanner_keys SET sealed = 'test-sealed-again', revision = 5").run();
    });
    const sent: SentNotice[] = [];
    const result = await run(world.admin, fields, { d1, sent });
    expect(result).toMatchObject({ ok: true, step: "revoke", keysErased: true, operatorsNotified: true });
    expect(await storedKeys()).toMatchObject({ sealed: null, revision: 6, erased_by: world.admin.id });
    expect((await audits()).filter((r) => JSON.parse(r.details).step === "keys_erased")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("erases nothing when the revoke's own write did not land", async () => {
    await seedKeys({ revision: 4 });
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const fields = await revokeFields("compromised");
    // Between the read and the write, someone else replaces the token.
    const d1 = recordingD1([], async () => {
      await env.DB.prepare("UPDATE capture_scanners SET revision = revision + 1, write_id = 'other-write'").run();
    });
    const sent: SentNotice[] = [];
    expect(await run(world.admin, fields, { d1, sent })).toEqual({ ok: false, error: "changed" });
    expect(await storedKeys()).toMatchObject({ sealed: SEALED, erased_at: null, revision: 4 });
    expect((await scanners())[0].revoked_at).toBeNull();
    expect(await audits()).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});

describe("erasing the stored keys", () => {
  it("erases with no live token, leaves the scanner as it was, and audits the erasure", async () => {
    await seedKeys({ revision: 4 });
    await act(world.admin, "make");
    await act(world.admin, "revoke");
    const before = await scanners();
    expect(await run(world.admin, await eraseFields())).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: false });
    expect(await scanners()).toEqual(before);
    expect(await storedKeys()).toMatchObject({ sealed: null, revision: 5, erased_by: world.admin.id });
    const last = (await audits()).at(-1)!;
    expect(last).toMatchObject({
      action: "scanner_token",
      actor_user_id: world.admin.id,
      target_tenant_id: DEFAULT_TEST_TENANT_ID,
      target_object_kind: "capture_scanner_keys",
    });
    expect(JSON.parse(last.details)).toEqual({ step: "keys_erased", reason: "manual" });
  });

  it("erases for a workspace that never had a scanner", async () => {
    await seedKeys();
    expect(await run(world.admin, await eraseFields())).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: false });
    expect(await scanners()).toEqual([]);
    expect((await storedKeys()).sealed).toBeNull();
  });

  it("answers no_stored_keys when none were stored, or they are already erased, and writes nothing", async () => {
    expect(await run(world.admin, { intent: "erase_keys", keysSeen: "0", confirm: "yes" })).toEqual({
      ok: false,
      error: "no_stored_keys",
    });
    await seedKeys({ erased: true, revision: 2 });
    expect(await run(world.admin, { intent: "erase_keys", keysSeen: "2", confirm: "yes" })).toEqual({
      ok: false,
      error: "no_stored_keys",
    });
    expect(await storedKeys()).toMatchObject({ revision: 2, erased_at: T0 });
    expect(await audits()).toEqual([]);
  });

  it("answers no_stored_keys with 409", async () => {
    const answer = await post(world.admin, { intent: "erase_keys", keysSeen: "0", confirm: "yes" });
    expect(answer).toEqual({ status: 409, body: { ok: false, error: "no_stored_keys" } });
  });

  it("refuses an erase without the confirmation, or from a stale page, and writes nothing", async () => {
    await seedKeys({ revision: 4 });
    expect(await run(world.admin, { intent: "erase_keys", keysSeen: "4" })).toEqual({ ok: false, error: "unconfirmed" });
    expect(await run(world.admin, { intent: "erase_keys", keysSeen: "4", confirm: "no" })).toEqual({
      ok: false,
      error: "unconfirmed",
    });
    expect(await run(world.admin, { intent: "erase_keys", confirm: "yes" })).toEqual({ ok: false, error: "invalid_request" });
    expect(await run(world.admin, { intent: "erase_keys", keysSeen: "3", confirm: "yes" })).toEqual({
      ok: false,
      error: "changed",
    });
    expect(await storedKeys()).toMatchObject({ sealed: SEALED, revision: 4 });
    expect(await audits()).toEqual([]);
  });

  it("refuses a federation staff grant with a bare 403", async () => {
    await seedKeys();
    const staff = await person({ tenantId: SECOND_TEST_TENANT_ID, name: "Test Staff" });
    await insertRow("federation_memberships", {
      id: crypto.randomUUID(),
      user_id: staff.id,
      federation_id: DEFAULT_TEST_FEDERATION_ID,
      role: "staff",
      created_at: T0,
    });
    expect(await status(post(staff, await eraseFields(), { grant: STAFF_GRANT }))).toBe(403);
    expect((await storedKeys()).sealed).toBe(SEALED);
  });

  it("does not audit an erase whose guarded write did not land", async () => {
    await seedKeys({ revision: 4 });
    const fields = await eraseFields();
    const d1 = recordingD1([], async () => {
      await env.DB.prepare("UPDATE capture_scanner_keys SET revision = 5").run();
    });
    const sent: SentNotice[] = [];
    await operator("Test Operator", "en");
    expect(await run(world.admin, fields, { d1, sent })).toEqual({ ok: false, error: "changed" });
    expect(await storedKeys()).toMatchObject({ sealed: SEALED, revision: 5 });
    expect(await audits()).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("the notice to the operators", () => {
  it("mails every operator once, in their language, with the two key names", async () => {
    await seedKeys();
    const en = await operator("Test Operator EN", "en");
    const es = await operator("Test Operator ES", null);
    const sent: SentNotice[] = [];
    expect(await run(world.admin, await eraseFields(), { sent })).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: true });
    expect(sent.sort((a, b) => a.to.localeCompare(b.to))).toEqual(
      [
        { to: en.email, locale: "en" },
        { to: es.email, locale: "es" },
      ]
        .sort((a, b) => a.to.localeCompare(b.to))
        .map((r) => ({
          ...r,
          notice: { workspace: on().name, slug: on().slug, erased: true, keys: [KEY_NAMES] },
        })),
    );
    expect(sent.map((s) => s.to)).not.toContain(world.admin.email);
  });

  it("mails no super admin of a workspace, this one or another, who is not an operator", async () => {
    await seedKeys();
    const op = await operator("Test Operator", "en");
    const here = await workspaceSuperAdmin("Test Super Admin Here", DEFAULT_TEST_TENANT_ID);
    const there = await workspaceSuperAdmin("Test Super Admin There", SECOND_TEST_TENANT_ID);
    const sent: SentNotice[] = [];
    await run(world.admin, await eraseFields(), { sent });
    expect(sent.map((x) => x.to)).toEqual([op.email]);
    expect(sent.map((x) => x.to)).not.toContain(here.email);
    expect(sent.map((x) => x.to)).not.toContain(there.email);
  });

  it("mails a platform admin of an ordinary workspace when the platform tenant has no user", async () => {
    await seedKeys();
    const admin = await platformAdmin("Test Platform Admin", SECOND_TEST_TENANT_ID, "en");
    const sent: SentNotice[] = [];
    expect(await run(world.admin, await eraseFields(), { sent })).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: true });
    expect(sent.map((x) => x.to)).toEqual([admin.email]);
  });

  it("mails a platform tenant user and a platform admin of another tenant, one message each", async () => {
    await seedKeys();
    const op = await operator("Test Operator", "en");
    const admin = await platformAdmin("Test Platform Admin", SECOND_TEST_TENANT_ID, "es");
    const sent: SentNotice[] = [];
    await run(world.admin, await eraseFields(), { sent });
    expect(sent.map((x) => x.to).sort()).toEqual([op.email, admin.email].sort());
    expect(sent).toHaveLength(2);
  });

  it("mails one message when an address is on several rows, compared lowercased, with the first row's language", async () => {
    await seedKeys();
    // Two platform admins and no platform tenant user.
    await platformAdmin("Test Platform Admin One", DEFAULT_TEST_TENANT_ID, "en", "Shared.Person@Example.com");
    await platformAdmin("Test Platform Admin Two", SECOND_TEST_TENANT_ID, "es", "shared.person@example.com");
    const sent: SentNotice[] = [];
    await run(world.admin, await eraseFields(), { sent });
    expect(sent).toHaveLength(1);
    expect(sent[0].to.toLowerCase()).toBe("shared.person@example.com");
    // ORDER BY email, id: the uppercase "S" sorts before the lowercase "s".
    expect(sent[0].to).toBe("Shared.Person@Example.com");
    expect(sent[0].locale).toBe("en");
  });

  it("mails the operators when the erasure landed, though the scanner changed after the batch", async () => {
    await seedKeys({ revision: 4 });
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const fields = await revokeFields("compromised");
    // Right after the batch, someone else writes to the scanner.
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            await target.prepare("UPDATE capture_scanners SET revision = revision + 1, write_id = 'other-write'").run();
            return results;
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sent: SentNotice[] = [];
    expect(await run(world.admin, fields, { d1, sent })).toEqual({ ok: true, step: "revoke", keysErased: true, operatorsNotified: true });
    expect((await storedKeys()).sealed).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("logs a fixed line, and keeps the answer, when there is no operator to mail", async () => {
    await seedKeys();
    await workspaceSuperAdmin("Test Super Admin", DEFAULT_TEST_TENANT_ID);
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    const sent: SentNotice[] = [];
    try {
      expect(await run(world.admin, await eraseFields(), { sent })).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: false });
    } finally {
      console.error = original;
    }
    expect(sent).toEqual([]);
    expect(lines).toEqual([["scanner keys erased: no operator address to send a notice to"]]);
  });

  it("logs a fixed line, and keeps the answer, when the operators cannot be read", async () => {
    await seedKeys();
    await operator("Test Operator", "en");
    // The erasure's batch goes through; the read of the operators fails.
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM users")) throw new Error("test read failure");
            return target.prepare(sql);
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      expect(await run(world.admin, await eraseFields(), { d1 })).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: false });
    } finally {
      console.error = original;
    }
    expect((await storedKeys()).sealed).toBeNull();
    expect(lines).toEqual([["scanner keys erased: the operators could not be read"]]);
  });

  it("names the staging keys on staging", async () => {
    await seedKeys();
    await operator("Test Operator", "en");
    const sent: SentNotice[] = [];
    const form = new FormData();
    for (const [k, v] of Object.entries(await eraseFields())) form.set(k, v);
    await scannerTokenAction(actionDeps({ sent, environment: "staging" }), form, on(), {
      user: world.admin,
      homeTenantId: DEFAULT_TEST_TENANT_ID,
      impersonationSessionId: null,
    });
    expect(sent[0].notice.keys).toEqual([
      { write: `fisqua-neogranadina-staging-appliance-${UNIT}`, read: `fisqua-neogranadina-staging-appliance-${UNIT}-read` },
    ]);
  });

  it("mails the operators after a compromised revoke", async () => {
    await seedKeys();
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const sent: SentNotice[] = [];
    await run(world.admin, await revokeFields("compromised"), { sent });
    expect(sent).toHaveLength(1);
    expect(sent[0].notice.keys).toEqual([KEY_NAMES]);
  });

  it("names only the stored keys after Erase stored keys, whatever the scanner is named", async () => {
    await seedKeys({ applianceId: "rig-2" });
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const sent: SentNotice[] = [];
    await run(world.admin, await eraseFields(), { sent });
    expect(sent.map((s) => s.notice)).toEqual([
      {
        workspace: on().name,
        slug: on().slug,
        erased: true,
        keys: [{ write: "fisqua-neogranadina-appliance-rig-2", read: "fisqua-neogranadina-appliance-rig-2-read" }],
      },
    ]);
  });

  it("answers operatorsNotified false when every send fails, after a compromised revoke and after Erase stored keys", async () => {
    await operator("Test Operator", "en");
    await act(world.admin, "make");
    const failing = async () => {
      throw new Error("test send failure");
    };
    const original = console.error;
    console.error = () => {};
    try {
      expect(await run(world.admin, await revokeFields("compromised"), { sendKeysErased: failing })).toEqual({
        ok: true,
        step: "revoke",
        keysErased: false,
        operatorsNotified: false,
      });
      await seedKeys();
      expect(await run(world.admin, await eraseFields(), { sendKeysErased: failing })).toEqual({
        ok: true,
        step: "erase_keys",
        keysErased: true,
        operatorsNotified: false,
      });
    } finally {
      console.error = original;
    }
  });

  it("keeps the erasure and its answer when a send fails, and logs a fixed line", async () => {
    await seedKeys();
    const a = await operator("Test Operator A", "en");
    await operator("Test Operator B", "es");
    const tried: string[] = [];
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      const result = await run(world.admin, await eraseFields(), {
        sendKeysErased: async (to) => {
          tried.push(to);
          if (to === a.email) throw new Error(`send failed for ${to}`);
        },
      });
      expect(result).toEqual({ ok: true, step: "erase_keys", keysErased: true, operatorsNotified: true });
    } finally {
      console.error = original;
    }
    expect(tried).toHaveLength(2);
    expect((await storedKeys()).sealed).toBeNull();
    expect(lines).toEqual([["scanner keys erased: a notice to an operator could not be sent"]]);
    expect(JSON.stringify(lines)).not.toContain(a.email);
    expect(JSON.stringify(lines)).not.toContain(KEY_NAMES.write);
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

// @version v0.9.0
