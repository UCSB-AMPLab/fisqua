/**
 * Digitization — the Scanner Screen's Reads and Token Actions
 *
 * This module is the server side of the Scanner screen
 * (`/admin/capture/scanner`): what the screen shows of the tenant's
 * Captua scanner, and the three token actions it offers, make, replace
 * and revoke. The route checks the digitization capability and passes
 * the request here; `captureAccess` (`screens.server.ts`) decides who may
 * act, the tenant's admins and its federation's stewards, and anyone else
 * gets a bare 403.
 *
 * `loadScanner` reads the scanner's name, when its token was made, when
 * the unit last called Fisqua (`last_seen_at`, which the link's
 * `authenticate` sets on every authenticated call, in the statement that
 * counts the call against the rate window, so recording it costs no
 * write of its own) and when the token was revoked. It never reads the
 * token's hash. `deviceStateOf` and `tokenStateOf` turn the row into the
 * screen's states: the device is not linked, waiting for its first call,
 * linked, or revoked; the token is none, active or revoked. The token's
 * fourth state, just made, exists only in the page that made it.
 *
 * `scannerTokenAction` carries out one action with the plan, the minting
 * and the statement of `scanner-token.ts`, the path the operator command
 * takes too. Its form fields are `intent` (`make`, `replace`,
 * `revoke`), `seen` (the scanner's `version` as the page showed it: its
 * id and `revision`, so an action taken on a stale page is refused with
 * `changed` rather than replacing a token someone else just made, however
 * close together the two were) and, for replace and revoke,
 * `confirm=yes`, which the page sends only from its confirmation step.
 * A tenant without a scanner gets one from Make token, which then also
 * takes `name`: the unit's short id, the one the operator command takes
 * as `--appliance` and the unit's bucket keys carry, checked by the same
 * rule (`invalid_name` otherwise). Once the scanner exists the name is
 * not asked again, and one given is ignored.
 *
 * The action is a cookie-authenticated form post. React Router refuses
 * any action request, document or data, whose `Origin` names another
 * host than the request's (`allowedActionOrigins` is unset), before the
 * route runs, so a page on a sibling tenant's host cannot make, replace
 * or revoke a token with the admin's cookie.
 *
 * The write and its audit row go in one D1 batch, under a write id of
 * the request's own. The audit row is an
 * `audit_log` row of action `scanner_token`, with the actor's id and
 * email, their home tenant, the tenant acted on, the scanner's id, the
 * impersonation session if any, and `details` of `{ step, name }`. It is
 * inserted only where the scanner carries this write's id at the
 * revision the write set (`landedCondition`), so a guarded write that
 * changed nothing, including one that lost a race to another, leaves no
 * row. The scanner is then read back the same way; a write that did not
 * land answers `changed` and shows no token. A new token is returned in
 * the action's answer and nowhere else: not in the loader, the audit row,
 * a log line or the session.
 *
 * @version v0.8.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Tenant, User } from "../../context";
import { captureAccess } from "./screens.server";
import { mintScannerToken } from "./token";
import {
  isNameOk,
  landedCondition,
  landedQuery,
  planScannerToken,
  rowOfScanner,
  scannerQuery,
  scannerTokenStatement,
  SCANNER_TOKEN_ACTIONS,
  type ScannerRow,
  type ScannerTokenAction,
  type ScannerTokenRefusal,
  type ScannerTokenStep,
} from "./scanner-token";

export type DeviceState = "not_linked" | "waiting" | "linked" | "revoked";
export type TokenState = "none" | "active" | "revoked";

export interface ScannerView {
  name: string;
  tokenState: TokenState;
  deviceState: DeviceState;
  tokenCreatedAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** What an action posts back as `seen`. */
  version: string;
}

/** `seen` for a tenant with no scanner. */
export const NO_SCANNER_VERSION = "none";

export function tokenStateOf(s: ScannerRow | null): TokenState {
  if (!s || s.tokenSha256 === null) return "none";
  return s.revokedAt !== null ? "revoked" : "active";
}

export function deviceStateOf(s: ScannerRow | null): DeviceState {
  const token = tokenStateOf(s);
  if (token === "none") return "not_linked";
  if (token === "revoked") return "revoked";
  return (s as ScannerRow).lastSeenAt === null ? "waiting" : "linked";
}

function versionOf(s: ScannerRow | null): string {
  return s ? `${s.id}:${s.revision}` : NO_SCANNER_VERSION;
}

async function readScanners(d1: D1Database, tenantId: string): Promise<ScannerRow[]> {
  const q = scannerQuery(tenantId);
  const { results } = await d1.prepare(q.sql).bind(...q.params).all<Record<string, unknown>>();
  return results.map(rowOfScanner);
}

