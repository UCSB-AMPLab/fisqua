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
 * counts the call against the rate window, so recording it costs no write
 * of its own), when the token was revoked, the mode the unit last
 * reported, and the linked unit's name and device id, which a collected
 * pairing stores. It never reads the token's hash. `deviceStateOf` and
 * `tokenStateOf` turn the row into the screen's states: the device is not
 * linked, waiting for its first call, linked, or revoked; the token is
 * none, active or revoked. The token's fourth state, just made, exists
 * only in the page that made it.
 *
 * `scannerTokenAction` carries out one action with the plan, the minting
 * and the statement of `scanner-token.ts`, the path the operator command
 * takes too. Its form fields are `intent` (`make`, `replace`, `revoke`,
 * or `erase_keys`, below), `seen` (the scanner's `version` as the page
 * showed it: its id and `revision`, so an action taken on a stale page is
 * refused with `changed` rather than replacing a token someone else just
 * made, however close together the two were) and, for replace and revoke,
 * `confirm=yes`, which the page sends only from its confirmation step. A
 * tenant without a scanner gets one from Make token, which then also
 * takes `name`: the unit's appliance id, the one the operator command
 * takes as `--appliance` and the unit's bucket keys carry, checked by the
 * same rule (`invalid_name` otherwise). Once the scanner exists the name
 * is not asked again, and one given is ignored.
 *
 * The same action pairs a Captua unit with the tenant by the code the
 * unit shows, in two intents, both open only to managers. `pair_lookup`
 * (field `code`) answers what the unit sent with its code: its unit
 * name, its device id, the workspace it reports being linked to now
 * (`currentTenant`, never looked up), the code as `XXX-XXX`, and
 * `replacesLinkedUnit`, true when the tenant's scanner has a live token.
 * It never answers the code's id, its hashes, or anything about another
 * workspace. `pair_approve` (fields `code`, `seen`, `keysSeen` and
 * `confirm=yes`, `unconfirmed` without it, as for the token actions)
 * binds the code to the tenant. In both, a tenant with
 * no stored scanner keys, or erased ones, is refused with `pair_no_keys`
 * before the code is looked up, so such a tenant learns nothing about
 * codes. The code is looked up by the SHA-256 of its normalised six
 * characters; a field that does not normalise, or no such code, is
 * `pair_unknown`, and a code that is not `waiting` or whose
 * `expires_at` has passed is `pair_not_waiting`. Wrong entries count
 * against the user (5 per 10 minutes) and the tenant (20 per hour).
 * After the stored keys are checked, every entry is counted
 * (`countHit`, one atomic UPSERT each) against the user and then, only
 * if the user's count accepted it, the tenant, before the code is looked
 * up, so entries sent at once cannot all pass the limit. When a count is
 * past its limit the entry is answered `pair_limited` with that count's
 * `retryAfterSeconds` and the code is not looked up, so an entry past
 * the limit says nothing about the code; every hit the entry made,
 * including the refused one, is given back, so a refused entry leaves
 * both counts as they were and a count at its limit never drifts above
 * it. Once the code is found waiting,
 * whatever the answer then is, and when it is a code this tenant has
 * already approved (`pair_not_waiting`), the hit is given back
 * (`uncountHit`, in the window the hit was counted in, so a late
 * give-back never lowers a newer window's count); only an unknown code,
 * or one not waiting that this
 * tenant did not approve, stays counted. Used one after another, five
 * wrong entries are answered with their own errors and the sixth entry,
 * right or wrong, is refused.
 *
 * Once the code is found waiting, the stored keys are opened
 * (`openStoredKeys`) with the private key the route passes
 * (`keysPrivateJwk`) and `keysEnvironment`, as collection opens them,
 * and the opened keys are discarded at once. Keys that do not open (the
 * secret is absent, or from another key pair), or an environment
 * setting other than exactly `production` or `staging`, which collection
 * refuses, are `pair_keys_unreadable` (503): nothing is written, the
 * code stays waiting, the entry is not counted, and one fixed line is
 * logged. Keys erased since the first check are `pair_no_keys`.
 *
 * Approval checks `seen` against the scanner as the token actions do,
 * and `keysSeen` against the stored keys' revision (`changed` when
 * either differs). It is one UPDATE guarded by the code being
 * `waiting` and unexpired, which sets the tenant, the approver, the
 * time, `collect_by` (`COLLECT_TTL_MS` later) and the scanner and key
 * revisions seen (0 for no scanner), for the collection to check. The
 * code table has no write id, so the audit row, `{ step:
 * "pair_approved", unitName, deviceId }` on the code, is inserted in
 * the same batch only where the UPDATE changed one row (`changes()`)
 * and the code now holds this approval; the UPDATE's own count of
 * changed rows decides the answer, and an UPDATE that changed nothing
 * is `pair_not_waiting`.
 *
 * Revoke takes `reason`: `replaced` (the unit was reset or replaced)
 * or `compromised` (it was lost, stolen or compromised); any other
 * value, or none, is `invalid_request` and nothing is written. The
 * revoke's audit row carries the reason. A compromised revoke also
 * erases the tenant's stored scanner keys in the same D1 batch: the
 * erasure (`eraseStoredKeysStatement`, given no revision) takes
 * whatever usable keys the tenant has when the batch runs, including
 * keys an operator stored again after this request read them, and is
 * guarded by the revoke having landed (`landedCondition`), so a revoke
 * that changed nothing erases nothing. When the tenant has no usable
 * keys, the erasure changes nothing and the revoke goes ahead alone. A
 * revoke is decided from the batch's own counts of changed rows: it
 * landed when its UPDATE changed one row, and keys were erased when the
 * erasure did; the answer carries `keysErased`.
 *
 * `erase_keys` (fields `keysSeen`, `invalid_request` when missing or not
 * a number, and `confirm=yes`, `unconfirmed` otherwise) erases the stored
 * keys without touching the scanner or its token, so keys left behind by
 * a unit already revoked or replaced can still be erased. With no stored
 * keys, or erased ones, it is `no_stored_keys`; with `keysSeen` other
 * than the keys' revision it is `changed`. Either way an erasure raises
 * the keys' revision, which voids a pairing code approved against the old
 * revision when the unit comes to collect it. Its audit row, `{ step:
 * "keys_erased", reason }` on the keys (`compromised` or `manual`), is
 * inserted in the same batch only where the erasure changed the row
 * (`changes()`) and the row now holds this erasure. Its answer carries
 * `keysErased: true` and `operatorsNotified` (below).
 *
 * Once a compromised revoke has landed, whether or not it erased
 * anything, and once `erase_keys` has, as the batch's own counts of
 * changed rows show, and whatever happens to the scanner afterwards,
 * every operator (a user of the platform tenant, or a platform admin of
 * any tenant, a user whose row has `is_platform_admin = 1`; a
 * workspace's super admin who is neither is not one) whose address
 * looks usable is sent one notice, one per distinct address (compared
 * in lower case; the first row in email, id order gives the language), in their saved
 * language (Spanish when none), naming the workspace, whether Fisqua
 * erased its stored copy, and the B2 key pairs to revoke by hand
 * (`applianceKeyNames`, for `environment`). After a compromised revoke
 * these are the pair named for the scanner's name before the revoke,
 * which the unit holds, and, when an erasure landed under another
 * appliance id (the erasing statement returns it; the id read before the
 * batch stands in if it does not), that id's pair too. After
 * `erase_keys` it is the stored keys' pair alone. Fisqua erases only its
 * own copy and never calls B2 key management.
 * The notice holds no key id and no secret. The sender is a dependency
 * (`sendKeysErased`); the sends are awaited one after another, as the
 * other emails' callers do; a send fails when Resend refuses the
 * message. A failed read of the operators, no operator to mail, or a
 * failed send is logged with a fixed line, without addresses or key
 * names, and changes neither the revoke nor the erasure. The answers of
 * a compromised revoke and of `erase_keys` carry `operatorsNotified`,
 * true when at least one notice was sent, so the page can tell the
 * administrator to reach an operator directly when none was.
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
 * @version v0.9.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Tenant, User } from "../../context";
