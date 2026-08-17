/**
 * Tests — vocabulary near-match computation
 *
 * This suite pins `computeVocabularyNearMatches`, the vocabulary side
 * of the duplicates-vocabulary design note: given a proposed term
 * sitting in the review queue and the already-approved vocabulary, it
 * flags the approved term that is probably the same concept, in one
 * of three reason classes (`exact-normalised`, `near-spelling`,
 * `stem-family`), and never more than one match per proposed term.
 * Pure computation, no DB — the route loader wires the actual queries
 * in a later phase, so these cases exercise the matcher directly
 * against hand-built `VocabularyTermLite` lists.
 *
 * The cases pin the design note's own specimen ("cattle brands" /
 * "cattle branding" as a stem-family match), the exact and
 * near-spelling classes, the short-form noise guard on near-spelling,
 * the token-count guard on stem-family, the best-class-wins and
 * within-class tie-break rules, and the closed suffix set that keeps
 * stem-family from over-matching.
 *
 * @version v0.7.0
 */
import { describe, it, expect } from "vitest";
import {
  computeVocabularyNearMatches,
  type VocabularyTermLite,
} from "../../app/lib/authority-duplicates.server";

function term(id: string, canonical: string, entityCount = 0): VocabularyTermLite {
  return { id, canonical, entityCount };
}

describe("computeVocabularyNearMatches", () => {
  it("matches the design note's own specimen as stem-family", () => {
    const proposed = [term("p1", "cattle brands")];
    const approved = [term("a1", "cattle branding")];
    const matches = computeVocabularyNearMatches(proposed, approved);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("stem-family");
    expect(matches[0].proposed.id).toBe("p1");
    expect(matches[0].approved.id).toBe("a1");
  });

  it("matches diacritics, case, and punctuation variants as exact-normalised", () => {
    const proposed = [term("p1", "Cabildo, Indígena")];
    const approved = [term("a1", "cabildo indigena")];
    const matches = computeVocabularyNearMatches(proposed, approved);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("exact-normalised");
  });

  it("matches an edit-distance-1 pair as near-spelling when both forms clear the length guard", () => {
    const proposed = [term("p1", "casas")];
    const approved = [term("a1", "casos")];
    const matches = computeVocabularyNearMatches(proposed, approved);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("near-spelling");
  });

  it("does not match a 3-character edit-distance-1 pair (short-form noise guard)", () => {
    const proposed = [term("p1", "cat")];
    const approved = [term("a1", "cot")];
    expect(computeVocabularyNearMatches(proposed, approved)).toHaveLength(0);
  });

  it("does not match a token-count mismatch as stem-family", () => {
    const proposed = [term("p1", "cattle")];
    const approved = [term("a1", "cattle branding")];
    expect(computeVocabularyNearMatches(proposed, approved)).toHaveLength(0);
  });

  it("returns the exact match only when a proposed term also has a stem candidate", () => {
    const proposed = [term("p1", "cattle brands")];
    const approved = [
      term("stem", "cattle branding"),
      term("exact", "cattle brands"),
    ];
    const matches = computeVocabularyNearMatches(proposed, approved);
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toBe("exact-normalised");
    expect(matches[0].approved.id).toBe("exact");
  });

  it("breaks a within-class tie by the higher entityCount", () => {
    const proposed = [term("p1", "cattle brands")];
    const approved = [
      term("low", "cattle branding", 3),
      term("high", "cattle branded", 9),
    ];
    const matches = computeVocabularyNearMatches(proposed, approved);
    expect(matches).toHaveLength(1);
    expect(matches[0].approved.id).toBe("high");
  });

  it("returns nothing for empty inputs, and never matches proposed terms against each other", () => {
    expect(computeVocabularyNearMatches([], [])).toHaveLength(0);
    expect(computeVocabularyNearMatches([term("p1", "cattle brands")], [])).toHaveLength(0);

    const proposed = [term("p1", "cattle brands"), term("p2", "cattle branding")];
    const matches = computeVocabularyNearMatches(proposed, []);
    expect(matches).toHaveLength(0);
  });

  it("does not stem-match a token pair whose remainders fall outside the closed suffix set", () => {
    // "cartels" / "carted": shared prefix "carte", remainders "ls" and
    // "d" — neither is in {"", "s", "es", "ing", "ed"}. Chosen over
    // "cartel"/"carted" because that pair is edit-distance 1 and would
    // match under near-spelling instead, obscuring which rule fired.
    const proposed = [term("p1", "cartels")];
    const approved = [term("a1", "carted")];
    expect(computeVocabularyNearMatches(proposed, approved)).toHaveLength(0);
  });
});
