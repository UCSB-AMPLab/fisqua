/**
 * Tests — the deploy scripts choose the environment at build time
 *
 * This suite checks that the deploy scripts choose the environment at
 * build time. A production build records no target environment, so
 * wrangler ignores `--env` when it deploys that build and `npm run deploy
 * -- --env staging` would deploy the production Worker. The suite checks
 * that `deploy` and `deploy:staging` both go through scripts/deploy.mjs
 * with their target named, and that the script refuses, before it builds
 * anything, an `--env` flag, a production deploy while `CLOUDFLARE_ENV` is
 * set, and every wrangler flag outside its allowlist — `--name`,
 * `-c`/`--config`, `--cwd` and `--script` would each deploy a
 * configuration or Worker other than the one it checks.
 *
 * The migrations gate runs the script for real against a copy of it in a
 * temporary directory, with a stub `npm` on PATH that writes the built
 * configuration and a stub wrangler beside it that records each call and
 * prints the `d1 migrations list` output the test chose, or each of a
 * sequence of outputs in turn, so a check that fails and then passes can
 * be run. The waits between attempts are set to zero through
 * FISQUA_DEPLOY_CHECK_WAITS_MS. Nothing reaches Cloudflare.
 *
 * The export-run gate runs the same way: the stub answers each `d1
 * execute` call with the next of the outputs the test chose (by default
 * a count of 0), and the suite checks that the script counts the pending
 * and running export runs on the target's database after the migrations
 * check, deploys only on a count of 0, and refuses on any other count,
 * on a failed query (naming the overload on a 7429) and on output it
 * cannot read.
 *
 * The production read lock: the sandbox holds a stand-in for
 * `scripts/lib/d1-production-lock-run.mjs` that records its arguments and
 * either exits with a code the test chose or runs the command, and a
 * stand-in for wrangler's `cli.js` beside the bin. The suite checks that
 * both production checks go through the helper with runD1's port, time
 * limit, pacing file and gap and run `cli.js`, that a held port is waited
 * for without counting as an attempt, that a check stopped at the time
 * limit refuses at once, and that staging runs the bin with no helper.
 * The real port is never bound here.
 *
 * @version v0.9.0
 */
import { afterEach, describe, it, expect } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  LOCK_BUSY_EXIT,
  LOCK_POLL_MS,
  LOCK_TIMEOUT_EXIT,
  PRODUCTION_ATTEMPT_TIMEOUT_MS,
  PRODUCTION_LOCK_PORT,
  PRODUCTION_READ_GAP_MS,
} from "../../scripts/lib/d1-cli";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { scripts: Record<string, string> };
const script = fileURLToPath(new URL("../../scripts/deploy.mjs", import.meta.url));

function runDeploy(args: string[], env: Record<string, string | undefined> = {}) {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) childEnv[k] = v;
  if (env.CLOUDFLARE_ENV === undefined) delete childEnv.CLOUDFLARE_ENV;
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: childEnv as NodeJS.ProcessEnv, cwd: root });
}

describe("deploy scripts in package.json", () => {
  it("deploys production through scripts/deploy.mjs", () => {
    expect(pkg.scripts.deploy).toBe("node scripts/deploy.mjs production");
  });

  it("deploys staging through scripts/deploy.mjs", () => {
    expect(pkg.scripts["deploy:staging"]).toBe("node scripts/deploy.mjs staging");
  });
});

