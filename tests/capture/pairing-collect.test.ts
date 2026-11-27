/**
 * Tests — the pairing collect route
 *
 * This suite drives `handlePairingCollect`, the call a Captua unit polls
 * on Fisqua's main address, with its code and collect secret, until it
 * receives its link settings once. Each test seeds a tenant, an approver,
 * the workspace's stored keys sealed with a test key pair, optionally a
 * scanner, and a code row whose approval columns are set directly. It
 * pins, per contract §12.2:
 *
 *   - 202 `waiting` for a waiting code within its two minutes;
 *   - 200 with the payload (`tenant`, `environment`, `token`, `bucket`,
 *     `writeKey`, `readKey`, `ageRecipient`) for an approved code; the
 *     token hashes to the scanner's `token_sha256`, the scanner is named
 *     with the stored appliance id and carries the code's unit name and
 *     device id, the code is `collected`, and one `scanner_token` audit
 *     row `pair_collected` names the approver and, when the scanner was
 *     renamed, its previous name;
 *   - 410 `collected` on the next poll, with the scanner kept as the
 *     first collect left it, and exactly one 200 of two concurrent
 *     collects;
 *   - 410 `expired`, with the code `void` and the scanner unchanged,
 *     after a token write, a new store or an erasure of the stored keys,
 *     a scanner made after approval, and past either two-minute window;
 *   - 404 `unknown`, the same answer in status, body and headers, for an
 *     unknown code, a wrong secret or a body that is not the two strings;
 *     nothing is written and the code stays collectable;
 *   - 429 `rate-limited` with `Retry-After` on the 31st poll in a minute;
 *   - 503 `busy` while the private key is missing, with the code left
 *     approved for a later poll;
 *   - the 503 answers are logged with a fixed location tag and the
 *     error's name only, never its message, the code or the secret;
 *   - a bare 404 on a workspace's host, 405 `method` for GET;
 *   - `Cache-Control: no-store` on every answer, and no column of any
 *     row equal to the token;
 *   - the 200 is decided from the batch's own result: one batch and no
 *     read of the scanner after it;
 *   - a pairing clears the replaced unit's reported mode;
 *   - the collect's audit row takes the actor's name and home workspace
 *     from the approval's audit row when there is one;
 *   - `pairingTokenStatements` on their own: the scanner write lands only
 *     when the code row was marked collected in the same batch, and a
 *     second batch planned against the same read changes nothing.
 *
 * Every value here, keys included, is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedTenants, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import type { PairingDeps } from "../../app/lib/capture/pairing.server";
import { handlePairingCollect } from "../../app/lib/capture/pairing-collect.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { generatePairingKeyPair, sealKeys, type StoredKeyPairs } from "../../app/lib/capture/pairing-seal";
import { sha256Hex } from "../../app/lib/capture/token";
import {
  pairingLandedCondition,
  pairingTokenStatements,
  rowOfScanner,
  scannerQuery,
  type PairingTokenWrite,
} from "../../app/lib/capture/scanner-token";
import {
  action as collectAction,
  loader as collectLoader,
} from "../../app/routes/api.capture.v1.pairing.collect";

const ORIGIN = "https://fisqua.org";
const URL_COLLECT = `${ORIGIN}/api/capture/v1/pairing/collect`;
const TENANT = DEFAULT_TEST_TENANT_ID;
const TENANT_SLUG = "neogranadina";
// A minute boundary, so the poll window is predictable.
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 600_000);
const APPROVER = "approver-1";
const APPROVER_EMAIL = "approver@example.test";
const CODE = "7KQM2X";
const SECRET = "ab".repeat(32);
const OLD_TOKEN_SHA = "cd".repeat(32);
const CODE_ID = "code-1";

const KEYS: StoredKeyPairs = {
  writeKey: { keyId: "0001-write-test", applicationKey: "K001writeMadeUpSecret" },
  readKey: { keyId: "0001-read-test", applicationKey: "K001readMadeUpSecret" },
};

let privateJwkText = "";
let publicJwk: JsonWebKey;

beforeAll(async () => {
  await applyMigrations();
  const pair = await generatePairingKeyPair();
  publicJwk = pair.publicJwk;
  privateJwkText = JSON.stringify(pair.privateJwk);
});

beforeEach(async () => {
  await cleanDatabase();
  await seedTenants();
  await env.DB.prepare(
    "INSERT INTO users (id, tenant_id, email, name, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(APPROVER, TENANT, APPROVER_EMAIL, "Approver", 1, T0, T0)
    .run();
});

let idCounter = 0;

function deps(
  overrides: { now?: number; origin?: string; secret?: string | null; d1?: D1Database } = {},
): PairingDeps {
  const secret = "secret" in overrides ? overrides.secret : privateJwkText;
  return {
    db: drizzle(env.DB),
    env: {
      ...env,
      DB: overrides.d1 ?? env.DB,
      CAPTURE_PAIRING_ORIGIN: overrides.origin ?? ORIGIN,
      CAPTURE_PAIRING_ENVIRONMENT: "production",
      ...(secret === null ? {} : { CAPTURE_KEYS_PRIVATE_JWK: secret }),
    } as Env,
    now: () => overrides.now ?? T0 + 10_000,
    newId: () => `id-${++idCounter}`,
    clientAddress: () => "203.0.113.7",
  };
}

function post(body: unknown, init: { url?: string; raw?: string } = {}): Request {
  return new Request(init.url ?? URL_COLLECT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: init.raw ?? JSON.stringify(body),
  });
}

const GOOD = { code: CODE, collectSecret: SECRET };

async function storeKeys(revision = 3) {
  const sealed = await sealKeys(publicJwk, KEYS, { tenantId: TENANT, environment: "production" });
  await env.DB.prepare(
    "INSERT INTO capture_scanner_keys (tenant_id, appliance_id, bucket, sealed, age_recipient, revision, stored_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  )
    .bind(TENANT, "rig-1", "test-masters", sealed, "age1madeuprecipient", revision, T0 - 60_000)
    .run();
}

async function seedScanner(revision = 2, name = "old-rig") {
  await env.DB.prepare(
    "INSERT INTO capture_scanners (id, tenant_id, name, token_sha256, token_created_at, last_seen_at, " +
      "rate_window_start, rate_window_calls, revision, write_id, created_at, updated_at) " +
      "VALUES ('scanner-1', ?, ?, ?, ?, ?, ?, 4, ?, 'old-write', ?, ?)",
  )
    .bind(TENANT, name, OLD_TOKEN_SHA, T0 - 100_000, T0 - 5_000, T0 - 50_000, revision, T0 - 100_000, T0 - 100_000)
    .run();
}

async function seedCode(
  opts: { state?: string; approved?: boolean; scannerRevisionSeen?: number; keysRevisionSeen?: number } = {},
) {
  const approved = opts.approved ?? true;
  await env.DB.prepare(
    "INSERT INTO capture_pairing_codes (id, code_sha256, collect_secret_sha256, unit_name, device_id, " +
      "current_tenant, state, created_at, expires_at, tenant_id, approved_by, approved_at, collect_by, " +
      "scanner_revision_seen, keys_revision_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      CODE_ID,
      await sha256Hex(CODE),
      await sha256Hex(SECRET),
      "Reading room rig",
      "rig-dev-7",
      null,
      opts.state ?? (approved ? "approved" : "waiting"),
      T0 - 30_000,
      T0 + 90_000,
      approved ? TENANT : null,
      approved ? APPROVER : null,
      approved ? T0 : null,
      approved ? T0 + 120_000 : null,
      approved ? (opts.scannerRevisionSeen ?? 2) : null,
      approved ? (opts.keysRevisionSeen ?? 3) : null,
    )
    .run();
}

async function codeRow() {
  return env.DB.prepare("SELECT * FROM capture_pairing_codes WHERE id = ?").bind(CODE_ID).first<Record<string, unknown>>();
}

async function scannerRows() {
  const { results } = await env.DB.prepare("SELECT * FROM capture_scanners WHERE tenant_id = ?")
    .bind(TENANT)
    .all<Record<string, unknown>>();
  return results;
}

async function auditRows() {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'scanner_token'").all<
    Record<string, unknown>
  >();
  return results;
}

async function expectJson(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Content-Type")).toBe("application/json");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual(body);
}

describe("handlePairingCollect", () => {
  it("collect while waiting answers 202 waiting", async () => {
    await storeKeys();
    await seedCode({ approved: false });
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 202, { state: "waiting" });
    expect((await codeRow())!.state).toBe("waiting");
  });

  it("collect after approval answers 200 with the payload", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    // The code is accepted as a person might type it.
    const res = await handlePairingCollect(deps(), post({ code: "7kq-m2x", collectSecret: SECRET }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual([
      "ageRecipient",
      "bucket",
      "environment",
      "readKey",
      "tenant",
      "token",
      "writeKey",
    ]);
    expect(body.tenant).toBe(TENANT_SLUG);
    expect(body.environment).toBe("production");
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.bucket).toBe("test-masters");
    expect(body.ageRecipient).toBe("age1madeuprecipient");
    expect(body.writeKey).toEqual(KEYS.writeKey);
    expect(body.readKey).toEqual(KEYS.readKey);

    const [scanner] = await scannerRows();
    expect(scanner.token_sha256).toBe(await sha256Hex(body.token));
    expect(scanner.name).toBe("rig-1");
    expect(scanner.unit_name).toBe("Reading room rig");
    expect(scanner.device_id).toBe("rig-dev-7");
    expect(scanner.revision).toBe(3);
    expect(scanner.revoked_at).toBeNull();
    expect(scanner.last_seen_at).toBeNull();
    expect(scanner.rate_window_start).toBeNull();
    expect(scanner.rate_window_calls).toBe(0);
    expect(scanner.token_created_at).toBe(T0 + 10_000);

    const code = await codeRow();
    expect(code!.state).toBe("collected");
    expect(code!.collected_at).toBe(T0 + 10_000);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(APPROVER);
    expect(audit[0].actor_user_id_text).toBe(APPROVER_EMAIL);
    expect(audit[0].actor_tenant_id).toBe(TENANT);
    expect(audit[0].target_tenant_id).toBe(TENANT);
    expect(audit[0].target_object_kind).toBe("capture_scanner");
    expect(audit[0].target_object_id).toBe("scanner-1");
    expect(JSON.parse(audit[0].details as string)).toEqual({
      step: "pair_collected",
      unitName: "Reading room rig",
      deviceId: "rig-dev-7",
      previousName: "old-rig",
    });

    // The token is stored nowhere: no column of any row the collect wrote or counted equals it.
    for (const table of ["capture_scanners", "capture_pairing_codes", "audit_log", "capture_pairing_limits"]) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
      for (const row of results) {
        for (const value of Object.values(row)) {
          expect(value).not.toBe(body.token);
          if (typeof value === "string") expect(value.includes(body.token)).toBe(false);
        }
      }
    }
  });

  it("records no previous name when the scanner already carried the stored appliance id, or there was none", async () => {
    await storeKeys();
    await seedScanner(2, "rig-1");
    await seedCode();
    expect((await handlePairingCollect(deps(), post(GOOD))).status).toBe(200);
    expect(JSON.parse((await auditRows())[0].details as string)).toEqual({
      step: "pair_collected",
      unitName: "Reading room rig",
      deviceId: "rig-dev-7",
    });
  });

  it("collect twice answers 410 collected", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const first = await handlePairingCollect(deps(), post(GOOD));
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    await expectJson(await handlePairingCollect(deps({ now: T0 + 15_000 }), post(GOOD)), 410, {
      state: "collected",
    });
    const [scanner] = await scannerRows();
    expect(scanner.token_sha256).toBe(await sha256Hex(token));
    expect(scanner.revision).toBe(3);
    expect(await auditRows()).toHaveLength(1);
  });

  it("two concurrent collects of one approved code yield one 200 and one 410", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const answers = await Promise.all([
      handlePairingCollect(deps(), post(GOOD)),
      handlePairingCollect(deps(), post(GOOD)),
    ]);
    const statuses = answers.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 410]);
    const ok = answers.find((r) => r.status === 200)!;
    const { token } = (await ok.json()) as { token: string };
    const [scanner] = await scannerRows();
    expect(scanner.token_sha256).toBe(await sha256Hex(token));
    expect(scanner.revision).toBe(3);
    expect((await codeRow())!.state).toBe("collected");
    expect(await auditRows()).toHaveLength(1);
  });

  it("collect after revoke answers 410 expired", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    // A token write after approval raises the scanner's revision.
    await env.DB.prepare("UPDATE capture_scanners SET revision = 3, revoked_at = ?, write_id = 'revoke-write'")
      .bind(T0 + 5_000)
      .run();
    const before = await scannerRows();
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 410, { state: "expired" });
    expect(await scannerRows()).toEqual(before);
    expect((await codeRow())!.state).toBe("void");
    expect(await auditRows()).toHaveLength(0);
  });

  it("collect after a scanner was made since approval answers 410 expired", async () => {
    await storeKeys();
    await seedCode({ scannerRevisionSeen: 0 });
    await seedScanner(1, "new-rig");
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 410, { state: "expired" });
    const [scanner] = await scannerRows();
    expect(scanner.name).toBe("new-rig");
    expect(scanner.token_sha256).toBe(OLD_TOKEN_SHA);
    expect((await codeRow())!.state).toBe("void");
  });

  it("collect after new store answers 410 expired", async () => {
    await storeKeys(4);
    await seedScanner();
    await seedCode({ keysRevisionSeen: 3 });
    const before = await scannerRows();
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 410, { state: "expired" });
    expect(await scannerRows()).toEqual(before);
    expect((await codeRow())!.state).toBe("void");
  });

  it("collect after erase answers 410 expired", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    await env.DB.prepare(
      "UPDATE capture_scanner_keys SET sealed = NULL, erased_at = ?, erased_by = ?, revision = revision + 1",
    )
      .bind(T0 + 5_000, APPROVER)
      .run();
    const before = await scannerRows();
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 410, { state: "expired" });
    expect(await scannerRows()).toEqual(before);
    expect((await codeRow())!.state).toBe("void");
  });

  it("collect after erase answers 410 expired even with the revision as seen", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    await env.DB.prepare("UPDATE capture_scanner_keys SET sealed = NULL").run();
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 410, { state: "expired" });
    expect((await codeRow())!.state).toBe("void");
  });

  it("collect past the two minutes answers 410 expired for a waiting code", async () => {
    await storeKeys();
    await seedCode({ approved: false });
    await expectJson(await handlePairingCollect(deps({ now: T0 + 90_000 }), post(GOOD)), 410, {
      state: "expired",
    });
    expect((await codeRow())!.state).toBe("void");
  });

  it("collect past the two minutes answers 410 expired for an approved code", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const before = await scannerRows();
    await expectJson(await handlePairingCollect(deps({ now: T0 + 120_000 }), post(GOOD)), 410, {
      state: "expired",
    });
    expect(await scannerRows()).toEqual(before);
    expect((await codeRow())!.state).toBe("void");
  });

  it("collect of a void code answers 410 expired", async () => {
    await storeKeys();
    await seedCode({ state: "void" });
    await expectJson(await handlePairingCollect(deps(), post(GOOD)), 410, { state: "expired" });
  });

  it("wrong secret answers 404 unknown and leaves the code collectable", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const before = await codeRow();
    const wrong = await handlePairingCollect(deps(), post({ code: CODE, collectSecret: "ef".repeat(32) }));
    const unknown = await handlePairingCollect(deps(), post({ code: "ZZZZZZ", collectSecret: SECRET }));
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(404);
      expect([...res.headers.entries()].sort()).toEqual([
        ["cache-control", "no-store"],
        ["content-type", "application/json"],
      ]);
      expect(await res.json()).toEqual({ state: "unknown" });
    }
    // Nothing was written, not even a poll.
    expect(await codeRow()).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
    expect((await handlePairingCollect(deps(), post(GOOD))).status).toBe(200);
  });

  it("a body that is not the code and the secret answers 404 unknown", async () => {
    await storeKeys();
    await seedCode();
    const before = await codeRow();
    const bodies: Array<{ body?: unknown; raw?: string }> = [
      { raw: "not json" },
      { body: [] },
      { body: { code: CODE } },
      { body: { collectSecret: SECRET } },
      { body: { code: 7, collectSecret: SECRET } },
      { body: { code: CODE, collectSecret: 7 } },
      { body: { code: "7KQ", collectSecret: SECRET } },
    ];
    for (const b of bodies) {
      await expectJson(await handlePairingCollect(deps(), post(b.body, { raw: b.raw })), 404, { state: "unknown" });
    }
    expect(await codeRow()).toEqual(before);
  });

  it("the 31st poll in a minute answers 429", async () => {
    await storeKeys();
    await seedCode({ approved: false });
    for (let i = 0; i < 30; i++) {
      expect((await handlePairingCollect(deps(), post(GOOD))).status).toBe(202);
    }
    const res = await handlePairingCollect(deps(), post(GOOD));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("50");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ rule: "rate-limited" });
    // The next minute counts afresh.
    expect((await handlePairingCollect(deps({ now: T0 + 60_000 }), post(GOOD))).status).toBe(202);
  });

  it("collect creates the scanner when the workspace had none", async () => {
    await storeKeys();
    await seedCode({ scannerRevisionSeen: 0 });
    const res = await handlePairingCollect(deps(), post(GOOD));
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const rows = await scannerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "rig-1",
      unit_name: "Reading room rig",
      device_id: "rig-dev-7",
      token_sha256: await sha256Hex(token),
      token_created_at: T0 + 10_000,
      revoked_at: null,
      last_seen_at: null,
      rate_window_calls: 0,
      revision: 1,
      created_at: T0 + 10_000,
      updated_at: T0 + 10_000,
    });
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].target_object_id).toBe(rows[0].id);
  });

  it("collect renames a scanner made by Make token under another name", async () => {
    await storeKeys();
    await seedScanner(2, "made-by-hand");
    await seedCode();
    const res = await handlePairingCollect(deps(), post(GOOD));
    expect(res.status).toBe(200);
    const [scanner] = await scannerRows();
    expect(scanner.id).toBe("scanner-1");
    expect(scanner.name).toBe("rig-1");
    expect(scanner.token_sha256).not.toBe(OLD_TOKEN_SHA);
  });

  it("collect while the private key is missing answers 503 and a later collect answers 200", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const before = await scannerRows();
    const res = await handlePairingCollect(deps({ secret: null }), post(GOOD));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ rule: "busy" });
    expect((await codeRow())!.state).toBe("approved");
    expect(await scannerRows()).toEqual(before);
    expect((await handlePairingCollect(deps({ now: T0 + 15_000 }), post(GOOD))).status).toBe(200);
  });

  it("collect on a tenant host answers bare 404", async () => {
    await storeKeys();
    await seedCode();
    const before = await codeRow();
    for (const method of ["POST", "GET"]) {
      const res = await handlePairingCollect(
        deps(),
        new Request("https://neogranadina.fisqua.org/api/capture/v1/pairing/collect", {
          method,
          body: method === "POST" ? JSON.stringify(GOOD) : undefined,
        }),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBeNull();
      expect(await res.text()).toBe("");
    }
    expect(await codeRow()).toEqual(before);
  });

  it("collect by GET answers 405 method", async () => {
    await expectJson(await handlePairingCollect(deps(), new Request(URL_COLLECT)), 405, { rule: "method" });
  });
});

describe("the 503 log lines", () => {
  it("logs a fixed location tag and the error's name for an unexpected error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingD1 = {
        prepare: () => {
          throw new Error("D1_ERROR: test failure");
        },
      } as unknown as D1Database;
      const res = await handlePairingCollect(deps({ d1: failingD1 }), post(GOOD));
      expect(res.status).toBe(503);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toHaveLength(1);
      const line = String(logged.mock.calls[0][0]);
      expect(line).toContain("pairing collect: unexpected error");
      expect(line).toContain("Error");
      expect(line).not.toContain("test failure");
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(SECRET);
    } finally {
      logged.mockRestore();
    }
  });

  it("logs a fixed location tag and the error's name when the stored keys cannot be opened", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await handlePairingCollect(deps({ secret: null }), post(GOOD));
      expect(res.status).toBe(503);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toHaveLength(1);
      const line = String(logged.mock.calls[0][0]);
      expect(line).toContain("pairing collect: stored keys could not be opened");
      expect(line).toContain("Error");
      // The error's own message is not logged.
      expect(line).not.toContain("The stored scanner keys");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("handlePairingCollect after the batch", () => {
  /** The test database, recording each statement prepared and each batch run, in order. */
  function recordingD1(log: string[]): D1Database {
    return {
      prepare: (query: string) => {
        log.push(query);
        return env.DB.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => {
        log.push("BATCH");
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
  }

  it("answers 200 from the batch result, with one batch and no later scanner read", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const log: string[] = [];
    const res = await handlePairingCollect(deps({ d1: recordingD1(log) }), post(GOOD));
    expect(res.status).toBe(200);
    expect(log.filter((q) => q === "BATCH")).toHaveLength(1);
    const after = log.slice(log.indexOf("BATCH") + 1);
    expect(after).toEqual([]);
  });

  it("clears the replaced unit's reported mode", async () => {
    await storeKeys();
    await seedScanner();
    await env.DB.prepare("UPDATE capture_scanners SET mode = 'fisqua', mode_reported_at = ?")
      .bind(T0 - 7_000)
      .run();
    await seedCode();
    expect((await handlePairingCollect(deps(), post(GOOD))).status).toBe(200);
    const [scanner] = await scannerRows();
    expect(scanner.mode).toBeNull();
    expect(scanner.mode_reported_at).toBeNull();
  });

  it("takes the actor's name and home workspace from the approval's audit row", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    // The approval's row as the Scanner page writes it, by a federation
    // staff member whose home workspace is not this one.
    await env.DB.prepare(
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
        "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details) " +
        "VALUES ('approval-audit', ?, ?, ?, ?, 'scanner_token', ?, 'capture_pairing_code', ?, NULL, ?)",
    )
      .bind(
        T0,
        APPROVER,
        "staff-at-approval@example.test",
        PLATFORM_TENANT_ID,
        TENANT,
        CODE_ID,
        JSON.stringify({ step: "pair_approved", unitName: "Reading room rig", deviceId: "rig-dev-7" }),
      )
      .run();
    expect((await handlePairingCollect(deps(), post(GOOD))).status).toBe(200);
    const collected = (await auditRows()).filter((r) => r.target_object_kind === "capture_scanner");
    expect(collected).toHaveLength(1);
    expect(collected[0].actor_user_id).toBe(APPROVER);
    expect(collected[0].actor_user_id_text).toBe("staff-at-approval@example.test");
    expect(collected[0].actor_tenant_id).toBe(PLATFORM_TENANT_ID);
    expect(collected[0].target_tenant_id).toBe(TENANT);
  });
});

