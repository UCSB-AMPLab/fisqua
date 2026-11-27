/**
 * Scripts — starting and following a publish run from the command line
 *
 *   `publish start --target staging|production --tenant <lead slug>
 *    --actor-email <email> [--fonds <codes>|--all-fonds]
 *    [--types <list>|--all-types] [--force] [--confirm-production]`
 *   `publish status <run id> --target staging|production --tenant <slug>
 *    [--follow]`
 *
 * This module deals with what `POST /api/publish` and its polling do,
 * done through wrangler's own login instead of a signed-in session on
 * the lead's host.
 *
 * `runPublishStart` checks everything before it writes: production
 * needs `--confirm-production` (`assertProductionConfirmed`); the tenant
 * exists, is not disabled and has the publish capability; the actor is
 * a super admin as the route sees them: a platform admin admitted to the
 * tenant (`admitsAsPlatformAdmin`, the auth middleware's test) acts with
 * every role flag on (`platformAdminEffectiveUser`), a member at home
 * with their stored `is_super_admin`, and the workspace admin of the
 * lead tenant of the tenant's active federation, acting on a member,
 * with the flags a steward grant carries there
 * (`grantEffectiveRoleFlags`), which are never a super admin's, so a
 * publish by them is refused; the tenant has a descriptive standard; and the
 * request validates against the route's own schema
 * (`publishRequestSchema`) over the fonds list the publish page offers,
 * read by the app's own `resolveExportScope` and `getScopedFondsList`
 * through a Drizzle proxy over the D1 runner, so the reads are the
 * app's. `--all-fonds` takes that list and `--all-types` every type.
 * The run's `total_steps` is `countPublishSteps`, which counts entities
 * and places only with the authorities capability. Against production
 * the start is also refused while any run there, of any tenant, is
 * pending or running with a heartbeat newer than the stale window.
 *
 * The run row is written with the route's conditional insert and its
 * values (`app/lib/export/publish-run.ts`), the numbered parameters
 * inlined as SQL literals (`inlineBinds`), since `wrangler d1 execute
 * --command` takes no parameters. When it writes no row the command
 * stops with the route's message. The workflow of the target
 * (`PUBLISH_WORKFLOWS`) is then started with the run id as its instance
 * id and the route's parameters; if that fails the run is closed as the
 * route closes it: status `error`, the route's message, `completed_at`,
 * but only when `wrangler workflows instances describe` says the
 * instance does not exist. When it exists (the trigger's answer was
 * lost) the run is followed; when wrangler cannot say, the run is left
 * as it is and the command stops. Against production the insert's check
 * covers every tenant's live runs (`INSERT_PUBLISH_RUN_ANY_TENANT_SQL`).
 * From the insert until the trigger and its check have returned, Ctrl-C
 * is deferred (`InterruptGate.hold`), so no run row is left without its
 * workflow by an interrupt.
 *
 * An insert whose answer is lost or unreadable is followed by a read of
 * the run by its id: a pending, unstarted row is the run, and its
 * workflow is started; no row stops the command as a failed insert; a
 * failed read prints the run id and the `status` command to check it,
 * and exits 1. After closing a run whose workflow did not start, the row
 * is read back and the summary records what it holds; a row still
 * pending is named as blocking the tenant.
 *
 * The follow reads the one run row, by id and tenant, every 30 s, and
 * prints a line when its status, step or count changes. It stops on
 * `complete` or `error`. It fetches the sign-in page before its first
 * read and every 10 reads after; a page that does not answer 200, or a
 * read refused (a 7429 named as an overload), stops the following and
 * leaves the run alone. Ctrl-C does the same, after the statement in
 * flight; an interrupt before the insert stops with nothing written.
 * Every stop says how to follow again with `status --follow`.
 *
 * `runPublishStatus` reads the run once, scoped to the tenant, so a run
 * of another tenant is not found. Both commands print the summary (run
 * id, outcome, steps, record counts, error, the keys written) and write
 * it to `.import/publish_<target>_<stamp>-<suffix>.json` and `.md`.
 * The keys come from the run's `record_counts`, which hold a count for
 * every step the workflow completed and the per-fonds steps it skipped
 * as unchanged (`keysWritten`). The per-fonds keys repeat
 * `perFondsMainKey` (`app/lib/export/pipeline.server.ts`), which a Node
 * script cannot import; keep the two in step.
 *
 * @version v0.9.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { resolveExportScope } from "../../../app/lib/export/federation-scope.server";
import { getScopedFondsList } from "../../../app/lib/export/fonds-list.server";
import {
  INSERT_PUBLISH_RUN_ANY_TENANT_SQL,
  INSERT_PUBLISH_RUN_SQL,
  insertPublishRunBinds,
  PUBLISH_IN_PROGRESS_MESSAGE,
  PUBLISH_STALE_AFTER_MS,
  PUBLISH_TYPES,
  publishRequestSchema,
  publishWorkflowParams,
  workflowCreateFailedMessage,
} from "../../../app/lib/export/publish-run";
import { countPublishSteps } from "../../../app/lib/export/publish-steps";
import { sanitiseRefForKey } from "../../../app/lib/export/xml/escape";
import type { User } from "../../../app/context";
import { admitsAsPlatformAdmin, platformAdminEffectiveUser } from "../../../app/lib/platform-admin.server";
import { assertProductionConfirmed, runNameOf } from "../cli/run-file";
import { LOGIN_URLS } from "../export-cli/run";
import { OVERLOADED } from "../export-cli/reader";
import { escapeSql } from "../sql";

export type Target = "staging" | "production";
type Row = Record<string, unknown>;

/** The publish workflow of each target, as `wrangler.jsonc` names them. */
export const PUBLISH_WORKFLOWS: Record<Target, string> = {
  production: "publish-export",
  staging: "publish-export-staging",
};

