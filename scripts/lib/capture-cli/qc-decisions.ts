/**
 * Scripts — running `fisqua capture qc-decisions`
 *
 * This module runs a list of capture QC decisions (`parseQcList` in
 * `../qc-decisions.ts`) against a target D1 on the command line's
 * engine (`../cli/run-file.ts`). The list, the rules for each row, who
 * may decide and the statements written are those of
 * `../qc-decisions.ts`, which records each opening as the Capture QC
 * screen records it; this module adds what every noun of the command
 * line does around a plan. `scripts/fisqua.ts` is a thin shell around
 * `runCaptureQcDecisions`; the reads, the writes and the clock are
 * injected, so the tests run it against the Workers test pool's D1
 * binding (`tests/capture/record-qc-decisions.test.ts`).
 *
 * `plan` reads D1, sorts every row and writes the report,
 * `.import/capture-qc-decisions_<target>_<stamp>-<suffix>.json`, and,
 * when there is something to write and no row is a conflict, missing or
 * locked, creates the SQL file beside it (`.sql`), refusing to replace
 * one; it writes nothing to D1. `apply` plans the same way, stops before
 * anything is written while any row is a conflict, missing or locked,
 * and reports "Nothing to write" when every row is already recorded.
 * Otherwise it creates the SQL file, writes the report, checks that the
 * file on disk hashes to the SQL the run holds, and applies it as one
 * unit (`applyCheckedSqlFile`). It then re-reads every set and decision
 * written (`verifyQcWrites`) and plans again: the second plan must find
 * every row `same`. A volume that does not read back stops the command
 * with the read-back's message; a second plan that finds anything else
 * stops it with that. Either way the report, written again, lists the
 * problems.
 *
 * The SQL file opens with the guards on who acts
 * (`captureAccessGuards` in `../cli/access-guards.ts`): the tenant and
 * the decider as `readCaptureAccess` read them when the run planned. A
 * change between the plan and the apply fails the file whole, nothing
 * written.
 *
 * An apply to production needs `--confirm-production`, checked before
 * anything is read (`assertProductionConfirmed`). `--revise` lets a row
 * replace a different decision already recorded, as before.
 *
 * @version v0.9.0
 */

import { captureAccessGuards } from "../cli/access-guards";
import {
  applyCheckedSqlFile,
  assertProductionConfirmed,
  runNameOf,
  type RunOptions,
  type RunProviders,
} from "../cli/run-file";
import {
  blockingRows,
  listIdOf,
  parseQcList,
  planQcDecisions,
  QcDecisionStop,
  verifyQcWrites,
  type QcDecisionReport,
} from "../qc-decisions";

export interface CaptureQcOptions extends RunOptions {
  /** Whether a row may replace a different decision already recorded. */
  revise: boolean;
}

/** The list's file name and its text, decoded as strict UTF-8. */
export interface CaptureQcInput {
  file: string;
  text: string;
}

/**
 * Plans the list and writes the report and the SQL file; with `apply`,
 * applies the file, reads it back and plans again (module header).
 * Returns the report; throws a `QcDecisionStop` on a refusal.
 */
export async function runCaptureQcDecisions(
  input: CaptureQcInput,
  options: CaptureQcOptions,
  providers: RunProviders,
  log: (line: string) => void,
): Promise<QcDecisionReport> {
  const stop = (message: string) => new QcDecisionStop(message);
  assertProductionConfirmed(options, stop);
  const list = parseQcList(input.text, input.file.toLowerCase().endsWith(".json") ? "json" : "tsv");
  const { name } = runNameOf("capture-qc-decisions", options.target, providers, providers.now());
  const planOptions = {
    slug: options.tenant,
    decidedBy: options.actorEmail,
    sourceRecord: options.target,
    revise: options.revise,
    listId: await listIdOf(input.text),
  };
  const plan = await planQcDecisions(list, planOptions, providers, log);
  const { report } = plan;

  const reportFile = `${name}.json`;
  const sqlFile = `${name}.sql`;
  const writeReport = () => {
    providers.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
    log("");
    log(`Report: ${reportFile}`);
  };
  const blocking = blockingRows(report);
  // Who decides is checked once, when the run plans; the file opens by checking it again.
  const statements = plan.statements.length > 0 ? [...captureAccessGuards(plan.access), ...plan.statements] : [];
  const sqlText = statements.join("\n") + "\n";
  const createSql = () => {
    providers.createFile(sqlFile, sqlText);
    log("");
    log(`Wrote ${statements.length} statements for ${report.volumes.length} volumes to ${sqlFile}`);
  };

  if (!options.apply) {
    if (blocking === 0 && statements.length > 0) createSql();
    writeReport();
    return report;
  }
  if (blocking > 0) {
    writeReport();
    throw new QcDecisionStop(
      `Nothing was written: ${report.counts.conflict} conflicts, ${report.counts.missing} missing and ` +
        `${report.counts.locked} locked rows need resolving first`,
    );
  }
  if (statements.length === 0) {
    log("");
    log("Nothing to write: every row is already recorded.");
    writeReport();
    return report;
  }

  createSql();
  // The report is written before the apply, so a run stopped there still has it.
  writeReport();
  await applyCheckedSqlFile(providers, sqlFile, sqlText, statements, log, stop);
  report.applied = true;

  await verifyQcWrites(plan, providers.rows, log);
  const again = await planQcDecisions(list, planOptions, providers, () => {});
  const problems = again.report.rows
    .filter((r) => r.outcome !== "same")
    .map((r) => `line ${r.line} ${r.stem}: the second plan finds it ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  report.problems = problems;
  log("");
  log(problems.length === 0 ? "Planned again: every row is already recorded." : problems.join("\n"));
  writeReport();
  if (report.volumes.some((v) => !v.verified)) {
    throw new QcDecisionStop(
      "The re-read does not show every write: a decision or a run was recorded on a volume between the read and the write. Run the list again to see where it stands",
    );
  }
  if (problems.length > 0) {
    throw new QcDecisionStop("Planned again after the write, the list still has rows to write; see the report");
  }
  return report;
}

// @version v0.9.0
