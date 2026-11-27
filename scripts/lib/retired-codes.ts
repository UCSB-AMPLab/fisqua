/**
 * Retired Codes — Pairing, Planning and SQL
 *
 * This module deals with the planning half of the command that records,
 * on Fisqua's own records, the codes zasqua.org has published since April
 * 2026. The site was built from the Django catalogue's export of
 * 2026-04-21, whose entities and places carry five-character codes
 * (`ne-u3ufz`, `nl-qfsbu`) and whose descriptions carry reference codes
 * some of which Fisqua has since corrected. Fisqua's records keep their
 * own six-character codes; the published ones go into `legacy_ids` so
 * that the publish export can write a map from each old address to the
 * new one.
 *
 * Pairing is by Django id. Every record in the site's files carries its
 * Django primary key as `id`; every Fisqua record imported from Django
 * carries the same number in `legacy_ids` under the provider
 * `django-zasqua`. A file record must pair with exactly one Fisqua
 * record. A description that absorbed another holds both Django ids, so
 * the absorbed description's reference code pairs with the survivor and
 * is recorded there.
 *
 * What is appended, and nothing else is written:
 *
 * - entities and places: `{"provider":"zasqua-2026-04","id":"<code>"}`;
 * - descriptions whose reference code differs from Fisqua's:
 *   `{"provider":"former-reference-code","id":"<old code>"}`.
 *
 * An entry already present is not written again, so a second run plans
 * nothing. A paired entity or place that has been merged into another
 * (`merged_into` set) has its code recorded on the record it was merged
 * into, following the chain to the live one, because neither merge path
 * carries `legacy_ids` to the survivor.
 *
 * Dangling place codes: the site's place links can name a code that
 * `places.json` has no record for (`nl-z9ruz`, Palma, Django 97587). For
 * each such code, every link naming it is matched against Fisqua's links
 * of the same description and role, leaving out the places that pair
 * with a code the site links that description to in that role. The links name the
 * reference code the site published, so the description is paired
 * through the site's descriptions file by Django id, never by Fisqua's
 * current reference code; places are compared as the live records merges
 * left, since a merge moves its links to the survivor. A code whose
 * links all point to the same single Fisqua place is recorded on that
 * place; any other code is reported and left alone.
 *
 * The plan refuses, and nothing is written, when a file record pairs with
 * no Fisqua record or with more than one, when a merge chain leads to a
 * record that is not there, when a five-character code appears twice
 * across the files, or when a code to be recorded equals a live code:
 * an entity or place code anywhere in the record's federation, or a
 * reference code in the description's tenant. An entry already recorded
 * is not refused even when it equals a live code (the AHR recodes of
 * 2026-10-23 shifted carpeta codes along, so an old code can be another
 * record's current one); it is reported as a warning.
 *
 * `buildStatements` writes, for each record that gains entries, a guard,
 * one changelog row and one UPDATE, all three conditional on `legacy_ids`
 * and `updated_at` still holding the values that were read and, for an
 * entity or place, on its still being unmerged; the guard fails the whole
 * file when the record no longer qualifies, so a record changed or merged
 * between the read and the apply is never skipped in silence or written
 * in place of its survivor. A guard before and after also compares the
 * number of records holding each provider, counted through the JSON as
 * the planner counts it, with what the plan expects, and further guards
 * repeat the live-code refusal at apply time, so a record recoded after
 * the read to a code another record is about to record fails the file.
 * Only `legacy_ids` and the update stamp are set; codes are never written.
 * Each changelog row records in `acted_as` how its user acted on the
 * record's workspace, which `retiredCodeActing` resolves as the command
 * line's other nouns resolve the actor, with the guards that open the
 * file.
 *
 * `streamJsonArray` reads a top-level JSON array one element at a time,
 * so the 223 MB descriptions file never sits in memory whole.
 *
 * @version v0.9.0
 */

import { createReadStream } from "node:fs";
import { escapeSql } from "./sql";
import { appendAll } from "./arrays";
import type { ChangelogActedAs } from "../../app/db/schema";
import { AuthorityLinksStop, changelogActedAsOf, readScope, resolveActor, type Actor, type RowReader } from "./authority-links";
import { actorGuards, scopeGuards } from "./cli/access-guards";

export const DJANGO_PROVIDER = "django-zasqua";
export const RETIRED_CODE_PROVIDER = "zasqua-2026-04";
export const FORMER_REFERENCE_PROVIDER = "former-reference-code";

export type AuthorityKind = "entity" | "place";
export type RecordKind = AuthorityKind | "description";

