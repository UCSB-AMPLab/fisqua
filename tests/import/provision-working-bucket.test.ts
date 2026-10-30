/**
 * Tests — the working bucket command
 *
 * This suite pins the one-off command that creates the pipeline's
 * shared B2 working bucket for one environment, run against the tenant
 * storage fakes (`tests/import/tenant-storage-fakes.ts`). Nothing here
 * reaches an account.
 *
 *   - the names: `fisqua-pipeline-working` in production,
 *     `fisqua-pipeline-working-staging` on staging, and the read key's
 *     name from it; the local target is refused;
 *   - the dry run reads, writes nothing, and prints the two Worker
 *     settings with the account's S3 endpoint;
 *   - an applied run creates the bucket private with no CORS rule,
 *     tagged with its role and environment,
 *     issues one read key limited to it, sets the two Worker secrets,
 *     and prints no key value; a second run changes nothing;
 *   - a name held by another account, or a public bucket of the name,
 *     stops the command; applying without credentials is refused;
 *   - the arguments: a target is required, and production needs
 *     `--confirm-production` to apply.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { ProvisionStop, workingBucketFor } from "../../scripts/lib/tenant-storage";
import { provisionWorkingBucket, workingReadKeyName } from "../../scripts/lib/working-bucket";
import { parseWorkingArgs } from "../../scripts/commands/provision-working-bucket";
import { fakeWorld, FAKE_B2_S3, FAKE_WORKING_BUCKET } from "./tenant-storage-fakes";

const WRITES = /create|put|set|update|add|write/i;

/** A fake world without the tenant fakes' stand-in working bucket. */
function world() {
  const w = fakeWorld();
  w.world.b2.buckets.delete(FAKE_WORKING_BUCKET);
  return w;
}

function capture() {
  const lines: string[] = [];
  return { log: (l: string) => lines.push(l), text: () => lines.join("\n") };
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

describe("working bucket names", () => {
  it("names the bucket and the read key per target, and refuses local", () => {
    expect(workingBucketFor("production")).toBe("fisqua-pipeline-working");
    expect(workingBucketFor("staging")).toBe("fisqua-pipeline-working-staging");
    expect(workingReadKeyName("production")).toBe("fisqua-pipeline-working-fisqua-read");
    expect(workingReadKeyName("staging")).toBe("fisqua-pipeline-working-staging-fisqua-read");
    expect(() => workingBucketFor("local")).toThrow(ProvisionStop);
  });
});

describe("provisioning the working bucket", () => {
  it("dry run: writes nothing and prints the settings", async () => {
    const { world: w, providers } = world();
    const out = capture();
    const result = await provisionWorkingBucket({ target: "staging", apply: false }, providers, out.log);
    expect(result).toEqual({ bucket: "fisqua-pipeline-working-staging", endpoint: FAKE_B2_S3 });
    expect(w.calls.filter((c) => WRITES.test(c.split(".")[1] ?? ""))).toEqual([]);
    expect(out.text()).toContain("would create B2 bucket fisqua-pipeline-working-staging, private, no CORS rule, no host");
    expect(out.text()).toContain("would issue fisqua-pipeline-working-staging-fisqua-read");
    expect(out.text()).toContain("PIPELINE_WORKING_BUCKET      = fisqua-pipeline-working-staging");
    expect(out.text()).toContain(`PIPELINE_WORKING_S3_ENDPOINT = ${FAKE_B2_S3}`);
  });

  it("apply: creates the private bucket and one read key, sets the two secrets, and a second run changes nothing", async () => {
    const { world: w, providers } = world();
    const out = capture();
    await provisionWorkingBucket({ target: "production", apply: true }, providers, out.log);
    const bucket = w.b2.buckets.get("fisqua-pipeline-working")!;
    expect(bucket).toMatchObject({ bucketType: "allPrivate", corsRules: [] });
    // Tagged as the environment's working bucket, with no federation: every federation shares it.
    expect(bucket.bucketInfo).toEqual({ "fisqua-role": "working", "fisqua-env": "production" });
    expect(w.b2.keys).toEqual([
      { name: "fisqua-pipeline-working-fisqua-read", bucketId: bucket.bucketId, capabilities: ["listBuckets", "listFiles", "readFiles"] },
    ]);
    expect([...w.worker.keys()].sort()).toEqual(["PIPELINE_WORKING_READ_KEY_ID", "PIPELINE_WORKING_READ_SECRET_KEY"]);
    for (const value of w.issued) expect(out.text()).not.toContain(value);

    const before = w.calls.length;
    const again = capture();
    await provisionWorkingBucket({ target: "production", apply: true }, providers, again.log);
    expect(w.calls.slice(before).filter((c) => WRITES.test(c.split(".")[1] ?? ""))).toEqual([]);
    expect(again.text()).not.toContain("[create]");
  });

  it("stops at a name held by another account, or a public bucket of the name", async () => {
    const a = world();
    a.world.b2.taken.add("fisqua-pipeline-working");
    expect(await stopped(provisionWorkingBucket({ target: "production", apply: true }, a.providers, () => {}))).toMatch(
      /fisqua-pipeline-working is taken/,
    );
    expect(a.world.b2.keys).toEqual([]);
    const b = world();
    b.world.b2.buckets.set("fisqua-pipeline-working", {
      bucketId: "b-pub", bucketName: "fisqua-pipeline-working", bucketType: "allPublic", corsRules: [],
    });
    expect(await stopped(provisionWorkingBucket({ target: "production", apply: false }, b.providers, () => {}))).toMatch(
      /allPublic, not allPrivate/,
    );
  });

  it("prints unchecked steps without credentials, refuses to apply without them, and refuses local", async () => {
    const { providers } = world();
    const out = capture();
    await provisionWorkingBucket({ target: "staging", apply: false }, { b2: null, worker: null }, out.log);
    expect(out.text()).toContain("[unchecked] B2 bucket fisqua-pipeline-working-staging");
    expect(await stopped(provisionWorkingBucket({ target: "staging", apply: true }, { ...providers, worker: null }, () => {})))
      .toMatch(/credentials for: Worker secrets/);
    expect(await stopped(provisionWorkingBucket({ target: "local", apply: false }, providers, () => {}))).toMatch(
      /staging or production/,
    );
  });
});

describe("working bucket arguments", () => {
  it("needs a target, and --confirm-production to apply against production", () => {
    expect(() => parseWorkingArgs([])).toThrow(/--target is required/);
    expect(() => parseWorkingArgs(["--target", "local"])).toThrow(/--target is required/);
    expect(() => parseWorkingArgs(["--target", "production", "--apply"])).toThrow(/confirm-production/);
    expect(parseWorkingArgs(["--target", "production", "--apply", "--confirm-production"])).toEqual({ target: "production", apply: true });
    expect(parseWorkingArgs(["--target", "staging"])).toEqual({ target: "staging", apply: false });
  });
});

// @version v0.8.0