import type { CaptureScannerMode } from "../validation/enums";
import { captureAccess } from "./screens.server";
import { mintScannerToken, sha256Hex } from "./token";
import { COLLECT_TTL_MS, formatPairingCode, normalizePairingCode } from "./pairing-code";
import { countHit, uncountHit } from "./pairing-limits.server";
import { applianceKeyNames, eraseStoredKeysStatement, loadStoredKeys, openStoredKeys } from "./scanner-keys.server";
import { chooseEmailLocale } from "../email-locale.server";
import { PLATFORM_TENANT_ID } from "../tenant";
import type { SupportedLanguage } from "../language-cookie.server";
import {
  hasLiveToken,
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
  type SqlStatement,
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
  /** The mode the unit last reported, and when; null until it reports one. */
  mode: CaptureScannerMode | null;
  modeReportedAt: number | null;
  /** The linked unit's name and device id, as a pairing stored them; null until one does. */
  unitName: string | null;
  deviceId: string | null;
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
  const reported = await d1
    .prepare("SELECT mode, mode_reported_at, unit_name, device_id FROM capture_scanners WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, s.id)
    .first<{
      mode: CaptureScannerMode | null;
      mode_reported_at: number | null;
      unit_name: string | null;
      device_id: string | null;
    }>();
  return {
    mode: reported?.mode ?? null,
    modeReportedAt: reported?.mode_reported_at ?? null,
    unitName: reported?.unit_name ?? null,
    deviceId: reported?.device_id ?? null,
    name: s.name,
    tokenState: tokenStateOf(s),
    deviceState: deviceStateOf(s),
    tokenCreatedAt: s.tokenCreatedAt,
    lastSeenAt: s.lastSeenAt,
    revokedAt: s.revokedAt,
    version: versionOf(s),
  };
}

export type PairingError = "pair_unknown" | "pair_not_waiting" | "pair_no_keys" | "pair_limited" | "pair_keys_unreadable";

export type ScannerActionError =
  | "invalid_request"
  | "invalid_name"
  | "unconfirmed"
  | "changed"
  | "no_stored_keys"
  | ScannerTokenRefusal
  | PairingError;

/** What `pair_lookup` shows of a waiting code. */
export interface PairingView {
  code: string;
  unitName: string;
  deviceId: string;
  currentTenant: string | null;
  replacesLinkedUnit: boolean;
}

export type ScannerActionResult =
  | { ok: true; step: Exclude<ScannerTokenStep, "none" | "revoke">; token?: string }
  | { ok: true; step: "revoke"; keysErased: boolean; operatorsNotified?: boolean }
  | { ok: true; step: "pair_lookup"; pairing: PairingView }
  | { ok: true; step: "pair_approve" }
  | { ok: true; step: "erase_keys"; keysErased: true; operatorsNotified: boolean }
  | { ok: false; error: ScannerActionError; retryAfterSeconds?: number };

/** The stored keys' state as the page shows it: no key material. */
export interface StoredKeysState {
  applianceId: string;
  usable: boolean;
  erasedAt: number | null;
  revision: number;
}

/** The tenant's stored scanner keys as the page shows them, or null when none were stored. */
export async function loadStoredKeysState(
  db: DrizzleD1Database<any>,
  tenantId: string,
): Promise<StoredKeysState | null> {
  const keys = await loadStoredKeys(db, tenantId);
  if (!keys) return null;
  return { applianceId: keys.applianceId, usable: keys.usable, erasedAt: keys.erasedAt, revision: keys.revision };
}

/** The names of one pair of B2 keys to revoke: the upload key and the read key. */
export interface KeysToRevoke {
  write: string;
  read: string;
}

/**
 * What the operators are told after a compromised revoke or an erasure:
 * whether Fisqua erased its stored copy, and the B2 key pairs to revoke.
 * No key ids, no secrets.
 */
export interface KeysErasedNotice {
  workspace: string;
  slug: string;
  erased: boolean;
  keys: KeysToRevoke[];
}

export interface ScannerActionDeps {
  d1: D1Database;
  db: DrizzleD1Database<any>;
  now: () => number;
  newId: () => string;
  mint?: () => Promise<{ token: string; sha256: string }>;
  /** The environment the B2 keys are named for (`CAPTURE_PAIRING_ENVIRONMENT`, `pairingEnvironment`). */
  environment: "production" | "staging";
  /** The Worker secret `CAPTURE_KEYS_PRIVATE_JWK`, which opens the stored keys; unset when absent. */
  keysPrivateJwk: string | undefined;
  /**
   * The environment the stored keys are opened for, as collection reads
   * it: `CAPTURE_PAIRING_ENVIRONMENT` when it is exactly `production` or
   * `staging`, otherwise null, which refuses pairing.
   */
  keysEnvironment: "production" | "staging" | null;
  /** Sends the erasure notice to one operator, in `locale`. */
  sendKeysErased: (to: string, locale: SupportedLanguage, notice: KeysErasedNotice) => Promise<void>;
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
  pair_unknown: 404,
  pair_not_waiting: 409,
  pair_no_keys: 409,
  pair_limited: 429,
  pair_keys_unreadable: 503,
  no_stored_keys: 409,
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
  if (intent === "pair_lookup" || intent === "pair_approve") return pairingAction(deps, form, tenant, actor, intent);
  if (intent === "erase_keys") return eraseKeysAction(deps, form, tenant, actor);
  const seen = form.get("seen");
  if (typeof intent !== "string" || !(SCANNER_TOKEN_ACTIONS as readonly string[]).includes(intent)) {
    return { ok: false, error: "invalid_request" };
  }
  if (typeof seen !== "string") return { ok: false, error: "invalid_request" };
  const action = intent as ScannerTokenAction;
  const reason = form.get("reason");
  if (action === "revoke" && !(REVOKE_REASONS as readonly unknown[]).includes(reason)) {
    return { ok: false, error: "invalid_request" };
  }
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
      JSON.stringify(step === "revoke" ? { step, name: write.name, reason } : { step, name: write.name }),
      ...landed.params,
    ],
  };
  const statements: SqlStatement[] = [statement, audit];

  // A compromised unit's stored keys are erased with the revoke, in the
  // same batch, and only where the revoke itself landed. The erasure is
  // not tied to the revision read here: keys stored again since the read
  // are erased too.
  const compromised = step === "revoke" && reason === "compromised";
  const keys = compromised ? await loadStoredKeys(deps.db, tenant.id) : null;
  if (compromised) {
    statements.push(
      ...eraseStatements(undefined, tenant.id, actor, now, deps.newId(), "compromised", {
        sql: `EXISTS (SELECT 1 FROM capture_scanners WHERE ${landed.sql})`,
        params: landed.params,
      }),
    );
  }
  const results = await deps.d1.batch(statements.map((x) => deps.d1.prepare(x.sql).bind(...x.params)));

  if (step === "revoke") {
    // Decided from the batch's own counts, so a later write to the
    // scanner cannot hide an erasure that landed.
    const revoked = results[0].meta.changes === 1;
    const keysErased = compromised && results[2].meta.changes === 1;
    if (!revoked) return { ok: false, error: "changed" };
    if (!compromised) return { ok: true, step, keysErased };
    // The unit holds the keys named for the scanner's name before the
    // revoke; erased keys stored under another appliance id are named too.
    const ids = [write.name];
    const erasedId = keysErased ? (erasedApplianceId(results[2]) ?? keys?.applianceId) : undefined;
    if (erasedId !== undefined) ids.push(erasedId);
    const operatorsNotified = await notifyOperators(deps, tenant, ids, keysErased);
    return { ok: true, step, keysErased, operatorsNotified };
  }

  const check = landedQuery(write, scannerId);
  const after = await deps.d1.prepare(check.sql).bind(...check.params).first();
  if (!after) return { ok: false, error: "changed" };
  return minted ? { ok: true, step, token: minted.token } : { ok: true, step };
}

