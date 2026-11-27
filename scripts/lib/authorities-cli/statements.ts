/**
 * Scripts — the SQL of the command line's authority changes
 *
 * This module turns a plan (`./plan.ts`) into the statements of one SQL
 * file, applied with `wrangler d1 execute --file`, which D1 runs as one
 * unit: opening guards, the writes, closing guards. Each guard is a
 * SELECT that fails on `json('ABORT: …')`, so a failing guard leaves
 * nothing written.
 *
 * The rule the guards follow: every row the plan reads is guarded in
 * the file as read, so nothing the read-back could reject is found only
 * after the commit. The file opens with guards that every entity read
 * still holds every column read (`RECORD_READ`, its version among them);
 * that every function row the plan holds, however it was read and merge
 * losers' included, holds every column and its rowid as read (the rowid
 * orders the functions text the changelog gives); that every record read
 * in full holds as many rows as read; that each id the plan found absent
 * (a row a rerun found gone, an id a move or copy would make) and each
 * changelog id the file writes are still absent; and that each term an
 * update looked up is still found as it was (`termLookupGuards`). What the plan reads besides is
 * the changelog, which is append-only. The merges' own statements follow,
 * as the reviewed merge builds them (`buildEntityStatements`), with
 * their guards; the records they name are named by no other row. What an
 * entity merge writes: each loser's links of the tenant's descriptions
 * (moved to the survivor or deleted as collisions), the links naming a
 * deleted one in `related_to` (repointed to the kept link), the loser's
 * function rows (moved), the loser's and survivor's rows, and new
 * changelog and ledger rows. Each link written is guarded positively, as
 * `./places.ts` guards a place merge's (`tenantLinkGuards`): it is a link
 * in a description whose `tenant_id` is the acting tenant's id, a
 * constant in the guard; the merge's own guards hold each loser link,
 * kept link and pointing link to its columns as read, and both records
 * to every column read. Each link a merge row cites as its evidence is
 * guarded to be there, and the merge's ledger row carries the evidence
 * in `detail.evidence`, as description ids, beside the file and line.
 *
 * Writes, in file order: a move to one target changes the row's
 * `entity_id` (`movedEntityFunctions`); a move to several and a copy
 * insert the row's columns on each target under its `functionRowId`; a
 * target that holds the function by then (`TargetPlan.foldInto`) gets no
 * row: the held row takes the fields the plan found it lacking, and its
 * `updated_at` the run's clock, and the record an `update` changelog row
 * of `{ functionFields: { old, new } }`, the row's id, text and filled
 * fields before and after, and a new version; a move onto such a target
 * deletes the source row; a move to several and a delete delete the
 * source row; a rename sets the
 * row's `function` and, when the row gives one, its `honorific`, and
 * moves its `updated_at` to the run's clock. Each function row
 * that writes gives each record it changes an `update` changelog row of
 * `{ functions: { old, new } }`, the record's functions as text, one per
 * line in entry order, before and after the row, as the entity editor
 * journals a change of functions, with the row's note; a move's or a
 * delete's row on its source has the id `functionJournalId` gives, the
 * evidence a rerun reads. A rename's changelog row, under the id
 * `functionJournalId` gives, records `functions` when the text changes
 * and `functionHonorific` (old and new) when the honorific does; it is
 * written even when only the honorific changes, and the record takes a
 * new version either way. Each update row
 * writes the fields that change and an `update` changelog row of them,
 * under the id `entityUpdateJournalId` gives (made from the file's name
 * and the record), the evidence a rerun reads.
 * Every record whose function rows or fields change takes
 * `nextVersion` of the `updated_at` read, so the publish export sees
 * the change and a save that read the record before fails its version
 * check. Terms an update points at or leaves are recounted.
 *
 * The file closes with guards that each moved row names its target, each
 * inserted row is on its target with its text, each filled row holds
 * the fields planned, each renamed row holds
 * its new text and honorific, each deleted row is gone,
 * every record read in full (merge losers aside, which the merge's own
 * guards leave empty) holds exactly the rows planned, each by id, owner
 * and text, kept rows and rows already in place included, and each
 * record changed holds its new version and planned name.
 *
 * The additions (`./additions.ts`: new records, document links, place
 * links and relations) add their own opening guards after these, their
 * writes after the field updates' and the merges', records before the
 * links that name them, and their closing guards after these. The place
 * rows (`./places.ts`) and the link moves (`./link-moves.ts`) follow
 * them: their opening guards after the additions', the place merges
 * after the entity merges, the place creates and updates before the
 * additions' writes, since a place link may name a place the file
 * creates, and the link moves after them, since a move's target may be a
 * record the file creates; then their closing guards. The record deletes
 * (`./deletes.ts`) come last of all: their opening guards after the link
 * moves', their writes after every other write, their closing guards
 * after every other closing guard. The split and separate ledger rows
 * (`./ledger.ts`) come between the link moves and the deletes, in each
 * of the three parts.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { changelog, entities, entityFunctions, type ChangelogActedAs } from "../../../app/db/schema";
import { movedEntityFunctions, nextVersion } from "../../../app/lib/entity-functions.server";
import { composeJournalEntry } from "../../../app/lib/stewardship.server";
import { recountStatement } from "../authority-links";
import { chunks, composer, guard, idList, matchingGuards, oversizedStatements, render } from "../authority-merges";
import { buildEntityStatements, functionRowOf } from "../entity-merges";
import { COMPARED_FIELD_COLUMNS, FILLABLE_FUNCTION_FIELDS, FUNCTION_FIELD_COLUMNS, type FillableFunctionField } from "../../../app/lib/function-duplicates";
import { termLookupGuards, text } from "../entity-splits";
import { buildAdditionStatements } from "./additions";
import { buildDeleteStatements } from "./deletes";
import { buildLedgerStatements } from "./ledger";
import { buildLinkMoveStatements } from "./link-moves";
import { buildPlaceStatements, tenantLinkGuards } from "./places";
import { heldKey, heldLinks } from "../../../app/lib/pair-merge.server";
import {
  FUNCTION_COLUMNS,
  RECORD_READ,
  functionFieldsOf,
  functionsTextOf,
  type AuthoritiesPlan,
  type AuthoritiesState,
  type StoredFunction,
} from "./plan";
import { appendAll, maxOf } from "../arrays";
import { escapeSql } from "../sql";

export interface BuildOptions {
  userId: string;
  /** How the actor acted (`changelog.acted_as`): null for a member. */
  actedAs?: ChangelogActedAs | null;
  now: number;
  tenantId: string;
  federationId: string;
  file: string;
  /** The owner a new record takes: null where the federation shares its authorities. */
  owner?: string | null;
}