export const FOLLOW_INTERVAL_MS = 30_000;
export const LOGIN_EVERY_READS = 10;

export interface PublishStartArgs {
  command: "start";
  target: Target;
  tenant: string;
  actorEmail: string;
  /** The fonds codes; null for `--all-fonds`. */
  fonds: string[] | null;
  /** The types; null for `--all-types`. */
  types: string[] | null;
  force: boolean;
  confirmProduction: boolean;
}

export interface PublishStatusArgs {
  command: "status";
  runId: string;
  target: Target;
  tenant: string;
  follow: boolean;
}

export type PublishArgs = PublishStartArgs | PublishStatusArgs;

export interface D1Answer {
  results: Row[];
  /** The rows the statement changed, or null when wrangler did not say. */
  changes: number | null;
}

export interface PublishProviders {
  /** Sends one statement to the target's D1, once. */
  d1: (sql: string) => Promise<D1Answer>;
  /** Starts an instance of `workflow` with `params` (JSON) and instance id `id`. */
  trigger: (workflow: string, params: string, id: string) => Promise<string>;
  /** Fetches the sign-in page; only the status is read. */
  fetch: (url: string) => Promise<{ status: number }>;
  sleep: (ms: number) => Promise<void>;
  /**
   * Whether the workflow instance `id` exists: `"absent"` only when
   * wrangler says it does not, `"unknown"` when the answer cannot be read.
   */
  describe: (workflow: string, id: string) => Promise<"exists" | "absent" | "unknown">;
  /** True once Ctrl-C has been pressed. */
  interrupted: () => boolean;
  /** Runs `fn` with Ctrl-C deferred: no press ends the command until it returns (`InterruptGate`). */
  hold: <T>(fn: () => Promise<T>) => Promise<T>;
  now: () => number;
  newId: () => string;
  writeFile: (path: string, text: string) => void;
  log: (line: string) => void;
}

export type Outcome = "complete" | "error" | "pending" | "running" | "refused" | "following stopped" | "interrupted" | "not found";

export interface RunSummary {
  runId: string;
  status: string;
  stepsCompleted: number;
  totalSteps: number;
  currentStep: string | null;
  recordCounts: Record<string, number>;
  skipped: string[];
  errorMessage: string | null;
  keys: string[];
  selectedFonds: string[];
  selectedTypes: string[];
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  lastHeartbeatAt: number | null;
}

export interface PublishResult {
  outcome: Outcome;
  runId: string | null;
  reason?: string;
  summary?: RunSummary;
  files?: string[];
}

/** A refusal before anything is written. */
export class PublishRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRefusal";
  }
}

const USAGE =
  "Usage: fisqua publish start --target staging|production --tenant <lead slug> --actor-email <email> " +
  "[--fonds <codes>|--all-fonds] [--types <list>|--all-types] [--force] [--confirm-production]\n" +
  "       fisqua publish status <run id> --target staging|production --tenant <lead slug> [--follow]";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** `publish start …` or `publish status <run id> …`. */
