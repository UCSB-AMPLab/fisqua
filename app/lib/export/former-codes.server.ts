/**
 * Former Codes in the Export
 *
 * This module deals with the codes a record was published under before
 * the one it carries now. zasqua.org published five-character entity and
 * place codes from April 2026 and moves to Fisqua's own; some reference
 * codes were corrected after they were published. The site's Worker
 * answers every old address with a permanent redirect, and it reads the
 * old-to-new pairs from the export: `former_codes` on each entity and
 * place, `former_reference_codes` on each description. Each value is one
 * path segment, exactly as it was published.
 *
 * The codes come from `legacy_ids`. An entity or place has its retired
 * site code under the provider `zasqua-2026-04`; a description has each
 * corrected reference code under `former-reference-code`. A record that
 * was merged into another is not exported, so its codes go to the record
 * it was merged into, following `merged_into` to the end of the chain:
 * an address that named the merged record then leads to the survivor.
 * Those codes are the merged record's retired site codes and then its own
 * current code (`entity_code`, `place_code`), which zasqua.org has
 * published since 2026-11-09. Every merge carries them, whenever it was
 * made. A chain that loops reaches no survivor and carries nothing.
 *
 * A survivor's `former_codes` are its own retired site codes, then the
 * codes it inherits, merged record by merged record in the order the
 * export reads them (by id), without repeats and never its own current
 * code. No code that is the current code of a record the same file
 * exports is written as a former code, whatever was merged between the
 * file's reads: such a code names a live page, so it cannot redirect.
 * The places file reads its places first and filters against their
 * codes, and a record it exports passes nothing on as merged. The
 * entities file is written as its batches read it, so it filters against
 * the codes read so far and refuses the file if a code it wrote as
 * former is the current code of an entity it wrote later.
 *
 * A merge made before the survivor's last publish adds codes
 * without moving the survivor's version; the entities and places files
 * are written whole at every publish that includes them, so the next
 * such publish carries the codes.
 *
 * A former reference code equal to a reference code a description holds
 * now is left out. Such a code names a live page, so it cannot redirect;
 * the AHR recodes that shifted codes along a series are recorded only as
 * history.
 *
 * The field is omitted when a record has no former codes.
 *
 * A description's former reference codes therefore change when a code
 * starts or stops being live: a description created with it or deleted
 * while holding it. `formerCodeHoldersFollow` gives the statement that
 * moves the version of every description, in the tenants published
 * together with the writing one (its federation's member tenants), that
 * records such a code under `former-reference-code`; the writing path
 * runs it in the batch of its own write. The description editor's create
 * and delete, and the promote, run it. The import and the revert do not:
 * a version move would put a row the run wrote past its journal row, and
 * the revert would then keep it as edited. The incremental publish's
 * fingerprint covers the descriptions those two leave unmoved.
 *
 * @version v0.9.0
 */

import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions } from "../../db/schema";
import { nextVersionSql } from "../record-version.server";

/** Provider under which an entity's or place's retired site code is kept. */
export const RETIRED_CODE_PROVIDER = "zasqua-2026-04";
/** Provider under which a description's corrected reference code is kept. */
export const FORMER_REFERENCE_PROVIDER = "former-reference-code";

/**
 * The ids recorded under `provider` in a `legacy_ids` JSON text, as
 * strings, in recorded order and without repeats. Malformed text or
 * entries yield nothing rather than failing the export.
 */
export function legacyIdsOf(legacyIds: string | null | undefined, provider: string): string[] {
  if (!legacyIds) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacyIds);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { provider?: unknown }).provider === provider
    ) {
      const id = (entry as { id?: unknown }).id;
      if ((typeof id === "string" && id !== "") || typeof id === "number") {
        const value = String(id);
        if (!out.includes(value)) out.push(value);
      }
    }
  }
  return out;
}

/** A merged authority record as the export reads it. */
export interface MergedRecord {
  id: string;
  mergedInto: string;
  /** The record's own current code: `entity_code` or `place_code`. */
  code: string | null;
  legacyIds: string | null;
}

