/**
 * Scripts — recording capture QC decisions in bulk from a list
 *
 * This module deals with recording capture QC decisions for many
 * openings at once, from a list an operator hands over, so that each
 * opening is recorded exactly as if a reviewer had decided it on the
 * Capture QC screen. `fisqua capture qc-decisions`
 * (`scripts/lib/capture-cli/qc-decisions.ts`) plans with
 * `planQcDecisions` here, writes the report and the SQL file, applies
 * it and reads back with `verifyQcWrites`; the providers are injected,
 * so the tests run every step against a real D1 binding.
 *
 * `parseQcList` reads the list: a TSV file with a header row, or a JSON
 * array of objects with the same keys. Each row names one opening by its
 * volume's `stem` (the volume's reference code) and its `pairId`, as the
 * capture manifest gives the pair id of the opening's images, and gives
 * the `decision` (`rejected`, the default when the column is absent or
 * the cell empty, `approved`, or `excluded`, for an opening that is not
 * a page), the `side` to retake (`left`, `right` or `both` for an
 * opening with two images; `single` or empty for one with one image),
 * the `reason` (one of the contract's reason codes), the `note`, and
 * optionally the record `sequence` and the unit's record id
 * (`captua_record_id`), which are checked against Fisqua's record; the
 * opening is found by stem and pair id alone. A row may leave the pair
 * id empty only when it gives the record id, for an opening whose images
 * carry no pair id (every image's pair id NULL; an empty string is a pair
 * id); it is then found by stem and record id, and its
 * report line names it as `record <id>`. An approval takes no side,
 * reason or note, so those cells are empty on its row. An exclusion
 * takes no side or reason, as the decisions route refuses both on one,
 * and may take a note, as the route accepts one; a single and an
 * opening with two images may both be excluded. It refuses the whole
 * list, naming every problem, when a column is missing or unknown, a row
 * has the wrong number of fields, a value is not one the contract
 * allows, a decision is not `rejected`, `approved` or `excluded`, an
 * approval has a side, reason or note, an exclusion has a side or
 * reason, a rejection has no reason, a rejection for `other` has no
 * note, a note passes 2,000 characters, a pair id is empty on a row
 * without a record id, or two rows name the same stem and pair id (or,
 * without a pair id, the same stem and record id).
 *
 * `planQcDecisions` reads the tenant, checks that the decider may
 * decide there as the Capture QC screen checks it, reads each named
 * volume's current delivery and sorts every row into one outcome:
 * `decide` (the opening is undecided and the decision can be recorded),
 * `same` (an identical decision, with the same reason, side and note, is
 * already recorded, so nothing is written and the list can be run
 * again), `revise` (with `revise` only: a different decision is already
 * recorded and the row replaces it), `conflict` (without `revise`, a
 * different decision is already recorded, which is never overwritten; or
 * Fisqua's record disagrees with the row: another record id or sequence,
 * a rejection's side that does not fit the opening's images, a pair id
 * found on more than one record, a row without a pair id naming a record
 * any of whose images carries one, even an empty string, which the row
 * must then give and the detail quotes, or two rows
 * naming one opening), `missing` (no volume, current delivery or opening
 * answers the row, or a row's record id is not in the current delivery) and
 * `locked` (a pipeline run has claimed or named the volume, after which
 * no decision may be recorded). An opening is a record read as
 * `in_review` or `approved` (`isOpeningRecord`), as on the screen: a
 * placeholder (contract 1.9) closed with an image is one; an open
 * placeholder, or one closed with no image, is not, and its row is
 * `missing`. Every check but the one on a different
 * decision applies with `revise` as without it. A `revise` row's report
 * carries the decision it replaces (`before`) and names it in its
 * detail. A plan stops there. An apply refuses to write anything while
 * any row is a conflict, missing or locked.
 *
 * The write calls the Capture QC screen's own statement builder,
 * `buildDecisionStatements` in `app/lib/capture/qc.server.ts`, once per
 * volume, and renders each statement as SQL text with its values written
 * in (`renderStatement`, as the registration command does), since the
 * command applies one file with `wrangler d1 execute --file`. The
 * builder's payloads are chunked by their size as written into that
 * text (`SQL_TEXT_PAYLOAD`), apostrophes doubled, so any list the
 * checks accept fits D1's statement size. The rows
 * written are therefore the screen's rows: the delivery's decision set
 * (created with its opening count if the delivery has none), each
 * decision with its reason, side, note, decider and the set's revision,
 * and the set's recounted counts, state, `decisionsId`, `decidedAt`,
 * revision and write id, which the hold on processing, the status call
 * and the decisions endpoint read. Each volume's write carries the
 * set's revision as read (`expectedRevision`), so a decision recorded on
 * the screen between the read and the write turns that volume's
 * statements into no-ops rather than racing it. `decide` and `revise`
 * rows are written alike, so a revision recounts the set as the screen
 * does: an approval or an exclusion over a volume's only rejection takes
 * the set out of `retakes_requested`, and an exclusion is counted in
 * `excluded_count`, so a set whose every opening is approved or excluded
 * is `approved`. The builder replaces the rotations of every
 * opening it writes with the ones it is given, so each opening is given
 * the rotations `capture_qc_rotations` already holds for it, and a
 * revised opening keeps its corrections; an excluded opening is given
 * none, since the viewer's exclude drops an opening's rotations and the
 * route refuses any on an exclusion. The builder's last statement,
 * a read-back the screen answers with, is left out of the file;
 * `verifyQcWrites` instead re-reads every set by its write id and every
 * decision written, and a volume is verified when its set carries the
 * write id and each of its decisions reads back with the row's decision,
 * reason, side and note.
 *
 * Who may decide follows the screen (`recordDecisionsAction` and the
 * sign-in that precedes it), checked by `readCaptureAccess`, which also
 * returns every value it read for the guards that open the SQL file
 * (`captureAccessGuards` in `./cli/access-guards.ts`): a platform admin
 * (`users.is_platform_admin`), from any tenant but the platform tenant
 * and without a membership, on a tenant of kind `tenant`, as
 * `admitsAsPlatformAdmin` admits them, deciding as a home member with no
 * audit row; a user of the tenant who is its workspace admin, a super admin or its digitization
 * admin, or who holds a steward membership in its active federation; or
 * a user of another tenant with a steward or staff membership in the
 * tenant's active federation, which gives them a grant into a live
 * tenant (a staff grant works in capture without administering it,
 * `canWorkInArea`); or, failing those, the workspace admin of the lead
 * tenant of the tenant's active federation, on a tenant not suspended,
 * their own tenant not disabled, who decides with no grant and no audit
 * row. The report records which of these the decider acted as
 * (`decidedBy.access`). The registration verb checks who acts with the same
 * function. A write under a grant records, as the sign-in records for every write under a grant, one `audit_log` row of
 * action `edit_on_behalf` per volume written, with the decider and their
 * home tenant as the actor and the tenant as the target; it is inserted
 * only when that volume's decisions were written. A decision by a user
 * of the tenant has no audit row, on the screen or here. The tenant must
 * not be disabled, which the app's tenant loader checks before anyone
 * is signed in, and is checked first; it must also have the
 * digitization capability, which the screen requires. A
 * volume's assigned reviewer who holds neither role is not accepted.
 *
 * Reads go through `wrangler d1 execute --command`, never `--file`,
 * which returns no rows against a remote database; each read names at
 * most `READ_CHUNK` values, and every statement of the file is checked
 * against `MAX_FILE_STATEMENT_BYTES`.
 *
 * @version v0.9.0
 */

