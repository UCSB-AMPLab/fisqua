/**
 * Scripts — the change file of the command line's authority changes
 *
 * This module reads the file `scripts/fisqua.ts authorities` takes: one
 * CSV, one row per operation, with an `op` column. A file may mix
 * operations and is applied whole or not at all. The rerun contract
 * (`./plan.ts`): a file run again finds every row done and writes
 * nothing, and a file with some rows done and others to write was
 * changed after it was applied and is refused whole; new changes go in a
 * new file.
 *
 * Columns: `op` is always required. `authority_code` and
 * `authority_name` (the record the row acts on, as a check) are
 * required when the file holds one of the operations that act on an
 * existing record, and must be blank on the four that add
 * (`ADDITION_OPS`), on `create-place` and on `drop-relation`; a file of
 * those alone may leave them out. `add-link` and `add-place-link` may give
 * `authority_name` (`NAME_CHECKED_OPS`) as a check of the existing
 * record they name in `entity` or `place`, blank when that is a
 * `new:<key>`. The
 * others may be left out of a file whose operations do not use them.
 * `function_id` and `function` name a function row and its text;
 * `new_function` and `new_honorific` are the text and honorific a
 * `rename-function` row gives the row (`new_honorific` blank leaves the
 * stored honorific, `NULL` clears it);
 * `target_codes` names one or more records, separated by spaces;
 * `label_to_keep`, `name_variants_add` and `name_variants_remove` serve
 * a merge or a field update (variants separated by " | ");
 * `current_name`, `current_dates`, `current_function`, the record fields
 * (`RECORD_FIELDS`, as the originals file of a split has them) and
 * `gender` serve a field update; `changelog_note` is the note of the
 * row's changelog rows. `rule`, `evidence` and `flag` are for the
 * reviewer: they are read and never written.
 *
 * The additions read `new_key`, the new record's fields
 * (`display_name`, `sort_name`, `surname`, `given_name`, `entity_type`,
 * `gender`, `qualified_name`, `known_only_from_relation`),
 * `description_code`, `entity`, `place`, the link's fields (`role`,
 * `name_as_recorded`, `role_raw`, `honorific`, `role_note`,
 * `sequence`), and for each side of a relation under `a_` and `b_` the
 * same fields with `entity` and `certainty` (the side's relation
 * certainty). A document link has no certainty: the `certainty` column
 * is read so that a file may carry it, and a value in it refuses the
 * row, as any column outside the row's operation does. An attribute of a link is a column
 * `attr_<key>`, and of a relation side `a_attr_<key>` or
 * `b_attr_<key>` (`ATTRIBUTE_COLUMN`): any `<key>` is read here, and the
 * plan refuses the file whole when the federation's `link_attribute`
 * list does not hold it. Any other column not named here refuses the
 * file whole.
 *
 * The columns each operation may fill (`OP_COLUMNS`); any other column
 * of the row, the reviewer's and `changelog_note` aside, must be blank:
 *
 *   keep-function     function_id, function
 *   move-function     function_id, function, target_codes
 *   copy-function     function_id, function, target_codes
 *   delete-function   function_id, function
 *   rename-function   function_id, function, new_function, new_honorific
 *   update-entity     current_*, the record fields, gender, name_variants_add, name_variants_remove
 *   merge-entity      target_codes (one), label_to_keep, name_variants_add, name_variants_remove, facts, evidence_codes
 *   cover-functions   (none): the file names every function row the authority holds
 *   create-entity     new_key and the new record's fields
 *   add-link          description_code, entity, the link fields (no certainty), attr_<key>
 *   add-place-link    description_code, place, role, role_note
 *   add-relation      description_code, and a_ and b_ entity, the link fields, attr_<key>
 *   create-place      new_key, the place fields (`PLACE_FIELDS`), name_variants_add
 *   update-place      the place fields, current_<field> for each but label, name_variants_add, name_variants_remove
 *   merge-place       target_codes (one), label_to_keep, name_variants_add, name_variants_remove, and the
 *                     values carried into the survivor: tgn_id, hgis_id, whg_id, latitude, longitude,
 *                     coordinate_precision
 *   move-place-link   description_code, role, target_codes (one)
 *   drop-place-link   description_code, role
 *   move-link         description_code, role, target_codes (one)
 *   drop-link         description_code, role
 *   update-link       description_code, role, new_role, the link fields it changes (`LINK_UPDATE_FIELDS`),
 *                     current_<field> for each (`LINK_CURRENT`)
 *   drop-relation     description_code, a_entity, a_role, b_entity, b_role
 *   delete-entity     (none)
 *   delete-place      (none)
 *   record-split      target_codes (one)
 *   record-separate   target_codes (one)
 *
 * A `merge-entity` row carries its evidence, since a shared name is
 * never evidence that two records are one: `facts`, one or more of
 * `dates`, `office`, `kin`, `place` and `matter` separated by spaces,
 * and `evidence_codes`, the reference codes of the acting tenant's
 * descriptions that show it, separated by spaces, each linked to the
 * row's authority or its target and at least one to each. The plan
 * refuses a row without them (`./plan.ts`). A `merge-place` row carries
 * neither.
 *
 * A place row names the place it acts on in `authority_code` (its code)
 * and `authority_name` (its stored `label`). The place fields are
 * `label`, `display_name`, `place_type`, `parent` (a place code or
 * `new:<key>`), `latitude`, `longitude`, `coordinate_precision`,
 * `tgn_id`, `hgis_id`, `whg_id`, `fclass` and `notes`; an update names
 * the stored value of each field it gives, `label` aside, in
 * `current_<field>` (`PLACE_CURRENT`). `create-place`, like the
 * additions, names no `authority_code` (`KEYED_OPS`). A link move or
 * drop names its source record in `authority_code` and `authority_name`:
 * a place for the place-link operations, an entity for the others.
 *
 * `drop-link` removes a document link only: a link that holds
 * `related_to`, or that another link names, is a side of a relation,
 * and the row is refused, since the other side would name a link that is
 * gone. A relation is removed whole by `drop-relation`, which names it as
 * `add-relation` makes it: the description, and each side's record and
 * role (`a_entity` and `a_role`, `b_entity` and `b_role`; existing codes,
 * both roles given), in either order; it names no `authority_code`
 * (`KEYED_OPS`).
 *
 * `update-link` names a document link or a relation side as `drop-link`
 * does (`authority_code`, `description_code`, `role`) and changes its
 * role (`new_role`, an `entity_role` code; never a relation side's) and
 * the fields `role_note`, `role_raw`, `honorific`, `name_as_recorded`
 * and `sequence`: blank leaves a field, `NULL` clears a text field, and
 * each field given names its stored value in `current_<field>` (blank or
 * `NULL` for an empty text), as an `update-place` row does; the stored
 * role is `role`. A link's attributes are not changed by this operation.
 *
 * `delete-entity` and `delete-place` name the record in `authority_code`
 * and `authority_name` (an entity's display name, a place's label) and
 * fill no other column (`DELETE_OPS`, planned by `./deletes.ts`).
 *
 * `record-split` and `record-separate` (`LEDGER_OPS`, planned by
 * `./ledger.ts`) write one `authority_operations` row of operation
 * `split` or `separate`, source the entity of `authority_code` (named by
 * `authority_name`), target the one existing entity of `target_codes`,
 * detail `{ reason, movedLinks: 0, backfill: true, file }`: they record a
 * split or a separation that a file applied before the link moves wrote
 * their own ledger rows. Each is refused when either record is missing,
 * out of scope or merged away, or when the two are one record; it is
 * "same" when a ledger row of its operation is between the two in either
 * direction, of any file or of the app, and "already recorded" when this
 * file's is. A `record-split` row's ledger row takes the target's
 * `created_at` (epoch ms; a stored value below 1e11 read as seconds) as
 * its `created_at`, the time the split made the target, so that the
 * handlists flag only members added before it; a `record-separate`
 * row's takes the run's clock. The link moves of a file write such rows themselves
 * (`./ledger.ts`).
 *
 * @version v0.9.0
 */

