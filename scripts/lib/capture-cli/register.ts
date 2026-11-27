/**
 * Scripts — running `fisqua capture register`
 *
 * This module registers the volumes of one Captua capture manifest with
 * the media pipeline on the command line's engine (`../cli/run-file.ts`).
 * The manifest's checks, the plan, the inventory of the masters bucket
 * and the statements are those of `../capture-registration.ts`, which
 * writes what the delivery endpoint writes for a manifest sent over the
 * link; this module adds what every noun of the command line does around
 * a plan. `scripts/fisqua.ts` is a thin shell around
 * `runCaptureRegister`; the reads, the writes, B2 and the clock are
 * injected, so the tests run it against an in-memory SQLite database and
 * the storage fakes (`tests/import/capture-registration.test.ts`).
 *
 * `plan` reads D1, lists the masters bucket when the operator's B2
 * credentials are set (without them the inventory is reported
 * unchecked), and writes the report,
 * `.import/capture-register_<target>_<stamp>-<suffix>.json`, and, when a
 * volume is to be written, creates the SQL file beside it (`.sql`),
 * refusing to replace one; it writes nothing to D1, B2, GitHub or the
 * Worker. `apply` needs the B2 credentials, plans the same way, and
 * reports "Nothing to write" when every volume is set aside. Otherwise
 * it creates the SQL file, reads the volumes each page-less replacement
 * keeps, writes the report, checks that the file on disk hashes to the
 * SQL the run holds, and applies it as one unit (`applyCheckedSqlFile`).
 * It then re-reads every volume written (`verifyRegistration`) and plans
 * again: every volume written must now be set aside as
 * `already_registered`, so the second plan must find nothing to write.
 * A re-read that does not match stops the command with its message; a
 * second plan that finds a volume to write stops it with that. Either
 * way the report, written again, records it.
 *
 * Who acts: the user of `--actor-email`, checked as the Capture QC
 * screen checks who decides (`readCaptureAccess` in
 * `../qc-decisions.ts`): a platform admin, a user of the tenant with
 * workspace, super or digitization admin rights or a steward membership,
 * a steward or staff member of the tenant's active federation, or the
 * workspace admin of that federation's lead tenant; the tenant must not
 * be disabled and must have the digitization capability. The SQL file
 * opens with the guards that everything this check read still holds
 * (`captureAccessGuards`). Registration writes no row that names a
 * user, so the actor is checked and guarded, and recorded only in the
 * report, with how they acted (`actor.actedAs`).
 *
 * An apply to production needs `--confirm-production`, checked before
 * anything is read (`assertProductionConfirmed`); `--allow-captured` is
 * refused against production.
 *
 * @version v0.9.0
 */

import { bodyDigest } from "../../../app/lib/capture/token";
import { captureAccessGuards } from "../cli/access-guards";
import {
  applyCheckedSqlFile,
  assertProductionConfirmed,
  runNameOf,
  type RunOptions,
  type RunProviders,
} from "../cli/run-file";
import {
  parseCaptureManifest,
  planRegistration,
  readKeptVolumes,
  RegistrationStop,
  verifyRegistration,
  type RegistrationReport,
} from "../capture-registration";
import { readCaptureAccess, type DeciderBasis } from "../qc-decisions";
import type { B2Api, D1Api } from "../tenant-storage";

export interface CaptureRegisterOptions extends RunOptions {
  /** Staging tests only: register volumes whose records are still `captured`. */
  allowCaptured: boolean;
}

export interface CaptureRegisterProviders extends RunProviders {
  /** The tenant and its federation's storage record, read through wrangler. */
  d1: D1Api;
  /** Null without the operator's B2 credentials; an apply needs them. */
  b2: B2Api | null;
}

/** The manifest's file name and its parsed JSON value, read as strict UTF-8. */
export interface CaptureRegisterInput {
  file: string;
  raw: unknown;
  /** The body's digest; by default `bodyDigest` of `raw`, as the link digests a body. */
  bodySha256?: string;
}