import { drizzle } from "drizzle-orm/d1";
import { sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { MAX_FILE_STATEMENT_BYTES, renderStatement } from "../../app/lib/capture/file-route.server";
import { MAX_NOTE_CHARS, readStoredRecords, volumeStillOpen } from "../../app/lib/capture/link.server";
import { MAX_FIELD_CHARS, isOpeningRecord, type RecordStatusFields } from "../../app/lib/capture/manifest";
import { buildDecisionStatements, displayName, type PayloadBudget, type PlannedDecision } from "../../app/lib/capture/qc.server";
import { rawBatchItem } from "../../app/lib/pipeline/callback.server";
import { CAPTURE_QC_REASONS, CAPTURE_QC_SIDES, type CaptureQcReason, type CaptureQcSide } from "../../app/lib/validation/enums";
import type { CaptureAccess } from "./cli/access-guards";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import { appendAll } from "./arrays";

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

/** A stop that names every problem it found. */
export class QcDecisionStop extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(problems.length > 0 ? `${message}:\n  ${problems.join("\n  ")}` : message);
    this.name = "QcDecisionStop";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** The columns a list may have, each with the other names its header may give. */
export const LIST_COLUMNS = {
  stem: ["stem"],
  pairId: ["pairId", "pair_id"],
  sequence: ["sequence", "record_sequence", "recordSequence"],
  side: ["side"],
  reason: ["reason"],
  note: ["note"],
  captuaRecordId: ["captua_record_id", "captuaRecordId", "record_id"],
  decision: ["decision"],
} as const;

type ColumnKey = keyof typeof LIST_COLUMNS;
const REQUIRED_COLUMNS: ColumnKey[] = ["stem", "pairId", "side", "reason", "note"];

/** The side a row gives: one of the contract's sides, or null for an opening with one image. */
export type RowSide = CaptureQcSide | null;

/** The decisions a list may record. */
export const LIST_DECISIONS = ["rejected", "approved", "excluded"] as const;
export type ListDecision = (typeof LIST_DECISIONS)[number];

export interface QcListRow {
  /** The row's line in a TSV file (the header is line 1), or its index plus one in a JSON array. */
  line: number;
  stem: string;
  pairId: string;
  sequence: number | null;
  decision: ListDecision;
  /** Null for an approval, which takes no side, reason or note, and for an exclusion, which takes no side or reason. */
  side: RowSide;
  reason: CaptureQcReason | null;
  note: string | null;
  captuaRecordId: number | null;
}

const chars = (text: string) => Array.from(text).length;
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * The cells of a TSV text, row by row. A field may be quoted with double
 * quotes, which lets it hold a tab or a line break, and a doubled quote
 * inside it stands for one. Blank lines are skipped. Each row carries
 * the line it starts on. A quoted field still open at the end of the
 * text refuses the whole list, naming the line the field opens on, so
 * that the rows after it are never read into it.
 */
export function tsvRows(text: string): Array<{ line: number; cells: string[] }> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let atStart = true;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 0;
  const endRow = () => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0].trim() === "")) out.push({ line: rowLine, cells });
    cells = [];
    cell = "";
    atStart = true;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      quoteLine = line;
      atStart = false;
    } else if (ch === "\t") {
      cells.push(cell);
      cell = "";
      atStart = true;
    } else if (ch === "\r" && body[i + 1] === "\n") {
      continue;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      line++;
      rowLine = line;
    } else {
      cell += ch;
      atStart = false;
    }
  }
  if (quoted) {
    throw new QcDecisionStop("The list is refused whole", [`line ${quoteLine}: a quoted field is never closed`]);
  }
  if (cell !== "" || cells.length > 0) endRow();
  return out;
}

/** An integer cell; empty is null, anything else not an integer is a problem. */
function intCell(value: string, name: string, where: string, problems: string[]): number | null {
  const v = value.trim();
  if (v === "") return null;
  if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
    problems.push(`${where}: ${name} ${JSON.stringify(value)} is not an integer`);
    return null;
  }
  return Number(v);
}

