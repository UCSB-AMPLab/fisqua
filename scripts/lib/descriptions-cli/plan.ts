/**
 * Scripts — reading and planning the command line's descriptions
 *
 * This module reads what a change file (`./change-file.ts`) needs from
 * the target D1 and plans every row against it; `./statements.ts` turns
 * the plan into SQL and `./run.ts` runs it. Any refusal stops the run
 * before anything is written. Refusals are reported in the order of the
 * file's lines.
 *
 * ## update-field
 *
 * The description. A row names it by `fisqua_id`, an id of the acting
 * user's tenant; `reference_code`, when also given, must be that
 * record's code. A row with a blank `fisqua_id` names it by
 * `reference_code` alone, which names at most one description of the
 * tenant (codes are unique within a tenant). A row naming neither is
 * refused. A record and field named by two rows are refused, and so is a
 * row that fills a column of `create-description` or of another
 * operation.
 *
 * The field is one of `UPDATE_FIELDS`: every field of the description
 * editor's save but the level and the digital flag (`FIELDS`), and the
 * digital flag, `has_digital`. A flag's `current_value` and `new_value`
 * are each `0` or `1` (`FLAG_VALUES`); any other value, blank included,
 * is refused before the description is looked up. A flag is compared and
 * written as the column holds it (0 or 1, so a stored NULL is not `0`),
 * and its changelog entry is a boolean, as the editor's diff has it. A
 * flag takes none of the editor's checks of a field's value. A row on
 * `has_digital` is refused when a `set-images` row of the file gives the
 * same record images, which set the flag themselves.
 *
 * The comparison. `current_value` is the whole stored field and must
 * equal it exactly: no trimming, no Unicode normalisation, case and
 * spacing as stored. An empty `current_value` matches a stored NULL or
 * ''. The one allowance is line endings: when the stored value holds a
 * line break `\n` and no `\r`, a `\r\n` in `current_value` and in
 * `new_value` reads as `\n` (a spreadsheet may write `\r\n` inside a
 * quoted cell). A row whose `current_value` does not hold is refused;
 * the refusal says when the two would match after Unicode normalisation
 * (NFC) or after trimming and collapsing whitespace, and the report
 * counts those rows as near misses, without letting them pass.
 *
 * The new value. `new_value` is the whole new field. The editor's save
 * trims what it stores, so a `new_value` with spaces at either end is
 * refused rather than trimmed here. A `new_value` holding U+FFFD or NUL
 * is refused: either is what a file read in the wrong encoding leaves.
 * A blank `new_value` clears the field, which the editor stores as NULL
 * (`genre` as its empty list, `[]`); `title` cannot be blank. The value
 * passes the editor's own checks for the field
 * (`app/routes/_auth.admin.descriptions.$id.tsx`, `update`): required at
 * the record's level by the tenant's descriptive standard
 * (`requiredFieldsForLevel`), and the field's schema in
 * `app/lib/validation/description.ts` (a title of 1 to 2000 characters,
 * a date bound as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, a resource type of
 * the list, a manifest URL), and a date bound must be a month or day of
 * the calendar (`isCalendarDate`). A `repository_id` must be a repository of
 * the tenant. A `date_start` after the `date_end` the record will hold
 * (stored, or given by another row of the file), or a `date_end` before
 * the start, is refused; the two are separate fields and neither is
 * derived from the other or from `date_expression`. Of the editor's
 * checks, only those on the fields the file changes are applied: the
 * editor also refuses a save when another required field of the record
 * is blank, which is not this file's to fix. A value the record already
 * holds is not a write, so none of these checks applies to it: its row is
 * "same" or "already updated" (below), even when the stored value is a
 * blank the standard requires to be filled.
 *
 * Done, same, to write. A row whose stored value already is `new_value`
 * is "already updated" only on evidence: the changelog row this file
 * writes for the record (`descriptionJournalId`, made from the tenant,
 * the file's name and the record) exists, names the record, and records
 * the field going from `current_value` (compared as above) to exactly
 * `new_value`. When there is no such changelog row, or the row records
 * other fields of the record and not this one (the field already held
 * its new value when the file was applied), the row is "same": nothing
 * to write, and not a refusal. When the row records this field with
 * another old or new value, or names another record, or its diff is not
 * readable, the row is refused: the file's own record of what it did
 * contradicts the row. Every
 * other row whose `current_value` holds is "update". A record to update
 * whose changelog row of this file already exists is refused as a row
 * changed since it was applied (below): a file is known by its name, and
 * its one changelog row per record is written once.
 *
 * ## create-description
 *
 * The parent, `parent_code`, is a description of the tenant, or a
 * description another row of the file creates; a blank one is refused.
 * The level is one `isValidChildLevel` allows under the parent's. The
 * code matches the reference-code pattern (`REFERENCE_CODE_PATTERN`, as
 * the promote checks it), starts with the parent's code and `-`, and is
 * created by one row only. The repository is the parent's. A blank
 * `local_identifier` is the parent's followed by the part of the code
 * after the parent's (`childLocalIdentifier`), and NULL when the parent
 * has none. Every other field is
 * the row's value or absent (NULL; `genre` its default `[]`), and the
 * record as created passes the editor's create checks: the fields the
 * tenant's standard requires at the level, then each field's schema
 * (`descriptionValidatorFor`). A date bound that is not a month or day
 * of the calendar (`isCalendarDate`: month 1 to 12, the day within its
 * month, 29 February in leap years only, Julian before 1583 and
 * Gregorian from 1583) is refused, and then a
 * `date_start` after the `date_end`: the earliest day the start can name is after the latest day
 * the end can name. `is_published` is `0`, `1` or blank (unpublished,
 * as the editor creates). A row that fills a column of `update-field`,
 * or of another operation, is refused.
 * A row whose `parent_code` or `after` is its own code is refused, and
 * so is a create under a parent that an `update-field` row of the same
 * file changes on `repository_id` or `local_identifier`: the create
 * takes those from the parent as read, so the two go in separate files.
 *
 * A created record is named by its code: a later row, or an earlier one,
 * may give it as `parent_code` or `after`. The rows are planned parents
 * and `after` siblings first, in the order of the file otherwise; rows
 * that depend on themselves through those columns are refused, and so is
 * a row whose parent or `after` is a refused row.
 *
 * Positions follow the parent's children as read and as the file's
 * earlier creates leave them. A blank `after` puts the record last: its
 * position is the number of the parent's children or one past the
 * highest position among them, whichever is greater, so it never shares a
 * position with a child. `after` names a child of the same parent, as read
 * or created by the file; the record takes the position after it, and
 * every child whose position is after that sibling's moves down one.
 *
 * Done. The record's id and its changelog row's id are made from the
 * tenant, the file's name and the code (`descriptionCreateId`,
 * `descriptionCreateJournalId`). A code the tenant already holds is
 * "already created" only when this file's create changelog row exists,
 * names that record, is of kind `create`, and records the values the row
 * gives: parent, repository, level, code, local identifier, publication
 * and every field; and the `after` the row gives, as written, blank
 * included, is the one the changelog row records (under the diff key
 * `after`, which `./statements.ts` writes). Nothing about the record's
 * position now is read: a reorder made since does not change what the
 * rerun reports. Otherwise the row is refused, as is a create whose id
 * a description already holds or whose changelog row exists without the
 * record.
 *
 * A code a `set-images` row of the file gives images takes, at its
 * create, the address `{manifest_base_url}/iiif/{code}/manifest.json`
 * among its fields and the digital flag, and both are among the values
 * the create's changelog row records.
 *
 * ## set-images, add-former-code, delete-description
 *
 * Planned in `./images.ts`, once the field updates and the creates are
 * planned: a manifest is built from the fields as the file leaves them,
 * and a create, a delete or a former code of one row is seen by the
 * others.
 *
 * ## The rerun contract
 *
 * A file is applied whole or not at all, so a run of the same file
 * again finds every row done ("already updated", "already created") or
 * "same", and writes nothing. A file in which some rows are done and
 * others would write is a file applied before and changed since: it is
 * refused whole ("this file was applied before and has changed since:
 * put new changes in a new file"), naming the first done line and the
 * first pending line, and its new changes belong in a new file. The
 * same holds inside a row: an `update-field` row that would write on a
 * record whose changelog row of this file already exists is refused
 * with the same message, naming the row. A row's own evidence of being
 * done (this file's changelog rows) is therefore never weighed against
 * new work in the same file.
 *
 * ## Reads
 *
 * One snapshot per description. The codes of rows without a `fisqua_id`,
 * the parents and the codes to create are first turned into ids by a
 * lookup that reads the id alone; then every description the file names
 * is read once, by id, with the columns `READ`, and every row of a
 * description is checked against that one snapshot, which the SQL file's
 * opening guards then hold it to. D1 returns at most 100 result columns
 * and `typed` reads two per column, so `READ` is read in groups of
 * columns (`readGroups`), each with the id, and joined on it; a change
 * landing between two groups leaves a snapshot no stored row matches, and
 * the guards, which hold every column to the value read, abort the file. A code whose description no
 * longer holds it in that snapshot changed between the two reads, and
 * its rows are refused ("plan again"). The children of every parent a
 * row creates under are read with the columns `CHILD_READ`; a child the
 * file also writes by another of its reads must agree with it on its
 * version, or the row is refused. Besides: the tenant's descriptive
 * standard; the repositories update-field rows name; the descriptions
 * holding an id the file would create; this file's changelog rows; the
 * descriptions' autosaved drafts, which are reported and left as they
 * are. The codes of `set-images`, `add-former-code` and
 * `delete-description` rows and the survivors a delete names are looked
 * up with the others, and the parents of the descriptions to delete are
 * read by id as well; `readOpsState` (`./images.ts`) reads the rest.
 *
 * @version v0.9.0
 */

