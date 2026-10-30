/**
 * Tests — the appliance key command
 *
 * This suite pins the command that mints a capture appliance's upload
 * key, run against the in-memory providers of the storage commands
 * (`tests/import/tenant-storage-fakes.ts`) and an in-memory Keychain
 * writer. Nothing here reaches an account or the real Keychain.
 *
 *   - names: `fisqua-{slug}[-staging]-appliance-{id}`, and the two
 *     Keychain accounts `{key name}-id` and `{key name}-secret`;
 *   - the dry run plans `[create]` with `listBuckets`, `listFiles` and
 *     `writeFiles` on the federation's masters bucket under `{slug}/`,
 *     and writes nothing;
 *   - an applied run issues the key with exactly those capabilities,
 *     bucket and prefix, stores its id and secret through the Keychain
 *     writer, prints the key's name, id and Keychain accounts and never
 *     the secret, and writes nothing to D1 or GitHub;
 *   - a key B2 reports with other limits after it is issued stops the
 *     command before anything is stored;
 *   - a key of the name already limited as it should be is `[exists]`
 *     and nothing is issued; one limited otherwise stops the command,
 *     which lists the keys of that name by id and deletes none;
 *   - the command refuses a tenant whose federation has no complete
 *     storage record, an invalid appliance id, and `--apply` against
 *     production without `--confirm-production`;
 *   - `--access read` makes the separate read key,
 *     `fisqua-{slug}[-staging]-appliance-{id}-read`, with `listBuckets`,
 *     `listFiles` and `readFiles` on the same bucket and prefix, under
 *     the same safeguards; a read key and an upload key never satisfy
 *     each other's check; `--access` defaults to `write` and refuses any
 *     other value.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { ProvisionStop, type DestinationValues } from "../../scripts/lib/tenant-storage";
import {
  applianceKeyName,
  B2_APPLIANCE_CAPABILITIES,
  B2_APPLIANCE_READ_CAPABILITIES,
  keychainAccounts,
  provisionApplianceKey,
  type ApplianceProviders,
} from "../../scripts/lib/appliance-key";
import { parseArgs, runApplianceCommand } from "../../scripts/commands/provision-appliance-key";
import { fakeWorld, FAKE_B2_S3, FAKE_R2_S3 } from "./tenant-storage-fakes";

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
const CAPABILITIES = ["listBuckets", "listFiles", "writeFiles"];
const NAME = "fisqua-sbmal-staging-appliance-rig-1";
const READ_CAPABILITIES = ["listBuckets", "listFiles", "readFiles"];
const READ_NAME = `${NAME}-read`;
const OPTS = {
  tenant: "sbmal",
  appliance: "rig-1",
  target: "staging" as const,
  apply: false,
  confirmProduction: false,
  access: "write" as const,
};
const READ_OPTS = { ...OPTS, access: "read" as const };
const WRITES = /create|put|set|update|add|write/i;

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

const writeCalls = (calls: string[]) => calls.filter((c) => WRITES.test(c.split(".")[1] ?? ""));

/** A world whose federation `acme` has its record and masters bucket, and an in-memory Keychain. */
function provisioned() {
  const w = fakeWorld({ listIssuedIds: true });
  Object.assign(w.world.d1.federations[0], RECORD);
  w.world.b2.buckets.set("acme-masters", {
    bucketId: "bucket-masters",
    bucketName: "acme-masters",
    bucketType: "allPrivate",
    corsRules: [],
  });
  const keychain: Array<{ service: string; account: string; value: string }> = [];
  const providers: ApplianceProviders = {
    b2: w.providers.b2,
    d1: w.providers.d1,
    keychain: (service, account, value) => {
      keychain.push({ service, account, value });
    },
  };
  return { ...w, providers, keychain };
}

describe("appliance key names", () => {
  it("names the key from the tenant's slug and the appliance's id, with -staging on staging", () => {
    expect(applianceKeyName("sbmal", "rig-1", "production")).toBe("fisqua-sbmal-appliance-rig-1");
    expect(applianceKeyName("sbmal", "rig-1", "staging")).toBe(NAME);
    expect(keychainAccounts(NAME)).toEqual({ id: `${NAME}-id`, secret: `${NAME}-secret` });
  });
});