export function parsePublishArgs(argv: string[]): PublishArgs {
  const [noun, command, ...rest] = argv;
  if (noun !== "publish" || (command !== "start" && command !== "status")) throw new Error(USAGE);
  let target: string | null = null;
  let tenant = "";
  let actorEmail = "";
  let runId = "";
  let fonds: string[] | undefined;
  let types: string[] | undefined;
  let allFonds = false;
  let allTypes = false;
  let force = false;
  let confirmProduction = false;
  let follow = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--target") target = value();
    else if (a === "--tenant") tenant = value();
    else if (command === "start" && a === "--actor-email") actorEmail = value();
    else if (command === "start" && a === "--fonds") fonds = [...(fonds ?? []), ...list(value())];
    else if (command === "start" && a === "--types") types = [...(types ?? []), ...list(value())];
    else if (command === "start" && a === "--all-fonds") allFonds = true;
    else if (command === "start" && a === "--all-types") allTypes = true;
    else if (command === "start" && a === "--force") force = true;
    else if (command === "start" && a === "--confirm-production") confirmProduction = true;
    else if (command === "status" && a === "--follow") follow = true;
    else if (command === "status" && !a.startsWith("--") && !runId) runId = a;
    else throw new Error(`Unknown argument: ${a}\n${USAGE}`);
  }
  if (target !== "staging" && target !== "production") throw new Error("--target is staging or production");
  if (!tenant) throw new Error("--tenant <lead slug> is required");
  if (command === "status") {
    if (!runId) throw new Error(`publish status needs a run id\n${USAGE}`);
    return { command, runId, target, tenant, follow };
  }
  if (!actorEmail) throw new Error("--actor-email is required");
  if (allFonds && fonds) throw new Error("Give --fonds or --all-fonds, not both");
  if (allTypes && types) throw new Error("Give --types or --all-types, not both");
  if (!allFonds && !fonds) throw new Error("--fonds <codes> or --all-fonds is required");
  if (!allTypes && !types) throw new Error("--types <list> or --all-types is required");
  return {
    command,
    target,
    tenant,
    actorEmail,
    fonds: allFonds ? null : fonds!,
    types: allTypes ? null : types!,
    force,
    confirmProduction,
  };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * `sql` with its parameters written in as SQL literals: `?N` takes the
 * Nth value and a bare `?` the next one. Quoted text is left alone.
 */
export function inlineBinds(sql: string, binds: readonly unknown[]): string {
  let out = "";
  let next = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      if (end < 0) throw new Error(`Unterminated quote in: ${sql.slice(0, 200)}`);
      out += sql.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c !== "?") {
      out += c;
      continue;
    }
    const digits = /^\d+/.exec(sql.slice(i + 1))?.[0] ?? "";
    const n = digits ? Number(digits) : ++next;
    if (n < 1 || n > binds.length) throw new Error(`No value for ?${n} in: ${sql.slice(0, 200)}`);
    out += escapeSql(binds[n - 1]);
    i += digits.length;
  }
  return out;
}

/** A Drizzle database whose statements go through `d1`, for the app's own reads. */
function proxyDb(d1: PublishProviders["d1"]): DrizzleD1Database<any> {
  const db = drizzle(async (sql, params, method) => {
    const { results } = await d1(inlineBinds(sql, params));
    if (method === "get") return { rows: results[0] ? Object.values(results[0]) : (undefined as unknown as unknown[]) };
    if (method === "run") return { rows: [] };
    return { rows: results.map((r) => Object.values(r)) };
  });
  // The app's functions take a D1 Drizzle database; they only select,
  // which the proxy database answers the same way.
  return db as unknown as DrizzleD1Database<any>;
}

const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";
const blank = (v: unknown) => v === null || v === undefined || v === "";
const num = (v: unknown) => (blank(v) ? null : Number(v));

const tenantSql = (slug: string) =>
  `SELECT id, slug, kind, status, federation_id, descriptive_standard, publish_pipeline_enabled, authorities_enabled, disabled_at ` +
  `FROM tenants WHERE slug = ${escapeSql(slug)}`;
const userSql = (email: string) =>
  `SELECT id, email, tenant_id, is_admin, is_super_admin, is_platform_admin FROM users WHERE lower(email) = lower(${escapeSql(email)})`;
const leadSql = (federationId: string, homeTenantId: string) =>
  `SELECT f.status AS status, f.lead_tenant_id AS lead_tenant_id, h.disabled_at AS home_disabled_at ` +
  `FROM federations f, tenants h WHERE f.id = ${escapeSql(federationId)} AND h.id = ${escapeSql(homeTenantId)}`;
const liveRunsSql = (cutoff: number) =>
  "SELECT id, tenant_id, status FROM export_runs WHERE status IN ('pending', 'running') " +
  `AND COALESCE(last_heartbeat_at, started_at, created_at) > ${cutoff}`;
const runSql = (runId: string, tenantId: string) =>
  "SELECT id, tenant_id, status, selected_fonds, selected_types, current_step, steps_completed, total_steps, " +
  "record_counts, error_message, started_at, completed_at, last_heartbeat_at, created_at " +
  `FROM export_runs WHERE id = ${escapeSql(runId)} AND tenant_id = ${escapeSql(tenantId)}`;

