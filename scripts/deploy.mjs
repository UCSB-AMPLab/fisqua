#!/usr/bin/env node
/**
 * Deploy — build and deploy one environment, refusing the ambiguous forms
 *
 * This script builds and deploys one environment: `npm run deploy` deploys
 * production and `npm run deploy:staging` deploys staging. Both come
 * through it; it builds, refuses the ambiguous forms below, and then runs
 * `wrangler deploy`.
 *
 * The React Router build writes a single resolved configuration to
 * build/server/wrangler.json, chosen by the `CLOUDFLARE_ENV` variable at
 * build time, and `wrangler deploy` follows a redirect to that file. A
 * production build records no target environment, and wrangler then
 * ignores an `--env` flag, so `wrangler deploy --env staging` after a
 * production build deploys the production Worker. This script therefore:
 *
 *   - refuses `--env` / `-e` in its arguments and points at
 *     `deploy:staging`;
 *   - refuses a production deploy while `CLOUDFLARE_ENV` is set, since
 *     the build would resolve that environment instead;
 *   - builds with `CLOUDFLARE_ENV=staging` for staging and with it unset
 *     for production;
 *   - checks that the built configuration names the expected Worker
 *     (`fisqua` or `fisqua-staging`) before deploying;
 *   - deploys staging with `CLOUDFLARE_ENV=staging`, so wrangler also
 *     checks the build's target environment;
 *   - refuses any WRANGLER_CI_* variable, which wrangler applies after
 *     `--name` and could send the build to another Worker;
 *   - removes the previous build's configuration before building, so a
 *     build that writes none cannot leave an older one to be deployed;
 *   - deploys the checked file, named with `-c` and the Worker name with
 *     `--name`, so nothing between the check and the deploy can choose
 *     another configuration or Worker;
 *   - checks that the build pins the account the Workers belong to, and
 *     keeps CLOUDFLARE_ACCOUNT_ID out of wrangler's environment, so no
 *     cached or configured account can take its place;
 *   - runs wrangler with an allowlisted environment and `--env-file
 *     /dev/null`, so no inherited variable and no .env file can override
 *     the Worker name after the check;
 *   - refuses to deploy while the target's D1 database (`fisqua-db` or
 *     `fisqua-staging-db`) has a migration in drizzle/ it has not
 *     applied, and when `wrangler d1 migrations list` fails or prints
 *     output it cannot read, because a Drizzle select of a column the
 *     database lacks returns the column's name as its value instead of
 *     an error. A dry run runs this check too, and no flag skips it. A
 *     check that fails or cannot be read is run again after 20 s and
 *     after 60 s, printing wrangler's errors each time, because wrangler
 *     sometimes refuses the account or finds D1 overloaded for a moment;
 *     the deploy itself is never run again;
 *   - after the migrations check, counts the live export runs on the
 *     same database (`wrangler d1 execute --json`), and refuses to deploy
 *     unless there are none. A run is live by the rule the publish route
 *     (app/routes/api.publish.tsx) uses to refuse a second publish: its
 *     status is `pending` or `running` and its last heartbeat (or its
 *     start, or its creation, when it has written no heartbeat) is less
 *     than `PUBLISH_STALE_AFTER_MS`, six hours, old. A pending or running
 *     run silent for longer is stale: it is counted and reported, and
 *     does not block. The count fails closed: a query that fails, or
 *     output that does not read as one whole-number live count and one
 *     stale count, refuses the deploy, and a refusal by D1 as overloaded
 *     (7429) is named as such. A failed or unreadable count is run again
 *     after the same waits as the migrations check; a live count above 0
 *     is an answer and is not. A dry run counts too. An export run
 *     started between this check and the deploy is not fenced;
 *   - runs both checks against production, which are reads, through the
 *     production read lock that every command-line production read takes
 *     (`scripts/lib/d1-production-lock-run.mjs`; `runD1` in
 *     `scripts/lib/d1-cli.ts` takes it the same way): the helper binds
 *     127.0.0.1:47393 (`PRODUCTION_LOCK_PORT`), waits until 1 s
 *     (`PRODUCTION_READ_GAP_MS`) has passed since the last production read
 *     ended, recorded in `d1-production.last` in `$XDG_CACHE_HOME/fisqua/`
 *     or `~/.cache/fisqua/`, and runs wrangler's `wrangler-dist/cli.js`
 *     with node directly, so the process that sends the query holds the
 *     port, stopping it after 5 minutes (`PRODUCTION_ATTEMPT_TIMEOUT_MS`).
 *     This script cannot import the TypeScript module, so the values are
 *     repeated here and a test keeps them equal to its. While another
 *     process holds the port the check says so once, waits 1 s and tries
 *     again, and such a try is not an attempt; a check stopped at the time
 *     limit refuses the deploy and is not run again. The staging checks
 *     run wrangler's bin as before, with no lock.
 *
 * Only the arguments in ALLOWED_ARGS reach `wrangler deploy`; any other
 * is refused, because wrangler flags such as `--name`, `-c`/`--config`,
 * `--cwd` or `--script` would deploy a configuration or Worker other
 * than the one checked.
 *
 * Usage:
 *   node scripts/deploy.mjs production [--dry-run] [--message <text>]
 *   node scripts/deploy.mjs staging [--dry-run] [--message <text>]
 *
 * @version v0.9.0
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {Record<string, { workerName: string, database: string, cloudflareEnv: string | undefined }>} */
const TARGETS = {
  production: { workerName: "fisqua", database: "fisqua-db", cloudflareEnv: undefined },
  staging: { workerName: "fisqua-staging", database: "fisqua-staging-db", cloudflareEnv: "staging" },
};

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