describe("provisionApplianceKey", () => {
  it("dry run: plans [create] with list and write on the masters bucket under {slug}/, and writes nothing", async () => {
    const { world, providers, keychain } = provisioned();
    const out = capture();
    await runApplianceCommand(OPTS, providers, out.log);
    const text = out.text();
    expect(text).toContain("masters (B2, federation's):   acme-masters/sbmal/");
    expect(text).toContain(`appliance key:                ${NAME}`);
    expect(text).toContain("capabilities:                 listBuckets, listFiles, writeFiles");
    expect(text).toContain(`Keychain accounts:            ${NAME}-id, ${NAME}-secret`);
    expect(text).toContain(
      `[create] would issue ${NAME}: B2 key, list and write, limited to acme-masters/sbmal/ (appliance)`,
    );
    expect(text).toContain("Dry run: nothing was written");
    expect(writeCalls(world.calls)).toEqual([]);
    expect(world.b2.keys).toEqual([]);
    expect(keychain).toEqual([]);
  });

  it("apply: issues the key with exactly its limits and stores id and secret in the Keychain, never printing the secret", async () => {
    const { world, providers, keychain } = provisioned();
    const out = capture();
    await runApplianceCommand({ ...OPTS, apply: true }, providers, out.log);
    expect(world.b2.keys).toHaveLength(1);
    const key = world.b2.keys[0];
    expect(key).toMatchObject({ name: NAME, bucketId: "bucket-masters", namePrefix: "sbmal/" });
    expect([...key.capabilities].sort()).toEqual(CAPABILITIES);
    expect(key.capabilities).not.toContain("readFiles");
    expect(key.capabilities).not.toContain("deleteFiles");
    const [keyId, secret] = world.issued;
    expect(keychain).toEqual([
      { service: "fisqua-appliance", account: `${NAME}-id`, value: keyId },
      { service: "fisqua-appliance", account: `${NAME}-secret`, value: secret },
    ]);
    const text = out.text();
    expect(text).not.toContain(secret);
    expect(text).toContain(`[create] issued ${NAME}`);
    expect(text).toContain(`key ${keyId}`);
    expect(text).toContain(`accounts ${NAME}-id and ${NAME}-secret`);
    expect(text).not.toContain("Dry run");
    // Nothing to D1, nothing to GitHub.
    expect(world.d1.writes).toBe(0);
    expect(world.calls.filter((c) => c.startsWith("gh.") || c.startsWith("d1.write"))).toEqual([]);
  });

  it("apply: stops before storing anything when B2 reports the new key with other limits", async () => {
    const { world, providers, keychain } = provisioned();
    const b2 = providers.b2!;
    const out = capture();
    const message = await stopped(
      runApplianceCommand(
        { ...OPTS, apply: true },
        {
          ...providers,
          b2: {
            ...b2,
            async keys() {
              return (await b2.keys()).map((k) => ({ ...k, capabilities: [...k.capabilities, "readFiles"] }));
            },
          },
        },
        out.log,
      ),
    );
    const [keyId, secret] = world.issued;
    expect(message).toContain(`reports the new key as key ${keyId}`);
    expect(message).toContain("Nothing was stored in the Keychain");
    expect(message).toContain(`delete key ${keyId} (${NAME}) by hand`);
    expect(message).not.toContain(secret);
    expect(keychain).toEqual([]);
  });

  it("a key of the name with the right limits is [exists], and nothing is issued", async () => {
    const { world, providers, keychain } = provisioned();
    world.b2.keys.push({ name: NAME, bucketId: "bucket-masters", capabilities: ["writeFiles", "listBuckets", "listFiles"], namePrefix: "sbmal/", keyId: "HELDKEY1" });
    for (const apply of [false, true]) {
      const out = capture();
      const callsBefore = world.calls.length;
      await runApplianceCommand({ ...OPTS, apply }, providers, out.log);
      expect(out.text()).toContain(`[exists] ${NAME}: B2 key, list and write, limited to acme-masters/sbmal/ (appliance); key HELDKEY1`);
      expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    }
    expect(world.b2.keys).toHaveLength(1);
    expect(keychain).toEqual([]);
  });

  it("keys of the name with other limits stop the command, listed by id, and none is deleted", async () => {
    const { world, providers, keychain } = provisioned();
    world.b2.keys.push(
      { name: NAME, bucketId: "bucket-masters", capabilities: CAPABILITIES, namePrefix: "sbmal/", keyId: "GOODKEY" },
      { name: NAME, bucketId: "bucket-masters", capabilities: [...CAPABILITIES, "readFiles"], namePrefix: "sbmal/", keyId: "READKEY" },
      { name: NAME, bucketId: "bucket-other", capabilities: CAPABILITIES, namePrefix: "sbmal/", keyId: "OTHERKEY" },
    );
    for (const apply of [false, true]) {
      const callsBefore = world.calls.length;
      const message = await stopped(runApplianceCommand({ ...OPTS, apply }, providers, () => {}));
      expect(message).toContain(`keys named ${NAME} that are not limited to listBuckets, listFiles, writeFiles on acme-masters/sbmal/`);
      expect(message).toContain("key GOODKEY (bucket bucket-masters, prefix sbmal/");
      expect(message).toContain("key READKEY (bucket bucket-masters, prefix sbmal/, capabilities listBuckets, listFiles, writeFiles, readFiles)");
      expect(message).toContain("key OTHERKEY (bucket bucket-other");
      expect(message).toContain("delete the stale key(s) by hand");
      expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    }
    expect(world.b2.keys).toHaveLength(3);
    expect(keychain).toEqual([]);
  });

  it("refuses a tenant whose federation has no complete storage record", async () => {
    const { world, providers, keychain } = provisioned();
    world.d1.federations[0].pipeline_masters_bucket = null;
    const message = await stopped(runApplianceCommand({ ...OPTS, apply: true }, providers, () => {}));
    expect(message).toContain("The federation acme has no complete storage record (unset: pipeline_masters_bucket)");
    expect(world.calls.filter((c) => c.startsWith("b2."))).toEqual([]);
    expect(keychain).toEqual([]);
  });

  it("refuses a tenant without a federation, and an unknown tenant", async () => {
    const { world, providers } = provisioned();
    expect(await stopped(runApplianceCommand({ ...OPTS, tenant: "nobody" }, providers, () => {}))).toBe(
      "No tenant has the slug nobody",
    );
    world.d1.tenants[0].federation_id = null;
    expect(await stopped(runApplianceCommand(OPTS, providers, () => {}))).toContain("has no federation");
  });

  it("refuses an invalid appliance id, in the arguments and in the step", async () => {
    const { world, providers } = provisioned();
    for (const bad of ["Rig-1", "rig_1", "rig 1", "", "a".repeat(33)]) {
      expect(await stopped(provisionApplianceKey({ slug: "sbmal", appliance: bad, target: "staging", apply: true }, providers, () => {}))).toContain(
        "Not an appliance id",
      );
    }
    expect(world.calls).toEqual([]);
    for (const bad of ["Rig-1", "rig_1", "a".repeat(33)]) {
      expect(() => parseArgs(["--tenant", "sbmal", "--appliance", bad, "--target", "staging"])).toThrow(/Not an appliance id/);
    }
    expect(parseArgs(["--tenant", "sbmal", "--appliance", "a".repeat(32), "--target", "staging"]).appliance).toBe("a".repeat(32));
  });

  it("arguments: production --apply needs --confirm-production; the target and appliance are required", () => {
    const base = ["--tenant", "sbmal", "--appliance", "rig-1"];
    expect(() => parseArgs([...base, "--target", "production", "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs([...base, "--target", "production", "--apply", "--confirm-production"])).toMatchObject({
      target: "production",
      apply: true,
    });
    expect(parseArgs([...base, "--target", "production"]).apply).toBe(false);
    expect(parseArgs([...base, "--target", "staging", "--apply"]).apply).toBe(true);
    expect(() => parseArgs(base)).toThrow(/--target is required/);
    expect(() => parseArgs(["--tenant", "sbmal", "--target", "staging"])).toThrow(/--appliance is required/);
    expect(() => parseArgs([...base, "--target", "staging", "--working-bucket", "x"])).toThrow(/Unknown argument/);
  });
});

describe("the read key (--access read)", () => {
  it("names the read key with -read after the upload key's name, and its Keychain accounts from that name", () => {
    expect(applianceKeyName("sbmal", "rig-1", "production", "read")).toBe("fisqua-sbmal-appliance-rig-1-read");
    expect(applianceKeyName("sbmal", "rig-1", "staging", "read")).toBe(READ_NAME);
    expect(applianceKeyName("sbmal", "rig-1", "staging")).toBe(NAME);
    expect(B2_APPLIANCE_READ_CAPABILITIES).toEqual(READ_CAPABILITIES);
    expect(B2_APPLIANCE_CAPABILITIES).toEqual(CAPABILITIES);
  });

  it("arguments: --access defaults to write, takes read, and refuses any other value", () => {
    const base = ["--tenant", "sbmal", "--appliance", "rig-1", "--target", "staging"];
    expect(parseArgs(base).access).toBe("write");
    expect(parseArgs([...base, "--access", "write"]).access).toBe("write");
    expect(parseArgs([...base, "--access", "read"]).access).toBe("read");
    for (const bad of ["Read", "readwrite", "delete", "rw"]) {
      expect(() => parseArgs([...base, "--access", bad])).toThrow(/Not an appliance key access/);
    }
    expect(() => parseArgs([...base, "--access"])).toThrow(/--access needs a value/);
  });

  it("refuses an appliance id ending in -read, whose upload key would carry another appliance's read key name", async () => {
    const { world, providers } = provisioned();
    expect(() => parseArgs(["--tenant", "sbmal", "--appliance", "rig-1-read", "--target", "staging"])).toThrow(/may not end in -read/);
    expect(await stopped(provisionApplianceKey({ slug: "sbmal", appliance: "rig-1-read", target: "staging", apply: true }, providers, () => {}))).toContain(
      "may not end in -read",
    );
    expect(world.calls).toEqual([]);
  });

  it("production --apply needs --confirm-production for the read key too", () => {
    const base = ["--tenant", "sbmal", "--appliance", "rig-1", "--target", "production", "--access", "read"];
    expect(() => parseArgs([...base, "--apply"])).toThrow(/--confirm-production/);
    expect(parseArgs([...base, "--apply", "--confirm-production"])).toMatchObject({ access: "read", apply: true });
  });

  it("dry run: plans [create] with list and read on the masters bucket under {slug}/, and writes nothing", async () => {
    const { world, providers, keychain } = provisioned();
    const out = capture();
    await runApplianceCommand(READ_OPTS, providers, out.log);
    const text = out.text();
    expect(text).toContain("Appliance read key for tenant sbmal");
    expect(text).toContain(`appliance read key:           ${READ_NAME}`);
    expect(text).toContain("capabilities:                 listBuckets, listFiles, readFiles");
    expect(text).toContain(`Keychain accounts:            ${READ_NAME}-id, ${READ_NAME}-secret`);
    expect(text).toContain(
      `[create] would issue ${READ_NAME}: B2 key, list and read, limited to acme-masters/sbmal/ (appliance read key)`,
    );
    expect(text).toContain("Dry run: nothing was written");
    expect(writeCalls(world.calls)).toEqual([]);
    expect(world.b2.keys).toEqual([]);
    expect(keychain).toEqual([]);
  });

  it("apply: issues the read key with exactly list and read on {slug}/ and stores it under the -read accounts", async () => {
    const { world, providers, keychain } = provisioned();
    const out = capture();
    await runApplianceCommand({ ...READ_OPTS, apply: true }, providers, out.log);
    expect(world.b2.keys).toHaveLength(1);
    const key = world.b2.keys[0];
    expect(key).toMatchObject({ name: READ_NAME, bucketId: "bucket-masters", namePrefix: "sbmal/" });
    expect([...key.capabilities].sort()).toEqual(READ_CAPABILITIES);
    expect(key.capabilities).not.toContain("writeFiles");
    expect(key.capabilities).not.toContain("deleteFiles");
    const [keyId, secret] = world.issued;
    expect(keychain).toEqual([
      { service: "fisqua-appliance", account: `${READ_NAME}-id`, value: keyId },
      { service: "fisqua-appliance", account: `${READ_NAME}-secret`, value: secret },
    ]);
    const text = out.text();
    expect(text).not.toContain(secret);
    expect(text).toContain(`[create] issued ${READ_NAME}: B2 key, list and read, limited to acme-masters/sbmal/ (appliance read key); key ${keyId}`);
    expect(text).toContain("B2 reports listBuckets, listFiles, readFiles on acme-masters/sbmal/");
    expect(text).toContain(`accounts ${READ_NAME}-id and ${READ_NAME}-secret`);
    expect(world.d1.writes).toBe(0);
  });

  it("apply: stops before storing anything when B2 reports the new read key with other limits", async () => {
    const { world, providers, keychain } = provisioned();
    const b2 = providers.b2!;
    const message = await stopped(
      runApplianceCommand(
        { ...READ_OPTS, apply: true },
        {
          ...providers,
          b2: {
            ...b2,
            async keys() {
              return (await b2.keys()).map((k) => ({ ...k, capabilities: [...k.capabilities, "writeFiles"] }));
            },
          },
        },
        () => {},
      ),
    );
    const [keyId, secret] = world.issued;
    expect(message).toContain(`reports the new key as key ${keyId}`);
    expect(message).toContain("not listBuckets, listFiles, readFiles on bucket bucket-masters, prefix sbmal/");
    expect(message).toContain(`delete key ${keyId} (${READ_NAME}) by hand`);
    expect(message).not.toContain(secret);
    expect(keychain).toEqual([]);
  });

  it("a read key of the name with the right limits is [exists], and nothing is issued", async () => {
    const { world, providers, keychain } = provisioned();
    world.b2.keys.push({ name: READ_NAME, bucketId: "bucket-masters", capabilities: ["readFiles", "listFiles", "listBuckets"], namePrefix: "sbmal/", keyId: "HELDREAD" });
    for (const apply of [false, true]) {
      const out = capture();
      const callsBefore = world.calls.length;
      await runApplianceCommand({ ...READ_OPTS, apply }, providers, out.log);
      expect(out.text()).toContain(`[exists] ${READ_NAME}: B2 key, list and read, limited to acme-masters/sbmal/ (appliance read key); key HELDREAD`);
      expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    }
    expect(world.b2.keys).toHaveLength(1);
    expect(keychain).toEqual([]);
  });

  it("a key named for the read key but limited as the upload key stops the command, and none is deleted", async () => {
    const { world, providers, keychain } = provisioned();
    world.b2.keys.push({ name: READ_NAME, bucketId: "bucket-masters", capabilities: CAPABILITIES, namePrefix: "sbmal/", keyId: "WRONGREAD" });
    for (const apply of [false, true]) {
      const callsBefore = world.calls.length;
      const message = await stopped(runApplianceCommand({ ...READ_OPTS, apply }, providers, () => {}));
      expect(message).toContain(`keys named ${READ_NAME} that are not limited to listBuckets, listFiles, readFiles on acme-masters/sbmal/`);
      expect(message).toContain("key WRONGREAD (bucket bucket-masters, prefix sbmal/, capabilities listBuckets, listFiles, writeFiles)");
      expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    }
    expect(world.b2.keys).toHaveLength(1);
    expect(keychain).toEqual([]);
  });

  it("a key named for the upload key but limited as the read key stops the upload key's command", async () => {
    const { world, providers } = provisioned();
    world.b2.keys.push({ name: NAME, bucketId: "bucket-masters", capabilities: READ_CAPABILITIES, namePrefix: "sbmal/", keyId: "WRONGWRITE" });
    const message = await stopped(runApplianceCommand(OPTS, providers, () => {}));
    expect(message).toContain(`keys named ${NAME} that are not limited to listBuckets, listFiles, writeFiles`);
    expect(message).toContain("key WRONGWRITE");
  });

  it("the upload key and the read key never stand in for each other", async () => {
    // Only the read key exists: the upload key's run plans [create], not [exists].
    let w = provisioned();
    w.world.b2.keys.push({ name: READ_NAME, bucketId: "bucket-masters", capabilities: READ_CAPABILITIES, namePrefix: "sbmal/", keyId: "HELDREAD" });
    let out = capture();
    await runApplianceCommand(OPTS, w.providers, out.log);
    expect(out.text()).toContain(`[create] would issue ${NAME}:`);
    expect(out.text()).not.toContain(`[exists] ${NAME}`);
    // Only the upload key exists: the read key's run plans [create], not [exists].
    w = provisioned();
    w.world.b2.keys.push({ name: NAME, bucketId: "bucket-masters", capabilities: CAPABILITIES, namePrefix: "sbmal/", keyId: "HELDWRITE" });
    out = capture();
    await runApplianceCommand(READ_OPTS, w.providers, out.log);
    expect(out.text()).toContain(`[create] would issue ${READ_NAME}:`);
    expect(out.text()).not.toContain(`[exists] ${READ_NAME}`);
    // Both exist: each is [exists] on its own key only.
    w.world.b2.keys.push({ name: READ_NAME, bucketId: "bucket-masters", capabilities: READ_CAPABILITIES, namePrefix: "sbmal/", keyId: "HELDREAD" });
    out = capture();
    await runApplianceCommand({ ...OPTS, apply: true }, w.providers, out.log);
    expect(out.text()).toContain(`[exists] ${NAME}: B2 key, list and write, limited to acme-masters/sbmal/ (appliance); key HELDWRITE, nothing issued`);
    out = capture();
    await runApplianceCommand({ ...READ_OPTS, apply: true }, w.providers, out.log);
    expect(out.text()).toContain(`[exists] ${READ_NAME}: B2 key, list and read, limited to acme-masters/sbmal/ (appliance read key); key HELDREAD, nothing issued`);
    expect(w.world.b2.keys).toHaveLength(2);
    expect(w.keychain).toEqual([]);
  });

});

// @version v0.8.0