/** A Fisqua entity or place as read from D1. */
export interface AuthorityRow {
  id: string;
  federationId: string;
  tenantId: string | null;
  code: string | null;
  mergedInto: string | null;
  legacyIds: string;
  updatedAt: number;
}

/** A Fisqua description as read from D1. */
export interface DescriptionRow {
  id: string;
  tenantId: string;
  referenceCode: string;
  legacyIds: string;
  updatedAt: number;
}

/** An entity or place record from the site's files: Django id and code. */
export interface FileAuthority {
  djangoId: string;
  code: string;
}

/** A description record from the site's file: Django id and reference code. */
export interface FileDescription {
  djangoId: string;
  referenceCode: string;
}

/** One place link from the site's `place_links.json`. */
export interface SiteLink {
  referenceCode: string;
  placeCode: string;
  role: string;
}

/** One link Fisqua holds: the description's id, the place and the role. */
export interface FisquaLink {
  descriptionId: string;
  placeId: string;
  role: string;
}

export interface LegacyEntry {
  provider: string;
  id: string | number;
}

export interface Refusal {
  kind: RecordKind;
  reason: string;
  detail: string;
}

/** One record that gains entries. */
export interface RecordWrite {
  kind: RecordKind;
  id: string;
  federationId: string | null;
  tenantId: string | null;
  /** The record's current code (entity/place code or reference code), for the report. */
  code: string | null;
  oldLegacyIds: string;
  newLegacyIds: string;
  /** The update stamp read, which the writes also require. */
  updatedAt: number;
  added: LegacyEntry[];
}

export interface MergeFollowed {
  kind: AuthorityKind;
  djangoId: string;
  retiredCode: string;
  pairedId: string;
  pairedCode: string | null;
  survivorId: string;
  survivorCode: string | null;
}

export interface DanglingCode {
  code: string;
  links: number;
  /** The Fisqua place the code resolves to, or null when it does not resolve to exactly one. */
  placeId: string | null;
  placeCode: string | null;
  candidates: string[];
  note: string;
}

export interface KindCounts {
  fileRecords: number;
  toWrite: number;
  alreadyPresent: number;
  unchanged: number;
  refused: number;
}

export interface KindPlan {
  kind: RecordKind;
  provider: string;
  counts: KindCounts;
  writes: RecordWrite[];
  /** Entries already present (code, record), up to the samples kept. */
  presentSamples: Array<{ code: string; recordId: string }>;
  refusals: Refusal[];
  /** Entries already recorded that equal a live code: written before, reported, never refused. */
  warnings: Refusal[];
  mergesFollowed: MergeFollowed[];
  /** Records holding the provider before the apply, and after. */
  holdingBefore: number;
  holdingAfter: number;
}

/** Parse a `legacy_ids` value; a value that is not a JSON array is refused by the caller. */
export function parseLegacyIds(value: string): LegacyEntry[] {
  const parsed: unknown = JSON.parse(value === "" ? "[]" : value);
  if (!Array.isArray(parsed)) throw new Error(`legacy_ids is not a JSON array: ${value}`);
  return parsed as LegacyEntry[];
}

/** The Django ids a `legacy_ids` value holds, as strings. */
export function djangoIdsOf(value: string): string[] {
  return parseLegacyIds(value)
    .filter((e) => e && e.provider === DJANGO_PROVIDER)
    .map((e) => String(e.id));
}

function holds(entries: LegacyEntry[], provider: string, id?: string): boolean {
  return entries.some((e) => e.provider === provider && (id === undefined || String(e.id) === id));
}

/** Index records by each Django id they hold. */
export function indexByDjangoId<T extends { legacyIds: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    for (const id of djangoIdsOf(row.legacyIds)) {
      const list = out.get(id);
      if (list) list.push(row);
      else out.set(id, [row]);
    }
  }
  return out;
}

/**
 * Refuse a five-character code that appears more than once across the
 * entity file, the place file and the dangling place codes.
 */
export function duplicateCodes(codes: Array<{ kind: AuthorityKind; code: string }>): Refusal[] {
  const seen = new Map<string, AuthorityKind[]>();
  for (const { kind, code } of codes) {
    const list = seen.get(code);
    if (list) list.push(kind);
    else seen.set(code, [kind]);
  }
  const out: Refusal[] = [];
  for (const [code, kinds] of seen) {
    if (kinds.length > 1) {
      out.push({ kind: kinds[0], reason: "code appears twice", detail: `${code} (${kinds.join(", ")})` });
    }
  }
  return out;
}