/** One row's values checked against the contract's rules; problems are added to `problems`. */
function checkRow(raw: Partial<Record<ColumnKey, string>>, line: number, where: string, problems: string[]): QcListRow | null {
  const before = problems.length;
  const stem = (raw.stem ?? "").trim();
  const pairId = (raw.pairId ?? "").trim();
  if (stem === "") problems.push(`${where}: stem is empty`);
  else if (chars(stem) > MAX_FIELD_CHARS) problems.push(`${where}: stem is longer than ${MAX_FIELD_CHARS} characters`);
  // An empty pair id names the opening by its record id instead.
  if (pairId === "" && (raw.captuaRecordId ?? "").trim() === "") {
    problems.push(`${where}: pairId is empty and the row gives no captua_record_id`);
  }
  else if (chars(pairId) > MAX_FIELD_CHARS) problems.push(`${where}: pairId is longer than ${MAX_FIELD_CHARS} characters`);

  const decisionText = (raw.decision ?? "").trim();
  if (decisionText !== "" && !(LIST_DECISIONS as readonly string[]).includes(decisionText)) {
    problems.push(`${where}: decision ${JSON.stringify(decisionText)} is not rejected, approved or excluded`);
    return null;
  }
  const decision: ListDecision = decisionText === "" ? "rejected" : (decisionText as ListDecision);

  // An approval takes no side, reason or note, so its cells are empty.
  if (decision === "approved") {
    for (const key of ["side", "reason", "note"] as const) {
      if ((raw[key] ?? "").trim() !== "") problems.push(`${where}: an approval takes no ${key}`);
    }
    const sequence = intCell(raw.sequence ?? "", "sequence", where, problems);
    const captuaRecordId = intCell(raw.captuaRecordId ?? "", "captua_record_id", where, problems);
    if (problems.length > before) return null;
    return { line, stem, pairId, sequence, decision, side: null, reason: null, note: null, captuaRecordId };
  }

  // A note is kept as given; only a note of nothing but white space is none.
  const noteOf = () => {
    const text = raw.note ?? "";
    const n = text.trim() === "" ? null : text;
    if (n !== null && chars(n) > MAX_NOTE_CHARS) problems.push(`${where}: the note is longer than ${MAX_NOTE_CHARS} characters`);
    return n;
  };

  // An exclusion is not a page: no side to retake and no reason, as the
  // decisions route refuses both; it takes a note, as the route does.
  if (decision === "excluded") {
    for (const key of ["side", "reason"] as const) {
      if ((raw[key] ?? "").trim() !== "") problems.push(`${where}: an exclusion takes no ${key}`);
    }
    const note = noteOf();
    const sequence = intCell(raw.sequence ?? "", "sequence", where, problems);
    const captuaRecordId = intCell(raw.captuaRecordId ?? "", "captua_record_id", where, problems);
    if (problems.length > before) return null;
    return { line, stem, pairId, sequence, decision, side: null, reason: null, note, captuaRecordId };
  }

  const sideText = (raw.side ?? "").trim();
  let side: RowSide = null;
  if (sideText === "" || sideText === "single") side = null;
  else if ((CAPTURE_QC_SIDES as readonly string[]).includes(sideText)) side = sideText as CaptureQcSide;
  else problems.push(`${where}: side ${JSON.stringify(sideText)} is not left, right, both, single or empty`);

  const reasonText = (raw.reason ?? "").trim();
  if (!(CAPTURE_QC_REASONS as readonly string[]).includes(reasonText)) {
    problems.push(`${where}: reason ${JSON.stringify(reasonText)} is not one of ${CAPTURE_QC_REASONS.join(", ")}`);
  }
  const reason = reasonText as CaptureQcReason;
  const note = noteOf();
  if (reason === "other" && note === null) problems.push(`${where}: a rejection for other needs a note`);

  const sequence = intCell(raw.sequence ?? "", "sequence", where, problems);
  const captuaRecordId = intCell(raw.captuaRecordId ?? "", "captua_record_id", where, problems);
  if (problems.length > before) return null;
  return { line, stem, pairId, sequence, decision, side, reason, note, captuaRecordId };
}

/** Which column each header cell names; problems for unknown, repeated and missing columns. */
function headerColumns(header: string[], problems: string[]): Array<ColumnKey> {
  const keys: ColumnKey[] = [];
  const seen = new Set<ColumnKey>();
  for (const cell of header) {
    const name = cell.trim();
    const key = (Object.keys(LIST_COLUMNS) as ColumnKey[]).find((k) => (LIST_COLUMNS[k] as readonly string[]).includes(name));
    if (!key) {
      problems.push(`the header names an unknown column ${JSON.stringify(name)}`);
      continue;
    }
    if (seen.has(key)) problems.push(`the header names the column ${key} twice`);
    seen.add(key);
    keys.push(key);
  }
  for (const k of REQUIRED_COLUMNS) if (!seen.has(k)) problems.push(`the header has no ${k} column`);
  return keys;
}

/** How a row names its opening: by its pair id, or as `record <id>` when it gives none. */
const openingName = (r: { pairId: string; captuaRecordId: number | null }) =>
  r.pairId === "" ? `record ${r.captuaRecordId}` : r.pairId;

