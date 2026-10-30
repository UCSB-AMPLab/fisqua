#!/usr/bin/env npx tsx
/**
 * Scanner Token — Make, Replace or Revoke a Capture Unit's Link Token
 *
 * Under the Captua exchange contract a Captua unit delivers its capture
 * manifests to Fisqua itself and asks after its volumes, with a bearer
 * token of its own. This command, beside the one that mints the
 * unit's bucket keys (`provision-appliance-key.ts`), makes that token,
 * replaces it, or revokes it. It runs on the operator's machine.
 *
 *   make      gives the tenant's scanner a token, creating the scanner
 *             when the tenant has none; refused when its token is live
 *   replace   gives the scanner a new token; the old one stops working
 *             on its next call
 *   revoke    revokes the scanner's token, effective on its next call
 *
 * A tenant has one scanner, named with the unit's short id
 * (`--appliance`, the id its bucket keys carry). The token is 32 random
 * bytes as 64 lowercase hex characters. Fisqua keeps only its SHA-256;
 * the command prints the token once, after reading the write back, for
 * the unit's key file, and writes it to no file. The SQL file it applies
 * holds the hash only and is removed once applied.
 *
 * A dry run is the default: it reads the tenant and its scanner and
 * prints what it would do, and mints and writes nothing. `--apply`
 * writes. `--apply` against production also needs
 * `--confirm-production`.
 *
 * Credentials: wrangler's own login, for D1 (reads with `--command`, the
 * write with one `--file`).
 *
 * Usage:
 *   npx tsx scripts/commands/scanner-token.ts make --tenant ahr --appliance rig-1 --target staging
 *   npx tsx scripts/commands/scanner-token.ts make --tenant ahr --appliance rig-1 --target staging --apply
 *   npx tsx scripts/commands/scanner-token.ts replace --tenant ahr --target production --apply --confirm-production
 *   npx tsx scripts/commands/scanner-token.ts revoke --tenant ahr --target production --apply --confirm-production
 *
 * `--target` picks the database: `staging` (`--env staging`) or
 * `production`.
 *
 * @version v0.8.0
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { d1Args, execCommand, wranglerD1, type Target } from "../lib/tenant-storage";
import { wranglerRows } from "../lib/capture-registration";
import {
  runScannerToken,
  SCANNER_TOKEN_ACTIONS,
  type ScannerTokenAction,
  type ScannerTokenProviders,
  type ScannerTokenResult,
} from "../lib/scanner-token";
import { SCANNER_NAME_PATTERN } from "../../app/lib/capture/token";

export interface ScannerTokenCliOptions {
  action: ScannerTokenAction;
  tenant: string;
  appliance: string | null;
  target: Exclude<Target, "local">;
  apply: boolean;
  confirmProduction: boolean;
}

export function parseArgs(argv: string[]): ScannerTokenCliOptions {
  const [action, ...rest] = argv;
  if (!(SCANNER_TOKEN_ACTIONS as readonly string[]).includes(action ?? "")) {
    throw new Error(`The first argument is the subcommand: ${SCANNER_TOKEN_ACTIONS.join(", ")}`);
  }
  let tenant = "";
  let appliance: string | null = null;
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
    else if (a === "--tenant") tenant = value();
    else if (a === "--appliance") appliance = value();
    else if (a === "--target") target = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!tenant) throw new Error("--tenant is required");
  if (action === "make" && appliance === null) throw new Error("make needs --appliance, the unit's short id");
  if (appliance !== null && !SCANNER_NAME_PATTERN.test(appliance)) {
    throw new Error(`Not an appliance id: ${appliance} (lowercase letters, digits and hyphens, 1 to 32 characters)`);
  }
  if (target !== "staging" && target !== "production") {
    throw new Error("--target is required (staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  return { action: action as ScannerTokenAction, tenant, appliance, target, apply, confirmProduction };
}

function providersFor(options: ScannerTokenCliOptions): ScannerTokenProviders {
  return {
    d1: wranglerD1(options.target, execCommand),
    rows: wranglerRows(options.target, execCommand),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    },
    // Applied with wrangler's own output and prompts on the terminal.
    applyFile: (file) => {
      execFileSync("npx", [...d1Args(options.target), `--file=${file}`], { stdio: "inherit" });
    },
    removeFile: (file) => fs.rmSync(file, { force: true }),
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

/** Runs the subcommand with the options and providers given. */
export async function runScannerTokenCommand(
  options: ScannerTokenCliOptions,
  providers: ScannerTokenProviders,
  log: (line: string) => void,
): Promise<ScannerTokenResult> {
  const result = await runScannerToken(
    { action: options.action, slug: options.tenant, appliance: options.appliance, target: options.target, apply: options.apply },
    providers,
    log,
  );
  if (!options.apply) log("\nDry run: nothing was minted or written. Run with --apply to write.");
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runScannerTokenCommand(options, providersFor(options), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