// ---------------------------------------------------------------------------
// Erasing the stored keys (module header)
// ---------------------------------------------------------------------------

/** Why a token is revoked: the unit was reset or replaced, or it was lost, stolen or compromised. */
export const REVOKE_REASONS = ["replaced", "compromised"] as const;

/**
 * The erasure of the stored keys, and its audit row, which is inserted
 * only where the erasure changed the row. With `seenRevision`, only the
 * keys as read at that revision are erased; without it, whatever usable
 * keys the tenant has when the batch runs. `onlyIf`, when given, is a
 * further condition the erasure needs, such as the revoke beside it
 * having landed.
 */
function eraseStatements(
  seenRevision: number | undefined,
  tenantId: string,
  actor: ScannerActor,
  now: number,
  auditId: string,
  reason: "compromised" | "manual",
  onlyIf?: SqlStatement,
): SqlStatement[] {
  const erase = eraseStoredKeysStatement(tenantId, seenRevision, actor.user.id, now, onlyIf);
  const revision = seenRevision === undefined ? [] : [seenRevision + 1];
  const audit: SqlStatement = {
    sql:
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
      "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)\n" +
      "SELECT ?, ?, ?, ?, ?, 'scanner_token', ?, 'capture_scanner_keys', ?, ?, ?\n" +
      "WHERE changes() = 1 AND EXISTS (SELECT 1 FROM capture_scanner_keys WHERE tenant_id = ? AND sealed IS NULL " +
      (seenRevision === undefined ? "" : "AND revision = ? ") +
      "AND erased_at = ? AND erased_by = ?);",
    params: [
      auditId,
      now,
      actor.user.id,
      actor.user.email,
      actor.homeTenantId,
      tenantId,
      tenantId,
      actor.impersonationSessionId,
      JSON.stringify({ step: "keys_erased", reason }),
      tenantId,
      ...revision,
      now,
      actor.user.id,
    ],
  };
  return [erase, audit];
}

