/**
 * Tests — the stored scanner keys
 *
 * This suite drives the module that reads, opens and erases the B2 key
 * pairs Fisqua keeps sealed for a workspace's scanner, against the test
 * D1 database. It pins:
 *
 *   - `loadStoredKeys` gives null for a workspace with no row, and a view
 *     with `usable: false` for an erased row;
 *   - `openStoredKeys` gives null for no row and for an erased row, and
 *     opens a sealed row with the private key passed as
 *     `CAPTURE_KEYS_PRIVATE_JWK`, bound to the tenant and environment;
 *   - `openStoredKeys` throws one fixed message, with no part of the
 *     secret or the keys in it, when the secret is absent, is not JSON,
 *     or is the wrong key, and when the environment does not match;
 *   - `loadStoredKeys` reads the row without its sealed text;
 *   - `eraseStoredKeysStatement` erases a row at the revision it was
 *     given and changes nothing at a stale revision or on an erased row,
 *     nor when a further condition given to it does not hold; given no
 *     revision, it erases the usable row at whatever revision it has;
 *     either way it returns the erased row's appliance id;
 *   - `applianceKeyNames` gives the names the minting command gives;
 *   - `pairingEnvironment` reads `staging` as staging and any other
 *     value, or none, as production.
 *
 * The key material here is made up.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDatabase, seedTenants, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { captureScannerKeys } from "../../app/db/schema";
import { generatePairingKeyPair, sealKeys, type StoredKeyPairs } from "../../app/lib/capture/pairing-seal";
import {
  applianceKeyNames,
  eraseStoredKeysStatement,
  loadStoredKeys,
  openStoredKeys,
} from "../../app/lib/capture/scanner-keys.server";
import { pairingEnvironment } from "../../app/lib/capture/appliance-key-names";

const TENANT = DEFAULT_TEST_TENANT_ID;
const STORED_AT = 1_800_000_000_000;

const keys: StoredKeyPairs = {
  writeKey: { keyId: "0001-write-test", applicationKey: "K001writeMadeUpSecret" },
  readKey: { keyId: "0001-read-test", applicationKey: "K001readMadeUpSecret" },
};

async function storeRow(sealed: string | null, extra: Partial<typeof captureScannerKeys.$inferInsert> = {}) {
  await drizzle(env.DB)
    .insert(captureScannerKeys)
    .values({
      tenantId: TENANT,
      applianceId: "rig-1",
      bucket: "test-masters",
      sealed,
      ageRecipient: "age1madeuprecipient",
      revision: 3,
      storedAt: STORED_AT,
      ...extra,
    });
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
  await seedTenants();
});

describe("loadStoredKeys", () => {
  it("gives null for a workspace with no stored keys", async () => {
    expect(await loadStoredKeys(drizzle(env.DB), TENANT)).toBeNull();
  });

  it("gives a usable view of a sealed row, without the sealed text", async () => {
    await storeRow("sealed-text");
    const view = await loadStoredKeys(drizzle(env.DB), TENANT);
    expect(view).toEqual({
      applianceId: "rig-1",
      bucket: "test-masters",
      ageRecipient: "age1madeuprecipient",
      revision: 3,
      storedAt: STORED_AT,
      erasedAt: null,
      usable: true,
    });
  });

  it("reads the row without its sealed text", async () => {
    await storeRow("sealed-text");
    const queries: string[] = [];
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            queries.push(sql);
            return target.prepare(sql);
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const view = await loadStoredKeys(drizzle(d1), TENANT);
    expect(view).toMatchObject({ applianceId: "rig-1", usable: true });
    expect(queries).toHaveLength(1);
    expect(queries[0].replace(/"sealed" is not null/gi, "")).not.toMatch(/"sealed"/i);
  });

  it("gives an erased row as not usable", async () => {
    await storeRow(null, { erasedAt: STORED_AT + 5, erasedBy: "user-1" });
    const view = await loadStoredKeys(drizzle(env.DB), TENANT);
    expect(view).toMatchObject({ erasedAt: STORED_AT + 5, usable: false });
  });
});

describe("openStoredKeys", () => {
  it("gives null for a workspace with no stored keys", async () => {
    const { privateJwk } = await generatePairingKeyPair();
    const secretEnv = { CAPTURE_KEYS_PRIVATE_JWK: JSON.stringify(privateJwk) };
    expect(await openStoredKeys(drizzle(env.DB), secretEnv, TENANT, "production")).toBeNull();
  });

  it("gives null for an erased row", async () => {
    const { privateJwk } = await generatePairingKeyPair();
    await storeRow(null, { erasedAt: STORED_AT + 5, erasedBy: "user-1" });
    const secretEnv = { CAPTURE_KEYS_PRIVATE_JWK: JSON.stringify(privateJwk) };
    expect(await openStoredKeys(drizzle(env.DB), secretEnv, TENANT, "production")).toBeNull();
  });

  it("opens a sealed row with the private key, bound to the tenant and environment", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    await storeRow(await sealKeys(publicJwk, keys, { tenantId: TENANT, environment: "staging" }));
    const secretEnv = { CAPTURE_KEYS_PRIVATE_JWK: JSON.stringify(privateJwk) };
    const opened = await openStoredKeys(drizzle(env.DB), secretEnv, TENANT, "staging");
    expect(opened).not.toBeNull();
    expect(opened!.keys).toEqual(keys);
    expect(opened!.view).toMatchObject({ applianceId: "rig-1", revision: 3, usable: true });
  });

  it("throws one fixed message, with no secret in it, for a missing, malformed or wrong key or environment", async () => {
    const { publicJwk, privateJwk } = await generatePairingKeyPair();
    const other = await generatePairingKeyPair();
    await storeRow(await sealKeys(publicJwk, keys, { tenantId: TENANT, environment: "production" }));
    const db = drizzle(env.DB);
    const cases: [Record<string, string | undefined>, "production" | "staging"][] = [
      [{}, "production"],
      [{ CAPTURE_KEYS_PRIVATE_JWK: "{not json d=SECRETFRAGMENT" }, "production"],
      [{ CAPTURE_KEYS_PRIVATE_JWK: JSON.stringify(other.privateJwk) }, "production"],
      [{ CAPTURE_KEYS_PRIVATE_JWK: JSON.stringify(privateJwk) }, "staging"],
    ];
    const messages: string[] = [];
    for (const [secretEnv, environment] of cases) {
      const err = await openStoredKeys(db, secretEnv, TENANT, environment).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).not.toContain("SECRETFRAGMENT");
      expect(message).not.toContain(String(privateJwk.d));
      expect(message).not.toContain(String(other.privateJwk.d));
      expect(message).not.toContain("MadeUpSecret");
      expect((err as Error).name).toBe("Error");
      messages.push(message);
    }
    expect(new Set(messages).size).toBe(1);
  });
});

describe("eraseStoredKeysStatement", () => {
  async function run(revision: number, now: number) {
    const s = eraseStoredKeysStatement(TENANT, revision, "user-1", now);
    return env.DB.prepare(s.sql).bind(...s.params).run();
  }

  async function row() {
    return drizzle(env.DB).select().from(captureScannerKeys).where(eq(captureScannerKeys.tenantId, TENANT)).get();
  }

  it("erases the sealed keys at the revision given, keeping the bucket and appliance id", async () => {
    await storeRow("sealed-text");
    const result = await run(3, STORED_AT + 10);
    expect(result.meta.changes).toBe(1);
    expect(await row()).toMatchObject({
      sealed: null,
      erasedAt: STORED_AT + 10,
      erasedBy: "user-1",
      revision: 4,
      applianceId: "rig-1",
      bucket: "test-masters",
      ageRecipient: "age1madeuprecipient",
      storedAt: STORED_AT,
    });
  });

  it("changes nothing at a stale revision", async () => {
    await storeRow("sealed-text");
    const result = await run(2, STORED_AT + 10);
    expect(result.meta.changes).toBe(0);
    expect(await row()).toMatchObject({ sealed: "sealed-text", erasedAt: null, erasedBy: null, revision: 3 });
  });

  it("erases only where a further condition holds", async () => {
    await storeRow("sealed-text");
    const no = eraseStoredKeysStatement(TENANT, 3, "user-1", STORED_AT + 10, {
      sql: "EXISTS (SELECT 1 FROM tenants WHERE id = ?)",
      params: ["no-such-tenant"],
    });
    expect((await env.DB.prepare(no.sql).bind(...no.params).run()).meta.changes).toBe(0);
    expect(await row()).toMatchObject({ sealed: "sealed-text", revision: 3 });
    const yes = eraseStoredKeysStatement(TENANT, 3, "user-1", STORED_AT + 10, {
      sql: "EXISTS (SELECT 1 FROM tenants WHERE id = ?)",
      params: [TENANT],
    });
    expect((await env.DB.prepare(yes.sql).bind(...yes.params).run()).meta.changes).toBe(1);
    expect(await row()).toMatchObject({ sealed: null, revision: 4 });
  });

  it("erases at whatever revision the row has when no revision is given, and returns the appliance id", async () => {
    await storeRow("sealed-text");
    const s = eraseStoredKeysStatement(TENANT, undefined, "user-1", STORED_AT + 10);
    const result = await env.DB.prepare(s.sql).bind(...s.params).run();
    expect(result.meta.changes).toBe(1);
    expect(result.results).toEqual([{ appliance_id: "rig-1" }]);
    expect(await row()).toMatchObject({ sealed: null, revision: 4 });
    const again = await env.DB.prepare(s.sql).bind(...s.params).run();
    expect(again.meta.changes).toBe(0);
  });

  it("changes nothing on a row already erased", async () => {
    await storeRow(null, { erasedAt: STORED_AT + 5, erasedBy: "user-0" });
    const result = await run(3, STORED_AT + 10);
    expect(result.meta.changes).toBe(0);
    expect(await row()).toMatchObject({ erasedAt: STORED_AT + 5, erasedBy: "user-0", revision: 3 });
  });
});

describe("applianceKeyNames", () => {
  it("gives the names the minting command gives, with -staging on staging", () => {
    expect(applianceKeyNames("ahr", "rig-1", "production")).toEqual({
      write: "fisqua-ahr-appliance-rig-1",
      read: "fisqua-ahr-appliance-rig-1-read",
    });
    expect(applianceKeyNames("ahr", "rig-1", "staging")).toEqual({
      write: "fisqua-ahr-staging-appliance-rig-1",
      read: "fisqua-ahr-staging-appliance-rig-1-read",
    });
  });
});

describe("pairingEnvironment", () => {
  it("reads staging as staging and anything else as production", () => {
    expect(pairingEnvironment("staging")).toBe("staging");
    expect(pairingEnvironment("production")).toBe("production");
    expect(pairingEnvironment(undefined)).toBe("production");
    expect(pairingEnvironment("")).toBe("production");
    expect(pairingEnvironment("Staging")).toBe("production");
  });
});

// @version v0.9.0