import { getTableColumns } from "drizzle-orm";
import { descriptions } from "../../../app/db/schema";
import { isValidChildLevel } from "../../../app/lib/description-levels";
import { getStandardConfig } from "../../../app/lib/standards/registry";
import type { DescriptionLevel, Standard } from "../../../app/lib/standards/types";
import { descriptionValidatorFor } from "../../../app/lib/standards/validator-factory";
import { descriptionSchema } from "../../../app/lib/validation/description";
import { DESCRIPTION_LEVELS } from "../../../app/lib/validation/enums";
import { newRecordId, type RowReader } from "../authority-links";
import { chunks, idList, storedValue, typed } from "../authority-merges";
import { MAX_PATH_CACHE_LENGTH } from "../../../app/lib/import/commit.server";
import { manifestUrl } from "../../../app/lib/pipeline/manifest-inputs";
import { escapeSql } from "../sql";
import {
  CREATE_ONLY_COLUMNS,
  FIELDS,
  FLAG_VALUES,
  OPS,
  UPDATE_ONLY_COLUMNS,
  changedSince,
  fieldSpec,
  foreignColumns,
  opOf,
  type DescriptionChangeRow,
  type FieldSpec,
  type Op,
} from "./change-file";
import {
  IMAGE_OPS,
  opCodes,
  planOps,
  readOpsState,
  type DeletePlan,
  type FetchManifest,
  type ImagesPlan,
  type OpsPlan,
  type OpsState,
} from "./images";
import { appendAll, maxOf } from "../arrays";

export { changedSince };

/** The namespace of the ids of the changelog rows a file writes. */
export const JOURNAL_ID_NAMESPACE = "description-field-journal";
/** The namespaces of the ids of a created description and of its create changelog row. */
export const CREATE_ID_NAMESPACE = "description-create-record";
export const CREATE_JOURNAL_ID_NAMESPACE = "description-create-journal";

/**
 * The id of the changelog row a file writes for one description: made
 * from the tenant, the file's name and the description (`newRecordId`,
 * in its own namespace; a description belongs to a tenant, so the
 * federation part is empty), so a run of the same file made again finds
 * it.
 */
export function descriptionJournalId(tenantId: string, file: string, descriptionId: string): Promise<string> {
  return newRecordId("", tenantId, file, descriptionId, JOURNAL_ID_NAMESPACE);
}

/** The id of the description a file creates under a code. */
export function descriptionCreateId(tenantId: string, file: string, code: string): Promise<string> {
  return newRecordId("", tenantId, file, code, CREATE_ID_NAMESPACE);
}

/** The id of the `create` changelog row a file writes for the description it creates under a code. */
export function descriptionCreateJournalId(tenantId: string, file: string, code: string): Promise<string> {
  return newRecordId("", tenantId, file, code, CREATE_JOURNAL_ID_NAMESPACE);
}

/**
 * Where a record created under `parent` sits, as the description editor's
 * create computes it: one level below the parent, under the parent's
 * root, its path the parent's path (or id) and its own id. A path longer
 * than the import's `MAX_PATH_CACHE_LENGTH` is stored empty, as the
 * import stores it.
 */
export function createdStructure(parent: { id: string; depth: number; rootDescriptionId: string | null; pathCache: string | null }, id: string) {
  const path = `${parent.pathCache || parent.id}/${id}`;
  return {
    depth: parent.depth + 1,
    rootDescriptionId: parent.rootDescriptionId || parent.id,
    pathCache: path.length > MAX_PATH_CACHE_LENGTH ? "" : path,
  };
}

/**
 * The local identifier a child takes by the convention its parent's
 * children follow: the parent's local identifier and the part of the
 * child's code after the parent's. Null when the code is not under the
 * parent's or the parent has no local identifier.
 */
export function childLocalIdentifier(parentCode: string, parentLocal: string | null, code: string): string | null {
  if (!parentLocal || !code.startsWith(`${parentCode}-`)) return null;
  return parentLocal + code.slice(parentCode.length);
}

