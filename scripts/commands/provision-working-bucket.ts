#!/usr/bin/env npx tsx
/**
 * Working Bucket — Create the Pipeline's Shared Working Space
 *
 * The media pipeline's runner keeps each run's working files (held
 * manifests and the reports Fisqua reads back) in one Backblaze B2
 * bucket that every tenant shares, each under its own prefix. This
 * one-off command creates that bucket for one environment and gives
 * Fisqua a key that can only read it. It runs once per environment,
 * before any tenant's storage is provisioned, on the operator's
 * machine.
 *
 * For `--target production` the bucket is `fisqua-pipeline-working`;
 * for `--target staging`, `fisqua-pipeline-working-staging`. It is
 * created private, with no CORS rule, no host and no lifecycle rule. A
 * name B2 holds for another account stops the command. Fisqua's read key
 * is limited to the bucket and set as the Worker secrets
 * `PIPELINE_WORKING_READ_KEY_ID` and `PIPELINE_WORKING_READ_SECRET_KEY`.
 * The command then prints the values for the Worker settings
 * `PIPELINE_WORKING_BUCKET` and `PIPELINE_WORKING_S3_ENDPOINT`; it does
 * not write them anywhere.
 *
 * The bucket is tagged in its bucket info as the environment's working
 * bucket (`fisqua-role` working, `fisqua-env`), with no federation, since
 * every federation shares it; an untagged existing one is tagged when the
 * command runs again, and one tagged otherwise stops it. An existing
 * bucket is adopted only when it is empty or already tagged as the
 * working bucket; an untagged one holding files stops the command.
 *
 * Every step checks what exists first, so running it again changes
 * nothing. A dry run is the default and writes nothing. `--apply`
 * writes; against production it also needs `--confirm-production`. No
 * secret value is printed.
 *
 * Credentials, read from the operator's environment:
 *   B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY   a B2 key with bucket and key rights
 *   wrangler's own login                         Worker secrets
 * The operator keeps these in the password manager and exports them into
 * the shell for the session only; they are never written to a file. A
 * dry run without them prints those steps as unchecked.
 *
 * Usage:
 *   npx tsx scripts/commands/provision-working-bucket.ts --target staging
 *   npx tsx scripts/commands/provision-working-bucket.ts --target staging --apply
 *   npx tsx scripts/commands/provision-working-bucket.ts --target production --apply --confirm-production
 *
 * @version v0.8.0
 */

import { pathToFileURL } from "node:url";
import { b2FromEnv, execCommand, wranglerSecrets, type Target } from "../lib/tenant-storage";
import { provisionWorkingBucket } from "../lib/working-bucket";

export interface WorkingCliOptions {
  target: Exclude<Target, "local">;
  apply: boolean;
}

export function parseWorkingArgs(argv: string[]): WorkingCliOptions {
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--target") {
      target = argv[++i] ?? null;
      if (target === null || target.startsWith("--")) throw new Error("--target needs a value");
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { target, apply };
}

async function main(): Promise<void> {
  const options = parseWorkingArgs(process.argv.slice(2));
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  await provisionWorkingBucket(
    options,
    { b2: b2FromEnv(process.env, fetchImpl), worker: wranglerSecrets(options.target, execCommand) },
    (line) => console.log(line),
  );
  if (!options.apply) console.log("\nDry run: nothing was written. Run with --apply to write.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
