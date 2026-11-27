/**
 * Scripts — reading and planning the command line's authority changes
 *
 * This module reads what a change file (`./change-file.ts`) needs from
 * the target D1 and plans every row against it; `./statements.ts` turns
 * the plan into SQL and `./run.ts` runs it. Any refusal stops the run
 * before anything is written.
 *
 * What every row checks: `authority_code` is one entity of the tenant's
 * federation, shared or the tenant's own, not merged away, whose display
 * name is `authority_name` (or, after an `update-entity` row of the same
 * file renamed it, the name before, when the changelog records the
 * rename); each of `target_codes` likewise, named once, and not the
 * row's own authority; the row fills only the columns of its operation.
 *
 * Function rows. A row names `function_id` and the row's `function`
 * text (compared after NFC and trimming), and is refused when the
 * stored row has other text or belongs to another record. A function
 * row named twice is refused.
 *
 *   keep-function    the row is on the authority with that text; writes nothing.
 *   move-function    one target: the row's `entity_id` changes, its id,
 *                    rowid and every other column kept, as a merge moves
 *                    function rows (`movedEntityFunctions`). Several
 *                    targets: a row with the same columns is inserted on
 *                    each, under an id made from the source row's id and
 *                    the target's (`functionRowId`), and the source row is
 *                    deleted. None is left on the source either way.
 *   copy-function    the row stays; a row with the same columns is
 *                    inserted on each target, under `functionRowId`.
 *   delete-function  the row is deleted.
 *   rename-function  the row's `function` becomes `new_function`, and its
 *                    `honorific` becomes `new_honorific` when that is
 *                    given (`NULL` clears it), and its `updated_at` takes
 *                    the run's clock; its id, rowid, owner and other
 *                    columns are kept. The record's primary function
 *                    is not touched. A row that writes finds the stored
 *                    text equal to `function`; `new_function` may not be
 *                    blank.
 *
 * A `rename-function` row whose `new_function` the record holds already
 * in another row (`functionIdentity`) does not leave two rows of one
 * function: the held row takes the renamed row's fields it lacks, with
 * the honorific `new_honorific` gives, and the renamed row is deleted,
 * as a move onto a holder is; the report lists it under "Target already
 * has this function", and its changelog row records the functions text
 * losing the row and `functionFields` when the held row is filled. A
 * rerun finds it "already renamed" when the row is gone, the record
 * holds the new text and that changelog row shows the old text leaving.
 *
 * A `rename-function` row whose function row already holds `new_function`
 * (and `new_honorific`, when given) is "same" when this file's changelog
 * row for it does not exist, and "already renamed" when it does and
 * records the change the row gives: the record's functions text with
 * `function` leaving and `new_function` arriving when the texts differ,
 * and none otherwise; the honorific changing to `new_honorific`
 * (`functionHonorific`), or no honorific when the row gives none. That
 * changelog row's id is made as a move's or a delete's is
 * (`functionJournalId`, under the operation `rename`). A row whose
 * changelog row exists while it would still write is refused as changed
 * since it was applied.
 *
 * A record holds each function once. A target that holds a row of the
 * same function (`functionIdentity`: text compared after NFC, trimming,
 * collapsing internal whitespace and case-folding) does not receive the
 * row: the held row takes each field it lacks (honorific, dates, date
 * note, source, notes) from the row, and keeps every field it has
 * (`fillFunctionFields`). A move onto such a target fills the held row
 * and deletes the source row; a copy fills it and inserts nothing. A
 * filled row is an update of the target, which is journaled
 * (`functionFields`, the row's fields before and after) and takes a new
 * version; a target left unchanged takes neither. The report lists each
 * such target under "Target already has this function", with what the
 * held row took ("filled", or "skipped" when it lacked nothing the row
 * carries) and each field both held with different values, where the
 * held value stays. A target holding a row that differs only in accents
 * (`functionKey`) still receives the row, and is listed there as
 * "arrives". A fold reads its held row as stored, so within one file a
 * row may not fold into a row another row creates, moves, renames, fills
 * or deletes, and no row is filled by two rows: the file is refused,
 * naming both lines, and the two go in two files applied one after the
 * other. A copy reads its source row the same way: another line may not
 * fill, move, rename or delete it. Every line counts whatever its
 * status, a "same" copy or rename among them. To find such a chain the plan looks for the held row among the
 * texts earlier renames give and the rows earlier rows bring. Two
 * `merge-entity` rows into one survivor whose losers hold one function
 * are refused the same way. A copy whose every target holds the function and lacks
 * nothing is "same"; a rerun of a copy that only filled reads so too.
 *
 * A row a move or a copy finds already on a target counts as its result
 * only when it is the row the operation makes there (`functionRowId`)
 * and holds the source row's columns (`CARRIED_COLUMNS`); a row of that
 * id with other columns is refused, never overwritten. A row that
 * writes is refused when its text, or the stored row's, holds a line
 * break: the changelog gives a record's functions as text, one per line,
 * as the editor does, and such a row would read there as two.
 *
 * Rerun. A second run of an applied file writes nothing and reports each
 * function row done, on evidence that names the row and the record it left: the
 * changelog row a move or a delete writes on its source, whose id is
 * made from the file's name, the operation, the row's id and the
 * source's (`functionJournalId`) and whose `record_id` is the source. A
 * row moved to one target is done when it is on that target under its
 * id and that changelog row exists; a row moved to several, when it is
 * gone, each target holds its `functionRowId` row, those rows agree, and
 * that changelog row exists; a deleted row, when it is gone and that
 * changelog row exists; a copy, when each target holds its
 * `functionRowId` row with the source row's columns. The requested text
 * must match throughout: the row on each target holds it, and the
 * changelog row of a move or a delete shows it leaving the source (it
 * stands more times among the source's functions before than after). A
 * row moved onto a target that held the function, or renamed onto a
 * text its record held, is done when it is gone and that changelog row
 * exists and names, in `foldedInto`, the record and the row it folded
 * into, which must still be that record's and hold the requested text
 * (the move's function, the rename's new function). Without the
 * evidence the row is refused: a row its target always held, or a row
 * that never existed. A file is known by its name, so a rerun under
 * another name finds no evidence and is refused.
 *
 * `update-entity` plans as the originals file of a split does
 * (`planRecordFields`): a blank column leaves the stored value, `NULL`
 * clears it (refused on a field a record cannot be without),
 * `name_variants_remove` and `name_variants_add` take variants off and
 * add them, and `current_name`, `current_dates` and `current_function`
 * name the stored values (`current_name` blank stands for
 * `authority_name`). A variant `name_variants_remove` names that the
 * record does not hold counts as removed only when this file's changelog
 * row on the record records an update of `nameVariants` that took it
 * off. One `update-entity` row per record.
 *
 * An `update-entity` row's changelog row has an id made from the
 * federation, the tenant, the file's name and the record
 * (`entityUpdateJournalId`), as a place update's is, and it is the only
 * changelog row a rerun reads as evidence: the rename `nameHolds`
 * accepts, a stated `current_*` value the field had before, and a
 * removed variant all count only when this row records them. A row whose
 * record already holds what it gives (its `current_*` naming the stored
 * values) while that row does not exist is "same": nothing to write and
 * no evidence needed, neither done nor pending in the rerun contract. A
 * row is "already updated" only when the record holds what the row gives
 * and that row exists, recording every field the row changes: a field with a
 * `current_*` column changes when the row's value differs from the
 * stated one, and is recorded changing from the stated value to the
 * row's; one restated unchanged needs only to hold its value, and must
 * not be recorded changing from another; a field without one (the
 * variants and the gender among them) changed when the plan that applied
 * the file found it different, which is when the row records it, and is
 * then recorded changing to the value it holds. A field the row records
 * that the row no longer gives refuses the row. A row whose changelog row
 * exists while the row would still write is refused as changed since it
 * was applied (below). A file applied before these ids were made from
 * the file has changelog rows of random ids: its rows that hold what they
 * give read as "same", never as done.
 *
 * `merge-entity` merges the authority into its one target exactly as
 * the reviewed merge list does (`planEntityMerges` and
 * `buildEntityStatements` in `../entity-merges.ts`): links, function
 * rows, variants, label (`label_to_keep`) and ledger, with the variants
 * the survivor gains checked against `name_variants_add` and
 * `name_variants_remove` left out of them. An authority already merged
 * into its target is reported already merged when the target holds
 * `label_to_keep` and the variants of `name_variants_add`. A merge row
 * whose repoints would give one entity two links to a description in one
 * role naming the same link (`mergeLinkCollisions`) is refused, naming the
 * description's reference code, the entity's code and the role; the codes
 * are read with the links naming the merged records' links. A merge row
 * whose loser holds a link named from outside its own description is
 * refused as stale data, naming only that link; nothing of the naming
 * link is read. A merge row to write needs its evidence
 * (`mergeRowEvidence`): `facts`, and `evidence_codes` naming the
 * tenant's descriptions, each linked to the authority or the target as
 * read and at least one to each; a row without it is refused, naming its
 * line, and the other rows are planned as they stand. A row found
 * already merged is not checked again. The evidence goes into the
 * merge's ledger row as description ids (`mergeEvidence`).
 *
 * `cover-functions` declares that the file accounts for every function
 * row the authority holds: a row of the authority the file neither names
 * nor puts there is a refusal.
 *
 * `update-entity` also takes `gender`: blank leaves the stored value,
 * `NULL` clears it to SQL NULL (a stored '' is cleared too), and any
 * other value must be a code of the federation's `gender` list; the
 * record as the row leaves it (its type and gender, given or stored) may
 * hold a gender only when it is a person; a change of gender alone
 * names the stored values in `current_*` as any change does.
 *
 * The four additions (`create-entity`, `add-link`, `add-place-link`,
 * `add-relation`) name no `authority_code`; they are read and planned
 * together by `./additions.ts`, which this module calls after the other
 * rows, with the records the file names resolved here (in scope, not
 * merged away, and named by no merge row of the file).
 *
 * The place rows (`create-place`, `update-place`, `merge-place`) are
 * read and planned by `./places.ts`, the link moves, drops and updates
 * (`move-place-link`, `drop-place-link`, `move-link`, `drop-link`,
 * `update-link`, `drop-relation`) by `./link-moves.ts`, and the record
 * deletes (`delete-entity`, `delete-place`) by `./deletes.ts`, last,
 * since a record a delete row names may be named by no other row. The
 * place rows are planned before the additions, so that an
 * `add-place-link` may name a `new:<key>` of a create-place
 * row, and the link moves after both, so that a move's target may be a
 * `new:<key>` of a create-place or create-entity row. An entity a link
 * row names is resolved here, as any other row's, and may be named by no
 * merge row of the file; a place, by `./places.ts`, under the same rule.
 *
 * The `authority_operations` rows of operation `split` and `separate`
 * are planned by `./ledger.ts` after the link moves: one per pair of
 * records the moves that write move links between (a split when the
 * target is a record the file creates, a separate when it is an existing
 * record), and one per `record-split` or `record-separate` row, which
 * names its two records as a merge row does (`authority_code` and one
 * code of `target_codes`, both resolved here) and may not name a pair
 * the moves record.
 *
 * The rerun contract. A file is applied whole or not at all, so a run of
 * the same file again finds every row done (or "same", which is
 * neither done nor pending) and writes nothing. A file in
 * which some rows are done (any "already …" status) and others would
 * write is a file applied before and changed since: it is refused whole,
 * naming the first done line and the first pending line, and its new
 * changes belong in a new file. The same holds inside a row: a row whose
 * effect is partly present (a copy or a move found on some of its
 * targets and not others, an update-place or update-entity row whose
 * file's changelog row exists while it would write more, part of a
 * relation or of a link move's changelog rows) is refused with the same
 * message, naming the row.
 * Each row's own evidence of being done
 * (the changelog rows of this file, the state it left) is therefore
 * never weighed against new work in the same file.
 *
 * A link whose role an `update-link` row changes is counted under its new
 * role in the check of the links as the whole file leaves them, so a
 * pair the update would make under one key of the unique index refuses
 * the row, as a move's does.
 *
 * Ordering and conflicts: rows do not depend on one another, so the
 * file's effect is the same in any order. A function row is named once,
 * and a row one row names, makes, or finds already made on a target may
 * be named or made by no other row ("relied on by line N");
 * a record a `merge-entity` row names, as source or target, may be named
 * by no other row of the file but another merge into the same target;
 * a record has at most one `update-entity` row and one `cover-functions`
 * row. The changelog rows are written in file order, each function row's
 * giving the record's functions before and after that row.
 *
 * Reads: the rows the file names (and the ids it would make) are read by
 * id, then every row of each record a function row, a coverage or a
 * merge names. A row read by id on a record read in full that is not
 * among that record's rows changed between the two reads, and is
 * refused; the later read stands for every row both found.
 *
 * @version v0.9.0
 */

