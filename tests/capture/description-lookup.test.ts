/**
 * Tests — the reference-code lookup of contract 1.8
 *
 * This suite drives `GET /api/capture/v1/descriptions/:referenceCode`
 * through its route module and its handler (`description-link.server.ts`)
 * against the test D1 database. It pins:
 *
 *   - 200 with the reference code, title, level and dates for a
 *     description of the workspace, published or not, the dates mapped
 *     as the digitisation-list export maps them;
 *   - the code read from the URL and decoded exactly once, so `%252F`
 *     is the code `%2F`, never `/`; a space or an accent round-trips;
 *     a malformed encoding is an unknown code; a trailing slash is
 *     ignored, an encoded one kept;
 *   - 404 with `{ rule: "unknown-reference-code" }` for a code the
 *     workspace does not hold, including one only another workspace
 *     holds, and the workspace's own description when both hold the code;
 *   - authentication as the link's other calls: no token and an unknown
 *     token 401, a revoked token and another tenant's token 403, an
 *     unknown host a bare 404;
 *   - without the digitization capability, the same bare 404 as the
 *     queue's calls;
 *   - 405 to another method, and the link's shared rate limit.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, seedFederations, DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { createTestDescription } from "../helpers/descriptions";
import { createTestRepository } from "../helpers/repositories";
import { insertRow } from "../helpers/media-pipeline";
import { RATE_LIMIT_PER_MINUTE, type CaptureLinkDeps } from "../../app/lib/capture/link.server";
import { handleDescriptionLookup } from "../../app/lib/capture/description-link.server";
import { handleQueueGet } from "../../app/lib/capture/queue-link.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { loader, action } from "../../app/routes/api.capture.v1.descriptions.$referenceCode";

const HOST = "https://neogranadina.fisqua.test";
const OTHER_HOST = "https://second-tenant.fisqua.test";
const T0 = 1_800_000_000_000;

type Json = Record<string, any>;

let deps: CaptureLinkDeps;
let token: string;
let scannerId: string;

async function answer(res: Response): Promise<{ status: number; json: Json | null; headers: Headers }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

function request(method: string, code: string, opts: { token?: string | null; host?: string } = {}) {
  const t = opts.token === undefined ? token : opts.token;
  const headers: Record<string, string> = {};
  if (t !== null) headers.Authorization = `Bearer ${t}`;
  return new Request(`${opts.host ?? HOST}/api/capture/v1/descriptions/${encodeURIComponent(code)}`, { method, headers });
}

/** Through the route module, as the router calls it. */
async function lookup(code: string, opts: { token?: string | null; host?: string; method?: string } = {}) {
  const method = opts.method ?? "GET";
  // The router's parameter, decoded once more than the URL: the route
  // must read the URL, never this.
  const twice = (() => {
    try {
      return decodeURIComponent(code);
    } catch {
      return code;
    }
  })();
  const args = { request: request(method, code, opts), context: { cloudflare: { env } }, params: { referenceCode: twice } } as any;
  return answer(await (method === "GET" ? loader(args) : action(args)));
}

async function seedScanner(tenantId: string, name: string) {
  const minted = await mintScannerToken();
  const id = crypto.randomUUID();
  await insertRow("capture_scanners", {
    id,
    tenant_id: tenantId,
    name,
    token_sha256: minted.sha256,
    token_created_at: T0,
    created_at: T0,
    updated_at: T0,
  });
  return { id, token: minted.token };
}

async function desc(code: string, opts: { tenantId?: string; isPublished?: boolean; level?: string; title?: string } = {}) {
  const tenantId = opts.tenantId ?? DEFAULT_TEST_TENANT_ID;
  const repo = await createTestRepository({ tenantId, code: `repo-${crypto.randomUUID().slice(0, 6)}` });
  const d = await createTestDescription({
    tenantId,
    repositoryId: repo.id,
    descriptionLevel: opts.level ?? "volume",
    referenceCode: code,
    title: opts.title ?? `Title ${code}`,
    dateExpression: "1650-1655",
    isPublished: opts.isPublished ?? true,
  });
  await env.DB.prepare("UPDATE descriptions SET date_start = ?, date_end = ? WHERE id = ?").bind("1650-01-01", "1655-12-31", d.id).run();
  return d.id as string;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedFederations();
  const scanner = await seedScanner(DEFAULT_TEST_TENANT_ID, "rig-1");
  token = scanner.token;
  scannerId = scanner.id;
  deps = {
    db: drizzle(env.DB),
    env: {},
    fetch: (input, init) => fetch(input, init),
    now: () => T0,
    newId: () => crypto.randomUUID(),
  };
  await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
});

