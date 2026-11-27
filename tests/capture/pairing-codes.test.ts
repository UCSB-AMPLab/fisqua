/**
 * Tests — the pairing codes route
 *
 * This suite drives `handlePairingCodes`, the unauthenticated call a
 * Captua unit makes on Fisqua's main address to ask for a pairing code,
 * with constructed requests, the test D1 database and a clock the tests
 * set. It pins:
 *
 *   - 201 with a 6-character code, a 64-hex collect secret,
 *     `expiresInSeconds` 120 and `pollSeconds` 5, and a `waiting` row
 *     that holds only the SHA-256 of the code and of the secret, the
 *     unit name trimmed, and an expiry 120 s after issue;
 *   - 400 with the contract's rules: `unit-name` for an empty, too long
 *     or control-character name, or a body that is not a JSON object;
 *     `device-id` and `current-tenant` for values outside
 *     `^[a-z0-9-]{1,32}$`; no `currentTenant` is accepted;
 *   - 429 `rate-limited` with `Retry-After` on the 21st request from one
 *     address in 10 minutes, and on the 1,001st live code, with
 *     `Retry-After: 120`; of two requests sent at once with 999 live
 *     codes, one is answered 201 and the other 429, leaving 1,000;
 *   - 405 `method` for a method other than POST, and from the route's
 *     loader;
 *   - a bare 404 with no body and no JSON type on a workspace's host, or
 *     with the main address unset;
 *   - a code that collides with a stored one is drawn again, after rows
 *     expired more than a day are deleted; after 5 collisions, 503
 *     `busy` with `Retry-After: 5`;
 *   - every answer but the bare 404 is `application/json`;
 *   - each request that passes validation deletes, at most 50 of each,
 *     code rows in any state that expired more than a day ago and limit
 *     rows whose window began more than a day ago;
 *   - the indexes on `expires_at` and `window_start` exist in the
 *     migration and in the test mirror;
 *   - the address limit counts an IPv6 address by its /64 and an IPv4
 *     address, mapped or not, whole (`addressLimitSubject`);
 *   - a dotted IPv4 group is read only as the last group of an IPv6
 *     address;
 *   - an unexpected error after the method check is 503 `busy`, JSON,
 *     and is logged with a fixed location tag and the error's name only;
 *   - `unitName` refuses control, format, surrogate, private-use and
 *     line and paragraph separator characters (`\p{Cc}`, `\p{Cf}`,
 *     `\p{Cs}`, `\p{Co}`, `\p{Zl}`, `\p{Zp}`) and accepts accented and
 *     non-Latin letters.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import {
  addressLimitSubject,
  handlePairingCodes,
  type PairingDeps,
} from "../../app/lib/capture/pairing.server";
import { sha256Hex } from "../../app/lib/capture/token";
import { capturePairingCodes } from "../../app/db/schema";
import { loader as codesLoader } from "../../app/routes/api.capture.v1.pairing.codes";

const ORIGIN = "https://fisqua.org";
const URL_CODES = `${ORIGIN}/api/capture/v1/pairing/codes`;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % 600_000);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
});

let idCounter = 0;

function deps(overrides: Partial<PairingDeps> & { origin?: string } = {}): PairingDeps {
  const { origin, ...rest } = overrides;
  return {
    db: drizzle(env.DB),
    env: {
      ...env,
      CAPTURE_PAIRING_ORIGIN: "origin" in overrides ? origin : ORIGIN,
      CAPTURE_PAIRING_ENVIRONMENT: "production",
    } as Env,
    now: () => T0,
    newId: () => `pc-${++idCounter}`,
    clientAddress: (r: Request) => r.headers.get("CF-Connecting-IP"),
    ...rest,
  };
}

function post(body: unknown, init: { url?: string; ip?: string; raw?: string } = {}): Request {
  return new Request(init.url ?? URL_CODES, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": init.ip ?? "203.0.113.7" },
    body: init.raw ?? JSON.stringify(body),
  });
}

const GOOD = { unitName: "Reading room rig", deviceId: "rig-1", currentTenant: "ahr" };

async function rows() {
  return drizzle(env.DB).select().from(capturePairingCodes).all();
}

describe("handlePairingCodes", () => {
  it("codes answers 201 with a code, a secret, expiresInSeconds 120 and pollSeconds 5", async () => {
    const res = await handlePairingCodes(deps(), post({ ...GOOD, unitName: "  Reading room rig  " }));
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "collectSecret", "expiresInSeconds", "pollSeconds"]);
    expect(body.code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(body.collectSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresInSeconds).toBe(120);
    expect(body.pollSeconds).toBe(5);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    const row = stored[0];
    expect(row.codeSha256).toBe(await sha256Hex(body.code as string));
    expect(row.collectSecretSha256).toBe(await sha256Hex(body.collectSecret as string));
    expect(row.state).toBe("waiting");
    expect(row.unitName).toBe("Reading room rig");
    expect(row.deviceId).toBe("rig-1");
    expect(row.currentTenant).toBe("ahr");
    expect(row.createdAt).toBe(T0);
    expect(row.expiresAt).toBe(T0 + 120_000);
    expect(row.tenantId).toBeNull();
    // Only hashes are kept: no column holds the code or the secret.
    for (const value of Object.values(row)) {
      expect(value).not.toBe(body.code);
      expect(value).not.toBe(body.collectSecret);
    }
  });

  it("codes rejects a bad unitName/deviceId/currentTenant", async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...GOOD, unitName: "" }, "unit-name"],
      [{ ...GOOD, unitName: "   " }, "unit-name"],
      [{ ...GOOD, unitName: "x".repeat(65) }, "unit-name"],
      [{ ...GOOD, unitName: "rig\u0007" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\u0085" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\u202Egir" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\u200Bone" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\ud800" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\uE000" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\u2028one" }, "unit-name"],
      [{ ...GOOD, unitName: "rig\u2029one" }, "unit-name"],
      [{ ...GOOD, unitName: 42 }, "unit-name"],
      [{ deviceId: "rig-1" }, "unit-name"],
      [{ ...GOOD, deviceId: "Rig_1" }, "device-id"],
      [{ ...GOOD, deviceId: "" }, "device-id"],
      [{ ...GOOD, deviceId: "a".repeat(33) }, "device-id"],
      [{ unitName: "Rig" }, "device-id"],
      [{ ...GOOD, currentTenant: "AHR" }, "current-tenant"],
      [{ ...GOOD, currentTenant: "" }, "current-tenant"],
      [{ ...GOOD, currentTenant: 7 }, "current-tenant"],
    ];
    for (const [body, rule] of cases) {
      const res = await handlePairingCodes(deps(), post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ rule });
    }
    // Accented and non-Latin names are accepted.
    for (const unitName of ["Escáner Biblioteca Ñuñoa", "Сканер 1", "スキャナー"]) {
      const res = await handlePairingCodes(deps(), post({ ...GOOD, unitName }));
      expect(res.status, unitName).toBe(201);
    }
    await env.DB.prepare("DELETE FROM capture_pairing_codes").run();
    // A 64-character name is accepted.
    const ok = await handlePairingCodes(deps(), post({ ...GOOD, unitName: "x".repeat(64) }));
    expect(ok.status).toBe(201);
    expect(await rows()).toHaveLength(1);
  });

  it("codes answers 400 unit-name for a body that is not a JSON object", async () => {
    for (const raw of ["not json", "[]", "null", "\"rig\"", ""]) {
      const res = await handlePairingCodes(deps(), post(null, { raw }));
      expect(res.status, raw).toBe(400);
      expect(await res.json()).toEqual({ rule: "unit-name" });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("codes accepts no currentTenant", async () => {
    const res = await handlePairingCodes(deps(), post({ unitName: "Rig", deviceId: "rig-1" }));
    expect(res.status).toBe(201);
    const [row] = await rows();
    expect(row.currentTenant).toBeNull();
  });

  it("the 21st request from one address in 10 minutes answers 429 rate-limited with Retry-After", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await handlePairingCodes(deps(), post(GOOD));
      expect(res.status).toBe(201);
    }
    const refused = await handlePairingCodes(deps(), post(GOOD));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Content-Type")).toBe("application/json");
    expect(await refused.json()).toEqual({ rule: "rate-limited" });
    const wait = Number(refused.headers.get("Retry-After"));
    expect(Number.isInteger(wait)).toBe(true);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(600);
    expect(await rows()).toHaveLength(20);

    // Another address is counted on its own.
    const other = await handlePairingCodes(deps(), post(GOOD, { ip: "198.51.100.9" }));
    expect(other.status).toBe(201);
  });

  it("counts requests without a client address in one shared bucket, by hash", async () => {
    const noIp = () =>
      new Request(URL_CODES, { method: "POST", body: JSON.stringify(GOOD) });
    for (let i = 0; i < 20; i++) {
      expect((await handlePairingCodes(deps(), noIp())).status).toBe(201);
    }
    expect((await handlePairingCodes(deps(), noIp())).status).toBe(429);
    const keys = (await env.DB.prepare("SELECT key FROM capture_pairing_limits").all<{ key: string }>()).results;
    expect(keys.map((k) => k.key)).toEqual([`codes-ip:${await sha256Hex("unknown")}`]);
  });

  it("stores the client address only as a hash", async () => {
    await handlePairingCodes(deps(), post(GOOD, { ip: "203.0.113.7" }));
    const keys = (await env.DB.prepare("SELECT key FROM capture_pairing_limits").all<{ key: string }>()).results;
    expect(keys.map((k) => k.key)).toEqual([`codes-ip:${await sha256Hex("203.0.113.7")}`]);
  });

  it("refuses the 1,001st live code with 429 and Retry-After 120", async () => {
    // 1,000 live waiting codes, plus rows that do not count: expired,
    // approved.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
       INSERT INTO capture_pairing_codes
         (id, code_sha256, collect_secret_sha256, unit_name, device_id, state, created_at, expires_at)
       SELECT 'live-' || i, 'live-hash-' || i, 'secret-' || i, 'Rig', 'rig-1', 'waiting', ?1, ?2 FROM n`,
    )
      .bind(T0 - 1000, T0 + 60_000)
      .run();
    const refused = await handlePairingCodes(deps(), post(GOOD));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Content-Type")).toBe("application/json");
    expect(refused.headers.get("Retry-After")).toBe("120");
    expect(await refused.json()).toEqual({ rule: "rate-limited" });

    // One of them expiring makes room.
    await env.DB.prepare("UPDATE capture_pairing_codes SET expires_at = ?1 WHERE id = 'live-1'").bind(T0).run();
    await env.DB.prepare("UPDATE capture_pairing_codes SET state = 'approved' WHERE id = 'live-2'").run();
    const ok = await handlePairingCodes(deps(), post(GOOD));
    expect(ok.status).toBe(201);
  });

  it("lets one of two requests sent at once with 999 live codes in, and refuses the other", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
       INSERT INTO capture_pairing_codes
         (id, code_sha256, collect_secret_sha256, unit_name, device_id, state, created_at, expires_at)
       SELECT 'live-' || i, 'live-hash-' || i, 'secret-' || i, 'Rig', 'rig-1', 'waiting', ?1, ?2 FROM n`,
    )
      .bind(T0 - 1000, T0 + 60_000)
      .run();
    const answers = await Promise.all([
      handlePairingCodes(deps(), post(GOOD, { ip: "203.0.113.7" })),
      handlePairingCodes(deps(), post(GOOD, { ip: "203.0.113.8" })),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 429]);
    const refused = answers.find((a) => a.status === 429)!;
    expect(refused.headers.get("Retry-After")).toBe("120");
    expect(await refused.json()).toEqual({ rule: "rate-limited" });
    const live = await env.DB.prepare("SELECT count(*) AS n FROM capture_pairing_codes WHERE state = 'waiting'").first<{ n: number }>();
    expect(live!.n).toBe(1000);
  });

  it("draws again on a code collision, first deleting rows expired more than a day", async () => {
    const first = await handlePairingCodes(deps({ newCode: () => "AAAAAA" }), post(GOOD));
    expect(first.status).toBe(201);
    await env.DB.prepare(
      `INSERT INTO capture_pairing_codes
         (id, code_sha256, collect_secret_sha256, unit_name, device_id, state, created_at, expires_at)
       VALUES ('old', 'old-hash', 'old-secret', 'Rig', 'rig-1', 'void', ?1, ?2),
              ('recent', 'recent-hash', 'recent-secret', 'Rig', 'rig-1', 'void', ?1, ?3)`,
    )
      .bind(T0 - 2 * DAY_MS, T0 - DAY_MS - 1, T0 - DAY_MS + 1)
      .run();

    const draws = ["AAAAAA", "BBBBBB"];
    const second = await handlePairingCodes(deps({ newCode: () => draws.shift()! }), post(GOOD));
    expect(second.status).toBe(201);
    expect(((await second.json()) as { code: string }).code).toBe("BBBBBB");
    const ids = (await rows()).map((r) => r.id).sort();
    expect(ids).not.toContain("old");
    expect(ids).toContain("recent");
    expect(ids).toHaveLength(3);
  });

  it("answers 503 busy with Retry-After 5 after 5 collisions", async () => {
    await handlePairingCodes(deps({ newCode: () => "AAAAAA" }), post(GOOD));
    let calls = 0;
    const res = await handlePairingCodes(
      deps({ newCode: () => { calls++; return "AAAAAA"; } }),
      post(GOOD),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toEqual({ rule: "busy" });
    expect(calls).toBe(5);
    expect(await rows()).toHaveLength(1);
  });

  it("every answer is application/json", async () => {
    const created = await handlePairingCodes(deps(), post(GOOD));
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toBe("application/json");

    const bad = await handlePairingCodes(deps(), post({ ...GOOD, deviceId: "Rig_1" }));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Content-Type")).toBe("application/json");

    for (let i = 0; i < 20; i++) await handlePairingCodes(deps(), post(GOOD, { ip: "192.0.2.1" }));
    const limited = await handlePairingCodes(deps(), post(GOOD, { ip: "192.0.2.1" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Content-Type")).toBe("application/json");

    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await handlePairingCodes(deps(), new Request(URL_CODES, { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ rule: "method" });
    }
  });

  it("codes on a tenant host answers bare 404", async () => {
    const res = await handlePairingCodes(
      deps(),
      post(GOOD, { url: "https://ahr.fisqua.org/api/capture/v1/pairing/codes" }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toBe("application/json");
    expect(await res.text()).toBe("");
    expect(await rows()).toHaveLength(0);

    // A wrong method on a workspace's host is a bare 404 too.
    const get = await handlePairingCodes(
      deps(),
      new Request("https://ahr.fisqua.org/api/capture/v1/pairing/codes"),
    );
    expect(get.status).toBe(404);
    expect(await get.text()).toBe("");
  });

  it("answers bare 404 everywhere when the main address is unset", async () => {
    for (const origin of ["", undefined]) {
      const res = await handlePairingCodes(deps({ origin: origin as string }), post(GOOD));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("cleanup of old rows", () => {
  async function insertCode(id: string, state: string, expiresAt: number) {
    await env.DB.prepare(
      `INSERT INTO capture_pairing_codes
         (id, code_sha256, collect_secret_sha256, unit_name, device_id, state, created_at, expires_at)
       VALUES (?1, ?1 || '-hash', ?1 || '-secret', 'Rig', 'rig-1', ?2, ?3, ?3)`,
    )
      .bind(id, state, expiresAt)
      .run();
  }
  async function insertLimit(key: string, windowStart: number) {
    await env.DB.prepare("INSERT INTO capture_pairing_limits (key, window_start, count) VALUES (?1, ?2, 1)")
      .bind(key, windowStart)
      .run();
  }
  async function codeIds() {
    return (await env.DB.prepare("SELECT id FROM capture_pairing_codes ORDER BY id").all<{ id: string }>()).results.map(
      (r) => r.id,
    );
  }
  async function limitKeys() {
    return (await env.DB.prepare("SELECT key FROM capture_pairing_limits ORDER BY key").all<{ key: string }>()).results.map(
      (r) => r.key,
    );
  }
  const HOUR_MS = 60 * 60 * 1000;

  it("deletes code rows in any state and limit rows older than a day, and keeps a 23-hour-old one", async () => {
    await insertCode("old-waiting", "waiting", T0 - DAY_MS - 1);
    await insertCode("old-approved", "approved", T0 - 2 * DAY_MS);
    await insertCode("old-collected", "collected", T0 - 3 * DAY_MS);
    await insertCode("recent", "void", T0 - 23 * HOUR_MS);
    await insertLimit("codes-ip:old", T0 - DAY_MS - 1);
    await insertLimit("codes-ip:recent", T0 - 23 * HOUR_MS);

    const res = await handlePairingCodes(deps({ newId: () => "new" }), post(GOOD));
    expect(res.status).toBe(201);
    expect(await codeIds()).toEqual(["new", "recent"]);
    const keys = await limitKeys();
    expect(keys).not.toContain("codes-ip:old");
    expect(keys).toContain("codes-ip:recent");
  });

  it("deletes at most 50 code rows and 50 limit rows per request", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
       INSERT INTO capture_pairing_codes
         (id, code_sha256, collect_secret_sha256, unit_name, device_id, state, created_at, expires_at)
       SELECT 'old-' || i, 'old-hash-' || i, 'old-secret-' || i, 'Rig', 'rig-1', 'void', ?1, ?1 FROM n`,
    )
      .bind(T0 - 2 * DAY_MS)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
       INSERT INTO capture_pairing_limits (key, window_start, count) SELECT 'old-' || i, ?1, 1 FROM n`,
    )
      .bind(T0 - 2 * DAY_MS)
      .run();

    const res = await handlePairingCodes(deps(), post(GOOD));
    expect(res.status).toBe(201);
    const codes = await codeIds();
    expect(codes.filter((id) => id.startsWith("old-"))).toHaveLength(10);
    expect(codes).toHaveLength(11);
    const keys = await limitKeys();
    expect(keys.filter((k) => k.startsWith("old-"))).toHaveLength(10);
  });

  it("does not delete on a request that fails validation", async () => {
    await insertCode("old", "void", T0 - 2 * DAY_MS);
    const res = await handlePairingCodes(deps(), post({ ...GOOD, deviceId: "Rig_1" }));
    expect(res.status).toBe(400);
    expect(await codeIds()).toEqual(["old"]);
  });
});

describe("indexes", () => {
  const migrations = import.meta.glob("../../drizzle/0123_capture_pairing.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const migration = Object.values(migrations)[0] ?? "";

  it("the migration and the test mirror index expires_at and window_start", async () => {
    expect(migration).toContain(
      "CREATE INDEX capture_pairing_codes_expires_idx ON capture_pairing_codes (expires_at);",
    );
    expect(migration).toContain(
      "CREATE INDEX capture_pairing_limits_window_idx ON capture_pairing_limits (window_start);",
    );
    const names = (
      await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'capture_pairing_%'").all<{
        name: string;
      }>()
    ).results.map((r) => r.name);
    expect(names).toContain("capture_pairing_codes_expires_idx");
    expect(names).toContain("capture_pairing_limits_window_idx");
  });
});

describe("addressLimitSubject", () => {
  it("keys an IPv6 address by its /64, expanded and in lower case", () => {
    expect(addressLimitSubject("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002");
    expect(addressLimitSubject("2001:DB8:1:2::1")).toBe("2001:0db8:0001:0002");
    expect(addressLimitSubject("2001:db8::1")).toBe("2001:0db8:0000:0000");
    expect(addressLimitSubject("::1")).toBe("0000:0000:0000:0000");
    expect(addressLimitSubject("::")).toBe("0000:0000:0000:0000");
    expect(addressLimitSubject("fe80::")).toBe("fe80:0000:0000:0000");
    expect(addressLimitSubject("64:ff9b::192.0.2.1")).toBe("0064:ff9b:0000:0000");
  });

  it("keys an IPv4 address, mapped or not, whole", () => {
    expect(addressLimitSubject("192.0.2.1")).toBe("192.0.2.1");
    expect(addressLimitSubject("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(addressLimitSubject("::FFFF:c000:0201")).toBe("192.0.2.1");
  });

  it("sends anything else to the shared unknown key", () => {
    for (const bad of [null, "", "unknown", "256.0.0.1", "1.2.3", "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::", "g::1", "fe80::1%eth0", "1:2:3:4:5:6:7", "1.2.3.4::", "1:1.2.3.4::", "1.2.3.4::1"]) {
      expect(addressLimitSubject(bad), String(bad)).toBe("unknown");
    }
  });

  it("two addresses in one /64 share a count; two /64s do not", async () => {
    for (let i = 0; i < 20; i++) {
      const ip = i % 2 ? "2001:db8:0:1::a" : "2001:db8:0:1:ffff:1:2:3";
      expect((await handlePairingCodes(deps(), post(GOOD, { ip }))).status).toBe(201);
    }
    expect((await handlePairingCodes(deps(), post(GOOD, { ip: "2001:db8:0:1::b" }))).status).toBe(429);
    expect((await handlePairingCodes(deps(), post(GOOD, { ip: "2001:db8:0:2::a" }))).status).toBe(201);
    const keys = (await env.DB.prepare("SELECT key FROM capture_pairing_limits ORDER BY key").all<{ key: string }>())
      .results.map((r) => r.key)
      .sort();
    expect(keys).toEqual(
      [
        `codes-ip:${await sha256Hex("2001:0db8:0000:0001")}`,
        `codes-ip:${await sha256Hex("2001:0db8:0000:0002")}`,
      ].sort(),
    );
  });
});

describe("unexpected errors", () => {
  function failing(method: "insert" | "select" | "batch"): PairingDeps["db"] {
    const real = drizzle(env.DB);
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === method) {
          return () => {
            throw new Error("D1_ERROR: test failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it("answers 503 busy, JSON, with Retry-After 5 when a dependency fails", async () => {
    for (const method of ["insert", "select", "batch"] as const) {
      const res = await handlePairingCodes(deps({ db: failing(method) }), post(GOOD));
      expect(res.status, method).toBe(503);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(await res.json()).toEqual({ rule: "busy" });
    }
  });

  it("logs a fixed location tag and the error's name, never its message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handlePairingCodes(deps({ db: failing("insert") }), post(GOOD));
      expect(logged).toHaveBeenCalledTimes(1);
      const line = String(logged.mock.calls[0][0]);
      expect(line).toContain("pairing codes: unexpected error");
      expect(line).toContain("Error");
      expect(line).not.toContain("test failure");
      expect(logged.mock.calls[0]).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the codes route", () => {
  const context = (origin: string) =>
    ({
      cloudflare: { env: { ...env, CAPTURE_PAIRING_ORIGIN: origin }, ctx: { waitUntil: () => {} } },
    }) as any;

  it("answers GET with 405 on the main address", async () => {
    const res = (await codesLoader({
      request: new Request(URL_CODES),
      context: context(ORIGIN),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(405);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ rule: "method" });
  });

  it("answers GET with a bare 404 on a workspace's host", async () => {
    const res = (await codesLoader({
      request: new Request("https://ahr.fisqua.org/api/capture/v1/pairing/codes"),
      context: context(ORIGIN),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

// @version v0.9.0