import { parseCsv, CsvParseError } from "../../../app/lib/import/csv";
import { RECORD_FIELDS } from "../entity-splits";

/** A problem that stops the whole run before anything is written. */
export class AuthoritiesStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoritiesStop";
  }
}

export const OPS = [
  "keep-function", "move-function", "copy-function", "delete-function", "rename-function", "update-entity", "merge-entity", "cover-functions",
  "create-entity", "add-link", "add-place-link", "add-relation",
  "create-place", "update-place", "merge-place", "move-place-link", "drop-place-link", "move-link", "drop-link",
  "update-link", "drop-relation", "delete-entity", "delete-place", "record-split", "record-separate",
] as const;
export type Op = (typeof OPS)[number];

/** The operations that add records and links; they name no `authority_code` or `authority_name`. */
export const ADDITION_OPS: readonly Op[] = ["create-entity", "add-link", "add-place-link", "add-relation"];

/** The link additions, which may give `authority_name` as a check of the record they name. */
export const NAME_CHECKED_OPS: readonly Op[] = ["add-link", "add-place-link"];

/** The operations that name no existing record in `authority_code`: the additions, `create-place` and `drop-relation`. */
export const KEYED_OPS: readonly Op[] = [...ADDITION_OPS, "create-place", "drop-relation"];

