#!/usr/bin/env npx tsx
/**
 * Appliance Key — Mint a Capture Appliance's Upload or Read Key
 *
 * A capture appliance (Captua) uploads the images it shoots to the
 * tenant's part of its federation's masters bucket, under `{slug}/`.
 * This command makes the B2 key it uploads with, next to the runner keys
 * `provision-tenant-storage.ts` issues: `listBuckets`, `listFiles` and
 * `writeFiles` on the masters bucket the federation's storage record
 * names, limited to the prefix `{slug}/`, with no `readFiles` and no
 * `deleteFiles`. An operator then hands the key to the appliance. It
 * runs on the operator's machine, with the operator's account-level B2
 * credentials, which never leave it.
 *
 * With `--access read` it makes the appliance's second, separate key
 * instead, which an admin uses to restore on the appliance a volume
 * whose images were freed from its card: `listBuckets`, `listFiles` and
 * `readFiles` on the same bucket and prefix, with no `writeFiles` and no
 * `deleteFiles`, named `fisqua-{slug}[-staging]-appliance-{id}-read`.
 * The prefix `{slug}/` covers every volume of the tenant and
 * `{slug}/db-backups/`, where the tenant's database dumps are kept
 * age-encrypted, so a unit whose read key is compromised can read its
 * tenant's whole archive; that risk was accepted on 2026-10-24. It
 * still cannot write or delete. `--access write`, the default, makes
 * the upload key. Every safeguard below applies to each key on its own:
 * a key named for one access and limited as the other stops the
 * command.
 *
 * It refuses a tenant whose federation has no complete storage record,
 * and reads the tenant and the record from D1 through wrangler, read
 * only. The key is named `fisqua-{slug}[-staging]-appliance-{id}`, from
 * the tenant's slug and the appliance's short id (lowercase letters,
 * digits and hyphens, 1 to 32 characters, not ending in `-read`). After issuing the key it
 * reads it back from B2 and stops unless B2 reports exactly those
 * capabilities, that bucket and that prefix. A key of that name already
 * limited as it should be is reported `[exists]` and nothing is issued;
 * one limited otherwise stops the command, which lists the keys of that
 * name by id for deletion by hand and deletes none.
 *
 * The key's id and secret go to the macOS login Keychain, service
 * `fisqua-appliance`, accounts `{key name}-id` and `{key name}-secret`;
 * the command prints the key's name, its id and the two account names,
 * never the secret, and writes no file. Nothing is written to D1 or
 * GitHub.
 *
 * A dry run is the default: it reads and prints what it would do, and
 * writes nothing. `--apply` issues the key. `--apply` against
 * production also needs `--confirm-production`.
 *
 * Credentials, read from the operator's environment:
 *   B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY   a B2 key with key rights
 *   wrangler's own login                         D1, read only
 * A dry run without the B2 pair prints the key as unchecked.
 *
 * Usage:
 *   npx tsx scripts/commands/provision-appliance-key.ts --tenant sbmal --appliance rig-1 --target staging
 *   npx tsx scripts/commands/provision-appliance-key.ts --tenant sbmal --appliance rig-1 --target staging --apply
 *   npx tsx scripts/commands/provision-appliance-key.ts --tenant sbmal --appliance rig-1 --target staging --access read
 *
 * `--target` picks the database and the key's name: `staging`
 * (`--env staging`, `-staging` in the name) or `production`.
 *
 * @version v0.8.0
 */

import { pathToFileURL } from "node:url";
import { b2FromEnv, execCommand, wranglerD1, type Target } from "../lib/tenant-storage";
import {
  APPLIANCE_ACCESS_VALUES,
  APPLIANCE_ID_PATTERN,
  macKeychain,
  provisionApplianceKey,
  type ApplianceAccess,
  type ApplianceProviders,
} from "../lib/appliance-key";

export interface ApplianceCliOptions {
  tenant: string;
  appliance: string;
  target: Exclude<Target, "local">;
  apply: boolean;
  confirmProduction: boolean;
  access: ApplianceAccess;
}

export function parseArgs(argv: string[]): ApplianceCliOptions {
  let tenant = "";
  let appliance = "";
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  let access = "write";
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
    else if (a === "--appliance") appliance = value();
    else if (a === "--target") target = value();
    else if (a === "--access") access = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!tenant) throw new Error("--tenant is required");
  if (!appliance) throw new Error("--appliance is required");
  if (!APPLIANCE_ID_PATTERN.test(appliance)) {
    throw new Error(`Not an appliance id: ${appliance} (lowercase letters, digits and hyphens, 1 to 32 characters)`);
  }
  if (appliance.endsWith("-read")) {
    throw new Error(`Not an appliance id: ${appliance} (an id may not end in -read, the read key's suffix)`);
  }
  if (!(APPLIANCE_ACCESS_VALUES as readonly string[]).includes(access)) {
    throw new Error(`Not an appliance key access: ${access} (--access write or read)`);
  }
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { tenant, appliance, target, apply, confirmProduction, access: access as ApplianceAccess };
}

function providersFor(options: ApplianceCliOptions, env: NodeJS.ProcessEnv): ApplianceProviders {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return {
    b2: b2FromEnv(env, fetchImpl),
    d1: wranglerD1(options.target, execCommand),
    keychain: macKeychain,
  };
}

/** Runs the appliance step with the options and providers given. */
export async function runApplianceCommand(
  options: ApplianceCliOptions,
  providers: ApplianceProviders,
  log: (line: string) => void,
): Promise<void> {
  await provisionApplianceKey(
    {
      slug: options.tenant,
      appliance: options.appliance,
      target: options.target,
      apply: options.apply,
      access: options.access,
    },
    providers,
    log,
  );
  if (!options.apply) log("\nDry run: nothing was written. Run with --apply to write.");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runApplianceCommand(options, providersFor(options, process.env), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
