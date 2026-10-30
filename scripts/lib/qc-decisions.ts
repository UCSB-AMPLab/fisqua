/**
 * Scripts — recording capture QC decisions in bulk from a list
 *
 * This module deals with recording capture QC rejections for many
 * openings at once, from a list an operator hands over, so that each
 * opening is recorded exactly as if a reviewer had sent it back on the
 * Capture QC screen. The command in
 * `scripts/commands/record-qc-decisions.ts` is a thin shell around
 * `recordQcDecisions` here; the providers are injected, so the tests run
 * every step against a real D1 binding.
 *
 * `parseQcList` reads the list: a TSV file with a header row, or a JSON
 * array of objects with the same keys. Each row names one opening by its
 * volume's `stem` (the volume's reference code) and its `pairId`, as the
 * capture manifest gives the pair id of the opening's images, and gives
 * the `side` to retake (`left`, `right` or `both` for an opening with
 * two images; `single` or empty for one with one image), the `reason`
 * (one of the contract's reason codes), the `note`, and optionally the
 * record `sequence` and the unit's record id (`captua_record_id`), which
 * are checked against Fisqua's record; the opening is found by stem and
 * pair id alone. Every row is a rejection. It refuses the whole list, naming
 * every problem, when a column is missing or unknown, a row has the
 * wrong number of fields, a value is not one the contract allows, a
 * rejection for `other` has no note, a note passes 2,000 characters, or
 * two rows name the same stem and pair id.
 *
 * `recordQcDecisions` reads the tenant, checks that the decider may
 * decide there as the Capture QC screen checks it, reads each named
 * volume's current delivery and sorts every row into one outcome:
 * `decide` (the opening is undecided and the decision can be recorded),
 * `same` (an identical rejection is already recorded, so nothing is
 * written and the list can be run again), `conflict` (a different
 * decision is already recorded, or Fisqua's record disagrees with the
 * row: another record id or sequence, a side that does not fit the
 * opening's images, a pair id found on more than one record, or two rows
 * naming one opening; never overwritten), `missing` (no volume, current
 * delivery or opening answers the row) and `locked` (a pipeline run has
 * claimed or named the volume, after which no decision may be recorded).
 * A dry run, the default, stops there and writes only the report. With
 * `--apply`, any conflict, missing or locked row stops the command
 * before anything is written.
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
 * statements into no-ops rather than racing it. The builder's last
 * statement, a read-back the screen answers with, is left out of the
 * file; the command re-reads every set by its write id instead.
 *
 * Who may decide follows the screen (`recordDecisionsAction` and the
 * sign-in that precedes it): a user of the tenant who is its workspace
 * admin, a super admin or its digitization admin, or who holds a steward
 * membership in its active federation; or a user of another tenant with
 * a steward membership in the tenant's active federation, which gives
 * them a grant into a live tenant. A write under a grant records, as the
 * sign-in records for every write under a grant, one `audit_log` row of
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
 * @version v0.8.0
 */

import { drizzle } from "drizzle-orm/d1";
import { sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { MAX_FILE_STATEMENT_BYTES, renderStatement } from "../../app/lib/capture/file-route.server";
import { MAX_NOTE_CHARS, unpackJson, volumeStillOpen } from "../../app/lib/capture/link.server";
import { MAX_FIELD_CHARS, isOpening } from "../../app/lib/capture/manifest";
import { buildDecisionStatements, displayName, type PayloadBudget, type PlannedDecision } from "../../app/lib/capture/qc.server";
import { rawBatchItem } from "../../app/lib/pipeline/callback.server";
import { CAPTURE_QC_REASONS, CAPTURE_QC_SIDES, type CaptureQcReason, type CaptureQcSide } from "../../app/lib/validation/enums";

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
} as const;

type ColumnKey = keyof typeof LIST_COLUMNS;
const REQUIRED_COLUMNS: ColumnKey[] = ["stem", "pairId", "side", "reason", "note"];

/** The side a row gives: one of the contract's sides, or null for an opening with one image. */
export type RowSide = CaptureQcSide | null;

export interface QcListRow {
  /** The row's line in a TSV file (the header is line 1), or its index plus one in a JSON array. */
  line: number;
  stem: string;
  pairId: string;
  sequence: number | null;
  side: RowSide;
  reason: CaptureQcReason;
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
  if (pairId === "") problems.push(`${where}: pairId is empty`);
  else if (chars(pairId) > MAX_FIELD_CHARS) problems.push(`${where}: pairId is longer than ${MAX_FIELD_CHARS} characters`);

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