/** The appliance id the erasing statement returned, if its result carries the row. */
function erasedApplianceId(result: D1Result): string | undefined {
  const row = (result.results as Array<{ appliance_id?: unknown }> | undefined)?.[0];
  return typeof row?.appliance_id === "string" ? row.appliance_id : undefined;
}

async function eraseKeysAction(
  deps: ScannerActionDeps,
  form: FormData,
  tenant: Tenant,
  actor: ScannerActor,
): Promise<ScannerActionResult> {
  const keysSeen = form.get("keysSeen");
  if (typeof keysSeen !== "string" || !/^\d{1,15}$/.test(keysSeen)) return { ok: false, error: "invalid_request" };
  if (form.get("confirm") !== "yes") return { ok: false, error: "unconfirmed" };

  const keys = await loadStoredKeys(deps.db, tenant.id);
  if (!keys || !keys.usable) return { ok: false, error: "no_stored_keys" };
  if (keys.revision !== Number(keysSeen)) return { ok: false, error: "changed" };

  const statements = eraseStatements(keys.revision, tenant.id, actor, deps.now(), deps.newId(), "manual");
  const [erased] = await deps.d1.batch(statements.map((x) => deps.d1.prepare(x.sql).bind(...x.params)));
  if (erased.meta.changes !== 1) return { ok: false, error: "changed" };
  const operatorsNotified = await notifyOperators(deps, tenant, [keys.applianceId], true);
  return { ok: true, step: "erase_keys", keysErased: true, operatorsNotified };
}

