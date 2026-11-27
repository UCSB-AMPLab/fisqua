/**
 * Scripts — running `fisqua capture copy-renamed`
 *
 * This module copies one volume's pre-contract captures into the
 * federation's masters bucket under contract names, from a Captua rename
 * map, with the command line's report names and production check. The
 * map's checks, the classification of every entry and the copies are
 * those of `../rename-copy.ts`; `scripts/fisqua.ts` is a thin shell
 * around `runCaptureCopyRenamed`, and the tests run it against the
 * storage fakes (`tests/import/rename-copy.test.ts`).
 *
 * The verb writes nothing to D1. It reads the tenant and its
 * federation's storage record, read only, from the database
 * `--source-record` names (`production` by default, or `staging`), and
 * copies within B2, server side, with the operator's B2 credentials. B2
 * is one account for both environments, so the copy itself does not
 * depend on the source record.
 *
 * `plan` lists both buckets, sorts every entry and writes the report,
 * `.import/capture-copy-renamed_<source record>_<stamp>-<suffix>.json`
 * (`runNameOf`), so no two runs share a report; it copies nothing.
 * `apply` does the same, stops before copying anything while any entry
 * is a conflict or missing, copies the `[copy]` entries and checks each
 * copy, and writes the report again with every copy's result. Every
 * apply needs `--confirm-production`, whichever record `--source-record`
 * names, since the copy writes the federation's masters bucket, the same
 * bucket for both environments; it is checked before anything is read
 * (`assertProductionConfirmed`). A plan needs no flag.
 *
 * @version v0.9.0
 */

import { assertProductionConfirmed, runNameOf, type Target } from "../cli/run-file";
import { RegistrationStop } from "../capture-registration";
import { copyRenamedCaptures, parseRenameMap, type RenameCopyProviders, type RenameCopyReport } from "../rename-copy";

export interface CaptureCopyRenamedOptions {
  tenant: string;
  /** The database the tenant's storage record is read from. */
  sourceRecord: Target;
  apply: boolean;
  confirmProduction: boolean;
}

export interface CaptureCopyRenamedProviders extends RenameCopyProviders {
  /** A random id; its first eight hex characters make the report's name unique. */
  newId: () => string;
  now: () => number;
}

/** The map's file name and its parsed JSON value, read as strict UTF-8. */
export interface CaptureCopyRenamedInput {
  file: string;
  raw: unknown;
}

/**
 * Plans the map and writes the report; with `apply`, copies and checks
 * each `[copy]` entry (module header). Returns the report; throws a
 * `RegistrationStop` on a refusal.
 */
export async function runCaptureCopyRenamed(
  input: CaptureCopyRenamedInput,
  options: CaptureCopyRenamedOptions,
  providers: CaptureCopyRenamedProviders,
  log: (line: string) => void,
): Promise<RenameCopyReport> {
  const stop = (message: string) => new RegistrationStop(message);
  // Every apply writes the federation's masters bucket, which serves both
  // environments, so the engine's check is made as for production
  // whichever record the run reads.
  assertProductionConfirmed(
    { target: "production", tenant: options.tenant, actorEmail: "", apply: options.apply, confirmProduction: options.confirmProduction },
    () => stop("Applying a copy into the masters bucket also needs --confirm-production"),
  );
  const map = parseRenameMap(input.raw);
  const { name } = runNameOf("capture-copy-renamed", options.sourceRecord, providers, providers.now());
  return copyRenamedCaptures(map, { slug: options.tenant, apply: options.apply, reportFile: `${name}.json` }, providers, log);
}

// @version v0.9.0
