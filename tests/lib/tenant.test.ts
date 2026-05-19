/**
 * Tests — tenant
 *
 * This suite is the unit-coverage net for the tenant helpers in `app/lib/tenant.ts`. Six
 * pure functions plus one async resolver are exercised here:
 *
 *   - `SlugSchema` -- Zod refinement that rejects the five reserved
 *     slugs (`platform`, `www`, `api`, `admin`, `app`) at tenant
 *     creation time, plus shape rules (lowercase, no leading digit,
 *     no trailing hyphen, length 1..63).
 *   - `getTenantFromRequest` -- maps the request `Host` header to a
 *     seeded tenant row via a legacy-host map and a subdomain
 *     suffix list, throws a bare 404 `Response` on unknown hosts.
 *   - `hasCapability` / `requireCapability` -- read the four
 *     capability flags on a `Tenant`; the `require` form 404s when
 *     the flag is off so route loaders can fail-loud server-side.
 *   - `isOperator` / `assertOperator` -- property-based check on
 *     `tenant.kind === "platform"` plus a 403-throwing variant.
 *   - `requireTenantUser` -- asserts `user.tenantId === tenant.id`
 *     and 403s otherwise; operator routes opt in to a carve-out
 *     where required.
 *
 * Tests that hit D1 (only `getTenantFromRequest`) use
 * `applyMigrations()` + `cleanDatabase()` (which also re-seeds the
 * three tenant rows). Pure-function tests skip the D1 setup.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import {
  SlugSchema,
  getTenantFromRequest,
  hasCapability,
  requireCapability,
  isOperator,
  assertOperator,
  requireTenantUser,
  assertNonPlatformOrAllowlisted,
  buildTenantOriginUrl,
  findTenantById,
  OPERATOR_ROUTE_PREFIXES,
  PLATFORM_TENANT_ID,
  NEOGRANADINA_TENANT_ID,
} from "../../app/lib/tenant";

describe("SlugSchema", () => {
  describe("rejects reserved slugs", () => {
    for (const slug of ["platform", "www", "api", "admin", "app"]) {
      it(`rejects '${slug}'`, () => {
        const result = SlugSchema.safeParse(slug);
        expect(result.success).toBe(false);
        if (!result.success) {
          const messages = result.error.issues.map((i) => i.message);
          expect(messages).toContain("Slug is reserved");
        }
      });
    }
  });

  describe("accepts valid slugs", () => {
    for (const slug of ["neogranadina", "harvard-archives", "bn-peru"]) {
      it(`accepts '${slug}'`, () => {
        const result = SlugSchema.safeParse(slug);
        expect(result.success).toBe(true);
      });
    }
  });

  describe("rejects shape violations", () => {
    it("rejects uppercase letters", () => {
      expect(SlugSchema.safeParse("Neogranadina").success).toBe(false);
    });
    it("rejects leading digit", () => {
      expect(SlugSchema.safeParse("1neogranadina").success).toBe(false);
    });
    it("rejects trailing hyphen", () => {
      expect(SlugSchema.safeParse("neogranadina-").success).toBe(false);
    });
    it("rejects empty string", () => {
      expect(SlugSchema.safeParse("").success).toBe(false);
    });
    it("rejects > 63 characters", () => {
      expect(SlugSchema.safeParse("a".repeat(64)).success).toBe(false);
    });
  });
});

describe("getTenantFromRequest", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("resolves legacy host catalogacion.zasqua.org to neogranadina", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://catalogacion.zasqua.org/anywhere");
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe("neogranadina");
    expect(tenant.id).toBe(NEOGRANADINA_TENANT_ID);
  });

  it("resolves legacy host case-insensitively", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://CATALOGACION.ZASQUA.ORG/anywhere");
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe("neogranadina");
  });

  it("resolves subdomain on .localhost", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://neogranadina.localhost/anywhere");
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe("neogranadina");
  });

  it("resolves subdomain on .fisqua.test", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://second-tenant.fisqua.test/anywhere");
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe("second-tenant");
    expect(tenant.id).toBe(SECOND_TEST_TENANT_ID);
  });

  it("resolves subdomain on .fisqua.org", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://neogranadina.fisqua.org/anywhere");
    const tenant = await getTenantFromRequest(db, request);
    expect(tenant.slug).toBe("neogranadina");
  });

  it("404s on unknown host", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://random.example.com/anywhere");
    try {
      await getTenantFromRequest(db, request);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("rejects multi-level subdomain (evil.neogranadina.fisqua.org)", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://evil.neogranadina.fisqua.org/anywhere");
    try {
      await getTenantFromRequest(db, request);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("404s on unknown subdomain (slug not in tenants)", async () => {
    const db = drizzle(env.DB);
    const request = new Request("https://no-such-tenant.fisqua.test/anywhere");
    try {
      await getTenantFromRequest(db, request);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});

describe("hasCapability", () => {
  it("returns crowdsourcingEnabled flag", () => {
    const tOn = makeTenantContext({ crowdsourcingEnabled: true });
    const tOff = makeTenantContext({ crowdsourcingEnabled: false });
    expect(hasCapability(tOn, "crowdsourcing")).toBe(true);
    expect(hasCapability(tOff, "crowdsourcing")).toBe(false);
  });

  it("returns vocabularyHubEnabled flag", () => {
    const tOn = makeTenantContext({ vocabularyHubEnabled: true });
    const tOff = makeTenantContext({ vocabularyHubEnabled: false });
    expect(hasCapability(tOn, "vocabulary_hub")).toBe(true);
    expect(hasCapability(tOff, "vocabulary_hub")).toBe(false);
  });

  it("returns publishPipelineEnabled flag", () => {
    const tOn = makeTenantContext({ publishPipelineEnabled: true });
    const tOff = makeTenantContext({ publishPipelineEnabled: false });
    expect(hasCapability(tOn, "publish_pipeline")).toBe(true);
    expect(hasCapability(tOff, "publish_pipeline")).toBe(false);
  });

  it("returns multiRepositoryEnabled flag", () => {
    const tOn = makeTenantContext({ multiRepositoryEnabled: true });
    const tOff = makeTenantContext({ multiRepositoryEnabled: false });
    expect(hasCapability(tOn, "multi_repository")).toBe(true);
    expect(hasCapability(tOff, "multi_repository")).toBe(false);
  });
});

describe("requireCapability", () => {
  it("returns void when capability is on", () => {
    const tenant = makeTenantContext({ crowdsourcingEnabled: true });
    expect(() => requireCapability(tenant, "crowdsourcing")).not.toThrow();
  });

  it("throws 404 when capability is off", () => {
    const tenant = makeTenantContext({ crowdsourcingEnabled: false });
    try {
      requireCapability(tenant, "crowdsourcing");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});

describe("isOperator", () => {
  it("returns true for kind=platform", () => {
    const tenant = makeTenantContext({ kind: "platform" });
    expect(isOperator(tenant)).toBe(true);
  });

  it("returns false for kind=tenant", () => {
    const tenant = makeTenantContext({ kind: "tenant" });
    expect(isOperator(tenant)).toBe(false);
  });
});

describe("assertOperator", () => {
  it("returns void for kind=platform", () => {
    const tenant = makeTenantContext({ kind: "platform" });
    expect(() => assertOperator(tenant)).not.toThrow();
  });

  it("throws 403 for kind=tenant", () => {
    const tenant = makeTenantContext({ kind: "tenant" });
    try {
      assertOperator(tenant);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

describe("requireTenantUser", () => {
  it("passes when user.tenantId === tenant.id", () => {
    const tenant = makeTenantContext({ id: NEOGRANADINA_TENANT_ID });
    const user = makeUserContext({ tenantId: NEOGRANADINA_TENANT_ID });
    expect(() => requireTenantUser(tenant, user)).not.toThrow();
  });

  it("throws 403 on cross-tenant", () => {
    const tenant = makeTenantContext({ id: SECOND_TEST_TENANT_ID });
    const user = makeUserContext({ tenantId: NEOGRANADINA_TENANT_ID });
    try {
      requireTenantUser(tenant, user);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("throws 403 for operator user hitting tenant subdomain (carve-out shape-only)", () => {
    // The operator carve-out is opt-in per call; without
    // `allowImpersonation`, requireTenantUser is the default-deny
    // gate — even an operator session is rejected at a tenant
    // subdomain.
    const tenant = makeTenantContext({
      id: NEOGRANADINA_TENANT_ID,
      kind: "tenant",
    });
    const user = makeUserContext({ tenantId: PLATFORM_TENANT_ID });
    try {
      requireTenantUser(tenant, user);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  // Opt-in operator carve-out.
  it("returns void for operator user on tenant when allowImpersonation:true", () => {
    const tenant = makeTenantContext({
      id: NEOGRANADINA_TENANT_ID,
      kind: "tenant",
    });
    const user = makeUserContext({ tenantId: PLATFORM_TENANT_ID });
    expect(() =>
      requireTenantUser(tenant, user, { allowImpersonation: true }),
    ).not.toThrow();
  });

  it("default-deny preserved when no options passed (regression)", () => {
    // Same shape as the carve-out test above but without options:
    // confirms every existing call site (which passes no options) still
    // 403s on tenant mismatch.
    const tenant = makeTenantContext({
      id: NEOGRANADINA_TENANT_ID,
      kind: "tenant",
    });
    const user = makeUserContext({ tenantId: PLATFORM_TENANT_ID });
    try {
      requireTenantUser(tenant, user);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("does NOT carve out when allowImpersonation:true but user is a tenant user", () => {
    // Only the platform-tenant operator can ride the carve-out;
    // a regular tenant user mismatching tenants cannot.
    const tenant = makeTenantContext({
      id: NEOGRANADINA_TENANT_ID,
      kind: "tenant",
    });
    const user = makeUserContext({ tenantId: "some-other-tenant-id" });
    try {
      requireTenantUser(tenant, user, { allowImpersonation: true });
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

// Prefix-matcher extension to the legacy OPERATOR_ROUTE_ALLOWLIST.
// The legacy literal allowlist stays at `[]` so back-compat callers
// don't break; the OPERATOR_ROUTE_PREFIXES list carries the actual
// operator-host allowlisted prefixes.
describe("OPERATOR_ROUTE_PREFIXES + assertNonPlatformOrAllowlisted", () => {
  it("OPERATOR_ROUTE_PREFIXES contains exactly the four documented prefixes", () => {
    expect([...OPERATOR_ROUTE_PREFIXES]).toEqual([
      "/login",
      "/operator",
      "/end-impersonation",
      "/handoff/impersonation",
    ]);
  });

  it("allows /login on platform host", () => {
    const tenant = makeTenantContext({ kind: "platform" });
    expect(() => assertNonPlatformOrAllowlisted(tenant, "/login")).not.toThrow();
  });

  it("allows nested /operator/tenants/new on platform host (prefix match)", () => {
    const tenant = makeTenantContext({ kind: "platform" });
    expect(() =>
      assertNonPlatformOrAllowlisted(tenant, "/operator/tenants/new"),
    ).not.toThrow();
  });

  it("allows /operator/tenants/anything-deeper on platform host", () => {
    const tenant = makeTenantContext({ kind: "platform" });
    expect(() =>
      assertNonPlatformOrAllowlisted(tenant, "/operator/tenants/anything-deeper"),
    ).not.toThrow();
  });

  it("rejects /unknown on platform host with 404", () => {
    const tenant = makeTenantContext({ kind: "platform" });
    try {
      assertNonPlatformOrAllowlisted(tenant, "/unknown");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("does not throw for kind=tenant regardless of pathname", () => {
    const tenant = makeTenantContext({ kind: "tenant" });
    expect(() =>
      assertNonPlatformOrAllowlisted(tenant, "/random-path"),
    ).not.toThrow();
  });
});

describe("findTenantById", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns the matching row by id", async () => {
    const db = drizzle(env.DB);
    const row = await findTenantById(db, NEOGRANADINA_TENANT_ID);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(NEOGRANADINA_TENANT_ID);
    expect(row?.slug).toBe("neogranadina");
  });

  it("returns null when no row matches", async () => {
    const db = drizzle(env.DB);
    const row = await findTenantById(db, "00000000-0000-4000-8000-000000000000");
    expect(row).toBeNull();
  });

  it("does not throw on unknown id", async () => {
    const db = drizzle(env.DB);
    await expect(
      findTenantById(db, "00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeNull();
  });
});

describe("buildTenantOriginUrl", () => {
  it("builds a .fisqua.org origin from a .fisqua.org request", () => {
    const req = new URL("https://ampl.fisqua.org/wrong-workspace?home=neogranadina");
    expect(buildTenantOriginUrl(req, "neogranadina")).toBe(
      "https://neogranadina.fisqua.org",
    );
  });

  it("builds a .fisqua.test origin from a .fisqua.test request", () => {
    const req = new URL("https://ampl.fisqua.test/path");
    expect(buildTenantOriginUrl(req, "neogranadina")).toBe(
      "https://neogranadina.fisqua.test",
    );
  });

  it("preserves port for dev (.localhost:5173)", () => {
    const req = new URL("http://ampl.localhost:5173/path");
    expect(buildTenantOriginUrl(req, "neogranadina")).toBe(
      "http://neogranadina.localhost:5173",
    );
  });

  it("returns null on legacy host (catalogacion.zasqua.org)", () => {
    const req = new URL("https://catalogacion.zasqua.org/path");
    expect(buildTenantOriginUrl(req, "neogranadina")).toBeNull();
  });

  it("returns null on raw apex (fisqua.org)", () => {
    const req = new URL("https://fisqua.org/path");
    expect(buildTenantOriginUrl(req, "neogranadina")).toBeNull();
  });

  it("returns null on unrelated host", () => {
    const req = new URL("https://example.com/path");
    expect(buildTenantOriginUrl(req, "neogranadina")).toBeNull();
  });

  it("preserves http protocol", () => {
    const req = new URL("http://ampl.localhost:5173/path");
    expect(buildTenantOriginUrl(req, "neogranadina")?.startsWith("http://")).toBe(true);
  });
});