/** The list's rows, or a stop listing why the whole list is refused (module header). */
export function parseQcList(text: string, format: "tsv" | "json"): QcListRow[] {
  const problems: string[] = [];
  const rows: QcListRow[] = [];
  if (format === "tsv") {
    const table = tsvRows(text);
    if (table.length === 0) throw new QcDecisionStop("The list is empty");
    const keys = headerColumns(table[0].cells, problems);
    if (problems.length > 0) throw new QcDecisionStop("The list is refused whole", problems);
    for (const { line, cells } of table.slice(1)) {
      const where = `line ${line}`;
      if (cells.length !== keys.length) {
        problems.push(`${where}: ${cells.length} fields where the header has ${keys.length}`);
        continue;
      }
      const raw: Partial<Record<ColumnKey, string>> = {};
      keys.forEach((k, i) => (raw[k] = cells[i]));
      const row = checkRow(raw, line, where, problems);
      if (row) rows.push(row);
    }
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (err) {
      throw new QcDecisionStop(`The list is not readable JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new QcDecisionStop("The list is refused whole: a JSON list is an array of rows");
    parsed.forEach((item, i) => {
      const where = `row ${i + 1}`;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        problems.push(`${where}: not an object`);
        return;
      }
      const raw: Partial<Record<ColumnKey, string>> = {};
      for (const [name, value] of Object.entries(item as Record<string, unknown>)) {
        const key = (Object.keys(LIST_COLUMNS) as ColumnKey[]).find((k) => (LIST_COLUMNS[k] as readonly string[]).includes(name));
        if (!key) {
          problems.push(`${where}: unknown key ${JSON.stringify(name)}`);
          continue;
        }
        if (value === null || value === undefined) raw[key] = "";
        else if (typeof value === "string" || typeof value === "number") raw[key] = String(value);
        else problems.push(`${where}: ${name} is not a string or a number`);
      }
      // An approval or an exclusion names no reason; a rejection's missing reason is a problem here.
      const noReason = ["approved", "excluded"].includes(raw.decision?.trim() ?? "");
      // A row may leave out its pair id; `checkRow` then asks for the record id.
      const optional = new Set<ColumnKey>(["note", "side", "pairId", ...(noReason ? (["reason"] as const) : [])]);
      for (const k of REQUIRED_COLUMNS) if (!(k in raw) && !optional.has(k)) problems.push(`${where}: no ${k}`);
      const row = checkRow(raw, i + 1, where, problems);
      if (row) rows.push(row);
    });
  }
  if (rows.length === 0 && problems.length === 0) problems.push("the list has no rows");

  // One row per opening key: the pair id, or the record id of a row without one.
  const keyOf = (r: QcListRow) => (r.pairId === "" ? `${r.stem}\u0000\u0001${r.captuaRecordId}` : `${r.stem}\u0000${r.pairId}`);
  const first = new Map<string, number>();
  for (const r of rows) {
    const earlier = first.get(keyOf(r));
    if (earlier !== undefined) problems.push(`row at ${r.line} names ${r.stem} ${openingName(r)} again (first at ${earlier})`);
    else first.set(keyOf(r), r.line);
  }
  if (problems.length > 0) throw new QcDecisionStop("The list is refused whole", problems);
  return rows;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Values one read names at most, so each `--command` stays short. */
export const READ_CHUNK = 100;
/** Deliveries whose records one read carries, since a delivery's records may be large. */
export const RECORDS_CHUNK = 5;
/** Volumes one open read checks: D1 takes at most five terms in a compound SELECT. */
export const OPEN_CHUNK = 5;

/**
 * Room each written statement keeps beside its payload, for the SQL
 * around it: the guard, the ids and the decider's name, which take a
 * few thousand bytes at most.
 */
export const STATEMENT_ROOM_BYTES = 15_000;

/**
 * The payloads as the file writes them: a JSON text inside an SQL
 * string literal, where each apostrophe is doubled, measured in UTF-8
 * bytes. A chunk of them therefore fits a file statement with
 * `STATEMENT_ROOM_BYTES` to spare, whatever the notes hold.
 */
export const SQL_TEXT_PAYLOAD: PayloadBudget = {
  limit: MAX_FILE_STATEMENT_BYTES - STATEMENT_ROOM_BYTES,
  cost: (json) => byteLength(json) + (json.match(/'/g)?.length ?? 0),
};

/** Builds statements only; nothing is ever run through this client. */
function builder() {
  return drizzle({ prepare: () => ({}) } as unknown as D1Database);
}

/** A built SQL fragment as one statement's text, its values written in. */
export function render(query: SQL): string {
  return renderStatement(rawBatchItem(builder(), query));
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

const inList = (values: Array<string | number>) => sql.join(values.map((v) => sql`${v}`), sql`, `);

export function tenantQuery(slug: string): string {
  return render(sql`SELECT t.id AS id, t.slug AS slug, IFNULL(t.kind, '') AS kind, IFNULL(t.federation_id, '') AS federation_id,
      t.status AS status, IFNULL(t.disabled_at, '') AS disabled_at, t.digitization_enabled AS digitization_enabled,
      IFNULL(f.status, '') AS federation_status
    FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE t.slug = ${slug}`);
}

export function userQuery(email: string, federationId: string): string {
  return render(sql`SELECT u.id AS id, u.email AS email, IFNULL(u.name, '') AS name, u.tenant_id AS tenant_id,
      u.is_admin AS is_admin, u.is_super_admin AS is_super_admin, u.is_digitization_admin AS is_digitization_admin,
      u.is_platform_admin AS is_platform_admin,
      IFNULL((SELECT m.role FROM federation_memberships m WHERE m.user_id = u.id AND m.federation_id = ${federationId}), '')
        AS federation_role
    FROM users u WHERE lower(u.email) = lower(${email})`);
}

/** The federation's lead tenant, and whether the user's own tenant is disabled. */
export function leadQuery(federationId: string, homeTenantId: string): string {
  return render(sql`SELECT IFNULL(f.lead_tenant_id, '') AS lead_tenant_id, IFNULL(h.disabled_at, '') AS home_disabled_at
    FROM federations f, tenants h WHERE f.id = ${federationId} AND h.id = ${homeTenantId}`);
}

/** Each named volume's current delivery, its volume and its set's revision. */
export function deliveriesQuery(tenantId: string, stems: string[]): string {
  return render(sql`SELECT d.id AS id, d.reference_code AS reference_code,
      IFNULL(d.pipeline_volume_id, '') AS pipeline_volume_id,
      IFNULL((SELECT s.revision FROM capture_qc_sets s WHERE s.tenant_id = d.tenant_id AND s.delivery_id = d.id), 0) AS revision
    FROM capture_deliveries d
    WHERE d.tenant_id = ${tenantId} AND d.state = 'registered' AND d.reference_code IN (${inList(stems)})`);
}

/** Whether each volume is still open to decisions, by the guard the screen's write carries. */
export function openQuery(tenantId: string, volumeIds: string[], now: number): string {
  return render(
    sql.join(
      volumeIds.map((v) => sql`SELECT ${v} AS id, CASE WHEN ${volumeStillOpen(tenantId, v, now)} THEN 1 ELSE 0 END AS open`),
      sql` UNION ALL `,
    ),
  );
}

export function recordsQuery(tenantId: string, deliveryIds: string[]): string {
  return render(sql`SELECT id, IFNULL(records, '') AS records FROM capture_deliveries
    WHERE tenant_id = ${tenantId} AND id IN (${inList(deliveryIds)})`);
}

/** The images that carry any of `pairIds` in the deliveries, each with its record's image count. */
export function imagesQuery(tenantId: string, deliveryIds: string[], pairIds: string[]): string {
  return render(sql`SELECT i.delivery_id AS delivery_id, i.captua_record_id AS captua_record_id, i.pair_id AS pair_id,
      (SELECT COUNT(*) FROM capture_images c WHERE c.tenant_id = i.tenant_id AND c.delivery_id = i.delivery_id
        AND c.captua_record_id = i.captua_record_id) AS images
    FROM capture_images i
    WHERE i.tenant_id = ${tenantId} AND i.delivery_id IN (${inList(deliveryIds)}) AND i.pair_id IN (${inList(pairIds)})`);
}

/**
 * The images of each of `recordIds` in the deliveries, for rows that give
 * no pair id: each record's image count, how many of its images carry a
 * pair id (an empty string is one; only NULL is none), and the pair ids
 * they carry, as a JSON array.
 */
export function recordImagesQuery(tenantId: string, deliveryIds: string[], recordIds: number[]): string {
  return render(sql`SELECT delivery_id, captua_record_id, COUNT(*) AS images, COUNT(pair_id) AS paired,
      json_group_array(pair_id) AS pair_ids
    FROM capture_images
    WHERE tenant_id = ${tenantId} AND delivery_id IN (${inList(deliveryIds)}) AND captua_record_id IN (${inList(recordIds)})
    GROUP BY delivery_id, captua_record_id`);
}

export function decisionsQuery(tenantId: string, deliveryIds: string[]): string {
  return render(sql`SELECT delivery_id, captua_record_id, decision, IFNULL(reason, '') AS reason, IFNULL(side, '') AS side,
      IFNULL(note, '') AS note
    FROM capture_qc_decisions WHERE tenant_id = ${tenantId} AND delivery_id IN (${inList(deliveryIds)})`);
}

/** The rotations recorded on those deliveries, which a revised opening keeps. */
export function rotationsQuery(tenantId: string, deliveryIds: string[]): string {
  return render(sql`SELECT delivery_id, captua_record_id, capture_id, role, quarter_turns FROM capture_qc_rotations
    WHERE tenant_id = ${tenantId} AND delivery_id IN (${inList(deliveryIds)})
    ORDER BY delivery_id, captua_record_id, capture_id, role`);
}

/** Each set written under one of `writeIds`, read back after the file is applied. */
export function verifyQuery(tenantId: string, writeIds: string[]): string {
  return render(sql`SELECT delivery_id, write_id, revision, state, rejected_count FROM capture_qc_sets
    WHERE tenant_id = ${tenantId} AND write_id IN (${inList(writeIds)})`);
}

/**
 * The `edit_on_behalf` row a write under a grant records (module header),
 * inserted only when the set carries this volume's write id.
 */
export function grantAuditStatement(a: {
  id: string;
  now: number;
  userId: string;
  email: string;
  homeTenantId: string;
  /** The grant's federation role, as the sign-in records it. */
  role: "steward" | "staff";
  tenantId: string;
  volumeId: string;
  deliveryId: string;
  writeId: string;
}): string {
  const details = JSON.stringify({ role: a.role, method: "POST", path: `/admin/capture/volumes/${a.volumeId}/decisions` });
  return render(sql`INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action,
      target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)
    SELECT ${a.id}, ${a.now}, ${a.userId}, ${a.email}, ${a.homeTenantId}, 'edit_on_behalf', ${a.tenantId}, 'grant_write',
      NULL, NULL, ${details}
    WHERE EXISTS (SELECT 1 FROM capture_qc_sets s WHERE s.tenant_id = ${a.tenantId} AND s.delivery_id = ${a.deliveryId}
      AND s.write_id = ${a.writeId})`);
}

// ---------------------------------------------------------------------------
// Who acts
// ---------------------------------------------------------------------------

export type RowReader = (sql: string) => Promise<Record<string, unknown>[]>;

const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export interface Decider {
  id: string;
  email: string;
  name: string;
  /** The decider's home tenant when they decide under a grant; null for a user of the tenant. */
  grantHome: string | null;
  /** The grant's federation role; null for a user of the tenant. */
  grantRole: "steward" | "staff" | null;
  /** How the decider acts in the tenant. */
  actedAs: DeciderBasis;
}

/** A user of the tenant, a platform admin, the lead's admin, or a federation grant. */
export type DeciderBasis = "member" | "platform-admin" | "lead-admin" | "grant";

/**
 * The tenant and who acts in it, checked as the Capture QC screen checks
 * them (module header), and every value the check read, for the guards
 * that open the SQL file (`captureAccessGuards`). A stop when the tenant
 * is missing, disabled or without the digitization capability, or the
 * user may not act there.
 */
export async function readCaptureAccess(
  rows: RowReader,
  slug: string,
  email: string,
): Promise<{ tenantId: string; decider: Decider; access: CaptureAccess }> {
  const tenantRows = await rows(tenantQuery(slug));
  if (tenantRows.length === 0) throw new QcDecisionStop(`No tenant has the slug ${slug}`);
  const tenant = tenantRows[0];
  // The tenant gate comes before any access check, as the app's tenant
  // loader refuses a disabled tenant before anyone is signed in.
  if (text(tenant.disabled_at) !== "") throw new QcDecisionStop(`The tenant ${slug} is disabled`);
  if (!truthy(tenant.digitization_enabled)) {
    throw new QcDecisionStop(`The tenant ${slug} does not have the digitization capability`);
  }
  const tenantId = text(tenant.id);
  const federationId = text(tenant.federation_id);
  const found = await rows(userQuery(email, federationId));
  if (found.length === 0) throw new QcDecisionStop(`No user has the email ${email}`);
  const u = found[0];
  const access: CaptureAccess = {
    tenant: {
      id: tenantId,
      slug: text(tenant.slug),
      federationId,
      federationStatus: text(tenant.federation_status),
      status: text(tenant.status),
      kind: text(tenant.kind),
      digitizationEnabled: true,
    },
    user: {
      id: text(u.id),
      email: text(u.email),
      tenantId: text(u.tenant_id),
      isAdmin: truthy(u.is_admin),
      isSuperAdmin: truthy(u.is_super_admin),
      isDigitizationAdmin: truthy(u.is_digitization_admin),
      // As the app reads the boolean column (`Number(value) === 1`).
      isPlatformAdmin: Number(u.is_platform_admin) === 1,
      federationRole: text(u.federation_role),
    },
  };
  const fedActive = federationId !== "" && text(tenant.federation_status) === "active";
  const steward = fedActive && text(u.federation_role) === "steward";
  const staff = fedActive && text(u.federation_role) === "staff";
  const base = { id: text(u.id), email: text(u.email), name: displayName({ name: text(u.name) || null }) };
  // A platform admin is at home in every live workspace, before any grant
  // is resolved (`admitsAsPlatformAdmin`): the tenant is not disabled,
  // which is checked above, and is of kind `tenant`, and the user's row is
  // not on the platform tenant.
  const platformAdmin =
    access.user.isPlatformAdmin && access.user.tenantId !== PLATFORM_TENANT_ID && access.tenant.kind === "tenant";
  if (platformAdmin) return { tenantId, decider: { ...base, grantHome: null, grantRole: null, actedAs: "platform-admin" }, access };
  if (text(u.tenant_id) === tenantId) {
    if (truthy(u.is_admin) || truthy(u.is_super_admin) || truthy(u.is_digitization_admin) || steward) {
      return { tenantId, decider: { ...base, grantHome: null, grantRole: null, actedAs: "member" }, access };
    }
    throw new QcDecisionStop(
      `${email} is a user of ${text(tenant.slug)} without digitization admin rights or a steward membership in its federation`,
    );
  }
  // A grant also needs the tenant not suspended (`resolveGrant`).
  const live = text(tenant.status) !== "suspended";
  const granted = steward || staff;
  if (granted && live) {
    return { tenantId, decider: { ...base, grantHome: text(u.tenant_id), grantRole: steward ? "steward" : "staff", actedAs: "grant" }, access };
  }
  // The workspace admin of the federation's lead tenant, on a live member
  // of the active federation, their own tenant not disabled: no grant, so
  // no edit_on_behalf row.
  if (fedActive && live && truthy(u.is_admin)) {
    const [l] = await rows(leadQuery(federationId, text(u.tenant_id)));
    if (l && text(l.lead_tenant_id) === text(u.tenant_id) && text(l.home_disabled_at) === "") {
      access.lead = { leadTenantId: text(l.lead_tenant_id) };
      return { tenantId, decider: { ...base, grantHome: null, grantRole: null, actedAs: "lead-admin" }, access };
    }
  }
  throw new QcDecisionStop(
    `${email} is not a user of ${text(tenant.slug)}, has no steward or staff grant into it, ` +
      `and is not an admin of the lead workspace of its federation` +
      (granted && !live ? " (the tenant is suspended)" : ""),
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type SourceRecord = "production" | "staging";

export interface QcDecisionOptions {
  /** The tenant's slug. */
  slug: string;
  /** The decider's email. */
  decidedBy: string;
  sourceRecord: SourceRecord;
  /** Whether a row may replace a different decision already recorded (module header). */
  revise: boolean;
  /** The list's digest, in hex, carried in the report. */
  listId: string;
}

export interface QcDecisionProviders {
  rows: RowReader;
  now: () => number;
  newId: () => string;
}

export type Outcome = "decide" | "same" | "revise" | "conflict" | "missing" | "locked";

/** A decision as `capture_qc_decisions` holds it, each empty value null. */
export interface RecordedDecision {
  decision: string;
  reason: string | null;
  side: string | null;
  note: string | null;
}

export interface RowReport {
  line: number;
  stem: string;
  pairId: string;
  decision: ListDecision;
  side: RowSide;
  reason: CaptureQcReason | null;
  note: string | null;
  /** The record the pair id names in the current delivery, when it names one. */
  captuaRecordId: number | null;
  outcome: Outcome;
  /** For a `revise` row: the decision it replaces. */
  before?: RecordedDecision;
  detail?: string;
}

export interface VolumeWrite {
  stem: string;
  volumeId: string;
  deliveryId: string;
  /** The decisions written: the volume's `decide` and `revise` rows. */
  decisions: number;
  /** Of those, the `revise` rows. */
  revisions: number;
  /** The set's revision as read: 0 when the delivery had no set. */
  revisionBefore: number;
  writeId: string;
  decisionsId: string;
  /** After an apply: whether the set carries this write and each written decision reads back as the row gave it. */
  verified?: boolean;
  revisionAfter?: number;
}

export interface QcDecisionReport {
  listId: string;
  tenant: string;
  sourceRecord: SourceRecord;
  decidedBy: { id: string; email: string; name: string; access: DeciderBasis };
  applied: boolean;
  counts: Record<Outcome, number>;
  rows: RowReport[];
  volumes: VolumeWrite[];
  /** After an apply: what the read-back and the second plan found wrong; empty when both pass. */
  problems?: string[];
}

/** The list's id: the first 16 hex characters of the SHA-256 of its text. */
export async function listIdOf(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface DeliveryState {
  id: string;
  stem: string;
  volumeId: string;
  revision: number;
  open: boolean;
  /** Record id to its sequence, status and placeholder fields, from the delivery's records. */
  records: Map<number, RecordStatusFields & { sequence: number }>;
  openings: number;
}

/** A decision in words: `approved`, or `rejected, <reason>, side <side>`, with its note when asked. */
function describe(d: { decision: string; reason: string | null; side: string | null; note: string | null }, withNote: boolean): string {
  const what = d.decision === "rejected" ? `rejected, ${d.reason}${d.side ? `, side ${d.side}` : ""}` : d.decision;
  return withNote && d.note ? `${what}, note ${JSON.stringify(d.note)}` : what;
}

function rowLine(r: RowReport): string {
  // A row without a pair id is named by its record id, which is not repeated.
  const record = r.captuaRecordId === null || r.pairId === "" ? "" : ` (record ${r.captuaRecordId})`;
  const what = describe(r, false);
  return `  [${r.outcome}] line ${r.line} ${r.stem} ${openingName(r)}${record}: ${what}${r.detail ? ` -- ${r.detail}` : ""}`;
}

/** The decisions recorded on `deliveryIds`, by delivery id and record id. */
async function readDecisions(rows: RowReader, tenantId: string, deliveryIds: string[]): Promise<Map<string, RecordedDecision>> {
  const out = new Map<string, RecordedDecision>();
  const orNull = (v: unknown) => (text(v) === "" ? null : text(v));
  for (const part of chunks([...new Set(deliveryIds)], READ_CHUNK)) {
    for (const r of await rows(decisionsQuery(tenantId, part))) {
      out.set(`${text(r.delivery_id)}\u0000${Number(r.captua_record_id)}`, {
        decision: text(r.decision),
        reason: orNull(r.reason),
        side: orNull(r.side),
        note: orNull(r.note),
      });
    }
  }
  return out;
}

/** Whether a recorded decision is the one a row gives: decision, reason, side and note alike. */
function sameDecision(
  recorded: RecordedDecision,
  row: { decision: string; reason: string | null; side: string | null; note: string | null },
): boolean {
  return (
    recorded.decision === row.decision &&
    (recorded.reason ?? "") === (row.reason ?? "") &&
    (recorded.side ?? "") === (row.side ?? "") &&
    (recorded.note ?? "") === (row.note ?? "")
  );
}

export interface QcDecisionPlan {
  report: QcDecisionReport;
  /** The file's statements, in order, without the guards on who acts that open it. */
  statements: string[];
  /** The rows each volume's write records, by write id, which the read-back checks. */
  writtenRows: Map<string, RowReport[]>;
  tenantId: string;
  access: CaptureAccess;
}

/**
 * Reads the tenant, who decides and every named volume, sorts every row
 * into one outcome, logs them, and builds the statements that record the
 * `decide` and `revise` rows. Reads only; writes nothing.
 */
export async function planQcDecisions(
  list: QcListRow[],
  options: QcDecisionOptions,
  providers: QcDecisionProviders,
  log: (line: string) => void,
): Promise<QcDecisionPlan> {
  const { rows } = providers;
  const { tenantId: t, decider, access } = await readCaptureAccess(rows, options.slug, options.decidedBy);
  const now = providers.now();
  log(`Tenant ${options.slug} (${t}), database ${options.sourceRecord}`);
  log(
    `Decided by ${decider.email} (${decider.id}), told to the unit as "${decider.name}"` +
      (decider.grantHome ? `, under a ${decider.grantRole} grant from tenant ${decider.grantHome}` : "") +
      (decider.actedAs === "lead-admin" ? ", as the admin of the lead workspace of its federation" : ""),
  );
  log(`List ${options.listId}: ${list.length} rows`);

  // The current delivery of each named volume.
  const stems = [...new Set(list.map((r) => r.stem))];
  const deliveries = new Map<string, DeliveryState>();
  for (const part of chunks(stems, READ_CHUNK)) {
    for (const r of await rows(deliveriesQuery(t, part))) {
      deliveries.set(text(r.reference_code), {
        id: text(r.id),
        stem: text(r.reference_code),
        volumeId: text(r.pipeline_volume_id),
        revision: Number(r.revision ?? 0),
        open: false,
        records: new Map(),
        openings: 0,
      });
    }
  }
  const held = [...deliveries.values()].filter((d) => d.volumeId !== "");
  for (const part of chunks(held, OPEN_CHUNK)) {
    for (const r of await rows(openQuery(t, part.map((d) => d.volumeId), now))) {
      const d = part.find((x) => x.volumeId === text(r.id));
      if (d) d.open = truthy(r.open);
    }
  }
  for (const part of chunks([...deliveries.values()], RECORDS_CHUNK)) {
    for (const r of await rows(recordsQuery(t, part.map((d) => d.id)))) {
      const d = part.find((x) => x.id === text(r.id));
      if (!d || text(r.records) === "") continue;
      const records = await readStoredRecords(text(r.records));
      for (const rec of records) d.records.set(rec.captuaRecordId, rec);
      d.openings = records.filter(isOpeningRecord).length;
    }
  }

  // The records each row's pair id names, with their image counts.
  const byDelivery = new Map<string, Map<string, Map<number, number>>>();
  const deliveryIds = [...deliveries.values()].map((d) => d.id);
  const pairIds = [...new Set(list.filter((r) => deliveries.has(r.stem) && r.pairId !== "").map((r) => r.pairId))];
  for (const dPart of chunks(deliveryIds, READ_CHUNK)) {
    for (const pPart of chunks(pairIds, READ_CHUNK)) {
      for (const r of await rows(imagesQuery(t, dPart, pPart))) {
        const pairs = byDelivery.get(text(r.delivery_id)) ?? new Map<string, Map<number, number>>();
        const records = pairs.get(text(r.pair_id)) ?? new Map<number, number>();
        records.set(Number(r.captua_record_id), Number(r.images));
        pairs.set(text(r.pair_id), records);
        byDelivery.set(text(r.delivery_id), pairs);
      }
    }
  }

  // The records the rows without a pair id name, with their image counts
  // and the pair ids their images carry: any value but NULL, the empty
  // string included, is a pair id.
  const byRecord = new Map<string, { images: number; paired: number; pairIds: string[] }>();
  const recordIds = [
    ...new Set(list.filter((r) => deliveries.has(r.stem) && r.pairId === "").map((r) => r.captuaRecordId as number)),
  ];
  for (const dPart of chunks(deliveryIds, READ_CHUNK)) {
    for (const rPart of chunks(recordIds, READ_CHUNK)) {
      for (const r of await rows(recordImagesQuery(t, dPart, rPart))) {
        byRecord.set(`${text(r.delivery_id)}\u0000${Number(r.captua_record_id)}`, {
          images: Number(r.images),
          paired: Number(r.paired),
          pairIds: [...new Set((JSON.parse(text(r.pair_ids)) as Array<string | null>).filter((p): p is string => p !== null))].sort(),
        });
      }
    }
  }

  // The decisions already recorded on those deliveries, and their rotations.
  const recorded = await readDecisions(rows, t, deliveryIds);
  const rotations = new Map<string, PlannedDecision["rotations"]>();
  for (const part of chunks(deliveryIds, READ_CHUNK)) {
    for (const r of await rows(rotationsQuery(t, part))) {
      const key = `${text(r.delivery_id)}\u0000${Number(r.captua_record_id)}`;
      rotations.set(key, [
        ...(rotations.get(key) ?? []),
        { captureId: text(r.capture_id), role: text(r.role), quarterTurns: Number(r.quarter_turns) },
      ]);
    }
  }

  // Each row's outcome.
  const reports: RowReport[] = list.map((row) => {
    const base: RowReport = {
      line: row.line,
      stem: row.stem,
      pairId: row.pairId,
      decision: row.decision,
      side: row.side,
      reason: row.reason,
      note: row.note,
      captuaRecordId: null,
      outcome: "decide",
    };
    const out = (outcome: Outcome, detail?: string, before?: RecordedDecision): RowReport => ({
      ...base,
      outcome,
      ...(before ? { before } : {}),
      ...(detail ? { detail } : {}),
    });
    const d = deliveries.get(row.stem);
    if (!d) return out("missing", `no current delivery holds a volume ${row.stem}`);
    if (d.volumeId === "") return out("missing", `the delivery ${d.id} holds no pipeline volume`);
    let recordId: number;
    let images: number;
    if (row.pairId === "") {
      // A row without a pair id names its record directly; it reaches the
      // record only if none of its images carries a pair id, so the two
      // ways of naming an opening can never disagree.
      recordId = row.captuaRecordId as number;
      base.captuaRecordId = recordId;
      if (!d.records.has(recordId)) return out("missing", `record ${recordId} is not in the delivery ${d.id}`);
      // Only a record none of whose images carries a pair id (all NULL) is
      // found this way; each pair id carried is shown quoted, so an empty
      // one reads "".
      const found = byRecord.get(`${d.id}\u0000${recordId}`) ?? { images: 0, paired: 0, pairIds: [] };
      if (found.paired > 0) {
        const named = found.pairIds.map((p) => JSON.stringify(p)).join(", ");
        const noun = found.pairIds.length > 1 ? "pair ids" : "pair id";
        return out("conflict", `record ${recordId}'s images carry the ${noun} ${named}, so the row must give it`);
      }
      images = found.images;
    } else {
      const named = byDelivery.get(d.id)?.get(row.pairId);
      if (!named || named.size === 0) return out("missing", `no image of the delivery ${d.id} carries the pair id ${row.pairId}`);
      if (named.size > 1) {
        return out("conflict", `the pair id ${row.pairId} is on records ${[...named.keys()].sort((a, b) => a - b).join(", ")}`);
      }
      [[recordId, images]] = [...named];
      base.captuaRecordId = recordId;
    }
    const record = d.records.get(recordId);
    if (!record || !isOpeningRecord(record)) {
      return out("missing", `record ${recordId} is not an opening of the delivery ${d.id}${record ? ` (it is ${record.status})` : ""}`);
    }
    if (row.captuaRecordId !== null && row.captuaRecordId !== recordId) {
      return out("conflict", `the list gives record ${row.captuaRecordId}; the pair id is on record ${recordId}`);
    }
    if (row.sequence !== null && row.sequence !== record.sequence) {
      return out("conflict", `the list gives sequence ${row.sequence}; record ${recordId} has sequence ${record.sequence}`);
    }
    // An approval or an exclusion takes no side, so only a rejection's
    // side is checked against the images: a single and a spread may
    // both be excluded, as on the screen.
    if (row.decision === "rejected") {
      if (images > 1 && row.side === null) return out("conflict", `the opening has ${images} images, so the row needs left, right or both`);
      if (images <= 1 && row.side !== null) return out("conflict", `the opening has one image, so the row takes no side`);
    }
    const existing = recorded.get(`${d.id}\u0000${recordId}`);
    if (existing && sameDecision(existing, row)) return out("same");
    if (existing && !options.revise) return out("conflict", `record ${recordId} is already decided: ${describe(existing, true)}`);
    if (!d.open) return out("locked", `a pipeline run has claimed or named the volume ${d.volumeId}`);
    if (existing) return out("revise", `record ${recordId} was ${describe(existing, true)}`, existing);
    return out("decide");
  });

  // Two rows that reach one opening are both conflicts, even when one of
  // them matches what is recorded: with --revise the other would replace
  // it, and each later run would swap them back.
  const writes = (r: RowReport) => r.outcome === "decide" || r.outcome === "revise";
  const seen = new Map<string, RowReport[]>();
  for (const r of reports) {
    if (r.captuaRecordId === null || !(writes(r) || r.outcome === "same")) continue;
    const key = `${r.stem}\u0000${r.captuaRecordId}`;
    seen.set(key, [...(seen.get(key) ?? []), r]);
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.outcome = "conflict";
      delete r.before;
      r.detail = `lines ${group.map((g) => g.line).join(", ")} name record ${r.captuaRecordId}`;
    }
  }

  const counts: Record<Outcome, number> = { decide: 0, same: 0, revise: 0, conflict: 0, missing: 0, locked: 0 };
  for (const r of reports) counts[r.outcome]++;

  log("");
  log("Rows");
  for (const r of reports) log(rowLine(r));
  log("");
  log(
    `${counts.decide} to decide, ${counts.revise} to revise, ${counts.same} already the same, ${counts.conflict} conflicts, ` +
      `${counts.missing} missing, ${counts.locked} locked`,
  );

  // One write per volume with rows to decide or revise. The builder
  // replaces each opening's rotations with the ones given, so every
  // opening is given the rotations it already has, except an excluded
  // one, which is given none: the viewer's exclude drops an opening's
  // rotations and the decisions route refuses any on an exclusion.
  const volumes: VolumeWrite[] = [];
  const statements: string[] = [];
  const writtenRows = new Map<string, RowReport[]>();
  const byStem = [...deliveries.values()].sort((x, y) => (x.stem < y.stem ? -1 : x.stem > y.stem ? 1 : 0));
  for (const d of byStem) {
    const decide = reports.filter((r) => r.stem === d.stem && writes(r));
    if (decide.length === 0) continue;
    const writeId = providers.newId();
    const decisionsId = providers.newId();
    const planned: PlannedDecision[] = decide.map((r) => ({
      captuaRecordId: r.captuaRecordId as number,
      decision: r.decision,
      reason: r.reason,
      side: r.side,
      note: r.note,
      rotations: r.decision === "excluded" ? [] : (rotations.get(`${d.id}\u0000${r.captuaRecordId}`) ?? []),
    }));
    const items = buildDecisionStatements(builder(), {
      tenantId: t,
      volumeId: d.volumeId,
      deliveryId: d.id,
      openingCount: d.openings,
      decisions: planned,
      userId: decider.id,
      userName: decider.name,
      decisionsId,
      writeId,
      now,
      expectedRevision: d.revision,
      clears: [],
      payload: SQL_TEXT_PAYLOAD,
    });
    // The last item is the read-back the screen answers with; the
    // command leaves it out of the file and re-reads the set instead.
    const written = items.slice(0, -1).map((i) => renderStatement(i as BatchItem<"sqlite">));
    if (decider.grantHome) {
      written.push(
        grantAuditStatement({
          id: providers.newId(),
          now,
          userId: decider.id,
          email: decider.email,
          homeTenantId: decider.grantHome,
          role: decider.grantRole ?? "steward",
          tenantId: t,
          volumeId: d.volumeId,
          deliveryId: d.id,
          writeId,
        }),
      );
    }
    for (const s of written) {
      if (byteLength(s) > MAX_FILE_STATEMENT_BYTES) {
        throw new QcDecisionStop(
          `A statement for the volume ${d.stem} takes ${byteLength(s)} bytes, past the ${MAX_FILE_STATEMENT_BYTES} a file statement may take`,
        );
      }
    }
    appendAll(statements, written);
    writtenRows.set(writeId, decide);
    volumes.push({
      stem: d.stem,
      volumeId: d.volumeId,
      deliveryId: d.id,
      decisions: decide.length,
      revisions: decide.filter((r) => r.outcome === "revise").length,
      revisionBefore: d.revision,
      writeId,
      decisionsId,
    });
  }

  const report: QcDecisionReport = {
    listId: options.listId,
    tenant: options.slug,
    sourceRecord: options.sourceRecord,
    decidedBy: { id: decider.id, email: decider.email, name: decider.name, access: decider.actedAs },
    applied: false,
    counts,
    rows: reports,
    volumes,
  };
  return { report, statements, writtenRows, tenantId: t, access };
}

