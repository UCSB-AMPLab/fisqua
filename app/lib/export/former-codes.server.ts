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
 * was merged into another is not exported, so its retired site codes go
 * to the record it was merged into, following `merged_into` to the end
 * of the chain: an address that named the merged record then leads to
 * the survivor. A merged record's own six-character code is not carried,
 * since no six-character code was published before the move.
 *
 * A former reference code equal to a reference code a description holds
 * now is left out. Such a code names a live page, so it cannot redirect;
 * the AHR recodes that shifted codes along a series are recorded only as
 * history.
 *
 * The field is omitted when a record has no former codes, as `mets_url`
 * is when a tenant has no METS base.
 *
 * @version v0.8.0
 */

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
  legacyIds: string | null;
}

/**
 * For each survivor, the retired site codes of the records merged
 * into it. Chains are
 * followed to the record that is not merged; a chain that loops is
 * dropped.
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
    if (codes.length === 0) continue;
    const list = out.get(target) ?? [];
    for (const code of codes) if (!list.includes(code)) list.push(code);
    out.set(target, list);
  }
  return out;
}

/**
 * A record's former codes: its own retired site codes, then those it
 * inherits by merge, without repeats and never its current code.
 */
export function formerCodesFor(
  current: string | null,
  legacyIds: string | null,
  inherited: string[] | undefined
): string[] {
  const out: string[] = [];
  for (const code of [...legacyIdsOf(legacyIds, RETIRED_CODE_PROVIDER), ...(inherited ?? [])]) {
    if (code !== current && !out.includes(code)) out.push(code);
  }
  return out;
}

// @version v0.8.0