/** The place operations, planned by `./places.ts`. */
export const PLACE_OPS: readonly Op[] = ["create-place", "update-place", "merge-place"];

/** The link moves, drops and updates, planned by `./link-moves.ts`. */
export const LINK_MOVE_OPS: readonly Op[] = ["move-place-link", "drop-place-link", "move-link", "drop-link", "update-link", "drop-relation"];

/** The deletes of whole records, planned by `./deletes.ts`. */
export const DELETE_OPS: readonly Op[] = ["delete-entity", "delete-place"];

/** The backfill of split and separate ledger rows, planned by `./ledger.ts`. */
export const LEDGER_OPS: readonly Op[] = ["record-split", "record-separate"];

/** An attribute column: `attr_<key>` on a link, `a_attr_<key>` or `b_attr_<key>` on a relation side. */
export const ATTRIBUTE_COLUMN = /^(a_|b_)?attr_([a-z][a-z0-9_]*)$/;

export const FUNCTION_OPS: readonly Op[] = ["keep-function", "move-function", "copy-function", "delete-function", "rename-function"];

/** Columns read and never written. */
export const REVIEWER_COLUMNS = ["rule", "evidence", "flag"] as const;

const FIELD_UPDATE = ["current_name", "current_dates", "current_function", ...RECORD_FIELDS, "gender", "name_variants_add", "name_variants_remove"];

/** A new record's fields. */
export const CREATE_FIELDS = [
  "new_key", "display_name", "sort_name", "surname", "given_name", "entity_type", "gender", "qualified_name", "known_only_from_relation",
] as const;
/** A link's fields, beside its attributes; a relation side has them under `a_` and `b_`. */
export const LINK_FIELDS = ["entity", "role", "name_as_recorded", "role_raw", "honorific", "role_note", "sequence", "certainty"] as const;
const SIDE_FIELDS = ["a_", "b_"].flatMap((p) => LINK_FIELDS.map((f) => `${p}${f}`));

/** A place's fields, as a create or an update gives them. */
export const PLACE_FIELDS = [
  "label", "display_name", "place_type", "parent", "latitude", "longitude", "coordinate_precision", "tgn_id", "hgis_id", "whg_id", "fclass", "notes",
] as const;
/** The stored value of each place field an update gives, `label` aside (`authority_name` names it). */
export const PLACE_CURRENT = PLACE_FIELDS.filter((f) => f !== "label").map((f) => `current_${f}`);
/** The fields of a document link or relation side that `update-link` may change, beside its role (`new_role`). */
export const LINK_UPDATE_FIELDS = ["role_note", "role_raw", "honorific", "name_as_recorded", "sequence"] as const;
/** The stored value of each link field an `update-link` row gives; the stored role is `role`, which names the link. */
export const LINK_CURRENT = LINK_UPDATE_FIELDS.map((f) => `current_${f}`);
/** The values a place merge carries into an empty field of the survivor. */
export const PLACE_CARRIED = ["tgn_id", "hgis_id", "whg_id", "latitude", "longitude", "coordinate_precision"] as const;

/** The evidence a `merge-entity` row carries: its facts and the reference codes of the descriptions that show them. */
export const MERGE_EVIDENCE_COLUMNS = ["facts", "evidence_codes"] as const;

