/**
 * Typeahead Term Resolution
 *
 * This module deals with which term id an action writes from a typeahead.
 * A typeahead submits the visible text, the id of the term the person
 * picked, and the term's text as it was when picked. The submitted id is
 * kept while the text still names the pick: it equals the term's current
 * canonical text (a retype of the same name) or the text as picked (the
 * term was renamed after the page was loaded). A term merged since the
 * pick is followed to the term it was merged into. Text that differs from
 * both is not a selection, and the caller resolves it from the text. A
 * kept term comes back with its current canonical text, which the caller
 * stores as the function text in place of the submitted text.
 *
 * @version v0.9.0
 */

import { and, eq } from "drizzle-orm";
import { vocabularyTerms } from "~/db/schema";
import { termTextMatches } from "~/lib/typeahead-term";

export type SubmittedTermResolution =
  | { kind: "missing" }
  | { kind: "use"; id: string; canonical: string }
  | { kind: "text" };

const MAX_MERGE_HOPS = 10;

export async function resolveSubmittedTerm(
  db: any,
  federationId: string,
  submittedId: string,
  text: string | null,
  selectedText: string | null
): Promise<SubmittedTermResolution> {
  const find = (id: string) =>
    db
      .select({
        id: vocabularyTerms.id,
        canonical: vocabularyTerms.canonical,
        mergedInto: vocabularyTerms.mergedInto,
      })
      .from(vocabularyTerms)
      .where(
        and(
          eq(vocabularyTerms.id, id),
          eq(vocabularyTerms.federationId, federationId)
        )
      )
      .get() as Promise<
      { id: string; canonical: string; mergedInto: string | null } | undefined
    >;

  const picked = await find(submittedId);
  if (!picked) return { kind: "missing" };
  if (
    !termTextMatches(text, picked.canonical) &&
    !termTextMatches(text, selectedText)
  ) {
    return { kind: "text" };
  }
  let current = picked;
  for (let hop = 0; current.mergedInto && hop < MAX_MERGE_HOPS; hop++) {
    const next = await find(current.mergedInto);
    if (!next) return { kind: "missing" };
    current = next;
  }
  if (current.mergedInto) return { kind: "missing" };
  return { kind: "use", id: current.id, canonical: current.canonical };
}

// @version v0.9.0
