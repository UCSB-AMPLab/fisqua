/**
 * Tests — the description search of contract 1.10
 *
 * This suite drives `GET /api/capture/v1/descriptions?q=<text>` through
 * its route module and its handler (`description-link.server.ts`)
 * against the test D1 database. It pins:
 *
 *   - matching on words of the reference code and the title through the
 *     description full-text index, each word of `q` a prefix: a title
 *     word, a code token, a hyphenated code prefix, case and accents
 *     folded, never a word only the scope and content holds;
 *   - every description of the workspace, at any level, published or
 *     not, and never another workspace's;
 *   - `{ results }` with at most 20 entries, each the 1.8 answer's shape,
 *     ordered by rank and then by reference code;
 *   - 400 with `{ rule: "query-too-short" }` to a `q` that is missing or
 *     under three characters once trimmed;
 *   - FTS5 syntax in `q` read as text: no error and no wider answer;
 *   - the expression built only from letter and digit tokens: at most
 *     eight, each cut at 64 characters, from a `q` cut at 256, so a NUL
 *     or a word of thousands of tokens is answered, never an error;
 *   - a bare 503 when the search statement fails;
 *   - authentication, the capability gate, 405 and the link's shared
 *     rate limit as for the 1.8 lookup, which still answers as before.
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
import { handleDescriptionLookup, handleDescriptionSearch, searchExpression } from "../../app/lib/capture/description-link.server";
import { mintScannerToken } from "../../app/lib/capture/token";
import { loader, action } from "../../app/routes/api.capture.v1.descriptions";

const HOST = "https://neogranadina.fisqua.test";
const OTHER_HOST = "https://second-tenant.fisqua.test";
const T0 = 1_800_000_000_000;

type Json = Record<string, any>;

let deps: CaptureLinkDeps;
let token: string;
let scannerId: string;
let repositoryId: string;

async function answer(res: Response): Promise<{ status: number; json: Json | null; headers: Headers }> {
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

function request(method: string, q: string | null, opts: { token?: string | null; host?: string } = {}) {
  const t = opts.token === undefined ? token : opts.token;
  const headers: Record<string, string> = {};
  if (t !== null) headers.Authorization = `Bearer ${t}`;
  const query = q === null ? "" : `?q=${encodeURIComponent(q)}`;
  return new Request(`${opts.host ?? HOST}/api/capture/v1/descriptions${query}`, { method, headers });
}

/** Through the route module, as the router calls it. */
async function search(q: string | null, opts: { token?: string | null; host?: string; method?: string } = {}) {
  const method = opts.method ?? "GET";
  const args = { request: request(method, q, opts), context: { cloudflare: { env } }, params: {} } as any;
  return answer(await (method === "GET" ? loader(args) : action(args)));
}

