/**
 * Scripts — the publish command's calls to wrangler
 *
 * This module deals with the two things `publish start` and `publish
 * status` ask of wrangler: one D1 statement, and starting the publish
 * workflow. `publishWrangler(target)` returns both, each run as one
 * wrangler process, node running wrangler's own `cli.js`
 * (`wranglerCliPath`, as the export does), and never sent twice.
 *
 *   `d1(sql)`     `d1 execute <database> … --remote --json --command
 *                 <sql>`, with the target's database and flags from
 *                 `d1Args` (`fisqua-db`, or `fisqua-staging-db` with
 *                 `--env staging`); it returns the first result set's
 *                 rows and the `changes` wrangler reports for it.
 *   `trigger(…)`  `workflows trigger <name> <params> --id <run id>`, with
 *                 `--env staging` on staging as `d1Args` passes it. The
 *                 workflow names are account-wide, so the name chooses
 *                 the Worker that runs it (`publish-export` on
 *                 `fisqua`, `publish-export-staging` on
 *                 `fisqua-staging`); a name that is not the target's is
 *                 refused before wrangler is started.
 *   `describe(…)` `workflows instances describe <name> <run id>` (the id
 *                 always given, never wrangler's default `latest`), after a
 *                 trigger that failed: `exists` when wrangler answers,
 *                 `absent` only when its output, colour codes removed,
 *                 holds `instance.not_found` or `[code: 10400]`
 *                 (`INSTANCE_ABSENT`), `unknown` for any other failure,
 *                 so the run is closed only on a clear answer.
 *
 * `CLOUDFLARE_ENV` is removed from wrangler's environment, so only the
 * flags above choose the environment. Each process is started in its
 * own process group, so a Ctrl-C reaches this command alone and the
 * statement or trigger in flight finishes; the command stops after it.
 * A failure is thrown with wrangler's own code and text
 * (`wranglerFailure`), so an overload reads as `[code: 7429]`.
 *
 * The exec and the path of `cli.js` are injectable, so the tests check
 * the arguments without a subprocess.
 *
 * @version v0.9.0
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { wranglerFailure } from "../d1-cli";
import { wranglerCliPath } from "../export-cli/d1";
import { d1Args } from "../tenant-storage";
import { PUBLISH_WORKFLOWS, type D1Answer, type Target } from "./run";

/** Runs a command and resolves with its stdout, or rejects with an error carrying `stdout` and `stderr`. */
export type PublishExec = (command: string, args: string[], env: Record<string, string | undefined>) => Promise<string>;

const defaultExec: PublishExec = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => reject(Object.assign(err, { stdout, stderr })));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`wrangler exited with ${code ?? signal}`), { stdout, stderr, status: code }));
    });
  });

/**
 * Wrangler's answer when a workflow instance does not exist, as wrangler
 * 4.71.0 prints it: `workflows.api.error.instance.not_found [code: 10400]`.
 */
export const INSTANCE_ABSENT = /instance\.not_found|\[code: 10400\]/;

/** Terminal colour and cursor codes, removed before wrangler's output is read. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Everything a failed exec printed, without colour codes. */
const rawOutput = (err: unknown) => {
  const e = (err ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const text = (v: unknown) => (typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString("utf8") : "");
  return [text(e.stdout), text(e.stderr), text(e.message)].join("\n").replace(ANSI, "");
};

const failureText = (err: unknown) => {
  const f = wranglerFailure(err);
  return `${f.code === null ? "" : `[code: ${f.code}] `}${f.text}`;
};

/** The D1 runner and workflow trigger for `target`. */
export function publishWrangler(target: Target, exec: PublishExec = defaultExec, cli: string = wranglerCliPath()) {
  const base = ["--no-warnings", "--experimental-vm-modules", cli];
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLOUDFLARE_ENV;
  const envFlags = target === "staging" ? ["--env", "staging"] : [];
  const own = (workflow: string) => {
    if (workflow !== PUBLISH_WORKFLOWS[target]) throw new Error(`${workflow} is not ${target}'s publish workflow`);
  };
  return {
    d1: async (sql: string): Promise<D1Answer> => {
      let out: string;
      try {
        out = await exec(process.execPath, [...base, ...d1Args(target).slice(1), "--json", "--command", sql], env);
      } catch (err) {
        throw new Error(`wrangler d1 execute failed ${failureText(err)}`);
      }
      const start = out.search(/[[{]/);
      if (start < 0) throw new Error(`wrangler produced no JSON output: ${out.slice(0, 200)}`);
      const parsed = JSON.parse(out.slice(start)) as Array<{ results?: Record<string, unknown>[]; meta?: { changes?: unknown } }>;
      const changes = parsed[0]?.meta?.changes;
      return { results: parsed[0]?.results ?? [], changes: typeof changes === "number" ? changes : null };
    },
    trigger: async (workflow: string, params: string, id: string): Promise<string> => {
      own(workflow);
      const args = [...base, "workflows", "trigger", workflow, params, "--id", id, ...envFlags];
      try {
        return await exec(process.execPath, args, env);
      } catch (err) {
        throw new Error(failureText(err));
      }
    },
    describe: async (workflow: string, id: string): Promise<"exists" | "absent" | "unknown"> => {
      own(workflow);
      if (!id) throw new Error("describe needs the instance id");
      const args = [...base, "workflows", "instances", "describe", workflow, id, ...envFlags];
      try {
        await exec(process.execPath, args, env);
        return "exists";
      } catch (err) {
        return INSTANCE_ABSENT.test(rawOutput(err)) ? "absent" : "unknown";
      }
    },
  };
}

// @version v0.9.0
