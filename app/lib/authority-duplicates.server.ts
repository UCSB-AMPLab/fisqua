/**
 * Authority duplicates — deterministic candidate computation
 *
 * The possible-duplicates worklist (spec §4) computes its candidate
 * pairs deterministically in the loader — no background jobs, no
 * persisted candidate table. This module owns that computation:
 *
 *   - `normaliseName` — the collision key: lowercase, Unicode
 *     accent-stripped (NFD + combining-mark removal), punctuation
 *     removed, whitespace collapsed. No SQL equivalent exists in
 *     SQLite (no `unaccent`), so the worklist loader pulls the
 *     federation's active records and buckets them here.
 *   - `computeDuplicateCandidates` — buckets records by normalised
 *     name, emits one candidate per unordered pair within a bucket,
 *     attaches match signals (normalised name always; date overlap
 *     and shared external id when present), ranks by signal count,
 *     and excludes any pair with a `separate` ledger operation
 *     between them in either direction — the durable do-not-relink
 *     dismissal store (spec §4, the Sowing / UPDB rejection pattern).
 *     A second pass then compares the bucket keys against each other
 *     at edit distance 1 and emits the cross-bucket pairs as
 *     `near-spelling` candidates: Fortuni / Fortuny, Catalá /
 *     Catalán, Martines / Martínez never collide exactly, and those
 *     are precisely the variants an archivist wants queued.
 *   - `isEditDistanceOne` — the near-spelling rule, ported from the
 *     SBMAL authority-worksheet builder (`editdist1`): exactly one
 *     substitution, insertion, or deletion, no transpositions.
 *     The reference applies it to a trailing-surname key; here it
 *     applies to the whole normalised name. Two reasons: this module
 *     serves places as well as agents, where "surname" has no
 *     meaning; and over a federation-wide authority file the surname
 *     key would pair every Gonzalez with every Gonzales regardless of
 *     given name, which is a worklist no one can work through. The
 *     variants the reference was built to catch all differ inside the
 *     surname with the rest of the name identical, so they survive
 *     the change of key.
 *   - `getDuplicateBadgeCounts` — the CHEAP approximation behind the
 *     sidebar badge, computed only while the current request is inside
 *     the authorities section (the `_auth` layout gates it): exact
 *     lowercase-name collision pairs per record type (a single GROUP
 *     BY scan, no accent normalisation), minus dismissed pairs whose
 *     two records still collide. It deliberately trades exactness for
 *     cost — the accent-normalised worklist can find MORE pairs than
 *     the badge counts. The worklist page shows the exact number.
 *   - `computeVocabularyNearMatches` — the vocabulary side of the
 *     duplicates-vocabulary design round: a proposed term sitting in
 *     the review queue next to an already-approved term that is
 *     probably the same concept. Pure computation over two flat lists
 *     (no DB access; the route loader wires the queries in a later
 *     phase), reusing `normaliseName` and `isEditDistanceOne` so the
 *     three surfaces — entity dupes, place dupes, vocabulary dupes —
 *     agree on what "the same name" means. Adds a third reason class,
 *     `stem-family`, that the entity/place candidate pass has no use
 *     for: controlled-vocabulary terms are short common-noun phrases
 *     ("cattle brand" / "cattle branding") where the variation is
 *     almost always a suffix, not a spelling slip, so a cheap
 *     shared-prefix-plus-suffix-set check catches pairs edit distance
 *     alone would miss without opening the door to unrelated terms.
 *
 * @version v0.7.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface CandidateRecord {
  id: string;
  name: string;
  code: string | null;
  /** ISO-ish date strings; entities only (places pass null). */
  dateStart?: string | null;
  dateEnd?: string | null;
  /** Display string for the card meta line (dates of existence). */
  dates?: string | null;
  /** Shared-external-id signal input (wikidata for entities, tgn for places). */
  externalId?: string | null;
}

export type MatchSignal = "name" | "nearName" | "dates" | "externalId";

/**
 * Why the pair was proposed. `exact-name` pairs share a normalised
 * key; `near-spelling` pairs have keys one edit apart. Both are
 * proposals — nothing is collapsed without a human merge.
 */
export type CandidateReason = "exact-name" | "near-spelling";

export interface CandidatePair {
  a: CandidateRecord;
  b: CandidateRecord;
  /**
   * Chip list for the card. Always leads with the name signal —
   * `name` for exact-key pairs, `nearName` for near-spelling ones —
   * so the two reasons are never labelled identically.
   */
  signals: MatchSignal[];
  /**
   * Set alongside `signals` at the single construction site; drives
   * ranking (exact before near) and the card's reason label. Added
   * after the exact-only release, so consumers written against the
   * older shape keep working — they simply ignore it.
   */
  reason: CandidateReason;
}