async function readTenant(p: PublishProviders, slug: string): Promise<Row> {
  const [t] = (await p.d1(tenantSql(slug))).results;
  if (!t) throw new PublishRefusal(`No tenant has the slug ${slug}`);
  return t;
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

const PER_FONDS = /^(descriptions|children|ead|dc):(.+)$/;
const WHOLE_FILES = new Set(["repositories", "entities", "places", "entity_links", "place_links"]);

/**
 * The R2 keys a run wrote. The per-fonds paths are `perFondsMainKey`'s in
 * `app/lib/export/pipeline.server.ts` (not loadable here); change both
 * together.
 *
 * The keys, from its record counts: the main file of each
 * step counted and not skipped, in the order recorded, and the
 * federation's publisher and vocabulary files once the run is complete.
 * A children step writes one file per parent in the fonds, its count.
 */
export function keysWritten(slug: string, run: { status: string; recordCounts: Record<string, unknown> }): string[] {
  const skipped = new Set(Array.isArray(run.recordCounts.skipped) ? (run.recordCounts.skipped as string[]) : []);
  const keys: string[] = [];
  for (const [step, count] of Object.entries(run.recordCounts)) {
    if (step === "skipped" || skipped.has(step)) continue;
    if (step === "descriptions:index") {
      keys.push(`${slug}/descriptions-index.json`);
      continue;
    }
    const m = PER_FONDS.exec(step);
    if (m) {
      const [, kind, fonds] = m;
      if (kind === "descriptions") keys.push(`${slug}/descriptions-${fonds}.json`);
      else if (kind === "children") keys.push(`${slug}/children/<reference code>.json for each of the ${count} parents in ${fonds}`);
      else keys.push(`${slug}/${kind}/${sanitiseRefForKey(fonds)}.xml`);
      continue;
    }
    if (WHOLE_FILES.has(step)) keys.push(`${slug}/${step}.json`);
    else keys.push(`${step} (a step whose file this command does not know)`);
  }
  if (run.status === "complete") keys.push(`${slug}/publisher.json`, `${slug}/vocabulary.json`);
  return keys;
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string" || v === "") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function summaryOf(row: Row, slug: string): RunSummary {
  const raw = parseJson(row.record_counts);
  const all = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const recordCounts: Record<string, number> = {};
  for (const [k, v] of Object.entries(all)) if (k !== "skipped" && typeof v === "number") recordCounts[k] = v;
  const status = String(row.status ?? "");
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    runId: String(row.id),
    status,
    stepsCompleted: Number(row.steps_completed ?? 0),
    totalSteps: Number(row.total_steps ?? 0),
    currentStep: blank(row.current_step) ? null : String(row.current_step),
    recordCounts,
    skipped: strings(all.skipped),
    errorMessage: blank(row.error_message) ? null : String(row.error_message),
    keys: keysWritten(slug, { status, recordCounts: all }),
    selectedFonds: strings(parseJson(row.selected_fonds)),
    selectedTypes: strings(parseJson(row.selected_types)),
    createdAt: num(row.created_at),
    startedAt: num(row.started_at),
    completedAt: num(row.completed_at),
    lastHeartbeatAt: num(row.last_heartbeat_at),
  };
}

const iso = (ms: number | null) => (ms === null ? "—" : new Date(ms).toISOString());

function summaryLines(s: RunSummary, outcome: Outcome, reason?: string): string[] {
  const counts = Object.entries(s.recordCounts);
  return [
    `Run ${s.runId}: ${outcome}${reason ? ` (${reason})` : ""}`,
    `Status: ${s.status}`,
    `Steps: ${s.stepsCompleted} of ${s.totalSteps}${s.currentStep ? `, last ${s.currentStep}` : ""}`,
    `Record counts: ${counts.length ? counts.map(([k, v]) => `${k} ${v}`).join(", ") : "none"}`,
    ...(s.skipped.length ? [`Skipped as unchanged: ${s.skipped.join(", ")}`] : []),
    ...(s.errorMessage ? [`Error: ${s.errorMessage}`] : []),
    `Keys written (${s.keys.length}):`,
    ...(s.keys.length ? s.keys.map((k) => `  ${k}`) : ["  none"]),
  ];
}

function markdownOf(s: RunSummary, ctx: ReportContext, outcome: Outcome, reason?: string): string {
  return [
    `# Fisqua publish: run ${s.runId}`,
    "",
    `- Command: publish ${ctx.command}`,
    `- Target: ${ctx.target}`,
    `- Tenant: ${ctx.tenant}`,
    ...(ctx.actorEmail ? [`- Actor: ${ctx.actorEmail}`] : []),
    ...(ctx.workflow ? [`- Workflow: ${ctx.workflow}, instance ${s.runId}, parameters ${ctx.params}`] : []),
    `- Outcome: ${outcome}${reason ? ` (${reason})` : ""}`,
    `- Status: ${s.status}`,
    `- Steps: ${s.stepsCompleted} of ${s.totalSteps}`,
    `- Fonds: ${s.selectedFonds.join(", ") || "none"}`,
    `- Types: ${s.selectedTypes.join(", ") || "none"}`,
    `- Created ${iso(s.createdAt)}, started ${iso(s.startedAt)}, completed ${iso(s.completedAt)}, last heartbeat ${iso(s.lastHeartbeatAt)}`,
    ...(s.errorMessage ? [`- Error: ${s.errorMessage}`] : []),
    "",
    "| Step | Records |",
    "|---|---:|",
    ...Object.entries(s.recordCounts).map(([k, v]) => `| ${k}${s.skipped.includes(k) ? " (skipped as unchanged)" : ""} | ${v} |`),
    "",
    "Keys written:",
    "",
    ...(s.keys.length ? s.keys.map((k) => `- \`${k}\``) : ["- none"]),
    "",
  ].join("\n");
}

