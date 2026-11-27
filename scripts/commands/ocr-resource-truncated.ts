/**
 * Re-source Truncated Transcripts — Pure Functions
 *
 * This module deals with the planning half of the one-off command that
 * restores the OCR transcripts the original import clipped. Fourteen
 * descriptions carry an `ocr-truncated` marker in `legacy_ids` whose id
 * is the byte length of the full original; the page-1 row holds only the
 * clipped text. Given the full originals in a local JSON file, these
 * functions decide which clipped rows can be restored and build the SQL
 * that restores them. Nothing here touches a database; the command-line
 * entry runs the SQL.
 *
 * `planResourcing` takes the clipped rows and the originals keyed by
 * reference code. A row is restored only when its marker exists, an
 * original was supplied, and the original's UTF-8 length equals the
 * length the marker recorded. Rows without an original are reported as
 * missing, and rows whose original has a different length as mismatched,
 * so a wrong file never overwrites a transcript.
 *
 * `splitForSql` cuts a text into pieces on code-point boundaries so that
 * each piece, once its single quotes are doubled, stays under a byte
 * budget. D1 rejects statements near 100 KB, and these are the rows that
 * were too large for that limit to begin with, so a restored text is
 * assembled from pieces rather than written in one statement.
 *
 * `restorationSql` returns the statements for one description, in order:
 * an INSERT into `ocr_pages_staging` with the first piece (selected from
 * the description itself, so it stages nothing for a description outside the
 * workspace), one UPDATE
 * appending each further piece, an UPDATE copying the assembled text into
 * the description's migrated page-1 row, and a DELETE clearing the staging
 * row. Every statement is scoped to the description's workspace, and the
 * copy leaves a pipeline-written page (`run_id` set) alone.
 *
 * `assertColumnRetired` refuses while `descriptions.ocr_text` still
 * exists. The migration that drops that column first overwrites every
 * migrated page-1 row that differs from it, which would put the clipped
 * text back over a restored page; restoring is therefore allowed only
 * after that migration has been applied.
 *
 * @version v0.8.0
 */
import { escapeSql } from "../lib/sql";

/** Largest SQL text, in bytes, that any one restoration statement may reach. */
export const RESTORE_STATEMENT_BYTES = 60_000;

/** Bytes left for the statement around a piece of text. */
const STATEMENT_HEADROOM_BYTES = 500;

/** Run id marking staging rows written by this command. */
const RESTORE_RUN_ID = "resource-truncated";

export interface ClippedRow {
  id: string;
  tenantId: string;
  referenceCode: string;
  legacyIds: string;
  text: string;
}

export interface TextUpdate {
  descriptionId: string;
  tenantId: string;
  text: string;
}

export interface ResourcingPlan {
  update: TextUpdate[];
  missing: string[];
  mismatched: string[];
}

/**
 * Decide which clipped rows an original can replace. The marker's id is
 * the byte length of the original as the importer measured it.
 */
export function planResourcing(
  rows: ClippedRow[],
  originals: Record<string, string>,
): ResourcingPlan {
  const update: TextUpdate[] = [];
  const missing: string[] = [];
  const mismatched: string[] = [];
  const encoder = new TextEncoder();
  for (const row of rows) {
    const entries = JSON.parse(row.legacyIds) as { provider: string; id: unknown }[];
    const mark = entries.find((e) => e.provider === "ocr-truncated");
    if (!mark) continue;
    const original = originals[row.referenceCode];
    if (original === undefined) {
      missing.push(row.referenceCode);
      continue;
    }
    const normalised = original.normalize("NFC");
    if (encoder.encode(normalised).length !== Number(mark.id)) {
      mismatched.push(row.referenceCode);
      continue;
    }
    update.push({ descriptionId: row.id, tenantId: row.tenantId, text: normalised });
  }
  return { update, missing, mismatched };
}

/**
 * Cut `text` into pieces whose quote-escaped UTF-8 size is at most
 * `maxEscapedBytes`. Pieces end on code-point boundaries, so a surrogate
 * pair is never split, and joining them gives `text` back.
 */
export function splitForSql(text: string, maxEscapedBytes: number): string[] {
  const pieces: string[] = [];
  let current = "";
  let size = 0;
  for (const char of text) {
    const charBytes = char === "'" ? 2 : new TextEncoder().encode(char).length;
    if (size + charBytes > maxEscapedBytes && current !== "") {
      pieces.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += charBytes;
  }
  if (current !== "" || pieces.length === 0) pieces.push(current);
  return pieces;
}

/**
 * The statements that restore one description's transcript, in the order
 * they must run. Each ends with a semicolon and stays under
 * `RESTORE_STATEMENT_BYTES`.
 */
export function restorationSql(
  update: TextUpdate,
  attemptId: string,
  now: number,
): string[] {
  const attempt = escapeSql(attemptId);
  const tenant = escapeSql(update.tenantId);
  const description = escapeSql(update.descriptionId);
  const pieces = splitForSql(update.text, RESTORE_STATEMENT_BYTES - STATEMENT_HEADROOM_BYTES);
  const staged = `attempt_id = ${attempt} AND tenant_id = ${tenant}`;

  const statements: string[] = [
    `INSERT INTO ocr_pages_staging (attempt_id, run_id, description_id, page_seq, tenant_id, text, created_at) ` +
      `SELECT ${attempt}, ${escapeSql(RESTORE_RUN_ID)}, id, 1, tenant_id, ${escapeSql(pieces[0])}, ${now} ` +
      `FROM descriptions WHERE id = ${description} AND tenant_id = ${tenant};`,
  ];
  for (const piece of pieces.slice(1)) {
    statements.push(
      `UPDATE ocr_pages_staging SET text = text || ${escapeSql(piece)} WHERE ${staged} AND page_seq = 1;`,
    );
  }
  statements.push(
    `UPDATE ocr_pages SET text = (SELECT text FROM ocr_pages_staging WHERE ${staged} AND page_seq = 1) ` +
      `WHERE description_id = ${description} AND tenant_id = ${tenant} AND run_id IS NULL AND page_seq = 1;`,
    `DELETE FROM ocr_pages_staging WHERE ${staged};`,
  );
  return statements;
}

/**
 * Throw while `descriptions.ocr_text` is among the table's columns. The
 * migration that retires it (0087) would copy the clipped column value
 * back over any page restored before it ran.
 */
export function assertColumnRetired(descriptionColumns: string[]): void {
  if (descriptionColumns.includes("ocr_text")) {
    throw new Error(
      "descriptions.ocr_text still exists in the target database. Apply migration 0087 first: " +
        "its catch-up would overwrite a restored transcript with the clipped column value.",
    );
  }
}

// Version: v0.8.0