export interface BuildResult {
  sql: string[];
  oversized: Array<{ index: number; bytes: number; head: string }>;
  /** Entity id → its version as read and the version the file leaves it with, for every record the file changes. */
  versions: Map<string, { from: number; to: number }>;
  movedRows: number;
  insertedRows: number;
  deletedRows: number;
  /** Function rows whose text or honorific a rename sets. */
  renamedRows: number;
  /** Function rows the merges move from losers to survivors. */
  mergeMovedRows: number;
  /** Rows held by a target that take fields from a row folding into them, by moves and copies. */
  filledRows: number;
  /** Losers' function rows the merges fold into a row of the same function on their survivor. */
  mergeFolded: Array<{ loserCode: string; survivorCode: string; functionId: string; function: string; into: string; filled: string[]; conflicts: Array<{ field: string; held: string; incoming: string }> }>;
  /** Records created, document links, place links and relations written. */
  created: number;
  linked: number;
  placeLinked: number;
  related: number;
  /** Places created, updated and merged away, and the links the place merges move and drop. */
  placesCreated: number;
  placesUpdated: number;
  placesMerged: number;
  placeLinksMovedByMerges: number;
  placeLinksDroppedByMerges: number;
  /** Place id → its version as read and the version the file leaves it with. */
  placeVersions: Map<string, { from: number; to: number }>;
  /** Description links moved, dropped and updated, and relations dropped, by the link rows. */
  linksMoved: number;
  linksDropped: number;
  linksUpdated: number;
  relationsDropped: number;
  /** Entities and places deleted. */
  entitiesDeleted: number;
  placesDeleted: number;
  /** Ledger rows of operation `split` and `separate` written, by the link moves and the backfill rows. */
  splitsRecorded: number;
  separatesRecorded: number;
}