/**
 * Normalise a display name into the collision key: lowercase, NFD
 * accent-stripped, punctuation replaced by spaces, whitespace
 * collapsed. "González, Juan" and "gonzalez juan" collide.
 */
export function normaliseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Leading four-digit year of a date string, or null. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * True when both records carry at least one parseable year and their
 * [start..end] year ranges intersect (an open end extends to the
 * other bound).
 */
export function datesOverlap(a: CandidateRecord, b: CandidateRecord): boolean {
  const aStart = yearOf(a.dateStart);
  const aEnd = yearOf(a.dateEnd);
  const bStart = yearOf(b.dateStart);
  const bEnd = yearOf(b.dateEnd);
  if (aStart == null && aEnd == null) return false;
  if (bStart == null && bEnd == null) return false;
  const aLo = aStart ?? aEnd!;
  const aHi = aEnd ?? aStart!;
  const bLo = bStart ?? bEnd!;
  const bHi = bEnd ?? bStart!;
  return aLo <= bHi && bLo <= aHi;
}

/**
 * True when `a` and `b` differ by exactly one substitution,
 * insertion, or deletion. Ported from the SBMAL authority-worksheet
 * builder's `editdist1`; identical strings are NOT distance 1 (they
 * are the exact-collision case, already bucketed).
 *
 * Bounded, not a Levenshtein matrix: a length difference above 1
 * rejects immediately, equal lengths take one positional scan, and
 * unequal lengths take one two-pointer scan of the longer string.
 * No allocation, so the pairwise pass stays cheap inside a Worker
 * request. Transpositions ("Peres" / "Pesre") are Damerau territory
 * and deliberately out of scope — the reference rule excludes them.
 */
export function isEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return false;
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > 1) return false;

  if (lenA === lenB) {
    let diffs = 0;
    for (let i = 0; i < lenA; i++) {
      if (a[i] !== b[i]) {
        diffs += 1;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }

  // One insertion/deletion: walk both, allowing a single skip in the
  // longer string.
  const short = lenA < lenB ? a : b;
  const long = lenA < lenB ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j += 1;
  }
  return true;
}

/** Order-insensitive pair key for the separate-dismissal lookup. */
export function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

export interface CandidateResult {
  pairs: CandidatePair[];
  /**
   * True when any bucket, or the near-spelling pass, hit a cap — the
   * pair list (and its length) is then a LOWER BOUND, not an exact
   * census. The UI renders the total with a trailing "+" so the cap
   * never masquerades as exact. One flag covers both passes: the
   * reader only needs to know the number is not final.
   */
  truncated: boolean;
}

/**
 * Records per bucket the quadratic pair loop will scan. Archival
 * corpora reliably contain placeholder names ("sin identificar" ×
 * hundreds); an uncapped bucket of n records emits n(n−1)/2 pair
 * objects — 1,000 placeholders would be ~500K allocations inside a
 * Worker request. Buckets beyond this size are scanned only across
 * their first slice and flagged truncated.
 */
const MAX_BUCKET_RECORDS = 50;

/** Pairs emitted per bucket before the bucket is cut off (flagged). */
const MAX_PAIRS_PER_BUCKET = 10;

/**
 * Shortest key the near-spelling pass will compare. Below this, one
 * edit is half the string or more — "Li"/"Lo", "Fe"/"Fi" — so every
 * two-letter name would pair with most others. The SBMAL rule guards
 * its surname key at the same length.
 */
const MIN_NEAR_KEY_LENGTH = 3;

/**
 * Distinct bucket keys the near-spelling pass will scan. The pass is
 * quadratic in DISTINCT KEYS (not records), and keys are sorted by
 * length so the inner loop breaks as soon as the length gap exceeds
 * 1 — in practice a narrow window, but a federation whose names are
 * all the same length is still n². Beyond this many keys only the
 * first slice is scanned, and the result is flagged truncated.
 */
const MAX_NEAR_KEYS = 2000;

/** Near-spelling pairs emitted in total before the pass is cut off. */
const MAX_NEAR_PAIRS = 100;

/**
 * Compute ranked duplicate candidates in two passes: exact
 * normalised-name collisions first, then cross-bucket pairs whose
 * keys are one edit apart (`near-spelling`). `separatePairs` is the
 * set of `pairKey`s with a `separate` ledger operation between them —
 * those pairs never resurface, from either pass. Callers pass only
 * active (non-merged-away) records. Output is bounded in both passes
 * (see the cap constants); the `truncated` flag reports when anything
 * was skipped.
 */