describe("pairingTokenStatements", () => {
  async function plan(writeId: string): Promise<PairingTokenWrite> {
    const q = scannerQuery(TENANT);
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<Record<string, unknown>>();
    return {
      codeId: CODE_ID,
      tenantId: TENANT,
      current: results[0] ? rowOfScanner(results[0]) : null,
      newScannerId: `scanner-${writeId}`,
      applianceId: "rig-1",
      unitName: "Reading room rig",
      deviceId: "rig-dev-7",
      sha256: (writeId === "w1" ? "1" : "2").repeat(64),
      now: T0 + 10_000,
      writeId,
      keysRevisionSeen: 3,
    };
  }

  async function run(w: PairingTokenWrite) {
    const statements = pairingTokenStatements(w);
    const results = await env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
    const landed = pairingLandedCondition(w);
    const row = await env.DB.prepare(`SELECT 1 FROM capture_scanners WHERE ${landed.sql}`)
      .bind(...landed.params)
      .first();
    return { codeChanges: results[0].meta.changes, landed: row !== null };
  }

  for (const existing of [true, false]) {
    const label = existing ? "an existing scanner" : "no scanner";
    it(`writes no scanner when the code is not approved, with ${label}`, async () => {
      await storeKeys();
      if (existing) await seedScanner();
      await seedCode({ state: "void", scannerRevisionSeen: existing ? 2 : 0 });
      const before = await scannerRows();
      expect(await run(await plan("w1"))).toEqual({ codeChanges: 0, landed: false });
      expect(await scannerRows()).toEqual(before);
      expect((await codeRow())!.state).toBe("void");
    });

    it(`lands once of two batches planned against one read, with ${label}`, async () => {
      await storeKeys();
      if (existing) await seedScanner();
      await seedCode({ scannerRevisionSeen: existing ? 2 : 0 });
      const first = await plan("w1");
      const second = await plan("w2");
      expect(await run(first)).toEqual({ codeChanges: 1, landed: true });
      expect(await run(second)).toEqual({ codeChanges: 0, landed: false });
      const rows = await scannerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].token_sha256).toBe("1".repeat(64));
      expect(rows[0].write_id).toBe("w1");
    });
  }

  it("marks nothing collected when the keys changed after the read", async () => {
    await storeKeys();
    await seedScanner();
    await seedCode();
    const w = await plan("w1");
    await env.DB.prepare("UPDATE capture_scanner_keys SET revision = 4").run();
    expect(await run(w)).toEqual({ codeChanges: 0, landed: false });
    expect((await codeRow())!.state).toBe("approved");
  });
});

describe("the collect route", () => {
  const context = (origin: string) =>
    ({
      cloudflare: {
        env: {
          ...env,
          CAPTURE_PAIRING_ORIGIN: origin,
          CAPTURE_PAIRING_ENVIRONMENT: "production",
          CAPTURE_KEYS_PRIVATE_JWK: privateJwkText,
        },
        ctx: { waitUntil: () => {} },
      },
    }) as any;

  it("answers GET with 405 on the main address", async () => {
    const res = (await collectLoader({
      request: new Request(URL_COLLECT),
      context: context(ORIGIN),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ rule: "method" });
  });

  it("answers an unknown code by POST with 404 unknown", async () => {
    const res = (await collectAction({
      request: post(GOOD),
      context: context(ORIGIN),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ state: "unknown" });
  });

  it("answers POST with a bare 404 on a workspace's host", async () => {
    const res = (await collectAction({
      request: post(GOOD),
      context: context("https://other.example"),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

// @version v0.9.0