/** The reference codes of a 200 answer, in order. */
async function codes(q: string): Promise<string[]> {
  const res = await search(q);
  expect(res.status).toBe(200);
  return res.json!.results.map((r: Json) => r.referenceCode);
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

async function desc(
  code: string,
  opts: { tenantId?: string; isPublished?: boolean; level?: string; title?: string; scopeContent?: string } = {},
) {
  const tenantId = opts.tenantId ?? DEFAULT_TEST_TENANT_ID;
  const repoId =
    tenantId === DEFAULT_TEST_TENANT_ID
      ? repositoryId
      : (await createTestRepository({ tenantId, code: `repo-${crypto.randomUUID().slice(0, 6)}` })).id;
  const d = await createTestDescription({
    tenantId,
    repositoryId: repoId,
    descriptionLevel: opts.level ?? "volume",
    referenceCode: code,
    title: opts.title ?? `Title ${code}`,
    dateExpression: "1650-1655",
    scopeContent: opts.scopeContent ?? null,
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
  repositoryId = (await createTestRepository({ tenantId: DEFAULT_TEST_TENANT_ID, code: "repo-main" })).id;
  deps = {
    db: drizzle(env.DB),
    env: {},
    fetch: (input, init) => fetch(input, init),
    now: () => T0,
    newId: () => crypto.randomUUID(),
  };
  await env.DB.prepare("UPDATE tenants SET digitization_enabled = 1 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
});

describe("GET /api/capture/v1/descriptions?q=", () => {
  it("answers each match in the shape of the 1.8 lookup", async () => {
    await desc("co-ahr-con-caj002", { level: "volume", title: "Cabildo de Tunja" });
    const res = await search("cabildo");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({
      results: [
        {
          referenceCode: "co-ahr-con-caj002",
          title: "Cabildo de Tunja",
          level: "volume",
          dates: { display: "1650-1655", start: "1650-01-01", end: "1655-12-31" },
        },
      ],
    });
    const lookup = await answer(
      await handleDescriptionLookup(deps, new Request(`${HOST}/api/capture/v1/descriptions/co-ahr-con-caj002`, { headers: { Authorization: `Bearer ${token}` } })),
    );
    expect(res.json!.results[0]).toEqual(lookup.json);
  });

  it("matches a title word as a prefix, folding case and accents", async () => {
    await desc("co-test-001", { title: "Cabildo de Bogotá" });
    await desc("co-test-002", { title: "Escribanía de Cartagena" });
    expect(await codes("cabil")).toEqual(["co-test-001"]);
    expect(await codes("BOGOTA")).toEqual(["co-test-001"]);
    expect(await codes("escribania cart")).toEqual(["co-test-002"]);
    // Every word must match.
    expect(await codes("cabildo cartagena")).toEqual([]);
  });

  it("matches a token of the reference code and a hyphenated code prefix", async () => {
    await desc("co-ahr-con-caj002", { title: "Volume one" });
    await desc("co-ahr-gob-caj001", { title: "Volume two" });
    expect(await codes("caj002")).toEqual(["co-ahr-con-caj002"]);
    expect(await codes("caj00")).toEqual(["co-ahr-con-caj002", "co-ahr-gob-caj001"]);
    expect(await codes("co-ahr-con")).toEqual(["co-ahr-con-caj002"]);
    expect(await codes("co-ahr-co")).toEqual(["co-ahr-con-caj002"]);
    expect(await codes("ahr-gob")).toEqual(["co-ahr-gob-caj001"]);
    expect(await codes("co-ahr-con-caj002")).toEqual(["co-ahr-con-caj002"]);
  });

  it("never matches a word only the scope and content holds", async () => {
    await desc("co-test-001", { title: "Volume one", scopeContent: "Testamento de Juana" });
    expect(await codes("testamento")).toEqual([]);
  });

  it("includes every level, published or not", async () => {
    await desc("co-fondo-001", { level: "fonds", title: "Archivo zeta" });
    await desc("co-fondo-002", { level: "file", title: "Archivo zeta", isPublished: false });
    expect(await codes("zeta")).toEqual(["co-fondo-001", "co-fondo-002"]);
  });

  it("never answers another workspace's descriptions", async () => {
    await desc("co-other-001", { tenantId: SECOND_TEST_TENANT_ID, title: "Cabildo ajeno" });
    await desc("co-ours-001", { title: "Cabildo propio" });
    expect(await codes("cabildo")).toEqual(["co-ours-001"]);
    expect(await codes("ajeno")).toEqual([]);
    expect(await codes("co-other")).toEqual([]);
  });

  it("answers an empty list when nothing matches", async () => {
    await desc("co-test-001");
    expect((await search("zzzz")).json).toEqual({ results: [] });
  });

  it("answers at most 20", async () => {
    for (let i = 0; i < 25; i++) await desc(`co-many-${String(i).padStart(3, "0")}`, { title: "Libro de cuentas" });
    const found = await codes("cuentas");
    expect(found).toHaveLength(20);
    expect(found[0]).toBe("co-many-000");
    expect(found[19]).toBe("co-many-019");
  });

  it("orders by rank, then by reference code", async () => {
    await desc("co-rank-003", { title: "Libro de cuentas" });
    await desc("co-rank-001", { title: "Libro de cuentas" });
    await desc("co-rank-002", { title: "Libro de cuentas" });
    // A shorter document ranks better under bm25 for the same match.
    await desc("co-rank-009", { title: "Cuentas" });
    expect(await codes("cuentas")).toEqual(["co-rank-009", "co-rank-001", "co-rank-002", "co-rank-003"]);
    expect(await codes("cuentas")).toEqual(await codes("cuentas"));
  });

  it("answers 400 with the rule to a q that is missing, empty or under three characters once trimmed", async () => {
    await desc("co-test-001");
    for (const q of [null, "", "ab", "  ab  ", "   ", "\tab\n"]) {
      const res = await search(q);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.json).toEqual({ rule: "query-too-short" });
    }
    expect((await search(" abc ")).status).toBe(200);
  });

  it("reads FTS5 syntax in q as text: no error, no wider answer", async () => {
    await desc("co-inj-001", { title: "Cabildo de Tunja", scopeContent: "Secreto" });
    await desc("co-inj-002", { title: "Escribania mayor" });
    await desc("co-other-001", { tenantId: SECOND_TEST_TENANT_ID, title: "Cabildo ajeno" });
    const cases: Array<[string, string[]]> = [
      ['"cabildo', ["co-inj-001"]],
      ['cabildo"', ["co-inj-001"]],
      ['"""', []],
      ["***", []],
      ["cab*", ["co-inj-001"]],
      ["*cab", ["co-inj-001"]],
      ["NEAR(cabildo escribania)", []],
      ["NEAR(cabildo", []],
      ["title:cabildo", []],
      ["scope_content:secreto", []],
      ["{scope_content}: secreto", []],
      ["secreto", []],
      ["zzz OR cabildo", []],
      ["cabildo OR escribania", []],
      ["cabildo AND", []],
      ["NOT cabildo", []],
      ["cabildo NOT tunja", []],
      ["(cabildo)", ["co-inj-001"]],
      ["(cabildo) OR (escribania)", []],
      ["^cabildo", ["co-inj-001"]],
      ["-cabildo", ["co-inj-001"]],
      ["cabildo -tunja", ["co-inj-001"]],
      ["cabildo + tunja", ["co-inj-001"]],
      ["c'abildo", []],
    ];
    for (const [q, expected] of cases) {
      const res = await search(q);
      expect(res.status, q).toBe(200);
      expect(res.json!.results.map((r: Json) => r.referenceCode), q).toEqual(expected);
    }
  });

  it("matches on the first eight tokens only, after dropping words with none", async () => {
    await desc("co-cap-001", { title: "alfa bravo charlie delta echo foxtrot golf hotel" });
    // Words nine to twelve match nothing; past the cap they constrain nothing.
    expect(await codes("alfa bravo charlie delta echo foxtrot golf hotel india juliet kilo lima")).toEqual(["co-cap-001"]);
    // A word with no token is dropped before counting, so `***` does not use up a place.
    expect(await codes("*** alfa bravo charlie delta echo foxtrot golf hotel india")).toEqual(["co-cap-001"]);
    // Within the first eight, every word still counts.
    expect(await codes("alfa bravo charlie delta echo foxtrot golf india")).toEqual([]);
  });

  it("builds the expression only from letter and digit tokens, at most eight of them", () => {
    const unit = (tokens: string) => `{reference_code title}: "${tokens}"*`;
    // One whitespace word that is thousands of tokens still builds eight.
    expect(searchExpression("co-".repeat(10_000))).toBe(unit("co co co co co co co co"));
    // The cap is across words; a word cut mid-way keeps its first tokens.
    expect(searchExpression("alfa bravo-charlie echo foxtrot golf hotel india-juliet-kilo")).toBe(
      [unit("alfa"), unit("bravo charlie"), unit("echo"), unit("foxtrot"), unit("golf"), unit("hotel"), unit("india")].join(" AND "),
    );
    expect(searchExpression("alfa bravo charlie delta echo foxtrot golf hotel india")).not.toContain("india");
    // A NUL, or any other non-letter, non-digit, separates tokens.
    expect(searchExpression("cab\u0000ildo")).toBe(unit("cab ildo"));
    expect(searchExpression('a"b NEAR(c) ^f {g} h*i')).toBe(
      [unit("a b"), unit("NEAR c"), unit("f"), unit("g"), unit("h i")].join(" AND "),
    );
    // A token is cut at 64 characters.
    expect(searchExpression("a".repeat(70))).toBe(unit("a".repeat(64)));
    expect(searchExpression("d:e title:x")).toBe([unit("d e"), unit("title x")].join(" AND "));
    // The query is cut at 256 characters before it is tokenised.
    expect(searchExpression(`${"-".repeat(250)}abcdefghij`)).toBe(unit("abcdef"));
    expect(searchExpression("***")).toBeNull();
    expect(searchExpression('"""')).toBeNull();
  });

  it("composes a decomposed accent before tokenising", async () => {
    await desc("co-nfd-001", { title: "Peña" });
    const decomposed = "Peña";
    expect(searchExpression(decomposed)).toBe('{reference_code title}: "Peña"*');
    expect(await codes(decomposed)).toEqual(["co-nfd-001"]);
  });

  it("answers a NUL in q as a separator, never an error", async () => {
    await desc("co-nul-001", { title: "Cab ildo" });
    const res = await search("cab\u0000ildo");
    expect(res.status).toBe(200);
    expect(res.json!.results.map((r: Json) => r.referenceCode)).toEqual(["co-nul-001"]);
  });

  it("answers a q of one long hyphenated word, cut to eight tokens", async () => {
    await desc("co-co-co-co-co-co-co-co-001", { title: "Repeated" });
    expect(await codes("co-".repeat(10_000))).toEqual(["co-co-co-co-co-co-co-co-001"]);
  });

  it("cuts q at 256 characters and each token at 64", async () => {
    await desc("co-long-001", { title: `abcdefxyz ${"b".repeat(64)}qqq` });
    // Past the cut, "zzzz" would have failed the match.
    expect(await codes(`${"-".repeat(250)}abcdefzzzz`)).toEqual(["co-long-001"]);
    expect(await codes(`${"b".repeat(64)}zzzz`)).toEqual(["co-long-001"]);
  });

  it("answers a bare 503 when the search statement fails", async () => {
    await desc("co-test-001");
    const real = drizzle(env.DB);
    const failing = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "all") return async () => { throw new Error("D1_ERROR: fts5: simulated"); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const res = await answer(await handleDescriptionSearch({ ...deps, db: failing as any }, request("GET", "title")));
    expect(res.status).toBe(503);
    expect(res.json).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 401 without a token and to an unknown token", async () => {
    await desc("co-test-001");
    const none = await search("title", { token: null });
    expect(none.status).toBe(401);
    expect(none.json).toBeNull();
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
    const unknown = await mintScannerToken();
    expect((await search("title", { token: unknown.token })).status).toBe(401);
    expect((await search("title", { token: "not-a-scanner-token" })).status).toBe(401);
    // Authentication comes before the query rule.
    expect((await search("ab", { token: null })).status).toBe(401);
  });

  it("answers 403 to a revoked token and to another tenant's token, and a bare 404 to an unknown host", async () => {
    await desc("co-test-001");
    const other = await seedScanner(SECOND_TEST_TENANT_ID, "rig-2");
    expect((await search("title", { token: other.token })).status).toBe(403);
    expect((await search("title", { host: OTHER_HOST })).status).toBe(403);
    const unknownHost = await search("title", { host: "https://nobody.fisqua.test" });
    expect(unknownHost.status).toBe(404);
    expect(unknownHost.json).toBeNull();
    await env.DB.prepare("UPDATE capture_scanners SET revoked_at = ? WHERE id = ?").bind(T0, scannerId).run();
    expect((await search("title")).status).toBe(403);
  });

  it("answers a bare 404 when the workspace has no digitization capability", async () => {
    await desc("co-test-001");
    await env.DB.prepare("UPDATE tenants SET digitization_enabled = 0 WHERE id = ?").bind(DEFAULT_TEST_TENANT_ID).run();
    const res = await search("title");
    expect(res.status).toBe(404);
    expect(res.json).toBeNull();
  });

  it("answers 405 to another method", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await search("title", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    }
    expect((await answer(await handleDescriptionSearch(deps, request("POST", "title")))).status).toBe(405);
  });

  it("counts against the link's shared rate limit", async () => {
    await desc("co-test-001");
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      expect((await answer(await handleDescriptionSearch(deps, request("GET", "title")))).status).toBe(200);
    }
    const over = await answer(await handleDescriptionSearch(deps, request("GET", "title")));
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).not.toBeNull();
    const lookupOver = await answer(
      await handleDescriptionLookup(deps, new Request(`${HOST}/api/capture/v1/descriptions/co-test-001`, { headers: { Authorization: `Bearer ${token}` } })),
    );
    expect(lookupOver.status).toBe(429);
  });

  it("leaves the 1.8 lookup as it was", async () => {
    await desc("co-test-001", { title: "Test volume one" });
    const res = await answer(
      await handleDescriptionLookup(deps, new Request(`${HOST}/api/capture/v1/descriptions/co-test-001`, { headers: { Authorization: `Bearer ${token}` } })),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      referenceCode: "co-test-001",
      title: "Test volume one",
      level: "volume",
      dates: { display: "1650-1655", start: "1650-01-01", end: "1655-12-31" },
    });
  });
});

// @version v0.9.0