interface ReportContext {
  command: "start" | "status";
  target: Target;
  tenant: string;
  actorEmail?: string;
  workflow?: string;
  params?: string;
  startedAt: number;
}

/** Prints the summary and writes the run's report files. */
function report(p: PublishProviders, ctx: ReportContext, s: RunSummary, outcome: Outcome, reason?: string): PublishResult {
  p.log("");
  for (const line of summaryLines(s, outcome, reason)) p.log(line);
  const { name } = runNameOf("publish", ctx.target, p, ctx.startedAt);
  const json = `${name}.json`;
  const md = `${name}.md`;
  p.writeFile(json, `${JSON.stringify({ ...ctx, outcome, reason: reason ?? null, readAt: p.now(), ...s }, null, 2)}\n`);
  p.writeFile(md, markdownOf(s, ctx, outcome, reason));
  p.log(`\nSummary written to ${json} and ${md}`);
  return { outcome, runId: s.runId, reason, summary: s, files: [json, md] };
}

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["complete", "error"]);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function resumeHint(runId: string, target: Target, tenant: string): string {
  return `npx tsx scripts/fisqua.ts publish status ${runId} --target ${target} --tenant ${tenant} --follow`;
}

interface FollowEnd {
  row: Row | null;
  stop?: { outcome: "following stopped" | "interrupted" | "not found"; reason: string };
}

async function follow(p: PublishProviders, target: Target, runId: string, tenantId: string, first: Row | null): Promise<FollowEnd> {
  const loginUrl = LOGIN_URLS[target];
  let row = first;
  let shown = "";
  let reads = 0;
  for (;;) {
    if (p.interrupted()) return { row, stop: { outcome: "interrupted", reason: "Ctrl-C" } };
    if (reads % LOGIN_EVERY_READS === 0) {
      let status: number;
      try {
        status = (await p.fetch(loginUrl)).status;
      } catch (err) {
        return { row, stop: { outcome: "following stopped", reason: `the sign-in page ${loginUrl} could not be fetched: ${messageOf(err)}` } };
      }
      if (status !== 200) return { row, stop: { outcome: "following stopped", reason: `the sign-in page ${loginUrl} answered ${status}, not 200` } };
    }
    let found: Row | undefined;
    try {
      reads++;
      [found] = (await p.d1(runSql(runId, tenantId))).results;
    } catch (err) {
      const message = messageOf(err).slice(0, 400);
      const reason = OVERLOADED.test(message)
        ? `D1 refused the read of the run as overloaded (7429): ${message}`
        : `the read of the run failed: ${message}`;
      return { row, stop: { outcome: "following stopped", reason } };
    }
    if (!found) return { row, stop: { outcome: "not found", reason: `no run ${runId} of this tenant` } };
    row = found;
    const line = `${row.status}  ${row.steps_completed ?? 0}/${row.total_steps ?? 0}  ${blank(row.current_step) ? "-" : row.current_step}`;
    if (line !== shown) {
      p.log(`${new Date(p.now()).toISOString().slice(11, 19)}Z  ${line}`);
      shown = line;
    }
    if (TERMINAL.has(String(row.status))) return { row };
    await p.sleep(FOLLOW_INTERVAL_MS);
  }
}

