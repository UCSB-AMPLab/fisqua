#!/usr/bin/env npx tsx
/**
 * Federation Storage — Provision or Adopt a Federation's Pipeline Storage
 *
 * The media pipeline writes a federation's image tiles, page text and
 * manifests to buckets that belong to the federation, each tenant's
 * output under its own slug inside them, and the federation's row in
 * the catalogue database names that storage. This command sets the
 * storage up and records it; `provision-tenant-storage.ts` then gives
 * each tenant's runs their keys. It runs on the operator's machine, with
 * the operator's account-level credentials, which never leave it: Fisqua
 * itself only ever holds keys limited to the federation's buckets.
 *
 * Provisioning (`--federation <slug> --domain <domain>`) creates, in
 * Neogranadina's Backblaze B2 and Cloudflare accounts: a public B2 bucket
 * `{slug}-iiif-tiles` served at `iiif.{domain}` (a proxied CNAME to the
 * B2 download host with a Transform Rule adding the bucket's path), a
 * private B2 bucket `{slug}-masters`, a private B2 bucket
 * `{slug}-review-tiles` with no lifecycle rule, an R2 bucket
 * `{slug}-manifests` served at `manifests.{domain}`, CORS rules on the
 * tiles and manifest buckets (GET and HEAD from any origin) and on the
 * review-tiles bucket (downloads from the target's tenant hosts only,
 * not the apex),
 * Fisqua's four keys (a B2 read key on the tiles bucket, an R2 write
 * token on the manifest bucket, a B2 key that can only list the masters
 * bucket, and a B2 key that can list, read and share the review-tiles
 * bucket) as eight Worker secrets named from
 * the prefix `FEDERATION_{SLUG}`, and the federation's destination
 * record. On staging the buckets and keys carry `-staging` after the slug
 * and the hosts become `iiif-staging.{domain}` and
 * `manifests-staging.{domain}`. The domain's zone must already be in the
 * Cloudflare account. A B2 bucket name that is taken stops the command.
 *
 * Provisioning with `--masters-bucket <name>` takes an existing private
 * B2 bucket as the masters bucket instead of creating `{slug}-masters`,
 * on staging as in production: the tenants' prefixes keep test and real
 * material apart, so both targets can record the same bucket. Everything
 * else is provisioned as above. The command checks that the bucket is in
 * the B2 account and private before it creates anything, stops if not,
 * and never changes the bucket; the dry run prints it as `[exists] …
 * (adopted)`. Fisqua's list-only key is issued limited to it, and it is
 * recorded as the federation's masters bucket. The other storage flags
 * are for adoption only.
 *
 * The recorded masters bucket changes only with `--masters-bucket`.
 * Without the flag, a federation whose record already names a masters
 * bucket keeps it: the command checks it as it checks one given by the
 * flag, prints it as `(recorded, kept)`, and never plans
 * `{slug}-masters` in its place. With the flag naming the recorded
 * bucket, nothing changes. With the flag naming another bucket, the
 * masters bucket is replaced: the record write is refused while any
 * tenant of the federation has pending work, Fisqua's list key is
 * issued again and the key it replaces is reported for deletion by
 * hand, and the output names the tenants whose runner keys must follow.
 * Adoption always takes the masters bucket from `--masters-bucket`, so
 * the same holds there.
 *
 * Adopting (`--adopt`) records storage that already exists, as for
 * Neogranadina's federation, the only one adopted: it creates no bucket
 * and no host but the review-tiles bucket, named as provisioning names
 * it. Every name and address is a flag; nothing is guessed.
 * `--masters-bucket` names the existing private B2 bucket the runner
 * reads masters from; the command stops if it is not in the B2 account
 * or not private, and never creates it. Adoption issues Fisqua's four keys
 * limited to the adopted buckets and the review-tiles bucket, sets the
 * eight Worker secrets, and writes the record. Already-published manifests and tiles at the
 * buckets' root are not touched; new output goes under each tenant's
 * slug.
 *
 * Either way, a key whose secrets are already set is not issued again,
 * unless the record names another tiles, manifest, masters or review-tiles bucket than the one
 * wanted: then the key limited to that bucket is issued again
 * (`[reissue]` in the dry run, with the reason), and the key replaced is
 * reported for deletion by hand, never deleted. With `--target local`
 * no key is issued; only the record is written (adoption only).
 *
 * Each B2 bucket's role is also recorded on the bucket as bucket-info
 * tags (`fisqua-role`, `fisqua-env`, `fisqua-federation`), which staging
 * and production both see. A masters bucket, which serves both
 * environments of its federation, is tagged with `fisqua-role` and
 * `fisqua-federation` only; a `fisqua-env` it already carries, of either
 * value, is accepted and left as it is. A bucket is tagged when it is
 * created or adopted, and an untagged one on a rerun. A bucket tagged
 * for another role, environment or federation stops the command before
 * anything is created or issued, dry run included; on a masters bucket
 * only another role or federation does. Tags are written only at the
 * bucket revision just read, and each is confirmed in B2 before a key
 * is issued over the bucket. A masters bucket replaced with
 * `--masters-bucket` keeps a masters tag. The command never removes or
 * changes a tag; changing a bucket's role is an operator's action
 * outside it.
 *
 * An applied run holds a lock on its destination in D1
 * (`provisioning_locks`) from start to end, and a second applied run is
 * refused, naming who holds it and since when; a lock left by a run that
 * crashed expires after 30 minutes. The run renews the lock with its own
 * token before and after every secret write, so a run whose lock has
 * expired and passed to another run stops without writing again. Keys are kept as two secrets each,
 * which cannot be read back: a pair is taken as held only when the
 * account has a live key of its name, bucket and capabilities, and is
 * issued again otherwise. Whether the two secrets belong to one key
 * cannot be read, so each pair's write is recorded in D1
 * (`provisioning_pending_pairs`) from before its key is issued until
 * both secrets are written; a pair a run left half written is issued
 * again from scratch by the next run, and a new key whose second secret
 * failed is deleted (or named, to be deleted by hand, if that fails).
 *
 * Every step checks what exists first, so a run that stopped part way
 * is finished by running it again. A dry run is the default: it reads
 * and prints each step and the names it would create, and writes
 * nothing. `--apply` writes. `--apply` against production also needs
 * `--confirm-production`. The record is not changed while any tenant of
 * the federation has an open run or a volume prepared or ready but not
 * yet published, unless the run only adds the review-tiles bucket to a
 * record without one. Running either form again against a federation
 * set up before the review-tiles bucket existed creates that bucket,
 * issues its key, sets its two secrets and adds it to the record; the
 * other storage, keys and columns are found as they are and left alone.
 * A bucket, manifest address or secret prefix another
 * federation already has stops the command before anything is created,
 * issued or set, dry run included. No secret value is printed.
 *
 * Credentials, read from the operator's environment:
 *   B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY   a B2 key with bucket and key rights
 *   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID  R2, DNS, rules and API-token rights
 *   wrangler's own login                         Worker secrets and D1
 * A dry run without some of them prints those steps as unchecked. The
 * operator keeps these in the password manager and exports them into the
 * shell for the session only; they are never written to a file.
 *
 * Usage:
 *   npx tsx scripts/commands/provision-federation-storage.ts --federation acme \
 *     --domain acme.example --target staging
 *   npx tsx scripts/commands/provision-federation-storage.ts --federation acme \
 *     --domain acme.example --target staging --apply
 *   npx tsx scripts/commands/provision-federation-storage.ts --federation acme \
 *     --domain acme.example --masters-bucket <existing private bucket> --target staging
 *   npx tsx scripts/commands/provision-federation-storage.ts --federation neogranadina --adopt \
 *     --target production --tiles-bucket <bucket> --tiles-endpoint <https S3 endpoint> \
 *     --image-base-url <https address> --masters-bucket <bucket> --manifest-bucket <bucket> \
 *     --manifest-endpoint <https S3 endpoint> --manifest-base-url <https address> \
 *     [--secret-prefix <PREFIX>]
 *
 * `--target` picks the database and Worker: `local` (adopting only),
 * `staging` (`--env staging`) or `production`.
 *
 * @version v0.8.0
 */

