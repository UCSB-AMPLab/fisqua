/**
 * Gate Passes Carried Forward to Runner v1.1.0 — the Statements
 *
 * This module deals with the SQL that copies each recipe declaration's
 * gate pass on script version v1.0.0 to v1.1.0, the statement migration
 * 0105 runs and the `carry-gate-passes` operator command runs again on
 * each environment's move to v1.1.0, so a pass won on v1.0.0 after the
 * migration ran is carried too. Runner v1.1.0 processes an unrotated
 * page as v1.0.0 did and turns a rotated page upright before the
 * recipe's first stage, which is why a v1.0.0 pass holds for it.
 *
 * `CARRY_GATE_PASSES_SQL` copies every v1.0.0 pass with no v1.1.0 pass
 * for its declaration: same tenant, declaration, sample run, `passed_by`
 * and `passed_at`, a new id, `note` as `GATE_PASS_CARRY_NOTE`, and
 * `carried_from` the original's id. It is `INSERT OR IGNORE` on UNIQUE
 * (declaration_id, script_version), so running it again changes nothing.
 * `PENDING_CARRY_SQL` counts the passes it would copy.
 *
 * @version v0.8.0
 */

export const CARRY_FROM_VERSION = "v1.0.0";
export const CARRY_TO_VERSION = "v1.1.0";

export const GATE_PASS_CARRY_NOTE =
  "Carried forward from v1.0.0. Unrotated pages are processed unchanged; a rotated page is turned upright before the recipe's first stage.";

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** A UUID-shaped id SQLite makes for each copied row. */
const NEW_ID_SQL =
  "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' " +
  "|| substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";

export const CARRY_GATE_PASSES_SQL =
  "INSERT OR IGNORE INTO pipeline_gate_passes " +
  "(id, tenant_id, declaration_id, script_version, sample_run_id, passed_by, passed_at, note, carried_from) " +
  `SELECT ${NEW_ID_SQL}, tenant_id, declaration_id, ${quote(CARRY_TO_VERSION)}, sample_run_id, passed_by, passed_at, ` +
  `${quote(GATE_PASS_CARRY_NOTE)}, id FROM pipeline_gate_passes WHERE script_version = ${quote(CARRY_FROM_VERSION)}`;

export const PENDING_CARRY_SQL =
  "SELECT COUNT(*) AS n FROM pipeline_gate_passes p " +
  `WHERE p.script_version = ${quote(CARRY_FROM_VERSION)} AND NOT EXISTS (SELECT 1 FROM pipeline_gate_passes q ` +
  `WHERE q.declaration_id = p.declaration_id AND q.script_version = ${quote(CARRY_TO_VERSION)})`;

// @version v0.8.0
