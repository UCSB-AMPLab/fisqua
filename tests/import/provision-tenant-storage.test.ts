/**
 * Tests — the tenant storage command
 *
 * This suite pins the tenant step: the command that gives one tenant's
 * pipeline runs their runner keys in its federation's storage, run
 * against in-memory providers (`tests/import/tenant-storage-fakes.ts`)
 * and, for the HTTP clients, an injected fetch. Nothing here reaches an
 * account.
 *
 *   - names: the runner Environment (`fisqua-pipeline-{tenantId}`, on
 *     staging `fisqua-pipeline-staging-{tenantId}`), the tenant's slug
 *     prefix, its working prefix, and the runner's key names from the
 *     tenant's slug, with `-staging` on staging;
 *   - the step refuses a tenant without a federation, a federation
 *     without a complete record or without its Worker secrets, the local
 *     target, and a federation bucket missing from the account;
 *   - the dry run reads and writes nothing and prints each step;
 *   - an applied run creates the Environment and issues the runner's five
 *     keys into it: tiles write and read limited to the federation's
 *     tiles bucket and `{slug}/`, masters read limited to the masters
 *     bucket and `{slug}/`, working write and read limited to
 *     `{tenantId}/`; it adds the Environment and the federation's storage
 *     host to the repository variables, writes nothing to D1 and creates
 *     no bucket; a second run changes nothing;
 *   - two tenants of one federation get keys on the same buckets, each
 *     limited to its own prefix, in their own Environments;
 *   - a key whose secrets are set but which no key of its name in the
 *     account fits (after the federation's bucket changed) is issued
 *     again (`[reissue]`, the replaced key left for deletion by hand),
 *     which pending work of the tenant refuses;
 *   - keys of one name limited to different buckets or prefixes (after
 *     a change back to an earlier bucket, with the old keys not yet
 *     deleted) stop the step before anything is written, listing them by
 *     id and limit; keys of one name all limited alike count as one;
 *   - a run that fails part way is finished by the next one without
 *     issuing a key whose secrets are already set;
 *   - the review-tiles keys: with a review-tiles bucket on the
 *     federation's record, a write key (list, read, write) and a delete
 *     key (list buckets, read buckets, list files, delete files) limited
 *     to that bucket and `{slug}/`, held under
 *     `REVIEW_WRITE_KEY_ID`/`REVIEW_WRITE_KEY` and
 *     `REVIEW_DELETE_KEY_ID`/`REVIEW_DELETE_KEY`; without one they are
 *     not issued; a tenant holding the five earlier keys is given only
 *     the two, with work open; a changed review-tiles bucket issues them
 *     again, which pending work refuses; a recorded bucket missing from
 *     the account stops the step;
 *   - a held key scoped right but without exactly its role's
 *     capabilities (a review delete key that can also read and write, an
 *     earlier read key that can write) is issued again under the reissue
 *     rule, which pending work refuses; the same capabilities in another
 *     order fit; keys of one name and limit with different capabilities
 *     stop the step;
 *   - a working bucket that is the federation's masters, tiles, review
 *     tiles or manifest bucket, or a bucket another federation records,
 *     stops the step before anything is read or issued;
 *   - a federation record that names one bucket in two roles (its
 *     review-tiles bucket being its masters, say) stops the step before
 *     anything is read or issued;
 *   - a federation or working bucket tagged in B2 for another role,
 *     environment or federation stops the step before any key is issued,
 *     and so does an untagged review-tiles bucket that holds files; a
 *     masters bucket is checked for its role and federation only, so one
 *     with no environment tag, or tagged for either environment, takes
 *     the runner's keys unchanged;
 *   - a dry run stops as apply does when a key would be issued over a
 *     bucket not tagged exactly for it, naming the command that tags
 *     each; an untagged bucket whose keys are all held does not stop it;
 *   - a runner pair's write is marked in D1: a failed second secret
 *     deletes the new key and leaves the mark, and the next run issues
 *     the pair again even when its live key fits; a crashed run's mark is
 *     handled the same; a full run leaves none;
 *   - no issued key or secret value appears in the output;
 *   - the arguments: production needs `--confirm-production` to apply,
 *     `--adopt` and `--domain` are refused, and the working bucket is the
 *     target's unless one is named;
 *   - the HTTP clients: B2 key and bucket requests (a key's name prefix,
 *     a private bucket), the keys' limits and capabilities read back,
 *     the files under a prefix listed page by page, a taken bucket name, the R2 token's S3 secret as the SHA-256 of its
 *     value, GitHub variables created or updated and secrets passed to
 *     `gh` on stdin, and the tenant's pending-work statement.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  b2Client,
  ensureB2Bucket,
  BucketNameTakenError,
  BucketRevisionConflictError,
  cloudflareClient,
  githubClient,
  pendingWorkStatement,
  provisionTenantStorage,
  ProvisionStop,
  tenantStorageNames,
  B2_CORS_RULES,
  RUNNER_SECRETS,
  type DestinationValues,
} from "../../scripts/lib/tenant-storage";
import { parseArgs, runTenantCommand } from "../../scripts/commands/provision-tenant-storage";
import {
  emptyFederation,
  fakeWorld,
  FAKE_B2_DOWNLOAD,
  FAKE_B2_S3,
  FAKE_R2_S3,
  FAKE_TENANT_ID,
  FAKE_WORKING_BUCKET,
  FAKE_WORKING_BUCKET_ID,
} from "./tenant-storage-fakes";

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
const OPTS = { slug: "sbmal", target: "production" as const, workingBucket: FAKE_WORKING_BUCKET };
const ENV = `fisqua-pipeline-${FAKE_TENANT_ID}`;
const WRITES = /create|put|set|update|add|write/i;
const RUNNER_SECRET_NAMES = [
  "DELIVERY_READ_KEY",
  "DELIVERY_READ_KEY_ID",
  "DELIVERY_WRITE_KEY",
  "DELIVERY_WRITE_KEY_ID",
  "SOURCE_READ_KEY",
  "SOURCE_READ_KEY_ID",
  "WORKING_READ_KEY",
  "WORKING_READ_KEY_ID",
  "WORKING_WRITE_KEY",
  "WORKING_WRITE_KEY_ID",
];

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

/** A world whose federation `acme` has its storage: buckets, record and Fisqua's secrets. */
function provisioned(options: Parameters<typeof fakeWorld>[0] = {}) {
  const w = fakeWorld(options);
  Object.assign(w.world.d1.federations[0], RECORD);
  w.world.b2.buckets.set("acme-iiif-tiles", {
    bucketId: "bucket-tiles",
    bucketName: "acme-iiif-tiles",
    bucketType: "allPublic",
    corsRules: B2_CORS_RULES,
  });
  w.world.b2.buckets.set("acme-masters", {
    bucketId: "bucket-masters",
    bucketName: "acme-masters",
    bucketType: "allPrivate",
    corsRules: [],
  });
  for (const suffix of ["DELIVERY_READ_KEY_ID", "DELIVERY_READ_SECRET_KEY", "MANIFEST_WRITE_KEY_ID", "MANIFEST_WRITE_SECRET_KEY"]) {
    w.world.worker.set(`FEDERATION_ACME_${suffix}`, "fisqua-held");
  }
  tagBuckets(w.world, "production");
  return w;
}

/**
 * Tags every bucket in the fake account for one environment, as the
 * federation and working-bucket commands would have: the role from the
 * bucket's name, the federation `acme`. The tenant step issues a key only
 * over a bucket whose tag it confirms.
 */
function tagBuckets(world: ReturnType<typeof fakeWorld>["world"], env: "production" | "staging", retag = false) {
  for (const [name, bucket] of world.b2.buckets) {
    if (bucket.bucketInfo && !retag) continue;
    if (name === FAKE_WORKING_BUCKET) {
      bucket.bucketInfo = { "fisqua-role": "working", "fisqua-env": env };
      continue;
    }
    const role = name.includes("review") ? "review-tiles" : name.includes("tiles") ? "tiles" : "masters";
    bucket.bucketInfo = { "fisqua-role": role, "fisqua-env": env, "fisqua-federation": "acme" };
  }
}

const limits = (world: ReturnType<typeof fakeWorld>["world"]) =>
  world.b2.keys.map((k) => [k.name, k.bucketId, k.capabilities.includes("writeFiles"), k.namePrefix ?? null]);

