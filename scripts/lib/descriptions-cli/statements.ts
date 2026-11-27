/**
 * Scripts — the SQL of the command line's descriptions
 *
 * This module turns a plan (`./plan.ts`) into the statements of one SQL
 * file, applied with `wrangler d1 execute --file`, which D1 runs as one
 * unit: opening guards, the writes, closing guards. Each guard is a
 * SELECT that fails on `json('ABORT: …')`, so a failing guard leaves
 * nothing written.
 *
 * Opening guards (after the guard on who acts, which `./run.ts` puts
 * first): every description the plan read by id, whatever its rows'
 * status, still holds every column read (`READ`: its code, level,
 * version, place in the tree and fields); every child of a parent the
 * file creates under still holds the columns read (`CHILD_READ`: its
 * code, parent, position, child count and version), and the parent has
 * no other; the tenant still has the descriptive standard the values
 * were checked against; every repository an update-field row names is
 * still the tenant's; no description holds an id or, in the tenant, a code the
 * file creates; every description the file deletes still holds every
 * column read (`FULL_READ`), and no pipeline volume, recipe declaration
 * or entry names it, and no description has it as parent; the tenant's
 * federation, its manifest address and bucket, when the file gives
 * images; no description of the tenant's federation, as it is when the
 * file is applied, but one the file deletes has a former code of the
 * file's rows as its reference code; and each changelog
 * row the file writes is still absent.
 * The changelog rows read as evidence need no guard: the changelog is
 * append-only.
 *
 * Writes to the descriptions read, one record at a time, one UPDATE
 * each, conditioned on the tenant, the id and the version read, with the
 * next version (`nextVersion` of the version read):
 *   - the fields the file changes, as the description editor's save
 *     writes them (`app/routes/_auth.admin.descriptions.$id.tsx`,
 *     `update`), and the digital flag an `update-field` row changes
 *     (`FLAG_FIELDS`, written 0 or 1, a boolean in the diff), then the
 *     address and the digital flag a `set-images` row gives and the
 *     `legacy_ids` an `add-former-code` row makes, with
 *     `updated_by` the acting user, and one `changelog`
 *     row for the record, kind `update`, no run id, the acting user, the
 *     clock, the rows' notes (each distinct note once, joined by a line
 *     break; NULL when the rows give none), and the diff `computeDiff`
 *     gives over the editor's keys, in `FIELDS` order and then
 *     `hasDigital` (a boolean, as the editor's diff has it) and
 *     `legacyIds`, under the id `descriptionJournalId` gives;
 *   - for a parent the file creates under or deletes from, the child
 *     count raised by the records created and lowered by the records
 *     deleted, as the editor's create and delete move it, `updated_by`
 *     left as it is;
 *   - for a child an `after` moves down, its new position, as the
 *     editor's reorder moves one (`_auth.admin.descriptions.tsx`,
 *     `reorder`): the position and the version, `updated_by` left as it
 *     is, no changelog row.
 * A record the file both changes and moves, or changes and creates
 * under, takes all of it in its one UPDATE. The full-text index follows
 * through its own trigger on the UPDATE (`descriptions_fts_au`).
 *
 * Creates, parents before children, as the editor's create writes
 * (`app/routes/_auth.admin.descriptions.new.tsx`): an INSERT of the
 * record with its id, the tenant, the repository, the parent, the
 * position, root, depth and path, the children the file creates under
 * it as its child count, the level, code, local identifier and fields,
 * `is_published`, the acting user as creator and updater, and the clock
 * as created and updated; then its `create` changelog row as the import
 * writes one (`processCreateBatch`: `createSnapshotDiff` of the values
 * inserted) with the row's `after` as written under the key `after`, no
 * run id, the row's note, under the id
 * `descriptionCreateJournalId` gives. The full-text index follows
 * through its insert trigger (`descriptions_fts_ai`). A record a
 * `set-images` row gives images takes its address and the digital flag
 * in its INSERT.
 *
 * Deletes, after every other write, as the editor's delete deletes: a
 * DELETE conditioned on the tenant, the id and the version read (the
 * links go with it by the schema's cascade), and a `delete` changelog
 * row with every value the record held (`deleteSnapshotDiff`), the row's
 * note, under the id `descriptionDeleteJournalId` gives.
 *
 * Last, as the editor's create and delete do in their batches, the
 * descriptions of the federation that record a created or deleted code
 * as a former one take a new version (`formerCodeHoldersFollow`), except
 * the descriptions the file writes
 * above, which have taken theirs: every record takes one new version per
 * file, however many reasons the file has to write it.
 *
 * Closing guards: each record changed holds its fields as planned, its
 * new version and the acting user; each record written holds its
 * position, child count and new version as planned; each record created
 * holds the values planned; each record deleted is gone, and its
 * survivor records its code as a former one; each changelog row is
 * there.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import { changelog, descriptions, type ChangelogActedAs } from "../../../app/db/schema";
import { computeDiff } from "../../../app/lib/changelog.server";
import { formerCodeHoldersFollow } from "../../../app/lib/export/former-codes.server";
import { nextVersion } from "../../../app/lib/record-version.server";
import { createSnapshotDiff } from "../../../app/lib/stewardship.server";
import { chunks, composer, guard, idList, matchingGuards, oversizedStatements, render } from "../authority-merges";
import { escapeSql } from "../sql";
import { FORMER_REFERENCE_PROVIDER } from "../../../app/lib/export/former-codes.server";
import { FIELDS, UPDATE_FIELDS } from "./change-file";
import { FULL_READ, deleteDiffOf, placeCheck } from "./images";
import { CHILD_READ, READ, type CreatePlan, type DescriptionsPlan, type DescriptionsState, type StoredDescription } from "./plan";
import { appendAll } from "../arrays";

export interface BuildOptions {
  userId: string;
  now: number;
  tenantId: string;
  /** How the actor acted (`changelog.acted_as`): null for a member. */
  actedAs?: ChangelogActedAs | null;
}

