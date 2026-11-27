/**
 * Scripts — the change file of the command line's descriptions
 *
 * This module reads the file `scripts/fisqua.ts descriptions` takes: one
 * CSV, one row per operation, applied whole or not at all. Five
 * operations, named in `op`:
 *
 *   update-field        one field of one description changed: the
 *                       columns `fisqua_id`, `reference_code`, `field`,
 *                       `current_value` and `new_value`. A blank or
 *                       absent `op` stands for it, so a file of field
 *                       updates written before `create-description` reads
 *                       as it did. `field` is one of `UPDATE_FIELDS`: the
 *                       editor's fields (`FIELDS`) and the digital flag,
 *                       `has_digital`, whose `current_value` and
 *                       `new_value` are written `0` or `1`.
 *   create-description  one new description: `reference_code`,
 *                       `parent_code`, `description_level`, `after`,
 *                       `is_published` (`0`, `1` or blank for 0) and a
 *                       column for each of `FIELDS` but `repository_id`,
 *                       by its `descriptions` column name
 *                       (`local_identifier`, `title`, `scope_content`,
 *                       `date_start`, …). The repository is always the
 *                       parent's, so a `repository_id` column is unknown
 *                       and refuses the file whole.
 *   set-images          a description given its own image manifest:
 *                       `reference_code`, `images` (the image files in
 *                       reading order, space-separated) and
 *                       `source_manifest` (the published manifests they
 *                       are taken from, space-separated), with
 *                       `first_image`, `last_image` and `n_images` as
 *                       checks of `images`.
 *   add-former-code     a former reference code recorded on a
 *                       description: `reference_code`, `former_code`.
 *   delete-description  a description deleted because it was joined into
 *                       another: `reference_code`, `merged_into` (the
 *                       code of the description it was joined into).
 *
 * Each operation fills only its own columns (`OP_COLUMNS`) besides
 * `op`, `reference_code` and the note and reviewer columns; `./plan.ts`
 * refuses a row that fills another operation's.
 *
 * `changelog_note` is the note of the record's changelog row; `rule` and
 * `evidence` are for the reviewer, read and never written. The columns an
 * operation needs (`REQUIRED_UPDATE_COLUMNS` and the other `REQUIRED_*`)
 * must be in the header when a row of that operation is in the file; a
 * column not named here refuses the file whole.
 *
 * `current_value` and `new_value` are whole field values and are kept
 * exactly as the file has them, spaces at either end included; every
 * other cell is trimmed, as the editor's forms trim what they store.
 *
 * @version v0.9.0
 */

import { getTableColumns } from "drizzle-orm";
import { descriptions } from "../../../app/db/schema";
import { parseCsv, CsvParseError } from "../../../app/lib/import/csv";

/** A problem that stops the whole run before anything is written. */
export class DescriptionsStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptionsStop";
  }
}

export const OPS = ["update-field", "create-description", "set-images", "add-former-code", "delete-description"] as const;
export type Op = (typeof OPS)[number];

/** The operation a row's `op` names; blank is `update-field`. */
export const opOf = (cells: Record<string, string>): string => cells.op || "update-field";

/**
 * The description editor's fields, by the keys its save and changelog use,
 * in the order of its update action's `UPDATE_FORM_FIELDS`
 * (`app/routes/_auth.admin.descriptions.$id.tsx`), which a changelog diff
 * of several fields follows. The level and the digital flag, which that
 * action handles apart, are not among them, and neither is the reference
 * code, which it never writes.
 */
const EDITOR_FIELD_KEYS = [
  "title", "localIdentifier", "repositoryId", "translatedTitle", "uniformTitle", "resourceType", "genre", "dateExpression",
  "dateStart", "dateEnd", "dateCertainty", "extent", "dimensions", "medium", "provenance", "scopeContent", "arrangement",
  "accessConditions", "reproductionConditions", "language", "locationOfOriginals", "locationOfCopies", "findingAids", "notes",
  "internalNotes", "imprint", "editionStatement", "seriesStatement", "volumeNumber", "issueNumber", "pages", "sectionTitle",
  "publicationTitle", "adminBiogHistory", "acquisitionInfo", "preferredCitation", "systemOfArrangement",
  "physicalCharacteristics", "creatorDisplay", "iiifManifestUrl",
] as const;