describe("tenant storage names", () => {
  it("names the Environment, the prefixes and the runner's keys from the tenant", () => {
    expect(tenantStorageNames("sbmal", FAKE_TENANT_ID, "production")).toEqual({
      environment: ENV,
      slugPrefix: "sbmal/",
      workingPrefix: `${FAKE_TENANT_ID}/`,
      keys: {
        runnerWrite: "fisqua-sbmal-tiles-runner-write",
        runnerRead: "fisqua-sbmal-tiles-runner-read",
        mastersRead: "fisqua-sbmal-masters-runner-read",
        workingWrite: "fisqua-sbmal-working-runner-write",
        workingRead: "fisqua-sbmal-working-runner-read",
        reviewWrite: "fisqua-sbmal-review-tiles-runner-write",
        reviewDelete: "fisqua-sbmal-review-tiles-runner-delete",
      },
    });
    const staging = tenantStorageNames("sbmal", FAKE_TENANT_ID, "staging");
    expect(staging.environment).toBe(`fisqua-pipeline-staging-${FAKE_TENANT_ID}`);
    expect(Object.values(staging.keys).every((k) => k.startsWith("fisqua-sbmal-staging-"))).toBe(true);
    expect(() => tenantStorageNames("SBMAL", FAKE_TENANT_ID, "production")).toThrow();
  });
});

describe("B2 CORS comparison", () => {
  const bucket = (corsRules: unknown[]) => ({
    bucketId: "b-t", bucketName: "acme-iiif-tiles", bucketType: "allPublic", corsRules,
  });
  const run = async (corsRules: unknown[], wanted: unknown[], apply = false) => {
    const { world, providers } = fakeWorld();
    world.b2.buckets.set("acme-iiif-tiles", bucket(corsRules));
    const out = capture();
    await ensureB2Bucket(providers.b2!, "acme-iiif-tiles", "allPublic", wanted, "public", apply, out.log);
    return { world, text: out.text() };
  };

  it("reports no change when the rules B2 returns, reordered and with null lists, match", async () => {
    const { world, text } = await run([...B2_CORS_RULES], B2_CORS_RULES, true);
    expect(text).toContain("[exists] B2 bucket acme-iiif-tiles");
    expect(world.calls).not.toContain("b2.updateBucket");
  });

  it("reports a change when a rule differs in an origin, an operation or the max age", async () => {
    const [rule] = B2_CORS_RULES;
    for (const other of [
      { ...rule, allowedOrigins: ["https://example.test"] },
      { ...rule, allowedOperations: ["s3_get"] },
      { ...rule, maxAgeSeconds: 60 },
    ]) {
      const { text } = await run([other], B2_CORS_RULES);
      expect(text).toContain("CORS rules would be set");
    }
    expect((await run([], B2_CORS_RULES)).text).toContain("CORS rules would be set");
  });

  it("reports a change for reordered rules, an added rule, or a changed header list or name", async () => {
    const [rule] = B2_CORS_RULES;
    const a = { ...rule, corsRuleName: "a", allowedOrigins: ["https://a.test"] };
    const b = { ...rule, corsRuleName: "b" };
    expect((await run([b, a], [a, b])).text).toContain("CORS rules would be set");
    expect((await run([a, b], [a, b])).text).toContain("[exists]");
    expect((await run([a], [a, b])).text).toContain("CORS rules would be set");
    expect((await run([a, b], [a])).text).toContain("CORS rules would be set");
    expect((await run([{ ...rule, allowedHeaders: ["x-one"] }], B2_CORS_RULES)).text).toContain("would be set");
    expect((await run([{ ...rule, corsRuleName: "other" }], B2_CORS_RULES)).text).toContain("would be set");
  });

  it("apply mode updates the bucket when the rules differ", async () => {
    const [rule] = B2_CORS_RULES;
    const { world, text } = await run([{ ...rule, maxAgeSeconds: 60 }], B2_CORS_RULES, true);
    expect(text).toContain("CORS rules set");
    expect(world.calls).toContain("b2.updateBucket");
    expect(world.b2.buckets.get("acme-iiif-tiles")!.corsRules).toEqual(B2_CORS_RULES);
  });

  it("treats lists in another order as the same rule", async () => {
    const [rule] = B2_CORS_RULES;
    const { text } = await run([{ ...rule, allowedOperations: [...rule.allowedOperations].reverse() }], B2_CORS_RULES);
    expect(text).toContain("[exists]");
  });
});