describe("scripts/deploy.mjs refusals", () => {
  it.each([["--env", "staging"], ["--env=staging"], ["-e", "staging"]])("refuses %s", (...flag) => {
    const r = runDeploy(["production", ...flag]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("deploy:staging");
    expect(r.stdout).not.toContain("react-router build");
  });

  it("refuses a production deploy while CLOUDFLARE_ENV is set", () => {
    const r = runDeploy(["production"], { CLOUDFLARE_ENV: "staging" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CLOUDFLARE_ENV=staging");
  });

  it.each([
    ["--name", "fisqua"],
    ["--name=fisqua"],
    ["-c", "wrangler.jsonc"],
    ["--config", "wrangler.jsonc"],
    ["--cwd", ".."],
    ["--script", "other.js"],
  ])("refuses %s on a staging deploy", (...flag) => {
    const r = runDeploy(["staging", ...flag]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing");
    expect(r.stdout).not.toContain("react-router build");
  });

  it.each(["WRANGLER_CI_OVERRIDE_NAME", "WRANGLER_CI_MATCH_TAG", "WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST"])(
    "refuses a staging deploy while %s is set",
    (name) => {
      const r = runDeploy(["staging"], { [name]: "fisqua" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(name);
      expect(r.stdout).not.toContain("react-router build");
    },
  );

  it("refuses --message without a value", () => {
    const r = runDeploy(["staging", "--message"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--message needs a value");
  });

  it("deploys the checked file and Worker name, with no dotenv files and an allowlisted environment", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('[wranglerBin, "deploy", "-c", builtPath, "--name", spec.workerName, "--env-file", "/dev/null", ...passthrough]');
    expect(source).toContain("env: /** @type {NodeJS.ProcessEnv} */ (wranglerEnv)");
    expect(source).not.toMatch(/"npx", \["wrangler"/);
    const allow = source.slice(source.indexOf("const WRANGLER_ENV_ALLOWLIST"), source.indexOf("];", source.indexOf("const WRANGLER_ENV_ALLOWLIST")));
    expect(allow).not.toMatch(/"WRANGLER_/);
    expect(allow).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(source).toContain("built.account_id !== ACCOUNT_ID");
  });

  it("refuses an unknown target", () => {
    const r = runDeploy(["preview"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"production" or "staging"');
  });
});

/** What the stub wrangler does for `d1 migrations list`. */
type Listing = { stdout: string; status: number; stderr?: string };

const NONE_PENDING: Listing = {
  stdout: "Resource location: remote\n\n\u2705 No migrations to apply!\n",
  status: 0,
};
const TWO_PENDING: Listing = {
  stdout:
    "Resource location: remote\n\nMigrations to be applied:\n" +
    "\u250c\u2500\u2500\u2510\n\u2502 Name \u2502\n" +
    "\u2502 0120_institution_records_licence_citations.sql \u2502\n" +
    "\u2502 0121_repository_credit_statements.sql \u2502\n\u2514\u2500\u2500\u2518\n",
  status: 0,
};

/** What the stub wrangler prints for `d1 execute --json` with the export-run count `n`. */
function exportRuns(live: number, stale = 0): Listing {
  return {
    stdout: JSON.stringify([{ results: [{ live, stale }], success: true, meta: { served_by: "test" } }], null, 2) + "\n",
    status: 0,
  };
}
const NO_EXPORT_RUNS = exportRuns(0);

/** Wrangler's answer, with --json, when D1 refuses the query as overloaded. */
const OVERLOADED: Listing = {
  stdout: JSON.stringify({
    error: {
      text: "A request to the Cloudflare API failed.",
      notes: [{ text: "D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]" }],
    },
  }) + "\n",
  status: 1,
};

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs a copy of scripts/deploy.mjs in a temporary tree with stub `npm`
 * and wrangler binaries, and returns the result with the wrangler calls.
 */
function runGated(
  target: "production" | "staging",
  listing: Listing | Listing[],
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = { FISQUA_DEPLOY_CHECK_WAITS_MS: "0,0" },
  exportCount: Listing | Listing[] = NO_EXPORT_RUNS,
  helperExits: number[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "fisqua-deploy-gate-"));
  sandboxes.push(dir);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(script, join(dir, "scripts/deploy.mjs"));
  writeFileSync(join(dir, "wrangler.jsonc"), "{}\n");
  writeFileSync(join(dir, "listing.json"), JSON.stringify(listing));
  writeFileSync(join(dir, "export-count.json"), JSON.stringify(exportCount));

  mkdirSync(join(dir, "bin"));
  const npmStub = join(dir, "bin/npm");
  writeFileSync(
    npmStub,
    `#!${process.execPath}
const { mkdirSync, writeFileSync } = require("node:fs");
const out = ${JSON.stringify(join(dir, "build/server"))};
mkdirSync(out, { recursive: true });
const staging = process.env.CLOUDFLARE_ENV === "staging";
writeFileSync(out + "/wrangler.json", JSON.stringify({
  account_id: "492ecadf9e992aecb0553ec14ebf90c7",
  name: staging ? "fisqua-staging" : "fisqua",
}));
`,
  );
  chmodSync(npmStub, 0o755);

  mkdirSync(join(dir, "scripts/lib"));
  writeFileSync(join(dir, "helper.json"), JSON.stringify(helperExits));
  // A stand-in for the production read lock helper: records its arguments, exits with the next of
  // the codes the test chose without running anything, and otherwise runs the command it was given.
  writeFileSync(
    join(dir, "scripts/lib/d1-production-lock-run.mjs"),
    `import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const log = ${JSON.stringify(join(dir, "helper.log"))};
appendFileSync(log, JSON.stringify(argv) + "\\n");
const n = readFileSync(log, "utf8").trim().split("\\n").length;
const exits = JSON.parse(readFileSync(${JSON.stringify(join(dir, "helper.json"))}, "utf8"));
if (n <= exits.length) process.exit(exits[n - 1]);
const [, , , , command, ...args] = argv;
const r = spawnSync(command, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );

  mkdirSync(join(dir, "node_modules/wrangler/bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules/wrangler/wrangler-dist"), { recursive: true });
  writeFileSync(join(dir, "node_modules/wrangler/package.json"), JSON.stringify({ name: "wrangler", main: "wrangler-dist/cli.js" }));
  const stub = `const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, JSON.stringify({ args, ci: process.env.CI, cloudflareEnv: process.env.CLOUDFLARE_ENV, via: require("node:path").basename(__filename) }) + "\\n");
if (args[0] === "d1") {
  const file = args[1] === "execute" ? "export-count.json" : "listing.json";
  const listings = [].concat(JSON.parse(readFileSync(${JSON.stringify(dir)} + "/" + file, "utf8")));
  const n = readFileSync(${JSON.stringify(join(dir, "calls.log"))}, "utf8").split("\\n").filter((l) => l.includes('"d1","' + args[1] + '"')).length;
  const listing = listings[Math.min(n, listings.length) - 1];
  process.stdout.write(listing.stdout);
  if (listing.stderr) process.stderr.write(listing.stderr);
  process.exit(listing.status);
}
`;
  writeFileSync(join(dir, "node_modules/wrangler/bin/wrangler.js"), stub);
  writeFileSync(join(dir, "node_modules/wrangler/wrangler-dist/cli.js"), stub);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WRANGLER_CI_")) env[k] = v;
  delete env.CLOUDFLARE_ENV;
  env.PATH = `${join(dir, "bin")}:${env.PATH ?? ""}`;
  env.XDG_CACHE_HOME = join(dir, "cache");
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, [join(dir, "scripts/deploy.mjs"), target, ...extraArgs], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    cwd: dir,
  });
  const log = join(dir, "calls.log");
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call)
    : [];
  const helperLog = join(dir, "helper.log");
  const helperCalls = existsSync(helperLog)
    ? readFileSync(helperLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])
    : [];
  return { ...r, calls, helperCalls, dir };
}

type Call = { args: string[]; ci?: string; cloudflareEnv?: string; via?: string };
const deployCalls = (calls: Call[]) => calls.filter((c) => c.args[0] === "deploy");
const listCalls = (calls: Call[]) => calls.filter((c) => c.args[0] === "d1" && c.args[1] === "migrations");
const countCalls = (calls: Call[]) => calls.filter((c) => c.args[0] === "d1" && c.args[1] === "execute");

describe("scripts/deploy.mjs refuses to deploy over unapplied migrations", () => {
  it("refuses while migrations are pending, names them and gives the command to apply them", () => {
    const r = runGated("production", TWO_PENDING);
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("0120_institution_records_licence_citations.sql");
    expect(r.stderr).toContain("0121_repository_credit_statements.sql");
    expect(r.stderr).toContain("npx wrangler d1 migrations apply fisqua-db --remote");
  });

  it("deploys when no migration is pending", () => {
    const r = runGated("production", NONE_PENDING);
    expect(r.status).toBe(0);
    const lists = listCalls(r.calls);
    expect(lists).toHaveLength(1);
    expect(lists[0].args.slice(0, 5)).toEqual(["d1", "migrations", "list", "fisqua-db", "--remote"]);
    expect(lists[0].args).toContain("--env-file");
    expect(lists[0].args).not.toContain("--env");
    expect(lists[0].ci).toBe("1");
    expect(deployCalls(r.calls)).toHaveLength(1);
  });

  it("checks before it deploys", () => {
    const r = runGated("production", NONE_PENDING);
    expect(r.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["d1 migrations", "d1 execute", "deploy -c"]);
  });

  it.each([
    ["empty output", { stdout: "", status: 0 }],
    ["an unknown message", { stdout: "Something else happened\n", status: 0 }],
    ["a pending list with no names", { stdout: "Migrations to be applied:\n\u250c\u2510\n", status: 0 }],
    ["both messages", { stdout: "\u2705 No migrations to apply!\nMigrations to be applied:\n0121_x.sql\n", status: 0 }],
  ])("refuses when the output cannot be classified (%s)", (_label, listing) => {
    const r = runGated("production", listing);
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("could not tell");
  });

  it("refuses when the check fails, even if the output looks clean", () => {
    const r = runGated("production", { stdout: NONE_PENDING.stdout, status: 1 });
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("exited with status 1");
  });

  it("checks the staging database with the staging environment", () => {
    const r = runGated("staging", NONE_PENDING);
    expect(r.status).toBe(0);
    const [list] = listCalls(r.calls);
    expect(list.args.slice(0, 5)).toEqual(["d1", "migrations", "list", "fisqua-staging-db", "--remote"]);
    expect(list.args.join(" ")).toContain("--env staging");
    expect(list.cloudflareEnv).toBe("staging");
    expect(deployCalls(r.calls)).toHaveLength(1);
  });

  it("names the staging command when staging has pending migrations", () => {
    const r = runGated("staging", TWO_PENDING);
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("npx wrangler d1 migrations apply fisqua-staging-db --remote --env staging");
  });

  it("runs the check on a dry run and refuses there too", () => {
    const r = runGated("production", TWO_PENDING, ["--dry-run"]);
    expect(r.status).toBe(1);
    expect(listCalls(r.calls)).toHaveLength(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
  });

  it("has no flag that skips the check", () => {
    for (const flag of ["--skip-migrations-check", "--force", "--no-check"]) {
      const r = runGated("production", TWO_PENDING, [flag]);
      expect(r.status).toBe(1);
      expect(r.calls).toHaveLength(0);
    }
  });
});

/** Wrangler's answer when the account check fails, which a later attempt can pass. */
const NOT_AUTHORIZED: Listing = {
  stdout: "",
  stderr: "\u2718 [ERROR] A request to the Cloudflare API failed. account not valid or not authorized [code: 7403]\n",
  status: 1,
};

describe("scripts/deploy.mjs checks the migrations again when the check fails", () => {
  it("deploys when the check fails twice and then passes, printing wrangler's error each time", () => {
    const r = runGated("production", [NOT_AUTHORIZED, NOT_AUTHORIZED, NONE_PENDING]);
    expect(r.status).toBe(0);
    expect(listCalls(r.calls)).toHaveLength(3);
    expect(deployCalls(r.calls)).toHaveLength(1);
    expect(r.stderr.match(/code: 7403/g)).toHaveLength(2);
    expect(r.stderr).toContain("checking again");
  });

  it("refuses after three failed checks and deploys nothing", () => {
    const r = runGated("production", [NOT_AUTHORIZED, NOT_AUTHORIZED, NOT_AUTHORIZED, NONE_PENDING]);
    expect(r.status).toBe(1);
    expect(listCalls(r.calls)).toHaveLength(3);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr.match(/code: 7403/g)).toHaveLength(3);
    expect(r.stderr).toContain("exited with status 1");
    expect(r.stderr).toContain("nothing was deployed");
  });

  it("checks again when the output cannot be read", () => {
    const r = runGated("production", [{ stdout: "", status: 0 }, NONE_PENDING]);
    expect(r.status).toBe(0);
    expect(listCalls(r.calls)).toHaveLength(2);
    expect(deployCalls(r.calls)).toHaveLength(1);
  });

  it("does not check again when migrations are pending", () => {
    const r = runGated("production", [TWO_PENDING, NONE_PENDING]);
    expect(r.status).toBe(1);
    expect(listCalls(r.calls)).toHaveLength(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
  });

  it("waits 20 s and then 60 s between attempts unless told otherwise", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("const DEFAULT_CHECK_WAITS_MS = [20_000, 60_000];");
  });

  it("refuses waits it cannot read", () => {
    const r = runGated("production", NONE_PENDING, [], { FISQUA_DEPLOY_CHECK_WAITS_MS: "soon" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FISQUA_DEPLOY_CHECK_WAITS_MS");
    expect(deployCalls(r.calls)).toHaveLength(0);
  });
});

describe("scripts/deploy.mjs refuses to deploy while an export run is pending or running", () => {
  it("counts the pending and running export runs on the target database after the migrations check", () => {
    const r = runGated("production", NONE_PENDING);
    expect(r.status).toBe(0);
    const counts = countCalls(r.calls);
    expect(counts).toHaveLength(1);
    expect(counts[0].args.slice(0, 4)).toEqual(["d1", "execute", "fisqua-db", "--remote"]);
    expect(counts[0].args).toContain("--json");
    expect(counts[0].args).toContain("--env-file");
    expect(counts[0].args).not.toContain("--env");
    const command = counts[0].args[counts[0].args.indexOf("--command") + 1];
    const match = command.match(
      /^SELECT COALESCE\(SUM\(CASE WHEN COALESCE\(last_heartbeat_at, started_at, created_at\) > (\d+) THEN 1 ELSE 0 END\), 0\) AS live, COALESCE\(SUM\(CASE WHEN COALESCE\(last_heartbeat_at, started_at, created_at\) > \1 THEN 0 ELSE 1 END\), 0\) AS stale FROM export_runs WHERE status IN \('pending', 'running'\)$/,
    );
    expect(match).not.toBeNull();
    // The cutoff is the publish route's window back from the moment of the check.
    const cutoff = Number(match![1]);
    expect(Math.abs(Date.now() - PUBLISH_STALE_AFTER_MS - cutoff)).toBeLessThan(60_000);
    expect(counts[0].ci).toBe("1");
    expect(deployCalls(r.calls)).toHaveLength(1);
  });

  it("counts on the staging database with the staging environment", () => {
    const r = runGated("staging", NONE_PENDING);
    expect(r.status).toBe(0);
    const [count] = countCalls(r.calls);
    expect(count.args.slice(0, 4)).toEqual(["d1", "execute", "fisqua-staging-db", "--remote"]);
    expect(count.args.join(" ")).toContain("--env staging");
    expect(count.cloudflareEnv).toBe("staging");
  });

  it("refuses while export runs are pending or running, and does not count again", () => {
    const r = runGated("production", NONE_PENDING, [], undefined, [exportRuns(2), NO_EXPORT_RUNS]);
    expect(r.status).toBe(1);
    expect(countCalls(r.calls)).toHaveLength(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("2 export run(s) pending or running on fisqua-db");
    expect(r.stderr).toContain("nothing was deployed");
  });

  it("prints wrangler's raw answer and the reason in one line when it refuses", () => {
    const counted = runGated("production", NONE_PENDING, [], undefined, exportRuns(3));
    expect(counted.stdout).toContain('"live": 3');
    const reason = counted.stderr.split("\n").filter((l) => l.startsWith("deploy: "));
    expect(reason).toHaveLength(1);
    expect(reason[0]).toContain("3 export run(s) pending or running on fisqua-db, so nothing was deployed");

    const refused = runGated("production", NONE_PENDING, [], undefined, [OVERLOADED, OVERLOADED, OVERLOADED]);
    expect(refused.stdout).toContain("[code: 7429]");
    const final = refused.stderr.split("\n").filter((l) => l.startsWith("deploy: ")).at(-1);
    expect(final).toMatch(/because D1 is overloaded \(7429\).*nothing was deployed\.$/);
  });

  it("ignores stale runs by the publish route's rule, says how many, and deploys", () => {
    const r = runGated("production", NONE_PENDING, [], undefined, exportRuns(0, 2));
    expect(r.status).toBe(0);
    expect(deployCalls(r.calls)).toHaveLength(1);
    expect(r.stderr).toContain("ignored 2 stale export run(s) on fisqua-db");
  });

  it("refuses on a live run even when stale runs are ignored", () => {
    const r = runGated("production", NONE_PENDING, [], undefined, exportRuns(1, 4));
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("ignored 4 stale export run(s) on fisqua-db");
    expect(r.stderr).toContain("1 export run(s) pending or running on fisqua-db");
  });

  it("states that an export started after the check is not fenced", () => {
    const header = readFileSync(script, "utf8").split("*/")[0].replace(/\n\s*\*\s*/g, " ");
    expect(header).toMatch(/export run started between this check and the deploy is not fenced/);
  });

  it("refuses on staging too", () => {
    const r = runGated("staging", NONE_PENDING, [], undefined, exportRuns(1));
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("1 export run(s) pending or running on fisqua-staging-db");
  });

  it("refuses when the count stays refused as overloaded, and says so", () => {
    const r = runGated("production", NONE_PENDING, [], undefined, [OVERLOADED, OVERLOADED, OVERLOADED]);
    expect(r.status).toBe(1);
    expect(countCalls(r.calls)).toHaveLength(3);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("D1 is overloaded (7429)");
    expect(r.stderr).toContain("nothing was deployed");
  });

  it("deploys when the count fails and then answers 0", () => {
    const r = runGated("production", NONE_PENDING, [], undefined, [OVERLOADED, NO_EXPORT_RUNS]);
    expect(r.status).toBe(0);
    expect(countCalls(r.calls)).toHaveLength(2);
    expect(deployCalls(r.calls)).toHaveLength(1);
    expect(r.stderr).toContain("checking again");
  });

  it.each([
    ["empty output", { stdout: "", status: 0 }],
    ["text that is not JSON", { stdout: "n\n0\n", status: 0 }],
    ["no results", { stdout: JSON.stringify([{ results: [], success: true }]), status: 0 }],
    ["a count that is not a number", { stdout: JSON.stringify([{ results: [{ live: "0", stale: 0 }], success: true }]), status: 0 }],
    ["no stale count", { stdout: JSON.stringify([{ results: [{ live: 0 }], success: true }]), status: 0 }],
    ["the old single count", { stdout: JSON.stringify([{ results: [{ n: 0 }], success: true }]), status: 0 }],
    ["an unsuccessful result", { stdout: JSON.stringify([{ results: [{ live: 0, stale: 0 }], success: false }]), status: 0 }],
  ])("refuses when the output cannot be read (%s)", (_label, output) => {
    const r = runGated("production", NONE_PENDING, [], undefined, output);
    expect(r.status).toBe(1);
    expect(countCalls(r.calls)).toHaveLength(3);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("could not read");
  });

  it("refuses when the query fails for another reason", () => {
    const failed: Listing = { stdout: "", stderr: "\u2718 [ERROR] no such table: export_runs\n", status: 1 };
    const r = runGated("production", NONE_PENDING, [], undefined, failed);
    expect(r.status).toBe(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
    expect(r.stderr).toContain("exited with status 1");
    expect(r.stderr).not.toContain("overloaded");
  });

  it("does not count when migrations are pending", () => {
    const r = runGated("production", TWO_PENDING);
    expect(r.status).toBe(1);
    expect(countCalls(r.calls)).toHaveLength(0);
  });

  it("runs the count on a dry run and refuses there too", () => {
    const r = runGated("production", NONE_PENDING, ["--dry-run"], undefined, exportRuns(1));
    expect(r.status).toBe(1);
    expect(countCalls(r.calls)).toHaveLength(1);
    expect(deployCalls(r.calls)).toHaveLength(0);
  });
});

describe("scripts/deploy.mjs reads production D1 through the production read lock", () => {
  it("runs both production checks through the lock helper, on its port, time limit, pacing file and gap", () => {
    const r = runGated("production", NONE_PENDING);
    expect(r.status).toBe(0);
    expect(r.helperCalls).toHaveLength(2);
    const cli = join(realpathSync(r.dir), "node_modules/wrangler/wrangler-dist/cli.js");
    for (const call of r.helperCalls) {
      expect(call.slice(0, 4)).toEqual([
        String(PRODUCTION_LOCK_PORT),
        String(PRODUCTION_ATTEMPT_TIMEOUT_MS),
        join(r.dir, "cache/fisqua/d1-production.last"),
        String(PRODUCTION_READ_GAP_MS),
      ]);
      expect(call.slice(4, 8)).toEqual([process.execPath, "--no-warnings", "--experimental-vm-modules", cli]);
    }
    expect(r.helperCalls.map((c) => c.slice(8, 11).join(" "))).toEqual(["d1 migrations list", "d1 execute fisqua-db"]);
    // wrangler's cli.js runs the reads, so the helper's socket reaches the process that sends them.
    expect(listCalls(r.calls)[0].via).toBe("cli.js");
    expect(countCalls(r.calls)[0].via).toBe("cli.js");
    expect(deployCalls(r.calls)[0].via).toBe("wrangler.js");
  });

  it("waits while another process holds the read lock, and does not count the wait as an attempt", () => {
    const r = runGated("production", NONE_PENDING, [], { FISQUA_DEPLOY_CHECK_WAITS_MS: "0,0" }, NO_EXPORT_RUNS, [75, 75, 75]);
    expect(r.status).toBe(0);
    expect(r.helperCalls).toHaveLength(5);
    expect(listCalls(r.calls)).toHaveLength(1);
    expect(r.stderr.match(/another process is reading production D1/gi)).toHaveLength(1);
    expect(deployCalls(r.calls)).toHaveLength(1);
  });

  it("refuses when a production check runs past the time limit, and does not run it again", () => {
    const r = runGated("production", NONE_PENDING, [], { FISQUA_DEPLOY_CHECK_WAITS_MS: "0,0" }, NO_EXPORT_RUNS, [124]);
    expect(r.status).toBe(1);
    expect(r.helperCalls).toHaveLength(1);
    expect(r.stderr).toMatch(/time limit/);
    expect(r.stderr).toContain("nothing was deployed");
    expect(deployCalls(r.calls)).toHaveLength(0);
  });

  it("leaves staging alone: no helper, wrangler's bin as before", () => {
    const r = runGated("staging", NONE_PENDING);
    expect(r.status).toBe(0);
    expect(r.helperCalls).toHaveLength(0);
    for (const c of r.calls) expect(c.via).toBe("wrangler.js");
  });

  it("uses the read lock's values that runD1 uses", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain('new URL("./lib/d1-production-lock-run.mjs", import.meta.url)');
    expect(source).toContain(`const PRODUCTION_LOCK_PORT = ${PRODUCTION_LOCK_PORT};`);
    expect(PRODUCTION_LOCK_PORT).toBe(47393);
    expect(LOCK_BUSY_EXIT).toBe(75);
    expect(LOCK_TIMEOUT_EXIT).toBe(124);
    expect(LOCK_POLL_MS).toBe(1000);
  });
});

/** The value of `const PUBLISH_STALE_AFTER_MS = <expr>;` in a source file, evaluated. */
function staleWindow(source: string): number {
  const m = source.match(/const PUBLISH_STALE_AFTER_MS = ([\d\s*_]+);/);
  if (!m) throw new Error("PUBLISH_STALE_AFTER_MS not found");
  return Number(Function(`"use strict"; return (${m[1]});`)());
}
const PUBLISH_STALE_AFTER_MS = staleWindow(readFileSync(`${root}/app/lib/export/publish-run.ts`, "utf8"));

describe("scripts/deploy.mjs counts a run as live by the publish route's rule", () => {
  // The route's statement and stale window, shared with the command line.
  const route = readFileSync(`${root}/app/lib/export/publish-run.ts`, "utf8");
  const deploy = readFileSync(script, "utf8");

  it("uses the same stale window as the publish route", () => {
    expect(staleWindow(deploy)).toBe(PUBLISH_STALE_AFTER_MS);
  });

  it("uses the same statuses and heartbeat columns as the publish route", () => {
    expect(route).toContain("r.status IN ('pending', 'running')");
    expect(route).toContain("COALESCE(r.last_heartbeat_at, r.started_at, r.created_at) > ?9");
    expect(route).toContain("now - PUBLISH_STALE_AFTER_MS");
    expect(deploy).toContain("status IN ('pending', 'running')");
    expect(deploy).toContain("COALESCE(last_heartbeat_at, started_at, created_at) > ${cutoff}");
    expect(deploy).toContain("const cutoff = Date.now() - PUBLISH_STALE_AFTER_MS;");
  });
});