/**
 * The flags an `update-field` row may change besides the editor form's
 * fields: boolean columns, written `0` or `1` in the file. They are kept
 * out of `EDITOR_FIELD_KEYS`, which follows the editor form and gives a
 * create its columns; a create takes the digital flag from a `set-images`
 * row of the file only.
 */
const FLAG_FIELD_KEYS = ["hasDigital"] as const;

export interface FieldSpec {
  /** The file's name for the field: the `descriptions` column. */
  field: string;
  /** The `descriptions` column. */
  column: string;
  /** The key the editor's form and changelog use. */
  key: string;
  /** A flag: written `0` or `1` in the file, stored 0 or 1, and a boolean in the changelog's diff. */
  flag?: true;
}

const SCHEMA_COLUMNS = getTableColumns(descriptions) as Record<string, { name: string }>;

/** The fields a row may change or a create may set. */
export const FIELDS: readonly FieldSpec[] = EDITOR_FIELD_KEYS.map((key) => {
  const column = SCHEMA_COLUMNS[key].name;
  return { field: column, column, key };
});

/** The flags a row may change (`FLAG_FIELD_KEYS`). */
export const FLAG_FIELDS: readonly FieldSpec[] = FLAG_FIELD_KEYS.map((key) => {
  const column = SCHEMA_COLUMNS[key].name;
  return { field: column, column, key, flag: true };
});

/** The values a flag is written as in the file. */
export const FLAG_VALUES = ["0", "1"] as const;

/** The fields an `update-field` row may change: the editor's, then the flags. */
export const UPDATE_FIELDS: readonly FieldSpec[] = [...FIELDS, ...FLAG_FIELDS];

export const fieldSpec = (field: string): FieldSpec | undefined => UPDATE_FIELDS.find((f) => f.field === field);

export const REQUIRED_UPDATE_COLUMNS = ["fisqua_id", "reference_code", "field", "current_value", "new_value"] as const;
export const REQUIRED_CREATE_COLUMNS = ["op", "reference_code", "parent_code", "description_level"] as const;
/** The columns of `update-field` alone, blank on a create. */
export const UPDATE_ONLY_COLUMNS = ["fisqua_id", "field", "current_value", "new_value"] as const;
/** The columns of `create-description` alone, blank on an update. */
export const CREATE_ONLY_COLUMNS: readonly string[] = [
  "parent_code", "description_level", "after", "is_published", ...FIELDS.filter((f) => f.key !== "repositoryId").map((f) => f.field),
];
/** The columns of `set-images`, `add-former-code` and `delete-description`, besides `reference_code`. */
export const IMAGES_COLUMNS = ["images", "source_manifest", "first_image", "last_image", "n_images"] as const;
export const FORMER_CODE_COLUMNS = ["former_code"] as const;
export const DELETE_COLUMNS = ["merged_into"] as const;
export const REQUIRED_IMAGES_COLUMNS = ["op", "reference_code", ...IMAGES_COLUMNS] as const;
export const REQUIRED_FORMER_CODE_COLUMNS = ["op", "reference_code", ...FORMER_CODE_COLUMNS] as const;
export const REQUIRED_DELETE_COLUMNS = ["op", "reference_code", ...DELETE_COLUMNS] as const;
/** Columns read and never written. */
export const REVIEWER_COLUMNS = ["rule", "evidence"] as const;
export const CHANGE_COLUMNS: readonly string[] = [
  "op", ...REQUIRED_UPDATE_COLUMNS, ...CREATE_ONLY_COLUMNS, ...IMAGES_COLUMNS, ...FORMER_CODE_COLUMNS, ...DELETE_COLUMNS,
  "changelog_note", ...REVIEWER_COLUMNS,
];
/** The columns each operation fills besides `op`, `reference_code`, `changelog_note` and the reviewer's. */
export const OP_COLUMNS: Record<Op, readonly string[]> = {
  "update-field": ["fisqua_id", "field", "current_value", "new_value"],
  "create-description": CREATE_ONLY_COLUMNS,
  "set-images": IMAGES_COLUMNS,
  "add-former-code": FORMER_CODE_COLUMNS,
  "delete-description": DELETE_COLUMNS,
};
/** The columns an operation leaves blank: every other operation's own. */
export function foreignColumns(op: Op): string[] {
  const own = new Set(OP_COLUMNS[op]);
  return [...new Set(Object.values(OP_COLUMNS).flat())].filter((c) => !own.has(c));
}
/** Columns kept as written. */
const VERBATIM = new Set(["current_value", "new_value"]);