/** Reference code validation, as the promote checks it (`app/lib/promote/promote.server.ts`). */
export const REFERENCE_CODE_PATTERN = /^[\p{L}\p{N}-]{1,50}$/u;

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

/** The description columns read, and guarded as read. */
export const READ = [
  "id", "tenant_id", "reference_code", "description_level", "updated_at", "updated_by", "parent_id", "position", "depth",
  "child_count", "root_description_id", "path_cache", ...FIELDS.map((f) => f.column), "has_digital", "legacy_ids",
] as const;
/** The columns read of the children of a parent a row creates under, and guarded as read. */
export const CHILD_READ = ["id", "tenant_id", "reference_code", "parent_id", "position", "child_count", "updated_at"] as const;

export type StoredDescription = Record<string, string | number | null>;

export interface Journaled {
  recordId: string;
  recordType: string;
  kind: string;
  diff: Record<string, { old: unknown; new: unknown }> | null;
}

export interface DescriptionsState {
  tenantId: string;
  tenantSlug: string;
  /** The tenant's descriptive standard, as read. */
  standard: string | null;
  /** Every description the file names, read once, by id: one snapshot per description. */
  byId: Map<string, StoredDescription>;
  /** The codes looked up (rows without an id, parents, codes to create), each to its description's snapshot in `byId`. */
  byCode: Map<string, StoredDescription>;
  /** Codes whose description did not hold them when it was read by id: they changed between the two reads. */
  unsettledCodes: Set<string>;
  /** For each description read: the id of this file's changelog row. */
  journalIds: Map<string, string>;
  /** Of this file's changelog rows (updates and creates), those the changelog holds, by id. */
  journalFound: Map<string, Journaled>;
  /** Autosaved drafts of the descriptions read, by description. */
  drafts: Map<string, { userId: string; updatedAt: number }>;
  /** The children of each parent a row creates under, by the parent's id, in position order. */
  children: Map<string, StoredDescription[]>;
  /** For each code to create: the record's id and its changelog row's id. */
  createIds: Map<string, { id: string; journalId: string }>;
  /** Descriptions, of any tenant, holding an id the file would create. */
  idsTaken: Map<string, StoredDescription>;
  /** The tenant's repositories update-field rows name, by id. */
  repositories: Map<string, StoredDescription>;
  /** What set-images, add-former-code and delete-description rows need (`./images.ts`); null when the file has none. */
  ops: OpsState | null;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const blank = (v: unknown) => v === null || v === undefined || v === "";

function stored(r: Record<string, unknown>, columns: readonly string[] = READ): StoredDescription {
  return Object.fromEntries(columns.map((c) => [c, storedValue(r, c)]));
}

/** Most result columns D1 returns for one statement. */
export const D1_MAX_RESULT_COLUMNS = 100;

/**
 * The columns split into groups that each read, with `typed`, within D1's result-column limit; the id leads
 * every group, so the groups join on it.
 */
export function readGroups(columns: readonly string[]): string[][] {
  const rest = columns.filter((c) => c !== "id");
  const perGroup = Math.floor(D1_MAX_RESULT_COLUMNS / 2) - 1;
  const groups: string[][] = [];
  for (let i = 0; i < rest.length; i += perGroup) groups.push(["id", ...rest.slice(i, i + perGroup)]);
  return groups.length > 0 ? groups : [["id"]];
}

async function readIn(rows: RowReader, values: string[], query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(values)].filter(Boolean), 100)) if (part.length > 0) appendAll(out, await rows(query(idList(part))));
  return out;
}

const isCreate = (r: DescriptionChangeRow) => opOf(r.cells) === "create-description";
const isUpdate = (r: DescriptionChangeRow) => opOf(r.cells) === "update-field";