describe("the tenant step", () => {
  it("refuses a tenant whose federation has no complete record, or no Worker secrets", async () => {
    const a = fakeWorld();
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: false }, a.providers, () => {}))).toMatch(
      /federation acme has no complete storage record \(unset: pipeline_delivery_endpoint, .*storage_secret_prefix\); run provision-federation-storage first/,
    );
    const b = provisioned();
    b.world.d1.federations[0].pipeline_masters_bucket = null;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: false }, b.providers, () => {}))).toMatch(
      /unset: pipeline_masters_bucket/,
    );
    const c = provisioned();
    c.world.worker.delete("FEDERATION_ACME_MANIFEST_WRITE_KEY_ID");
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: false }, c.providers, () => {}))).toMatch(
      /Worker secrets are not set \(FEDERATION_ACME_MANIFEST_WRITE_KEY_ID\)/,
    );
    const d = provisioned();
    d.world.d1.tenants[0].federation_id = null;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: false }, d.providers, () => {}))).toMatch(
      /has no federation/,
    );
    for (const w of [a, b, c, d]) expect(writeCalls(w.world.calls)).toEqual([]);
  });

  it("refuses the local target and an unknown tenant", async () => {
    const { providers } = provisioned();
    expect(await stopped(provisionTenantStorage({ ...OPTS, target: "local", apply: false }, providers, () => {}))).toMatch(
      /staging or production/,
    );
    expect(await stopped(provisionTenantStorage({ ...OPTS, slug: "nobody", apply: false }, providers, () => {}))).toMatch(
      /No tenant has the slug nobody/,
    );
  });

  it("stops when a federation bucket or the working bucket is not in the account, and creates none", async () => {
    for (const name of ["acme-iiif-tiles", "acme-masters", FAKE_WORKING_BUCKET]) {
      const { world, providers } = provisioned();
      world.b2.buckets.delete(name);
      expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
        new RegExp(`${name} is not in the B2 account`),
      );
      expect(world.calls.filter((c) => c.startsWith("b2.createBucket"))).toEqual([]);
      expect(world.b2.keys).toEqual([]);
    }
  });

  it("dry run: reads, writes nothing, and prints the keys and variables it would set", async () => {
    const { world, providers } = provisioned();
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, out.log);
    expect(writeCalls(world.calls)).toEqual([]);
    expect(out.text()).toContain(`would create runner Environment ${ENV}`);
    expect(out.text()).toContain(
      "would issue fisqua-sbmal-tiles-runner-write: B2 key, write, limited to acme-iiif-tiles/sbmal/ (runner)",
    );
    expect(out.text()).toContain(
      "would issue fisqua-sbmal-masters-runner-read: B2 key, read, limited to acme-masters/sbmal/ (runner)",
    );
    expect(out.text()).toContain(
      `would issue fisqua-sbmal-working-runner-write: B2 key, write, limited to ${FAKE_WORKING_BUCKET}/${FAKE_TENANT_ID}/ (runner)`,
    );
    expect(out.text()).toContain(`would add ${ENV} to PIPELINE_ENVIRONMENTS`);
    expect(out.text()).toContain(`would add ${new URL(FAKE_B2_S3).hostname} to PIPELINE_STORAGE_HOSTS`);
  });

  it("apply: issues the runner's five keys under the tenant's prefixes, and a second run changes nothing", async () => {
    const { world, providers } = provisioned();
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, out.log);
    expect(limits(world)).toEqual([
      ["fisqua-sbmal-tiles-runner-write", "bucket-tiles", true, "sbmal/"],
      ["fisqua-sbmal-tiles-runner-read", "bucket-tiles", false, "sbmal/"],
      ["fisqua-sbmal-masters-runner-read", "bucket-masters", false, "sbmal/"],
      ["fisqua-sbmal-working-runner-write", FAKE_WORKING_BUCKET_ID, true, `${FAKE_TENANT_ID}/`],
      ["fisqua-sbmal-working-runner-read", FAKE_WORKING_BUCKET_ID, false, `${FAKE_TENANT_ID}/`],
    ]);
    expect([...world.gh.environments]).toEqual([ENV]);
    const envSecrets = world.gh.secrets.get(ENV)!;
    expect([...envSecrets.keys()].sort()).toEqual(RUNNER_SECRET_NAMES);
    // Each role holds its own key: no two id secrets share a value.
    const ids = ["DELIVERY_WRITE_KEY_ID", "DELIVERY_READ_KEY_ID", "SOURCE_READ_KEY_ID", "WORKING_WRITE_KEY_ID", "WORKING_READ_KEY_ID"]
      .map((n) => envSecrets.get(n));
    expect(new Set(ids).size).toBe(5);
    expect(world.gh.variables.get("PIPELINE_ENVIRONMENTS")).toBe(`fisqua-pipeline-existing,${ENV}`);
    expect(world.gh.variables.get("PIPELINE_STORAGE_HOSTS")).toBe(
      `s3.us-west-999.backblazeb2.com,${new URL(FAKE_B2_S3).hostname}`,
    );
    // Nothing for Fisqua, no bucket, no record.
    expect(world.cf.tokens).toEqual([]);
    expect(world.calls.filter((c) => /^(b2\.createBucket|cf\.|worker\.put|d1\.writeDestination)/.test(c))).toEqual([]);
    expect(world.d1.writes).toBe(0);
    for (const value of world.issued) expect(out.text()).not.toContain(value);

    const callsBefore = world.calls.length;
    const again = capture();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    expect(again.text()).not.toContain("[create]");
    expect(again.text()).not.toContain("[reissue]");
  });

  it("on staging, names the keys and the Environment for staging", async () => {
    const { world, providers } = provisioned();
    tagBuckets(world, "staging", true);
    world.gh.variables.set("PIPELINE_ENVIRONMENTS", ENV);
    await provisionTenantStorage({ ...OPTS, target: "staging", apply: true }, providers, () => {});
    const staging = `fisqua-pipeline-staging-${FAKE_TENANT_ID}`;
    expect(world.b2.keys.every((k) => k.name.startsWith("fisqua-sbmal-staging-"))).toBe(true);
    expect([...world.gh.environments]).toEqual([staging]);
    expect(world.gh.variables.get("PIPELINE_ENVIRONMENTS")).toBe(`${ENV},${staging}`);
  });

  it("gives two tenants of one federation keys on the same buckets, each under its own prefix", async () => {
    const { world, providers } = provisioned();
    const otherId = "22222222-bbbb-4bbb-8bbb-222222222222";
    world.d1.tenants.push({ id: otherId, slug: "komuni", federation_id: world.d1.federations[0].id });
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    await provisionTenantStorage({ ...OPTS, slug: "komuni", apply: true }, providers, () => {});
    const tiles = world.b2.keys.filter((k) => k.bucketId === "bucket-tiles");
    expect(tiles.map((k) => [k.name, k.namePrefix])).toEqual([
      ["fisqua-sbmal-tiles-runner-write", "sbmal/"],
      ["fisqua-sbmal-tiles-runner-read", "sbmal/"],
      ["fisqua-komuni-tiles-runner-write", "komuni/"],
      ["fisqua-komuni-tiles-runner-read", "komuni/"],
    ]);
    expect([...world.gh.environments].sort()).toEqual([ENV, `fisqua-pipeline-${otherId}`].sort());
  });

  it("issues a held key again when no key of its name fits the federation's bucket and the tenant's prefix", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    // The federation's tiles bucket changes.
    world.b2.buckets.set("acme-moved-tiles", { bucketId: "bucket-moved", bucketName: "acme-moved-tiles", bucketType: "allPublic", corsRules: B2_CORS_RULES });
    tagBuckets(world, "production");
    world.d1.federations[0].pipeline_tiles_bucket = "acme-moved-tiles";
    const before = new Map(world.gh.secrets.get(ENV)!);

    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-sbmal-tiles-runner-write again: B2 key, write, limited to acme-moved-tiles/sbmal/ (runner), " +
        "and replace the secrets that hold it, because no key named fisqua-sbmal-tiles-runner-write in the B2 account is " +
        "limited to acme-moved-tiles/sbmal/; the older key fisqua-sbmal-tiles-runner-write is left in place, " +
        "to be deleted by hand once the new one is in use",
    );
    expect(dry.text()).toContain("[reissue] would issue fisqua-sbmal-tiles-runner-read again");
    expect(dry.text()).toContain("[exists] fisqua-sbmal-masters-runner-read");

    world.d1.openRuns = 1;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /The tenant has 1 open run\(s\); its runner keys cannot be issued again/,
    );
    expect(world.d1.pendingScopes.at(-1)).toEqual({ tenantId: FAKE_TENANT_ID });
    world.d1.openRuns = 0;

    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const env = world.gh.secrets.get(ENV)!;
    expect(env.get("DELIVERY_WRITE_KEY_ID")).not.toBe(before.get("DELIVERY_WRITE_KEY_ID"));
    expect(env.get("SOURCE_READ_KEY_ID")).toBe(before.get("SOURCE_READ_KEY_ID"));
    expect(world.b2.keys.filter((k) => k.bucketId === "bucket-moved").map((k) => [k.name, k.namePrefix])).toEqual([
      ["fisqua-sbmal-tiles-runner-write", "sbmal/"],
      ["fisqua-sbmal-tiles-runner-read", "sbmal/"],
    ]);
    expect(world.calls.filter((c) => /delete/i.test(c))).toEqual([]);
  });

  it("issues a held key again when it is not limited to the tenant's prefix", async () => {
    const { world, providers } = provisioned();
    world.gh.environments.add(ENV);
    world.gh.secrets.set(ENV, new Map(["SOURCE_READ_KEY_ID", "SOURCE_READ_KEY"].map((n) => [n, "held"])));
    // A masters key on the right bucket, but for the whole bucket.
    world.b2.keys.push({ name: "fisqua-sbmal-masters-runner-read", bucketId: "bucket-masters", capabilities: ["readFiles"] });
    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[reissue] would issue fisqua-sbmal-masters-runner-read again");
  });

  it("stops when keys of one name are limited differently, as after a change back to an earlier bucket", async () => {
    const { world, providers } = provisioned();
    world.b2.buckets.set("acme-moved-tiles", { bucketId: "bucket-moved", bucketName: "acme-moved-tiles", bucketType: "allPublic", corsRules: B2_CORS_RULES });
    tagBuckets(world, "production");
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    // The tiles bucket changes and the runner's tiles keys are issued again;
    // the old keys stay in the account.
    world.d1.federations[0].pipeline_tiles_bucket = "acme-moved-tiles";
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const heldAfterMove = new Map(world.gh.secrets.get(ENV)!);
    // Then it changes back: the secrets hold the keys limited to the moved
    // bucket, while keys limited to the first bucket also exist.
    world.d1.federations[0].pipeline_tiles_bucket = "acme-iiif-tiles";
    const keysBefore = world.b2.keys.length;
    for (const apply of [false, true]) {
      const callsBefore = world.calls.length;
      const message = await stopped(provisionTenantStorage({ ...OPTS, apply }, providers, () => {}));
      expect(message).toContain("cannot tell which one the secrets hold");
      expect(message).toContain(
        "fisqua-sbmal-tiles-runner-write: key FAKELISTEDKEY0 (bucket bucket-tiles, prefix sbmal/, " +
          "capabilities listBuckets,listFiles,readFiles,writeFiles); " +
          "key FAKELISTEDKEY5 (bucket bucket-moved, prefix sbmal/, capabilities listBuckets,listFiles,readFiles,writeFiles)",
      );
      expect(message).toContain("fisqua-sbmal-tiles-runner-read: key FAKELISTEDKEY1");
      expect(message).not.toContain("fisqua-sbmal-masters-runner-read");
      expect(message).toContain("Delete the stale key(s) by hand");
      for (const value of world.issued) expect(message).not.toContain(value);
      expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    }
    expect(world.b2.keys).toHaveLength(keysBefore);
    expect(world.gh.secrets.get(ENV)).toEqual(heldAfterMove);

    // Once the stale keys (the first bucket's, not in use) are deleted, the
    // keys held are limited to the wrong bucket and are issued again.
    world.b2.keys = world.b2.keys.filter((k) => !(k.bucketId === "bucket-tiles" && k.name.includes("-tiles-runner-")));
    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain("[reissue] would issue fisqua-sbmal-tiles-runner-write again");
    expect(dry.text()).toContain("[reissue] would issue fisqua-sbmal-tiles-runner-read again");
    expect(dry.text()).toContain("[exists] fisqua-sbmal-masters-runner-read");
  });

  it("treats keys of one name all limited alike as one key", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    // A duplicate with the same limit, as a run that failed part way leaves.
    world.b2.keys.push({ name: "fisqua-sbmal-tiles-runner-read", bucketId: "bucket-tiles", capabilities: ["readFiles", "listFiles", "listBuckets"], namePrefix: "sbmal/" });
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, out.log);
    expect(out.text()).toContain("[exists] fisqua-sbmal-tiles-runner-read");
    expect(out.text()).not.toContain("[reissue]");
  });

  it("issues only the keys missing from an Environment that holds some of them", async () => {
    const { world, providers } = provisioned();
    world.gh.environments.add(ENV);
    world.gh.secrets.set(ENV, new Map(["SOURCE_READ_KEY_ID", "SOURCE_READ_KEY"].map((n) => [n, "kept"])));
    world.b2.keys.push({ name: "fisqua-sbmal-masters-runner-read", bucketId: "bucket-masters", capabilities: ["listBuckets", "listFiles", "readFiles"], namePrefix: "sbmal/" });
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.calls).not.toContain("gh.createEnvironment");
    expect(world.calls).not.toContain("b2.createKey:fisqua-sbmal-masters-runner-read");
    expect(world.gh.secrets.get(ENV)!.get("SOURCE_READ_KEY_ID")).toBe("kept");
    expect(world.gh.secrets.get(ENV)!.size).toBe(10);
  });

  it("finishes a run that failed part way without issuing a held key again", async () => {
    let fail = true;
    const { world, providers } = provisioned({ failOn: (c) => fail && c === "gh.setEnvironmentSecret:SOURCE_READ_KEY" });
    await expect(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {})).rejects.toThrow(/fake failure/);
    fail = false;
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.calls.filter((c) => c.startsWith("b2.createKey:"))).toEqual([
      "b2.createKey:fisqua-sbmal-tiles-runner-write",
      "b2.createKey:fisqua-sbmal-tiles-runner-read",
      "b2.createKey:fisqua-sbmal-masters-runner-read",
      // Its secrets were not both set, so it is issued again.
      "b2.createKey:fisqua-sbmal-masters-runner-read",
      "b2.createKey:fisqua-sbmal-working-runner-write",
      "b2.createKey:fisqua-sbmal-working-runner-read",
    ]);
  });

  it("prints steps as unchecked without credentials, and refuses to apply without them", async () => {
    const { providers } = provisioned();
    const bare = { ...providers, b2: null, github: null };
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, bare, out.log);
    expect(out.text()).toContain("[unchecked] B2 buckets acme-iiif-tiles, acme-masters");
    expect(out.text()).toContain("[unchecked] PIPELINE_ENVIRONMENTS and PIPELINE_STORAGE_HOSTS");
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, bare, () => {}))).toMatch(/credentials for: B2, GitHub/);
  });
});

