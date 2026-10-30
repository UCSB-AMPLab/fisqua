/**
 * Scripts — a capture unit's link token
 *
 * This module deals with the bearer token a Captua unit presents on the
 * capture link the Captua exchange contract defines: making it, replacing it
 * and revoking it. It sits beside the appliance's bucket keys
 * (`./appliance-key`), which the same operator mints for the same unit.
 * The command in `scripts/commands/scanner-token.ts` is a thin shell
 * around `runScannerToken` here, and every provider is an argument, so
 * the tests run it against an in-memory database. What each subcommand
 * comes to, the statement that writes it and the re-read that checks
 * it are `app/lib/capture/scanner-token.ts`'s, the same the Scanner
 * screen uses; here they are written out as literals for wrangler.
 *
 * A tenant has one scanner (ruled for now; the table keeps it a row of
 * its own so that several per tenant later means lifting a unique
 * index), named with the unit's short id, the one its bucket keys
 * carry. The token is 32 random bytes as 64 lowercase hex characters
 * (`mintScannerToken`, shared with the Worker). Fisqua keeps only its
 * SHA-256; the token is printed once, after the write has been read
 * back, for the unit's key file, and is never written to a file, a log
 * line or the database.
 *
 *   - `make` gives a tenant's scanner a token: it creates the scanner
 *     row when the tenant has none, or gives a token to its scanner when
 *     that has none or its token was revoked. A scanner with a live
 *     token stops it: `replace` is the subcommand for that.
 *   - `replace` gives the scanner a new token in place of its live one,
 *     which stops working on the next call.
 *   - `revoke` marks the live token revoked, effective on the next call.
 *     The hash is kept, so the Worker can tell a revoked token from an
 *     unknown one. A scanner with no live token is reported and left.
 *
 * `--appliance` names the unit. `make` needs it; for `replace` and
 * `revoke` it is optional, and when given it must be the scanner's
 * name. A scanner of another name stops every subcommand, since a tenant
 * has one scanner.
 *
 * Reads go through `wrangler d1 execute --json --command`, writes
 * through one `--file`, as the other operator commands do. Each write
 * is guarded by the row it was planned against (no scanner yet, or the
 * scanner's id and revision), so a scanner changed between the read
 * and the write is left as it was; the re-read then shows it and the
 * command stops without printing a token. The SQL file holds the hash
 * only and is removed once applied.
 *
 * A dry run, the default, reads and prints what it would do; it mints
 * nothing and writes nothing.
 *
 * @version v0.8.0
 */

import { escapeSql } from "./sql";
import { ProvisionStop, type D1Api, type Log, type Target } from "./tenant-storage";
import type { RowReader } from "./capture-registration";
import { mintScannerToken } from "../../app/lib/capture/token";
import {
  isNameOk,
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
} from "../../app/lib/capture/scanner-token";

export { SCANNER_TOKEN_ACTIONS, type ScannerRow, type ScannerTokenAction };

export interface ScannerTokenOptions {
  action: ScannerTokenAction;
  /** The tenant's slug. */
  slug: string;
  /** The unit's short id; required for `make`. */
  appliance: string | null;
  target: Target;
  apply: boolean;
}

export interface ScannerTokenProviders {
  d1: D1Api;
  rows: RowReader;
  writeFile: (path: string, text: string) => void;
  applyFile: (path: string) => void;
  removeFile: (path: string) => void;
  now: () => number;
  newId: () => string;
  mint?: () => Promise<{ token: string; sha256: string }>;
}

export interface ScannerTokenResult {
  action: ScannerTokenAction;
  /** What was done, or would be: `create`, `issue`, `replace`, `revoke` or `none`. */
  step: ScannerTokenStep;
  applied: boolean;
  scannerId: string | null;
  /** Set once, after an applied make or replace was read back. */
  token?: string;
}

export function checkScannerName(name: string): void {
  if (!isNameOk(name)) {
    throw new ProvisionStop(`Not an appliance id: ${name} (lowercase letters, digits and hyphens, 1 to 32 characters)`);
  }
}

/**
 * A statement with its values written in as SQL literals, for a
 * `--command` read or the `--file` the command applies. The shared
 * statements hold no `?` other than their placeholders.
 */
export function inlineSql(statement: SqlStatement): string {
  const parts = statement.sql.split("?");
  if (parts.length !== statement.params.length + 1) throw new Error("Placeholder count does not match the values");
  return parts.reduce((out, part, i) => out + escapeSql(statement.params[i - 1]) + part);
}