/**
 * Mails every operator (a user of the platform tenant, or a platform
 * admin of any tenant) the names of the B2 key pairs to revoke, one
 * pair per appliance id in `applianceIds` (each named once), and whether
 * Fisqua erased its stored copy, one message each, in the operator's
 * saved language. An address on several rows gets one message, compared
 * in lower case, in the language of the first row in email, id order.
 * A failed read of the operators, no operator to mail,
 * or a failed send is logged with a fixed line and changes nothing else.
 * Gives true when at least one message was sent.
 */
async function notifyOperators(
  deps: ScannerActionDeps,
  tenant: Tenant,
  applianceIds: string[],
  erased: boolean,
): Promise<boolean> {
  const notice: KeysErasedNotice = {
    workspace: tenant.name,
    slug: tenant.slug,
    erased,
    keys: [...new Set(applianceIds)].map((id) => applianceKeyNames(tenant.slug, id, deps.environment)),
  };
  let operators: Array<{ email: string; locale: string | null }>;
  try {
    const { results } = await deps.d1
      .prepare(
        "SELECT email, locale FROM users WHERE (tenant_id = ? OR is_platform_admin = 1) AND email LIKE '%_@_%' ORDER BY email, id",
      )
      .bind(PLATFORM_TENANT_ID)
      .all<{ email: string; locale: string | null }>();
    const seen = new Set<string>();
    operators = results.filter((row) => {
      const key = row.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    console.error("scanner keys erased: the operators could not be read");
    return false;
  }
  if (operators.length === 0) {
    console.error("scanner keys erased: no operator address to send a notice to");
    return false;
  }
  let sent = 0;
  for (const operator of operators) {
    try {
      await deps.sendKeysErased(operator.email, chooseEmailLocale({ userLocale: operator.locale }), notice);
      sent += 1;
    } catch {
      console.error("scanner keys erased: a notice to an operator could not be sent");
    }
  }
  return sent > 0;
}

// ---------------------------------------------------------------------------
// Pairing a unit by its code (module header)
// ---------------------------------------------------------------------------

const ENTRY_USER_LIMIT = 5;
const ENTRY_USER_WINDOW_MS = 10 * 60_000;
const ENTRY_TENANT_LIMIT = 20;
const ENTRY_TENANT_WINDOW_MS = 60 * 60_000;

interface PairingCodeRow {
  id: string;
  unit_name: string;
  device_id: string;
  current_tenant: string | null;
  state: string;
  expires_at: number;
  tenant_id: string | null;
}

type CodeOutcome =
  | { ok: true; code: string; row: PairingCodeRow }
  | { ok: false; error: "pair_unknown" | "pair_not_waiting"; approvedHere: boolean };

async function findCode(d1: D1Database, field: string, tenantId: string, now: number): Promise<CodeOutcome> {
  const code = normalizePairingCode(field);
  if (code === null) return { ok: false, error: "pair_unknown", approvedHere: false };
  const row = await d1
    .prepare(
      "SELECT id, unit_name, device_id, current_tenant, state, expires_at, tenant_id FROM capture_pairing_codes " +
        "WHERE code_sha256 = ?",
    )
    .bind(await sha256Hex(code))
    .first<PairingCodeRow>();
  if (!row) return { ok: false, error: "pair_unknown", approvedHere: false };
  if (row.state !== "waiting" || row.expires_at <= now) {
    return { ok: false, error: "pair_not_waiting", approvedHere: row.state === "approved" && row.tenant_id === tenantId };
  }
  return { ok: true, code, row };
}

/** The wrong-entry limits for this user and tenant, as `[key, limit, windowMs]`. */
function entryLimits(tenantId: string, userId: string): Array<[string, number, number]> {
  return [
    [`entry-user:${userId}`, ENTRY_USER_LIMIT, ENTRY_USER_WINDOW_MS],
    [`entry-tenant:${tenantId}`, ENTRY_TENANT_LIMIT, ENTRY_TENANT_WINDOW_MS],
  ];
}

/** A hit counted against one entry limit: its key and the window it was counted in. */
type ChargedEntry = { key: string; windowStart: number };

/**
 * Counts this entry against the user, then the tenant, before the code
 * is looked up. The tenant is counted only once the user's count
 * accepted the entry. When a count refuses, every hit this entry made,
 * the refused one included (a refused `countHit` still counted it), is
 * given back in the window it was counted in, and the answer is
 * `pair_limited` with the refusing count's wait: a refused entry leaves
 * both counts as they were, alone or concurrent with others. Otherwise
 * the answer is null, with the hits charged, for `uncountEntry`.
 */
async function countEntry(
  deps: ScannerActionDeps,
  tenantId: string,
  userId: string,
  now: number,
): Promise<{ refused: ScannerActionResult | null; charged: ChargedEntry[] }> {
  const charged: ChargedEntry[] = [];
  for (const [key, limit, windowMs] of entryLimits(tenantId, userId)) {
    const r = await countHit(deps.db, key, limit, windowMs, now);
    charged.push({ key, windowStart: r.windowStart });
    if (!r.ok) {
      await uncountEntry(deps, charged);
      return { refused: { ok: false, error: "pair_limited", retryAfterSeconds: r.retryAfterSeconds }, charged: [] };
    }
  }
  return { refused: null, charged };
}

/** Gives back hits `countEntry` charged, each in the window it was counted in. */
async function uncountEntry(deps: ScannerActionDeps, charged: ChargedEntry[]): Promise<void> {
  for (const { key, windowStart } of charged) await uncountHit(deps.db, key, windowStart);
}

async function pairingAction(
  deps: ScannerActionDeps,
  form: FormData,
  tenant: Tenant,
  actor: ScannerActor,
  intent: "pair_lookup" | "pair_approve",
): Promise<ScannerActionResult> {
  const field = form.get("code");
  if (typeof field !== "string") return { ok: false, error: "invalid_request" };
  const seen = form.get("seen");
  const keysSeen = form.get("keysSeen");
  if (intent === "pair_approve") {
    if (typeof seen !== "string" || typeof keysSeen !== "string" || !/^\d{1,15}$/.test(keysSeen)) {
      return { ok: false, error: "invalid_request" };
    }
    if (form.get("confirm") !== "yes") return { ok: false, error: "unconfirmed" };
  }

  const keys = await loadStoredKeys(deps.db, tenant.id);
  if (!keys || !keys.usable) return { ok: false, error: "pair_no_keys" };

  const now = deps.now();
  const { refused, charged } = await countEntry(deps, tenant.id, actor.user.id, now);
  if (refused) return refused;
  const found = await findCode(deps.d1, field, tenant.id, now);
  // Only an unknown code, or one not waiting that this tenant did not
  // approve, stays counted as a wrong entry.
  if (found.ok || found.approvedHere) await uncountEntry(deps, charged);
  if (!found.ok) return { ok: false, error: found.error };
  const { row } = found;

  // The keys are opened as collection would open them, so a key pair that
  // cannot open them is found here, not by a unit polling into 503. The
  // opened keys are not kept.
  // Collection refuses an environment setting other than exactly
  // `production` or `staging`, so approval refuses it too.
  if (deps.keysEnvironment === null) {
    console.error("scanner pairing: no pairing environment configured");
    return { ok: false, error: "pair_keys_unreadable" };
  }
  try {
    const opened = await openStoredKeys(
      deps.db,
      { CAPTURE_KEYS_PRIVATE_JWK: deps.keysPrivateJwk },
      tenant.id,
      deps.keysEnvironment,
    );
    if (!opened) return { ok: false, error: "pair_no_keys" };
  } catch (err) {
    console.error(`scanner pairing: stored keys could not be opened: ${err instanceof Error ? err.name : "error"}`);
    return { ok: false, error: "pair_keys_unreadable" };
  }

  const rows = await readScanners(deps.d1, tenant.id);
  if (rows.length > 1) return { ok: false, error: "several_scanners" };
  const scanner = rows[0] ?? null;

  if (intent === "pair_lookup") {
    return {
      ok: true,
      step: "pair_lookup",
      pairing: {
        code: formatPairingCode(found.code),
        unitName: row.unit_name,
        deviceId: row.device_id,
        currentTenant: row.current_tenant,
        replacesLinkedUnit: scanner !== null && hasLiveToken(scanner),
      },
    };
  }

  if (versionOf(scanner) !== seen || keys.revision !== Number(keysSeen)) return { ok: false, error: "changed" };

  const approve = deps.d1
    .prepare(
      "UPDATE capture_pairing_codes SET state = 'approved', tenant_id = ?, approved_by = ?, approved_at = ?, " +
        "collect_by = ?, scanner_revision_seen = ?, keys_revision_seen = ?\n" +
        "WHERE id = ? AND state = 'waiting' AND expires_at > ?;",
    )
    .bind(tenant.id, actor.user.id, now, now + COLLECT_TTL_MS, scanner?.revision ?? 0, keys.revision, row.id, now);
  const audit = deps.d1
    .prepare(
      "INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action, " +
        "target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)\n" +
        "SELECT ?, ?, ?, ?, ?, 'scanner_token', ?, 'capture_pairing_code', ?, ?, ?\n" +
        "WHERE changes() = 1 AND EXISTS (SELECT 1 FROM capture_pairing_codes WHERE id = ? AND state = 'approved' " +
        "AND tenant_id = ? AND approved_by = ? AND approved_at = ?);",
    )
    .bind(
      deps.newId(),
      now,
      actor.user.id,
      actor.user.email,
      actor.homeTenantId,
      tenant.id,
      row.id,
      actor.impersonationSessionId,
      JSON.stringify({ step: "pair_approved", unitName: row.unit_name, deviceId: row.device_id }),
      row.id,
      tenant.id,
      actor.user.id,
      now,
    );
  const [updated] = await deps.d1.batch([approve, audit]);
  if (updated.meta.changes !== 1) return { ok: false, error: "pair_not_waiting" };
  return { ok: true, step: "pair_approve" };
}

// @version v0.9.0