describe("GET /api/capture/v1/descriptions/:referenceCode", () => {
  it("answers a published description with its code, title, level and dates", async () => {
    await desc("co-test-001", { level: "volume", title: "Test volume one" });
    const res = await lookup("co-test-001");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({
      referenceCode: "co-test-001",
      title: "Test volume one",
      level: "volume",
      dates: { display: "1650-1655", start: "1650-01-01", end: "1655-12-31" },
    });
  });

  it("answers an unpublished description the same way", async () => {
    await desc("co-test-002", { isPublished: false, level: "file" });
    const res = await lookup("co-test-002");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ referenceCode: "co-test-002", title: "Title co-test-002", level: "file" });
  });

  it("gives null dates when the description has none", async () => {
    const id = await desc("co-test-003");
    await env.DB.prepare("UPDATE descriptions SET date_expression = NULL, date_start = NULL, date_end = NULL WHERE id = ?").bind(id).run();
    expect((await lookup("co-test-003")).json!.dates).toEqual({ display: null, start: null, end: null });
  });

  it("answers 404 with the rule for a code the workspace does not hold", async () => {
    const res = await lookup("co-test-999");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.json).toEqual({ rule: "unknown-reference-code" });
  });

  it("never answers another workspace's description", async () => {
    await desc("co-other-001", { tenantId: SECOND_TEST_TENANT_ID, title: "Another workspace's volume" });
    const res = await lookup("co-other-001");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ rule: "unknown-reference-code" });

    // A code both workspaces hold answers with this workspace's description.
    await desc("co-shared-001", { tenantId: SECOND_TEST_TENANT_ID, title: "Theirs" });
    await desc("co-shared-001", { title: "Ours" });
    expect((await lookup("co-shared-001")).json!.title).toBe("Ours");
  });

  it("matches the code exactly", async () => {
    await desc("co-test-001");
    expect((await lookup("CO-TEST-001")).json).toEqual({ rule: "unknown-reference-code" });
    expect((await lookup("co-test-00")).json).toEqual({ rule: "unknown-reference-code" });
    expect((await lookup("co-test-%")).json).toEqual({ rule: "unknown-reference-code" });
  });

  it("decodes the code from the URL exactly once", async () => {
    await desc("A%2FB", { title: "Literal percent" });
    await desc("A/B", { title: "Slash" });
    // "A%2FB" goes out as "A%252FB"; it must arrive as "A%2FB", never "A/B".
    expect((await lookup("A%2FB")).json!.title).toBe("Literal percent");
    const raw = await answer(
      await handleDescriptionLookup(deps, new Request(`${HOST}/api/capture/v1/descriptions/A%252FB`, { headers: { Authorization: `Bearer ${token}` } })),
    );
    expect(raw.json!.referenceCode).toBe("A%2FB");
  });

  it("ignores a trailing slash, but keeps an encoded one as part of the code", async () => {
    await desc("co-test-001");
    await desc("co-test-002/", { title: "Ends in a slash" });
    const get = async (path: string) =>
      answer(await handleDescriptionLookup(deps, new Request(`${HOST}/api/capture/v1/descriptions/${path}`, { headers: { Authorization: `Bearer ${token}` } })));
    const slashed = await get("co-test-001/");
    expect(slashed.status).toBe(200);
    expect(slashed.json!.referenceCode).toBe("co-test-001");
    expect((await get("co-test-002%2F")).json!.title).toBe("Ends in a slash");
  });

  it("round-trips a code with a space or an accent", async () => {
    await desc("co bogotá 01", { title: "Spaced and accented" });
    const res = await lookup("co bogotá 01");
    expect(res.status).toBe(200);
    expect(res.json!.referenceCode).toBe("co bogotá 01");
  });

  it("answers 404 with the rule to a malformed encoding", async () => {
    const res = await answer(
      await handleDescriptionLookup(deps, new Request(`${HOST}/api/capture/v1/descriptions/co%E0%A4%A`, { headers: { Authorization: `Bearer ${token}` } })),
    );
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ rule: "unknown-reference-code" });
  });

  it("answers 401 without a token and to an unknown token", async () => {
    await desc("co-test-001");
    const none = await lookup("co-test-001", { token: null });
    expect(none.status).toBe(401);
    expect(none.json).toBeNull();
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
    const unknown = await mintScannerToken();
    expect((await lookup("co-test-001", { token: unknown.token })).status).toBe(401);
    expect((await lookup("co-test-001", { token: "not-a-scanner-token" })).status).toBe(401);
  });

  it("answers 403 to a revoked token and to another tenant's token, and a bare 404 to an unknown host", async () => {
    await desc("co-test-001");
    const other = await seedScanner(SECOND_TEST_TENANT_ID, "rig-2");
    expect((await lookup("co-test-001", { token: other.token })).status).toBe(403);
    expect((await lookup("co-test-001", { host: OTHER_HOST })).status).toBe(403);
    const unknownHost = await lookup("co-test-001", { host: "https://nobody.fisqua.test" });
    expect(unknownHost.status).toBe(404);
    expect(unknownHost.json).toBeNull();
    await env.DB.prepare("UPDATE capture_scanners SET revoked_at = ? WHERE id = ?").bind(T0, scannerId).run();
    expect((await lookup("co-test-001")).status).toBe(403);
  });

  it("answers a bare 404, as the queue's calls do, when the workspace has no digitization capability", async () => {
    await desc("co-test-001");
    await env.DB.prepare("UPDATE tenants SET digitization_enabled = 0 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
    const res = await lookup("co-test-001");
    expect(res.status).toBe(404);
    expect(res.json).toBeNull();
    const queue = await answer(await handleQueueGet(deps, new Request(`${HOST}/api/capture/v1/queue`, { headers: { Authorization: `Bearer ${token}` } })));
    expect(queue.status).toBe(res.status);
    expect(queue.json).toBe(res.json);
  });

  it("answers 405 to another method", async () => {
    await desc("co-test-001");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await lookup("co-test-001", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    }
    expect((await answer(await handleDescriptionLookup(deps, request("POST", "co-test-001")))).status).toBe(405);
  });

  it("shares the link's rate limit", async () => {
    await desc("co-test-001");
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      expect((await answer(await handleDescriptionLookup(deps, request("GET", "co-test-001")))).status).toBe(200);
    }
    const over = await answer(await handleQueueGet(deps, new Request(`${HOST}/api/capture/v1/queue`, { headers: { Authorization: `Bearer ${token}` } })));
    expect(over.status).toBe(429);
    const lookupOver = await answer(await handleDescriptionLookup(deps, request("GET", "co-test-001")));
    expect(lookupOver.status).toBe(429);
    expect(lookupOver.headers.get("Retry-After")).not.toBeNull();
  });
});

// @version v0.9.0