/** The columns each operation may fill, beside `authority_code`, `authority_name` and `changelog_note`. */
export const OP_COLUMNS: Record<Op, readonly string[]> = {
  "keep-function": ["function_id", "function"],
  "move-function": ["function_id", "function", "target_codes"],
  "copy-function": ["function_id", "function", "target_codes"],
  "delete-function": ["function_id", "function"],
  "rename-function": ["function_id", "function", "new_function", "new_honorific"],
  "update-entity": FIELD_UPDATE,
  "merge-entity": ["target_codes", "label_to_keep", "name_variants_add", "name_variants_remove", ...MERGE_EVIDENCE_COLUMNS],
  "cover-functions": [],
  "create-entity": CREATE_FIELDS,
  "add-link": ["description_code", ...LINK_FIELDS.filter((f) => f !== "certainty")],
  "add-place-link": ["description_code", "place", "role", "role_note"],
  "add-relation": ["description_code", ...SIDE_FIELDS],
  "create-place": ["new_key", ...PLACE_FIELDS, "name_variants_add"],
  "update-place": [...PLACE_FIELDS, ...PLACE_CURRENT, "name_variants_add", "name_variants_remove"],
  "merge-place": ["target_codes", "label_to_keep", "name_variants_add", "name_variants_remove", ...PLACE_CARRIED],
  "move-place-link": ["description_code", "role", "target_codes"],
  "drop-place-link": ["description_code", "role"],
  "move-link": ["description_code", "role", "target_codes"],
  "drop-link": ["description_code", "role"],
  "update-link": ["description_code", "role", "new_role", ...LINK_UPDATE_FIELDS, ...LINK_CURRENT],
  "drop-relation": ["description_code", "a_entity", "a_role", "b_entity", "b_role"],
  "delete-entity": [],
  "delete-place": [],
  "record-split": ["target_codes"],
  "record-separate": ["target_codes"],
};

/** The columns the operations that act on an existing record require. */
export const REQUIRED_COLUMNS = ["op", "authority_code", "authority_name"] as const;

export const CHANGE_COLUMNS = [
  ...new Set([
    ...REQUIRED_COLUMNS, "function_id", "function", "new_function", "new_honorific", "target_codes", "label_to_keep", ...FIELD_UPDATE, ...CREATE_FIELDS,
    "description_code", "place", ...LINK_FIELDS, ...SIDE_FIELDS, ...PLACE_FIELDS, ...PLACE_CURRENT, "new_role", ...LINK_CURRENT, ...MERGE_EVIDENCE_COLUMNS, "changelog_note",
    ...REVIEWER_COLUMNS,
  ]),
] as readonly string[];

export interface ChangeRow {
  /** The file's name, without its folder. */
  file: string;
  /** The row's line, counting the header as 1. */
  line: number;
  /** Every column of `CHANGE_COLUMNS`, and each attribute column of the header, trimmed; '' where the file leaves it out or blank. */
  cells: Record<string, string>;
}

/** Reads the change file: one row per operation. */
export function parseChangeFile(text: string, file: string): ChangeRow[] {
  let parsed;
  try {
    parsed = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    if (err instanceof CsvParseError) throw new AuthoritiesStop(`${file} is not readable as CSV: ${err.message}`);
    throw err;
  }
  const columns = CHANGE_COLUMNS;
  const header = parsed.headers.map((h) => h.trim());
  // Which operations the file holds decides which columns it requires.
  const opAt = header.indexOf("op");
  const acting = opAt >= 0 && parsed.rows.some((raw) => {
    const op = (raw[opAt] ?? "").trim();
    return op !== "" && !(KEYED_OPS as readonly string[]).includes(op);
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c) && (c === "op" || acting));
  const unknown = header.filter((h) => !columns.includes(h) && !ATTRIBUTE_COLUMN.test(h));
  const repeated = header.filter((h, i) => header.indexOf(h) !== i);
  if (missing.length || unknown.length || repeated.length) {
    throw new AuthoritiesStop(
      `${file} is refused whole: ` +
        [
          missing.length ? `missing columns ${missing.join(", ")}` : "",
          unknown.length ? `unknown columns ${unknown.join(", ")}` : "",
          repeated.length ? `repeated columns ${repeated.join(", ")}` : "",
        ].filter(Boolean).join("; "),
    );
  }
  const rows: ChangeRow[] = [];
  const problems: string[] = [];
  parsed.rows.forEach((raw, i) => {
    const line = i + 2;
    if (raw.every((v) => v.trim() === "")) return;
    if (raw.length !== header.length) {
      problems.push(`line ${line}: ${raw.length} fields, not ${header.length}`);
      return;
    }
    const cells = Object.fromEntries([...columns.map((c) => [c, ""]), ...header.map((h, k) => [h, raw[k].trim()])]);
    rows.push({ file, line, cells });
  });
  if (problems.length > 0) throw new AuthoritiesStop(`${file} is refused whole: ${problems.join("; ")}`);
  return rows;
}

/** The codes of `target_codes`, separated by spaces. */
export const targetCodes = (row: ChangeRow) => row.cells.target_codes.split(/\s+/).filter(Boolean);

/** A space-separated list: the facts or the evidence codes of a merge row. */
export const spacedList = (value: string) => value.split(/\s+/).filter(Boolean);

/** Variants separated by " | ". */
export const variantList = (value: string) => value.split(" | ").map((v) => v.trim()).filter(Boolean);

// @version v0.9.0
