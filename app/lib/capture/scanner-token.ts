/**
 * Capture Link — Making, Replacing and Revoking a Scanner's Token
 *
 * This module is the one path by which a tenant's Captua scanner gets,
 * changes or loses its link token for the Captua link. Two
 * callers use it: the operator command `scripts/commands/scanner-token.ts`,
 * which writes through wrangler with a SQL file, and the Scanner screen
 * (`scanner.server.ts`), which writes through the Worker's D1 binding.
 * Both read the tenant's scanner, ask `planScannerToken` what the action
 * comes to, mint with `mintScannerToken` (`token.ts`) and write the
 * statement `scannerTokenStatement` gives them; neither builds SQL of
 * its own. The module is pure and imports nothing Worker-only, so the
 * command can import it.
 *
 * A tenant has one scanner (the table keeps it a row of its own, so
 * several per tenant later means lifting a unique index), named with the
 * unit's short id. Its token is live when it has a hash and no
 * `revoked_at`.
 *
 *   - `make` gives the tenant's scanner a token: `create` when the
 *     tenant has no scanner, `issue` when its scanner has no token or a
 *     revoked one. A live token refuses it (`live_token`): replacing is
 *     a separate action with its own confirmation.
 *   - `replace` puts a new hash in place of the live one (`replace`), in
 *     one UPDATE, so the old token is unknown to the link from the moment
 *     the new one exists. It needs a scanner (`no_scanner`) with a live
 *     token (`no_live_token`).
 *   - `revoke` sets `revoked_at` and keeps the hash, so the link can
 *     tell a revoked token from an unknown one. With no live token there
 *     is nothing to do (`none`).
 *
 * A name given with the action must be the scanner's (`name_mismatch`),
 * and a tenant with more than one scanner stops every action
 * (`several_scanners`).
 *
 * Statements use `?` placeholders with their values beside them
 * (`SqlStatement`). Each write is guarded by the row it was planned
 * against: no scanner for the tenant yet, or the scanner's id,
 * `revision`, hash and `revoked_at` as read. Every write raises `revision` by one (a new
 * scanner starts at 1) and sets `write_id` to the caller's own id, so a
 * scanner changed between the read and the write is left as it was,
 * however close together the two writes were. The re-read
 * (`landedQuery`) and the screen's audit row (`landedCondition`) match
 * the new revision and this write's id, so only the write that changed
 * the row ever counts as landed.
 * Issuing or replacing a token clears `last_seen_at` and the rate window,
 * since they belong to the old token.
 *
 * @version v0.8.0
 */

import { SCANNER_NAME_PATTERN } from "./token";

export const SCANNER_TOKEN_ACTIONS = ["make", "replace", "revoke"] as const;
export type ScannerTokenAction = (typeof SCANNER_TOKEN_ACTIONS)[number];

/** What an action comes to against the scanner as read. */
export type ScannerTokenStep = "create" | "issue" | "replace" | "revoke" | "none";

/** Why an action cannot be taken against the scanner as read. */
export type ScannerTokenRefusal = "live_token" | "no_scanner" | "no_live_token" | "name_mismatch" | "several_scanners";

export interface ScannerRow {
  id: string;
  name: string;
  tokenSha256: string | null;
  revokedAt: number | null;
  tokenCreatedAt: number | null;
  lastSeenAt: number | null;
  updatedAt: number | null;
  revision: number;
  writeId: string | null;
}

export type ScannerTokenPlan =
  | { ok: true; step: ScannerTokenStep; current: ScannerRow | null }
  | { ok: false; refusal: ScannerTokenRefusal; current: ScannerRow | null };

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params: SqlValue[];
}

export function isNameOk(name: string): boolean {
  return SCANNER_NAME_PATTERN.test(name);
}

export function hasLiveToken(s: ScannerRow): boolean {
  return s.tokenSha256 !== null && s.revokedAt === null;
}

/** The columns every read of a scanner takes, in `rowOfScanner`'s names. */
export const SCANNER_COLUMNS =
  "id, name, token_sha256, revoked_at, token_created_at, last_seen_at, updated_at, revision, write_id";

/** The tenant's scanners (at most one is expected). */
export function scannerQuery(tenantId: string): SqlStatement {
  return { sql: `SELECT ${SCANNER_COLUMNS} FROM capture_scanners WHERE tenant_id = ?;`, params: [tenantId] };
}

/** A scanner row as D1 or the command's JSON reader returns it. */
export function rowOfScanner(r: Record<string, unknown>): ScannerRow {
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  return {
    id: String(r.id),
    name: String(r.name),
    tokenSha256: str(r.token_sha256),
    revokedAt: num(r.revoked_at),
    tokenCreatedAt: num(r.token_created_at),
    lastSeenAt: num(r.last_seen_at),
    updatedAt: num(r.updated_at),
    revision: num(r.revision) ?? 0,
    writeId: str(r.write_id),
  };
}