import { functionKey } from "../../../app/lib/export/entities.server";
import { fillFunctionFields, functionIdentity, type ComparedFields, type FillableFunctionField, type FunctionFill } from "../../../app/lib/function-duplicates";
import { functionsText } from "../../../app/lib/entity-functions.server";
import {
  heldKey, heldLinks, linkCollisionMessage, linkCollisions, parseVariants, type IndexedLink, type JunctionRow,
} from "../../../app/lib/pair-merge.server";
import { newRecordId, type RowReader } from "../authority-links";
import { chunks, idList, storedValue, typed } from "../authority-merges";
import {
  ENTITY_GUARDED_COLUMNS,
  LINK_COLUMNS,
  junctionRowOf,
  mergeLinkChanges,
  planEntityMerges,
  pointingLinksSql,
  staleLoserLinks,
  staleNamingMessage,
  staleNamingSql,
  type EntityMergeRow,
  type EntityPlan,
  type EntityRow,
  type StoredEntity as MergeStoredEntity,
} from "../entity-merges";
import {
  ENTITY_READ,
  RECORD_FIELDS,
  blank,
  planRecordFields,
  readTerms,
  sameName,
  sameNfc,
  text,
  type OriginalPlan,
  type StoredEntity,
} from "../entity-splits";
import { escapeSql } from "../sql";
import { ATTRIBUTE_COLUMN, FUNCTION_OPS, KEYED_OPS, NAME_CHECKED_OPS, OP_COLUMNS, OPS, PLACE_OPS, REVIEWER_COLUMNS, spacedList, targetCodes, variantList, type ChangeRow, type Op } from "./change-file";
import { MERGE_FACTS, judgeMergeEvidence, type MergeEvidence } from "../../../app/lib/merge-evidence.server";
import { NAMESPACES, entityIdentity } from "./additions";
import { changedSince } from "./places";
import { isLinkMoveOp, planLinkMoves, readLinkMovesState, type LinkMoveStatus, type LinkMovesPlan, type LinkMovesState } from "./link-moves";
import { isPlaceOp, planPlaces, readPlacesState, type PlacesPlan, type PlacesState } from "./places";
import {
  PERSON,
  isAdditionOp,
  planAdditions,
  readAdditionsState,
  vocabularyOf,
  type AdditionStatus,
  type AdditionsPlan,
  type AdditionsState,
} from "./additions";
import { isDeleteOp, planDeletes, readDeletesState, type DeleteStatus, type DeletesPlan, type DeletesState } from "./deletes";
import {
  isLedgerRowOp, movedPairs, planBackfillRow, planMoveLedger, readLedgerState, type LedgerPlan, type LedgerState, type LedgerStatus,
} from "./ledger";
import { appendAll } from "../arrays";

/** The namespace of the ids `functionRowId` makes. */
export const FUNCTION_ID_NAMESPACE = "entity-function";

/**
 * The id of the row a move to several targets or a copy puts on
 * `targetId`: made from the source row's id and the target's, under the
 * federation and the tenant (`newRecordId`, in its own namespace), so a
 * run made again finds the row it made.
 */
export function functionRowId(federationId: string, tenantId: string, sourceRowId: string, targetId: string): Promise<string> {
  return newRecordId(federationId, tenantId, sourceRowId, targetId, FUNCTION_ID_NAMESPACE);
}

/** The function operations whose changelog row on the source has an id made from the file (`functionJournalId`). */
export type JournalOp = "move" | "delete" | "rename";

/** The namespace of the ids of the changelog rows a move, a delete or a rename writes on its source. */
export const JOURNAL_ID_NAMESPACE = "entity-function-journal";

/**
 * The id of the changelog row a move or a delete of `rowId` writes on its
 * source `sourceId`: made from the file's name, the operation, the row
 * and the source (`newRecordId`), so a run of the same file made again
 * finds it, and it names the row and the record the row left.
 */
export function functionJournalId(
  federationId: string, tenantId: string, file: string, op: JournalOp, rowId: string, sourceId: string,
): Promise<string> {
  return newRecordId(federationId, tenantId, file, `${op}|${rowId}|${sourceId}`, JOURNAL_ID_NAMESPACE);
}

/** The namespace of the ids of the changelog rows an `update-entity` row writes. */
export const ENTITY_UPDATE_JOURNAL_NAMESPACE = "authorities-entity-update-journal";

/**
 * The id of the changelog row an `update-entity` row writes on its
 * record: made from the federation, the tenant, the file's name and the
 * record (`newRecordId`), as a place update's is, so a run of the same
 * file made again finds this file's row and no other's.
 */
export function entityUpdateJournalId(federationId: string, tenantId: string, file: string, recordId: string): Promise<string> {
  return newRecordId(federationId, tenantId, file, recordId, ENTITY_UPDATE_JOURNAL_NAMESPACE);
}

/** The columns a row made from another must hold as that row does: all but the id and the owner. */
export const CARRIED_COLUMNS = [
  "honorific", "function", "date_start", "date_end", "date_note", "certainty", "source", "notes", "created_at", "updated_at",
] as const;

/** Whether a function text holds a line break, which the editor's functions text (one per line) cannot show. */
export const hasLineBreak = (v: unknown) => /[\r\n]/.test(text(v));

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

/** Entity columns read and guarded as stored: those a split reads, those a merge guards, and the relation fields of migration 0125. */
export const RECORD_READ = [...new Set<string>([...ENTITY_READ, ...ENTITY_GUARDED_COLUMNS, "gender", "known_only_from_relation", "qualified_name"])];

/** Every column of an `entity_functions` row. */
export const FUNCTION_COLUMNS = [
  "id", "entity_id", "honorific", "function", "date_start", "date_end", "date_note", "certainty", "source", "notes", "created_at", "updated_at",
] as const;

export type StoredRecord = Record<string, string | number | null>;
export type StoredFunction = Record<(typeof FUNCTION_COLUMNS)[number], string | number | null> & { rid: number };

export interface AuthoritiesState {
  tenantId: string;
  federationId: string;
  /** Entities of the federation by code, for every code the file names. */
  byCode: Map<string, StoredRecord>;
  /** Every entity read, by id. */
  byId: Map<string, StoredRecord>;
  /** Every function row read, by id: those the file names, the ids it would make, and every row of `fullSets`. */
  functions: Map<string, StoredFunction>;
  /** The records whose function rows were read in full, each in entry order. */
  fullSets: Map<string, StoredFunction[]>;
  /** The function rows of each merge target not in `fullSets`, in entry order: what a loser's rows may fold into. */
  mergeTargetSets: Map<string, StoredFunction[]>;
  /** For a row and a target: the id `functionRowId` makes. */
  derived: Map<string, string>;
  /** The live terms of each primary function an update gives. */
  terms: Map<string, string[]>;
  /** For each record an `update-entity` row names: the id of the changelog row this file writes on it (`entityUpdateJournalId`). */
  updateJournalIds: Map<string, string>;
  /** The tenant's links of each record a merge names. */
  links: Map<string, JunctionRow[]>;
  /** The links naming, in `related_to`, a link of `links` on its own description, keyed by the link named. */
  pointing: Map<string, JunctionRow[]>;
  /** The tenant's descriptions of each reference code a merge row cites in `evidence_codes`, by code. */
  evidenceDescriptions: Map<string, string[]>;
  /** The links of `links` that a link outside their own description names (stale data): their ids only. */
  staleNamed: Set<string>;
  /**
   * The reference code of each of the tenant's descriptions, and the code
   * of each entity, that a link read for the merges, the additions or the
   * link moves holds, for the refusals that name them.
   */
  linkCodes: { descriptions: Map<string, string>; entities: Map<string, string> };
  /** For an operation, a row and its source: the id of the changelog row a move or delete writes. */
  journalIds: Map<string, string>;
  /** Of those ids and of `updateJournalIds`, the ones the changelog holds, with the record each names. */
  journalFound: Map<string, { recordId: string; diff: Record<string, { old: unknown; new: unknown }> | null }>;
  /** Rows found on a record by id and not among the rows read of that record: they changed between the reads. */
  unsettled: string[];
  /** What the additions read (`./additions.ts`). */
  additions: AdditionsState;
  /** What the place rows read, and the places the link moves name (`./places.ts`). */
  places: PlacesState;
  /** What the link moves read (`./link-moves.ts`). */
  linkMoves: LinkMovesState;
  /** What the deletes read (`./deletes.ts`). */
  deletes: DeletesState;
  /** The split and separate ledger rows this file wrote, and those between the pairs its backfill rows name (`./ledger.ts`). */
  ledger: LedgerState;
  /** The tenant's slug, for the refusals that name it. */
  tenantSlug?: string;
}

/** The operation a function row's changelog id is made under, for the rows whose changelog row a rerun reads. */
const journalOpOf = (op: string): JournalOp | null =>
  op === "move-function" ? "move" : op === "delete-function" ? "delete" : op === "rename-function" ? "rename" : null;

const derivedKey = (rowId: string, targetId: string) => `${rowId}|${targetId}`;
export const journalKey = (op: JournalOp, rowId: string, sourceId: string) => `${op}|${rowId}|${sourceId}`;

function storedRecord(r: Record<string, unknown>): StoredRecord {
  return Object.fromEntries(RECORD_READ.map((c) => [c, storedValue(r, c)]));
}

function storedFunction(r: Record<string, unknown>): StoredFunction {
  return { ...(Object.fromEntries(FUNCTION_COLUMNS.map((c) => [c, storedValue(r, c)])) as StoredFunction), rid: Number(r.rid) };
}

async function readIn(rows: RowReader, ids: string[], size: number, query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(ids)].filter(Boolean), size)) if (part.length > 0) appendAll(out, await rows(query(idList(part))));
  return out;
}

const FUNCTION_SELECT = `${typed(FUNCTION_COLUMNS)}, rowid AS rid`;