/** Follows the run and reports how it ended. */
async function followAndReport(p: PublishProviders, ctx: ReportContext, runId: string, tenantId: string, fallback: Row): Promise<PublishResult> {
  p.log(`Following run ${runId}: one read every ${FOLLOW_INTERVAL_MS / 1000} s. Ctrl-C stops following and leaves the run alone.`);
  const end = await follow(p, ctx.target, runId, tenantId, null);
  const row = end.row ?? fallback;
  if (end.stop) {
    if (end.stop.outcome === "not found" && !end.row) {
      p.log(`Run ${runId} was not found for tenant ${ctx.tenant} on ${ctx.target}.`);
      return { outcome: "not found", runId, reason: end.stop.reason };
    }
    p.log(`\nStopped following: ${end.stop.reason}. The run continues; nothing was changed.`);
    p.log(`Follow it again with: ${resumeHint(runId, ctx.target, ctx.tenant)}`);
    return report(p, ctx, summaryOf(row, ctx.tenant), end.stop.outcome, end.stop.reason);
  }
  const status = String(row.status) as Outcome;
  return report(p, ctx, summaryOf(row, ctx.tenant), status);
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/** Starts a publish run as the API does and follows it; see the module header. */
export async function runPublishStart(args: PublishStartArgs, p: PublishProviders): Promise<PublishResult> {
  assertProductionConfirmed(
    { target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, apply: true, confirmProduction: args.confirmProduction },
    (m) => new PublishRefusal(m.replace("Applying to production", "Publishing to production")),
  );
  const startedAt = p.now();

  // The tenant, as the auth middleware and requireCapability gate it.
  const t = await readTenant(p, args.tenant);
  if (!blank(t.disabled_at)) throw new PublishRefusal(`The tenant ${args.tenant} is disabled`);
  if (!truthy(t.publish_pipeline_enabled)) throw new PublishRefusal(`The tenant ${args.tenant} does not have publishing on (publish_pipeline)`);
  if (blank(t.federation_id)) throw new PublishRefusal(`The tenant ${args.tenant} has no federation`);
  const tenantId = String(t.id);

  // The actor as the auth middleware hands them to the route: a platform
  // admin admitted to the tenant acts with every role flag on
  // (`platformAdminEffectiveUser`), a member at home with their stored
  // flags; anyone else never reaches the route. The route then requires
  // the effective user's super admin flag.
  const [u] = (await p.d1(userSql(args.actorEmail))).results;
  if (!u) throw new PublishRefusal(`No user has the email ${args.actorEmail}`);
  const stored = {
    id: String(u.id),
    tenantId: String(u.tenant_id),
    isSuperAdmin: truthy(u.is_super_admin),
    isPlatformAdmin: truthy(u.is_platform_admin),
  };
  const platformAdmin = admitsAsPlatformAdmin(stored, { kind: t.kind as "tenant" | "platform", disabledAt: null });
  const effective = platformAdmin
    ? platformAdminEffectiveUser(stored as unknown as User, { id: tenantId })
    : stored.tenantId === tenantId
      ? stored
      : null;
  if (!effective) {
    // The workspace admin of the federation's lead tenant acts on a live
    // member with a steward grant's flags (`grantEffectiveRoleFlags`),
    // which never include super admin.
    const [l] = truthy(u.is_admin) && String(t.status ?? "") !== "suspended"
      ? (await p.d1(leadSql(String(t.federation_id), stored.tenantId))).results
      : [];
    if (l && String(l.status) === "active" && String(l.lead_tenant_id ?? "") === stored.tenantId && blank(l.home_disabled_at)) {
      throw new PublishRefusal(
        `${args.actorEmail} acts in ${args.tenant} as the admin of the lead workspace of its federation, ` +
          "which does not make them a super admin there",
      );
    }
    throw new PublishRefusal(
      `${args.actorEmail} may not act in ${args.tenant}: not a member of it, not a platform admin, ` +
        "and not an admin of the lead workspace of its federation",
    );
  }
  if (!effective.isSuperAdmin) throw new PublishRefusal(`${args.actorEmail} is not a super admin`);
  if (blank(t.descriptive_standard)) throw new PublishRefusal(`The tenant ${args.tenant} has no descriptive standard, so it cannot publish`);

  // The fonds the publish page offers, read by the app's own functions.
  const db = proxyDb(p.d1);
  const scope = await resolveExportScope(db, {
    id: tenantId,
    federationId: String(t.federation_id),
    slug: String(t.slug),
    descriptiveStandard: t.descriptive_standard as "isadg",
  });
  const fondsList = await getScopedFondsList(db, scope.memberTenantIds);
  const request = {
    selectedFonds: args.fonds ?? fondsList,
    selectedTypes: args.types ?? [...PUBLISH_TYPES],
    ...(args.force ? { force: true } : {}),
  };
  const parsed = publishRequestSchema(fondsList).safeParse(request);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const at = i.path.reduce<unknown>((v, k) => (v as Record<PropertyKey, unknown> | undefined)?.[k], request);
      return `${i.path.join(".")}${at === undefined || typeof at === "object" ? "" : ` (${String(at)})`}: ${i.message}`;
    });
    throw new PublishRefusal(`The request does not validate: ${issues.join("; ")}`);
  }
  const { selectedFonds, selectedTypes } = parsed.data;
  const totalSteps = countPublishSteps({ selectedFonds, selectedTypes, authoritiesEnabled: scope.authoritiesEnabled });

  if (args.target === "production") {
    const live = (await p.d1(liveRunsSql(p.now() - PUBLISH_STALE_AFTER_MS))).results;
    if (live.length > 0) {
      throw new PublishRefusal(
        `A publish run is live on production: ${live.map((r) => `${r.id} (tenant ${r.tenant_id}, ${r.status})`).join(", ")}. ` +
          "Wait for it to finish before starting another.",
      );
    }
  }
  if (p.interrupted()) throw new PublishRefusal("Interrupted before the run was inserted; nothing was written");

  // The route's conditional insert, with the route's values. Against
  // production its check covers every tenant's live runs, so a run
  // started anywhere after the check above still stops this one. From
  // the insert until the workflow has started, Ctrl-C is deferred: a run
  // row with no workflow would block the tenant until it went stale.
  const exportId = p.newId();
  const ended = await p.hold(() => insertAndTrigger(args, p, exportId, String(u.id), tenantId, scope.federationId, selectedFonds, selectedTypes, totalSteps, startedAt));
  if (ended.result) return ended.result;
  return followAndReport(p, ended.ctx, exportId, tenantId, ended.pendingRow);
}