const [target, ...passthrough] = process.argv.slice(2);
const spec = TARGETS[target];
if (!spec) fail(`the first argument must be "production" or "staging", not ${JSON.stringify(target)}`);

const envFlag = passthrough.find((a) => a === "--env" || a === "-e" || a.startsWith("--env=") || a.startsWith("-e="));
if (envFlag) {
  fail(
    `refusing ${envFlag}: the build, not wrangler, chooses the environment. ` +
      `Use "npm run deploy:staging" for staging and "npm run deploy" for production.`,
  );
}

/** Flags passed through to wrangler; `--message` takes the next argument as its value. */
const ALLOWED_ARGS = new Set(["--dry-run", "--message"]);
for (let i = 0; i < passthrough.length; i++) {
  const arg = passthrough[i];
  if (arg === "--message") {
    if (i + 1 >= passthrough.length) fail(`--message needs a value`);
    i++;
    continue;
  }
  if (!ALLOWED_ARGS.has(arg)) {
    fail(
      `refusing ${JSON.stringify(arg)}: only ${[...ALLOWED_ARGS].join(", ")} are passed to wrangler, ` +
        `so the deploy cannot target a configuration or Worker other than the one checked.`,
    );
  }
}

if (target === "production" && process.env.CLOUDFLARE_ENV) {
  fail(
    `refusing a production deploy while CLOUDFLARE_ENV=${process.env.CLOUDFLARE_ENV} is set. ` +
      `Unset it, or use "npm run deploy:staging" for staging.`,
  );
}

// Wrangler reads WRANGLER_CI_* variables (WRANGLER_CI_OVERRIDE_NAME and
// others) after it resolves --name and -c, so any of them could deploy
// the checked build under another Worker. They are refused here rather
// than dropped silently, so the caller sees why.
const ciOverrides = Object.keys(process.env).filter((k) => k.startsWith("WRANGLER_CI_"));
if (ciOverrides.length > 0) {
  fail(
    `refusing to deploy while ${ciOverrides.join(", ")} is set: wrangler applies it after the checked ` +
      `Worker name and could deploy this build to another Worker. Unset it and run again.`,
  );
}

/** The waits before the second and third attempt at the check. */
const DEFAULT_CHECK_WAITS_MS = [20_000, 60_000];
// The tests set FISQUA_DEPLOY_CHECK_WAITS_MS to "0,0" so they do not sleep.
const waitsSetting = process.env.FISQUA_DEPLOY_CHECK_WAITS_MS;
if (waitsSetting !== undefined && !/^\d+,\d+$/.test(waitsSetting)) {
  fail(`FISQUA_DEPLOY_CHECK_WAITS_MS must be two whole numbers of milliseconds, such as "20000,60000", not ${JSON.stringify(waitsSetting)}.`);
}
const checkWaitsMs = waitsSetting === undefined ? DEFAULT_CHECK_WAITS_MS : waitsSetting.split(",").map(Number);