/**
 * The live record a record was merged into, following `merged_into` to
 * the end of the chain; the record itself when it is not merged; null
 * when the chain leads to a record that is not there or loops.
 */
export function survivorOf(row: AuthorityRow, byId: Map<string, AuthorityRow>): AuthorityRow | null {
  let current = row;
  const seen = new Set<string>([row.id]);
  while (current.mergedInto) {
    const next = byId.get(current.mergedInto);
    if (!next || seen.has(next.id)) return null;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/** Live entity and place codes, by federation. */
export function liveCodesByFederation(entities: AuthorityRow[], places: AuthorityRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const row of [...entities, ...places]) {
    if (!row.code) continue;
    let set = out.get(row.federationId);
    if (!set) out.set(row.federationId, (set = new Set()));
    set.add(row.code);
  }
  return out;
}

const SAMPLES = 10;

/** Accumulates the entries to append to each record. */
class WriteSet<R extends { id: string; legacyIds: string }> {
  private readonly pending = new Map<string, { row: R; entries: LegacyEntry[]; added: LegacyEntry[] }>();

  /** Whether the record holds the entry, or it is already pending. */
  has(row: R, entry: LegacyEntry): boolean {
    const slot = this.pending.get(row.id);
    const entries = slot ? slot.entries : parseLegacyIds(row.legacyIds);
    return holds(entries, entry.provider, String(entry.id));
  }

  /** Add an entry unless the record holds it or it is already pending; true when added. */
  add(row: R, entry: LegacyEntry): boolean {
    let slot = this.pending.get(row.id);
    if (!slot) {
      slot = { row, entries: parseLegacyIds(row.legacyIds), added: [] };
      this.pending.set(row.id, slot);
    }
    if (holds(slot.entries, entry.provider, String(entry.id))) return false;
    slot.entries.push(entry);
    slot.added.push(entry);
    return true;
  }

  rows(): Array<{ row: R; entries: LegacyEntry[]; added: LegacyEntry[] }> {
    return [...this.pending.values()].filter((s) => s.added.length > 0);
  }
}

function holdingAfter<R extends { id: string; legacyIds: string }>(
  rows: R[],
  provider: string,
  writes: Array<{ row: R }>,
): { before: number; after: number } {
  const before = rows.filter((r) => holds(parseLegacyIds(r.legacyIds), provider)).length;
  const gained = writes.filter((w) => !holds(parseLegacyIds(w.row.legacyIds), provider)).length;
  return { before, after: before + gained };
}

/**
 * Plan the retired codes for one authority kind. `extra` carries codes
 * from elsewhere (resolved dangling codes) already tied to a Fisqua
 * record id.
 */
export function planAuthorities(
  kind: AuthorityKind,
  fileRecords: FileAuthority[],
  rows: AuthorityRow[],
  liveCodes: Map<string, Set<string>>,
  extra: Array<{ code: string; recordId: string }> = [],
): KindPlan {
  const byDjango = indexByDjangoId(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const refusals: Refusal[] = [];
  const warnings: Refusal[] = [];
  const mergesFollowed: MergeFollowed[] = [];
  const presentSamples: Array<{ code: string; recordId: string }> = [];
  const set = new WriteSet<AuthorityRow>();
  let alreadyPresent = 0;
  let toWrite = 0;

  const record = (code: string, paired: AuthorityRow, djangoId: string | null): void => {
    const target = survivorOf(paired, byId);
    if (!target) {
      refusals.push({ kind, reason: "merge chain broken", detail: `${code} → ${paired.id} (merged_into ${paired.mergedInto})` });
      return;
    }
    if (target.id !== paired.id) {
      mergesFollowed.push({
        kind, djangoId: djangoId ?? "", retiredCode: code, pairedId: paired.id, pairedCode: paired.code,
        survivorId: target.id, survivorCode: target.code,
      });
    }
    const entry = { provider: RETIRED_CODE_PROVIDER, id: code };
    const isLive = liveCodes.get(target.federationId)?.has(code) ?? false;
    const detail = `${code} in federation ${target.federationId}`;
    if (set.has(target, entry)) {
      alreadyPresent++;
      if (presentSamples.length < SAMPLES) presentSamples.push({ code, recordId: target.id });
      if (isLive) warnings.push({ kind, reason: "already recorded, and a live code", detail });
      return;
    }
    if (isLive) {
      refusals.push({ kind, reason: "retired code is a live code", detail });
      return;
    }
    set.add(target, entry);
    toWrite++;
  };

  for (const file of fileRecords) {
    const matches = byDjango.get(file.djangoId) ?? [];
    if (matches.length === 0) {
      refusals.push({ kind, reason: "no Fisqua pair", detail: `Django ${file.djangoId} (${file.code})` });
      continue;
    }
    if (matches.length > 1) {
      refusals.push({
        kind, reason: "two Fisqua pairs",
        detail: `Django ${file.djangoId} (${file.code}): ${matches.map((m) => m.code ?? m.id).join(", ")}`,
      });
      continue;
    }
    record(file.code, matches[0], file.djangoId);
  }
  for (const { code, recordId } of extra) {
    const row = byId.get(recordId);
    if (!row) {
      refusals.push({ kind, reason: "no Fisqua record", detail: `${code} → ${recordId}` });
      continue;
    }
    record(code, row, null);
  }

  const pending = set.rows();
  const writes: RecordWrite[] = pending.map(({ row, entries, added }) => ({
    kind, id: row.id, federationId: row.federationId, tenantId: row.tenantId, code: row.code,
    oldLegacyIds: row.legacyIds, newLegacyIds: JSON.stringify(entries), updatedAt: row.updatedAt, added,
  }));
  const { before, after } = holdingAfter(rows, RETIRED_CODE_PROVIDER, pending);
  return {
    kind, provider: RETIRED_CODE_PROVIDER,
    counts: {
      fileRecords: fileRecords.length + extra.length, toWrite, alreadyPresent,
      unchanged: 0, refused: refusals.length,
    },
    writes, presentSamples, refusals, warnings, mergesFollowed, holdingBefore: before, holdingAfter: after,
  };
}

/**
 * Plan the former reference codes: every file description paired by
 * Django id whose reference code differs from the paired record's.
 */
export function planDescriptions(fileRecords: FileDescription[], rows: DescriptionRow[]): KindPlan {
  const byDjango = indexByDjangoId(rows);
  const liveByTenant = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = liveByTenant.get(r.tenantId);
    if (!s) liveByTenant.set(r.tenantId, (s = new Set()));
    s.add(r.referenceCode);
  }
  const refusals: Refusal[] = [];
  const warnings: Refusal[] = [];
  const presentSamples: Array<{ code: string; recordId: string }> = [];
  const set = new WriteSet<DescriptionRow>();
  let toWrite = 0;
  let alreadyPresent = 0;
  let unchanged = 0;

  for (const file of fileRecords) {
    const matches = byDjango.get(file.djangoId) ?? [];
    if (matches.length !== 1) {
      refusals.push({
        kind: "description",
        reason: matches.length === 0 ? "no Fisqua pair" : "two Fisqua pairs",
        detail: `Django ${file.djangoId} (${file.referenceCode})${matches.length ? ": " + matches.map((m) => m.referenceCode).join(", ") : ""}`,
      });
      continue;
    }
    const row = matches[0];
    if (row.referenceCode === file.referenceCode) {
      unchanged++;
      continue;
    }
    const entry = { provider: FORMER_REFERENCE_PROVIDER, id: file.referenceCode };
    const isLive = liveByTenant.get(row.tenantId)?.has(file.referenceCode) ?? false;
    const detail = `${file.referenceCode} (now ${row.referenceCode}) is live in tenant ${row.tenantId}`;
    if (set.has(row, entry)) {
      alreadyPresent++;
      if (presentSamples.length < SAMPLES) presentSamples.push({ code: file.referenceCode, recordId: row.id });
      if (isLive) warnings.push({ kind: "description", reason: "already recorded, and a live code", detail });
      continue;
    }
    if (isLive) {
      refusals.push({ kind: "description", reason: "retired code is a live code", detail });
      continue;
    }
    set.add(row, entry);
    toWrite++;
  }

  const pending = set.rows();
  const writes: RecordWrite[] = pending.map(({ row, entries, added }) => ({
    kind: "description", id: row.id, federationId: null, tenantId: row.tenantId, code: row.referenceCode,
    oldLegacyIds: row.legacyIds, newLegacyIds: JSON.stringify(entries), updatedAt: row.updatedAt, added,
  }));
  const { before, after } = holdingAfter(rows, FORMER_REFERENCE_PROVIDER, pending);
  return {
    kind: "description", provider: FORMER_REFERENCE_PROVIDER,
    counts: { fileRecords: fileRecords.length, toWrite, alreadyPresent, unchanged, refused: refusals.length },
    writes, presentSamples, refusals, warnings, mergesFollowed: [], holdingBefore: before, holdingAfter: after,
  };
}

/** Place codes named by the site's links that `places.json` has no record for. */
export function danglingPlaceCodes(links: SiteLink[], placeCodes: Set<string>): Map<string, SiteLink[]> {
  const out = new Map<string, SiteLink[]>();
  for (const link of links) {
    if (placeCodes.has(link.placeCode)) continue;
    const list = out.get(link.placeCode);
    if (list) list.push(link);
    else out.set(link.placeCode, [link]);
  }
  return out;
}

/**
 * Pair the reference codes the site's links name with Fisqua descriptions.
 * The links carry the reference code the site published, which Fisqua
 * may since have corrected or given to another description; so each is
 * looked up in the site's own descriptions file, and the description
 * found there is paired by Django id. A reference code that names no
 * file description or two, or whose Django id pairs with no Fisqua
 * description or two, is left out: its links then have no candidates.
 */
export function pairSiteReferences(
  references: Iterable<string>,
  fileDescriptions: FileDescription[],
  rows: DescriptionRow[],
): Map<string, string> {
  const wanted = new Set(references);
  const djangoByReference = new Map<string, string[]>();
  for (const file of fileDescriptions) {
    if (!wanted.has(file.referenceCode)) continue;
    const list = djangoByReference.get(file.referenceCode);
    if (list) list.push(file.djangoId);
    else djangoByReference.set(file.referenceCode, [file.djangoId]);
  }
  const byDjango = indexByDjangoId(rows);
  const out = new Map<string, string>();
  for (const [reference, djangoIds] of djangoByReference) {
    if (djangoIds.length !== 1) continue;
    const matches = byDjango.get(djangoIds[0]) ?? [];
    if (matches.length === 1) out.set(reference, matches[0].id);
  }
  return out;
}

/**
 * The live Fisqua place each published place code pairs with: the place
 * holding its Django id, or the place that one was merged into, since a
 * merge moves the merged place's description links to the survivor. A
 * code whose Django id pairs with no place or two, or whose merge chain
 * is broken, is left out.
 */
export function placeIdsBySiteCode(filePlaces: FileAuthority[], rows: AuthorityRow[]): Map<string, string> {
  const byDjango = indexByDjangoId(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const file of filePlaces) {
    const matches = byDjango.get(file.djangoId) ?? [];
    if (matches.length !== 1) continue;
    const survivor = survivorOf(matches[0], byId);
    if (survivor) out.set(file.code, survivor.id);
  }
  return out;
}

/**
 * Resolve each dangling code to the one Fisqua place its links point to.
 *
 * `siteLinksByReference` holds every site link of the descriptions the
 * dangling links touch, by the reference code the site published;
 * `descriptionBySiteReference` pairs each such code with a Fisqua
 * description (`pairSiteReferences`); `fisquaLinks` holds Fisqua's links
 * of those descriptions; `placeIdBySiteCode` maps a published place code
 * to the live Fisqua place it pairs with (`placeIdsBySiteCode`). Fisqua's
 * links are read through merges as well, so every place compared is a
 * live one. For each dangling link the candidates are the places linked
 * to the paired description in that role, less those paired with a code
 * the site links that description to in the same role: a place the site
 * links in another role can still be the dangling code's. The code resolves when every
 * link's candidates are the same single place.
 */
export function resolveDangling(input: {
  dangling: Map<string, SiteLink[]>;
  siteLinksByReference: Map<string, SiteLink[]>;
  descriptionBySiteReference: Map<string, string>;
  fisquaLinks: FisquaLink[];
  placeIdBySiteCode: Map<string, string>;
  places: AuthorityRow[];
}): DanglingCode[] {
  const byId = new Map(input.places.map((p) => [p.id, p]));
  const live = (placeId: string): string => {
    const row = byId.get(placeId);
    return (row && survivorOf(row, byId)?.id) ?? placeId;
  };
  const fisquaByDescription = new Map<string, FisquaLink[]>();
  for (const link of input.fisquaLinks) {
    const list = fisquaByDescription.get(link.descriptionId);
    if (list) list.push(link);
    else fisquaByDescription.set(link.descriptionId, [link]);
  }
  const out: DanglingCode[] = [];
  for (const [code, links] of [...input.dangling].sort(([a], [b]) => a.localeCompare(b))) {
    const resolved = new Set<string>();
    let note = "";
    for (const link of links) {
      const descriptionId = input.descriptionBySiteReference.get(link.referenceCode);
      if (descriptionId === undefined) {
        note = `${link.referenceCode} pairs with no single Fisqua description`;
        continue;
      }
      const pairedHere = new Set(
        (input.siteLinksByReference.get(link.referenceCode) ?? [])
          .filter((l) => l.role === link.role)
          .map((l) => input.placeIdBySiteCode.get(l.placeCode))
          .filter((id): id is string => id !== undefined),
      );
      const candidates = new Set(
        (fisquaByDescription.get(descriptionId) ?? [])
          .filter((f) => f.role === link.role)
          .map((f) => live(f.placeId))
          .filter((id) => !pairedHere.has(id)),
      );
      if (candidates.size !== 1) {
        note = `${link.referenceCode} (${link.role}) has ${candidates.size} candidate place(s) in Fisqua`;
      }
      for (const c of candidates) resolved.add(c);
    }
    const placeId = note === "" && resolved.size === 1 ? [...resolved][0] : null;
    if (note === "" && resolved.size > 1) note = "links point to different Fisqua places";
    out.push({
      code, links: links.length, placeId, placeCode: placeId ? byId.get(placeId)?.code ?? null : null,
      candidates: [...resolved].sort(), note: placeId ? "resolved" : note,
    });
  }
  return out;
}

const NOTES: Record<RecordKind, string> = {
  entity: "Code published on zasqua.org (April 2026 export) recorded as a former code",
  place: "Code published on zasqua.org (April 2026 export) recorded as a former code",
  description: "Reference code published on zasqua.org (April 2026 export) recorded as a former reference code",
};

const TABLES: Record<RecordKind, string> = { entity: "entities", place: "places", description: "descriptions" };

/**
 * The record as it was read: its id and scope, the `legacy_ids` and update
 * stamp read, and, for an entity or place, still unmerged. A merge sets
 * `merged_into` and the stamp but leaves `legacy_ids` alone, so the
 * `legacy_ids` lock alone would let a code land on a record merged away
 * after the read.
 */
function scopeOf(w: RecordWrite): string {
  const id = `id = ${escapeSql(w.id)}`;
  const lock = `legacy_ids = ${escapeSql(w.oldLegacyIds)} AND updated_at = ${escapeSql(w.updatedAt)}`;
  if (w.kind === "description") return `tenant_id = ${escapeSql(w.tenantId)} AND ${id} AND ${lock}`;
  const tenant = w.tenantId === null ? "tenant_id IS NULL" : `tenant_id = ${escapeSql(w.tenantId)}`;
  return `federation_id = ${escapeSql(w.federationId)} AND ${tenant} AND ${id} AND merged_into IS NULL AND ${lock}`;
}

/**
 * SQL counting the records of a table whose `legacy_ids` hold an entry of
 * the provider, read as JSON as the planner reads it, so spacing in the
 * stored text does not matter. A value that is not valid JSON counts as
 * holding nothing.
 */
export function holdingCountSql(table: string, provider: string): string {
  return (
    `SELECT count(*) AS n FROM ${table} t WHERE EXISTS (SELECT 1 FROM ` +
    `json_each(CASE WHEN json_valid(t.legacy_ids) THEN t.legacy_ids ELSE '[]' END) e ` +
    `WHERE json_extract(CASE WHEN e.type = 'object' THEN e.value ELSE '{}' END, '$.provider') = ${escapeSql(provider)})`
  );
}

function guard(plan: KindPlan, expected: number, label: string): string {
  const table = TABLES[plan.kind];
  return (
    `SELECT CASE WHEN (${holdingCountSql(table, plan.provider)}) = ${expected} ` +
    `THEN 1 ELSE json('ABORT: ${table} holding ${plan.provider} ${label} is not ${expected}') END AS guard;`
  );
}

/** The longest live-code guard statement written, in bytes (D1 recommends 50,000 at most). */
export const GUARD_STATEMENT_BYTES = 40_000;

/**
 * Guards that no code a plan appends has become a live code since the
 * read: for entities and places, an entity or place code in the record's
 * federation; for descriptions, a reference code in its tenant. The
 * planner refuses such a code, but a record recoded between the read and
 * the apply would otherwise go unseen. Codes are grouped by federation
 * or tenant and split so that no statement exceeds
 * `GUARD_STATEMENT_BYTES`.
 */
export function liveCodeGuards(plan: KindPlan, maxBytes = GUARD_STATEMENT_BYTES): string[] {
  const byScope = new Map<string, Set<string>>();
  for (const w of plan.writes) {
    const scope = (plan.kind === "description" ? w.tenantId : w.federationId) ?? "";
    let set = byScope.get(scope);
    if (!set) byScope.set(scope, (set = new Set()));
    for (const a of w.added) set.add(String(a.id));
  }
  const statement = (scope: string, codes: string[]): string => {
    const list = codes.join(", ");
    const s = escapeSql(scope);
    const label = `${TABLES[plan.kind]} ${scope.replace(/'/g, "")}`;
    const hit =
      plan.kind === "description"
        ? `EXISTS (SELECT 1 FROM descriptions WHERE tenant_id = ${s} AND reference_code IN (${list}))`
        : `EXISTS (SELECT 1 FROM entities WHERE federation_id = ${s} AND entity_code IN (${list})) ` +
          `OR EXISTS (SELECT 1 FROM places WHERE federation_id = ${s} AND place_code IN (${list}))`;
    return `SELECT CASE WHEN ${hit} THEN json('ABORT: a code to record is now a live code in ${label}') ELSE 1 END AS guard;`;
  };
  const out: string[] = [];
  for (const [scope, codes] of byScope) {
    const overhead = Buffer.byteLength(statement(scope, []));
    const copies = plan.kind === "description" ? 1 : 2;
    let chunk: string[] = [];
    let bytes = overhead;
    for (const code of [...codes].sort()) {
      const quoted = escapeSql(code);
      const add = (Buffer.byteLength(quoted) + 2) * copies;
      if (chunk.length > 0 && bytes + add > maxBytes) {
        out.push(statement(scope, chunk));
        chunk = [];
        bytes = overhead;
      }
      chunk.push(quoted);
      bytes += add;
    }
    if (chunk.length > 0) out.push(statement(scope, chunk));
  }
  return out;
}

/**
 * The SQL that applies the plans, in order: a guard per kind on the
 * number of records holding its provider, guards that no code to record
 * has become a live code, then for each record a guard
 * that it still holds the `legacy_ids` read, a changelog row (when
 * `userId` is given) and the UPDATE, then the guards on the numbers
 * expected afterwards. `newId` makes changelog ids; it is
 * a parameter so tests are deterministic.
 */
export function buildStatements(
  plans: KindPlan[],
  opts: {
    userId: string | null;
    now: number;
    newId: () => string;
    /** How the user acted on each record (`retiredCodeActing`); NULL for every row when omitted. */
    actedAs?: (w: RecordWrite) => ChangelogActedAs | null;
  },
): string[] {
  const out: string[] = [];
  const active = plans.filter((p) => p.writes.length > 0);
  for (const plan of active) out.push(guard(plan, plan.holdingBefore, "before"));
  for (const plan of active) appendAll(out, liveCodeGuards(plan));
  for (const plan of active) {
    const table = TABLES[plan.kind];
    for (const w of plan.writes) {
      const where = scopeOf(w);
      // The provider counts cannot see a record that already held the
      // provider and changed since the read: its writes would match no
      // row and the counts would still agree. So each record is checked.
      out.push(
        `SELECT CASE WHEN (SELECT count(*) FROM ${table} WHERE ${where}) = 1 ` +
          `THEN 1 ELSE json('ABORT: ${table} ${w.id.replace(/'/g, "")} legacy_ids changed since the read') END AS guard;`,
      );
      if (opts.userId !== null) {
        const diff = JSON.stringify({ legacyIds: { old: w.oldLegacyIds, new: w.newLegacyIds } });
        out.push(
          `INSERT INTO changelog (id, record_id, record_type, user_id, note, diff, created_at, kind, acted_as) ` +
            `SELECT ${escapeSql(opts.newId())}, id, ${escapeSql(plan.kind)}, ${escapeSql(opts.userId)}, ` +
            `${escapeSql(NOTES[plan.kind])}, ${escapeSql(diff)}, ${opts.now}, 'update', ${escapeSql(opts.actedAs?.(w) ?? null)} ` +
            `FROM ${table} WHERE ${where};`,
        );
      }
      const by = plan.kind === "description" && opts.userId !== null ? `, updated_by = ${escapeSql(opts.userId)}` : "";
      out.push(
        `UPDATE ${table} SET legacy_ids = ${escapeSql(w.newLegacyIds)}, updated_at = ${opts.now}${by} WHERE ${where};`,
      );
    }
  }
  for (const plan of active) out.push(guard(plan, plan.holdingAfter, "after"));
  return out;
}

/**
 * Who writes the run's changelog rows, as the other nouns of the command
 * line resolve the actor (`resolveActor`): for each workspace a write
 * lands in, a description's or an owned record's own and a shared
 * record's federation's lead, where its steward acts. Returns how the
 * user acted on each record, for `acted_as`, and the guards that open
 * the file (`actorGuards`, and `scopeGuards` where shared records are
 * written). A workspace the user may not act in, or shared records of a
 * federation they are no steward of (`readScope`), stops the run.
 */
export async function retiredCodeActing(
  rows: RowReader,
  email: string,
  writes: RecordWrite[],
): Promise<{ actedAs: (w: RecordWrite) => ChangelogActedAs | null; guards: string[] }> {
  const list = (ids: Iterable<string>) => [...new Set(ids)].map(escapeSql).join(", ");
  const sharedFederations = new Set(writes.filter((w) => w.tenantId === null).map((w) => w.federationId ?? ""));
  const leads = new Map<string, string>();
  if (sharedFederations.size > 0) {
    for (const f of await rows(`SELECT id, IFNULL(lead_tenant_id, '') AS lead FROM federations WHERE id IN (${list(sharedFederations)})`)) {
      if (String(f.lead) !== "") leads.set(String(f.id), String(f.lead));
    }
  }
  const tenantOf = (w: RecordWrite): string => {
    if (w.tenantId !== null) return w.tenantId;
    const lead = leads.get(w.federationId ?? "");
    if (!lead) throw new AuthorityLinksStop(`The federation ${w.federationId} of ${w.kind} ${w.id} has no lead workspace`);
    return lead;
  };
  const tenants = new Set(writes.map(tenantOf));
  const slugs = new Map<string, string>();
  if (tenants.size > 0) {
    for (const t of await rows(`SELECT id, slug FROM tenants WHERE id IN (${list(tenants)})`)) slugs.set(String(t.id), String(t.slug));
  }
  const actors = new Map<string, Actor>();
  const guards: string[] = [];
  for (const id of [...tenants].sort()) {
    const slug = slugs.get(id);
    if (!slug) throw new AuthorityLinksStop(`No tenant has the id ${id}`);
    const actor = await resolveActor(rows, email, slug);
    actors.set(id, actor);
    appendAll(guards, actorGuards(actor));
  }
  for (const [federationId, lead] of leads) {
    if (!sharedFederations.has(federationId)) continue;
    const actor = actors.get(lead)!;
    const scope = await readScope(rows, actor);
    if (!scope.steward) throw new AuthorityLinksStop(`${email} is not a steward of ${scope.federationSlug}, whose shared records the run changes`);
    appendAll(guards, scopeGuards(actor, scope));
  }
  return { actedAs: (w) => changelogActedAsOf(actors.get(tenantOf(w))!), guards };
}

/**
 * Yield the elements of a file holding one top-level JSON array, one at
 * a time. Throws when the file is not a JSON array, when an element does
 * not parse, or when the commas between elements are not exactly one
 * each (`[{},,{}]`, `[{},]`, `[{}{}]`, `[,{}]`).
 */
export async function* streamJsonArray(path: string): AsyncGenerator<unknown> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  let started = false;
  let ended = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let buffer = "";
  let elementStart = -1;
  let index = 0;
  // At the top level: what may come next.
  let expecting: "first" | "element" | "separator" = "first";
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer = elementStart >= 0 ? buffer.slice(elementStart) + chunk : chunk;
    const scanFrom = elementStart >= 0 ? buffer.length - chunk.length : 0;
    elementStart = elementStart >= 0 ? 0 : -1;
    for (let i = scanFrom; i < buffer.length; i++) {
      const c = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
      if (ended) throw new Error(`${path}: content after the closing bracket`);
      if (!started) {
        if (c !== "[") throw new Error(`${path}: not a JSON array`);
        started = true;
        continue;
      }
      if (depth === 0) {
        if (c === ",") {
          if (expecting !== "separator") throw new Error(`${path}: unexpected comma before element ${index}`);
          expecting = "element";
          continue;
        }
        if (c === "]") {
          if (expecting === "element") throw new Error(`${path}: trailing comma after element ${index - 1}`);
          ended = true;
          continue;
        }
        if (expecting === "separator") throw new Error(`${path}: missing comma before element ${index}`);
        if (c !== "{" && c !== "[") throw new Error(`${path}: element ${index} is not an object or array`);
        elementStart = i;
      }
      if (c === '"') inString = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth < 0) throw new Error(`${path}: unbalanced brackets`);
        if (depth === 0) {
          const text = buffer.slice(elementStart, i + 1);
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch (err) {
            throw new Error(`${path}: element ${index} does not parse: ${(err as Error).message}`);
          }
          index++;
          expecting = "separator";
          yield value;
          elementStart = -1;
        }
      }
    }
    if (elementStart < 0) buffer = "";
  }
  if (!started || !ended || depth !== 0 || inString) throw new Error(`${path}: JSON array is incomplete`);
}

// @version v0.9.0