import { pathToFileURL } from "node:url";
import {
  b2FromEnv,
  cloudflareClient,
  execCommand,
  runHolder,
  ProvisionStop,
  secretPrefixFor,
  wranglerD1,
  wranglerSecrets,
  type CommandRunner,
  type DestinationValues,
  type Providers,
  type Target,
} from "../lib/tenant-storage";
import {
  ADOPTABLE_FEDERATION,
  adoptFederationStorage,
  provisionFederationStorage,
} from "../lib/federation-storage";

export interface FederationCliOptions {
  federation: string;
  target: Target;
  apply: boolean;
  confirmProduction: boolean;
  adopt: boolean;
  domain: string | null;
  adoptValues: Partial<Record<keyof DestinationValues, string>>;
}

const ADOPT_FLAGS: Record<string, keyof DestinationValues> = {
  "--tiles-bucket": "pipeline_tiles_bucket",
  "--tiles-endpoint": "pipeline_delivery_endpoint",
  "--image-base-url": "pipeline_image_base_url",
  "--masters-bucket": "pipeline_masters_bucket",
  "--manifest-bucket": "manifest_bucket",
  "--manifest-endpoint": "manifest_endpoint",
  "--manifest-base-url": "manifest_base_url",
  "--secret-prefix": "storage_secret_prefix",
};