/** What `action` comes to for a tenant whose scanners are `rows`. */
export function planScannerToken(
  action: ScannerTokenAction,
  rows: ScannerRow[],
  name: string | null,
): ScannerTokenPlan {
  if (rows.length > 1) return { ok: false, refusal: "several_scanners", current: null };
  const current = rows[0] ?? null;
  if (current && name !== null && current.name !== name) return { ok: false, refusal: "name_mismatch", current };
  if (action === "make") {
    if (current && hasLiveToken(current)) return { ok: false, refusal: "live_token", current };
    return { ok: true, step: current ? "issue" : "create", current };
  }
  if (action === "replace") {
    if (!current) return { ok: false, refusal: "no_scanner", current };
    if (!hasLiveToken(current)) return { ok: false, refusal: "no_live_token", current };
    return { ok: true, step: "replace", current };
  }
  if (!current || !hasLiveToken(current)) return { ok: true, step: "none", current };
  return { ok: true, step: "revoke", current };
}

/** The guard that the scanner is still as it was read. */
function asRead(tenantId: string, s: ScannerRow): SqlStatement {
  return {
    sql: "tenant_id = ? AND id = ? AND revision = ? AND token_sha256 IS ? AND revoked_at IS ?",
    params: [tenantId, s.id, s.revision, s.tokenSha256, s.revokedAt],
  };
}

export interface ScannerTokenWrite {
  tenantId: string;
  /** The scanner as read; null for `create`. */
  current: ScannerRow | null;
  /** The new scanner's id, for `create`. */
  newId: string;
  /** The new scanner's name, for `create`. */
  name: string;
  /** The new token's hash, for `create`, `issue` and `replace`. */
  sha256: string | null;
  now: number;
  /** This write's own id, set as `write_id`. */
  writeId: string;
}

/** The revision a step leaves the scanner at. */
export function nextRevision(w: Pick<ScannerTokenWrite, "current">): number {
  return (w.current?.revision ?? 0) + 1;
}

/** The one statement that carries out a step (not `none`). */
export function scannerTokenStatement(step: Exclude<ScannerTokenStep, "none">, w: ScannerTokenWrite): SqlStatement {
  if (step === "create") {
    return {
      sql:
        "INSERT INTO capture_scanners (id, tenant_id, name, token_sha256, token_created_at, revision, write_id, created_at, updated_at)\n" +
        "SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?\n" +
        "WHERE NOT EXISTS (SELECT 1 FROM capture_scanners WHERE tenant_id = ?);",
      params: [w.newId, w.tenantId, w.name, w.sha256, w.now, w.writeId, w.now, w.now, w.tenantId],
    };
  }
  const guard = asRead(w.tenantId, w.current as ScannerRow);
  if (step === "revoke") {
    return {
      sql: `UPDATE capture_scanners SET revoked_at = ?, revision = revision + 1, write_id = ?, updated_at = ?\nWHERE ${guard.sql};`,
      params: [w.now, w.writeId, w.now, ...guard.params],
    };
  }
  return {
    sql:
      "UPDATE capture_scanners SET token_sha256 = ?, token_created_at = ?, revoked_at = NULL, " +
      "last_seen_at = NULL, rate_window_start = NULL, rate_window_calls = 0, revision = revision + 1, write_id = ?, " +
      "updated_at = ?\n" +
      `WHERE ${guard.sql};`,
    params: [w.sha256, w.now, w.writeId, w.now, ...guard.params],
  };
}

/**
 * The condition, on `capture_scanners`, that holds only once this
 * write has landed: the scanner's id at the revision the write set, with
 * this write's id. `landedQuery` reads
 * with it; the Scanner screen's audit row is inserted under it, so a
 * write that changed nothing records nothing.
 */
export function landedCondition(w: ScannerTokenWrite, scannerId: string): SqlStatement {
  return {
    sql: "tenant_id = ? AND id = ? AND revision = ? AND write_id = ?",
    params: [w.tenantId, scannerId, nextRevision(w), w.writeId],
  };
}

/** The scanner as the step leaves it, or no row if it did not land. */
export function landedQuery(w: ScannerTokenWrite, scannerId: string): SqlStatement {
  const c = landedCondition(w, scannerId);
  return { sql: `SELECT ${SCANNER_COLUMNS} FROM capture_scanners WHERE ${c.sql};`, params: c.params };
}

// @version v0.8.0