/** The rows that keep the file from being applied: conflicts, missing and locked. */
export function blockingRows(report: QcDecisionReport): number {
  return report.counts.conflict + report.counts.missing + report.counts.locked;
}

/**
 * After the file is applied: re-reads every set by its write id and every
 * decision written, marks each volume verified or not, and logs each.
 */
export async function verifyQcWrites(plan: QcDecisionPlan, rows: RowReader, log: (line: string) => void): Promise<void> {
  const { report, writtenRows, tenantId: t } = plan;
  const volumes = report.volumes;
  const sets = new Map<string, Record<string, unknown>>();
  for (const part of chunks(volumes.map((v) => v.writeId), READ_CHUNK)) {
    for (const r of await rows(verifyQuery(t, part))) sets.set(text(r.write_id), r);
  }
  const after = await readDecisions(rows, t, volumes.map((v) => v.deliveryId));
  log("");
  log("Re-read");
  for (const v of volumes) {
    const s = sets.get(v.writeId);
    const differ = (writtenRows.get(v.writeId) ?? []).filter((r) => {
      const held = after.get(`${v.deliveryId}\u0000${r.captuaRecordId}`);
      return !held || !sameDecision(held, r);
    });
    v.verified = !!s && text(s.delivery_id) === v.deliveryId && differ.length === 0;
    if (s) v.revisionAfter = Number(s.revision);
    log(
      `  [${v.verified ? "ok" : "not written"}] ${v.stem}: ${v.decisions} decisions, ${v.revisions} of them revisions` +
        (s ? `, set revision ${v.revisionBefore} to ${text(s.revision)}, state ${text(s.state)}` : ", the set does not carry this write") +
        (s && differ.length > 0 ? `; records ${differ.map((r) => r.captuaRecordId).join(", ")} do not read back as the list gives them` : ""),
    );
  }
}

// @version v0.9.0