export function parseArgs(argv: string[]): FederationCliOptions {
  const out: FederationCliOptions = {
    federation: "",
    target: "staging",
    apply: false,
    confirmProduction: false,
    adopt: false,
    domain: null,
    adoptValues: {},
  };
  let target: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") out.apply = true;
    else if (a === "--confirm-production") out.confirmProduction = true;
    else if (a === "--adopt") out.adopt = true;
    else if (a === "--federation") out.federation = value();
    else if (a === "--target") target = value();
    else if (a === "--domain") out.domain = value();
    else if (a in ADOPT_FLAGS) out.adoptValues[ADOPT_FLAGS[a]] = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.federation) throw new Error("--federation is required");
  if (target !== "local" && target !== "staging" && target !== "production") {
    throw new Error("--target is required (local, staging or production)");
  }
  out.target = target;
  if (out.adopt) {
    if (out.domain !== null) throw new Error("--adopt takes the names and addresses as flags, not --domain");
    const missing = Object.entries(ADOPT_FLAGS)
      .filter(([flag, column]) => flag !== "--secret-prefix" && !out.adoptValues[column])
      .map(([flag]) => flag);
    if (missing.length > 0) throw new Error(`--adopt needs ${missing.join(", ")}`);
  } else {
    if (out.domain === null) throw new Error("--domain is required to provision");
    // Provisioning takes one storage flag: an existing masters bucket.
    if (Object.keys(out.adoptValues).some((column) => column !== "pipeline_masters_bucket")) {
      throw new Error("The storage flags other than --masters-bucket are for --adopt only");
    }
    if (out.target === "local") throw new Error("Provisioning needs --target staging or production");
  }
  if (out.apply && out.target === "production" && !out.confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return out;
}

export function adoptValuesFrom(options: FederationCliOptions): DestinationValues {
  const v = options.adoptValues;
  return {
    pipeline_delivery_endpoint: v.pipeline_delivery_endpoint ?? "",
    pipeline_tiles_bucket: v.pipeline_tiles_bucket ?? "",
    pipeline_masters_bucket: v.pipeline_masters_bucket ?? "",
    pipeline_image_base_url: (v.pipeline_image_base_url ?? "").replace(/\/+$/, ""),
    manifest_endpoint: v.manifest_endpoint ?? "",
    manifest_bucket: v.manifest_bucket ?? "",
    manifest_base_url: (v.manifest_base_url ?? "").replace(/\/+$/, ""),
    storage_secret_prefix: v.storage_secret_prefix ?? secretPrefixFor(options.federation),
  };
}

const runCommand: CommandRunner = execCommand;

function providersFor(options: FederationCliOptions, env: NodeJS.ProcessEnv): Providers {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return {
    b2: b2FromEnv(env, fetchImpl),
    cloudflare:
      env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID
        ? cloudflareClient(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, fetchImpl)
        : null,
    github: null,
    worker: options.target === "local" ? null : wranglerSecrets(options.target, runCommand),
    d1: wranglerD1(options.target, runCommand),
    now: () => Date.now(),
    holder: runHolder(),
  };
}

/** Runs the federation step with the options and providers given. */
export async function runFederationCommand(
  options: FederationCliOptions,
  providers: Providers,
  log: (line: string) => void,
): Promise<void> {
  if (options.adopt) {
    if (options.federation !== ADOPTABLE_FEDERATION) {
      // Adoption is for storage that predates the command; Neogranadina's
      // is the only such storage. Any other federation is provisioned.
      throw new ProvisionStop(
        `Only Neogranadina's existing storage is adopted; provision ${options.federation} instead`,
      );
    }
    await adoptFederationStorage(
      { slug: options.federation, target: options.target, apply: options.apply, values: adoptValuesFrom(options) },
      providers,
      log,
    );
  } else {
    await provisionFederationStorage(
      {
        slug: options.federation,
        domain: options.domain as string,
        target: options.target,
        apply: options.apply,
        mastersBucket: options.adoptValues.pipeline_masters_bucket ?? null,
      },
      providers,
      log,
    );
  }
  if (!options.apply) log("\nDry run: nothing was written. Run with --apply to write.");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runFederationCommand(options, providersFor(options, process.env), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