/** The report context of a start that ended before its workflow was named. */
function emptyCtx(args: PublishStartArgs, startedAt: number): ReportContext {
  return { command: "start", target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, startedAt };
}

interface Started {
  result?: PublishResult;
  ctx: ReportContext;
  pendingRow: Row;
}

/** Inserts the run and starts its workflow; a result is returned when the command ends there. */
async function insertAndTrigger(
  args: PublishStartArgs,
  p: PublishProviders,
  exportId: string,
  actorId: string,
  tenantId: string,
  federationId: string | null | undefined,
  selectedFonds: string[],
  selectedTypes: string[],
  totalSteps: number,
  startedAt: number,
): Promise<Started> {
  const now = p.now();
  const insert = inlineBinds(
    args.target === "production" ? INSERT_PUBLISH_RUN_ANY_TENANT_SQL : INSERT_PUBLISH_RUN_SQL,
    insertPublishRunBinds({
      exportId,
      triggeredBy: actorId,
      tenantId,
      selectedFonds,
      selectedTypes,
      federationId,
      totalSteps,
      now,
    }),
  );
  // When the insert's answer is lost or unreadable, the row is read back
  // by its id: D1 may have committed it, and a pending row with no
  // workflow would block the tenant until it went stale.
  let changes: number | null;
  let lost: string | null = null;
  try {
    changes = (await p.d1(insert)).changes;
    if (changes === null) lost = "wrangler did not say whether it was written";
  } catch (err) {
    changes = null;
    lost = messageOf(err);
  }
  if (lost !== null) {
    let row: Row | undefined;
    try {
      [row] = (await p.d1(runSql(exportId, tenantId))).results;
    } catch (readErr) {
      p.log(
        `The insert of run ${exportId} failed (${lost}), and reading the run back failed too (${messageOf(readErr)}). ` +
          `Whether the run exists is not known. Check it with: npx tsx scripts/fisqua.ts publish status ${exportId} ` +
          `--target ${args.target} --tenant ${args.tenant}`,
      );
      return {
        result: { outcome: "error", runId: exportId, reason: `the insert's answer was lost and the run could not be read back: ${lost}` },
        ctx: emptyCtx(args, startedAt),
        pendingRow: {},
      };
    }
    if (!row) throw new Error(`The insert of run ${exportId} failed and the run was not written: ${lost}`);
    if (row.status !== "pending" || !blank(row.started_at)) {
      p.log(`The insert of run ${exportId} failed (${lost}), but the run exists and is ${row.status}; it is not started again.`);
      return {
        result: { outcome: "error", runId: exportId, reason: `the insert's answer was lost and the run is already ${row.status}` },
        ctx: emptyCtx(args, startedAt),
        pendingRow: {},
      };
    }
    p.log(`The insert of run ${exportId} reported an error (${lost}), but the run was written and is pending; starting its workflow.`);
    changes = 1;
  }
  const workflow = PUBLISH_WORKFLOWS[args.target];
  const params = JSON.stringify(publishWorkflowParams(exportId, args.force));
  const ctx: ReportContext = { command: "start", target: args.target, tenant: args.tenant, actorEmail: args.actorEmail, workflow, params, startedAt };
  const pendingRow: Row = {
    id: exportId,
    status: "pending",
    selected_fonds: JSON.stringify(selectedFonds),
    selected_types: JSON.stringify(selectedTypes),
    steps_completed: 0,
    total_steps: totalSteps,
    created_at: now,
  };
  if (changes === 0) {
    const reason =
      args.target === "production"
        ? `${PUBLISH_IN_PROGRESS_MESSAGE} (On production a live run of any tenant counts.)`
        : PUBLISH_IN_PROGRESS_MESSAGE;
    p.log(reason);
    return { result: { outcome: "refused", runId: null, reason }, ctx, pendingRow };
  }
  p.log(
    `Run ${exportId} inserted for ${args.tenant} on ${args.target}, acting as ${args.actorEmail}: ` +
      `${totalSteps} steps, fonds ${selectedFonds.join(", ")}, types ${selectedTypes.join(", ")}${args.force ? ", force" : ""}`,
  );

  // The workflow, with the run id as its instance id.
  try {
    const out = await p.trigger(workflow, params, exportId);
    p.log(`Workflow ${workflow} started, instance ${exportId}${out.trim() ? `: ${out.trim().split("\n").pop()}` : ""}`);
  } catch (err) {
    const message = workflowCreateFailedMessage(err);
    // The trigger can fail after the instance was created (its answer
    // lost); the run is closed only when the instance does not exist.
    const instance = await p.describe(workflow, exportId).catch(() => "unknown" as const);
    if (instance === "exists") {
      p.log(`The trigger reported an error (${message}), but instance ${exportId} of ${workflow} exists; the run is not closed and is followed.`);
      return { ctx, pendingRow };
    }
    if (instance === "unknown") {
      const reason = `${message}; whether instance ${exportId} exists could not be read, so the run is left as it is`;
      p.log(
        `The trigger reported an error, and wrangler could not say whether instance ${exportId} exists. The run is not closed: ` +
          `check it with \`wrangler workflows instances describe ${workflow} ${exportId}\` and ` +
          `${resumeHint(exportId, args.target, args.tenant)}. A run with no workflow blocks the tenant's publishing until it goes stale.`,
      );
      return { result: report(p, ctx, summaryOf(pendingRow, args.tenant), "error", reason), ctx, pendingRow };
    }
    const completedAt = p.now();
    const close =
      `UPDATE export_runs SET status = 'error', error_message = ${escapeSql(message)}, ` +
      `completed_at = ${completedAt} WHERE id = ${escapeSql(exportId)}`;
    let reason = message;
    try {
      await p.d1(close);
    } catch (closeErr) {
      reason = `${message}; closing the run failed: ${messageOf(closeErr)}`;
    }
    // The summary records the row as it is after the close, read back.
    let row: Row;
    try {
      const [found] = (await p.d1(runSql(exportId, tenantId))).results;
      row = found ?? { ...pendingRow, status: "not found" };
    } catch (readErr) {
      reason = `${reason}; the run could not be read back: ${messageOf(readErr)}`;
      row = { ...pendingRow, status: "unknown (not read back)" };
    }
    if (row.status === "error") {
      p.log(`The workflow did not start; run ${exportId} is closed as an error.`);
    } else if (row.status === "pending") {
      p.log(`The workflow did not start, and run ${exportId} is still pending: it blocks the tenant's publishing until it goes stale. Run id: ${exportId}`);
      reason = `${reason}; the run is still pending`;
    } else {
      p.log(`The workflow did not start; run ${exportId} reads as ${row.status}. Run id: ${exportId}`);
    }
    return { result: report(p, ctx, summaryOf(row, args.tenant), "error", reason), ctx, pendingRow };
  }
  return { ctx, pendingRow };
}