  // A note is kept as given; only a note of nothing but white space is none.
  const noteText = raw.note ?? "";
  const note = noteText.trim() === "" ? null : noteText;
  if (note !== null && chars(note) > MAX_NOTE_CHARS) {
    problems.push(`${where}: the note is longer than ${MAX_NOTE_CHARS} characters`);
  }
  if (reason === "other" && note === null) problems.push(`${where}: a rejection for other needs a note`);

  const sequence = intCell(raw.sequence ?? "", "sequence", where, problems);
  const captuaRecordId = intCell(raw.captuaRecordId ?? "", "captua_record_id", where, problems);
  if (problems.length > before) return null;
  return { line, stem, pairId, sequence, side, reason, note, captuaRecordId };
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
      for (const k of REQUIRED_COLUMNS) if (!(k in raw) && k !== "note" && k !== "side") problems.push(`${where}: no ${k}`);
      const row = checkRow(raw, i + 1, where, problems);
      if (row) rows.push(row);
    });
  }
  if (rows.length === 0 && problems.length === 0) problems.push("the list has no rows");

  // One row per opening key.
  const keyOf = (r: QcListRow) => `${r.stem}\u0000${r.pairId}`;
  const first = new Map<string, number>();
  for (const r of rows) {
    const earlier = first.get(keyOf(r));
    if (earlier !== undefined) problems.push(`row at ${r.line} names ${r.stem} ${r.pairId} again (first at ${earlier})`);
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
  return render(sql`SELECT t.id AS id, t.slug AS slug, IFNULL(t.federation_id, '') AS federation_id,
      t.status AS status, IFNULL(t.disabled_at, '') AS disabled_at, t.digitization_enabled AS digitization_enabled,
      IFNULL(f.status, '') AS federation_status
    FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE t.slug = ${slug}`);
}

