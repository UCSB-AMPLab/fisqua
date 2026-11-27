#!/usr/bin/env npx tsx
/**
 * Fisqua — the Command Line
 *
 * This script is Fisqua's command line: one command for bulk changes to
 * catalogue data, each read from a reviewed file, checked against D1 and
 * written as one unit, and for read-only exports, for starting a publish
 * run, and for the files a Captua capture appliance hands over. Six nouns:
 *
 *   authorities   function rows, record fields and merges of entities,
 *                 new entities, document links, place links and
 *                 relations, new places, place fields and place merges,
 *                 moves, removals and field changes of description
 *                 links, removals of relations, and deletes of entities
 *                 and places that nothing names, from one
 *                 change file with one row per operation, so that a split
 *                 of an entity is written as create-entity, move-link and
 *                 update-entity rows (`scripts/lib/authorities-cli/`);
 *   descriptions  new descriptions and fields of descriptions (any field
 *                 the description editor's save changes but the level and
 *                 the digital flag), one row per record created or field
 *                 changed, written as the editor's create and save write
 *                 them; a description's own image manifest, made from
 *                 canvases of published manifests; former reference codes;
 *                 and deletes of descriptions joined into another
 *                 (`scripts/lib/descriptions-cli/`);
 *   export        a fonds' descriptions, its entity or place links, or the
 *                 federation's pool of authorities, read into CSV files
 *                 under fixed load limits (`scripts/lib/export-cli/`);
 *   publish       a publish run started as the publish page starts it,
 *                 and followed to its end, or the state of a run started
 *                 elsewhere (`scripts/lib/publish-cli/`);
 *   capture       three verbs for Captua's files: `qc-decisions`, capture
 *                 QC decisions recorded from a list as the Capture QC
 *                 screen records them; `register`, the volumes of a
 *                 capture manifest registered with the media pipeline as
 *                 the delivery endpoint registers them; and
 *                 `copy-renamed`, pre-contract captures copied within B2
 *                 under contract names from a rename map, which writes
 *                 nothing to D1 (`scripts/lib/capture-cli/`);
 *   duplicates    one verb, `rebuild`, which marks every live entity
 *                 record in `duplicate_recheck`, in batches of `--batch`
 *                 (2000 by default) with 2 s between them, so that the
 *                 job that runs every five minutes refills the table of
 *                 duplicate candidates; it takes no file and needs
 *                 `--confirm-production` against production
 *                 (`scripts/lib/duplicates-cli/`).
 *
 * `export` has no plan or apply: it only reads, one SELECT at a time, at
 * least 1 s apart, checking the sign-in page every 20 statements, waiting
 * out one overload and stopping at a second, and resuming from the
 * checkpoint in `--out`. One export runs at a time against each target:
 * the run listens on 127.0.0.1:47391 (production) or :47392 (staging)
 * from before its first read to its end, each wrangler process it starts
 * holds the same socket, and the operating system frees the port once
 * all of them have exited (`scripts/lib/export-cli/lock.ts`), so there is
 * no lock to clear. Each statement is sent by one wrangler process, node
 * running wrangler's `cli.js` without npx (`scripts/lib/export-cli/d1.ts`),
 * and never retried by the runner itself; the Worker version in its
 * summary is the latest deployment `wrangler deployments list` reports.
 *
 * `publish` has no plan or apply either. `publish start` checks what
 * `POST /api/publish` checks, inserts the run with the API's own
 * conditional statement, starts the target's workflow with the run id
 * as its instance id (`wrangler workflows trigger`), and reads the run
 * row every 30 s until it ends; `publish status` reads one run of the
 * tenant. Against production `start` needs `--confirm-production` and
 * is refused while any run there is live. Ctrl-C stops the following,
 * not the run. Each command writes its summary to `.import/publish_
 * <target>_<stamp>-<suffix>.json` and `.md`.
 *
 * The file, the checks, the guards, what is written and how a run is
 * verified are in each noun's folder; what the nouns share is in
 * `scripts/lib/cli/run-file.ts`.
 *
 *   plan   reads D1 and writes the report, `.import/<noun>_<target>_
 *          <stamp>-<suffix>.json` and `.md` (eight random hex characters
 *          after the stamp, so no two runs share a name), and creates the
 *          SQL file beside it, refusing to replace one; it writes nothing
 *          to D1.
 *   apply  plans, checks that the SQL file on disk hashes to the SQL the
 *          run planned, uploads the image manifests a descriptions file
 *          builds that differ from what their address holds (`wrangler
 *          r2 object put` to the federation's `manifest_bucket`, each
 *          fetched back from its public address; nothing is ever deleted
 *          from the bucket), applies the SQL file with `wrangler d1
 *          execute --file` as one unit, reads everything again and plans again; the
 *          command exits 1 when anything planned does not read back, or
 *          the second plan finds anything to write. Against production it
 *          also needs `--confirm-production`.
 *
 * A run made again writes nothing and reports every row it wrote as already done.
 * Any refusal stops the run before anything is written. `.import/` is
 * never committed.
 *
 * `capture qc-decisions` and `capture register` take `plan` and `apply`
 * as above, the verb before them (`capture register plan <file> ...`);
 * their SQL files open with guards that the tenant and the acting user
 * are as the plan read them. `capture copy-renamed plan` writes only its
 * report; its `apply` copies into the federation's masters bucket, which
 * serves both environments, and so always needs `--confirm-production`,
 * whichever database `--source-record` names (production by default).
 *
 * Who acts, in every noun that takes `--tenant` and `--actor-email`: a
 * user of the tenant, a platform admin, or the workspace admin of the
 * lead tenant of the tenant's federation, acting on a member of it; no
 * one else. Each noun then checks the rights its writes need, and its
 * report records which of the three the user acted as.
 *
 * The change file must be UTF-8 (a BOM is allowed); a file in another
 * encoding stops the run before anything is read from D1.
 *
 * A stop or a refusal prints its message alone. An error of the language
 * itself (a `RangeError`, `TypeError`, `ReferenceError` or `SyntaxError`)
 * is a fault in the command, not in the file, and prints its stack, so
 * the line that threw is known from the run that hit it.
 *
 * Credentials: wrangler's own login, for D1, R2 and Workflows; for `capture
 * register` and `capture copy-renamed`, B2_APPLICATION_KEY_ID and
 * B2_APPLICATION_KEY in the operator's environment (a key that can list
 * the masters bucket, or read and write both buckets of a rename map).
 * `capture register plan` without them reports the inventory unchecked.
 *
 * Usage:
 *   npx tsx scripts/fisqua.ts authorities plan <file> --target staging --tenant <slug> --actor-email <email>
 *   npx tsx scripts/fisqua.ts authorities apply <file> --target staging --tenant <slug> --actor-email <email>
 *   npx tsx scripts/fisqua.ts authorities apply <file> --target production ... --confirm-production
 *   npx tsx scripts/fisqua.ts descriptions plan <file> --target staging --tenant <slug> --actor-email <email>
 *   npx tsx scripts/fisqua.ts descriptions apply <file> --target production ... --confirm-production
 *   npx tsx scripts/fisqua.ts export descriptions --target staging --tenant <slug> --fonds <reference code> --out <dir>
 *   npx tsx scripts/fisqua.ts export entity-links|place-links --target staging --tenant <slug> --fonds <code> --out <dir>
 *   npx tsx scripts/fisqua.ts export pool --target production --tenant <slug> --fonds <code> [--fonds <code> ...] \
 *     --out <dir> --confirm-production
 *   npx tsx scripts/fisqua.ts publish start --target staging --tenant <lead slug> --actor-email <email> \
 *     --all-fonds --all-types [--force]
 *   npx tsx scripts/fisqua.ts publish start --target production --tenant <lead slug> --actor-email <email> \
 *     --fonds <code>,<code> --types descriptions,repositories --confirm-production
 *   npx tsx scripts/fisqua.ts publish status <run id> --target staging --tenant <lead slug> [--follow]
 *   npx tsx scripts/fisqua.ts capture qc-decisions plan <list.tsv> --target staging --tenant <slug> --actor-email <email> [--revise]
 *   npx tsx scripts/fisqua.ts capture qc-decisions apply <list.tsv> --target production ... --confirm-production
 *   npx tsx scripts/fisqua.ts capture register plan <manifest.json> --target staging --tenant <slug> --actor-email <email> \
 *     [--allow-captured]
 *   npx tsx scripts/fisqua.ts capture register apply <manifest.json> --target production ... --confirm-production
 *   npx tsx scripts/fisqua.ts capture copy-renamed plan <rename-map.json> --tenant <slug> [--source-record staging]
 *   npx tsx scripts/fisqua.ts capture copy-renamed apply <rename-map.json> --tenant <slug> [--source-record staging] --confirm-production
 *   npx tsx scripts/fisqua.ts duplicates rebuild --target staging [--batch 2000]
 *   npx tsx scripts/fisqua.ts duplicates rebuild --target production --confirm-production
 *
 * @version v0.9.0
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { b2FromEnv, d1Args, execCommand, wranglerD1, type CommandRunner } from "./lib/tenant-storage";
import { MANIFEST_CONTENT_TYPE } from "../app/lib/pipeline/canonical.server";
import { exportD1 } from "./lib/export-cli/d1";
import { parseExportArgs, runExport, type Target as ExportTarget } from "./lib/export-cli/run";
import { RegistrationStop, wranglerRows } from "./lib/capture-registration";
import { parseCaptureArgs, readCaptureJson } from "./lib/capture-cli/run";
import { runCaptureQcDecisions } from "./lib/capture-cli/qc-decisions";
import { runCaptureRegister } from "./lib/capture-cli/register";
import { runCaptureCopyRenamed } from "./lib/capture-cli/copy-renamed";
import { parseDuplicatesArgs, runDuplicatesRebuild } from "./lib/duplicates-cli/run";
import { parseChangeFile } from "./lib/authorities-cli/change-file";
import { exitCodeOf, parseAuthoritiesArgs, runAuthorities } from "./lib/authorities-cli/run";
import {
  InterruptGate,
  parsePublishArgs,
  publishExitCode,
  runPublishStart,
  runPublishStatus,
  type PublishProviders,
} from "./lib/publish-cli/run";
import { publishWrangler } from "./lib/publish-cli/wrangler";
import { readChangeFile, type CliArgs, type RunProviders } from "./lib/cli/run-file";
import { parseDescriptionChangeFile } from "./lib/descriptions-cli/change-file";
import {
  exitCodeOf as descriptionsExitCodeOf,
  parseDescriptionsArgs,
  runDescriptions,
} from "./lib/descriptions-cli/run";

const runWrangler: CommandRunner = (command, args, opts) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input: opts.input,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });

function providersFor(args: Pick<CliArgs, "target">): RunProviders {
  return {
    rows: wranglerRows(args.target, runWrangler),
    writeFile: (out, text) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
    },
    // The SQL file is created, never replaced: a file of that name stops the run.
    createFile: (out, text) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, { encoding: "utf8", flag: "wx" });
    },
    readFile: (file) => fs.readFileSync(file, "utf8"),
    newId: () => randomUUID(),
    // The file is applied with wrangler's own output and prompts on the terminal.
    applyFile: (sqlFile) => {
      execFileSync("npx", [...d1Args(args.target), `--file=${sqlFile}`, "--yes"], { stdio: "inherit" });
    },
    now: () => Date.now(),
  };
}

/** The latest deployment's version ids, or null when wrangler does not answer. */
function workerVersion(target: ExportTarget): string | null {
  try {
    const out = execFileSync("npx", ["wrangler", "deployments", "list", "--json", ...(target === "staging" ? ["--env", "staging"] : [])], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const deployments = JSON.parse(out.slice(out.search(/[[{]/))) as Array<{
      id: string;
      created_on: string;
      versions?: Array<{ version_id: string; percentage: number }>;
    }>;
    const latest = [...deployments].sort((a, b) => (a.created_on < b.created_on ? 1 : -1))[0];
    if (!latest) return null;
    const versions = (latest.versions ?? []).map((v) => `${v.version_id} (${v.percentage}%)`).join(", ");
    return `${versions} (deployment ${latest.id}, ${latest.created_on})`;
  } catch {
    return null;
  }
}

/**
 * The publish command's providers. The first Ctrl-C ends the wait between
 * reads and stops the command after the statement in flight; a second
 * one exits at once, except from the insert until the workflow has
 * started, when presses wait for that to return (`InterruptGate`).
 */
function publishProviders(target: "staging" | "production", log: (line: string) => void): PublishProviders {
  const wrangler = publishWrangler(target);
  const gate = new InterruptGate();
  let wake: (() => void) | null = null;
  process.on("SIGINT", () => {
    const action = gate.press();
    if (action === "exit") process.exit(130);
    log(
      action === "deferred"
        ? "\nCtrl-C: the run is being inserted and its workflow started; the command stops once that has returned."
        : "\nCtrl-C: stopping after the statement in flight. Ctrl-C again exits at once, whatever is in flight.",
    );
    wake?.();
  });
  return {
    d1: wrangler.d1,
    trigger: wrangler.trigger,
    describe: wrangler.describe,
    hold: (fn) => gate.hold(fn),
    fetch: async (url) => {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      return { status: res.status };
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        const timer = setTimeout(done, ms);
        wake = done;
      }),
    interrupted: () => gate.interrupted(),
    now: () => Date.now(),
    newId: () => randomUUID(),
    writeFile: (out, text) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
    },
    log,
  };
}

/** `fisqua capture <verb> plan|apply <file> ...`; a refusal throws, and the shell exits 1. */
async function capture(argv: string[], log: (line: string) => void): Promise<void> {
  const args = parseCaptureArgs(argv);
  const apply = args.command === "apply";
  const stop = (message: string) => new RegistrationStop(message);
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  if (args.verb === "qc-decisions") {
    await runCaptureQcDecisions(
      { file: path.basename(args.file), text: readChangeFile(args.file) },
      { target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, apply, confirmProduction: args.confirmProduction, revise: args.revise },
      providersFor(args),
      log,
    );
    if (!apply) log("\nPlan only: nothing was written to D1. Run `capture qc-decisions apply` to write.");
    return;
  }
  if (args.verb === "register") {
    await runCaptureRegister(
      { file: path.basename(args.file), raw: readCaptureJson(args.file, "capture manifest", stop) },
      { target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, apply, confirmProduction: args.confirmProduction, allowCaptured: args.allowCaptured },
      { ...providersFor(args), d1: wranglerD1(args.target, execCommand), b2: b2FromEnv(process.env, fetchImpl) },
      log,
    );
    if (!apply) log("\nPlan only: nothing was written to D1. Run `capture register apply` to write.");
    return;
  }
  const writeFile = (out: string, text: string) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text, "utf8");
  };
  await runCaptureCopyRenamed(
    { file: path.basename(args.file), raw: readCaptureJson(args.file, "rename map", stop) },
    { tenant: args.tenant, sourceRecord: args.sourceRecord, apply, confirmProduction: args.confirmProduction },
    {
      // The tenant and its federation's record; read only.
      d1: wranglerD1(args.sourceRecord, execCommand),
      b2: b2FromEnv(process.env, fetchImpl),
      writeFile,
      newId: () => randomUUID(),
      now: () => Date.now(),
    },
    log,
  );
  if (!apply) log("\nPlan only: nothing was copied. Run `capture copy-renamed apply` to copy.");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (line: string) => console.log(line);
  if (argv[0] === "capture") {
    await capture(argv, log);
    return;
  }
  if (argv[0] === "publish") {
    const args = parsePublishArgs(argv);
    const providers = publishProviders(args.target, log);
    const result = args.command === "start" ? await runPublishStart(args, providers) : await runPublishStatus(args, providers);
    process.exitCode = publishExitCode(result);
    return;
  }
  if (argv[0] === "duplicates") {
    await runDuplicatesRebuild({ ...parseDuplicatesArgs(argv), log });
    return;
  }
  if (argv[0] === "export") {
    const args = parseExportArgs(argv);
    const result = await runExport(args, {
      d1: exportD1(args.target),
      fetch: async (url) => {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        return { status: res.status };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      workerVersion: () => workerVersion(args.target),
      log,
    });
    process.exitCode = result.outcome === "complete" ? 0 : 1;
    return;
  }
  if (argv[0] === "descriptions") {
    const args = parseDescriptionsArgs(argv);
    const file = path.basename(args.file);
    const apply = args.command === "apply";
    const report = await runDescriptions(
      { file, rows: parseDescriptionChangeFile(readChangeFile(args.file), file) },
      { target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, apply, confirmProduction: args.confirmProduction },
      {
        ...providersFor(args),
        // A manifest's address, read without a cache.
        fetchManifest: async (url) => {
          const res = await fetch(url, { cache: "no-store", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
          return res.status === 200 ? { status: 200, text: await res.text() } : { status: res.status };
        },
        // Only an apply puts; the file holds exactly the bytes the run built.
        putObject: (bucket, key, _body, file) => {
          execFileSync(
            "npx",
            ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", MANIFEST_CONTENT_TYPE, "--remote"],
            { stdio: "inherit" },
          );
        },
      },
      log,
    );
    if (!apply && report.outcome === "dry run") console.log("\nPlan only: nothing was written to D1. Run `descriptions apply` to write.");
    process.exitCode = descriptionsExitCodeOf(report);
    return;
  }
  const args = parseAuthoritiesArgs(argv);
  const file = path.basename(args.file);
  const apply = args.command === "apply";
  const report = await runAuthorities(
    { file, rows: parseChangeFile(readChangeFile(args.file), file) },
    { target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, apply, confirmProduction: args.confirmProduction },
    providersFor(args),
    log,
  );
  if (!apply && report.outcome === "dry run") console.log("\nPlan only: nothing was written to D1. Run `authorities apply` to write.");
  process.exitCode = exitCodeOf(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const fault = err instanceof RangeError || err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError;
    console.error(fault ? (err as Error).stack : (err as Error).message);
    process.exit(1);
  });
}

// @version v0.9.0
