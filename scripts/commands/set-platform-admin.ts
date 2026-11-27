#!/usr/bin/env npx tsx
/**
 * Set Platform Admin — Set or Clear a Person's Platform-Admin Flag
 *
 * This script sets or clears a person's platform-admin flag. A platform
 * admin is at home in every live workspace (kind `tenant`, not disabled)
 * with every role flag on, whatever workspace their row is stored in
 * (`app/lib/platform-admin.server.ts`). Nobody can set the flag through
 * the app; this script, run on the operator's machine, is the only writer
 * of `users.is_platform_admin`.
 *
 *   set     turns the flag on for the person with the email
 *   clear   turns it off; it takes effect on their next request
 *
 * Each change records one `set_user_role` row in `audit_log`
 * (`scripts/lib/platform-admin.ts` has the details). The person's stored
 * workspace is not changed.
 *
 * A dry run is the default: it reads the person and prints what it
 * would do, and writes nothing. `--apply` writes. `--apply` against
 * production also needs `--confirm-production`.
 *
 * Credentials: wrangler's own login, for D1 (reads with `--command`, the
 * write with one `--file`).
 *
 * Usage:
 *   npx tsx scripts/commands/set-platform-admin.ts set --email someone@example.org --target staging
 *   npx tsx scripts/commands/set-platform-admin.ts set --email someone@example.org --target staging --apply
 *   npx tsx scripts/commands/set-platform-admin.ts clear --email someone@example.org --target production --apply --confirm-production
 *
 * `--target` picks the database: `staging` (`--env staging`) or
 * `production`.
 *
 * @version v0.9.0
 */

import { runD1 } from "../lib/d1-cli";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { d1Args, execCommand, type Target } from "../lib/tenant-storage";
import { wranglerRows } from "../lib/capture-registration";
import {
  runSetPlatformAdmin,
  SET_PLATFORM_ADMIN_ACTIONS,
  type SetPlatformAdminAction,
  type SetPlatformAdminProviders,
  type SetPlatformAdminResult,
} from "../lib/platform-admin";

export interface SetPlatformAdminCliOptions {
  action: SetPlatformAdminAction;
  email: string;
  target: Exclude<Target, "local">;
  apply: boolean;
  confirmProduction: boolean;
}

export function parseArgs(argv: string[]): SetPlatformAdminCliOptions {
  const [action, ...rest] = argv;
  if (!(SET_PLATFORM_ADMIN_ACTIONS as readonly string[]).includes(action ?? "")) {
    throw new Error(`The first argument is the subcommand: ${SET_PLATFORM_ADMIN_ACTIONS.join(", ")}`);
  }
  let email = "";
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--email") email = value();
    else if (a === "--target") target = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!email.trim()) throw new Error("--email is required");
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { action: action as SetPlatformAdminAction, email, target, apply, confirmProduction };
}

function providersFor(options: SetPlatformAdminCliOptions): SetPlatformAdminProviders {
  return {
    rows: wranglerRows(options.target, execCommand),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    },
    // Applied with wrangler's own output and prompts on the terminal.
    applyFile: (file) => {
      runD1([...d1Args(options.target), `--file=${file}`], { stdio: "inherit" });
    },
    removeFile: (file) => fs.rmSync(file, { force: true }),
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

/** Runs the subcommand with the options and providers given. */
export async function runSetPlatformAdminCommand(
  options: SetPlatformAdminCliOptions,
  providers: SetPlatformAdminProviders,
  log: (line: string) => void,
): Promise<SetPlatformAdminResult> {
  const result = await runSetPlatformAdmin(
    { action: options.action, email: options.email, target: options.target, apply: options.apply },
    providers,
    log,
  );
  if (!options.apply) log("\nDry run: nothing was written. Run with --apply to write.");
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runSetPlatformAdminCommand(options, providersFor(options), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