describe("tenant arguments", () => {
  it("needs --confirm-production to apply against production, and is a dry run by default", () => {
    expect(() => parseArgs(["--tenant", "sbmal", "--target", "production", "--apply"])).toThrow(/confirm-production/);
    expect(parseArgs(["--tenant", "sbmal", "--target", "production", "--apply", "--confirm-production"]).apply).toBe(true);
    expect(parseArgs(["--tenant", "sbmal", "--target", "production"]).apply).toBe(false);
  });

  it("refuses --adopt, --domain and the local target, and takes the target's working bucket unless one is named", () => {
    expect(() => parseArgs(["--tenant", "sbmal", "--target", "staging", "--adopt"])).toThrow(/provision-federation-storage/);
    expect(() => parseArgs(["--tenant", "sbmal", "--target", "staging", "--domain", "x.example.test"])).toThrow(
      /provision-federation-storage/,
    );
    expect(() => parseArgs(["--tenant", "sbmal", "--target", "local"])).toThrow(/staging or production/);
    expect(parseArgs(["--tenant", "sbmal", "--target", "staging"]).workingBucket).toBe("fisqua-pipeline-working-staging");
    expect(parseArgs(["--tenant", "sbmal", "--target", "production"]).workingBucket).toBe("fisqua-pipeline-working");
    expect(parseArgs(["--tenant", "sbmal", "--target", "staging", "--working-bucket", "w-bucket"]).workingBucket).toBe("w-bucket");
  });

  it("runs the step and ends a dry run by saying nothing was written", async () => {
    const { world, providers } = provisioned();
    tagBuckets(world, "staging", true);
    const out = capture();
    await runTenantCommand(parseArgs(["--tenant", "sbmal", "--target", "staging", "--working-bucket", FAKE_WORKING_BUCKET]), providers, out.log);
    expect(out.lines.at(-1)).toContain("Dry run: nothing was written");
  });
});

