/**
 * Scripts — the shared working bucket
 *
 * This module deals with the one B2 bucket every tenant's pipeline runs
 * share as working space: the runner writes held manifests and run
 * reports there, each tenant under its own `{tenantId}/` prefix, and
 * Fisqua reads them back with a read-only key. It exists once per
 * environment, `fisqua-pipeline-working` in production and
 * `fisqua-pipeline-working-staging` on staging (`workingBucketFor`), and
 * `scripts/commands/provision-working-bucket.ts` creates it.
 *
 * `provisionWorkingBucket(options, providers, log)` walks three steps,
 * reading what exists before it writes, so a second run changes nothing:
 *
 *   1. The bucket: created private, with no CORS rule, no host and no
 *      lifecycle rule. A name B2 holds for another account stops the
 *      command; an existing bucket of the name that is not private stops
 *      it too.
 *   2. Fisqua's read key, limited to the bucket, issued only when one of
 *      the Worker secrets that hold it (`PIPELINE_WORKING_READ_KEY_ID`,
 *      `PIPELINE_WORKING_READ_SECRET_KEY`) is missing, and then written
 *      to both.
 *   3. The two Worker settings the bucket needs, printed for the operator
 *      to set: `PIPELINE_WORKING_BUCKET` and `PIPELINE_WORKING_S3_ENDPOINT`,
 *      the B2 account's S3 endpoint.
 *
 * It uses the tenant storage module's helpers (`ensureB2Bucket`,
 * `issueKeys`) and its provider interfaces, so the tests run it against
 * the same fakes. A dry run, the default, writes nothing; no secret
 * value is printed.
 *
 * @version v0.8.0
 */

import {
  confirmTag,
  ensureB2Bucket,
  lacksTag,
  refuseTagConflict,
  has,
  idOf,
  issueKeys,
  workingBucketFor,
  B2_READ_CAPABILITIES,
  ProvisionStop,
  type BucketTag,
  type Log,
  type Providers,
  type Target,
} from "./tenant-storage";

export const WORKING_READ_SECRETS = {
  keyId: "PIPELINE_WORKING_READ_KEY_ID",
  secret: "PIPELINE_WORKING_READ_SECRET_KEY",
} as const;

export interface WorkingBucketOptions {
  target: Target;
  apply: boolean;
}

export interface WorkingBucketResult {
  bucket: string;
  /** The B2 account's S3 endpoint, or null when it was not read. */
  endpoint: string | null;
}

/** The name of Fisqua's read key on the working bucket. */
export function workingReadKeyName(target: Target): string {
  return `${workingBucketFor(target)}-fisqua-read`;
}

/** Creates the target's working bucket and Fisqua's read key on it. */
export async function provisionWorkingBucket(
  options: WorkingBucketOptions,
  providers: Pick<Providers, "b2" | "worker">,
  log: Log,
): Promise<WorkingBucketResult> {
  const { apply, target } = options;
  if (target === "local") {
    throw new ProvisionStop("The working bucket is created in the B2 account; use --target staging or production");
  }
  const bucket = workingBucketFor(target);
  const keyName = workingReadKeyName(target);
  const { b2, worker } = providers;
  log(`Working bucket, target ${target}${apply ? "" : ", dry run"}`);
  log(`  bucket (B2, private, shared by every tenant): ${bucket}`);
  log(`  Fisqua's read key:                            ${keyName}`);
  if (apply) {
    const missing = [!b2 && "B2", !worker && "Worker secrets"].filter(Boolean);
    if (missing.length > 0) throw new ProvisionStop(`--apply needs credentials for: ${missing.join(", ")}`);
  }

  log("");
  log("1. Bucket");
  let bucketId: string | null = null;
  let endpoint: string | null = null;
  if (!b2) {
    log(`  [unchecked] B2 bucket ${bucket} (no B2 credentials)`);
  } else {
    endpoint = (await b2.account()).s3ApiUrl.replace(/\/+$/, "");
    // Tagged as the target's working bucket, shared by every
    // federation. An existing bucket is adopted only when it is empty or
    // already tagged as this working bucket: the working keys can write,
    // so an untagged bucket holding files (a former tiles or masters
    // bucket, say) never becomes the working bucket.
    const tag: BucketTag = { role: "working", env: target, federation: null };
    const existing = await b2.findBucket(bucket);
    if (existing) {
      refuseTagConflict(existing, bucket, tag);
      if (lacksTag(existing, tag) && (await b2.hasFileVersions(existing.bucketId))) {
        throw new ProvisionStop(
          `The B2 bucket ${bucket} holds files and is not tagged as the ${target} working bucket; ` +
            "the command adopts only an empty bucket as the working bucket and never deletes files",
        );
      }
    }
    bucketId = await ensureB2Bucket(b2, bucket, "allPrivate", [], "private, no CORS rule, no host", apply, log, tag);
  }

  log("");
  log("2. Fisqua's read key and Worker secrets");
  const workerNames = worker ? await worker.names() : null;
  if (!b2 || !worker) {
    log(`  [unchecked] ${keyName}, ${WORKING_READ_SECRETS.keyId}, ${WORKING_READ_SECRETS.secret}`);
  } else {
    const keyNames = await b2.keyNames();
    await issueKeys(
      [
        {
          label: `B2 key, read, limited to ${bucket} (Fisqua)`,
          name: keyName,
          held: has(workerNames, WORKING_READ_SECRETS.keyId, WORKING_READ_SECRETS.secret),
          older: keyNames.includes(keyName),
          issue: async () => {
            await confirmTag(b2, bucket, { role: "working", env: target, federation: null });
            return b2.createKey(keyName, B2_READ_CAPABILITIES, idOf(bucketId, bucket));
          },
          store: async (k) => {
            await worker.put(WORKING_READ_SECRETS.keyId, k.keyId);
            await worker.put(WORKING_READ_SECRETS.secret, k.secret);
          },
        },
      ],
      apply,
      log,
    );
    for (const name of Object.values(WORKING_READ_SECRETS)) {
      log(`  [${workerNames!.includes(name) ? "exists" : apply ? "set" : "would set"}] ${name}`);
    }
  }

  log("");
  log("3. Worker settings to set for this environment");
  log(`  PIPELINE_WORKING_BUCKET      = ${bucket}`);
  log(`  PIPELINE_WORKING_S3_ENDPOINT = ${endpoint ?? "(unchecked: the B2 account's S3 endpoint)"}`);
  return { bucket, endpoint };
}

// @version v0.8.0
