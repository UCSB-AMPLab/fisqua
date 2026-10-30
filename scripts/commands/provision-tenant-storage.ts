#!/usr/bin/env npx tsx
/**
 * Tenant Storage — Give a Tenant's Pipeline Runs Their Keys
 *
 * The media pipeline writes each tenant's image tiles, page text and
 * manifests under the tenant's slug in its federation's buckets, which
 * `provision-federation-storage.ts` sets up and records. This command is
 * the second step: it gives one tenant's runs the runner keys they use,
 * each limited to the tenant's part of that storage. It runs on the
 * operator's machine, with the operator's account-level credentials,
 * which never leave it.
 *
 * It refuses a tenant whose federation has no complete storage record,
 * or whose federation's Worker secrets are not set. Otherwise it creates
 * the tenant's runner key store, the GitHub Environment
 * `fisqua-pipeline-{tenantId}` in the runner repository
 * (`fisqua-pipeline-staging-{tenantId}` on staging, since both
 * environments dispatch to one runner repository and a tenant seeded by
 * a migration has the same id in both), and issues into it the runner's
 * keys:
 *
 *   - tiles write and read, limited to the federation's tiles bucket and
 *     the prefix `{slug}/`;
 *   - masters read, limited to the federation's masters bucket and
 *     `{slug}/`;
 *   - working write and read, limited to `{tenantId}/` in the shared
 *     working bucket;
 *   - when the federation records a review-tiles bucket, review write
 *     (for the review run) and review delete (for the processing run's
 *     purge of review prefixes), limited to that bucket and `{slug}/`.
 *     Without that bucket they are not issued, and the tenant's volumes
 *     skip the review run.
 *
 * Run against a tenant that already holds the other five keys, it
 * issues only the two review keys.
 *
 * It then adds the Environment to the runner's `PIPELINE_ENVIRONMENTS`
 * and the host of the federation's storage endpoint to
 * `PIPELINE_STORAGE_HOSTS`. Keys are named `fisqua-{slug}[-staging]-…`
 * from the tenant's slug. Nothing is written to D1.
 *
 * The working bucket is shared by every tenant and is not created here:
 * `provision-working-bucket.ts` creates it once per environment. It is
 * `fisqua-pipeline-working` in production and
 * `fisqua-pipeline-working-staging` on staging; `--working-bucket` names
 * another, and the command stops if the bucket is not in the B2 account.
 * It also stops, before reading or issuing anything, when the working
 * bucket is one of the federation's buckets (tiles, masters, review
 * tiles, manifests) or a bucket another federation records, since the
 * working keys can write there.
 *
 * A key whose secrets are already set is not issued again, unless the
 * keys of its name in the B2 account are not limited to the bucket and
 * prefix it should be (after the federation's bucket changed, say), or do
 * not have exactly its role's capabilities: then
 * it is issued again (`[reissue]` in the dry run, with the reason), which
 * is refused while the tenant has an open run or a volume prepared or
 * ready but not yet published. A key replaced is reported for deletion
 * by hand, never deleted. Until it is deleted, the account holds keys of
 * one name limited differently, and since the secrets cannot be read
 * back the command cannot tell which one they hold: it stops before
 * writing anything and lists those keys by id and limit, for the stale
 * ones to be deleted by hand before it is run again.
 *
 * Before any key is issued, the B2 role tags of the federation's buckets
 * and of the working bucket are checked: a bucket tagged for another
 * role, environment or federation stops the command, and so does an
 * untagged review-tiles bucket that holds files. Each key is issued
 * only after its bucket's tag is read again and is exactly this tenant's
 * role, environment and federation; an untagged bucket is tagged by
 * running provision-federation-storage (or provision-working-bucket)
 * first.
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
 * `--confirm-production`. No secret value is printed.
 *
 * Credentials, read from the operator's environment:
 *   B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY   a B2 key with bucket and key rights
 *   GITHUB_TOKEN                                 the runner repository's environments,
 *                                                secrets and variables (`gh` sets secrets)
 *   wrangler's own login                         D1, and the Worker's secret names
 * A dry run without some of them prints those steps as unchecked. The
 * operator keeps these in the password manager and exports them into the
 * shell for the session only; they are never written to a file.
 *
 * Usage:
 *   npx tsx scripts/commands/provision-tenant-storage.ts --tenant sbmal --target staging
 *   npx tsx scripts/commands/provision-tenant-storage.ts --tenant sbmal --target staging --apply
 *
 * `--target` picks the database and Worker: `staging` (`--env staging`)
 * or `production`. `--runner-repo` names the runner repository (by
 * default the one `wrangler.jsonc` dispatches to).
 *
 * @version v0.8.0
 */

import { pathToFileURL } from "node:url";
import {
  b2FromEnv,
  execCommand,
  runHolder,
  githubClient,
  provisionTenantStorage,
  wranglerD1,
  workingBucketFor,
  wranglerSecrets,
  type CommandRunner,
  type Providers,
  type Target,
} from "../lib/tenant-storage";

/** The runner repository `wrangler.jsonc` sets as PIPELINE_DISPATCH_REPO. */
const DEFAULT_RUNNER_REPO = "UCSB-AMPLab/fisqua-media-pipeline";

export interface TenantCliOptions {
  tenant: string;
  target: Exclude<Target, "local">;
  apply: boolean;
  confirmProduction: boolean;
  workingBucket: string;
  runnerRepo: string;
}

export function parseArgs(argv: string[]): TenantCliOptions {
  let tenant = "";
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  let workingBucket: string | null = null;
  let runnerRepo = DEFAULT_RUNNER_REPO;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--tenant") tenant = value();
    else if (a === "--target") target = value();
    else if (a === "--working-bucket") workingBucket = value();
    else if (a === "--runner-repo") runnerRepo = value();
    else if (a === "--adopt" || a === "--domain") {
      throw new Error(`${a} belongs to provision-federation-storage; the buckets are the federation's`);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!tenant) throw new Error("--tenant is required");
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return {
    tenant,
    target,
    apply,
    confirmProduction,
    workingBucket: workingBucket ?? workingBucketFor(target),
    runnerRepo,
  };
}

const runCommand: CommandRunner = execCommand;

function providersFor(options: TenantCliOptions, env: NodeJS.ProcessEnv): Providers {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return {
    b2: b2FromEnv(env, fetchImpl),
    cloudflare: null,
    github: env.GITHUB_TOKEN ? githubClient(env.GITHUB_TOKEN, options.runnerRepo, fetchImpl, runCommand) : null,
    worker: wranglerSecrets(options.target, runCommand),
    d1: wranglerD1(options.target, runCommand),
    now: () => Date.now(),
    holder: runHolder(),
  };
}

/** Runs the tenant step with the options and providers given. */
export async function runTenantCommand(
  options: TenantCliOptions,
  providers: Providers,
  log: (line: string) => void,
): Promise<void> {
  await provisionTenantStorage(
    { slug: options.tenant, target: options.target, apply: options.apply, workingBucket: options.workingBucket },
    providers,
    log,
  );
  if (!options.apply) log("\nDry run: nothing was written. Run with --apply to write.");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runTenantCommand(options, providersFor(options, process.env), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
