#!/usr/bin/env npx tsx
/**
 * Capture Registration — Register the Volumes of a Captua Capture Manifest
 *
 * A capture appliance (Captua) shoots each volume of a digitisation list
 * and uploads the images to the tenant's part of its federation's
 * masters bucket, under `{slug}/{stem}/`. When a batch is ready for
 * review it writes a capture manifest: one JSON file listing each
 * volume, its records (one opening each) and every image's object key
 * and SHA-256. This command reads that file and registers the volumes
 * with the media pipeline, so they can be dispatched: one pipeline
 * volume per handed-over volume, in state `received`, and one page per
 * image of every record under review or approved, with the digest the
 * runner checks when it pulls the file. Each volume's manifest is
 * recorded as a capture delivery with route `file`, as one a unit sends
 * over the link is, so the volume goes through capture QC and is held
 * from processing until every opening is approved. A file with one
 * volume records it under the manifest's id; in a file with several,
 * each volume's delivery id is derived from the manifest's id and the
 * volume's stem. It runs on the operator's machine.
 *
 * It refuses the whole file when the envelope or the shape is wrong,
 * and stops when the tenant's federation has no complete storage record
 * or the manifest's transfer root is not `{slug}/`. Volumes it cannot
 * register are reported and left alone: one created on the appliance
 * without a reference code (unmatched), one whose reference code is not
 * a description of the tenant, one with a record still `captured`, one
 * already registered and past `received`, held by an open run or named
 * by any run, and one whose pages or objects fail a check. A volume already registered
 * and still `received` has its page list replaced, as for a retake. A
 * volume whose delivery is already recorded from this same file is
 * reported as already registered and written again by nothing, so the
 * file can be applied again; one whose delivery id was recorded from a
 * different body is refused, and the file's other volumes go on.
 *
 * It lists the masters bucket under each volume's prefix, names and
 * sizes only, with the operator's B2 credentials: a master object that
 * is missing rejects the volume, and objects the manifest does not name
 * are reported. Nothing is written to B2, GitHub or the Worker.
 *
 * A dry run is the default: it reads, plans and prints, and writes only
 * the report, `.import/capture-registration_<manifest id>.json`. With
 * `--apply` it also writes every registration to one SQL file,
 * `.import/capture-registration_<manifest id>.sql`, applies it with
 * `wrangler d1 execute --file`, then re-reads the volumes and prints
 * their page and digest counts and the delivery that holds each. `--apply` against production also needs
 * `--confirm-production`. `.import/` is never committed.
 *
 * Credentials, read from the operator's environment:
 *   B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY   a B2 key that can list the masters bucket
 *   wrangler's own login                         D1 (staging, production)
 * A dry run without the B2 pair prints the inventory as unchecked;
 * `--apply` needs it.
 *
 * Usage:
 *   npx tsx scripts/commands/register-capture-volumes.ts --manifest <file.json> --tenant sbmal --target staging
 *   npx tsx scripts/commands/register-capture-volumes.ts --manifest <file.json> --tenant sbmal --target staging --apply
 *
 * `--target` picks the database: `local`, `staging` (`--env staging`) or
 * `production`. `--allow-captured` registers volumes whose records are
 * still `captured`, taking their images as pages, for a test of the
 * pipeline on staging before the archive hands a volume over; it is
 * refused against production.
 *
 * @version v0.8.0
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { b2FromEnv, d1Args, execCommand, wranglerD1, type Target } from "../lib/tenant-storage";
import {
  parseCaptureManifest,
  registerCaptureVolumes,
  RegistrationStop,
  wranglerRows,
  type RegistrationProviders,
  type RegistrationReport,
} from "../lib/capture-registration";
import { bodyDigest } from "../../app/lib/capture/token";

export interface CaptureCliOptions {
  manifest: string;
  tenant: string;
  target: Target;
  apply: boolean;
  confirmProduction: boolean;
  allowCaptured: boolean;
}

export function parseArgs(argv: string[]): CaptureCliOptions {
  let manifest = "";
  let tenant = "";
  let target: string | null = null;
  let apply = false;
  let confirmProduction = false;
  let allowCaptured = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--apply") apply = true;
    else if (a === "--confirm-production") confirmProduction = true;
    else if (a === "--allow-captured") allowCaptured = true;
    else if (a === "--manifest") manifest = value();
    else if (a === "--tenant") tenant = value();
    else if (a === "--target") target = value();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!manifest) throw new Error("--manifest is required");
  if (!tenant) throw new Error("--tenant is required");
  if (target !== "local" && target !== "staging" && target !== "production") {
    throw new Error("--target is required (local, staging or production)");
  }
  if (apply && target === "production" && !confirmProduction) {
    throw new Error("--apply against production also needs --confirm-production");
  }
  if (allowCaptured && target === "production") {
    throw new Error("--allow-captured is for staging tests and is refused against production");
  }
  return { manifest, tenant, target, apply, confirmProduction, allowCaptured };
}

/** Reads the manifest file as JSON; a file that is not JSON is refused whole. */
function readManifestJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new RegistrationStop(`The capture manifest ${file} is not readable JSON: ${(err as Error).message}`);
  }
}

/** Reads and parses the manifest file; a file that is not JSON is refused whole. */
export function readManifest(file: string) {
  return parseCaptureManifest(readManifestJson(file));
}

function providersFor(options: CaptureCliOptions, env: NodeJS.ProcessEnv): RegistrationProviders {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return {
    d1: wranglerD1(options.target, execCommand),
    rows: wranglerRows(options.target, execCommand),
    b2: b2FromEnv(env, fetchImpl),
    writeFile: (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    },
    // The file is applied with wrangler's own output and prompts on the terminal.
    applyFile: (file) => {
      execFileSync("npx", [...d1Args(options.target), `--file=${file}`], { stdio: "inherit" });
    },
    now: () => Date.now(),
    newId: () => randomUUID(),
  };
}

/** Runs the command with the options and providers given. */
export async function runCaptureCommand(
  options: CaptureCliOptions,
  providers: RegistrationProviders,
  log: (line: string) => void,
): Promise<RegistrationReport> {
  const raw = readManifestJson(options.manifest);
  const manifest = parseCaptureManifest(raw);
  const report = await registerCaptureVolumes(
    manifest,
    {
      slug: options.tenant,
      target: options.target,
      apply: options.apply,
      allowCaptured: options.allowCaptured,
      // The body's digest as the link takes it, so the same document sent
      // over the link with the same id gets the same answer.
      bodySha256: await bodyDigest(raw),
    },
    providers,
    log,
  );
  if (!options.apply) log("\nDry run: nothing was written to D1. Run with --apply to write.");
  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runCaptureCommand(options, providersFor(options, process.env), (line) => console.log(line));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}

// @version v0.8.0