describe("HTTP clients", () => {
  function recorder(reply: (url: string, init: RequestInit) => Response) {
    const seen: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      return reply(url, init);
    }) as typeof fetch;
    return { seen, fetchImpl };
  }
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("B2: sends bucket info on create and update only when given, and leaves out what is not", async () => {
    const { seen, fetchImpl } = recorder((url, init) => {
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      const body = JSON.parse(String(init.body));
      return ok({ bucketId: "b-new", bucketName: body.bucketName, bucketType: body.bucketType, corsRules: body.corsRules });
    });
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    const info = { "fisqua-role": "masters", "fisqua-env": "production", "fisqua-federation": "acme" };
    await b2.createBucket("tagged", "allPrivate", [], info);
    await b2.updateBucket("b-1", "allPrivate", undefined, { owner: "lab", ...info });
    await b2.updateBucket("b-1", "allPrivate", []);
    const creates = seen.filter((r) => r.url.endsWith("b2_create_bucket"));
    const updates = seen.filter((r) => r.url.endsWith("b2_update_bucket"));
    expect(creates[0].body).toEqual({ accountId: "acct", bucketName: "tagged", bucketType: "allPrivate", corsRules: [], bucketInfo: info });
    expect(updates[0].body).toEqual({ accountId: "acct", bucketId: "b-1", bucketType: "allPrivate", bucketInfo: { owner: "lab", ...info } });
    expect(updates[1].body).toEqual({ accountId: "acct", bucketId: "b-1", bucketType: "allPrivate", corsRules: [] });
  });

  it("B2: sends ifRevisionIs on an update and reports B2's conflict as a changed revision", async () => {
    const { seen, fetchImpl } = recorder((url) => {
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      return new Response(JSON.stringify({ status: 409, code: "conflict", message: "revision mismatch" }), { status: 409 });
    });
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    await expect(b2.updateBucket("b-1", "allPrivate", undefined, { a: "b" }, 7)).rejects.toBeInstanceOf(BucketRevisionConflictError);
    expect(seen.find((r) => r.url.endsWith("b2_update_bucket"))!.body).toEqual({
      accountId: "acct", bucketId: "b-1", bucketType: "allPrivate", bucketInfo: { a: "b" }, ifRevisionIs: 7,
    });
  });

  it("B2: asks for one file version to tell whether a bucket holds anything", async () => {
    let files: unknown[] = [];
    const { seen, fetchImpl } = recorder((url) => {
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      return ok({ files, nextFileName: null });
    });
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.hasFileVersions("bucket-1")).toBe(false);
    files = [{ fileName: "a", action: "hide" }];
    expect(await b2.hasFileVersions("bucket-1")).toBe(true);
    const asked = seen.filter((r) => r.url.endsWith("b2_list_file_versions"));
    expect(asked).toHaveLength(2);
    expect(asked[0].body).toEqual({ bucketId: "bucket-1", maxFileCount: 1 });
  });

  it("B2: authorizes once, issues keys limited to one bucket and a name prefix, and reports a taken name", async () => {
    const { seen, fetchImpl } = recorder((url, init) => {
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      if (url.endsWith("b2_create_key")) return ok({ applicationKeyId: "kid", applicationKey: "ksecret" });
      if (url.endsWith("b2_create_bucket")) {
        const body = JSON.parse(String(init.body));
        if (body.bucketName === "taken") return new Response(JSON.stringify({ code: "duplicate_bucket_name" }), { status: 400 });
        return ok({ bucketId: "b-new", bucketName: body.bucketName, bucketType: body.bucketType, corsRules: body.corsRules });
      }
      return ok({});
    });
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.createKey("k", ["readFiles"], "bucket-1")).toEqual({ keyId: "kid", secret: "ksecret" });
    await b2.createKey("w", ["readFiles", "writeFiles"], "bucket-2", "tenant-1/");
    await expect(b2.createBucket("taken", "allPublic", B2_CORS_RULES)).rejects.toBeInstanceOf(BucketNameTakenError);
    await b2.createBucket("private-one", "allPrivate", []);
    expect(seen.filter((r) => r.url.endsWith("b2_authorize_account"))).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe(`Basic ${Buffer.from("operator-key-id:operator-key").toString("base64")}`);
    const keys = seen.filter((r) => r.url.endsWith("b2_create_key"));
    expect(keys[0].url).toBe("https://api000.example.test/b2api/v2/b2_create_key");
    expect(keys[0].headers.authorization).toBe("tok");
    expect(keys[0].body).toEqual({ accountId: "acct", keyName: "k", capabilities: ["readFiles"], bucketId: "bucket-1" });
    expect(keys[1].body).toEqual({
      accountId: "acct",
      keyName: "w",
      capabilities: ["readFiles", "writeFiles"],
      bucketId: "bucket-2",
      namePrefix: "tenant-1/",
    });
    const buckets = seen.filter((r) => r.url.endsWith("b2_create_bucket"));
    expect(buckets[0].body).toMatchObject({ bucketName: "taken", bucketType: "allPublic", corsRules: B2_CORS_RULES });
    expect(buckets[1].body).toMatchObject({ bucketName: "private-one", bucketType: "allPrivate", corsRules: [] });
    // No lifecycle rule is sent, so a bucket is created without one.
    expect(buckets[1].body).not.toHaveProperty("lifecycleRules");
  });

  it("B2: reads every key's id, name, bucket, name prefix and capabilities back, page by page", async () => {
    const { seen, fetchImpl } = recorder((url, init) => {
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      const body = JSON.parse(String(init.body));
      return body.startApplicationKeyId
        ? ok({ keys: [{ keyName: "b", applicationKeyId: "2", capabilities: [] }], nextApplicationKeyId: null })
        : ok({
            keys: [{ keyName: "a", applicationKeyId: "1", bucketId: "bk", namePrefix: "sbmal/", capabilities: ["listFiles", "writeFiles"] }],
            nextApplicationKeyId: "2",
          });
    });
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.keys()).toEqual([
      { keyId: "1", keyName: "a", bucketId: "bk", namePrefix: "sbmal/", capabilities: ["listFiles", "writeFiles"] },
      { keyId: "2", keyName: "b", bucketId: null, namePrefix: null, capabilities: [] },
    ]);
    expect(await b2.keyNames()).toEqual(["a", "b"]);
    expect(seen.filter((r) => r.url.endsWith("b2_list_keys"))).toHaveLength(4);
  });

  it("B2: lists the current files under a prefix, names and sizes, page by page", async () => {
    const { seen, fetchImpl } = recorder((url, init) => {
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      const body = JSON.parse(String(init.body));
      return body.startFileName
        ? ok({ files: [{ fileName: "sbmal/v/b.jpg", contentLength: 7, action: "upload" }], nextFileName: null })
        : ok({
            files: [
              { fileName: "sbmal/v/a.jpg", contentLength: 5, action: "upload" },
              { fileName: "sbmal/v/sub/", contentLength: 0, action: "folder" },
            ],
            nextFileName: "sbmal/v/b.jpg",
          });
    });
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.listFiles("bucket-m", "sbmal/v/")).toEqual([
      { fileName: "sbmal/v/a.jpg", contentLength: 5 },
      { fileName: "sbmal/v/b.jpg", contentLength: 7 },
    ]);
    const calls = seen.filter((r) => r.url.endsWith("b2_list_file_names"));
    expect(calls.map((c) => c.body)).toEqual([
      { bucketId: "bucket-m", prefix: "sbmal/v/", maxFileCount: 1000 },
      { bucketId: "bucket-m", prefix: "sbmal/v/", maxFileCount: 1000, startFileName: "sbmal/v/b.jpg" },
    ]);
  });

  it("Cloudflare: an R2 token limited to one bucket, its S3 secret the SHA-256 of its value", async () => {
    const { seen, fetchImpl } = recorder((url, init) => {
      if (url.endsWith("/tokens/permission_groups")) {
        return ok({ result: [{ id: "pg-other", name: "Other" }, { id: "pg-write", name: "Workers R2 Storage Bucket Item Write" }] });
      }
      if (url.endsWith("/tokens") && init.method === "POST") return ok({ result: { id: "token-id", value: "token-value" } });
      return ok({ result: [] });
    });
    const cf = cloudflareClient("operator-token", "acct123", fetchImpl);
    expect(cf.s3Endpoint).toBe("https://acct123.r2.cloudflarestorage.com");
    const key = await cf.createR2WriteToken("fisqua-acme-manifests-write", "acme-manifests");
    expect(key).toEqual({ keyId: "token-id", secret: createHash("sha256").update("token-value").digest("hex") });
    const post = seen.find((r) => r.method === "POST")!;
    expect(post.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/tokens");
    expect(post.body.policies).toEqual([
      {
        effect: "allow",
        resources: { "com.cloudflare.edge.r2.bucket.acct123_default_acme-manifests": "*" },
        permission_groups: [{ id: "pg-write" }],
      },
    ]);
    expect(post.headers.authorization).toBe("Bearer operator-token");
  });

  it("GitHub: creates or updates a variable, and passes a secret to gh on stdin", async () => {
    const vars = new Map<string, string>([["PIPELINE_ENVIRONMENTS", "a"]]);
    const { seen, fetchImpl } = recorder((url, init) => {
      const name = url.split("/actions/variables/")[1];
      if (init.method === "GET" && name) {
        return vars.has(name) ? ok({ name, value: vars.get(name) }) : new Response("", { status: 404 });
      }
      return new Response(null, { status: 204 });
    });
    const runs: Array<{ command: string; args: string[]; input?: string; env?: Record<string, string> }> = [];
    const gh = githubClient("gh-token", "owner/runner", fetchImpl, (command, args, o) => {
      runs.push({ command, args, ...o });
      return "";
    });
    await gh.setVariable("PIPELINE_ENVIRONMENTS", "a,b");
    await gh.setVariable("PIPELINE_STORAGE_HOSTS", "h");
    expect(seen.filter((r) => r.method !== "GET").map((r) => [r.method, r.url.replace("https://api.github.com/repos/owner/runner", "")])).toEqual([
      ["PATCH", "/actions/variables/PIPELINE_ENVIRONMENTS"],
      ["POST", "/actions/variables"],
    ]);
    await gh.setEnvironmentSecret("fisqua-pipeline-x", "DELIVERY_READ_KEY", "the-secret");
    expect(runs).toEqual([
      {
        command: "gh",
        args: ["secret", "set", "DELIVERY_READ_KEY", "--env", "fisqua-pipeline-x", "--repo", "owner/runner"],
        input: "the-secret",
        env: { GH_TOKEN: "gh-token" },
      },
    ]);
  });

  it("D1: pending work counts open runs and prepared or ready volumes, scoped to the tenant", () => {
    expect(pendingWorkStatement({ tenantId: "id'1" }, 42)).toBe(
      "SELECT (SELECT COUNT(*) FROM pipeline_runs WHERE tenant_id = 'id''1' " +
        "AND token_revoked_at IS NULL AND token_expires_at > 42) AS open_runs, " +
        "(SELECT COUNT(*) FROM pipeline_volumes WHERE tenant_id = 'id''1' " +
        "AND state IN ('prepared', 'ready')) AS unpublished_volumes",
    );
  });
});