/** Everything planning needs, read from the target. */
export async function readDescriptionsState(
  rows: RowReader,
  input: { file: string; rows: DescriptionChangeRow[] },
  scope: { tenantId: string; tenantSlug: string },
  options: { fetchManifest?: FetchManifest; bust?: string | null; stop?: (message: string) => Error } = {},
): Promise<DescriptionsState> {
  const T = escapeSql(scope.tenantId);
  const [t] = await rows(`SELECT descriptive_standard FROM tenants WHERE id = ${T}`);
  const updates = input.rows.filter(isUpdate);
  const creates = input.rows.filter(isCreate);
  // The codes to ids: the id alone, nothing else.
  const codeIds = new Map<string, string>();
  const lookedUp = [
    ...updates.filter((x) => !x.cells.fisqua_id).map((x) => x.cells.reference_code),
    ...creates.flatMap((x) => [x.cells.reference_code, x.cells.parent_code]),
    ...opCodes(input.rows),
  ];
  for (const r of await readIn(rows, lookedUp, (p) => `SELECT id, reference_code FROM descriptions WHERE tenant_id = ${T} AND reference_code IN (${p})`)) {
    codeIds.set(text(r.reference_code), text(r.id));
  }
  // Every description, once, by id: the one snapshot each of its rows is planned and guarded against.
  // D1 returns at most 100 columns, and `typed` reads two per column, so the columns are read in groups,
  // each with the id, and joined on it: one snapshot per description all the same.
  const byId = new Map<string, StoredDescription>();
  const snapshotIds = [...updates.map((x) => x.cells.fisqua_id), ...codeIds.values()];
  const readSnapshots = async (ids: string[]) => {
    const joined = new Map<string, Record<string, unknown>>();
    for (const group of readGroups(READ)) {
      for (const r of await readIn(rows, ids, (p) => `SELECT ${typed(group)} FROM descriptions WHERE tenant_id = ${T} AND id IN (${p})`)) {
        const id = text(r.id);
        joined.set(id, { ...(joined.get(id) ?? {}), ...r });
      }
    }
    for (const r of joined.values()) {
      const d = stored(r);
      byId.set(text(d.id), d);
    }
  };
  await readSnapshots(snapshotIds);
  // The parents of the descriptions a row deletes, whose child count the delete lowers.
  const deleteParents = input.rows
    .filter((x) => opOf(x.cells) === "delete-description")
    .map((x) => byId.get(codeIds.get(x.cells.reference_code) ?? ""))
    .filter((d): d is StoredDescription => !!d && !blank(d.parent_id))
    .map((d) => text(d.parent_id))
    .filter((id) => !byId.has(id));
  if (deleteParents.length > 0) await readSnapshots(deleteParents);
  // A code resolves only when the snapshot of its id still holds it.
  const byCode = new Map<string, StoredDescription>();
  const unsettledCodes = new Set<string>();
  for (const [code, id] of codeIds) {
    const d = byId.get(id);
    if (d && text(d.reference_code) === code) byCode.set(code, d);
    else unsettledCodes.add(code);
  }
  // The children of each parent a row creates under.
  const parentIds = creates.map((x) => byCode.get(x.cells.parent_code)).filter((d): d is StoredDescription => !!d).map((d) => text(d.id));
  const children = new Map<string, StoredDescription[]>();
  for (const id of new Set(parentIds)) children.set(id, []);
  for (const r of await readIn(rows, parentIds, (p) =>
    `SELECT ${typed(CHILD_READ)} FROM descriptions WHERE tenant_id = ${T} AND parent_id IN (${p})`,
  )) {
    const c = stored(r, CHILD_READ);
    children.get(text(c.parent_id))?.push(c);
  }
  for (const list of children.values()) list.sort((a, b) => Number(a.position) - Number(b.position) || (text(a.id) < text(b.id) ? -1 : 1));
  // The ids the creates would take.
  const createIds = new Map<string, { id: string; journalId: string }>();
  for (const code of new Set(creates.map((x) => x.cells.reference_code).filter(Boolean))) {
    createIds.set(code, {
      id: await descriptionCreateId(scope.tenantId, input.file, code),
      journalId: await descriptionCreateJournalId(scope.tenantId, input.file, code),
    });
  }
  const idsTaken = new Map<string, StoredDescription>();
  for (const r of await readIn(rows, [...createIds.values()].map((c) => c.id), (p) =>
    `SELECT ${typed(["id", "tenant_id", "reference_code"])} FROM descriptions WHERE id IN (${p})`,
  )) {
    const d = stored(r, ["id", "tenant_id", "reference_code"]);
    idsTaken.set(text(d.id), d);
  }
  // What set-images, add-former-code and delete-description rows need besides.
  const hasOps = input.rows.some((x) => IMAGE_OPS.includes(opOf(x.cells) as Op));
  const ops = hasOps
    ? await readOpsState(rows, input, { tenantId: scope.tenantId, byCode, byId, createIds }, {
      fetchManifest: options.fetchManifest, bust: options.bust ?? null,
    }, options.stop ?? ((m) => new Error(m)))
    : null;
  // This file's changelog rows.
  const ids = [...byId.keys()];
  const journalIds = new Map<string, string>();
  for (const id of ids) journalIds.set(id, await descriptionJournalId(scope.tenantId, input.file, id));
  const journalFound = new Map<string, Journaled>();
  const journalsRead = [...journalIds.values(), ...[...createIds.values()].map((c) => c.journalId), ...(ops ? ops.deleteJournalIds.values() : [])];
  for (const r of await readIn(rows, journalsRead, (p) =>
    `SELECT id, record_id, record_type, kind, diff FROM changelog WHERE id IN (${p})`,
  )) {
    let diff: Journaled["diff"] = null;
    try {
      const parsed = JSON.parse(String(r.diff));
      if (parsed && typeof parsed === "object") diff = parsed;
    } catch {
      diff = null;
    }
    journalFound.set(String(r.id), { recordId: String(r.record_id), recordType: text(r.record_type), kind: text(r.kind), diff });
  }
  const drafts = new Map<string, { userId: string; updatedAt: number }>();
  for (const r of await readIn(rows, ids, (p) =>
    `SELECT record_id, user_id, updated_at FROM drafts WHERE tenant_id = ${T} AND record_type = 'description' AND record_id IN (${p})`,
  )) {
    drafts.set(text(r.record_id), { userId: text(r.user_id), updatedAt: Number(r.updated_at) });
  }
  // The repositories update-field rows name, of the tenant.
  const named = [
    ...updates.filter((x) => x.cells.field === "repository_id").map((x) => x.cells.new_value),
  ];
  const repositories = new Map<string, StoredDescription>();
  for (const r of await readIn(rows, named, (p) => `SELECT ${typed(["id", "tenant_id"])} FROM repositories WHERE tenant_id = ${T} AND id IN (${p})`)) {
    const d = stored(r, ["id", "tenant_id"]);
    repositories.set(text(d.id), d);
  }
  return {
    tenantId: scope.tenantId, tenantSlug: scope.tenantSlug, standard: t && !blank(t.descriptive_standard) ? text(t.descriptive_standard) : null,
    byId, byCode, unsettledCodes, journalIds, journalFound, drafts, children, createIds, idsTaken, repositories, ops,
  };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** A file value as compared with, and written over, `stored`: `\r\n` reads as `\n` where the stored value breaks lines with `\n` alone. */
export function asStored(value: string, stored: string | number | null): string {
  const s = text(stored);
  return s.includes("\n") && !s.includes("\r") ? value.replace(/\r\n/g, "\n") : value;
}

/** Whether the stored value is the one the file gives; an empty one matches NULL or ''. */
export function holds(stored: string | number | null, given: string): boolean {
  if (given === "") return blank(stored);
  return stored !== null && String(stored) === asStored(given, stored);
}

const collapse = (v: string) => v.replace(/\s+/g, " ").trim();

/** What a value that does not hold would match after, if anything. */
export function nearMiss(stored: string | number | null, given: string): string | null {
  const s = text(stored);
  const g = asStored(given, stored);
  if (s.normalize("NFC") === g.normalize("NFC")) return "Unicode normalisation (NFC)";
  if (collapse(s) === collapse(g)) return "trimming or collapsing whitespace";
  if (collapse(s).normalize("NFC") === collapse(g).normalize("NFC")) return "trimming, collapsing whitespace and Unicode normalisation (NFC)";
  return null;
}

/** Where two values differ, with up to `context` characters either side and the changed part in brackets. */
export function changedSpan(before: string, after: string, context = 40): { before: string; after: string } {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const lead = p > context ? `…${before.slice(p - context, p)}` : before.slice(0, p);
  const tail = (v: string) => (s > context ? `${v.slice(v.length - s, v.length - s + context)}…` : v.slice(v.length - s));
  const show = (v: string) => `${lead}[${v.slice(p, v.length - s)}]${tail(v)}`;
  return { before: show(before), after: show(after) };
}

/** A value as a refusal shows it: whole when short, its changed span against `other` when long. */
function shown(v: string | number | null, other: string | number | null, side: "before" | "after"): string {
  if (v === null) return "NULL";
  const a = text(v);
  const b = text(other);
  if (a.length <= 200 && b.length <= 200) return JSON.stringify(a);
  const span = side === "before" ? changedSpan(a, b) : changedSpan(b, a);
  return JSON.stringify(side === "before" ? span.before : span.after);
}

/** The first and last day a date bound (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) can name, as text that sorts as the days do. */
const earliest = (v: string) => (v.length === 4 ? `${v}-01-01` : v.length === 7 ? `${v}-01` : v);
const latest = (v: string) => (v.length === 4 ? `${v}-12-31` : v.length === 7 ? `${v}-31` : v);
/** Whether a start bound is after an end bound: the start's first day after the end's last. */
export const startAfterEnd = (start: string, end: string) => earliest(start) > latest(end);

/**
 * Whether a date bound of the schema's shape names a month or a day of
 * the calendar: a month from 1 to 12, a day within its month, 29
 * February only in a leap year. Documents dated before the Gregorian
 * reform are dated in the Julian calendar, so before 1583 every year
 * divisible by 4 is a leap year; from 1583 the Gregorian rule holds
 * (divisible by 4, and not by 100 unless by 400).
 */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
  if (!m) return false;
  const year = Number(m[1]);
  if (m[2] === undefined) return true;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const day = Number(m[3]);
  const leap = year < 1583 ? year % 4 === 0 : (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= days;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface Refusal {
  ref: string;
  reason: string;
}

export type RowStatus = "update" | "already updated" | "same" | "create" | "already created" | "delete" | "already deleted" | "refused";

/** The statuses that write. */
export const WRITES: readonly RowStatus[] = ["update", "create", "delete"];
/** What each writing status reads back as. */
export const DONE: Partial<Record<RowStatus, RowStatus>> = { update: "already updated", create: "already created", delete: "already deleted" };

/** A description a row creates. */
export interface CreatePlan {
  row: DescriptionChangeRow;
  code: string;
  id: string;
  journalId: string;
  /** The parent: a description read, or the plan of the row that creates it. */
  parent: { read: StoredDescription } | { created: CreatePlan };
  parentId: string;
  /** Where the record sits, as the editor's create computes it from the parent. */
  depth: number;
  rootDescriptionId: string;
  pathCache: string;
  /** The position once every row is planned. */
  position: number;
  /** The children the file creates under it. */
  childCount: number;
  repositoryId: string;
  descriptionLevel: string;
  localIdentifier: string | null;
  /** The fields the row gives, by the editor's keys, in `FIELDS` order (repository and local identifier apart); a set-images row's address among them. */
  fields: Record<string, string>;
  isPublished: boolean;
  /** Whether a set-images row of the file gives the record its images, and with them the digital flag. */
  hasDigital: boolean;
}

/** A child of a parent a row creates under, moved down by an `after`. */
export interface Move {
  id: string;
  code: string;
  from: number;
  to: number;
  read: StoredDescription;
}

export interface RowPlan {
  row: DescriptionChangeRow;
  status: RowStatus;
  /** The description, once resolved (an update's record). */
  description?: StoredDescription;
  spec?: FieldSpec;
  /** The value the field takes: the column's value after the write. */
  next?: string | null;
  /** For a refused comparison: what the values would match after. */
  nearMiss?: string;
  /** A create's record, once planned. */
  create?: CreatePlan;
  /** A set-images row's manifest, once planned. */
  images?: ImagesPlan;
  /** An add-former-code row's code, once planned. */
  formerCode?: string;
  /** A delete-description row's record, once planned. */
  deletion?: DeletePlan;
}

export interface DescriptionsPlan {
  rows: RowPlan[];
  refusals: Refusal[];
  /** The records to create, parents before children. */
  creates: CreatePlan[];
  /** The children read that move down, in the order of their parents and positions. */
  moves: Move[];
  /** For each parent read that gets new children: how many. */
  newChildren: Map<string, number>;
  /** The manifests, former codes and deletes of the file (`./images.ts`). */
  ops: OpsPlan;
}

const ref = (r: DescriptionChangeRow) => `${r.file} line ${r.line}`;

/** The editor's checks of one field's value at the record's level (module header). */
function editorErrors(spec: FieldSpec, value: string | null, level: string, standard: string): string[] {
  const required = getStandardConfig(standard as Standard).requiredFieldsForLevel(level as DescriptionLevel);
  if (blank(value) && required.includes(spec.key)) return ["field_required"];
  if (value === null) return [];
  const schema = (descriptionSchema.shape as Record<string, { optional(): { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } } }>)[spec.key];
  const parsed = schema.optional().safeParse(value);
  return parsed.success ? [] : parsed.error!.issues.map((i) => i.message);
}

const COLUMN_OF_KEY = Object.fromEntries(
  Object.entries(getTableColumns(descriptions) as Record<string, { name: string }>).map(([k, c]) => [k, c.name]),
);

/** The editor's create checks of a record's values (module header): required fields first, then each field's schema. */
function createErrors(values: Record<string, unknown>, level: string, standard: string): string[] {
  const errors = new Map<string, string[]>();
  for (const key of getStandardConfig(standard as Standard).requiredFieldsForLevel(level as DescriptionLevel)) {
    if (blank(values[key])) errors.set(key, ["field_required"]);
  }
  const parsed = descriptionValidatorFor(standard as Standard, level as DescriptionLevel).safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (errors.has(key)) continue;
      errors.set(key, [...(errors.get(key) ?? []), issue.message]);
    }
  }
  return [...errors].map(([key, messages]) => `${COLUMN_OF_KEY[key] ?? key}: ${[...new Set(messages)].join("; ")}`);
}