/** The tenant's scanner as the screen shows it, or null when it has none. */
export async function loadScanner(d1: D1Database, tenantId: string): Promise<ScannerView | null> {
  const [s] = await readScanners(d1, tenantId);
  if (!s) return null;
  return {
    name: s.name,
    tokenState: tokenStateOf(s),
    deviceState: deviceStateOf(s),
    tokenCreatedAt: s.tokenCreatedAt,
    lastSeenAt: s.lastSeenAt,
    revokedAt: s.revokedAt,
    version: versionOf(s),
  };
}

export type ScannerActionError = "invalid_request" | "invalid_name" | "unconfirmed" | "changed" | ScannerTokenRefusal;

export type ScannerActionResult =
  | { ok: true; step: Exclude<ScannerTokenStep, "none">; token?: string }
  | { ok: false; error: ScannerActionError };

export interface ScannerActionDeps {
  d1: D1Database;
  db: DrizzleD1Database<any>;
  now: () => number;
  newId: () => string;
  mint?: () => Promise<{ token: string; sha256: string }>;
}

export interface ScannerActor {
  user: User;
  /** The actor's home tenant: the grant's for a steward, the user's own otherwise. */
  homeTenantId: string;
  impersonationSessionId: string | null;
}

const STATUS: Record<ScannerActionError, number> = {
  invalid_request: 400,
  invalid_name: 400,
  unconfirmed: 400,
  changed: 409,
  live_token: 409,
  no_scanner: 409,
  no_live_token: 409,
  name_mismatch: 409,
  several_scanners: 409,
};

export function statusOf(result: ScannerActionResult): number {
  return result.ok ? 200 : STATUS[result.error];
}

/** Makes, replaces or revokes the tenant's scanner token (module header). */
export async function scannerTokenAction(
  deps: ScannerActionDeps,
  form: FormData,
  tenant: Tenant,
  actor: ScannerActor,
): Promise<ScannerActionResult> {
  const access = await captureAccess(deps.db, tenant, actor.user);
  if (!access.manager) throw new Response(null, { status: 403 });

  const intent = form.get("intent");
  const seen = form.get("seen");
  if (typeof intent !== "string" || !(SCANNER_TOKEN_ACTIONS as readonly string[]).includes(intent)) {
    return { ok: false, error: "invalid_request" };
  }
  if (typeof seen !== "string") return { ok: false, error: "invalid_request" };
  const action = intent as ScannerTokenAction;
  if (action !== "make" && form.get("confirm") !== "yes") return { ok: false, error: "unconfirmed" };

  const rows = await readScanners(deps.d1, tenant.id);
  if (rows.length <= 1 && versionOf(rows[0] ?? null) !== seen) return { ok: false, error: "changed" };
  const plan = planScannerToken(action, rows, null);
  if (!plan.ok) return { ok: false, error: plan.refusal };
  if (plan.step === "none") return { ok: false, error: "no_live_token" };
  const step = plan.step;
  const current = plan.current;
  const name = form.get("name");
  if (step === "create" && (typeof name !== "string" || !isNameOk(name))) return { ok: false, error: "invalid_name" };

  const now = deps.now();
  const minted = step === "revoke" ? null : await (deps.mint ?? mintScannerToken)();
  const scannerId = current?.id ?? deps.newId();
  const write = {
    tenantId: tenant.id,
    current,
    newId: scannerId,
    name: current?.name ?? (name as string),
    sha256: minted?.sha256 ?? null,
    now,
    writeId: deps.newId(),
  };

  const statement = scannerTokenStatement(step, write);
  const landed = landedCondition(write, scannerId);
  const audit = {
    sql:
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
      "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)\n" +
      "SELECT ?, ?, ?, ?, ?, 'scanner_token', ?, 'capture_scanner', ?, ?, ?\n" +
      `WHERE EXISTS (SELECT 1 FROM capture_scanners WHERE ${landed.sql});`,
    params: [
      deps.newId(),
      now,
      actor.user.id,
      actor.user.email,
      actor.homeTenantId,
      tenant.id,
      scannerId,
      actor.impersonationSessionId,
      JSON.stringify({ step, name: write.name }),
      ...landed.params,
    ],
  };
  await deps.d1.batch([
    deps.d1.prepare(statement.sql).bind(...statement.params),
    deps.d1.prepare(audit.sql).bind(...audit.params),
  ]);

  const check = landedQuery(write, scannerId);
  const after = await deps.d1.prepare(check.sql).bind(...check.params).first();
  if (!after) return { ok: false, error: "changed" };
  return minted ? { ok: true, step, token: minted.token } : { ok: true, step };
}

// @version v0.8.0