export type CaptureRegisterReport = RegistrationReport & { actor: { id: string; email: string; actedAs: DeciderBasis } };

/**
 * Plans the manifest and writes the report and the SQL file; with
 * `apply`, applies the file, reads it back and plans again (module
 * header). Returns the report; throws a `RegistrationStop` on a refusal.
 */
export async function runCaptureRegister(
  input: CaptureRegisterInput,
  options: CaptureRegisterOptions,
  providers: CaptureRegisterProviders,
  log: (line: string) => void,
): Promise<CaptureRegisterReport> {
  const stop = (message: string) => new RegistrationStop(message);
  assertProductionConfirmed(options, stop);
  if (options.allowCaptured && options.target === "production") {
    throw stop("--allow-captured is for staging tests and is refused against production");
  }
  const manifest = parseCaptureManifest(input.raw);
  const { name } = runNameOf("capture-register", options.target, providers, providers.now());

  let access;
  try {
    access = await readCaptureAccess(providers.rows, options.tenant, options.actorEmail);
  } catch (err) {
    throw stop((err as Error).message);
  }
  log(`Acting as ${access.decider.email} (${access.decider.id})` +
    (access.decider.grantHome ? `, under a ${access.decider.grantRole} grant from tenant ${access.decider.grantHome}` : "") +
    (access.decider.actedAs === "lead-admin" ? ", as the admin of the lead workspace of its federation" : ""));

  const planOptions = {
    slug: options.tenant,
    target: options.target,
    apply: options.apply,
    allowCaptured: options.allowCaptured,
    // The body's digest as the link takes it, so the same document sent
    // over the link with the same id gets the same answer.
    bodySha256: input.bodySha256 ?? (await bodyDigest(input.raw)),
  };
  const plan = await planRegistration(manifest, planOptions, providers, log);
  if (plan.tenantId !== access.tenantId) {
    throw stop(`The tenant ${options.tenant} reads as ${plan.tenantId} from its storage record and ${access.tenantId} from D1`);
  }
  const report: CaptureRegisterReport = Object.assign(plan.report, {
    actor: { id: access.decider.id, email: access.decider.email, actedAs: access.decider.actedAs },
  });

  const reportFile = `${name}.json`;
  const sqlFile = `${name}.sql`;
  const writeReport = () => {
    providers.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
    log("");
    log(`Report: ${reportFile}`);
  };
  // Who acts is checked once, when the run plans; the file opens by checking it again.
  const statements = plan.writes.length > 0 ? [...captureAccessGuards(access.access), ...plan.statements] : [];
  const sqlText = statements.join("\n") + "\n";
  const createSql = () => {
    providers.createFile(sqlFile, sqlText);
    log("");
    log(`Wrote ${statements.length} statements to ${sqlFile}`);
  };

  if (!options.apply) {
    if (statements.length > 0) createSql();
    writeReport();
    return report;
  }
  if (statements.length === 0) {
    log("");
    log("Nothing to write.");
    writeReport();
    return report;
  }

  createSql();
  const kept = await readKeptVolumes(plan, providers.rows);
  // The report is written before the apply, so a run stopped there still has it.
  writeReport();
  await applyCheckedSqlFile(providers, sqlFile, sqlText, statements, log, stop);
  report.applied = true;

  const verified = await verifyRegistration(plan, kept, providers.rows, log);
  const again = await planRegistration(manifest, planOptions, providers, () => {});
  const problems = again.writes.map((v) => `${v.stem}: the second plan finds it to ${v.action}`);
  report.problems = problems;
  log("");
  log(problems.length === 0 ? "Planned again: nothing is left to write." : problems.join("\n"));
  writeReport();
  if (verified.some((x) => !x.ok)) throw stop("The re-read does not match what was written; see the report");
  if (problems.length > 0) throw stop("Planned again after the write, the manifest still has volumes to write; see the report");
  return report;
}

// @version v0.9.0