describe("the runner's review-tiles keys", () => {
  const REVIEW_SECRET_NAMES = ["REVIEW_DELETE_KEY", "REVIEW_DELETE_KEY_ID", "REVIEW_WRITE_KEY", "REVIEW_WRITE_KEY_ID"];

  /** A provisioned world whose federation also records a review-tiles bucket. */
  function withReview(options: Parameters<typeof fakeWorld>[0] = {}) {
    const w = provisioned(options);
    w.world.d1.federations[0].pipeline_review_tiles_bucket = "acme-review-tiles";
    w.world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review",
      bucketName: "acme-review-tiles",
      bucketType: "allPrivate",
      corsRules: [],
    });
    tagBuckets(w.world, "production");
    return w;
  }

  it("are named for the review run and the processing run's purge", () => {
    expect(RUNNER_SECRETS).toMatchObject({
      reviewWriteKeyId: "REVIEW_WRITE_KEY_ID",
      reviewWriteKey: "REVIEW_WRITE_KEY",
      reviewDeleteKeyId: "REVIEW_DELETE_KEY_ID",
      reviewDeleteKey: "REVIEW_DELETE_KEY",
    });
    const staging = tenantStorageNames("sbmal", FAKE_TENANT_ID, "staging").keys;
    expect([staging.reviewWrite, staging.reviewDelete]).toEqual([
      "fisqua-sbmal-staging-review-tiles-runner-write",
      "fisqua-sbmal-staging-review-tiles-runner-delete",
    ]);
  });

  it("are not issued when the federation records no review-tiles bucket", async () => {
    const { world, providers } = provisioned();
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, out.log);
    expect(world.b2.keys.some((k) => k.name.includes("review-tiles"))).toBe(false);
    expect([...world.gh.secrets.get(ENV)!.keys()].sort()).toEqual(RUNNER_SECRET_NAMES);
    expect(out.text()).toContain("review tiles (B2, federation's): (none recorded)");
    expect(out.text()).toContain(
      "[note] the federation records no review-tiles bucket, so fisqua-sbmal-review-tiles-runner-write and " +
        "fisqua-sbmal-review-tiles-runner-delete are not issued and its volumes skip the review run",
    );
  });

  it("dry run: prints the two keys limited to the bucket and the tenant's prefix", async () => {
    const { world, providers } = withReview();
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, out.log);
    expect(writeCalls(world.calls)).toEqual([]);
    expect(out.text()).toContain("review tiles (B2, federation's): acme-review-tiles/sbmal/");
    expect(out.text()).toContain("[exists] B2 review-tiles bucket acme-review-tiles");
    expect(out.text()).toContain(
      "would issue fisqua-sbmal-review-tiles-runner-write: B2 key, write, limited to acme-review-tiles/sbmal/ (runner)",
    );
    expect(out.text()).toContain(
      "would issue fisqua-sbmal-review-tiles-runner-delete: B2 key, delete, limited to acme-review-tiles/sbmal/ (runner)",
    );
  });

  it("apply: issues the write and delete keys with their own capabilities, scoped to the bucket and the slug", async () => {
    const { world, providers } = withReview();
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, out.log);
    const review = world.b2.keys.filter((k) => k.bucketId === "bucket-review");
    expect(review.map((k) => [k.name, k.namePrefix, k.capabilities])).toEqual([
      ["fisqua-sbmal-review-tiles-runner-write", "sbmal/", ["listBuckets", "listFiles", "readFiles", "writeFiles"]],
      ["fisqua-sbmal-review-tiles-runner-delete", "sbmal/", ["listBuckets", "readBuckets", "listFiles", "deleteFiles"]],
    ]);
    // No other runner key reaches the review bucket, and neither review key can delete and write at once.
    expect(world.b2.keys.filter((k) => k.bucketId === "bucket-review")).toHaveLength(2);
    const envSecrets = world.gh.secrets.get(ENV)!;
    expect([...envSecrets.keys()].sort()).toEqual([...RUNNER_SECRET_NAMES, ...REVIEW_SECRET_NAMES].sort());
    const ids = Object.values(RUNNER_SECRETS)
      .filter((n) => n.endsWith("_KEY_ID"))
      .map((n) => envSecrets.get(n));
    expect(new Set(ids).size).toBe(7);
    for (const value of world.issued) expect(out.text()).not.toContain(value);

    const before = world.calls.length;
    const again = capture();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, again.log);
    expect(writeCalls(world.calls.slice(before))).toEqual([]);
    expect(again.text()).toContain("[exists] fisqua-sbmal-review-tiles-runner-write");
    expect(again.text()).toContain("[exists] fisqua-sbmal-review-tiles-runner-delete");
  });

  it("a tenant holding the five earlier keys is given only the two new ones, even with work open", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const keysBefore = world.b2.keys.map((k) => ({ ...k }));
    const secretsBefore = new Map(world.gh.secrets.get(ENV)!);
    // The federation gains its review-tiles bucket.
    world.d1.federations[0].pipeline_review_tiles_bucket = "acme-review-tiles";
    world.b2.buckets.set("acme-review-tiles", { bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
    tagBuckets(world, "production");
    world.d1.openRuns = 1;
    world.d1.unpublishedVolumes = 1;

    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text().match(/\[create\]/g)).toHaveLength(2);
    expect(dry.text()).not.toContain("[reissue]");

    const before = world.calls.length;
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.calls.slice(before).filter((c) => c.startsWith("b2.createKey:"))).toEqual([
      "b2.createKey:fisqua-sbmal-review-tiles-runner-write",
      "b2.createKey:fisqua-sbmal-review-tiles-runner-delete",
    ]);
    expect(world.calls.slice(before).filter((c) => c.startsWith("gh.setEnvironmentSecret:")).sort()).toEqual(
      REVIEW_SECRET_NAMES.map((n) => `gh.setEnvironmentSecret:${n}`).sort(),
    );
    expect(world.calls.slice(before)).not.toContain("gh.createEnvironment");
    expect(world.b2.keys.slice(0, keysBefore.length)).toEqual(keysBefore);
    const env = world.gh.secrets.get(ENV)!;
    for (const [name, value] of secretsBefore) expect(env.get(name)).toBe(value);
    expect(env.size).toBe(14);

    const after = world.calls.length;
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(writeCalls(world.calls.slice(after))).toEqual([]);
  });

  it("issues the review keys again when the review-tiles bucket changes, which pending work refuses", async () => {
    const { world, providers } = withReview();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.buckets.set("acme-moved-review", { bucketId: "bucket-moved-review", bucketName: "acme-moved-review", bucketType: "allPrivate", corsRules: [] });
    tagBuckets(world, "production");
    world.d1.federations[0].pipeline_review_tiles_bucket = "acme-moved-review";
    const before = new Map(world.gh.secrets.get(ENV)!);

    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-sbmal-review-tiles-runner-write again: B2 key, write, limited to acme-moved-review/sbmal/ (runner)",
    );
    expect(dry.text()).toContain("[reissue] would issue fisqua-sbmal-review-tiles-runner-delete again");
    expect(dry.text()).toContain("[exists] fisqua-sbmal-tiles-runner-write");

    world.d1.unpublishedVolumes = 1;
    const callsBefore = world.calls.length;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /The tenant has 1 volume\(s\) prepared or ready but not published; its runner keys cannot be issued again/,
    );
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    world.d1.unpublishedVolumes = 0;

    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const env = world.gh.secrets.get(ENV)!;
    expect(env.get("REVIEW_WRITE_KEY_ID")).not.toBe(before.get("REVIEW_WRITE_KEY_ID"));
    expect(env.get("REVIEW_DELETE_KEY_ID")).not.toBe(before.get("REVIEW_DELETE_KEY_ID"));
    expect(env.get("DELIVERY_WRITE_KEY_ID")).toBe(before.get("DELIVERY_WRITE_KEY_ID"));
    expect(world.b2.keys.filter((k) => k.bucketId === "bucket-moved-review").map((k) => [k.name, k.namePrefix])).toEqual([
      ["fisqua-sbmal-review-tiles-runner-write", "sbmal/"],
      ["fisqua-sbmal-review-tiles-runner-delete", "sbmal/"],
    ]);
    // The replaced keys are left in the account, never deleted.
    expect(world.b2.keys.filter((k) => k.bucketId === "bucket-review")).toHaveLength(2);
  });

  it("stops when the recorded review-tiles bucket is not in the account, and creates none", async () => {
    const { world, providers } = withReview();
    world.b2.buckets.delete("acme-review-tiles");
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /review-tiles bucket acme-review-tiles is not in the B2 account; run provision-federation-storage first/,
    );
    expect(world.calls.filter((c) => c.startsWith("b2.createBucket"))).toEqual([]);
    expect(world.b2.keys).toEqual([]);
  });
});

