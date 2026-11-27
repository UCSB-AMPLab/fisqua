/**
 * Merge facts — the independent facts a merge of two entity records rests on
 *
 * This module deals with the list the evidence panel shows and the
 * server checks: the five independent facts a steward may state for
 * merging two entity records, in the order the panel shows them. It
 * holds no server code, so the panel in the browser and the check in
 * `./merge-evidence.server.ts` read the same list.
 *
 * @version v0.9.0
 */

/** The independent facts a steward may state, in the order the panel shows them. */
export const MERGE_FACTS = ["dates", "office", "kin", "place", "matter"] as const;
export type MergeFact = (typeof MERGE_FACTS)[number];

/** The refusals of a merge for its evidence, as the server names them. */
export const EVIDENCE_ERRORS = [
  "evidence_facts",
  "evidence_loser",
  "evidence_survivor",
  "evidence_unlinked",
  "evidence_stale",
] as const;
export type EvidenceError = (typeof EVIDENCE_ERRORS)[number];

export const isEvidenceError = (value: unknown): value is EvidenceError =>
  typeof value === "string" && (EVIDENCE_ERRORS as readonly string[]).includes(value);

// @version v0.9.0
