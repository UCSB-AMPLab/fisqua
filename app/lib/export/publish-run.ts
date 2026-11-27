/**
 * Publish Run — the request, the run row and the workflow's parameters
 *
 * This module deals with the parts of starting a publish run that the
 * publish API (`app/routes/api.publish.tsx`) and the command line's
 * `publish start` (`scripts/lib/publish-cli/`) must do identically, so
 * that a run started from either is the same run. It holds no Worker
 * binding and imports nothing that needs one, so a Node script can load
 * it.
 *
 * `PUBLISH_TYPES` and `publishRequestSchema(fondsList)` are the request's
 * validation: at least one fonds, every one in the list the publish page
 * offers, at least one type, each one of the four, and an optional
 * `force`.
 *
 * `INSERT_PUBLISH_RUN_SQL` is the conditional insert of the run row,
 * with numbered parameters, and `insertPublishRunBinds` gives its values
 * in order. `INSERT_PUBLISH_RUN_ANY_TENANT_SQL`, built by the same
 * `insertPublishRunSql`, takes the same values and checks the live runs
 * of every tenant; the command line uses it against production. The statement writes the row only when no other run of the
 * tenant is pending or running with a heartbeat (or start, or creation)
 * newer than `PUBLISH_STALE_AFTER_MS`; check and insert are one
 * statement, so two requests that arrive together cannot both pass. When
 * it writes no row the caller stops with `PUBLISH_IN_PROGRESS_MESSAGE`.
 *
 * `publishWorkflowParams` is what the workflow instance is created with,
 * `force` only when asked, and `workflowCreateFailedMessage` is the
 * error message a run is closed with when the instance cannot be
 * created.
 *
 * @version v0.9.0
 */

import { z } from "zod";

/** The data types a publish run can include. */
export const PUBLISH_TYPES = ["descriptions", "repositories", "entities", "places"] as const;

/**
 * How long an unfinished run blocks a new publish of the same tenant,
 * counted from its last heartbeat (or its start, or its creation, when
 * it has not yet written one). The workflow sets no step timeouts of
 * its own, and every step writes a heartbeat, so a pending or running
 * row that has been silent this long is presumed dead: a run killed
 * without reaching its error handler would otherwise block publishing
 * for good.
 */
export const PUBLISH_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** The request's schema, accepting only the fonds of `fondsList`. */
export function publishRequestSchema(fondsList: readonly string[]) {
  return z.object({
    selectedFonds: z
      .array(
        z.string().refine((val) => fondsList.includes(val), {
          message: "Invalid fonds code",
        })
      )
      .nonempty("selectedFonds must contain at least one fonds code"),
    selectedTypes: z
      .array(z.enum(PUBLISH_TYPES))
      .nonempty("selectedTypes must contain at least one type"),
    // Write every per-fonds file whatever its recorded fingerprint.
    force: z.boolean().optional(),
  });
}

export const PUBLISH_IN_PROGRESS_MESSAGE =
  "Another publish for this tenant is still in progress. Wait for it to finish before starting a new one.";

/**
 * The conditional insert, its check scoped to the run's tenant or, with
 * `"every tenant"`, to the live runs of every tenant. The values are the
 * same either way; `?8` is still the run's tenant.
 */
export function insertPublishRunSql(check: "tenant" | "every tenant"): string {
  const tenantTerm = check === "tenant" ? "r.tenant_id = ?8\n         AND " : "";
  return `INSERT INTO export_runs (
       id, triggered_by, tenant_id, status, selected_fonds, selected_types,
       federation_id, steps_completed, total_steps, created_at
     )
     SELECT ?1, ?2, ?8, 'pending', ?3, ?4, ?5, 0, ?6, ?7
     WHERE NOT EXISTS (
       SELECT 1 FROM export_runs r
       WHERE ${tenantTerm}r.status IN ('pending', 'running')
         AND COALESCE(r.last_heartbeat_at, r.started_at, r.created_at) > ?9
     )`;
}

// The run records the request tenant, and the check reads the runs of
// that tenant, as the API's loader and the workflow's load-config do. A
// federation publish runs on the lead host and writes under the lead's
// slug, so the lead tenant is the one checked.
export const INSERT_PUBLISH_RUN_SQL = insertPublishRunSql("tenant");

/**
 * The command line's insert against production, which may start only
 * when no run of any tenant is live there: the check of every tenant's
 * runs is inside the statement, so a run another tenant starts after an
 * earlier read still stops it.
 */
export const INSERT_PUBLISH_RUN_ANY_TENANT_SQL = insertPublishRunSql("every tenant");

export interface PublishRunInsert {
  exportId: string;
  /** The user who starts the run. */
  triggeredBy: string;
  /** The request tenant. */
  tenantId: string;
  selectedFonds: readonly string[];
  selectedTypes: readonly string[];
  /** The federation the run publishes, from the export scope. */
  federationId: string | null | undefined;
  totalSteps: number;
  now: number;
}

/** The values of `INSERT_PUBLISH_RUN_SQL`, ?1 to ?9. */
export function insertPublishRunBinds(v: PublishRunInsert): [string, string, string, string, string | null, number, number, string, number] {
  return [
    v.exportId,
    v.triggeredBy,
    JSON.stringify(v.selectedFonds),
    JSON.stringify(v.selectedTypes),
    // Recorded at insert so the run history is federation-attributed
    // even before the workflow's load-config runs (migration 0055).
    v.federationId ?? null,
    v.totalSteps,
    v.now,
    v.tenantId,
    v.now - PUBLISH_STALE_AFTER_MS,
  ];
}

/** The parameters the workflow instance is created with. */
export function publishWorkflowParams(exportId: string, force?: boolean): { exportId: string; force?: true } {
  return force ? { exportId, force: true } : { exportId };
}

/** The error message a run is closed with when its workflow instance is not created. */
export function workflowCreateFailedMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "failed to create workflow";
  return `workflow create failed: ${message}`;
}

// @version v0.9.0