export interface DescriptionChangeRow {
  /** The file's name, without its folder. */
  file: string;
  /** The row's line, counting the header as 1 (the file's line when no value holds a line break). */
  line: number;
  /** Every column of `CHANGE_COLUMNS`; '' where the file leaves it out or blank. */
  cells: Record<string, string>;
}

/** The refusal of a row whose effect is partly present: the file changed after it was applied. */
export const changedSince = (r: DescriptionChangeRow, detail: string) =>
  `line ${r.line} was applied before and has changed since: put new changes in a new file (${detail})`;

/** Reads the change file: one row per operation. */
export function parseDescriptionChangeFile(text: string, file: string): DescriptionChangeRow[] {
  let parsed;
  try {
    parsed = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    if (err instanceof CsvParseError) throw new DescriptionsStop(`${file} is not readable as CSV: ${err.message}`);
    throw err;
  }
  const columns = CHANGE_COLUMNS;
  const header = parsed.headers.map((h) => h.trim());
  const unknown = header.filter((h) => !columns.includes(h));
  const repeated = header.filter((h, i) => header.indexOf(h) !== i);
  const rows: DescriptionChangeRow[] = [];
  const problems: string[] = [];
  parsed.rows.forEach((raw, i) => {
    const line = i + 2;
    if (raw.every((v) => v.trim() === "")) return;
    if (raw.length !== header.length) {
      problems.push(`line ${line}: ${raw.length} fields, not ${header.length}`);
      return;
    }
    const cells = Object.fromEntries([
      ...columns.map((c) => [c, ""]),
      ...header.map((h, k) => [h, VERBATIM.has(h) ? raw[k] : raw[k].trim()]),
    ]);
    rows.push({ file, line, cells });
  });
  // The columns each operation in the file needs; a file without rows,
  // or without an `op` column, is read as one of field updates.
  const ops = new Set(rows.map((r) => opOf(r.cells)));
  const required = [
    ...(ops.has("update-field") || rows.length === 0 ? REQUIRED_UPDATE_COLUMNS : []),
    ...(ops.has("create-description") ? REQUIRED_CREATE_COLUMNS : []),
    ...(ops.has("set-images") ? REQUIRED_IMAGES_COLUMNS : []),
    ...(ops.has("add-former-code") ? REQUIRED_FORMER_CODE_COLUMNS : []),
    ...(ops.has("delete-description") ? REQUIRED_DELETE_COLUMNS : []),
  ];
  const missing = [...new Set(required)].filter((c) => !header.includes(c));
  if (missing.length || unknown.length || repeated.length) {
    throw new DescriptionsStop(
      `${file} is refused whole: ` +
        [
          missing.length ? `missing columns ${missing.join(", ")}` : "",
          unknown.length ? `unknown columns ${unknown.join(", ")}` : "",
          repeated.length ? `repeated columns ${repeated.join(", ")}` : "",
        ].filter(Boolean).join("; "),
    );
  }
  if (problems.length > 0) throw new DescriptionsStop(`${file} is refused whole: ${problems.join("; ")}`);
  return rows;
}

// @version v0.9.0