/** Every statement of the file. */
export function buildAuthorityStatements(
  plan: AuthoritiesPlan,
  state: AuthoritiesState,
  opts: BuildOptions,
  db: DrizzleD1Database<any> = composer(),
): BuildResult {
  const F = opts.federationId;
  const scope = eq(entities.federationId, F);
  const before: string[] = [];
  const writes: any[] = [];
  const raw: string[] = [];
  const after: string[] = [];
  const versions = new Map<string, { from: number; to: number }>();
  const bump = (id: string) => {
    if (versions.has(id)) return;
    const from = Number(state.byId.get(id)!.updated_at);
    versions.set(id, { from, to: nextVersion(from, opts.now) });
  };

  // Each record's rows as the file goes, in entry order: new rows take
  // rowids past every one read, in the order inserted.
  const sim = new Map<string, Array<{ id: string; function: unknown; rid: number }>>();
  let nextRid = 1 + maxOf([0, ...[...state.functions.values()].map((f) => f.rid)]);
  const setOf = (id: string) => {
    let set = sim.get(id);
    if (!set) {
      set = (state.fullSets.get(id) ?? []).map((f) => ({ id: text(f.id), function: f.function, rid: f.rid }));
      sim.set(id, set);
    }
    return set;
  };
  const textOf = (id: string) => functionsTextOf([...setOf(id)].sort((a, b) => a.rid - b.rid));

  const moved: Array<[string, string]> = [];
  const inserted: Array<[string, string, unknown]> = [];
  const deleted: string[] = [];
  const renamed: Array<[string, string, unknown, unknown]> = [];
  // Each filled row: its record, and its fields as the file leaves them.
  const filled = new Map<string, { entityId: string; function: unknown; fields: Partial<Record<FillableFunctionField, string | null>> }>();
  const fieldsOfRow = (id: string) => filled.get(id)?.fields ?? (state.functions.has(id) ? functionFieldsOf(state.functions.get(id)!) : {});
  const changedSets = new Set<string>();
  const journalIds: string[] = [];

  for (const p of plan.rows) {
    if (p.status === "rename" && p.targets[0]?.foldInto) {
      // Renamed onto a function the record holds: the held row takes what it lacks, and the renamed row goes.
      const f = p.fn as StoredFunction;
      const fid = text(f.id);
      const source = p.entityId!;
      const fold = p.targets[0].foldInto;
      const beforeText = textOf(source);
      const diff: Record<string, unknown> = {};
      if (Object.keys(fold.set).length > 0) {
        const old = { ...fieldsOfRow(fold.id) };
        const now = { ...old, ...fold.set };
        writes.push(db.update(entityFunctions).set({ ...fold.set, updatedAt: opts.now })
          .where(and(eq(entityFunctions.id, fold.id), eq(entityFunctions.entityId, source))));
        filled.set(fold.id, { entityId: source, function: fold.function, fields: now });
        const pick = (v: Partial<Record<FillableFunctionField, string | null>>) =>
          Object.fromEntries(Object.keys(fold.set).map((k) => [k, v[k as FillableFunctionField] ?? null]));
        diff.functionFields = { old: { id: fold.id, function: fold.function, ...pick(old) }, new: { id: fold.id, function: fold.function, ...pick(now) } };
      }
      writes.push(db.delete(entityFunctions).where(and(eq(entityFunctions.id, fid), eq(entityFunctions.entityId, source))));
      const set = setOf(source);
      set.splice(set.findIndex((x) => x.id === fid), 1);
      deleted.push(fid);
      changedSets.add(source);
      bump(source);
      // Under the id that names this row and its record: a rerun's evidence.
      writes.push(db.insert(changelog).values({
        id: p.journalId!, recordId: source, recordType: "entity", userId: opts.userId, note: p.note,
        diff: JSON.stringify({ functions: { old: beforeText, new: textOf(source) }, ...diff, foldedInto: { old: null, new: [{ record: source, row: fold.id }] } }),
        runId: null, kind: "update", createdAt: opts.now, actedAs: opts.actedAs ?? null,
      }));
      journalIds.push(p.journalId!);
      continue;
    }
    if (p.status === "rename") {
      // The row keeps its id, rowid and owner; its text, honorific and updated_at change.
      const f = p.fn as StoredFunction;
      const fid = text(f.id);
      const source = p.entityId!;
      const set = p.rename ?? {};
      const before = textOf(source);
      writes.push(db.update(entityFunctions).set({
        ...(set.function !== undefined ? { function: set.function } : {}),
        ...(set.honorific !== undefined ? { honorific: set.honorific } : {}),
        updatedAt: opts.now,
      }).where(and(eq(entityFunctions.id, fid), eq(entityFunctions.entityId, source))));
      const row = setOf(source).find((x) => x.id === fid)!;
      if (set.function !== undefined) row.function = set.function;
      const after = textOf(source);
      renamed.push([fid, source, row.function, set.honorific !== undefined ? set.honorific : f.honorific]);
      changedSets.add(source);
      bump(source);
      const diff = {
        ...(after !== before ? { functions: { old: before, new: after } } : {}),
        ...(set.honorific !== undefined ? { functionHonorific: { old: f.honorific, new: set.honorific } } : {}),
      };
      // Under the id that names this row and its record: a rerun's evidence.
      writes.push(db.insert(changelog).values({
        id: p.journalId!, recordId: source, recordType: "entity", userId: opts.userId, note: p.note, diff: JSON.stringify(diff),
        runId: null, kind: "update", createdAt: opts.now, actedAs: opts.actedAs ?? null,
      }));
      journalIds.push(p.journalId!);
      continue;
    }
    if (p.status !== "move" && p.status !== "copy" && p.status !== "delete") continue;
    const f = p.fn as StoredFunction;
    const source = p.entityId!;
    const fid = text(f.id);
    const touched: string[] = [];
    const old = new Map<string, string | null>();
    const touch = (id: string) => {
      if (!old.has(id)) {
        old.set(id, textOf(id));
        touched.push(id);
      }
    };
    const arriving = p.targets.filter((t) => t.arrives && !t.foldInto);
    // A target whose held row takes fields from this one: an update of the row and of the record.
    for (const t of p.targets) {
      if (!t.foldInto || Object.keys(t.foldInto.set).length === 0) continue;
      const into = t.foldInto.id;
      const before = { ...fieldsOfRow(into) };
      const after = { ...before, ...t.foldInto.set };
      writes.push(db.update(entityFunctions).set({ ...t.foldInto.set, updatedAt: opts.now })
        .where(and(eq(entityFunctions.id, into), eq(entityFunctions.entityId, t.id))));
      filled.set(into, { entityId: t.id, function: t.foldInto.function, fields: after });
      changedSets.add(t.id);
      bump(t.id);
      const pick = (v: Partial<Record<FillableFunctionField, string | null>>) =>
        Object.fromEntries(Object.keys(t.foldInto!.set).map((k) => [k, v[k as FillableFunctionField] ?? null]));
      writes.push(composeJournalEntry(db, {
        recordId: t.id, recordType: "entity", userId: opts.userId, kind: "update",
        diff: { functionFields: { old: { id: into, function: t.foldInto.function, ...pick(before) }, new: { id: into, function: t.foldInto.function, ...pick(after) } } },
        note: p.note, now: opts.now, actedAs: opts.actedAs ?? null,
      }));
    }

    if (p.status === "move" && p.targets.length === 1 && !p.targets[0].foldInto) {
      const t = p.targets[0];
      touch(source);
      touch(t.id);
      appendAll(writes, movedEntityFunctions(db, source, t.id, [fid], scope));
      const set = setOf(source);
      const at = set.findIndex((x) => x.id === fid);
      const [row] = set.splice(at, 1);
      setOf(t.id).push(row);
      moved.push([fid, t.id]);
    } else {
      if (p.status === "move" || p.status === "delete") touch(source);
      for (const t of arriving) {
        touch(t.id);
        writes.push(db.insert(entityFunctions).values({
          id: t.rowId, entityId: t.id, honorific: f.honorific as string | null, function: text(f.function), dateStart: f.date_start as string | null,
          dateEnd: f.date_end as string | null, dateNote: f.date_note as string | null, certainty: f.certainty as never, source: f.source as string | null,
          notes: f.notes as string | null, createdAt: Number(f.created_at), updatedAt: Number(f.updated_at),
        }));
        setOf(t.id).push({ id: t.rowId, function: f.function, rid: nextRid++ });
        inserted.push([t.rowId, t.id, f.function]);
      }
      if (p.status === "move" || p.status === "delete") {
        writes.push(db.delete(entityFunctions).where(and(eq(entityFunctions.id, fid), eq(entityFunctions.entityId, source))));
        const set = setOf(source);
        set.splice(set.findIndex((x) => x.id === fid), 1);
        deleted.push(fid);
      }
    }
    for (const id of touched) {
      const next = textOf(id);
      if (next === old.get(id)) continue;
      changedSets.add(id);
      bump(id);
      const entry = { recordId: id, recordType: "entity", userId: opts.userId, kind: "update" as const, diff: { functions: { old: old.get(id), new: next } }, note: p.note, now: opts.now, actedAs: opts.actedAs ?? null };
      if (id === source && p.journalId && (p.status === "move" || p.status === "delete")) {
        // The source's row, under the id that names this row and the record it left: a rerun's evidence.
        // A row folded into a target's row: the record and the row it went into, which a rerun checks.
        const folds = p.targets.filter((t) => t.foldInto).map((t) => ({ record: t.id, row: t.foldInto!.id }));
        writes.push(db.insert(changelog).values({
          id: p.journalId, recordId: entry.recordId, recordType: entry.recordType, userId: entry.userId, note: entry.note,
          diff: JSON.stringify({ ...entry.diff, ...(folds.length > 0 ? { foldedInto: { old: null, new: folds } } : {}) }),
          runId: null, kind: entry.kind, createdAt: entry.now, actedAs: entry.actedAs,
        }));
        journalIds.push(p.journalId);
      } else {
        writes.push(composeJournalEntry(db, entry));
      }
    }
  }

  // Field updates.
  const fieldSets = new Map<string, Record<string, unknown>>();
  const terms = new Set<string>();
  const lookups = new Map<string, string | null>();
  for (const p of plan.rows) {
    if (p.status !== "update" || p.op !== "update-entity") continue;
    const o = p.fields!;
    bump(o.id);
    fieldSets.set(o.id, o.set);
    for (const t of o.termsTouched) terms.add(t);
    if (typeof o.set.primaryFunction === "string") {
      lookups.set(o.set.primaryFunction, "primaryFunctionId" in o.set ? (o.set.primaryFunctionId as string | null) : (state.byId.get(o.id)!.primary_function_id as string | null));
    }
    // Under the id made from the file and the record (`entityUpdateJournalId`): a rerun's evidence.
    writes.push(db.insert(changelog).values({
      id: p.journalId!, recordId: o.id, recordType: "entity", userId: opts.userId, note: o.note, diff: JSON.stringify(o.changes),
      runId: null, kind: "update", createdAt: opts.now, actedAs: opts.actedAs ?? null,
    }));
    journalIds.push(p.journalId!);
  }
  for (const [id, v] of versions) {
    writes.push(db.update(entities).set({ ...(fieldSets.get(id) ?? {}), updatedAt: v.to }).where(and(scope, eq(entities.id, id))));
  }
  for (const t of terms) raw.push(recountStatement(t, F, opts.tenantId, opts.now));

  // Merges, as the reviewed merge builds them.
  let mergeSql: string[] = [];
  let mergeMovedRows = 0;
  let mergeFolded: BuildResult["mergeFolded"] = [];
  if (plan.merges.groups.length > 0) {
    const losers = plan.merges.groups.flatMap((g) => g.pairs.map((x) => x.loser.id));
    const survivors = plan.merges.groups.map((g) => g.survivor.id);
    const functionsByEntity = new Map([...losers, ...survivors].map((id) => [
      id, (state.fullSets.get(id) ?? state.mergeTargetSets.get(id) ?? []).map((f) => functionRowOf(f as Record<string, unknown>)),
    ]));
    const lineOf = (ref: string) => plan.mergeRows.get(ref)!.line;
    const noteOf = (ref: string) => plan.rows.find((r) => r.row === plan.mergeRows.get(ref))!.note;
    const built = buildEntityStatements(plan.merges, state.links, {
      userId: opts.userId, actedAs: opts.actedAs ?? null, now: opts.now, tenantId: opts.tenantId, functionsByEntity, pointing: state.pointing, staleNamed: state.staleNamed,
      source: {
        reason: (row) => noteOf(row.ref),
        detail: (row) => ({ file: opts.file, line: lineOf(row.ref), evidence: plan.mergeEvidence.get(row.ref) }),
        labelNote: (rows) => [...new Set(rows.map((r) => noteOf(r.ref)))].join("\n"),
      },
    }, db);
    // Every link the entity merges write, each loser's links (moved or dropped) and the links whose
    // related_to a drop repoints, is in a description of the acting tenant: a constant, not a value read.
    const written: string[] = [];
    for (const g of plan.merges.groups) {
      const holds = heldLinks(state.links.get(g.survivor.id) ?? []);
      for (const x of g.pairs) {
        for (const l of state.links.get(x.loser.id) ?? []) {
          written.push(l.id);
          if (holds.has(heldKey(l))) {
            for (const p of state.pointing.get(l.id) ?? []) written.push(p.id);
          } else holds.set(heldKey(l), l.id);
        }
      }
    }
    appendAll(before, tenantLinkGuards("description_entities", written, opts.tenantId));
    // Every link a merge row cites as its evidence is still there, on one of the tenant's descriptions, as read.
    const cited = [...plan.mergeEvidence.values()].flatMap((e) =>
      Object.entries(e.descriptions).flatMap(([entityId, ids]) => ids.map((d) => [entityId, d] as [string, string])));
    for (const part of chunks(cited, 200)) {
      before.push(guard(
        `NOT EXISTS (SELECT 1 FROM (VALUES ${part.map(([e, d]) => `(${escapeSql(e)}, ${escapeSql(d)})`).join(", ")}) v ` +
          `WHERE NOT EXISTS (SELECT 1 FROM description_entities t JOIN descriptions d ON d.id = t.description_id ` +
          `WHERE t.entity_id = v.column1 AND t.description_id = v.column2 AND d.tenant_id = ${escapeSql(opts.tenantId)}))`,
        "a description a merge cites as evidence is not linked to its record",
      ));
    }
    mergeSql = built.sql;
    mergeMovedRows = built.movedFunctions;
    mergeFolded = built.foldedFunctions.map((f) => ({
      loserCode: f.loserCode, survivorCode: f.survivorCode, functionId: f.row.id, function: f.row.function, into: f.into,
      filled: Object.keys(f.filled).map((k) => FUNCTION_FIELD_COLUMNS[k as FillableFunctionField]),
      conflicts: f.conflicts.map((x) => ({ field: COMPARED_FIELD_COLUMNS[x.field], held: x.held, incoming: x.incoming })),
    }));
    for (const g of plan.merges.groups) {
      for (const e of [g.survivor, ...g.pairs.map((x) => x.loser)]) versions.set(e.id, { from: e.updatedAt, to: nextVersion(e.updatedAt, opts.now) });
    }
  }

  // Opening guards: what was read still holds.
  appendAll(before, matchingGuards(
    "entities",
    RECORD_READ,
    [...state.byId.values()].map((e) => RECORD_READ.map((c) => e[c])),
    "an entity the file reads has changed since it was read",
  ));
  // Every function row the plan holds, however it was read (by id, or
  // among a record's rows, merge losers' included), on every column and
  // its rowid, which orders the functions text; and each record read in
  // full by count, so no row has been added.
  const full = [...state.fullSets.keys()];
  for (const ids of chunks(full, 200)) {
    const n = ids.reduce((sum, id) => sum + state.fullSets.get(id)!.length, 0);
    before.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(ids)})) = ${n}`, "a record's function rows have changed since they were read"));
  }
  appendAll(before, matchingGuards(
    "entity_functions",
    [...FUNCTION_COLUMNS, "rowid"],
    [...state.functions.values()].map((f) => [...FUNCTION_COLUMNS.map((c) => f[c]), f.rid]),
    "a function row has changed since it was read",
  ));
  for (const ids of chunks(journalIds, 200)) {
    before.push(guard(`NOT EXISTS (SELECT 1 FROM changelog WHERE id IN (${idList(ids)}))`, "a changelog row the file writes is already there"));
  }
  const absent = [...new Set(plan.rows.flatMap((p) => (p.status === "refused" ? [] : p.absent)))];
  for (const ids of chunks(absent, 200)) {
    before.push(guard(`NOT EXISTS (SELECT 1 FROM entity_functions WHERE id IN (${idList(ids)}))`, "a function row the plan found absent is there"));
  }
  appendAll(before, termLookupGuards(lookups, F));

  // Closing guards: the file did what it planned.
  appendAll(after, matchingGuards("entity_functions", ["id", "entity_id"], moved, "a moved function row does not name its target"));
  appendAll(after, matchingGuards("entity_functions", ["id", "entity_id", "function"], inserted, "a function row is not on its target as planned"));
  appendAll(after, matchingGuards("entity_functions", ["id", "entity_id", "function", "honorific"], renamed, "a renamed function row does not hold its new text and honorific"));
  appendAll(after, matchingGuards(
    "entity_functions",
    ["id", "entity_id", ...FILLABLE_FUNCTION_FIELDS.map((k) => FUNCTION_FIELD_COLUMNS[k])],
    [...filled].map(([id, x]) => [id, x.entityId, ...FILLABLE_FUNCTION_FIELDS.map((k) => x.fields[k] ?? null)]),
    "a filled function row does not hold the fields planned",
  ));
  for (const ids of chunks(deleted, 200)) {
    after.push(guard(`(SELECT count(*) FROM entity_functions WHERE id IN (${idList(ids)})) = 0`, "a function row the file removes is still there"));
  }
  // Every row the plan expects each record read in full to hold after the
  // file, kept rows and rows already in place included, and no other.
  const losers = new Set(plan.merges.groups.flatMap((g) => g.pairs.map((x) => x.loser.id)));
  const remaining = full.filter((id) => !losers.has(id));
  for (const ids of chunks(remaining, 200)) {
    const n = ids.reduce((sum, id) => sum + setOf(id).length, 0);
    after.push(guard(`(SELECT count(*) FROM entity_functions WHERE entity_id IN (${idList(ids)})) = ${n}`, "a record does not hold the function rows planned"));
  }
  appendAll(after, matchingGuards(
    "entity_functions",
    ["id", "entity_id", "function"],
    remaining.flatMap((id) => setOf(id).map((x) => [x.id, id, x.function])),
    "a function row the file expects to remain is not as planned",
  ));
  const own = [...versions].filter(([id]) => !plan.merges.groups.some((g) => g.survivor.id === id || g.pairs.some((x) => x.loser.id === id)));
  appendAll(after, matchingGuards(
    "entities",
    ["id", "display_name", "merged_into", "updated_at"],
    own.map(([id, v]) => {
      const set = fieldSets.get(id) ?? {};
      return [id, "displayName" in set ? set.displayName : state.byId.get(id)!.display_name, null, v.to];
    }),
    "a record the file changes is not as planned",
  ));

  const additions = buildAdditionStatements(plan.additions, state.additions, {
    userId: opts.userId, actedAs: opts.actedAs ?? null, now: opts.now, tenantId: opts.tenantId, federationId: F, owner: opts.owner ?? null, recordColumns: RECORD_READ,
  });

  const placed = buildPlaceStatements(plan.places, state.places, {
    userId: opts.userId, actedAs: opts.actedAs ?? null, now: opts.now, tenantId: opts.tenantId, federationId: F, owner: opts.owner ?? null, file: opts.file,
  });
  const moves = buildLinkMoveStatements(plan.linkMoves, state.linkMoves, { userId: opts.userId, now: opts.now, tenantId: opts.tenantId, actedAs: opts.actedAs ?? null });
  const ledger = buildLedgerStatements(plan.ledger, { userId: opts.userId, now: opts.now, federationId: F });
  const deletes = buildDeleteStatements(plan.deletes, { userId: opts.userId, now: opts.now, tenantId: opts.tenantId, federationId: F });

  const sql = [
    ...before, ...additions.before, ...placed.before, ...moves.before, ...ledger.before, ...deletes.before,
    ...mergeSql, ...placed.merges, ...writes.map(render), ...raw, ...placed.writes, ...additions.writes, ...moves.writes, ...ledger.writes, ...deletes.writes,
    ...after, ...additions.after, ...placed.after, ...moves.after, ...ledger.after, ...deletes.after,
  ];
  return {
    sql, oversized: oversizedStatements(sql), versions, movedRows: moved.length, insertedRows: inserted.length, deletedRows: deleted.length, renamedRows: renamed.length, mergeMovedRows,
    filledRows: filled.size, mergeFolded,
    created: additions.created, linked: additions.linked, placeLinked: additions.placeLinked, related: additions.related,
    placesCreated: placed.created, placesUpdated: placed.updated, placesMerged: placed.merged, placeLinksMovedByMerges: placed.linksMoved,
    placeLinksDroppedByMerges: placed.linksDropped, placeVersions: placed.versions, linksMoved: moves.moved, linksDropped: moves.dropped,
    linksUpdated: moves.updated, relationsDropped: moves.relationsDropped, entitiesDeleted: deletes.entitiesDeleted, placesDeleted: deletes.placesDeleted,
    splitsRecorded: ledger.splits, separatesRecorded: ledger.separates,
  };
}

// @version v0.9.0