export function computeDuplicateCandidates(
  records: CandidateRecord[],
  separatePairs: Set<string>,
): CandidateResult {
  const buckets = new Map<string, CandidateRecord[]>();
  for (const r of records) {
    const key = normaliseName(r.name);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }

  const pairs: CandidatePair[] = [];
  let truncated = false;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    let scan = bucket;
    if (bucket.length > MAX_BUCKET_RECORDS) {
      scan = bucket.slice(0, MAX_BUCKET_RECORDS);
      truncated = true;
    }

    let emitted = 0;
    outer: for (let i = 0; i < scan.length; i++) {
      for (let j = i + 1; j < scan.length; j++) {
        const a = scan[i];
        const b = scan[j];
        if (separatePairs.has(pairKey(a.id, b.id))) continue;
        if (emitted >= MAX_PAIRS_PER_BUCKET) {
          truncated = true;
          break outer;
        }
        pairs.push(makePair(a, b, "name", "exact-name"));
        emitted += 1;
      }
    }
  }

  // -- Near-spelling pass ---------------------------------------------
  // Bucket keys one edit apart are the variants exact collision can
  // never see. Sorted by length first so the inner loop can break out
  // the moment the length gap exceeds 1 (distance 1 is impossible
  // beyond it), then by key so the cap always cuts at the same place.
  let nearKeys = Array.from(buckets.keys())
    .filter((k) => k.length >= MIN_NEAR_KEY_LENGTH)
    .sort((x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0));
  if (nearKeys.length > MAX_NEAR_KEYS) {
    nearKeys = nearKeys.slice(0, MAX_NEAR_KEYS);
    truncated = true;
  }

  let nearEmitted = 0;
  nearPass: for (let i = 0; i < nearKeys.length; i++) {
    for (let j = i + 1; j < nearKeys.length; j++) {
      if (nearKeys[j].length > nearKeys[i].length + 1) break;
      if (!isEditDistanceOne(nearKeys[i], nearKeys[j])) continue;

      // Same per-bucket record cap as the exact pass: the cross
      // product of two placeholder buckets is the same OOM shape.
      const left = capBucket(buckets.get(nearKeys[i])!);
      const right = capBucket(buckets.get(nearKeys[j])!);
      if (left.capped || right.capped) truncated = true;
      let crossEmitted = 0;
      cross: for (const a of left.records) {
        for (const b of right.records) {
          if (separatePairs.has(pairKey(a.id, b.id))) continue;
          if (nearEmitted >= MAX_NEAR_PAIRS) {
            truncated = true;
            break nearPass;
          }
          if (crossEmitted >= MAX_PAIRS_PER_BUCKET) {
            truncated = true;
            break cross;
          }
          pairs.push(makePair(a, b, "nearName", "near-spelling"));
          crossEmitted += 1;
          nearEmitted += 1;
        }
      }
    }
  }

  // Rank exact collisions above near spellings, then by match
  // strength (signal count), then by name for a stable deterministic
  // order.
  pairs.sort(
    (x, y) =>
      Number(x.reason === "near-spelling") -
        Number(y.reason === "near-spelling") ||
      y.signals.length - x.signals.length ||
      x.a.name.localeCompare(y.a.name) ||
      x.a.id.localeCompare(y.a.id),
  );
  return { pairs, truncated };
}

/** Trim a bucket to the scan cap, reporting whether it was trimmed. */
function capBucket(bucket: CandidateRecord[]): {
  records: CandidateRecord[];
  capped: boolean;
} {
  if (bucket.length <= MAX_BUCKET_RECORDS) {
    return { records: bucket, capped: false };
  }
  return { records: bucket.slice(0, MAX_BUCKET_RECORDS), capped: true };
}

/** Assemble a candidate with its name signal plus the tie-signals. */
function makePair(
  a: CandidateRecord,
  b: CandidateRecord,
  nameSignal: "name" | "nearName",
  reason: CandidateReason,
): CandidatePair {
  const signals: MatchSignal[] = [nameSignal];
  if (datesOverlap(a, b)) signals.push("dates");
  if (a.externalId && b.externalId && a.externalId === b.externalId) {
    signals.push("externalId");
  }
  return { a, b, signals, reason };
}

/**
 * Fetch the set of `pairKey`s dismissed as not-duplicates: every
 * `separate` ledger operation for the record type in this federation,
 * both directions collapsed to the unordered key.
 */