describe("held keys with other capabilities than their role's", () => {
  function withReview() {
    const w = provisioned();
    w.world.d1.federations[0].pipeline_review_tiles_bucket = "acme-review-tiles";
    w.world.b2.buckets.set("acme-review-tiles", { bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
    tagBuckets(w.world, "production");
    return w;
  }

  it("issues a review delete key again when it can also read and write, which pending work refuses", async () => {
    const { world, providers } = withReview();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    // The delete key in the account is scoped right but has more than its role's capabilities.
    const key = world.b2.keys.find((k) => k.name === "fisqua-sbmal-review-tiles-runner-delete")!;
    key.capabilities = ["listBuckets", "readBuckets", "listFiles", "deleteFiles", "readFiles", "writeFiles"];
    const before = new Map(world.gh.secrets.get(ENV)!);

    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-sbmal-review-tiles-runner-delete again: B2 key, delete, limited to acme-review-tiles/sbmal/ (runner), " +
        "and replace the secrets that hold it, because the key named fisqua-sbmal-review-tiles-runner-delete in the B2 account " +
        "has the capabilities deleteFiles,listBuckets,listFiles,readBuckets,readFiles,writeFiles, not deleteFiles,listBuckets,listFiles,readBuckets",
    );
    expect(dry.text()).toContain("[exists] fisqua-sbmal-review-tiles-runner-write");

    world.d1.openRuns = 1;
    const callsBefore = world.calls.length;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /The tenant has 1 open run\(s\); its runner keys cannot be issued again/,
    );
    expect(writeCalls(world.calls.slice(callsBefore))).toEqual([]);
    world.d1.openRuns = 0;

    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const env = world.gh.secrets.get(ENV)!;
    expect(env.get("REVIEW_DELETE_KEY_ID")).not.toBe(before.get("REVIEW_DELETE_KEY_ID"));
    expect(env.get("REVIEW_WRITE_KEY_ID")).toBe(before.get("REVIEW_WRITE_KEY_ID"));
    const deletes = world.b2.keys.filter((k) => k.name === "fisqua-sbmal-review-tiles-runner-delete");
    expect(deletes.at(-1)!.capabilities).toEqual(["listBuckets", "readBuckets", "listFiles", "deleteFiles"]);
  });

  it("checks the earlier keys' capabilities too, and accepts the same capabilities in another order", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys.find((k) => k.name === "fisqua-sbmal-tiles-runner-read")!.capabilities = [
      "listBuckets", "listFiles", "readFiles", "writeFiles",
    ];
    world.b2.keys.find((k) => k.name === "fisqua-sbmal-masters-runner-read")!.capabilities = ["readFiles", "listFiles", "listBuckets"];
    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-sbmal-tiles-runner-read again: B2 key, read, limited to acme-iiif-tiles/sbmal/ (runner)",
    );
    expect(dry.text()).toContain("has the capabilities listBuckets,listFiles,readFiles,writeFiles, not listBuckets,listFiles,readFiles");
    expect(dry.text()).toContain("[exists] fisqua-sbmal-masters-runner-read");
    expect(dry.text()).toContain("[exists] fisqua-sbmal-tiles-runner-write");
  });

  it("stops when keys of one name and limit differ in capabilities, since the secrets cannot be read back", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.keys.push({ name: "fisqua-sbmal-working-runner-read", bucketId: FAKE_WORKING_BUCKET_ID, namePrefix: `${FAKE_TENANT_ID}/`, capabilities: ["listBuckets", "listFiles", "readFiles", "writeFiles"] });
    const message = await stopped(provisionTenantStorage({ ...OPTS, apply: false }, providers, () => {}));
    expect(message).toContain("cannot tell which one the secrets hold");
    expect(message).toContain("fisqua-sbmal-working-runner-read");
  });
});

describe("a working bucket that is another role's bucket", () => {
  function withReview() {
    const w = provisioned();
    Object.assign(w.world.d1.federations[0], { pipeline_review_tiles_bucket: "acme-review-tiles" });
    w.world.b2.buckets.set("acme-review-tiles", { bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
    tagBuckets(w.world, "production");
    // A B2 bucket of the manifest bucket's name, as Codex's repro had.
    w.world.b2.buckets.set("acme-manifests", { bucketId: "bucket-b2-manifests", bucketName: "acme-manifests", bucketType: "allPrivate", corsRules: [] });
    return w;
  }

  it("stops before reading or issuing anything when it is one of the federation's buckets", async () => {
    const cases: Array<[string, string]> = [
      ["acme-masters", "The masters bucket and the shared working bucket would both be acme-masters; each role needs its own bucket"],
      ["acme-iiif-tiles", "The tiles bucket and the shared working bucket would both be acme-iiif-tiles; each role needs its own bucket"],
      ["acme-review-tiles", "The review-tiles bucket and the shared working bucket would both be acme-review-tiles; each role needs its own bucket"],
      ["acme-manifests", "The manifest bucket and the shared working bucket would both be acme-manifests; each role needs its own bucket"],
    ];
    for (const [bucket, message] of cases) {
      for (const apply of [false, true]) {
        const { world, providers } = withReview();
        expect(await stopped(provisionTenantStorage({ ...OPTS, workingBucket: bucket, apply }, providers, () => {})), bucket).toBe(message);
        expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
        expect(world.b2.keys).toEqual([]);
        expect(world.gh.environments.size).toBe(0);
      }
    }
  });

  it("stops when another federation records it in any role", async () => {
    for (const [column, role] of [
      ["pipeline_masters_bucket", "masters bucket"],
      ["pipeline_review_tiles_bucket", "review-tiles bucket"],
    ] as const) {
      for (const apply of [false, true]) {
        const { world, providers } = provisioned();
        world.d1.federations.push({ ...emptyFederation("other", "other"), [column]: FAKE_WORKING_BUCKET });
        expect(await stopped(provisionTenantStorage({ ...OPTS, apply }, providers, () => {}))).toBe(
          `Federation other records ${FAKE_WORKING_BUCKET} as its ${role}; it cannot also be this federation's shared working bucket`,
        );
        expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
        expect(world.b2.keys).toEqual([]);
      }
    }
  });

  it("stops when the federation's record names one bucket in two roles", async () => {
    for (const [column, name, message] of [
      ["pipeline_review_tiles_bucket", "acme-masters", "The masters bucket and the review-tiles bucket would both be acme-masters; each role needs its own bucket"],
      ["pipeline_review_tiles_bucket", "acme-iiif-tiles", "The tiles bucket and the review-tiles bucket would both be acme-iiif-tiles; each role needs its own bucket"],
      ["pipeline_masters_bucket", "acme-iiif-tiles", "The tiles bucket and the masters bucket would both be acme-iiif-tiles; each role needs its own bucket"],
    ] as const) {
      for (const apply of [false, true]) {
        const { world, providers } = provisioned();
        Object.assign(world.d1.federations[0], { [column]: name });
        expect(await stopped(provisionTenantStorage({ ...OPTS, apply }, providers, () => {}))).toBe(message);
        expect(world.calls.filter((c) => !c.startsWith("d1."))).toEqual([]);
        expect(world.b2.keys).toEqual([]);
      }
    }
  });

  it("goes ahead with a working bucket of its own", async () => {
    const { world, providers } = withReview();
    world.d1.federations.push({ ...emptyFederation("other", "other"), pipeline_masters_bucket: "other-masters" });
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.b2.keys.filter((k) => k.bucketId === FAKE_WORKING_BUCKET_ID)).toHaveLength(2);
  });
});

describe("bucket role tags in the tenant step", () => {
  it("stops before any key is issued when a bucket is tagged for another role, environment or federation", async () => {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["acme-masters", { "fisqua-role": "review-tiles", "fisqua-env": "production", "fisqua-federation": "acme" }, /cannot be the masters bucket of federation acme/],
      ["acme-masters", { "fisqua-role": "masters", "fisqua-federation": "bravo" }, /tagged as the masters bucket of federation bravo .*; it cannot be the masters bucket of federation acme/],
      ["acme-iiif-tiles", { "fisqua-role": "tiles", "fisqua-env": "staging", "fisqua-federation": "acme" }, /cannot be the production tiles bucket/],
      [FAKE_WORKING_BUCKET, { "fisqua-role": "working", "fisqua-env": "staging" }, /cannot be the production working bucket/],
    ];
    for (const [name, info, message] of cases) {
      for (const apply of [false, true]) {
        const { world, providers } = provisioned();
        world.b2.buckets.get(name)!.bucketInfo = info;
        expect(await stopped(provisionTenantStorage({ ...OPTS, apply }, providers, () => {}))).toMatch(message);
        expect(world.b2.keys).toEqual([]);
        expect(world.gh.environments.size).toBe(0);
      }
    }
  });

  it("stops at an untagged review-tiles bucket that holds files, and goes ahead when it is tagged or empty", async () => {
    const make = () => {
      const w = provisioned();
      w.world.d1.federations[0].pipeline_review_tiles_bucket = "acme-review-tiles";
      w.world.b2.buckets.set("acme-review-tiles", { bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [] });
      return w;
    };
    const a = make();
    a.world.b2.files.set("bucket-review", [{ fileName: "sbmal/master.cr2", contentLength: 1 }]);
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, a.providers, () => {}))).toMatch(
      /review-tiles bucket acme-review-tiles holds files and is not tagged as the production review-tiles bucket of federation acme/,
    );
    expect(a.world.b2.keys).toEqual([]);

    const b = make();
    b.world.b2.files.set("bucket-review", [{ fileName: "sbmal/d/p/info.json", contentLength: 1 }]);
    b.world.b2.buckets.get("acme-review-tiles")!.bucketInfo = { "fisqua-role": "review-tiles", "fisqua-env": "production", "fisqua-federation": "acme" };
    await provisionTenantStorage({ ...OPTS, apply: true }, b.providers, () => {});
    expect(b.world.b2.keys.filter((k) => k.bucketId === "bucket-review")).toHaveLength(2);

    // An empty untagged one passes the check, but no key is issued over
    // it until the federation step has tagged it.
    const c = make();
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, c.providers, () => {}))).toMatch(
      /No runner key can be issued yet\. The B2 bucket acme-review-tiles is not tagged as the production review-tiles bucket of federation acme \(its tags: none\); run provision-federation-storage first/,
    );
    expect(c.world.b2.keys.filter((k) => k.bucketId === "bucket-review")).toEqual([]);
  });
});