export interface RecordWrite {
  id: string;
  code: string;
  from: number;
  to: number;
  /** The fields written, by the editor's keys (the digital flag as a boolean); empty when the file changes none. */
  set: Record<string, string | boolean | null>;
  diff: Record<string, { old: unknown; new: unknown }>;
  note: string | null;
  journalId: string;
  /** The new child count, for a parent the file creates under. */
  childCount?: number;
  /** The new position, for a child an `after` moves. */
  position?: number;
  /** The snapshot the write is conditioned on. */
  read: StoredDescription;
}

export interface CreateWrite {
  plan: CreatePlan;
  /** The record's columns, by the schema's keys, in the editor's order. */
  values: Record<string, unknown>;
}

export interface BuildResult {
  sql: string[];
  oversized: Array<{ index: number; bytes: number; head: string }>;
  records: RecordWrite[];
  created: CreateWrite[];
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export const GUARD_MESSAGES = {
  read: "a description the file reads has changed since it was read",
  children: "a child of a parent the file creates under has changed since it was read",
  standard: "the tenant's descriptive standard has changed since it was read",
  repositories: "a repository the file names has changed since it was read",
  absent: "a description the file creates, or its code, is already there",
  journal: "a changelog row the file writes is already there",
  deleted: "a description the file deletes has changed since it was read",
  pipeline: "a pipeline record names a description the file deletes",
  deletedChildren: "a description the file deletes has a child",
  place: "the federation's manifest address or bucket has changed since it was read",
  formerLive: "a former code the file adds is the reference code of a description of the federation",
} as const;

const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";

/** The records read that the plan writes: fields, child counts and positions, one write per record. */
export function recordWritesOf(plan: DescriptionsPlan, state: DescriptionsState, now: number): RecordWrite[] {
  const out = new Map<string, RecordWrite>();
  const writeOf = (id: string, read: StoredDescription): RecordWrite => {
    let w = out.get(id);
    if (!w) {
      const from = Number(read.updated_at);
      w = {
        id, code: text(read.reference_code), from, to: nextVersion(from, now), set: {}, diff: {}, note: null,
        journalId: state.journalIds.get(id) ?? "", read,
      };
      out.set(id, w);
    }
    return w;
  };

  const byRecord = new Map<string, DescriptionsPlan["rows"]>();
  for (const p of plan.rows) {
    // A set-images row of a record the file creates is written with its create.
    if (p.status !== "update" || !p.description) continue;
    const id = text(p.description.id);
    byRecord.set(id, [...(byRecord.get(id) ?? []), p]);
  }
  for (const [id, rows] of byRecord) {
    const d = rows[0].description!;
    const w = writeOf(id, d);
    const before: Record<string, unknown> = {};
    for (const f of UPDATE_FIELDS) {
      const p = rows.find((x) => x.spec?.field === f.field);
      if (!p) continue;
      // A flag is a boolean on either side, as the editor's diff has it.
      w.set[f.key] = f.flag ? p.next === "1" : p.next ?? null;
      before[f.key] = f.flag ? truthy(d[f.column]) : d[f.column];
    }
    // The address and the digital flag a set-images row gives, and the former codes added, after the fields.
    const images = rows.find((x) => x.images)?.images;
    if (images?.set.iiifManifestUrl) {
      w.set.iiifManifestUrl = images.set.iiifManifestUrl;
      before.iiifManifestUrl = d.iiif_manifest_url;
    }
    if (images?.set.hasDigital) {
      w.set.hasDigital = true;
      before.hasDigital = truthy(d.has_digital);
    }
    const former = plan.ops.formerCodes.get(id);
    if (former) {
      w.set.legacyIds = former.next;
      before.legacyIds = d.legacy_ids;
    }
    const notes = [...new Set(rows.map((x) => x.row.cells.changelog_note).filter(Boolean))];
    w.diff = computeDiff(before, w.set) ?? {};
    w.note = notes.length > 0 ? notes.join("\n") : null;
  }
  for (const [id, k] of plan.newChildren) {
    const d = state.byId.get(id)!;
    writeOf(id, d).childCount = Number(d.child_count) + k;
  }
  for (const [id, k] of plan.ops.lostChildren) {
    const d = state.byId.get(id)!;
    const w = writeOf(id, d);
    w.childCount = Math.max(0, (w.childCount ?? Number(d.child_count)) - k);
  }
  for (const m of plan.moves) writeOf(m.id, state.byId.get(m.id) ?? m.read).position = m.to;
  return [...out.values()];
}

/** The records the plan creates, each with the columns the editor's create writes. */
export function createWritesOf(plan: DescriptionsPlan, opts: BuildOptions): CreateWrite[] {
  return plan.creates.map((c) => {
    const { title, ...rest } = c.fields;
    const values: Record<string, unknown> = {
      tenantId: opts.tenantId,
      id: c.id,
      repositoryId: c.repositoryId,
      parentId: c.parentId,
      position: c.position,
      rootDescriptionId: c.rootDescriptionId,
      depth: c.depth,
      childCount: c.childCount,
      pathCache: c.pathCache,
      descriptionLevel: c.descriptionLevel,
      referenceCode: c.code,
      ...(c.localIdentifier !== null ? { localIdentifier: c.localIdentifier } : {}),
      title,
      ...rest,
      ...(c.hasDigital ? { hasDigital: true } : {}),
      isPublished: c.isPublished,
      createdBy: opts.userId,
      updatedBy: opts.userId,
      createdAt: opts.now,
      updatedAt: opts.now,
    };
    return { plan: c, values };
  });
}

/**
 * A create's changelog diff: the import's snapshot of the values
 * inserted (`createSnapshotDiff`), and under `after` the row's `after`
 * as written, blank included, which a rerun compares with the row
 * (`./plan.ts`). `after` is no column of `descriptions`; the revert of a
 * create reads only the snapshot's `depth` and `parentId`.
 */
export function createDiffOf(c: CreateWrite): Record<string, { old: unknown; new: unknown }> {
  return { ...createSnapshotDiff(c.values), after: { old: null, new: c.plan.row.cells.after } };
}

const COLUMN_OF: Record<string, string> = { ...Object.fromEntries(FIELDS.map((f) => [f.key, f.column])), hasDigital: "has_digital", legacyIds: "legacy_ids" };
/** The columns a created record is checked on after the write. */
const CREATED_COLUMNS = [
  "id", "tenant_id", "reference_code", "parent_id", "position", "depth", "child_count", "root_description_id", "path_cache",
  "description_level", "is_published", "created_by", "updated_by", "created_at", "updated_at", ...FIELDS.map((f) => f.column), "has_digital",
];

/** Every statement of the file. */
export function buildDescriptionStatements(plan: DescriptionsPlan, state: DescriptionsState, opts: BuildOptions): BuildResult {
  const db = composer();
  const T = escapeSql(opts.tenantId);
  const records = recordWritesOf(plan, state, opts.now);
  const created = createWritesOf(plan, opts);
  const changed = records.filter((r) => Object.keys(r.set).length > 0);
  const before: string[] = [];
  const writes: string[] = [];
  const after: string[] = [];

  // Opening guards: what was read still holds.
  // One snapshot per description (`readDescriptionsState`).
  const read: Map<string, StoredDescription> = state.byId;
  appendAll(before, matchingGuards("descriptions", READ, [...read.values()].map((d) => READ.map((c) => d[c])), GUARD_MESSAGES.read));
  // The children of every parent the file creates under, and no other.
  for (const parentId of new Set(plan.creates.map((c) => c.parentId))) {
    const children = state.children.get(parentId);
    if (!children) continue;
    appendAll(before, matchingGuards("descriptions", CHILD_READ, children.map((d) => CHILD_READ.map((c) => d[c])), GUARD_MESSAGES.children));
    before.push(guard(
      `(SELECT count(*) FROM descriptions WHERE tenant_id = ${T} AND parent_id = ${escapeSql(parentId)}) = ${children.length}`,
      GUARD_MESSAGES.children,
    ));
  }
  before.push(guard(
    `(SELECT descriptive_standard FROM tenants WHERE id = ${T}) IS ${escapeSql(state.standard)}`,
    GUARD_MESSAGES.standard,
  ));
  const repositories = [...new Set([
    ...changed.map((r) => r.set.repositoryId).filter((v): v is string => !!v),
  ])];
  appendAll(before, matchingGuards("repositories", ["id", "tenant_id"], repositories.map((id) => [id, opts.tenantId]), GUARD_MESSAGES.repositories));
  for (const part of chunks(created, 100)) {
    before.push(guard(
      `NOT EXISTS (SELECT 1 FROM descriptions WHERE id IN (${idList(part.map((c) => c.plan.id))})) ` +
        `AND NOT EXISTS (SELECT 1 FROM descriptions WHERE tenant_id = ${T} AND reference_code IN (${idList(part.map((c) => c.plan.code))}))`,
      GUARD_MESSAGES.absent,
    ));
  }
  // Each description to delete holds every column read, and no pipeline record names it.
  const deletes = plan.ops.deletes;
  appendAll(before, matchingGuards("descriptions", FULL_READ, deletes.map((x) => FULL_READ.map((c) => x.read[c])), GUARD_MESSAGES.deleted));
  for (const part of chunks(deletes.map((x) => x.id), 100)) {
    const ids = idList(part);
    before.push(guard(
      `NOT EXISTS (SELECT 1 FROM pipeline_volumes WHERE description_id IN (${ids}) OR recipe_scope_description_id IN (${ids})) ` +
        `AND NOT EXISTS (SELECT 1 FROM pipeline_recipe_declarations WHERE scope_description_id IN (${ids})) ` +
        `AND NOT EXISTS (SELECT 1 FROM entries WHERE promoted_description_id IN (${ids}))`,
      GUARD_MESSAGES.pipeline,
    ));
  }
  for (const part of chunks(deletes.map((x) => x.id), 100)) {
    before.push(guard(`NOT EXISTS (SELECT 1 FROM descriptions WHERE parent_id IN (${idList(part)}))`, GUARD_MESSAGES.deletedChildren));
  }
  // The manifests' address and bucket, and the tenant's federation, as the plan read them.
  const place = state.ops?.place;
  if (place && plan.ops.images.length > 0) {
    before.push(guard(`(${placeCheck(place, opts.tenantId).replace("count(*) AS n", "count(*)")}) = 1`, GUARD_MESSAGES.place));
  }
  // No description of the federation holds a former code the file adds as its reference code, but one the file deletes.
  // Every code of the file's add-former-code rows, held already or added, and the tenant's federation as it is when the file is applied.
  const formerCodes = [...new Set(plan.rows.filter((r) => r.formerCode && r.status !== "refused").map((r) => r.formerCode!))];
  for (const part of chunks(formerCodes, 100)) {
    before.push(guard(
      `NOT EXISTS (SELECT 1 FROM descriptions WHERE tenant_id IN (SELECT m.id FROM tenants m WHERE m.federation_id = ` +
        `(SELECT t.federation_id FROM tenants t WHERE t.id = ${T})) ` +
        `AND reference_code IN (${idList(part)})` +
        (deletes.length > 0 ? ` AND id NOT IN (${idList(deletes.map((x) => x.id))})` : "") + ")",
      GUARD_MESSAGES.formerLive,
    ));
  }
  const journalIds = [...changed.map((r) => r.journalId), ...created.map((c) => c.plan.journalId), ...deletes.map((x) => x.journalId)];
  for (const ids of chunks(journalIds, 200)) {
    before.push(guard(`NOT EXISTS (SELECT 1 FROM changelog WHERE id IN (${idList(ids)}))`, GUARD_MESSAGES.journal));
  }

  // The records read: the editor's save, the parent's count, the reorder.
  for (const r of records) {
    const fields = Object.keys(r.set).length > 0;
    writes.push(render(db.update(descriptions).set({
      ...r.set,
      ...(fields ? { updatedBy: opts.userId } : {}),
      ...(r.childCount !== undefined ? { childCount: r.childCount } : {}),
      ...(r.position !== undefined ? { position: r.position } : {}),
      updatedAt: r.to,
    } as Partial<typeof descriptions.$inferInsert>).where(
      and(eq(descriptions.tenantId, opts.tenantId), eq(descriptions.id, r.id), eq(descriptions.updatedAt, r.from)),
    )));
    if (!fields) continue;
    writes.push(render(db.insert(changelog).values({
      id: r.journalId, recordId: r.id, recordType: "description", userId: opts.userId, note: r.note, diff: JSON.stringify(r.diff),
      runId: null, kind: "update", createdAt: opts.now, actedAs: opts.actedAs ?? null,
    })));
  }

  // The editor's create, parents first, each with its create changelog row.
  for (const c of created) {
    writes.push(render(db.insert(descriptions).values(c.values as typeof descriptions.$inferInsert)));
    writes.push(render(db.insert(changelog).values({
      id: c.plan.journalId, recordId: c.plan.id, recordType: "description", userId: opts.userId,
      note: c.plan.row.cells.changelog_note || null, diff: JSON.stringify(createDiffOf(c)), runId: null, kind: "create",
      createdAt: opts.now, actedAs: opts.actedAs ?? null,
    })));
  }
  // The editor's delete, after every other write: the record (its links follow by the schema's cascade) and its delete changelog row.
  for (const x of deletes) {
    writes.push(render(db.delete(descriptions).where(
      and(eq(descriptions.tenantId, opts.tenantId), eq(descriptions.id, x.id), eq(descriptions.updatedAt, Number(x.read.updated_at))),
    )));
    writes.push(render(db.insert(changelog).values({
      id: x.journalId, recordId: x.id, recordType: "description", userId: opts.userId, note: x.row.cells.changelog_note || null,
      diff: JSON.stringify(deleteDiffOf(x.read)), runId: null, kind: "delete", createdAt: opts.now, actedAs: opts.actedAs ?? null,
    })));
  }
  // A record the file writes already takes its one new version above.
  const holders = formerCodeHoldersFollow(db, opts.tenantId, [...created.map((c) => c.plan.code), ...deletes.map((x) => x.code)], opts.now);
  if (holders) {
    const s = render(holders);
    writes.push(records.length === 0 ? s : `${s.slice(0, -1)} AND "descriptions"."id" NOT IN (${idList(records.map((r) => r.id))});`);
  }

  // Closing guards: the file did what it planned.
  const columns = ["id", "tenant_id", "updated_at", "updated_by", ...FIELDS.map((f) => f.column), "has_digital", "legacy_ids"];
  appendAll(after, matchingGuards("descriptions", columns, changed.map((r) => {
    const value = (column: string) => {
      const key = Object.keys(COLUMN_OF).find((k) => COLUMN_OF[k] === column);
      return key && key in r.set ? r.set[key] : r.read[column];
    };
    return [r.id, opts.tenantId, r.to, opts.userId, ...FIELDS.map((f) => value(f.column)), value("has_digital"), value("legacy_ids")];
  }), "a description the file changes is not as planned"));
  appendAll(after, matchingGuards("descriptions", ["id", "tenant_id", "updated_at", "position", "child_count"], records.map((r) => [
    r.id, opts.tenantId, r.to, r.position ?? r.read.position, r.childCount ?? r.read.child_count,
  ]), "a description the file writes is not as planned"));
  appendAll(after, matchingGuards("descriptions", CREATED_COLUMNS, created.map((c) => {
    const v = c.values;
    return [
      c.plan.id, opts.tenantId, c.plan.code, c.plan.parentId, c.plan.position, c.plan.depth, c.plan.childCount, c.plan.rootDescriptionId,
      c.plan.pathCache, c.plan.descriptionLevel, c.plan.isPublished ? 1 : 0, opts.userId, opts.userId, opts.now, opts.now,
      ...FIELDS.map((f) => (f.key in v ? v[f.key] : f.key === "genre" ? "[]" : null)), c.plan.hasDigital ? 1 : 0,
    ];
  }), "a description the file creates is not as planned"));
  for (const part of chunks(deletes, 100)) {
    after.push(guard(`NOT EXISTS (SELECT 1 FROM descriptions WHERE id IN (${idList(part.map((x) => x.id))}))`, "a description the file deletes is still there"));
  }
  // Each survivor records the deleted code as a former one once the file has written.
  for (const x of deletes) {
    after.push(guard(
      `EXISTS (SELECT 1 FROM descriptions s, json_each(CASE WHEN json_valid(s.legacy_ids) THEN ` +
        `CASE WHEN json_type(s.legacy_ids) = 'array' THEN s.legacy_ids ELSE '[]' END ELSE '[]' END) j ` +
        `WHERE s.id = ${escapeSql(x.survivorId)} AND s.tenant_id = ${T} AND CASE WHEN j.type = 'object' THEN ` +
        `json_extract(j.value, '$.provider') = ${escapeSql(FORMER_REFERENCE_PROVIDER)} AND CAST(json_extract(j.value, '$.id') AS TEXT) = ${escapeSql(x.code)} ELSE 0 END)`,
      "a survivor does not record the code of the description joined into it",
    ));
  }
  for (const ids of chunks(journalIds, 200)) {
    after.push(guard(`(SELECT count(*) FROM changelog WHERE id IN (${idList(ids)})) = ${ids.length}`, "a changelog row the file writes is not there"));
  }

  const sql = [...before, ...writes, ...after];
  return { sql, oversized: oversizedStatements(sql), records, created };
}

// @version v0.9.0