export async function getSeparatePairs(
  db: DrizzleD1Database<any>,
  federationId: string,
  recordType: "entity" | "place",
): Promise<Set<string>> {
  const { and, eq } = await import("drizzle-orm");
  const { authorityOperations } = await import("../db/schema");
  const rows = await db
    .select({
      sourceId: authorityOperations.sourceId,
      targetId: authorityOperations.targetId,
    })
    .from(authorityOperations)
    .where(
      and(
        eq(authorityOperations.federationId, federationId),
        eq(authorityOperations.recordType, recordType),
        eq(authorityOperations.operation, "separate"),
      ),
    )
    .all();
  const set = new Set<string>();
  for (const r of rows) {
    if (r.targetId) set.add(pairKey(r.sourceId, r.targetId));
  }
  return set;
}

/**
 * Cheap sidebar-badge counts: exact lowercase-name collision pairs
 * per record type, minus dismissed pairs whose records still collide.
 * One GROUP BY scan + one indexed join per type — an approximation
 * (no accent normalisation), never the worklist's exact number.
 *
 * `ownerTenantId` narrows the count to what the request tenant can
 * actually SEE after migration 0067: the federation-shared records plus
 * its own, never another tenant's owned ones (the same predicate
 * `authorityScope` builds for the worklist itself). It is OPTIONAL, and
 * omitting it counts the whole federation — the pre-0067 behaviour,
 * correct for any federation whose authority space is entirely shared,
 * which is every federation until a claim runs. Callers on a
 * multi-tenant federation should pass it so the badge matches the
 * worklist it links to.
 */
export async function getDuplicateBadgeCounts(
  db: DrizzleD1Database<any>,
  federationId: string,
  ownerTenantId?: string,
): Promise<{ entities: number; places: number }> {
  const { sql } = await import("drizzle-orm");

  async function countFor(
    table: "entities" | "places",
    recordType: "entity" | "place",
  ): Promise<number> {
    // Ownership arm per aliased occurrence of the authority table. With
    // no owner supplied it collapses to `1 = 1`, leaving the statement
    // byte-equivalent to its pre-0067 shape.
    const owned = (alias: string) =>
      ownerTenantId === undefined
        ? sql`1 = 1`
        : sql`(${sql.raw(alias)}.tenant_id IS NULL OR ${sql.raw(alias)}.tenant_id = ${ownerTenantId})`;

    const groups = (await db.all(sql`
      SELECT COUNT(*) AS c
      FROM ${sql.raw(table)} t
      WHERE t.federation_id = ${federationId} AND t.merged_into IS NULL
        AND ${owned("t")}
      GROUP BY lower(t.display_name)
      HAVING c > 1
    `)) as Array<{ c: number }>;
    let pairs = 0;
    for (const g of groups) pairs += (g.c * (g.c - 1)) / 2;
    if (pairs === 0) return 0;

    const dismissed = (await db.all(sql`
      SELECT COUNT(DISTINCT CASE
        WHEN ao.source_id < ao.target_id
          THEN ao.source_id || '|' || ao.target_id
        ELSE ao.target_id || '|' || ao.source_id
      END) AS c
      FROM authority_operations ao
      JOIN ${sql.raw(table)} a ON a.id = ao.source_id
      JOIN ${sql.raw(table)} b ON b.id = ao.target_id
      WHERE ao.federation_id = ${federationId}
        AND ao.record_type = ${recordType}
        AND ao.operation = 'separate'
        AND a.merged_into IS NULL AND b.merged_into IS NULL
        AND ${owned("a")} AND ${owned("b")}
        AND lower(a.display_name) = lower(b.display_name)
    `)) as Array<{ c: number }>;
    return Math.max(0, pairs - (dismissed[0]?.c ?? 0));
  }

  const [entityCount, placeCount] = await Promise.all([
    countFor("entities", "entity"),
    countFor("places", "place"),
  ]);
  return { entities: entityCount, places: placeCount };
}

// ---------------------------------------------------------------------------
// Vocabulary near-match — duplicates-vocabulary design note
// ---------------------------------------------------------------------------

export interface VocabularyTermLite {
  id: string;
  canonical: string;
  entityCount: number;
}

/**
 * Why a proposed term was matched to an approved one. `stem-family` is
 * unique to the vocabulary pass — see the module header — the other
 * two mirror the entity/place candidate reasons.
 */
export type VocabularyMatchReason =
  | "exact-normalised"
  | "near-spelling"
  | "stem-family";

export interface VocabularyNearMatch {
  proposed: VocabularyTermLite;
  approved: VocabularyTermLite;
  reason: VocabularyMatchReason;
}

/**
 * Shortest normalised form the near-spelling rule will compare, same
 * noise guard the entity/place near-spelling pass applies at the
 * bucket-key level: below this, one edit is most of the string.
 */
const MIN_NEAR_SPELLING_LENGTH = 4;