describe("a masters bucket in the tenant step, which both environments share", () => {
  it("issues the runner's keys over a masters bucket with no environment, or tagged for either one", async () => {
    for (const env of [null, "staging", "production"] as const) {
      const { world, providers } = provisioned();
      const info = {
        "fisqua-role": "masters",
        ...(env === null ? {} : { "fisqua-env": env }),
        "fisqua-federation": "acme",
      };
      world.b2.buckets.get("acme-masters")!.bucketInfo = { ...info };
      await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
      const masters = world.b2.buckets.get("acme-masters")!;
      expect(world.b2.keys.filter((k) => k.bucketId === masters.bucketId).length).toBeGreaterThan(0);
      expect(masters.bucketInfo).toEqual(info);
    }
  });
});

describe("the tenant dry run and untagged buckets", () => {
  it("stops the dry run as apply does, naming the step that tags each bucket", async () => {
    for (const apply of [false, true]) {
      const { world, providers } = provisioned();
      world.b2.buckets.get(FAKE_WORKING_BUCKET)!.bucketInfo = undefined;
      world.b2.buckets.get("acme-masters")!.bucketInfo = undefined;
      const message = await stopped(provisionTenantStorage({ ...OPTS, apply }, providers, () => {}));
      expect(message).toContain("No runner key can be issued yet.");
      expect(message).toContain(
        "The B2 bucket acme-masters is not tagged as the masters bucket of federation acme (its tags: none); run provision-federation-storage first",
      );
      expect(message).toContain(
        `The B2 bucket ${FAKE_WORKING_BUCKET} is not tagged as the production working bucket (its tags: none); run provision-working-bucket first`,
      );
      expect(world.b2.keys).toEqual([]);
      expect(world.gh.environments.size).toBe(0);
    }
  });

  it("does not stop for an untagged bucket whose keys are all held", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    world.b2.buckets.get("acme-masters")!.bucketInfo = undefined;
    const out = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, out.log);
    expect(out.text()).toContain("[exists] fisqua-sbmal-masters-runner-read");
  });
});

describe("runner pairs whose secrets were left half written", () => {
  const SCOPE = `tenant:${FAKE_TENANT_ID}`;
  function withReview(options: Parameters<typeof fakeWorld>[0] = {}) {
    const w = provisioned(options);
    w.world.d1.federations[0].pipeline_review_tiles_bucket = "acme-review-tiles";
    w.world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [],
      bucketInfo: { "fisqua-role": "review-tiles", "fisqua-env": "production", "fisqua-federation": "acme" },
    });
    return w;
  }

  it("deletes the new delete key when its second secret fails, and the rerun issues the pair again", async () => {
    let failing = false;
    const { world, providers } = withReview({ failOn: (c) => failing && c === "gh.setEnvironmentSecret:REVIEW_DELETE_KEY" });
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    // The delete key needs issuing again: it can also write.
    world.b2.keys.find((k) => k.name === "fisqua-sbmal-review-tiles-runner-delete")!.capabilities = [
      "listBuckets", "readBuckets", "listFiles", "deleteFiles", "writeFiles",
    ];
    failing = true;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(
      /^Writing the secrets of fisqua-sbmal-review-tiles-runner-delete failed .*; the new key .* was deleted\. fisqua-sbmal-review-tiles-runner-delete is marked as half written \(by this run, read back from D1\)/,
    );
    failing = false;
    expect([...world.d1.pendingPairs.keys()]).toEqual([`${SCOPE} fisqua-sbmal-review-tiles-runner-delete`]);
    // Put the capabilities right, so only the mark calls for a reissue.
    world.b2.keys.find((k) => k.name === "fisqua-sbmal-review-tiles-runner-delete")!.capabilities = [
      "listBuckets", "readBuckets", "listFiles", "deleteFiles",
    ];
    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-sbmal-review-tiles-runner-delete again: B2 key, delete, limited to acme-review-tiles/sbmal/ (runner), " +
        "and replace the secrets that hold it, because an earlier run began writing its two secrets and did not finish",
    );
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const env = world.gh.secrets.get(ENV)!;
    expect(env.get("REVIEW_DELETE_KEY")).toBe(env.get("REVIEW_DELETE_KEY_ID")!.replace("FAKEKEYID", "FAKESECRET"));
    expect(world.d1.pendingPairs.size).toBe(0);
  });

  it("issues again a runner pair a crashed run left marked, and a full run leaves no mark", async () => {
    const { world, providers } = provisioned();
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.d1.pendingPairs.size).toBe(0);
    expect(world.calls.filter((c) => c.startsWith("d1.markPair:"))).toHaveLength(5);
    world.d1.pendingPairs.set(`${SCOPE} fisqua-sbmal-tiles-runner-write`, "t-crashed");
    const before = world.gh.secrets.get(ENV)!.get("DELIVERY_WRITE_KEY_ID");
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    expect(world.gh.secrets.get(ENV)!.get("DELIVERY_WRITE_KEY_ID")).not.toBe(before);
    expect(world.d1.pendingPairs.size).toBe(0);
  });
});

describe("a review delete key from before it could read the bucket", () => {
  it("is not accepted: a rerun issues it again with readBuckets, under the reissue rule", async () => {
    const { world, providers } = provisioned();
    world.d1.federations[0].pipeline_review_tiles_bucket = "acme-review-tiles";
    world.b2.buckets.set("acme-review-tiles", {
      bucketId: "bucket-review", bucketName: "acme-review-tiles", bucketType: "allPrivate", corsRules: [],
      bucketInfo: { "fisqua-role": "review-tiles", "fisqua-env": "production", "fisqua-federation": "acme" },
    });
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    // As a key issued with the earlier three capabilities would be.
    world.b2.keys.find((k) => k.name === "fisqua-sbmal-review-tiles-runner-delete")!.capabilities = [
      "listBuckets", "listFiles", "deleteFiles",
    ];
    const before = new Map(world.gh.secrets.get(ENV)!);
    const dry = capture();
    await provisionTenantStorage({ ...OPTS, apply: false }, providers, dry.log);
    expect(dry.text()).toContain(
      "[reissue] would issue fisqua-sbmal-review-tiles-runner-delete again: B2 key, delete, limited to acme-review-tiles/sbmal/ (runner), " +
        "and replace the secrets that hold it, because the key named fisqua-sbmal-review-tiles-runner-delete in the B2 account " +
        "has the capabilities deleteFiles,listBuckets,listFiles, not deleteFiles,listBuckets,listFiles,readBuckets",
    );
    expect(dry.text()).toContain("[exists] fisqua-sbmal-review-tiles-runner-write");
    // Refused while work is open, as any reissue is.
    world.d1.openRuns = 1;
    expect(await stopped(provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {}))).toMatch(/its runner keys cannot be issued again/);
    world.d1.openRuns = 0;
    await provisionTenantStorage({ ...OPTS, apply: true }, providers, () => {});
    const env = world.gh.secrets.get(ENV)!;
    expect(env.get("REVIEW_DELETE_KEY_ID")).not.toBe(before.get("REVIEW_DELETE_KEY_ID"));
    expect(env.get("REVIEW_WRITE_KEY_ID")).toBe(before.get("REVIEW_WRITE_KEY_ID"));
    expect(world.b2.keys.filter((k) => k.name === "fisqua-sbmal-review-tiles-runner-delete").at(-1)!.capabilities).toEqual([
      "listBuckets", "readBuckets", "listFiles", "deleteFiles",
    ]);
  });
});

// @version v0.8.0