/** The values a create's changelog row records that a rerun compares, by the editor's keys. */
export function comparedValues(c: CreatePlan): Record<string, unknown> {
  const out: Record<string, unknown> = {
    repositoryId: c.repositoryId, parentId: c.parentId, descriptionLevel: c.descriptionLevel, referenceCode: c.code,
    localIdentifier: c.localIdentifier, isPublished: c.isPublished,
  };
  for (const f of FIELDS) if (!(f.key in out)) out[f.key] = c.fields[f.key] ?? null;
  if (c.hasDigital) out.hasDigital = true;
  return out;
}

/** Checks the file against what was read and plans every row. */
export function planDescriptions(input: { file: string; rows: DescriptionChangeRow[] }, state: DescriptionsState): DescriptionsPlan {
  const refusals: Array<Refusal & { line: number }> = [];
  const plans: RowPlan[] = [];
  const named = new Map<string, DescriptionChangeRow>();
  const standard = state.standard ?? "";
  const refuse = (r: DescriptionChangeRow, reason: string) => refusals.push({ ref: ref(r), reason, line: r.line });

  // The set-images rows by the code they give images, for an update of the digital flag on the same record.
  const imagesRowOf = new Map<string, DescriptionChangeRow>();
  for (const r of input.rows) if (opOf(r.cells) === "set-images" && !imagesRowOf.has(r.cells.reference_code)) imagesRowOf.set(r.cells.reference_code, r);

  const createRows: RowPlan[] = [];
  for (const r of input.rows) {
    const c = r.cells;
    const plan: RowPlan = { row: r, status: "refused" };
    plans.push(plan);
    const no = (reason: string) => refuse(r, reason);
    const op = opOf(c);

    if (!(OPS as readonly string[]).includes(op)) { no(`op ${JSON.stringify(c.op)} is not ${OPS.join(", ")}`); continue; }
    if (op === "create-description") { createRows.push(plan); continue; }
    if (IMAGE_OPS.includes(op as Op)) continue;

    const given = CREATE_ONLY_COLUMNS.filter((col) => c[col] !== "");
    if (given.length > 0) { no(`an update-field row leaves the create-description columns blank; this one gives ${given.join(", ")}`); continue; }
    const other = foreignColumns("update-field").filter((col) => !CREATE_ONLY_COLUMNS.includes(col) && c[col] !== "");
    if (other.length > 0) { no(`an update-field row fills only its own columns; this one gives ${other.join(", ")}`); continue; }
    const spec = fieldSpec(c.field);
    if (!spec) { no(`field ${JSON.stringify(c.field)} is not one of the editor's fields that update-field changes`); continue; }
    plan.spec = spec;
    if (spec.flag) {
      const bad = (["new_value", "current_value"] as const).find((col) => !(FLAG_VALUES as readonly string[]).includes(c[col]));
      if (bad) { no(`${spec.field} is written ${FLAG_VALUES.join(" or ")}; ${bad} is ${JSON.stringify(c[bad])}`); continue; }
    }

    // The description.
    let d: StoredDescription | undefined;
    if (c.fisqua_id) {
      d = state.byId.get(c.fisqua_id);
      if (!d) { no(`no description of ${state.tenantSlug} has the id ${c.fisqua_id}`); continue; }
      if (c.reference_code && c.reference_code !== text(d.reference_code)) {
        no(`fisqua_id ${c.fisqua_id} is ${text(d.reference_code)}, not ${c.reference_code}`);
        continue;
      }
    } else if (c.reference_code) {
      if (state.unsettledCodes.has(c.reference_code)) {
        no(`the description of reference code ${c.reference_code} changed while the plan read it; plan again`);
        continue;
      }
      d = state.byCode.get(c.reference_code);
      if (!d) { no(`no description of ${state.tenantSlug} has the reference code ${c.reference_code}`); continue; }
    } else {
      no("the row names neither fisqua_id nor reference_code");
      continue;
    }
    plan.description = d;
    const id = text(d.id);
    const code = text(d.reference_code);
    const key = `${id}|${spec.field}`;
    const twice = named.get(key);
    if (twice) { no(`${code} ${spec.field} is named again (line ${twice.line})`); continue; }
    named.set(key, r);
    const imagesRow = spec.flag ? imagesRowOf.get(code) : undefined;
    if (imagesRow) {
      no(`${code} is given images by line ${imagesRow.line}, which sets ${spec.field}; change ${spec.field} in another file`);
      continue;
    }

    // The new value, as the editor would take it.
    const storedValue = d[spec.column];
    if (c.new_value !== c.new_value.trim()) { no("new_value has leading or trailing whitespace, which the editor's save trims"); continue; }
    if (/[�\u0000]/.test(c.new_value)) {
      no("new_value holds U+FFFD (the replacement character) or NUL, the trace of a file read in the wrong encoding");
      continue;
    }
    let next = c.new_value === "" ? null : asStored(c.new_value, storedValue);
    if (next === null && spec.key === "genre") next = "[]";
    plan.next = next;

    // Done, same, or to write. An empty genre list over a stored NULL is no change, as in the editor.
    // A value the record already holds is no write, so the editor's checks below do not apply to it.
    const isNew = spec.flag
      ? holds(storedValue, next!)
      : next === null ? blank(storedValue) : storedValue === next || (spec.key === "genre" && next === "[]" && storedValue === null);
    if (isNew) {
      const journalId = state.journalIds.get(id);
      const found = journalId ? state.journalFound.get(journalId) : undefined;
      if (!found) { plan.status = "same"; continue; }
      const entry = found.recordId === id && found.diff && Object.hasOwn(found.diff, spec.key) ? found.diff[spec.key] : undefined;
      // This file's row exists but does not record this field: the field
      // already held its new value when the file was applied.
      if (found.recordId === id && found.diff && entry === undefined) { plan.status = "same"; continue; }
      const old = entry?.old ?? null;
      const recorded = entry?.new ?? null;
      // A flag's entry is a boolean either side; a field's is the value as stored.
      const recordedHolds = spec.flag
        ? old === (c.current_value === "1") && recorded === (next === "1")
        : !(typeof old === "object" && old !== null) && recorded === next && holds(old as string | null, c.current_value);
      if (!entry || !recordedHolds) {
        no(`this file's changelog row for ${code} records ${spec.field} other than from current_value to new_value`);
        continue;
      }
      plan.status = "already updated";
      continue;
    }
    const errors = spec.flag ? [] : editorErrors(spec, next, text(d.description_level), standard);
    if (errors.length > 0) { no(`${spec.field} of ${code}: the editor refuses this value (${errors.join("; ")})`); continue; }
    if ((spec.key === "dateStart" || spec.key === "dateEnd") && next !== null && !isCalendarDate(next)) {
      no(`${spec.field} of ${code}: ${next} is not a date of the calendar`);
      continue;
    }
    if (next === null && spec.field === "title") { no(`title of ${code}: a title cannot be blank`); continue; }
    if (spec.key === "repositoryId" && next !== null && !state.repositories.has(next)) {
      no(`repository_id of ${code}: ${next} is not a repository of ${state.tenantSlug}`);
      continue;
    }
    if (!holds(storedValue, c.current_value)) {
      const near = nearMiss(storedValue, c.current_value);
      if (near) plan.nearMiss = near;
      no(
        `${spec.field} of ${code} is not current_value: stored ${shown(storedValue, c.current_value, "before")}, ` +
          `current_value ${c.current_value === "" ? '""' : shown(c.current_value, storedValue, "after")}` +
          (near ? `; it would match after ${near}` : ""),
      );
      continue;
    }
    plan.status = "update";
  }

  // The date bounds a record will hold, its updates applied.
  for (const p of plans) {
    if (p.status !== "update" || (p.spec!.key !== "dateStart" && p.spec!.key !== "dateEnd")) continue;
    const d = p.description!;
    const bound = (key: "dateStart" | "dateEnd", column: string) => {
      const u = plans.find((x) => x.status === "update" && x.description === d && x.spec!.key === key);
      return u ? u.next ?? null : (d[column] as string | null);
    };
    const start = bound("dateStart", "date_start");
    const end = bound("dateEnd", "date_end");
    if (start && end && startAfterEnd(start, end)) {
      refuse(p.row, `${text(d.reference_code)}: date_start ${start} would be after date_end ${end}`);
      p.status = "refused";
    }
  }

  // A record to write whose changelog row of this file is already there: the row's effect is partly
  // present (the file was applied, and the row would write more), so it was changed since.
  for (const p of plans) {
    if (p.status !== "update") continue;
    const id = text(p.description!.id);
    if (state.journalFound.has(state.journalIds.get(id) ?? "")) {
      refuse(p.row, changedSince(p.row, `part of its effect is present: this file's changelog row for ${text(p.description!.reference_code)} is already written, and the row would write more`));
      p.status = "refused";
    }
  }

  // The parents' fields a create takes as read: an update of one in the same file is refused below.
  const inherited = new Map<string, { field: string; line: number }>();
  for (const p of plans) {
    if (p.description && p.spec && (p.spec.key === "repositoryId" || p.spec.key === "localIdentifier") && !inherited.has(text(p.description.id))) {
      inherited.set(text(p.description.id), { field: p.spec.field, line: p.row.line });
    }
  }
  // The codes a set-images row gives images: a create of one takes the address and the digital flag.
  const imagesFor = new Set(input.rows.filter((r) => opOf(r.cells) === "set-images").map((r) => r.cells.reference_code));
  const { creates, moves, newChildren } = planCreates(createRows, state, standard, refuse, inherited, imagesFor);
  const createByCode = new Map<string, RowPlan>();
  for (const p of createRows) if (p.row.cells.reference_code && !createByCode.has(p.row.cells.reference_code)) createByCode.set(p.row.cells.reference_code, p);
  const ops: OpsPlan = state.ops
    ? planOps(plans, createByCode, state, refuse)
    : { uploads: [], images: [], deletes: [], formerCodes: new Map(), lostChildren: new Map() };

  // A child the file moves, read again as a record it writes, must be the same snapshot.
  for (const m of moves) {
    const d = state.byId.get(m.id);
    if (d && d.updated_at !== m.read.updated_at) {
      const by = creates.find((c) => c.parentId === text(m.read.parent_id))!;
      refuse(by.row, `${m.code} changed while the plan read it; plan again`);
      plans.find((p) => p.row === by.row)!.status = "refused";
    }
  }

  // The rerun contract: a file applies whole, so a run of it again finds every row done. A file with
  // some rows done and others to write was applied before and has changed since: it is refused whole.
  const byLine = [...plans].sort((a, b) => a.row.line - b.row.line);
  const done = byLine.find((p) => p.status.startsWith("already"));
  const pending = byLine.find((p) => WRITES.includes(p.status));
  if (done && pending) {
    refusals.push({
      ref: input.file, line: Number.MAX_SAFE_INTEGER,
      reason: `this file was applied before and has changed since: put new changes in a new file ` +
        `(line ${done.row.line} is ${done.status}; line ${pending.row.line} would ${pending.status})`,
    });
  }

  refusals.sort((a, b) => a.line - b.line);
  return { rows: plans, refusals: refusals.map(({ ref: r, reason }) => ({ ref: r, reason })), creates, moves, newChildren, ops };
}