/** Shortest shared prefix a stem-family token pair must clear. */
const MIN_STEM_PREFIX_LENGTH = 4;

/**
 * Remainders a stem-family token pair's shared prefix may leave
 * behind, on BOTH sides, for the pair to count as the same stem.
 * Plural, gerund, and past-tense suffixes — the shapes a controlled
 * vocabulary's own near-duplicates actually take ("brand" / "brands" /
 * "branding" / "branded"), not a general morphology.
 */
const STEM_SUFFIXES = new Set(["", "s", "es", "ing", "ed"]);

/** Priority order for match-reason selection: lower wins. */
const VOCAB_REASON_RANK: Record<VocabularyMatchReason, number> = {
  "exact-normalised": 0,
  "near-spelling": 1,
  "stem-family": 2,
};

/**
 * True when two normalised tokens are the same stem: identical
 * outright, or sharing a leading run of at least
 * `MIN_STEM_PREFIX_LENGTH` characters with both remainders after that
 * shared prefix members of `STEM_SUFFIXES`. "brand"/"branding"
 * qualifies (shared prefix "brand", remainders "" and "ing"); "cat"/
 * "cats" does not — the shared prefix is one character short of the
 * guard, which is what keeps three-letter tokens from pairing on any
 * trailing "s".
 */
function isSameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const maxPrefix = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < maxPrefix && a[shared] === b[shared]) shared += 1;
  if (shared < MIN_STEM_PREFIX_LENGTH) return false;
  return STEM_SUFFIXES.has(a.slice(shared)) && STEM_SUFFIXES.has(b.slice(shared));
}

/**
 * True when two normalised, space-split forms are a `stem-family`
 * match: the same token count, every position either an exact token
 * match or an `isSameStem` pair, and at least one position NOT an
 * exact match (an all-equal pair is `exact-normalised`, already
 * resolved before this rule runs).
 */
function isStemFamily(normA: string, normB: string): boolean {
  const tokensA = normA.split(" ");
  const tokensB = normB.split(" ");
  if (tokensA.length !== tokensB.length) return false;
  let hasVariation = false;
  for (let i = 0; i < tokensA.length; i++) {
    if (tokensA[i] === tokensB[i]) continue;
    hasVariation = true;
    if (!isSameStem(tokensA[i], tokensB[i])) return false;
  }
  return hasVariation;
}

/**
 * Match each proposed vocabulary term against the approved vocabulary,
 * catching what the review queue's plain-text list makes an archivist
 * hunt for by eye: a term that is already there under another spelling
 * or another suffix. Three reason classes, tried in priority order per
 * proposed term — exact-normalised, then near-spelling, then
 * stem-family (per the duplicates-vocabulary design note) — and at
 * most one match survives per proposed term: the best-ranked reason
 * class, ties within a class broken by the approved term's
 * `entityCount` (the more-used term is the likelier survivor), then by
 * id for a deterministic result when even that ties. A proposed term
 * with no qualifying approved match is simply absent from the output.
 * Proposed terms are never matched against each other — only against
 * the approved list.
 */
export function computeVocabularyNearMatches(
  proposed: VocabularyTermLite[],
  approved: VocabularyTermLite[],
): VocabularyNearMatch[] {
  const results: VocabularyNearMatch[] = [];

  for (const p of proposed) {
    const normP = normaliseName(p.canonical);
    let best: VocabularyNearMatch | null = null;

    for (const a of approved) {
      const normA = normaliseName(a.canonical);
      let reason: VocabularyMatchReason | null = null;

      if (normP === normA) {
        reason = "exact-normalised";
      } else if (
        normP.length >= MIN_NEAR_SPELLING_LENGTH &&
        normA.length >= MIN_NEAR_SPELLING_LENGTH &&
        isEditDistanceOne(normP, normA)
      ) {
        reason = "near-spelling";
      } else if (isStemFamily(normP, normA)) {
        reason = "stem-family";
      }

      if (reason === null) continue;

      if (best === null || VOCAB_REASON_RANK[reason] < VOCAB_REASON_RANK[best.reason]) {
        best = { proposed: p, approved: a, reason };
        continue;
      }
      if (VOCAB_REASON_RANK[reason] > VOCAB_REASON_RANK[best.reason]) continue;

      // Same reason class as the current best: tie-break by
      // entityCount, then id, for a deterministic winner.
      if (
        a.entityCount > best.approved.entityCount ||
        (a.entityCount === best.approved.entityCount && a.id < best.approved.id)
      ) {
        best = { proposed: p, approved: a, reason };
      }
    }

    if (best) results.push(best);
  }

  return results;
}