export function userQuery(email: string, federationId: string): string {
  return render(sql`SELECT u.id AS id, u.email AS email, IFNULL(u.name, '') AS name, u.tenant_id AS tenant_id,
      u.is_admin AS is_admin, u.is_super_admin AS is_super_admin, u.is_digitization_admin AS is_digitization_admin,
      IFNULL((SELECT m.role FROM federation_memberships m WHERE m.user_id = u.id AND m.federation_id = ${federationId}), '')
        AS federation_role
    FROM users u WHERE lower(u.email) = lower(${email})`);
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

export function decisionsQuery(tenantId: string, deliveryIds: string[]): string {
  return render(sql`SELECT delivery_id, captua_record_id, decision, IFNULL(reason, '') AS reason, IFNULL(side, '') AS side,
      IFNULL(note, '') AS note
    FROM capture_qc_decisions WHERE tenant_id = ${tenantId} AND delivery_id IN (${inList(deliveryIds)})`);
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
  tenantId: string;
  volumeId: string;
  deliveryId: string;
  writeId: string;
}): string {
  const details = JSON.stringify({ role: "steward", method: "POST", path: `/admin/capture/volumes/${a.volumeId}/decisions` });
  return render(sql`INSERT INTO audit_log (id, created_at, actor_user_id, actor_user_id_text, actor_tenant_id, action,
      target_tenant_id, target_object_kind, target_object_id, impersonation_session_id, details)
    SELECT ${a.id}, ${a.now}, ${a.userId}, ${a.email}, ${a.homeTenantId}, 'edit_on_behalf', ${a.tenantId}, 'grant_write',
      NULL, NULL, ${details}
    WHERE EXISTS (SELECT 1 FROM capture_qc_sets s WHERE s.tenant_id = ${a.tenantId} AND s.delivery_id = ${a.deliveryId}
      AND s.write_id = ${a.writeId})`);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export type SourceRecord = "production" | "staging";
export type RowReader = (sql: string) => Promise<Record<string, unknown>[]>;

export interface QcDecisionOptions {
  /** The tenant's slug. */
  slug: string;
  /** The decider's email. */
  decidedBy: string;
  sourceRecord: SourceRecord;
  apply: boolean;
  /** Names the report and SQL files: the list's digest, in hex. */
  listId: string;
}

export interface QcDecisionProviders {
  rows: RowReader;
  /** Writes a local file (the report, the SQL file). */
  writeFile: (path: string, text: string) => void;
  /** Applies the SQL file with `wrangler d1 execute --file`; `statements` are its statements, in order. */
  applyFile: (path: string, statements: string[]) => Promise<void> | void;
  now: () => number;
  newId: () => string;
}

export type Outcome = "decide" | "same" | "conflict" | "missing" | "locked";

export interface RowReport {
  line: number;
  stem: string;
  pairId: string;
  side: RowSide;
  reason: CaptureQcReason;
  note: string | null;
  /** The record the pair id names in the current delivery, when it names one. */
  captuaRecordId: number | null;
  outcome: Outcome;
  detail?: string;
}

export interface VolumeWrite {
  stem: string;
  volumeId: string;
  deliveryId: string;
  decisions: number;
  /** The set's revision as read: 0 when the delivery had no set. */
  revisionBefore: number;
  writeId: string;
  decisionsId: string;
  /** After `--apply`: whether the set carries this write and the expected rejections. */
  verified?: boolean;
  revisionAfter?: number;
}

export interface QcDecisionReport {
  listId: string;
  tenant: string;
  sourceRecord: SourceRecord;
  decidedBy: { id: string; email: string; name: string; access: "member" | "grant" };
  applied: boolean;
  counts: Record<Outcome, number>;
  rows: RowReport[];
  volumes: VolumeWrite[];
}

export const OUTPUT_DIR = ".import";

export function reportPath(listId: string): string {
  return `${OUTPUT_DIR}/qc-decisions_${listId}.json`;
}

export function sqlPath(listId: string): string {
  return `${OUTPUT_DIR}/qc-decisions_${listId}.sql`;
}

/** The list's id: the first 16 hex characters of the SHA-256 of its text. */
export async function listIdOf(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

interface Decider {
  id: string;
  email: string;
  name: string;
  /** The decider's home tenant when they decide under a grant; null for a user of the tenant. */
  grantHome: string | null;
}

/** Who decides, checked as the screen checks it (module header); a stop when they may not. */
async function resolveDecider(
  rows: RowReader,
  tenant: Record<string, unknown>,
  email: string,
): Promise<Decider> {
  const tenantId = text(tenant.id);
  const federationId = text(tenant.federation_id);
  const found = await rows(userQuery(email, federationId));
  if (found.length === 0) throw new QcDecisionStop(`No user has the email ${email}`);
  const u = found[0];
  const fedActive = federationId !== "" && text(tenant.federation_status) === "active";
  const steward = fedActive && text(u.federation_role) === "steward";
  const base = { id: text(u.id), email: text(u.email), name: displayName({ name: text(u.name) || null }) };
  if (text(u.tenant_id) === tenantId) {
    if (truthy(u.is_admin) || truthy(u.is_super_admin) || truthy(u.is_digitization_admin) || steward) {
      return { ...base, grantHome: null };
    }
    throw new QcDecisionStop(
      `${email} is a user of ${text(tenant.slug)} without digitization admin rights or a steward membership in its federation`,
    );
  }
  // A grant also needs the tenant not suspended (`resolveGrant`).
  const live = text(tenant.status) !== "suspended";
  if (steward && live) return { ...base, grantHome: text(u.tenant_id) };
  throw new QcDecisionStop(
    `${email} is not a user of ${text(tenant.slug)} and has no steward grant into it` +
      (steward && !live ? " (the tenant is suspended)" : ""),
  );
}

interface DeliveryState {
  id: string;
  stem: string;
  volumeId: string;
  revision: number;
  open: boolean;
  /** Record id to its sequence and status, from the delivery's records. */
  records: Map<number, { sequence: number; status: string }>;
  openings: number;
}

function rowLine(r: RowReport): string {
  const record = r.captuaRecordId === null ? "" : ` (record ${r.captuaRecordId})`;
  const what = `rejected, ${r.reason}${r.side ? `, side ${r.side}` : ""}`;
  return `  [${r.outcome}] line ${r.line} ${r.stem} ${r.pairId}${record}: ${what}${r.detail ? ` -- ${r.detail}` : ""}`;
}

/**
 * Records the list's rejections for one tenant: reads, sorts every row,
 * writes the report, and with `apply` writes the decisions in one file
 * and re-reads them. Returns the report.
 */
export async function recordQcDecisions(
  list: QcListRow[],
  options: QcDecisionOptions,
  providers: QcDecisionProviders,
  log: (line: string) => void,
): Promise<QcDecisionReport> {
  const { rows } = providers;
  const tenantRows = await rows(tenantQuery(options.slug));
  if (tenantRows.length === 0) throw new QcDecisionStop(`No tenant has the slug ${options.slug}`);
  const tenant = tenantRows[0];
  const t = text(tenant.id);
  // The tenant gate comes before any access check, as the app's tenant
  // loader refuses a disabled tenant before anyone is signed in.
  if (text(tenant.disabled_at) !== "") throw new QcDecisionStop(`The tenant ${options.slug} is disabled`);
  if (!truthy(tenant.digitization_enabled)) {
    throw new QcDecisionStop(`The tenant ${options.slug} does not have the digitization capability`);
  }
  const decider = await resolveDecider(rows, tenant, options.decidedBy);
  const now = providers.now();
  log(`Tenant ${options.slug} (${t}), database ${options.sourceRecord}`);
  log(
    `Decided by ${decider.email} (${decider.id}), told to the unit as "${decider.name}"` +
      (decider.grantHome ? `, under a steward grant from tenant ${decider.grantHome}` : ""),
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
  for (const part of chunks(held, READ_CHUNK)) {
    for (const r of await rows(openQuery(t, part.map((d) => d.volumeId), now))) {
      const d = part.find((x) => x.volumeId === text(r.id));
      if (d) d.open = truthy(r.open);
    }
  }
  for (const part of chunks([...deliveries.values()], RECORDS_CHUNK)) {
    for (const r of await rows(recordsQuery(t, part.map((d) => d.id)))) {
      const d = part.find((x) => x.id === text(r.id));
      if (!d || text(r.records) === "") continue;
      const records = JSON.parse(await unpackJson(text(r.records))) as Array<{ captuaRecordId: number; sequence: number; status: string }>;
      for (const rec of records) d.records.set(rec.captuaRecordId, { sequence: rec.sequence, status: rec.status });
      d.openings = records.filter((rec) => isOpening(rec.status)).length;
    }
  }

  // The records each row's pair id names, with their image counts.
  const byDelivery = new Map<string, Map<string, Map<number, number>>>();
  const deliveryIds = [...deliveries.values()].map((d) => d.id);
  const pairIds = [...new Set(list.filter((r) => deliveries.has(r.stem)).map((r) => r.pairId))];
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

  // The decisions already recorded on those deliveries.
  const recorded = new Map<string, { decision: string; reason: string; side: string; note: string }>();
  for (const part of chunks(deliveryIds, READ_CHUNK)) {
    for (const r of await rows(decisionsQuery(t, part))) {
      recorded.set(`${text(r.delivery_id)}\u0000${Number(r.captua_record_id)}`, {
        decision: text(r.decision),
        reason: text(r.reason),
        side: text(r.side),
        note: text(r.note),
      });
    }
  }

  // Each row's outcome.
  const reports: RowReport[] = list.map((row) => {
    const base: RowReport = {
      line: row.line,
      stem: row.stem,
      pairId: row.pairId,
      side: row.side,
      reason: row.reason,
      note: row.note,
      captuaRecordId: null,
      outcome: "decide",
    };
    const out = (outcome: Outcome, detail?: string): RowReport => ({ ...base, outcome, ...(detail ? { detail } : {}) });
    const d = deliveries.get(row.stem);
    if (!d) return out("missing", `no current delivery holds a volume ${row.stem}`);
    if (d.volumeId === "") return out("missing", `the delivery ${d.id} holds no pipeline volume`);
    const named = byDelivery.get(d.id)?.get(row.pairId);
    if (!named || named.size === 0) return out("missing", `no image of the delivery ${d.id} carries the pair id ${row.pairId}`);
    if (named.size > 1) {
      return out("conflict", `the pair id ${row.pairId} is on records ${[...named.keys()].sort((a, b) => a - b).join(", ")}`);
    }
    const [[recordId, images]] = [...named];
    base.captuaRecordId = recordId;
    const record = d.records.get(recordId);
    if (!record || !isOpening(record.status)) {
      return out("missing", `record ${recordId} is not an opening of the delivery ${d.id}${record ? ` (it is ${record.status})` : ""}`);
    }
    if (row.captuaRecordId !== null && row.captuaRecordId !== recordId) {
      return out("conflict", `the list gives record ${row.captuaRecordId}; the pair id is on record ${recordId}`);
    }
    if (row.sequence !== null && row.sequence !== record.sequence) {
      return out("conflict", `the list gives sequence ${row.sequence}; record ${recordId} has sequence ${record.sequence}`);
    }
    if (images > 1 && row.side === null) return out("conflict", `the opening has ${images} images, so the row needs left, right or both`);
    if (images <= 1 && row.side !== null) return out("conflict", `the opening has one image, so the row takes no side`);
    const existing = recorded.get(`${d.id}\u0000${recordId}`);
    if (existing) {
      const same =
        existing.decision === "rejected" &&
        existing.reason === row.reason &&
        existing.side === (row.side ?? "") &&
        existing.note === (row.note ?? "");
      if (same) return out("same");
      const was = existing.decision === "rejected" ? `rejected, ${existing.reason}${existing.side ? `, side ${existing.side}` : ""}` : existing.decision;
      return out("conflict", `record ${recordId} is already decided: ${was}${existing.note ? `, note ${JSON.stringify(existing.note)}` : ""}`);
    }
    if (!d.open) return out("locked", `a pipeline run has claimed or named the volume ${d.volumeId}`);
    return out("decide");
  });

  // Two rows that reach one opening are both conflicts.
  const seen = new Map<string, RowReport[]>();
  for (const r of reports) {
    if (r.captuaRecordId === null || r.outcome !== "decide") continue;
    const key = `${r.stem}\u0000${r.captuaRecordId}`;
    seen.set(key, [...(seen.get(key) ?? []), r]);
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.outcome = "conflict";
      r.detail = `lines ${group.map((g) => g.line).join(", ")} name record ${r.captuaRecordId}`;
    }
  }

  const counts: Record<Outcome, number> = { decide: 0, same: 0, conflict: 0, missing: 0, locked: 0 };
  for (const r of reports) counts[r.outcome]++;

  log("");
  log("Rows");
  for (const r of reports) log(rowLine(r));
  log("");
  log(
    `${counts.decide} to decide, ${counts.same} already the same, ${counts.conflict} conflicts, ` +
      `${counts.missing} missing, ${counts.locked} locked`,
  );

  // One write per volume with rows to decide.
  const volumes: VolumeWrite[] = [];
  const statements: string[] = [];
  const byStem = [...deliveries.values()].sort((x, y) => (x.stem < y.stem ? -1 : x.stem > y.stem ? 1 : 0));
  for (const d of byStem) {
    const decide = reports.filter((r) => r.stem === d.stem && r.outcome === "decide");
    if (decide.length === 0) continue;
    const writeId = providers.newId();
    const decisionsId = providers.newId();
    const planned: PlannedDecision[] = decide.map((r) => ({
      captuaRecordId: r.captuaRecordId as number,
      decision: "rejected",
      reason: r.reason,
      side: r.side,
      note: r.note,
      rotations: [],
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
    statements.push(...written);
    volumes.push({
      stem: d.stem,
      volumeId: d.volumeId,
      deliveryId: d.id,
      decisions: decide.length,
      revisionBefore: d.revision,
      writeId,
      decisionsId,
    });
  }

  const report: QcDecisionReport = {
    listId: options.listId,
    tenant: options.slug,
    sourceRecord: options.sourceRecord,
    decidedBy: { id: decider.id, email: decider.email, name: decider.name, access: decider.grantHome ? "grant" : "member" },
    applied: false,
    counts,
    rows: reports,
    volumes,
  };
  const finish = () => {
    providers.writeFile(reportPath(options.listId), JSON.stringify(report, null, 2) + "\n");
    log("");
    log(`Report: ${reportPath(options.listId)}`);
  };

  if (!options.apply) {
    finish();
    return report;
  }
  const blocking = counts.conflict + counts.missing + counts.locked;
  if (blocking > 0) {
    finish();
    throw new QcDecisionStop(
      `Nothing was written: ${counts.conflict} conflicts, ${counts.missing} missing and ${counts.locked} locked rows need resolving first`,
    );
  }
  if (statements.length === 0) {
    log("");
    log("Nothing to write: every row is already recorded.");
    finish();
    return report;
  }

  const file = sqlPath(options.listId);
  providers.writeFile(file, statements.join("\n") + "\n");
  log("");
  log(`Wrote ${statements.length} statements for ${volumes.length} volumes to ${file}`);
  await providers.applyFile(file, statements);
  report.applied = true;

  // Re-read every set by its write id.
  const sets = new Map<string, Record<string, unknown>>();
  for (const part of chunks(volumes.map((v) => v.writeId), READ_CHUNK)) {
    for (const r of await rows(verifyQuery(t, part))) sets.set(text(r.write_id), r);
  }
  log("");
  log("Re-read");
  for (const v of volumes) {
    const s = sets.get(v.writeId);
    v.verified = !!s && text(s.delivery_id) === v.deliveryId && Number(s.rejected_count) >= v.decisions;
    if (s) v.revisionAfter = Number(s.revision);
    log(
      `  [${v.verified ? "ok" : "not written"}] ${v.stem}: ${v.decisions} rejections` +
        (s ? `, set revision ${v.revisionBefore} to ${text(s.revision)}, state ${text(s.state)}` : ", the set does not carry this write"),
    );
  }
  finish();
  if (volumes.some((v) => !v.verified)) {
    throw new QcDecisionStop(
      "The re-read does not show every write: a decision or a run was recorded on a volume between the read and the write. Run the list again to see where it stands",
    );
  }
  return report;
}

// @version v0.8.0
