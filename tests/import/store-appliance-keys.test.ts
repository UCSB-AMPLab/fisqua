/**
 * Tests — the command that stores a workspace's appliance keys
 *
 * This suite pins the operator command that seals a workspace's two
 * appliance key pairs with the environment's pairing public key and
 * stores the sealed text in D1, run against the in-memory D1 of the
 * storage commands (`tests/import/tenant-storage-fakes.ts`), an
 * in-memory Keychain, a fake SQL file runner and a fixed clock. Nothing
 * here reaches the real Keychain, wrangler or the network. The key
 * material is made up.
 *
 *   - arguments: `--tenant`, `--appliance`, `--target` and
 *     `--age-recipient` are required and checked before anything is
 *     read; the age recipient matches `^age1[0-9a-z]{58}$`; `--apply`
 *     against production also needs `--confirm-production`;
 *   - a dry run checks that the four Keychain entries exist, reads no
 *     secret, prints the key names, bucket and age recipient, and writes
 *     nothing;
 *   - a missing Keychain entry, a null public key or an unknown tenant
 *     stops the command before anything is written;
 *   - an applied run writes one upsert through a SQL file in a fresh
 *     directory, mode 0600, removed afterwards even when the write
 *     fails; the file holds no key id or secret in plain; the test private
 *     key opens the sealed text with the binding of the tenant id and the
 *     target, and with no other binding;
 *   - the log carries no secret, and an applied run prints the names
 *     stored, the new revision and that approved codes are void; when
 *     the revision cannot be read back after the write, the command
 *     stops saying that the row was stored;
 *   - the upsert sets revision 1 on first store and `revision + 1` on
 *     conflict, clears an erasure, and writes its values as SQL string
 *     literals with single quotes doubled.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ProvisionStop, type DestinationValues } from "../../scripts/lib/tenant-storage";
import type { KeychainStore } from "../../scripts/lib/keychain";
import {
  AGE_RECIPIENT_PATTERN,
  parseArgs,
  runStoreApplianceKeys,
  storeKeysStatement,
  type StoreCliOptions,
  type StoreProviders,
} from "../../scripts/commands/store-appliance-keys";
import { generatePairingKeyPair, openKeys } from "../../app/lib/capture/pairing-seal";
import { fakeWorld, FAKE_B2_S3, FAKE_R2_S3, FAKE_TENANT_ID } from "./tenant-storage-fakes";

const RECORD: DestinationValues = {
  pipeline_delivery_endpoint: FAKE_B2_S3,
  pipeline_tiles_bucket: "acme-iiif-tiles",
  pipeline_masters_bucket: "acme-masters",
  pipeline_image_base_url: "https://iiif.acme.example.test",
  manifest_endpoint: FAKE_R2_S3,
  manifest_bucket: "acme-manifests",
  manifest_base_url: "https://manifests.acme.example.test",
  storage_secret_prefix: "FEDERATION_ACME",
};
const AGE = `age1${"q".repeat(58)}`;
const WRITE_NAME = "fisqua-sbmal-staging-appliance-rig-1";
const READ_NAME = `${WRITE_NAME}-read`;
const SECRETS: Record<string, string> = {
  [`${WRITE_NAME}-id`]: "MADEUPWRITEKEYID0001",
  [`${WRITE_NAME}-secret`]: "MadeUpWriteSecretValue0001",
  [`${READ_NAME}-id`]: "MADEUPREADKEYID0002",
  [`${READ_NAME}-secret`]: "MadeUpReadSecretValue0002",
};
const NOW = 1_763_000_000_000;
const OPTS: StoreCliOptions = {
  tenant: "sbmal",
  appliance: "rig-1",
  target: "staging",
  ageRecipient: AGE,
  apply: false,
  confirmProduction: false,
};

function capture() {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), text: () => lines.join("\n") };
}

async function stopped(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProvisionStop) return err.message;
    throw err;
  }
  throw new Error("expected the command to stop");
}

async function setup(options: { missing?: string; revisionAfter?: number; failWrite?: boolean; failRevision?: boolean } = {}) {
  const w = fakeWorld();
  Object.assign(w.world.d1.federations[0], RECORD);
  const pair = await generatePairingKeyPair();
  const reads: string[] = [];
  const keychain: KeychainStore = {
    has: (service, account) => service === "fisqua-appliance" && account in SECRETS && account !== options.missing,
    read: (service, account) => {
      reads.push(account);
      return service === "fisqua-appliance" && account !== options.missing ? (SECRETS[account] ?? null) : null;
    },
    add: () => {
      throw new Error("the storing command adds nothing to the Keychain");
    },
  };
  const files: Array<{ path: string; sql: string; mode: number; dirMode: number }> = [];
  const providers: StoreProviders = {
    d1: w.providers.d1,
    keychain,
    keysDb: {
      runFile(path) {
        files.push({
          path,
          sql: readFileSync(path, "utf8"),
          mode: statSync(path).mode & 0o777,
          dirMode: statSync(dirname(path)).mode & 0o777,
        });
        if (options.failWrite) throw new Error("wrangler d1 execute failed");
      },
      revision: () => {
        if (options.failRevision) throw new Error("wrangler d1 execute failed: overloaded");
        return options.revisionAfter ?? 1;
      },
    },
    publicKeys: { staging: pair.publicJwk, production: null },
    now: () => NOW,
  };
  return { world: w.world, providers, pair, files, reads };
}

function sealedFrom(sql: string): string {
  const m = /'(\{"v":1,(?:[^']|'')*)'/.exec(sql);
  if (!m) throw new Error("no sealed value in the SQL");
  return m[1].replace(/''/g, "'");
}

describe("parseArgs", () => {
  const base = ["--tenant", "sbmal", "--appliance", "rig-1", "--target", "staging", "--age-recipient", AGE];

  it("reads the options", () => {
    expect(parseArgs(base)).toEqual(OPTS);
  });

  it("requires every option", () => {
    for (const flag of ["--tenant", "--appliance", "--target", "--age-recipient"]) {
      const i = base.indexOf(flag);
      const argv = [...base.slice(0, i), ...base.slice(i + 2)];
      expect(() => parseArgs(argv)).toThrow(flag);
    }
  });

  it("refuses a malformed age recipient", () => {
    expect(AGE_RECIPIENT_PATTERN.source).toBe("^age1[0-9a-z]{58}$");
    for (const bad of [`age1${"q".repeat(57)}`, `age1${"Q".repeat(58)}`, `AGE1${"q".repeat(58)}`, `age1${"q".repeat(59)}`, "x"]) {
      const argv = [...base.slice(0, 6), "--age-recipient", bad];
      expect(() => parseArgs(argv)).toThrow(/age recipient/);
    }
  });

  it("refuses a malformed tenant slug or appliance id", () => {
    expect(() => parseArgs(["--tenant", "SBMAL", ...base.slice(2)])).toThrow(/tenant slug/);
    expect(() => parseArgs(["--tenant", "x'y", ...base.slice(2)])).toThrow(/tenant slug/);
    expect(() => parseArgs([...base.slice(0, 2), "--appliance", "Rig_1", ...base.slice(4)])).toThrow(/appliance id/);
    expect(() => parseArgs([...base.slice(0, 2), "--appliance", "rig-read", ...base.slice(4)])).toThrow(/appliance id/);
  });

  it("refuses --apply against production without --confirm-production", () => {
    const prod = [...base.slice(0, 4), "--target", "production", ...base.slice(6)];
    expect(() => parseArgs([...prod, "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs([...prod, "--apply", "--confirm-production"])).toMatchObject({ target: "production", apply: true });
  });
});

describe("storeKeysStatement", () => {
  it("inserts revision 1, and on conflict replaces the row, clears an erasure and raises the revision", () => {
    const sql = storeKeysStatement({
      tenantId: "t-1",
      applianceId: "rig-1",
      bucket: "acme-masters",
      sealed: '{"v":1}',
      ageRecipient: AGE,
      now: NOW,
    });
    expect(sql).toContain("INSERT INTO capture_scanner_keys");
    expect(sql).toContain(`VALUES ('t-1', 'rig-1', 'acme-masters', '{"v":1}', '${AGE}', 1, ${NOW}, NULL, NULL)`);
    expect(sql).toContain("ON CONFLICT(tenant_id) DO UPDATE SET");
    for (const set of [
      "appliance_id = excluded.appliance_id",
      "bucket = excluded.bucket",
      "sealed = excluded.sealed",
      "age_recipient = excluded.age_recipient",
      "stored_at = excluded.stored_at",
      "erased_at = NULL",
      "erased_by = NULL",
      "revision = capture_scanner_keys.revision + 1",
    ]) {
      expect(sql).toContain(set);
    }
  });

  it("writes values as SQL string literals with single quotes doubled", () => {
    const sql = storeKeysStatement({
      tenantId: "t'1",
      applianceId: "rig-1",
      bucket: "b",
      sealed: "it's",
      ageRecipient: AGE,
      now: NOW,
    });
    expect(sql).toContain("'t''1'");
    expect(sql).toContain("'it''s'");
  });
});

describe("runStoreApplianceKeys", () => {
  it("dry run: checks the Keychain entries exist, reads no secret, prints names, bucket and age recipient, and writes nothing", async () => {
    const { providers, files, reads, world } = await setup();
    const out = capture();
    await runStoreApplianceKeys(OPTS, providers, out.log);
    const text = out.text();
    expect(text).toContain(WRITE_NAME);
    expect(text).toContain(READ_NAME);
    expect(text).toContain("acme-masters");
    expect(text).toContain(AGE);
    expect(text).toContain(FAKE_TENANT_ID);
    expect(text).toContain("Dry run: nothing was written");
    expect(reads).toEqual([]);
    expect(files).toEqual([]);
    expect(world.d1.writes).toBe(0);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
  });

  it("stops when any of the four Keychain entries is missing, before writing", async () => {
    for (const missing of Object.keys(SECRETS)) {
      for (const apply of [false, true]) {
        const { providers, files } = await setup({ missing });
        const out = capture();
        const message = await stopped(runStoreApplianceKeys({ ...OPTS, apply }, providers, out.log));
        expect(message).toContain(missing);
        expect(files).toEqual([]);
        // Nothing printed before the stop says the keys were stored.
        expect(out.text()).not.toMatch(/\bstored\b/i);
      }
    }
  });

  it("stops when the target has no public key, before reading the Keychain or writing", async () => {
    const { providers, files, reads } = await setup();
    const message = await stopped(
      runStoreApplianceKeys({ ...OPTS, apply: true }, { ...providers, publicKeys: { staging: null, production: null } }, capture().log),
    );
    expect(message).toContain("PAIRING_PUBLIC_KEYS.staging");
    expect(reads).toEqual([]);
    expect(files).toEqual([]);
  });

  it("stops for an unknown tenant", async () => {
    const { providers, files, reads } = await setup();
    const message = await stopped(runStoreApplianceKeys({ ...OPTS, tenant: "nobody", apply: true }, providers, capture().log));
    expect(message).toContain("nobody");
    expect(reads).toEqual([]);
    expect(files).toEqual([]);
  });

  it("apply: writes one upsert through a 0600 file in a fresh directory, with no secret in plain, and removes it", async () => {
    const { providers, files, pair } = await setup({ revisionAfter: 3 });
    const out = capture();
    await runStoreApplianceKeys({ ...OPTS, apply: true }, providers, out.log);
    expect(files).toHaveLength(1);
    const { path, sql, mode, dirMode } = files[0];
    expect(mode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
    for (const secret of Object.values(SECRETS)) expect(sql).not.toContain(secret);
    expect(sql).toContain(`'${FAKE_TENANT_ID}', 'rig-1', 'acme-masters'`);
    expect(sql).toContain(`'${AGE}', 1, ${NOW}, NULL, NULL`);

    const sealed = sealedFrom(sql);
    const opened = await openKeys(pair.privateJwk, sealed, { tenantId: FAKE_TENANT_ID, environment: "staging" });
    expect(opened).toEqual({
      writeKey: { keyId: SECRETS[`${WRITE_NAME}-id`], applicationKey: SECRETS[`${WRITE_NAME}-secret`] },
      readKey: { keyId: SECRETS[`${READ_NAME}-id`], applicationKey: SECRETS[`${READ_NAME}-secret`] },
    });
    await expect(openKeys(pair.privateJwk, sealed, { tenantId: "another-tenant", environment: "staging" })).rejects.toThrow();
    await expect(openKeys(pair.privateJwk, sealed, { tenantId: FAKE_TENANT_ID, environment: "production" })).rejects.toThrow();

    const text = out.text();
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).not.toContain(sealed);
    expect(text).toContain(WRITE_NAME);
    expect(text).toContain(READ_NAME);
    expect(text).toContain("revision 3");
    expect(text).toMatch(/approved.*void/i);
    expect(text).not.toContain("Dry run");
  });

  it("apply: says the row was stored when the revision cannot be read back", async () => {
    const { providers, files } = await setup({ failRevision: true });
    const message = await stopped(runStoreApplianceKeys({ ...OPTS, apply: true }, providers, capture().log));
    expect(files).toHaveLength(1);
    expect(message).toMatch(/stored/);
    expect(message).toMatch(/revision could not be read back/);
    expect(message).toContain("overloaded");
  });

  it("apply: removes the temporary directory when the write fails", async () => {
    const { providers, files } = await setup({ failWrite: true });
    await expect(runStoreApplianceKeys({ ...OPTS, apply: true }, providers, capture().log)).rejects.toThrow(/wrangler/);
    expect(files).toHaveLength(1);
    expect(existsSync(dirname(files[0].path))).toBe(false);
  });
});

// @version v0.9.0