/**
 * For each survivor, the codes of the records merged into it: for each
 * merged record in the order given, its retired site codes and then its
 * own current code, without repeats. Chains are followed to the record
 * that is not merged; a chain that loops is dropped.
 */
export function mergedFormerCodes(merged: MergedRecord[]): Map<string, string[]> {
  const byId = new Map(merged.map((r) => [r.id, r]));
  const out = new Map<string, string[]>();
  for (const record of merged) {
    let target = record.mergedInto;
    const seen = new Set([record.id]);
    let looped = false;
    while (byId.has(target)) {
      if (seen.has(target)) {
        looped = true;
        break;
      }
      seen.add(target);
      target = byId.get(target)!.mergedInto;
    }
    if (looped) continue;
    const codes = legacyIdsOf(record.legacyIds, RETIRED_CODE_PROVIDER);
    if (record.code) codes.push(record.code);
    if (codes.length === 0) continue;
    const list = out.get(target) ?? [];
    for (const code of codes) if (!list.includes(code)) list.push(code);
    out.set(target, list);
  }
  return out;
}

/**
 * A record's former codes: its own retired site codes, then those it
 * inherits by merge, without repeats, never its current code and never
 * a code in `live`, the current codes of the records the same file
 * exports.
 */
export function formerCodesFor(
  current: string | null,
  legacyIds: string | null,
  inherited: string[] | undefined,
  live?: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const code of [...legacyIdsOf(legacyIds, RETIRED_CODE_PROVIDER), ...(inherited ?? [])]) {
    if (code !== current && !live?.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * The statement that moves the version (`nextVersionSql`) of every
 * description in `tenantId`'s federation whose `legacy_ids` record one
 * of `codes` under `FORMER_REFERENCE_PROVIDER`, as `legacyIdsOf` reads
 * them: entries of a JSON array whose provider is that one and whose id
 * is a non-empty string or a number, compared as text. A `legacy_ids`
 * that is not JSON, or not an array, records nothing, and an entry that
 * is not an object is skipped. Every JSON function is reached only
 * through a `CASE` that has already checked its input (`json_valid`,
 * then the array type, then json_each's own `type` of the entry), since
 * SQLite does not order the terms of an `AND`: no content of
 * `legacy_ids` can make the statement, and the write it follows, fail.
 * Null when `codes` is empty.
 *
 * The `LIKE` term only skips rows whose text cannot hold the provider;
 * the match itself is the `json_each` test. The codes go as one JSON
 * parameter.
 */
export function formerCodeHoldersFollow(
  db: DrizzleD1Database<any>,
  tenantId: string,
  codes: readonly string[],
  now: number = Date.now()
) {
  const wanted = [...new Set(codes.filter((c) => c !== ""))];
  if (wanted.length === 0) return null;
  const ids = descriptions.legacyIds;
  return db
    .update(descriptions)
    .set({ updatedAt: nextVersionSql(descriptions.updatedAt, now) })
    .where(
      sql`${descriptions.tenantId} IN (SELECT m.id FROM tenants m WHERE m.federation_id = (SELECT t.federation_id FROM tenants t WHERE t.id = ${tenantId}))
        AND ${ids} LIKE ${"%" + FORMER_REFERENCE_PROVIDER + "%"}
        AND EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(${ids}) THEN
              CASE WHEN json_type(${ids}) = 'array' THEN ${ids} ELSE '[]' END
            ELSE '[]' END
          ) e
          WHERE CASE WHEN e.type = 'object' THEN
              json_extract(e.value, '$.provider') = ${FORMER_REFERENCE_PROVIDER}
              AND json_type(e.value, '$.id') IN ('text', 'integer', 'real')
              AND json_extract(e.value, '$.id') <> ''
              AND CAST(json_extract(e.value, '$.id') AS TEXT) IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))
            ELSE 0 END
        )`
    );
}

// @version v0.9.0