/** Everything planning needs, read from the target. */
export async function readAuthoritiesState(
  rows: RowReader,
  input: { file: string; rows: ChangeRow[] },
  scope: { tenantId: string; federationId: string; owner?: string | null; tenantSlug?: string },
): Promise<AuthoritiesState> {
  const F = scope.federationId;
  const byCode = new Map<string, StoredRecord>();
  const byId = new Map<string, StoredRecord>();
  // The place rows name places, which `./places.ts` reads.
  const onPlaces = (r: ChangeRow) => (PLACE_OPS as readonly string[]).includes(r.cells.op) || ["move-place-link", "drop-place-link", "delete-place"].includes(r.cells.op);
  const codes = input.rows
    .flatMap((r) => (onPlaces(r) ? [] : [r.cells.authority_code, ...targetCodes(r), r.cells.entity, r.cells.a_entity, r.cells.b_entity]))
    .filter((c) => c && !c.startsWith("new:"));
  for (const r of await readIn(rows, codes, 100, (p) => `SELECT ${typed(RECORD_READ)} FROM entities WHERE federation_id = ${escapeSql(F)} AND entity_code IN (${p})`)) {
    const e = storedRecord(r);
    byCode.set(text(e.entity_code), e);
    byId.set(text(e.id), e);
  }
  const idOf = (code: string) => text(byCode.get(code)?.id);

  // The ids a move to several targets or a copy makes.
  const derived = new Map<string, string>();
  for (const r of input.rows) {
    const op = r.cells.op as Op;
    if (!r.cells.function_id || (op !== "copy-function" && (op !== "move-function" || targetCodes(r).length < 2))) continue;
    for (const code of targetCodes(r)) {
      const t = idOf(code);
      if (t && !derived.has(derivedKey(r.cells.function_id, t))) {
        derived.set(derivedKey(r.cells.function_id, t), await functionRowId(F, scope.tenantId, r.cells.function_id, t));
      }
    }
  }

  // Function rows: those the file names and the ids it would make, then
  // every row of each record a function row or a coverage names, and of
  // each record a merge takes away.
  const functions = new Map<string, StoredFunction>();
  const byIdRead = await readIn(rows, [...input.rows.map((r) => r.cells.function_id), ...derived.values()], 100, (p) =>
    `SELECT ${FUNCTION_SELECT} FROM entity_functions WHERE id IN (${p})`,
  );
  for (const r of byIdRead) functions.set(String(r.id), storedFunction(r));
  const fullIds = new Set<string>();
  for (const r of input.rows) {
    const op = r.cells.op as Op;
    if (FUNCTION_OPS.includes(op) || op === "cover-functions") for (const c of [r.cells.authority_code, ...targetCodes(r)]) if (idOf(c)) fullIds.add(idOf(c));
    if (op === "merge-entity" && idOf(r.cells.authority_code)) fullIds.add(idOf(r.cells.authority_code));
  }
  const fullSets = new Map<string, StoredFunction[]>([...fullIds].map((id) => [id, []]));
  const inFullSets = new Set<string>();
  for (const r of await readIn(rows, [...fullIds], 100, (p) => `SELECT ${FUNCTION_SELECT} FROM entity_functions WHERE entity_id IN (${p}) ORDER BY rowid`)) {
    const f = storedFunction(r);
    functions.set(text(f.id), f);
    fullSets.get(text(f.entity_id))!.push(f);
    inFullSets.add(text(f.id));
  }
  // Each merge target's rows, for the folds of the losers' rows into them.
  const mergeTargets = input.rows.filter((r) => r.cells.op === "merge-entity").flatMap((r) => targetCodes(r)).map(idOf).filter((id) => id && !fullIds.has(id));
  const mergeTargetSets = new Map<string, StoredFunction[]>([...new Set(mergeTargets)].map((id) => [id, []]));
  for (const r of await readIn(rows, [...mergeTargetSets.keys()], 100, (p) => `SELECT ${FUNCTION_SELECT} FROM entity_functions WHERE entity_id IN (${p}) ORDER BY rowid`)) {
    const f = storedFunction(r);
    mergeTargetSets.get(text(f.entity_id))!.push(f);
  }
  // A row read by id on a record read in full must be among that record's
  // rows; the later read wins for every row both reads found.
  const unsettled = [...functions.values()]
    .filter((f) => fullIds.has(text(f.entity_id)) && !inFullSets.has(text(f.id)))
    .map((f) => text(f.id));
  // The owners of rows read by id, for the refusals that name them.
  const owners = [...functions.values()].map((f) => text(f.entity_id)).filter((id) => !byId.has(id));
  for (const r of await readIn(rows, owners, 100, (p) => `SELECT ${typed(RECORD_READ)} FROM entities WHERE id IN (${p})`)) {
    const e = storedRecord(r);
    byId.set(text(e.id), e);
  }

  const updateTexts = input.rows.filter((r) => r.cells.op === "update-entity" && r.cells.primary_function && r.cells.primary_function !== "NULL");
  const terms = await readTerms(rows, updateTexts.map((r) => r.cells.primary_function), F);

  // The changelog row this file writes on each record an update-entity row names.
  const updateJournalIds = new Map<string, string>();
  for (const r of input.rows) {
    const id = r.cells.op === "update-entity" ? idOf(r.cells.authority_code) : "";
    if (id && !updateJournalIds.has(id)) updateJournalIds.set(id, await entityUpdateJournalId(F, scope.tenantId, input.file, id));
  }

  // The tenant's links of each record a merge names, in full.
  const links = new Map<string, JunctionRow[]>();
  const merged = input.rows.filter((r) => r.cells.op === "merge-entity").flatMap((r) => [r.cells.authority_code, ...targetCodes(r)]).map(idOf).filter(Boolean);
  for (const part of chunks([...new Set(merged)], 100)) {
    let last = "";
    for (;;) {
      const page = await rows(
        `SELECT ${typed(LINK_COLUMNS)} FROM description_entities WHERE entity_id IN (${idList(part)}) ` +
          `AND description_id IN (SELECT id FROM descriptions WHERE tenant_id = ${escapeSql(scope.tenantId)}) ` +
          `AND id > ${escapeSql(last)} ORDER BY id LIMIT 1000`,
      );
      for (const r of page) {
        const v = (c: string) => storedValue(r, c);
        const link: JunctionRow = {
          id: String(v("id")), descriptionId: String(v("description_id")), entityId: String(v("entity_id")), role: v("role") as string,
          roleNote: v("role_note"), roleRaw: v("role_raw"), sequence: v("sequence"), honorific: v("honorific"), attributes: v("attributes"),
          nameAsRecorded: v("name_as_recorded"), createdAt: v("created_at"), relatedTo: v("related_to"),
          relationCertainty: v("relation_certainty"),
        };
        links.set(String(link.entityId), [...(links.get(String(link.entityId)) ?? []), link]);
      }
      if (page.length < 1000) break;
      last = String(page[page.length - 1].id);
    }
  }

  // The tenant's descriptions the merge rows cite as evidence, by reference code.
  const evidenceDescriptions = new Map<string, string[]>();
  const citedCodes = input.rows.filter((r) => r.cells.op === "merge-entity").flatMap((r) => spacedList(r.cells.evidence_codes));
  for (const r of await readIn(rows, citedCodes, 100, (p) =>
    `SELECT id, reference_code FROM descriptions WHERE tenant_id = ${escapeSql(scope.tenantId)} AND reference_code IN (${p})`)) {
    const code = text(r.reference_code);
    evidenceDescriptions.set(code, [...(evidenceDescriptions.get(code) ?? []), String(r.id)]);
  }

  // The changelog rows a move, a delete or a rename of this file writes on its source, and those already there.
  const journalIds = new Map<string, string>();
  for (const r of input.rows) {
    const op = journalOpOf(r.cells.op);
    const source = idOf(r.cells.authority_code);
    if (!op || !source || !r.cells.function_id) continue;
    journalIds.set(journalKey(op, r.cells.function_id, source), await functionJournalId(F, scope.tenantId, input.file, op, r.cells.function_id, source));
  }
  const journalFound: AuthoritiesState["journalFound"] = new Map();
  for (const r of await readIn(rows, [...journalIds.values(), ...updateJournalIds.values()], 100, (p) => `SELECT id, record_id, diff FROM changelog WHERE id IN (${p})`)) {
    let diff: Record<string, { old: unknown; new: unknown }> | null = null;
    try {
      const parsed = JSON.parse(String(r.diff));
      if (parsed && typeof parsed === "object") diff = parsed;
    } catch {
      diff = null;
    }
    journalFound.set(String(r.id), { recordId: String(r.record_id), diff });
  }

  // The other sides of those links' relations, for the drops a merge repoints.
  const pointing = new Map<string, JunctionRow[]>();
  for (const part of chunks([...new Set(merged)], 100)) {
    for (const r of await rows(pointingLinksSql(part, scope.tenantId, typed(LINK_COLUMNS)))) {
      const link = junctionRowOf((c) => storedValue(r, c));
      pointing.set(String(link.relatedTo), [...(pointing.get(String(link.relatedTo)) ?? []), link]);
    }
  }
  const additions = await readAdditionsState(rows, input, { tenantId: scope.tenantId, federationId: F, owner: scope.owner ?? null }, RECORD_READ, idOf);
  const places = await readPlacesState(rows, input, { tenantId: scope.tenantId, federationId: F, owner: scope.owner ?? null });
  const linkMoves = await readLinkMovesState(rows, input, { tenantId: scope.tenantId, federationId: F }, {
    entityId: idOf,
    entityKeyId: (key) => newRecordId(F, scope.tenantId, input.file, key, NAMESPACES.entity),
    placeId: (code) => text(places.byCode.get(code)?.id),
    placeKeyId: (key) => places.keyIds.get(key) ?? "",
  });
  const deletes = await readDeletesState(rows, input, { tenantId: scope.tenantId, federationId: F });
  const ledger = await readLedgerState(rows, input, { tenantId: scope.tenantId, federationId: F }, {
    entityId: idOf,
    entityKeyId: (key) => newRecordId(F, scope.tenantId, input.file, key, NAMESPACES.entity),
    placeId: (code) => text(places.byCode.get(code)?.id),
    placeKeyId: (key) => places.keyIds.get(key) ?? "",
  });
  // The merged records' links named from outside their own description: stale data, read by their ids alone.
  const staleNamed = new Set<string>();
  for (const part of chunks([...new Set(merged)], 100)) {
    for (const r of await rows(staleNamingSql(part, scope.tenantId))) staleNamed.add(String(r.id));
  }
  // The codes a refusal of colliding links names: of the tenant's descriptions only, so a refusal
  // names nothing of another workspace's.
  const linkCodes: AuthoritiesState["linkCodes"] = { descriptions: new Map(), entities: new Map() };
  const held = [
    ...[...links.values()].flat().map((l) => [l.descriptionId, String(l.entityId)]),
    ...[...pointing.values()].flat().map((l) => [l.descriptionId, String(l.entityId)]),
    ...[...linkMoves.entityLinks, ...additions.links].map((l) => [text(l.description_id), text(l.entity_id)]),
  ];
  for (const r of await readIn(rows, held.map((h) => h[0]), 100, (p) =>
    `SELECT id, reference_code FROM descriptions WHERE tenant_id = ${escapeSql(scope.tenantId)} AND id IN (${p})`)) {
    linkCodes.descriptions.set(String(r.id), text(r.reference_code));
  }
  for (const r of await readIn(rows, held.filter((h) => linkCodes.descriptions.has(h[0])).map((h) => h[1]), 100, (p) =>
    `SELECT id, entity_code FROM entities WHERE id IN (${p})`)) {
    linkCodes.entities.set(String(r.id), text(r.entity_code));
  }
  return {
    tenantId: scope.tenantId, federationId: F, byCode, byId, functions, fullSets, mergeTargetSets, derived, terms, updateJournalIds, links, pointing, evidenceDescriptions, staleNamed, linkCodes, journalIds, journalFound,
    unsettled, additions, places, linkMoves, deletes, ledger, tenantSlug: scope.tenantSlug,
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface Refusal {
  ref: string;
  reason: string;
}

export type RowStatus =
  | "keep" | "move" | "copy" | "delete" | "rename" | "update" | "merge" | "cover"
  | "already moved" | "already copied" | "already deleted" | "already renamed" | "already updated" | "already merged" | "same" | AdditionStatus | LinkMoveStatus
  | DeleteStatus | LedgerStatus | "refused";

/** The statuses that write. */
export const WRITES: readonly RowStatus[] = [
  "move", "copy", "delete", "rename", "update", "merge", "create", "link", "place-link", "relate", "move link", "drop link", "update link", "drop relation",
  "delete entity", "delete place", "record split", "record separate",
];
/** What each writing status reads back as. */
export const DONE: Partial<Record<RowStatus, RowStatus>> = {
  move: "already moved", copy: "already copied", delete: "already deleted", rename: "already renamed", update: "already updated", merge: "already merged",
  create: "already created", link: "already linked", "place-link": "already place-linked", relate: "already related",
  "move link": "already moved link", "drop link": "already dropped link", "update link": "already updated link", "drop relation": "already dropped relation",
  "delete entity": "already deleted entity", "delete place": "already deleted place",
  "record split": "already recorded split", "record separate": "already recorded separate",
};

export interface TargetPlan {
  id: string;
  code: string;
  /** The id the row has on the target: the source row's for a move to one target, `functionRowId`'s otherwise. */
  rowId: string;
  /** Whether the row is still to arrive. */
  arrives: boolean;
  /** A row the target holds that differs from the row only in accents (`functionKey`), when it receives the row. */
  alreadyHas?: string;
  /**
   * The row of the same function (`functionIdentity`) the target holds,
   * which the row fills instead of arriving (a held row another row of
   * the file touches refuses the file): its id and text, the fields it takes, and the
   * fields both hold with different values. `arrives` is then whether
   * it takes any.
   */
  foldInto?: { id: string; function: string; set: FunctionFill["set"]; conflicts: FunctionFill["conflicts"] };
}

export interface RowPlan {
  row: ChangeRow;
  op: Op | string;
  status: RowStatus;
  /** The authority's id, once resolved. */
  entityId?: string;
  /** The function row as read, where it was found. */
  fn?: StoredFunction;
  targets: TargetPlan[];
  /** Ids the plan found absent and relies on staying so. */
  absent: string[];
  /** An update's planned fields. */
  fields?: OriginalPlan;
  /** For a move, a delete or a rename: the id of the changelog row it writes on its source; for an update-entity row, on its record. */
  journalId?: string;
  /** A rename's writes: the new text, when it changes, and the new honorific, when it changes (null clears it). */
  rename?: { function?: string; honorific?: string | null };
  note: string;
}

export interface AuthoritiesPlan {
  rows: RowPlan[];
  refusals: Refusal[];
  /** The merges to write, as the reviewed merge plans them. */
  merges: EntityPlan;
  /** Each merge row to write, by the ref it carries in `merges`. */
  mergeRows: Map<string, ChangeRow>;
  /** The evidence of each merge row to write, by the ref it carries in `merges`, for its ledger row and its guards. */
  mergeEvidence: Map<string, MergeEvidence>;
  /** The additions, as `./additions.ts` plans them. */
  additions: AdditionsPlan;
  /** The place rows, as `./places.ts` plans them. */
  places: PlacesPlan;
  /** The link moves, drops and updates, as `./link-moves.ts` plans them. */
  linkMoves: LinkMovesPlan;
  /** The record deletes, as `./deletes.ts` plans them. */
  deletes: DeletesPlan;
  /** The split and separate ledger rows, of the link moves and of the backfill rows, as `./ledger.ts` plans them. */
  ledger: LedgerPlan;
}

/** The merge's view of a stored record. */
export function entityRowOf(e: StoredRecord): EntityRow {
  const stored = Object.fromEntries(ENTITY_GUARDED_COLUMNS.map((c) => [c, e[c]])) as MergeStoredEntity;
  const opt = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  return {
    id: text(e.id), federationId: text(e.federation_id), tenantId: opt(e.tenant_id), code: text(e.entity_code), displayName: text(e.display_name),
    sortName: text(e.sort_name), nameVariants: opt(e.name_variants) ?? "[]", mergedInto: opt(e.merged_into), wikidataId: opt(e.wikidata_id),
    viafId: opt(e.viaf_id), dbeId: opt(e.dbe_id), sources: opt(e.sources), updatedAt: Number(e.updated_at), stored,
  };
}

const ref = (r: ChangeRow) => `${r.file} line ${r.line}`;

/** Checks the file against what was read and plans every row. */
export function planAuthorities(input: { file: string; rows: ChangeRow[] }, state: AuthoritiesState): AuthoritiesPlan {
  const refusals: Refusal[] = [];
  const refuse = (where: string, reason: string) => refusals.push({ ref: where, reason });
  const codeOf = (id: string) => text(state.byId.get(id)?.entity_code) || id;
  /** This file's update-entity changelog row on a record, when the changelog holds it on that record. */
  const fileDiff = (id: string): Record<string, { old: unknown; new: unknown }> | null => {
    const found = state.journalFound.get(state.updateJournalIds.get(id) ?? "");
    return found && found.recordId === id ? found.diff ?? {} : null;
  };
  /** Whether this file's changelog row on the record records `key` changing from `from` to `to`. */
  const changedFrom = (id: string, key: string, from: unknown, to: unknown) => {
    const d = fileDiff(id)?.[key];
    return !!d && typeof d === "object" && sameNfc(d.old, from) && sameNfc(d.new, to);
  };

  /** The record of a code, in scope and not merged away; or a refusal. */
  const resolve = (code: string, what: string): StoredRecord | string => {
    const e = state.byCode.get(code);
    if (!e) return `no entity has the code ${code}`;
    if (!blank(e.tenant_id) && text(e.tenant_id) !== state.tenantId) return `${what}${code} is owned by another tenant`;
    if (!blank(e.merged_into)) return `${what}${code} is merged into ${text(e.merged_into)}`;
    return e;
  };

  // The update rows, by record, for the names they change.
  const updates = new Map<string, ChangeRow>();
  for (const r of input.rows) if (r.cells.op === "update-entity" && state.byCode.has(r.cells.authority_code)) {
    const id = text(state.byCode.get(r.cells.authority_code)!.id);
    if (!updates.has(id)) updates.set(id, r);
  }
  /** The name a row gives is the stored one, or the one an update row of the file renamed (the changelog records it). */
  const nameHolds = (e: StoredRecord, name: string) => {
    const stored = text(e.display_name);
    if (sameName(name, stored)) return true;
    const u = updates.get(text(e.id));
    return !!u && u.cells.display_name !== "" && sameName(u.cells.display_name, stored) &&
      sameName(name, u.cells.current_name || u.cells.authority_name) && changedFrom(text(e.id), "displayName", name, stored);
  };

  // The records merges name: no other row may name them.
  const mergedBy = new Map<string, number>();
  for (const r of input.rows) {
    if (r.cells.op !== "merge-entity") continue;
    for (const code of [r.cells.authority_code, ...targetCodes(r)]) {
      const e = state.byCode.get(code);
      if (e && !mergedBy.has(text(e.id))) mergedBy.set(text(e.id), r.line);
    }
  }

  const named = new Map<string, ChangeRow>();
  const covered = new Map<string, ChangeRow>();
  const updated = new Map<string, ChangeRow>();
  const plans: RowPlan[] = [];
  const mergeRows = new Map<string, ChangeRow>();
  const mergeEvidence = new Map<string, MergeEvidence>();
  const toMerge: EntityMergeRow[] = [];
  const deferred = new Set<RowPlan>();
  const deleteRows = new Set<RowPlan>();
  const ledgerRows: Array<{ plan: RowPlan; sourceId: string; targetId: string }> = [];

  // The function rows each record holds as the file goes, for finding the row a row would fold into:
  // its stored rows under the text an earlier rename gives them, then the rows earlier rows bring it.
  // A fold into any row another row of the file touches is refused below, so only the stored fields count.
  const arrivedOn = new Map<string, Array<{ id: string; function: string }>>();
  const renamedTo = new Map<string, string>();
  const heldOn = (targetId: string, key: string, except: string[]) => {
    const textNow = (x: StoredFunction) => renamedTo.get(text(x.id)) ?? text(x.function);
    const stored = (state.fullSets.get(targetId) ?? []).find((x) => !except.includes(text(x.id)) && functionIdentity(textNow(x)) === key);
    if (stored) return { id: text(stored.id), function: textNow(stored) };
    return (arrivedOn.get(targetId) ?? []).find((x) => !except.includes(x.id) && functionIdentity(x.function) === key);
  };
  const fieldsNow = (id: string) => (state.functions.has(id) ? functionFieldsOf(state.functions.get(id)!) : {});

  for (const r of input.rows) {
    const c = r.cells;
    const plan: RowPlan = { row: r, op: c.op, status: "refused", targets: [], absent: [], note: c.changelog_note || `Authorities change file ${r.file}, line ${r.line}` };
    plans.push(plan);
    const no = (reason: string) => refuse(ref(r), reason);

    // The shape of the row.
    if (!(OPS as readonly string[]).includes(c.op)) { no(`op ${JSON.stringify(c.op)} is not one of ${OPS.join(", ")}`); continue; }
    const op = c.op as Op;
    // A row names its function row whatever else is wrong with it, so coverage reports only the rows the file leaves out.
    if (FUNCTION_OPS.includes(op) && c.function_id) {
      const twice = named.get(c.function_id);
      if (twice) { no(`function row ${c.function_id} is named again (line ${twice.line})`); continue; }
      named.set(c.function_id, r);
    }
    const allowed = new Set(OP_COLUMNS[op]);
    // An addition names no existing record in authority_code; an attribute column belongs to a link or a relation side.
    // Every column of the file but the op, the note, the reviewer's and an existing operation's authority is
    // a candidate, so a column no operation fills (a document link's certainty) refuses the row too.
    // A link addition may carry authority_name as a check of the record it names (`./additions.ts`).
    const authorityColumns = KEYED_OPS.includes(op) ? (NAME_CHECKED_OPS.includes(op) ? ["authority_name"] : []) : ["authority_code", "authority_name"];
    const kept = new Set<string>(["op", "changelog_note", ...REVIEWER_COLUMNS, ...authorityColumns]);
    const stray = Object.keys(c).filter((k) => !kept.has(k)).filter((k, i, a) => {
      if (a.indexOf(k) !== i || allowed.has(k) || c[k] === "") return false;
      const side = ATTRIBUTE_COLUMN.exec(k)?.[1];
      return !(ATTRIBUTE_COLUMN.test(k) && ((op === "add-link" && side === undefined) || (op === "add-relation" && side !== undefined)));
    });
    if (stray.length > 0) { no(`${op} carries no ${stray.join(", ")}`); continue; }
    // The additions, the place rows and the link moves are planned together, below.
    if (isAdditionOp(op)) { plan.status = "create"; continue; }
    if (isPlaceOp(op) || isLinkMoveOp(op)) { deferred.add(plan); continue; }
    if (isDeleteOp(op)) { deleteRows.add(plan); continue; }
    const codes = targetCodes(r);
    if ((op === "move-function" || op === "copy-function") && codes.length === 0) { no(`${op} names one or more target_codes`); continue; }
    if (op === "merge-entity" && codes.length !== 1) { no("merge-entity names exactly one target code"); continue; }
    if (isLedgerRowOp(op) && codes.length !== 1) { no(`${op} names exactly one target code`); continue; }
    if (FUNCTION_OPS.includes(op)) {
      if (!c.function_id) { no(`${op} names no function_id`); continue; }
      if (!c.function) { no(`${op} names no function`); continue; }
      if (op === "rename-function" && !c.new_function) { no("rename-function names no new_function"); continue; }
    }

    // The authority. A merge's source may already be merged into its target (a rerun).
    const stored = state.byCode.get(c.authority_code);
    const mergedIntoTarget = op === "merge-entity" && !!stored && !blank(stored.merged_into) &&
      text(state.byCode.get(codes[0])?.id) === text(stored.merged_into);
    const e = mergedIntoTarget ? stored! : resolve(c.authority_code, "");
    if (typeof e === "string") { no(e); continue; }
    const id = text(e.id);
    plan.entityId = id;
    if (!nameHolds(e, c.authority_name)) {
      no(`authority_name ${JSON.stringify(c.authority_name)} is not the stored name ${JSON.stringify(text(e.display_name))}`);
      continue;
    }
    if (op !== "merge-entity" && mergedBy.has(id)) { no(`${c.authority_code} is merged by line ${mergedBy.get(id)}, so no other row may name it`); continue; }

    // The targets.
    const targets: StoredRecord[] = [];
    let bad = false;
    for (const code of codes) {
      if (codes.indexOf(code) !== codes.lastIndexOf(code)) { no(`target ${code} is named twice`); bad = true; break; }
      if (code === c.authority_code) { no(`target ${code} is the row's own authority`); bad = true; break; }
      const t = resolve(code, "the target ");
      if (typeof t === "string") { no(t); bad = true; break; }
      if (op !== "merge-entity" && mergedBy.has(text(t.id))) { no(`${code} is merged by line ${mergedBy.get(text(t.id))}, so no other row may name it`); bad = true; break; }
      targets.push(t);
    }
    if (bad) continue;

    // The backfill of a split or separate ledger row, planned once the link moves' own rows are known.
    if (isLedgerRowOp(op)) { ledgerRows.push({ plan, sourceId: id, targetId: text(targets[0].id) }); continue; }

    if (op === "cover-functions") {
      const twice = covered.get(id);
      if (twice) { no(`${c.authority_code} has another cover-functions row (line ${twice.line})`); continue; }
      covered.set(id, r);
      plan.status = "cover";
      continue;
    }

    if (op === "update-entity") {
      const twice = updated.get(id);
      if (twice) { no(`${c.authority_code} has another update-entity row (line ${twice.line})`); continue; }
      updated.set(id, r);
      const cells = { ...c, current_name: c.current_name || c.authority_name };
      const fields: OriginalPlan = { row: { file: r.file, line: r.line, cells }, id, status: "refused", set: {}, changes: {}, termsTouched: [], note: plan.note };
      plan.fields = fields;
      // Gender is a code of the federation's `gender` list: blank leaves it, NULL clears it.
      let gender: { set: string | null } | null = null;
      if (c.gender !== "") {
        const g = c.gender === "NULL" ? null : c.gender;
        if (g !== null && !vocabularyOf(state.additions).codes.get("gender")!.has(g)) { no(`gender ${JSON.stringify(g)} is not in the federation's gender list`); continue; }
        if (g !== null && text(e.entity_type) !== PERSON && c.entity_type === "") { no(`${c.authority_code} is ${text(e.entity_type)}, and only a person has a gender`); continue; }
        // NULL leaves SQL NULL: a stored '' is a value to clear.
        if (g === null ? e.gender !== null : e.gender !== g) gender = { set: g };
      }
      // The record as the row leaves it: its type and its gender, given or stored, must agree.
      const typeAfter = c.entity_type !== "" ? c.entity_type : text(e.entity_type);
      const genderAfter = c.gender === "" ? e.gender : c.gender === "NULL" ? null : c.gender;
      // Checked when the row gives either field; a row giving neither leaves the record as it is.
      if (typeAfter !== PERSON && !blank(genderAfter) && (c.entity_type !== "" || c.gender !== "")) {
        no(`${c.authority_code} would be ${typeAfter} and ${c.gender === "" ? "keep" : "have"} the gender ${JSON.stringify(text(genderAfter))}; only a person has a gender`);
        continue;
      }
      // This file's changelog row on the record: the one evidence a rerun takes that the row was applied.
      plan.journalId = state.updateJournalIds.get(id);
      const found = plan.journalId ? state.journalFound.get(plan.journalId) : undefined;
      if (found && found.recordId !== id) { no(`the changelog row ${plan.journalId} of this file records another record`); continue; }
      const diff = fileDiff(id);
      // A row whose effect is partly present: this file's changelog row on the record exists while the row
      // would still write a field.
      const stated: Array<[string, string, string]> = [["display_name", cells.current_name, "displayName"], ["dates_of_existence", c.current_dates, "datesOfExistence"], ["primary_function", c.current_function, "primaryFunction"]];
      const stillToWrite = RECORD_FIELDS.filter((f) => f !== "name_variants" && c[f] !== "" && (c[f] === "NULL" ? e[f] !== null : !sameNfc(e[f], c[f])));
      if (diff && stillToWrite.length > 0) {
        no(changedSince(r, `part of its effect is present: a changelog row of this file records an update of ${c.authority_code}, and the row would write ${stillToWrite.join(", ")}`));
        continue;
      }
      planRecordFields(fields, e as unknown as StoredEntity, {
        terms: state.terms,
        changedFrom: (key, from, to) => changedFrom(id, key, from, to),
        removedBefore: (absent) => absent.every((v) => !!diff?.nameVariants &&
          parseVariants(blank(diff.nameVariants.old) ? null : String(diff.nameVariants.old)).includes(v) &&
          !parseVariants(blank(diff.nameVariants.new) ? null : String(diff.nameVariants.new)).includes(v)),
      }, no);
      if (fields.status !== "refused" && gender) {
        // A change of gender alone must name the stored values, as any change must.
        const wrong = ([["current_name", cells.current_name, e.display_name], ["current_dates", c.current_dates, e.dates_of_existence],
          ["current_function", c.current_function, e.primary_function]] as const).find(([, named, held]) => !sameNfc(named, held));
        if (wrong && fields.status === "already updated") { no(`${wrong[0]} ${JSON.stringify(wrong[1])} is not the stored ${JSON.stringify(text(wrong[2]))}`); continue; }
        fields.set.gender = gender.set;
        fields.changes.gender = { old: e.gender, new: gender.set };
        fields.status = "update";
      }
      if (fields.status === "update" && diff) {
        no(changedSince(r, `part of its effect is present: a changelog row of this file records an update of ${c.authority_code}, and the row would write more`));
        continue;
      }
      // Done only on this file's changelog row, recording every field the row changes changing to the value
      // the record holds. A field with a current_* column changes when the row's value differs from the
      // stated one, and is recorded changing from the stated value; one restated unchanged needs only to hold
      // its value, and must not be recorded changing from another. A field without one (the variants and
      // the gender among them) changed when the plan that applied the file found it different, which is
      // when this file's row records it, and then it is recorded changing to the value it holds. A field
      // the row recorded that the row no longer gives is a row changed since it was applied.
      if (fields.status === "already updated") {
        // Held already, with no changelog row of this file: nothing to write and no evidence needed, neither
        // done nor pending (the descriptions file's "same").
        if (!diff) { plan.status = "same"; continue; }
        const camel = (k: string) => k.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
        const statedOf = new Map(stated.map(([f, cur]) => [f, cur]));
        const valueOf = (k: string) => (c[k] === "NULL" ? "" : c[k]);
        const variantsGiven = c.name_variants !== "" || c.name_variants_add !== "" || (c.name_variants_remove ?? "") !== "";
        const given = [...RECORD_FIELDS.filter((k) => c[k] !== "" && k !== "name_variants"), ...(c.gender !== "" ? ["gender"] : [])];
        const toNow = (k: string, d: { new: unknown }) => (e[k] === null ? d.new === null : sameNfc(d.new, e[k]));
        let problem = "";
        for (const k of given) {
          const d = diff[camel(k)];
          const recorded = !!d && typeof d === "object";
          if (statedOf.has(k)) {
            const from = statedOf.get(k)!;
            if (sameNfc(from, valueOf(k))) {
              if (recorded && !sameNfc(d.old, from)) problem = `records ${k} changing from ${JSON.stringify(text(d.old))}, not from the row's ${JSON.stringify(from)}`;
            } else if (!recorded || !toNow(k, d)) {
              problem = `does not record ${k} changing to the row's value`;
            } else if (!sameNfc(d.old, from)) {
              problem = `records ${k} changing from ${JSON.stringify(text(d.old))}, not from the row's ${JSON.stringify(from)}`;
            }
          } else if (recorded && !toNow(k, d)) {
            problem = `records ${k} changing to ${JSON.stringify(text(d.new))}, not to the row's value`;
          }
          if (problem) break;
        }
        if (!problem && diff.nameVariants && typeof diff.nameVariants === "object") {
          const recordedVariants = parseVariants(blank(diff.nameVariants.new) ? null : String(diff.nameVariants.new));
          if (!variantsGiven) problem = "records name_variants, which the row does not change";
          else if (c.name_variants !== "") {
            if (!toNow("name_variants", diff.nameVariants)) problem = "does not record name_variants changing as the row gives them";
          } else if (variantList(c.name_variants_add).some((v) => !recordedVariants.includes(v)) ||
            variantList(c.name_variants_remove ?? "").some((v) => recordedVariants.includes(v))) {
            problem = "does not record name_variants changing as the row gives them";
          }
        }
        if (!problem) {
          const keyOf = new Map([...RECORD_FIELDS, "gender"].map((k) => [camel(k), k]));
          const dropped = Object.keys(diff).find((key) => key !== "nameVariants" && key !== "primaryFunctionId" && keyOf.has(key) && !given.includes(keyOf.get(key)!));
          if (dropped) problem = `records ${keyOf.get(dropped)}, which the row does not give`;
        }
        if (problem) {
          no(`the changelog row of this file for ${c.authority_code} ${problem}: no evidence the row was applied as it stands`);
          continue;
        }
      }
      if (fields.status !== "refused") plan.status = fields.status === "update" ? "update" : "already updated";
      continue;
    }

    if (op === "merge-entity") {
      const t = targets[0];
      const label = c.label_to_keep;
      const add = variantList(c.name_variants_add);
      plan.targets = [{ id: text(t.id), code: text(t.entity_code), rowId: "", arrives: !mergedIntoTarget }];
      if (mergedIntoTarget) {
        // Done before: the target holds the label and the variants the file gives.
        const variants = parseVariants(blank(t.name_variants) ? null : String(t.name_variants));
        const exclude = new Set(variantList(c.name_variants_remove));
        const missing = add.filter((v) => v !== text(t.display_name) && !exclude.has(v) && !variants.includes(v));
        if (label && !sameName(label, text(t.display_name))) { no(`${c.authority_code} is merged into ${text(t.entity_code)}, which is called ${JSON.stringify(text(t.display_name))}, not ${JSON.stringify(label)}`); continue; }
        if (missing.length > 0) { no(`${c.authority_code} is merged into ${text(t.entity_code)}, whose variants do not hold ${JSON.stringify(missing)}`); continue; }
        plan.status = "already merged";
        continue;
      }
      // The evidence: a fact, and a cited description of the tenant linked to each record, as read.
      const evidence = mergeRowEvidence(c, id, text(t.id), c.authority_code, text(t.entity_code), state);
      if (typeof evidence === "string") { no(evidence); continue; }
      const row: EntityMergeRow = {
        ref: ref(r), pair: `line ${r.line}`, codeA: text(t.entity_code), codeB: c.authority_code, survivorCode: text(t.entity_code),
        loserCode: c.authority_code, labelToKeep: label, add, remove: variantList(c.name_variants_remove), idsToCarry: "", idsNotCarried: "",
        precondition: "",
      };
      toMerge.push(row);
      mergeRows.set(row.ref, r);
      mergeEvidence.set(row.ref, evidence);
      plan.status = "merge";
      continue;
    }

    // Function rows.
    const f = state.functions.get(c.function_id);
    if (state.unsettled.includes(c.function_id)) { no(`function row ${c.function_id} changed while the plan read it; plan again`); continue; }
    const textHolds = (x: StoredFunction) => sameName(text(x.function), c.function);
    const onSource = !!f && text(f.entity_id) === id;
    if (op !== "rename-function" && f && !textHolds(f) && (onSource || targets.some((t) => text(t.id) === text(f.entity_id)))) {
      no(`function row ${c.function_id} is ${JSON.stringify(text(f.function))}, not ${JSON.stringify(c.function)}`);
      continue;
    }
    const elsewhere = () => no(`function row ${c.function_id} belongs to ${codeOf(text(f!.entity_id))}, not ${c.authority_code}`);
    plan.fn = f;

    if (op === "keep-function") {
      if (!f) { no(`no function row has the id ${c.function_id}`); continue; }
      if (!onSource) { elsewhere(); continue; }
      plan.status = "keep";
      continue;
    }

    // A row that writes changes the record's functions text, one function per line.
    if (hasLineBreak(c.function) || hasLineBreak(c.new_function) || (f && hasLineBreak(f.function))) {
      no(`function row ${c.function_id} holds a line break, which the editor's functions text, one per line, cannot show`);
      continue;
    }
    // The changelog row this file writes, or wrote, on the source for a move, a delete or a rename.
    const journalOp = journalOpOf(op);
    if (journalOp) plan.journalId = state.journalIds.get(journalKey(journalOp, c.function_id, id));
    const found = plan.journalId ? state.journalFound.get(plan.journalId) : undefined;
    const journaled = !!found && found.recordId === id;
    // The changelog row shows the row's text leaving the source: the text
    // stands more times among the functions before than after. A text
    // with a line break never gets this far, so the lines are the rows.
    const leaving = () => {
      const d = found?.diff?.functions;
      const count = (v: unknown) => (blank(v) ? [] : String(v).split("\n")).filter((l) => sameName(l, c.function)).length;
      return !!d && count(d.old) > count(d.new);
    };
    const notLeaving = () =>
      no(`the changelog row of this file for ${c.function_id} does not show ${JSON.stringify(c.function)} leaving ${c.authority_code}`);
    // A row folded away is done only where this file's changelog row records the fold: into a row of
    // `recordId` that holds the text `wanted`, case and spacing aside.
    const foldRecorded = (recordId: string, wanted: string) => {
      const into = found?.diff?.foldedInto?.new;
      return Array.isArray(into) && into.some((x: { record?: unknown; row?: unknown }) => {
        const held = state.functions.get(String(x?.row));
        return x?.record === recordId && !!held && text(held.entity_id) === recordId && functionIdentity(text(held.function)) === functionIdentity(wanted);
      });
    };
    const notFolded = (recordId: string, wanted: string) =>
      no(`function row ${c.function_id} is gone from ${c.authority_code}, and no changelog row of this file records its fold into a row of ${codeOf(recordId)} holding ${JSON.stringify(wanted)}`);

    if (op === "rename-function") {
      if (!f && journaled && heldOn(id, functionIdentity(c.new_function), [c.function_id])) {
        // Renamed onto a function the record held: the row is gone, and this file's changelog row records it
        // leaving and folding into the record's row of the new text.
        if (!leaving()) { notLeaving(); continue; }
        if (!foldRecorded(id, c.new_function)) { notFolded(id, c.new_function); continue; }
        plan.status = "already renamed";
        plan.absent = [c.function_id];
        continue;
      }
      if (!f) { no(`no function row has the id ${c.function_id}`); continue; }
      if (!onSource) { elsewhere(); continue; }
      const stored = text(f.function);
      const holdsNew = sameName(stored, c.new_function);
      const retexts = !sameName(c.function, c.new_function);
      // The honorific the row gives: undefined leaves it, null clears it.
      const honorific = c.new_honorific === "" ? undefined : c.new_honorific === "NULL" ? null : c.new_honorific;
      const honorificHolds = honorific === undefined || (honorific === null ? f.honorific === null : sameNfc(f.honorific, honorific));
      if (holdsNew && honorificHolds) {
        // Held already: "same" without this file's changelog row, done with it when it records the row's change.
        if (!journaled) { plan.status = "same"; continue; }
        const d = found?.diff ?? {};
        const count = (v: unknown, t: string) => (blank(v) ? [] : String(v).split("\n")).filter((l) => sameName(l, t)).length;
        const fx = d.functions && typeof d.functions === "object" ? d.functions : null;
        const hx = d.functionHonorific && typeof d.functionHonorific === "object" ? d.functionHonorific : null;
        let problem = "";
        if (retexts && !(fx && count(fx.old, c.function) > count(fx.new, c.function) && count(fx.new, c.new_function) > count(fx.old, c.new_function))) {
          problem = `does not show ${JSON.stringify(c.function)} becoming ${JSON.stringify(c.new_function)} on ${c.authority_code}`;
        } else if (!retexts && fx) {
          problem = "records a change of the functions text, which the row does not give";
        } else if (hx && honorific === undefined) {
          problem = "records a change of the honorific, which the row does not give";
        } else if (hx && !(honorific === null ? hx.new === null : sameNfc(hx.new, honorific))) {
          problem = `records the honorific changing to ${JSON.stringify(text(hx.new))}, not to the row's ${JSON.stringify(c.new_honorific)}`;
        } else if (!fx && !hx) {
          problem = "records no change of the row";
        }
        if (problem) { no(`the changelog row of this file for ${c.function_id} ${problem}: no evidence the row was applied as it stands`); continue; }
        plan.status = "already renamed";
        continue;
      }
      if (journaled) {
        no(changedSince(r, `part of its effect is present: a changelog row of this file records a rename of ${c.function_id}, and the row would write more`));
        continue;
      }
      // A row that writes finds the text it names.
      if (!textHolds(f)) { no(`function row ${c.function_id} is ${JSON.stringify(stored)}, not ${JSON.stringify(c.function)}`); continue; }
      plan.rename = {
        ...(holdsNew ? {} : { function: c.new_function }),
        ...(honorificHolds ? {} : { honorific: honorific as string | null }),
      };
      // A new text the record holds already, case and spacing aside, in another row: the held row
      // takes the renamed row's fields it lacks (the honorific the row gives among them), and the
      // renamed row goes, as a move onto a holder does.
      const holder = plan.rename.function === undefined ? undefined : heldOn(id, functionIdentity(c.new_function), [c.function_id]);
      if (holder) {
        const incoming = { ...functionFieldsOf(f), ...(honorific !== undefined ? { honorific } : {}) };
        const fill = fillFunctionFields(fieldsNow(holder.id), incoming);
        plan.targets = [{ id, code: c.authority_code, rowId: c.function_id, arrives: Object.keys(fill.set).length > 0, foldInto: { id: holder.id, function: holder.function, ...fill } }];
      } else if (plan.rename.function !== undefined) {
        renamedTo.set(c.function_id, c.new_function);
      }
      plan.status = "rename";
      continue;
    }

    if (op === "delete-function") {
      if (!f) {
        if (!journaled) {
          no(`no function row has the id ${c.function_id}, and no changelog row of this file records its removal from ${c.authority_code}`);
          continue;
        }
        if (!leaving()) { notLeaving(); continue; }
        plan.status = "already deleted";
        plan.absent = [c.function_id];
        continue;
      }
      if (!onSource) { elsewhere(); continue; }
      plan.status = "delete";
      continue;
    }

    // Moves and copies: where the row is, or is to be, on each target. A
    // row already on a target counts as this row's result only when it is
    // the row it makes there and holds the source's columns.
    const single = op === "move-function" && targets.length === 1;
    const sourceText = f ? text(f.function) : c.function;
    const differing = (x: StoredFunction, from: StoredFunction) => CARRIED_COLUMNS.filter((k) => x[k] !== from[k]);
    const placed = targets.map((t): TargetPlan | string => {
      const tid = text(t.id);
      const rowId = single ? c.function_id : state.derived.get(derivedKey(c.function_id, tid))!;
      const there = state.functions.get(rowId);
      if (single) return { id: tid, code: text(t.entity_code), rowId, arrives: !(there && text(there.entity_id) === tid) };
      if (!there) return { id: tid, code: text(t.entity_code), rowId, arrives: true };
      if (text(there.entity_id) !== tid || !textHolds(there)) return `function row ${rowId}, the row ${c.function_id} makes on ${text(t.entity_code)}, is not as planned`;
      if (f && onSource && differing(there, f).length > 0) {
        return `function row ${rowId}, the row ${c.function_id} makes on ${text(t.entity_code)}, does not hold ${c.function_id}'s columns (${differing(there, f).join(", ")})`;
      }
      return { id: tid, code: text(t.entity_code), rowId, arrives: false };
    });
    const problem = placed.find((p): p is string => typeof p === "string");
    if (problem) { no(problem); continue; }
    plan.targets = placed as TargetPlan[];

    // A target that holds the function by then keeps its row, which takes the fields it lacks.
    const identity = functionIdentity(sourceText);
    for (const t of plan.targets) {
      if (!t.arrives) continue;
      const held = heldOn(t.id, identity, [c.function_id, t.rowId]);
      if (!held) continue;
      const fill = f && onSource ? fillFunctionFields(fieldsNow(held.id), functionFieldsOf(f)) : { set: {}, conflicts: [] };
      t.foldInto = { id: held.id, function: held.function, ...fill };
      t.arrives = Object.keys(fill.set).length > 0;
    }
    const folds = plan.targets.filter((t) => t.foldInto);
    const made = plan.targets.filter((t) => !t.arrives && !t.foldInto);

    if (single) {
      if (!f && folds.length === 1) {
        // Moved onto a target that held the function: the row is gone, and the changelog row records it leaving.
        if (!journaled) { no(`function row ${c.function_id} is gone from ${c.authority_code}, and no changelog row of this file records its move from there`); continue; }
        if (!leaving()) { notLeaving(); continue; }
        if (!foldRecorded(folds[0].id, c.function)) { notFolded(folds[0].id, c.function); continue; }
        plan.status = "already moved";
        plan.absent = [c.function_id];
        continue;
      }
      if (!f) { no(`no function row has the id ${c.function_id}`); continue; }
      if (text(f.entity_id) === plan.targets[0].id) {
        if (!journaled) { no(`function row ${c.function_id} is on ${plan.targets[0].code}, and no changelog row of this file records its move from ${c.authority_code}`); continue; }
        if (!leaving()) { notLeaving(); continue; }
        plan.status = "already moved";
        continue;
      }
      if (!onSource) { elsewhere(); continue; }
      plan.status = "move";
    } else if (op === "move-function") {
      if (!f) {
        if (plan.targets.every((t) => t.arrives)) { no(`no function row has the id ${c.function_id}`); continue; }
        if (plan.targets.some((t) => t.arrives)) { no(changedSince(r, `part of its effect is present: function row ${c.function_id} is gone from ${c.authority_code} and not on every target`)); continue; }
        if (!journaled) { no(`function row ${c.function_id} is gone from ${c.authority_code}, and no changelog row of this file records its move from there`); continue; }
        if (!leaving()) { notLeaving(); continue; }
        const unfolded = folds.find((t) => !foldRecorded(t.id, c.function));
        if (unfolded) { notFolded(unfolded.id, c.function); continue; }
        const madeRows = made.map((t) => state.functions.get(t.rowId)!);
        const unlike = madeRows.find((x) => differing(x, madeRows[0]).length > 0);
        if (unlike) { no(`the rows ${c.function_id} made on its targets differ in ${differing(unlike, madeRows[0]).join(", ")}`); continue; }
        plan.status = "already moved";
        plan.absent = [c.function_id];
        continue;
      }
      if (!onSource) { elsewhere(); continue; }
      if (made.length > 0) { no(changedSince(r, `part of its effect is present: the row ${c.function_id} makes is already on ${made.map((t) => t.code).join(", ")}`)); continue; }
      plan.status = "move";
    } else {
      if (!f) { no(`no function row has the id ${c.function_id}`); continue; }
      if (!onSource) { elsewhere(); continue; }
      const arriving = plan.targets.filter((t) => t.arrives);
      if (made.length > 0 && arriving.length > 0) {
        no(changedSince(r, `part of its effect is present: the row ${c.function_id} makes is already on ${made.map((t) => t.code).join(", ")}, not on ${arriving.map((t) => t.code).join(", ")}`));
        continue;
      }
      // Every target holding the function and lacking nothing: nothing to write, nothing done.
      plan.status = arriving.length > 0 ? "copy" : made.length > 0 ? "already copied" : "same";
    }
    plan.absent = plan.targets.filter((t) => t.arrives && !t.foldInto && t.rowId !== c.function_id).map((t) => t.rowId);

    // What the row brings each target, for the rows after it.
    if (plan.status === "move" || plan.status === "copy") {
      for (const t of plan.targets) {
        if (!t.foldInto && t.arrives) arrivedOn.set(t.id, [...(arrivedOn.get(t.id) ?? []), { id: t.rowId, function: sourceText }]);
      }
    }

    // A target that holds a row differing only in accents still receives the row.
    const key = functionKey(sourceText);
    for (const t of plan.targets.filter((x) => x.arrives && !x.foldInto)) {
      const held = (state.fullSets.get(t.id) ?? []).find((x) => functionKey(text(x.function)) === key && text(x.id) !== c.function_id && text(x.id) !== t.rowId);
      if (held) t.alreadyHas = text(held.function);
    }
  }

  // The place rows first, since a place link may name a place the file creates.
  const entityKeys = new Map<string, number>();
  for (const r of input.rows) if (r.cells.op === "create-entity" && r.cells.new_key && !entityKeys.has(r.cells.new_key)) entityKeys.set(r.cells.new_key, r.line);
  // Only the rows whose shape held reach them, as only those reach the additions.
  const deferredInput = { file: input.file, rows: [...deferred].map((p) => p.row) };
  const placed = planPlaces(
    deferredInput, state.places, { tenantId: state.tenantId, tenantSlug: state.tenantSlug, federationId: state.federationId, entityKeys }, refuse,
  );

  // The additions: keys, records, links and relations, checked together.
  const additionRows = plans.filter((p) => p.status === "create" && isAdditionOp(p.op));
  for (const p of additionRows) p.status = "refused";
  const added = planAdditions(
    { file: input.file, rows: additionRows.map((p) => p.row) },
    state.additions,
    {
      tenantId: state.tenantId, tenantSlug: state.tenantSlug, federationId: state.federationId,
      resolve: (code) => resolve(code, ""),
      mergedBy: (id) => mergedBy.get(id),
      nameHolds: nameHolds,
      placeKey: placed.resolver.key,
      placeMergedBy: placed.resolver.mergedBy,
      placeNameHolds: placed.resolver.nameHolds,
    },
    refuse,
    input.rows,
  );
  for (const p of additionRows) p.status = added.statuses.get(p.row) ?? "refused";

  // The link moves, which may name what the file creates.
  /** A create-entity key's record: its id, or the reason a row naming it is refused. */
  const entityKey = (value: string): string | { id: string } => {
    const key = value.slice("new:".length);
    const made = additionRows.find((p) => p.op === "create-entity" && p.row.cells.new_key === key);
    if (!made) return `${value} is not defined by any create-entity row of the file`;
    if (made.status === "refused") return `${value} is refused at line ${made.row.line}`;
    const id = state.additions.ids.get(entityIdentity(made.row.file, key)) ?? "";
    const line = mergedBy.get(id);
    if (line !== undefined) return `${value} is merged by line ${line}, so no other row may name it`;
    return { id };
  };
  // The links the merges write: each loser's links (moved or dropped), and the links naming a dropped
  // one in `related_to`, which the merge repoints; and each place loser's links.
  const writtenLinks = new Map<string, string>();
  const survivorRows = new Map<string, ChangeRow[]>();
  for (const m of toMerge) {
    const r = mergeRows.get(m.ref)!;
    survivorRows.set(m.survivorCode, [...(survivorRows.get(m.survivorCode) ?? []), r]);
  }
  for (const [survivorCode, rs] of survivorRows) {
    const holds = heldLinks(state.links.get(text(state.byCode.get(survivorCode)?.id)) ?? []);
    for (const r of rs) {
      for (const l of state.links.get(text(state.byCode.get(r.cells.authority_code)?.id)) ?? []) {
        writtenLinks.set(l.id, `the merge of line ${r.line}`);
        if (holds.has(heldKey(l))) {
          for (const p of state.pointing.get(l.id) ?? []) writtenLinks.set(p.id, `the merge of line ${r.line}, which repoints its related_to`);
        } else holds.set(heldKey(l), l.id);
      }
    }
  }
  for (const g of placed.plan.groups) {
    for (const p of g.pairs) for (const l of state.places.links.get(text(p.loser.id)) ?? []) writtenLinks.set(l.id, `the merge of line ${p.row.line}`);
  }
  // A link an addition finds held ("same") is relied on by that row: no move or drop row may name it.
  for (const a of added.plan.rows) if (a.held) writtenLinks.set(a.held, `line ${a.row.line}, which finds it held`);
  const moved = planLinkMoves(deferredInput, state.linkMoves, state.places, {
    writtenLinks,
    tenantId: state.tenantId,
    tenantSlug: state.tenantSlug,
    places: placed.resolver,
    entity: (code) => resolve(code, ""),
    entityNameHolds: nameHolds,
    entityMergedBy: (id) => mergedBy.get(id),
    entityKey,
    added: added.plan.rows.flatMap((a) => [
      ...a.links.map((l): ["entity", string, string, string, string] => ["entity", l.descriptionId, l.entityId, l.role, l.relatedTo ?? ""]),
      ...(a.placeLink ? [["place", a.placeLink.descriptionId, a.placeLink.placeId, a.placeLink.role, ""] as ["place", string, string, string, string]] : []),
    ]),
  }, refuse);
  for (const p of deferred) p.status = placed.statuses.get(p.row) ?? moved.statuses.get(p.row) ?? "refused";

  // The ledger rows: one split or separate per pair of records the moves that write move links between,
  // then the backfill rows, none of which may name a pair the moves record.
  const ledgerMoves = planMoveLedger(
    input, moved.plan, state.ledger,
    (kind, code) => text((kind === "entity" ? state.byCode.get(code) : state.places.byCode.get(code))?.id),
    refuse,
  );
  for (const p of deferred) if (ledgerMoves.refused.includes(p.row)) p.status = "refused";
  const ledger: LedgerPlan = { rows: [...ledgerMoves.rows] };
  const ledgerTaken = movedPairs(ledgerMoves.rows);
  for (const x of ledgerRows) {
    const planned = planBackfillRow(x.plan.row, x.sourceId, x.targetId, state.ledger, {
      federationId: state.federationId, note: x.plan.note, file: input.file,
    }, ledgerTaken);
    if (typeof planned === "string") { refuse(ref(x.plan.row), planned); continue; }
    x.plan.status = planned.status;
    if (planned.plan) ledger.rows.push(planned.plan);
  }

  // The deletes: a record a delete row names is named by no other row of the file.
  const removed = planDeletes(
    { file: input.file, rows: [...deleteRows].map((p) => p.row) }, state.deletes, { tenantId: state.tenantId, federationId: state.federationId }, refuse, input.rows,
  );
  const deleting = new Map(removed.plan.rows.map((d) => [d.row, d]));
  for (const p of deleteRows) {
    p.status = removed.statuses.get(p.row) ?? "refused";
    // The record a delete changes, for the steward check.
    const d = deleting.get(p.row);
    if (d?.kind === "entity") p.entityId = d.id;
    else if (d) placed.plan.changed.push(d.record);
  }

  // Rows that rely on one another: a function row one row names or makes,
  // or finds already made, may be named or made by no other row.
  const reliedOn = new Map<string, number>();
  for (const p of plans) {
    if (p.status === "refused" || !FUNCTION_OPS.includes(p.op as Op)) continue;
    const ids = [...new Set([p.row.cells.function_id, ...p.targets.map((t) => t.rowId)])];
    const taken = ids.find((x) => reliedOn.has(x));
    if (taken) {
      refuse(ref(p.row), `function row ${taken} is relied on by line ${reliedOn.get(taken)}`);
      p.status = "refused";
      continue;
    }
    for (const x of ids) reliedOn.set(x, p.row.line);
  }
  // A fold reads its held row as stored: no other row of the file may create, move, rename, fill or
  // delete that row, and no row is filled by two rows. Such a chain is applied as two files, one after
  // the other, each planned against what the one before it left.
  const touchedBy = new Map<string, Array<{ line: number; what: string }>>();
  const touch = (id: string, line: number, what: string) => touchedBy.set(id, [...(touchedBy.get(id) ?? []), { line, what }]);
  for (const q of plans) {
    if (q.status === "refused" || !FUNCTION_OPS.includes(q.op as Op)) continue;
    const line = q.row.line;
    const id = q.row.cells.function_id;
    // A line touches its rows whatever its status: a rename that changes nothing ("same") still reads its row.
    if (q.op === "move-function") {
      const there = q.targets.some((t) => t.arrives && !t.foldInto && t.rowId === id);
      touch(id, line, there ? "moved there" : "moved");
      for (const t of q.targets) if (t.arrives && !t.foldInto && t.rowId !== id) touch(t.rowId, line, "created");
    }
    if (q.op === "copy-function") for (const t of q.targets) if (t.arrives && !t.foldInto) touch(t.rowId, line, "created");
    if (q.op === "rename-function") touch(id, line, "renamed");
    if (q.op === "delete-function") touch(id, line, "deleted");
    // A fold counts whatever the line's status, a "same" copy onto a holder that lacks nothing among them.
    for (const t of q.targets) if (t.foldInto) touch(t.foldInto.id, line, "filled");
  }
  for (const p of plans) {
    if (p.status === "refused" || !FUNCTION_OPS.includes(p.op as Op)) continue;
    for (const t of p.targets) {
      if (!t.foldInto) continue;
      const other = (touchedBy.get(t.foldInto.id) ?? []).filter((x) => x.line !== p.row.line).sort((a, b) => a.line - b.line)[0];
      if (!other) continue;
      refuse(ref(p.row), `function row ${t.foldInto.id}, which this row would fill on ${t.code}, is ${other.what} by line ${other.line} of the same file: ` +
        "put the two lines in two files, applied one after the other");
      p.status = "refused";
      break;
    }
    // A copy reads its source row: another line may not fill, move, rename or delete it.
    if (p.status !== "refused" && p.op === "copy-function") {
      const id = p.row.cells.function_id;
      const other = (touchedBy.get(id) ?? []).filter((x) => x.line !== p.row.line).sort((a, b) => a.line - b.line)[0];
      if (other) {
        refuse(ref(p.row), `function row ${id}, which this row copies, is ${other.what} by line ${other.line} of the same file: ` +
          "put the two lines in two files, applied one after the other");
        p.status = "refused";
      }
    }
  }

  // Merges: a record already merged into its target is done; the rest are
  // planned as the reviewed merge plans them.
  const merges: EntityPlan = { groups: [], refusals: [], exclusions: [], idsLeftOnLoser: [] };
  if (toMerge.length > 0) {
    const byCode = new Map<string, EntityRow[]>([...state.byCode].map(([code, e]) => [code, [entityRowOf(e)]]));
    const planned = planEntityMerges(toMerge, byCode);
    // A loser link named from outside its description is stale data: the row is refused, naming only the loser's link.
    for (const x of staleLoserLinks(planned, state.links, state.pointing, state.staleNamed)) {
      const ref = planned.groups.flatMap((g) => g.pairs).find((p) => p.loser.id === x.loserId)?.row.ref;
      if (ref) planned.refusals.push({ ref, reason: staleNamingMessage(x.linkId, x.loserCode) });
    }
    for (const f of planned.refusals) refuse(f.ref, f.reason);
    Object.assign(merges, planned);
    for (const f of planned.refusals) {
      const p = plans.find((x) => ref(x.row) === f.ref);
      if (p) p.status = "refused";
    }
    // Two merges into one survivor whose losers hold one function would fold one loser's row into the
    // other's, or both into one survivor row: a chain within the file, refused as the function rows' are.
    for (const g of planned.groups) {
      const first = new Map<string, { line: number; rowId: string }>();
      for (const { row, loser } of g.pairs) {
        const line = mergeRows.get(row.ref)?.line;
        if (line === undefined) continue;
        const own = new Map<string, string>();
        for (const fr of state.fullSets.get(loser.id) ?? []) {
          const key = functionIdentity(text(fr.function));
          const earlier = first.get(key);
          if (earlier && earlier.line !== line) {
            refuse(ref(mergeRows.get(row.ref)!), `function row ${text(fr.id)} of ${loser.code} would fold on ${g.survivor.code} with function row ${earlier.rowId}, ` +
              `which line ${earlier.line} merges there: put the two lines in two files, applied one after the other`);
            const p = plans.find((x) => x.row === mergeRows.get(row.ref));
            if (p) p.status = "refused";
            break;
          }
          if (!own.has(key)) own.set(key, text(fr.id));
        }
        for (const [key, rowId] of own) if (!first.has(key)) first.set(key, { line, rowId });
      }
    }
  }

  // The links as the whole file leaves them: the merges' moves, repoints and drops, the link rows'
  // moves and drops, and the additions. A pair under one key of the unique index would fail the
  // file whole when applied, with no word of which links; the rows that make it are refused here,
  // by the codes of the description and the entity.
  {
    const changes = mergeLinkChanges(merges, state.links, state.pointing);
    const causeOf = new Map<string, ChangeRow>();
    for (const [id, loserId] of changes.causeOf) {
      const r = mergeRows.get(merges.groups.flatMap((g) => g.pairs).find((x) => x.loser.id === loserId)?.row.ref ?? "");
      if (r) causeOf.set(id, r);
    }
    const rowsRead: IndexedLink[] = [
      ...changes.rows,
      ...[...state.linkMoves.entityLinks, ...state.additions.links].map((l) => ({
        id: text(l.id), descriptionId: text(l.description_id), entityId: text(l.entity_id), role: text(l.role),
        relatedTo: blank(l.related_to) ? null : text(l.related_to),
      })),
    ];
    for (const p of moved.plan.rows) {
      if (p.kind !== "entity") continue;
      const id = String(p.link.id);
      if (p.status === "move link") { changes.entityOf.set(id, p.targetId!); causeOf.set(id, p.row); }
      if (p.status === "drop link") changes.dropped.add(id);
      if (p.status === "drop relation") for (const x of [p.link, p.pair!]) changes.dropped.add(String(x.id));
      if (p.status === "update link" && typeof p.set?.role === "string") {
        // A role changed: the link is read under its new role, ahead of the link as read.
        rowsRead.unshift({ id, descriptionId: String(p.link.descriptionId), entityId: p.sourceId, role: p.set.role, relatedTo: blank(p.link.relatedTo) ? null : String(p.link.relatedTo) });
        changes.entityOf.set(id, p.sourceId);
        causeOf.set(id, p.row);
      }
    }
    for (const a of added.plan.rows) {
      if (a.status !== "link" && a.status !== "relate") continue;
      for (const l of a.links) {
        rowsRead.push(l);
        changes.entityOf.set(l.id, l.entityId);
        causeOf.set(l.id, a.row);
      }
    }
    const opOf: Record<string, string> = {
      "merge-entity": "the merge", "move-link": "the move", "update-link": "the update", "add-link": "the addition", "add-relation": "the addition",
    };
    const refusedHere = new Set<ChangeRow>();
    for (const c of linkCollisions(rowsRead, changes)) {
      const causes = [...new Set(c.linkIds.map((id) => causeOf.get(id)).filter((r): r is ChangeRow => r !== undefined))].sort((a, b) => a.line - b.line);
      if (causes.length === 0) continue;
      const at = causes[causes.length - 1];
      if (refusedHere.has(at)) continue;
      refusedHere.add(at);
      const subject = causes.length === 1 ? (opOf[at.cells.op] ?? "the row") : `this row and line ${causes[0].line} together`;
      refuse(ref(at), linkCollisionMessage({
        referenceCode: state.linkCodes.descriptions.get(c.descriptionId) ?? c.descriptionId,
        entityCode: text(state.byId.get(c.entityId)?.entity_code) || (state.linkCodes.entities.get(c.entityId) ?? c.entityId),
        role: c.role,
      }, subject));
      const p = plans.find((x) => x.row === at);
      if (p) p.status = "refused";
    }
  }

  // Coverage: every row of a covered record is named, or put there by the file.
  for (const [id, r] of covered) {
    const placedHere = new Set(plans.flatMap((p) => p.targets.filter((t) => t.id === id).map((t) => t.rowId)));
    for (const f of state.fullSets.get(id) ?? []) {
      const fid = text(f.id);
      const listed = named.get(fid);
      if (listed && listed.cells.authority_code === r.cells.authority_code) continue;
      if (placedHere.has(fid)) continue;
      refuse(codeOf(id), `the file covers its functions and does not name its function row ${fid} (${text(f.function)})`);
    }
  }

  // The rerun contract: a file applies whole, so a run of it again finds every row done. A file with
  // some rows done and others to write was applied before and has changed since: it is refused whole.
  const done = plans.find((p) => p.status.startsWith("already"));
  const pending = plans.find((p) => WRITES.includes(p.status));
  if (done && pending) {
    refuse(input.file, `this file was applied before and has changed since: put new changes in a new file ` +
      `(line ${done.row.line} is ${done.status}; line ${pending.row.line} would ${pending.status})`);
  }

  return { rows: plans, refusals, merges, mergeRows, mergeEvidence, additions: added.plan, places: placed.plan, linkMoves: moved.plan, deletes: removed.plan, ledger };
}

/**
 * The evidence of a `merge-entity` row, or the reason it is refused. The
 * facts are `facts`; each code of `evidence_codes` must name one of the
 * tenant's descriptions, linked (as read) to the row's authority, its
 * target or both, and the rule of `judgeMergeEvidence` decides the rest.
 */
function mergeRowEvidence(
  c: Record<string, string>,
  loserId: string,
  survivorId: string,
  loserCode: string,
  survivorCode: string,
  state: AuthoritiesState,
): MergeEvidence | string {
  const holds = (entityId: string) => new Set((state.links.get(entityId) ?? []).map((l) => l.descriptionId));
  const sides = [{ id: loserId, holds: holds(loserId) }, { id: survivorId, holds: holds(survivorId) }];
  const cited: Array<{ entityId: string; descriptionId: string }> = [];
  for (const code of spacedList(c.evidence_codes)) {
    const found = state.evidenceDescriptions.get(code) ?? [];
    if (found.length === 0) return `evidence code ${code} is not a description of this workspace`;
    if (found.length > 1) return `evidence code ${code} names ${found.length} descriptions of this workspace`;
    const on = sides.filter((x) => x.holds.has(found[0]));
    if (on.length === 0) return `evidence code ${code} is linked to neither ${loserCode} nor ${survivorCode}`;
    for (const x of on) cited.push({ entityId: x.id, descriptionId: found[0] });
  }
  const judged = judgeMergeEvidence(loserId, survivorId, { facts: spacedList(c.facts), cited }, () => true);
  if (judged.ok) return judged.evidence;
  switch (judged.error) {
    case "evidence_facts":
      return `facts ${JSON.stringify(c.facts)} must name one or more of ${MERGE_FACTS.join(", ")}: a shared name is not evidence`;
    case "evidence_loser":
      return `evidence_codes cite no description linked to ${loserCode}`;
    case "evidence_survivor":
      return `evidence_codes cite no description linked to ${survivorCode}`;
    default:
      return "the evidence cites a description linked to neither record";
  }
}

/** Whether the plan writes anything. */
export function hasWrites(plan: AuthoritiesPlan): boolean {
  return plan.rows.some((r) => WRITES.includes(r.status));
}

/** A stored function row's fillable fields, under the app's names. */
export function functionFieldsOf(f: StoredFunction): ComparedFields {
  const v = (c: string) => (f[c as keyof StoredFunction] === null ? null : text(f[c as keyof StoredFunction]));
  return {
    honorific: v("honorific"), dateStart: v("date_start"), dateEnd: v("date_end"), dateNote: v("date_note"), source: v("source"), notes: v("notes"),
    certainty: v("certainty"),
  };
}

/** The functions of a record as text, one per line in entry order, as the editor's changelog gives them. */
export const functionsTextOf = (rows: Array<{ function: unknown }>) => functionsText(rows.map((r) => ({ function: text(r.function) })));

// @version v0.9.0
