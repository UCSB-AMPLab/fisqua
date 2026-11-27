/**
 * Scripts — the arguments of the command line's capture verbs
 *
 * This module deals with what `fisqua capture` takes on the command line
 * and how a capture file is read. The noun has three verbs, each with
 * `plan` and `apply`:
 *
 *   `capture qc-decisions plan|apply <list.tsv|list.json> --target
 *    staging|production --tenant <slug> --actor-email <email> [--revise]
 *    [--confirm-production]`
 *       records capture QC decisions from a list (`./qc-decisions.ts`);
 *   `capture register plan|apply <manifest.json> --target
 *    staging|production --tenant <slug> --actor-email <email>
 *    [--allow-captured] [--confirm-production]`
 *       registers the volumes of a Captua capture manifest
 *       (`./register.ts`);
 *   `capture copy-renamed plan|apply <rename-map.json> --tenant <slug>
 *    [--source-record staging|production]`, `apply` with
 *    `--confirm-production`
 *       copies pre-contract captures within B2 under contract names
 *       (`./copy-renamed.ts`).
 *
 * `parseCaptureArgs` refuses an unknown verb, an unknown flag, a flag of
 * another verb, a missing value and a missing file, and refuses
 * `--allow-captured` with `--target production`, as the registration
 * command refused it. Whether an apply to production is confirmed is
 * not checked here: each verb checks it with the engine's one check,
 * `assertProductionConfirmed` (`../cli/run-file.ts`), before anything is
 * read. `copy-renamed` writes nothing to D1 but writes the federation's
 * masters bucket, which serves both environments, so every
 * `copy-renamed apply` needs `--confirm-production`, whatever
 * `--source-record` names.
 *
 * `readCaptureJson` reads a JSON capture file as the other nouns read a
 * change file (`readChangeFile`: bytes decoded as UTF-8 in fatal mode, a
 * leading BOM dropped), so a file in another encoding stops the run
 * before anything is read from D1 or B2, and then parses it, refusing a
 * file that is not JSON whole.
 *
 * @version v0.9.0
 */

import { readChangeFile, type Target } from "../cli/run-file";

export type CaptureVerb = "qc-decisions" | "register" | "copy-renamed";

interface CommonArgs {
  command: "plan" | "apply";
  file: string;
  tenant: string;
  confirmProduction: boolean;
}

export interface QcDecisionsArgs extends CommonArgs {
  verb: "qc-decisions";
  target: Target;
  actorEmail: string;
  revise: boolean;
}

export interface RegisterArgs extends CommonArgs {
  verb: "register";
  target: Target;
  actorEmail: string;
  allowCaptured: boolean;
}

export interface CopyRenamedArgs extends CommonArgs {
  verb: "copy-renamed";
  sourceRecord: Target;
}

export type CaptureArgs = QcDecisionsArgs | RegisterArgs | CopyRenamedArgs;

const USAGE = [
  "Usage:",
  "  fisqua capture qc-decisions plan|apply <list> --target staging|production --tenant <slug> --actor-email <email> [--revise] [--confirm-production]",
  "  fisqua capture register plan|apply <manifest.json> --target staging|production --tenant <slug> --actor-email <email> [--allow-captured] [--confirm-production]",
  "  fisqua capture copy-renamed plan <rename-map.json> --tenant <slug> [--source-record staging|production]",
  "  fisqua capture copy-renamed apply <rename-map.json> --tenant <slug> [--source-record staging|production] --confirm-production",
].join("\n");

/** The flags each verb takes, besides the file. */
const FLAGS: Record<CaptureVerb, { values: string[]; switches: string[] }> = {
  "qc-decisions": { values: ["--target", "--tenant", "--actor-email"], switches: ["--revise", "--confirm-production"] },
  register: { values: ["--target", "--tenant", "--actor-email"], switches: ["--allow-captured", "--confirm-production"] },
  "copy-renamed": { values: ["--tenant", "--source-record"], switches: ["--confirm-production"] },
};

/** `capture <verb> plan|apply <file> ...`, as the module header gives each verb. */
export function parseCaptureArgs(argv: string[]): CaptureArgs {
  const [noun, verb, command, ...rest] = argv;
  if (noun !== "capture") throw new Error(USAGE);
  if (verb !== "qc-decisions" && verb !== "register" && verb !== "copy-renamed") throw new Error(USAGE);
  if (command !== "plan" && command !== "apply") throw new Error(`capture ${verb} takes plan or apply`);
  const allowed = FLAGS[verb];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  let file = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (allowed.switches.includes(a)) switches.add(a);
    else if (allowed.values.includes(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      values.set(a, v);
    } else if (!a.startsWith("--") && !file) file = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!file) throw new Error(`capture ${verb} needs a file`);
  const tenant = values.get("--tenant") ?? "";
  if (!tenant) throw new Error("--tenant <slug> is required");
  const common = { command, file, tenant, confirmProduction: switches.has("--confirm-production") } as const;

  if (verb === "copy-renamed") {
    const sourceRecord = values.get("--source-record") ?? "production";
    if (sourceRecord !== "production" && sourceRecord !== "staging") throw new Error("--source-record is production or staging");
    return { verb, ...common, sourceRecord };
  }
  const target = values.get("--target");
  if (target !== "staging" && target !== "production") throw new Error("--target is staging or production");
  const actorEmail = values.get("--actor-email") ?? "";
  if (!actorEmail) throw new Error("--actor-email is required");
  if (verb === "qc-decisions") return { verb, ...common, target, actorEmail, revise: switches.has("--revise") };
  const allowCaptured = switches.has("--allow-captured");
  if (allowCaptured && target === "production") {
    throw new Error("--allow-captured is for staging tests and is refused against production");
  }
  return { verb, ...common, target, actorEmail, allowCaptured };
}

/**
 * A JSON capture file's value: read as strict UTF-8 (`readChangeFile`),
 * then parsed; `stop` makes the error for a file that is not JSON.
 */
export function readCaptureJson(
  file: string,
  what: string,
  stop: (message: string) => Error,
  readBytes?: (file: string) => Uint8Array,
): unknown {
  const text = readChangeFile(file, readBytes);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw stop(`The ${what} ${file} is not readable JSON: ${(err as Error).message}`);
  }
}

// @version v0.9.0