/** Reads one run of the tenant and prints its summary; with `--follow`, follows it as `start` does. */
export async function runPublishStatus(args: PublishStatusArgs, p: PublishProviders): Promise<PublishResult> {
  const startedAt = p.now();
  const t = await readTenant(p, args.tenant);
  const tenantId = String(t.id);
  const ctx: ReportContext = { command: "status", target: args.target, tenant: args.tenant, startedAt };
  const [row] = (await p.d1(runSql(args.runId, tenantId))).results;
  if (!row) {
    p.log(`Run ${args.runId} was not found for tenant ${args.tenant} on ${args.target}.`);
    return { outcome: "not found", runId: args.runId };
  }
  if (args.follow && !TERMINAL.has(String(row.status))) return followAndReport(p, ctx, args.runId, tenantId, row);
  return report(p, ctx, summaryOf(row, args.tenant), String(row.status) as Outcome);
}

/**
 * Ctrl-C for the command: the first press stops it after the statement
 * in flight (`interrupted`), a second exits at once, except while `hold`
 * runs, when every press only records that the command is to stop.
 */
export class InterruptGate {
  private presses = 0;
  private holding = 0;

  /** What a press does now: stop after the statement in flight, exit at once, or wait for `hold` to end. */
  press(): "stop" | "exit" | "deferred" {
    this.presses++;
    if (this.holding > 0) return "deferred";
    return this.presses > 1 ? "exit" : "stop";
  }

  interrupted(): boolean {
    return this.presses > 0;
  }

  async hold<T>(fn: () => Promise<T>): Promise<T> {
    this.holding++;
    try {
      return await fn();
    } finally {
      this.holding--;
    }
  }
}

/** 0 for a complete run, or a run read without following; 130 after Ctrl-C; 1 otherwise. */
export function publishExitCode(result: PublishResult): number {
  if (result.outcome === "complete" || result.outcome === "pending" || result.outcome === "running") return 0;
  if (result.outcome === "interrupted") return 130;
  return 1;
}

// @version v0.9.0