interface Sibling {
  code: string;
  position: number;
  read?: StoredDescription;
}

/** Plans the create rows (module header): order, checks, positions. */
function planCreates(
  rows: RowPlan[],
  state: DescriptionsState,
  standard: string,
  refuse: (r: DescriptionChangeRow, reason: string) => void,
  inherited: Map<string, { field: string; line: number }>,
  imagesFor: Set<string>,
): { creates: CreatePlan[]; moves: Move[]; newChildren: Map<string, number> } {
  const refused = new Set<RowPlan>();
  const no = (p: RowPlan, reason: string) => {
    refuse(p.row, reason);
    refused.add(p);
    p.status = "refused";
  };

  // The checks of a row alone.
  const byCode = new Map<string, RowPlan>();
  for (const p of rows) {
    const c = p.row.cells;
    const code = c.reference_code;
    const given = UPDATE_ONLY_COLUMNS.filter((col) => c[col] !== "");
    if (given.length > 0) { no(p, `a create-description row leaves fisqua_id, field, current_value and new_value blank; this one gives ${given.join(", ")}`); continue; }
    const other = foreignColumns("create-description").filter((col) => !(UPDATE_ONLY_COLUMNS as readonly string[]).includes(col) && c[col] !== "");
    if (other.length > 0) { no(p, `a create-description row fills only its own columns; this one gives ${other.join(", ")}`); continue; }
    if (!code) { no(p, "reference_code is blank"); continue; }
    const twice = byCode.get(code);
    if (twice) { no(p, `${code} is created again (line ${twice.row.line})`); continue; }
    byCode.set(code, p);
    if (c.parent_code === code) { no(p, `${code} names itself as its parent`); continue; }
    if (c.after === code) { no(p, `${code} names itself as the sibling it follows`); continue; }
    if (!REFERENCE_CODE_PATTERN.test(code)) {
      no(p, `reference code ${JSON.stringify(code)} does not match the reference-code pattern (letters, digits and hyphens, 1 to 50 characters)`);
      continue;
    }
    if (Object.entries(c).some(([k, v]) => k !== "rule" && k !== "evidence" && /[�\u0000]/.test(v))) {
      no(p, `${code}: a value holds U+FFFD (the replacement character) or NUL, the trace of a file read in the wrong encoding`);
      continue;
    }
    if (!["", "0", "1"].includes(c.is_published)) { no(p, `is_published is 0 or 1, not ${JSON.stringify(c.is_published)}`); continue; }
    if (!(DESCRIPTION_LEVELS as readonly string[]).includes(c.description_level)) {
      no(p, `description_level ${JSON.stringify(c.description_level)} is not one of ${DESCRIPTION_LEVELS.join(", ")}`);
      continue;
    }
  }

  // Parents and `after` siblings first, the file's order otherwise.
  const deps = (p: RowPlan) => [p.row.cells.parent_code, p.row.cells.after].map((c) => byCode.get(c)).filter((x): x is RowPlan => !!x && x !== p);
  const order: RowPlan[] = [];
  const done = new Set<RowPlan>();
  const onStack: RowPlan[] = [];
  const cyclic = new Set<RowPlan>();
  const visit = (p: RowPlan) => {
    if (done.has(p)) return;
    const at = onStack.indexOf(p);
    if (at >= 0) {
      for (const x of onStack.slice(at)) cyclic.add(x);
      return;
    }
    onStack.push(p);
    for (const d of deps(p)) visit(d);
    onStack.pop();
    done.add(p);
    order.push(p);
  };
  for (const p of rows) if (byCode.get(p.row.cells.reference_code) === p) visit(p);

  const siblingsOf = new Map<string, Sibling[]>();
  const siblings = (parentId: string): Sibling[] => {
    let list = siblingsOf.get(parentId);
    if (!list) {
      list = (state.children.get(parentId) ?? []).map((d) => ({ code: text(d.reference_code), position: Number(d.position), read: d }));
      siblingsOf.set(parentId, list);
    }
    return list;
  };
  const creates: CreatePlan[] = [];
  const newChildren = new Map<string, number>();
  const byPosition = new Map<CreatePlan, Sibling>();

  for (const p of order) {
    if (refused.has(p)) continue;
    const c = p.row.cells;
    const code = c.reference_code;
    if (cyclic.has(p)) { no(p, `${code} depends on itself through parent_code or after`); continue; }

    // The parent.
    const pc = c.parent_code;
    if (!pc) { no(p, "parent_code is blank: a description is created under a parent"); continue; }
    const parentRow = byCode.get(pc);
    let parent: CreatePlan["parent"];
    if (parentRow && parentRow.status !== "already created") {
      if (refused.has(parentRow)) { no(p, `the parent ${pc} is created by line ${parentRow.row.line}, which is refused`); continue; }
      parent = { created: parentRow.create! };
    } else {
      if (state.unsettledCodes.has(pc)) { no(p, `the description of reference code ${pc} changed while the plan read it; plan again`); continue; }
      const d = state.byCode.get(pc);
      if (!d) { no(p, `parent_code ${pc} is not a description of ${state.tenantSlug}`); continue; }
      parent = { read: d };
    }
    const pv = "read" in parent
      ? {
        id: text(parent.read.id), level: text(parent.read.description_level), local: parent.read.local_identifier as string | null,
        repository: text(parent.read.repository_id), depth: Number(parent.read.depth),
        root: parent.read.root_description_id as string | null, path: parent.read.path_cache as string | null,
      }
      : {
        id: parent.created.id, level: parent.created.descriptionLevel, local: parent.created.localIdentifier,
        repository: parent.created.repositoryId, depth: parent.created.depth, root: parent.created.rootDescriptionId, path: parent.created.pathCache,
      };
    const updated = inherited.get(pv.id);
    if (updated) {
      no(p, `the parent ${pc} has an update-field row on ${updated.field} in this file (line ${updated.line}), ` +
        "which a create under it would not see; put the update and the creates in separate files");
      continue;
    }
    if (!code.startsWith(`${pc}-`)) { no(p, `${code} does not start with its parent's code ${pc}-`); continue; }
    const level = c.description_level;
    if (!isValidChildLevel(pv.level, level)) { no(p, `${level} is not a level allowed under ${pc} (${pv.level})`); continue; }

    // The values, checked as the editor's create checks them.
    const ids = state.createIds.get(code)!;
    const structure = createdStructure({ id: pv.id, depth: pv.depth, rootDescriptionId: pv.root, pathCache: pv.path }, ids.id);
    const fields: Record<string, string> = {};
    for (const f of FIELDS) if (f.key !== "repositoryId" && f.key !== "localIdentifier" && c[f.field] !== "") fields[f.key] = c[f.field];
    // A set-images row gives the record its own address; the create's own iiif_manifest_url refuses that row.
    const withImages = imagesFor.has(code) && state.ops?.place != null && !fields.iiifManifestUrl;
    if (withImages) fields.iiifManifestUrl = manifestUrl(state.ops!.place!.baseUrl, code);
    const plan: CreatePlan = {
      row: p.row, code, id: ids.id, journalId: ids.journalId, parent, parentId: pv.id, depth: structure.depth,
      rootDescriptionId: structure.rootDescriptionId, pathCache: structure.pathCache, position: 0, childCount: 0,
      repositoryId: pv.repository, descriptionLevel: level,
      localIdentifier: c.local_identifier || childLocalIdentifier(pc, pv.local, code), fields, isPublished: c.is_published === "1",
      hasDigital: withImages,
    };
    const errors = createErrors(
      { referenceCode: code, descriptionLevel: level, repositoryId: plan.repositoryId, localIdentifier: plan.localIdentifier ?? undefined, ...fields },
      level, standard,
    );
    if (errors.length > 0) { no(p, `${code}: the editor refuses these values (${errors.join(", ")})`); continue; }
    const badDate = (["dateStart", "dateEnd"] as const).find((k) => fields[k] && !isCalendarDate(fields[k]));
    if (badDate) { no(p, `${code}: ${COLUMN_OF_KEY[badDate]} ${fields[badDate]} is not a date of the calendar`); continue; }
    if (fields.dateStart && fields.dateEnd && startAfterEnd(fields.dateStart, fields.dateEnd)) {
      no(p, `${code}: date_start ${fields.dateStart} is after date_end ${fields.dateEnd}`);
      continue;
    }

    // Already there: done on this file's create changelog row, or refused.
    if (state.unsettledCodes.has(code)) { no(p, `the description of reference code ${code} changed while the plan read it; plan again`); continue; }
    const existing = state.byCode.get(code);
    const journal = state.journalFound.get(ids.journalId);
    if (existing) {
      const holder = `${code} is already a description of ${state.tenantSlug} (${text(existing.id)})`;
      if (!journal) { no(p, `${holder}, not one this file created`); continue; }
      const want = comparedValues(plan);
      const differ = journal.recordId !== text(existing.id) || journal.kind !== "create" || journal.recordType !== "description" || !journal.diff
        ? ["record"]
        : Object.keys(want).filter((k) => JSON.stringify(journal.diff![k]?.new ?? null) !== JSON.stringify(want[k]));
      if (differ.length > 0) {
        no(p, `${holder}; this file's create changelog row records other values: ${differ.map((k) => COLUMN_OF_KEY[k] ?? k).join(", ")}`);
        continue;
      }
      // The order: the after the file was applied with, as written (blank
      // included); nothing about the record's position now is read.
      const recorded = journal.diff?.after?.new;
      if (recorded !== c.after) {
        no(p, `${holder}; it was created by this file with a different after (${recorded === undefined ? "none recorded" : JSON.stringify(recorded)}, not ${JSON.stringify(c.after)})`);
        continue;
      }
      p.status = "already created";
      p.create = plan;
      continue;
    }
    const taken = state.idsTaken.get(ids.id);
    if (taken) { no(p, `the id ${ids.id} this file gives ${code} is held by ${text(taken.reference_code)}`); continue; }
    if (journal) { no(p, `this file's create changelog row for ${code} is already written, but no description of ${state.tenantSlug} has the code`); continue; }

    // The position.
    const list = siblings(pv.id);
    let position = maxOf([list.length, ...list.map((x) => x.position + 1)]);
    if (c.after) {
      const s = list.find((x) => x.code === c.after);
      if (!s) {
        const afterRow = byCode.get(c.after);
        if (afterRow && refused.has(afterRow)) no(p, `after ${c.after} is created by line ${afterRow.row.line}, which is refused`);
        else no(p, `after ${c.after} is not a child of ${pc}`);
        continue;
      }
      position = s.position + 1;
      for (const x of list) if (x.position > s.position) x.position += 1;
    }
    const sibling: Sibling = { code, position };
    list.push(sibling);
    byPosition.set(plan, sibling);
    if ("created" in parent) parent.created.childCount += 1;
    else newChildren.set(pv.id, (newChildren.get(pv.id) ?? 0) + 1);
    p.status = "create";
    p.create = plan;
    creates.push(plan);
  }

  for (const [plan, s] of byPosition) plan.position = s.position;
  const moves: Move[] = [];
  for (const list of siblingsOf.values()) {
    for (const s of list) {
      if (s.read && s.position !== Number(s.read.position)) {
        moves.push({ id: text(s.read.id), code: s.code, from: Number(s.read.position), to: s.position, read: s.read });
      }
    }
  }
  return { creates, moves, newChildren };
}

/** Whether the plan writes anything. */
export function hasWrites(plan: DescriptionsPlan): boolean {
  return plan.rows.some((r) => WRITES.includes(r.status));
}

// @version v0.9.0