export const OUTPUT_DIR = ".import";

export function sqlPath(slug: string, now: number): string {
  return `${OUTPUT_DIR}/scanner-token_${slug}_${now}.sql`;
}

function describe(s: ScannerRow): string {
  const token = s.tokenSha256 === null ? "no token" : s.revokedAt !== null ? "token revoked" : "live token";
  return `scanner ${s.name} (${s.id}), ${token}${s.lastSeenAt !== null ? `, last seen ${new Date(s.lastSeenAt).toISOString()}` : ""}`;
}

function refusalMessage(refusal: ScannerTokenRefusal, slug: string, rows: ScannerRow[], appliance: string | null): string {
  const current = rows[0];
  switch (refusal) {
    case "several_scanners":
      return `The tenant ${slug} has ${rows.length} scanners; one is expected`;
    case "name_mismatch":
      return `The tenant's scanner is ${current.name}, not ${appliance}; a tenant has one scanner`;
    case "live_token":
      return `The scanner ${current.name} has a live token; use replace to give it a new one`;
    case "no_scanner":
      return "The tenant has no scanner; use make";
    case "no_live_token":
      return `The scanner ${current.name} has no live token; use make`;
  }
}

/** Makes, replaces or revokes the tenant's scanner token (module header). */
export async function runScannerToken(
  options: ScannerTokenOptions,
  providers: ScannerTokenProviders,
  log: Log,
): Promise<ScannerTokenResult> {
  const { action, apply } = options;
  if (options.appliance !== null) checkScannerName(options.appliance);
  if (action === "make" && options.appliance === null) throw new ProvisionStop("make needs --appliance, the unit's short id");
  const tenant = await providers.d1.tenant(options.slug);
  if (!tenant) throw new ProvisionStop(`No tenant has the slug ${options.slug}`);
  const rows = (await providers.rows(inlineSql(scannerQuery(tenant.id)))).map(rowOfScanner);
  const plan = planScannerToken(action, rows, options.appliance);
  if (!plan.ok && plan.refusal === "several_scanners") {
    throw new ProvisionStop(refusalMessage(plan.refusal, tenant.slug, rows, options.appliance));
  }
  const current = plan.current;

  log(`Link token for tenant ${tenant.slug} (${tenant.id}), target ${options.target}${apply ? "" : ", dry run"}`);
  log(`  ${current ? describe(current) : "no scanner"}`);
  if (!plan.ok) throw new ProvisionStop(refusalMessage(plan.refusal, tenant.slug, rows, options.appliance));
  const step = plan.step;
  if (step === "none") {
    log("  [exists] no live token to revoke; nothing to do");
    return { action, step: "none", applied: false, scannerId: current?.id ?? null };
  }

  const name = current?.name ?? (options.appliance as string);
  const wording = {
    create: `create the scanner ${name} with a new token`,
    issue: `give the scanner ${name} a new token`,
    replace: `replace the scanner ${name}'s token; the old one stops working on its next call`,
    revoke: `revoke the scanner ${name}'s token, effective on its next call`,
    none: "",
  }[step];
  if (!apply) {
    log(`  [${step}] would ${wording}`);
    return { action, step, applied: false, scannerId: current?.id ?? null };
  }

  const now = providers.now();
  const minted = step === "revoke" ? null : await (providers.mint ?? mintScannerToken)();
  const scannerId = current?.id ?? providers.newId();
  const write = {
    tenantId: tenant.id,
    current,
    newId: scannerId,
    name,
    sha256: minted?.sha256 ?? null,
    now,
    writeId: providers.newId(),
  };
  const file = sqlPath(tenant.slug, now);
  providers.writeFile(file, inlineSql(scannerTokenStatement(step, write)) + "\n");
  try {
    providers.applyFile(file);
  } finally {
    providers.removeFile(file);
  }

  const landed = (await providers.rows(inlineSql(landedQuery(write, scannerId)))).length === 1;
  if (!landed) {
    throw new ProvisionStop(
      "The re-read does not show the write; the scanner changed between the read and the write. Run the command again",
    );
  }
  log(`  [${step}] ${wording.replace(/^\w/, (c) => c.toUpperCase())}: done`);
  if (minted) {
    log("");
    log("The token, shown once and stored nowhere; put it in the unit's key file:");
    log(`  ${minted.token}`);
    return { action, step, applied: true, scannerId, token: minted.token };
  }
  return { action, step, applied: true, scannerId };
}

// @version v0.8.0