const childEnv = { ...process.env };
if (spec.cloudflareEnv) childEnv.CLOUDFLARE_ENV = spec.cloudflareEnv;
else delete childEnv.CLOUDFLARE_ENV;

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: childEnv });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const builtPath = fileURLToPath(new URL("../build/server/wrangler.json", import.meta.url));
// A build that exits 0 without writing must not leave an older file to be checked and deployed.
rmSync(builtPath, { force: true });

run("npm", ["run", "build"]);

const built = JSON.parse(readFileSync(builtPath, "utf8"));
/** The account the Worker belongs to; wrangler.jsonc pins it for every environment. */
const ACCOUNT_ID = "492ecadf9e992aecb0553ec14ebf90c7";
if (built.account_id !== ACCOUNT_ID) {
  fail(`the build names account ${JSON.stringify(built.account_id)}, not ${ACCOUNT_ID}; nothing was deployed.`);
}
if (built.name !== spec.workerName) {
  fail(`the build names the Worker "${built.name}", not "${spec.workerName}"; nothing was deployed.`);
}

// Wrangler's inputs are its arguments, its environment and the dotenv files
// it loads. All three are fixed here: the arguments above, an environment
// holding only WRANGLER_ENV_ALLOWLIST (plus CLOUDFLARE_ENV for staging), and
// --env-file /dev/null, which replaces the .env and .env.local wrangler would
// otherwise load from the working directory.
/** Variables wrangler may receive: system paths and locale, and Cloudflare credentials. */
const WRANGLER_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL",
  "XDG_CONFIG_HOME",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL",
];
/** @type {Record<string, string>} */
const wranglerEnv = {};
for (const name of WRANGLER_ENV_ALLOWLIST) {
  const value = process.env[name];
  if (value !== undefined) wranglerEnv[name] = value;
}
if (spec.cloudflareEnv) wranglerEnv.CLOUDFLARE_ENV = spec.cloudflareEnv;

const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

// The production read lock; the values are runD1's (scripts/lib/d1-cli.ts).
const PRODUCTION_LOCK_HELPER = fileURLToPath(new URL("./lib/d1-production-lock-run.mjs", import.meta.url));
const PRODUCTION_LOCK_PORT = 47393;
const PRODUCTION_READ_GAP_MS = 1_000;
const PRODUCTION_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
const LOCK_POLL_MS = 1_000;
const LOCK_BUSY_EXIT = 75;
const LOCK_TIMEOUT_EXIT = 124;
const productionLastFile = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "fisqua", "d1-production.last");

/** Wrangler's `cli.js`, which the helper runs with node directly so that it holds the lock's socket. */
function wranglerCli() {
  const pkgUrl = new URL("../node_modules/wrangler/package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
  return fileURLToPath(new URL(pkg.main ?? "wrangler-dist/cli.js", pkgUrl));
}

/**
 * Runs one `wrangler d1 …` read of the target's database: on production
 * through the production read lock, waiting while another process holds
 * it; on staging through wrangler's bin. A production read stopped at the
 * time limit refuses the deploy.
 * @param {string[]} d1Args the arguments after `wrangler`
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} options
 */
function readD1(d1Args, options) {
  if (target !== "production") return spawnSync(process.execPath, [wranglerBin, ...d1Args], options);
  const helperArgs = [
    PRODUCTION_LOCK_HELPER,
    String(PRODUCTION_LOCK_PORT),
    String(PRODUCTION_ATTEMPT_TIMEOUT_MS),
    productionLastFile,
    String(PRODUCTION_READ_GAP_MS),
    process.execPath,
    "--no-warnings",
    "--experimental-vm-modules",
    wranglerCli(),
    ...d1Args,
  ];
  let said = false;
  for (;;) {
    const result = spawnSync(process.execPath, helperArgs, options);
    if (result.status === LOCK_BUSY_EXIT) {
      if (!said) {
        console.error(`deploy: another process is reading production D1 (it holds 127.0.0.1:${PRODUCTION_LOCK_PORT}); waiting for it to finish.`);
        said = true;
      }
      sleep(LOCK_POLL_MS);
      continue;
    }
    if (result.status === LOCK_TIMEOUT_EXIT) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      fail(
        `"wrangler ${d1Args.slice(0, 4).join(" ")}" ran past its time limit of ${PRODUCTION_ATTEMPT_TIMEOUT_MS / 1000} s ` +
          `and was stopped; it is not run again, and nothing was deployed.`,
      );
    }
    return result;
  }
}

// The migrations the code expects are the files in drizzle/, which the
// source wrangler.jsonc names as each database's migrations_dir; the
// built configuration is not used here because it sits in build/server/.
// Wrangler 4 prints "No migrations to apply!" when nothing is pending and
// "Migrations to be applied:" followed by a table of file names otherwise.
// Any other outcome, including a non-zero exit, refuses the deploy: a check
// that could not run has not shown the database to be current.
const sourceConfig = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const envArgs = spec.cloudflareEnv ? ["--env", spec.cloudflareEnv] : [];
const applyCommand = `npx wrangler d1 migrations apply ${spec.database} --remote${envArgs.length ? ` ${envArgs.join(" ")}` : ""}`;
/**
 * CI=1 keeps wrangler from prompting; the environment is otherwise the deploy's.
 * @type {Record<string, string>}
 */
const listEnv = { ...wranglerEnv, CI: "1" };

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * One run of `wrangler d1 migrations list`: the pending file names, or the
 * reason the check could not tell, as the refusal would state it.
 * @returns {{ pending: string[] } | { problem: string }}
 */
function listMigrations() {
  const listed = readD1(
    ["d1", "migrations", "list", spec.database, "--remote", "-c", sourceConfig, ...envArgs, "--env-file", "/dev/null"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: /** @type {NodeJS.ProcessEnv} */ (listEnv) },
  );
  process.stdout.write(listed.stdout ?? "");
  process.stderr.write(listed.stderr ?? "");
  if (listed.status !== 0) {
    return {
      problem:
        `"wrangler d1 migrations list ${spec.database} --remote" exited with status ${listed.status ?? listed.signal}, ` +
        `so the database's migrations could not be checked`,
    };
  }
  const listing = (listed.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const nonePending = listing.includes("No migrations to apply!");
  const pendingHeader = listing.indexOf("Migrations to be applied:");
  const pending = pendingHeader === -1 ? [] : [...listing.slice(pendingHeader).matchAll(/\b\d+_[\w.-]*\.sql\b/g)].map((m) => m[0]);
  if (nonePending === (pendingHeader !== -1) || (pendingHeader !== -1 && pending.length === 0)) {
    return {
      problem: `could not tell from "wrangler d1 migrations list ${spec.database} --remote" whether migrations are pending`,
    };
  }
  return { pending };
}

/**
 * Runs `check` until it gives an answer, three attempts in all, waiting
 * `checkWaitsMs` between attempts; refuses the deploy with the last
 * problem when none of them does. Wrangler sometimes fails a check for a
 * moment (a 7403 for the account, a 7429 when D1 is overloaded) and
 * passes it a minute later. An answer, whatever it says, is not run again.
 * @template T
 * @param {() => T | { problem: string }} check
 * @returns {T}
 */
function untilAnswered(check) {
  const attempts = checkWaitsMs.length + 1;
  let checked = check();
  for (let attempt = 1; typeof checked === "object" && checked !== null && "problem" in checked; attempt++) {
    const { problem } = /** @type {{ problem: string }} */ (checked);
    if (attempt >= attempts) {
      fail(
        problem.startsWith("could not")
          ? `${problem}; nothing was deployed. Run it yourself and check the output.`
          : `${problem}; nothing was deployed.`,
      );
    }
    const ms = checkWaitsMs[attempt - 1];
    console.error(`deploy: ${problem}; checking again in ${ms / 1000} s (attempt ${attempt + 1} of ${attempts}).`);
    sleep(ms);
    checked = check();
  }
  return /** @type {T} */ (checked);
}

const { pending } = untilAnswered(listMigrations);
if (pending.length > 0) {
  fail(
    `${spec.database} has ${pending.length} unapplied migration(s): ${pending.join(", ")}. ` +
      `The code expects them, so nothing was deployed. Apply them with:\n\n  ${applyCommand}\n\nthen deploy again.`,
  );
}

// An export run is a Workflow of this Worker (PUBLISH_EXPORT), and no
// deploy goes ahead while one is live. The count is a read of the target's
// database with the migrations check's environment; with --json wrangler
// prints an array of results on success, and an object with an `error` on
// failure.
/**
 * How long a pending or running export run counts as live after its last
 * heartbeat: the value of PUBLISH_STALE_AFTER_MS in
 * app/routes/api.publish.tsx, which a test keeps equal to it.
 */
const PUBLISH_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * One run of the export-run count: the live and stale counts, or the
 * reason they could not be read, as the refusal would state it.
 * @returns {{ live: number, stale: number } | { problem: string }}
 */
function countExportRuns() {
  const cutoff = Date.now() - PUBLISH_STALE_AFTER_MS;
  const fresh = `COALESCE(last_heartbeat_at, started_at, created_at) > ${cutoff}`;
  const query =
    `SELECT COALESCE(SUM(CASE WHEN ${fresh} THEN 1 ELSE 0 END), 0) AS live, ` +
    `COALESCE(SUM(CASE WHEN ${fresh} THEN 0 ELSE 1 END), 0) AS stale ` +
    `FROM export_runs WHERE status IN ('pending', 'running')`;
  const counted = readD1(
    ["d1", "execute", spec.database, "--remote", "--json", "--command", query, "-c", sourceConfig, ...envArgs, "--env-file", "/dev/null"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: /** @type {NodeJS.ProcessEnv} */ (listEnv) },
  );
  process.stdout.write(counted.stdout ?? "");
  process.stderr.write(counted.stderr ?? "");
  const output = `${counted.stdout ?? ""}\n${counted.stderr ?? ""}`;
  if (counted.status !== 0) {
    const overloaded = /\b7429\b|overloaded/i.test(output);
    return {
      problem:
        `"wrangler d1 execute ${spec.database} --remote" exited with status ${counted.status ?? counted.signal}` +
        (overloaded ? ` because D1 is overloaded (7429)` : ``) +
        `, so the pending and running export runs could not be counted`,
    };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(counted.stdout ?? "");
  } catch {
    parsed = undefined;
  }
  const first = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  const rows = first && first.success === true && Array.isArray(first.results) ? first.results : [];
  const live = rows.length === 1 ? rows[0]?.live : undefined;
  const stale = rows.length === 1 ? rows[0]?.stale : undefined;
  /** @param {unknown} v */
  const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (!isCount(live) || !isCount(stale)) {
    return {
      problem: `could not read a count of export runs from "wrangler d1 execute ${spec.database} --remote"`,
    };
  }
  return { live: /** @type {number} */ (live), stale: /** @type {number} */ (stale) };
}

const exportRuns = untilAnswered(countExportRuns);
if (exportRuns.stale > 0) {
  console.error(
    `deploy: ignored ${exportRuns.stale} stale export run(s) on ${spec.database}: pending or running, ` +
      `with no heartbeat for ${PUBLISH_STALE_AFTER_MS / 3_600_000} h, as the publish route ignores them.`,
  );
}
if (exportRuns.live !== 0) {
  fail(
    `${exportRuns.live} export run(s) pending or running on ${spec.database}, so nothing was deployed. ` +
      `Wait for them to finish and deploy again.`,
  );
}
const deployed = spawnSync(
  process.execPath,
  [wranglerBin, "deploy", "-c", builtPath, "--name", spec.workerName, "--env-file", "/dev/null", ...passthrough],
  { stdio: "inherit", env: /** @type {NodeJS.ProcessEnv} */ (wranglerEnv) },
);
if (deployed.status !== 0) process.exit(deployed.status ?? 1);
