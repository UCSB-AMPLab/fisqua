/**
 * Typeahead Term Matching
 *
 * This module deals with the one comparison that decides whether a
 * typeahead's term id still describes its text. A typeahead field submits
 * the visible text and, beside it, the id of the vocabulary term the
 * person picked. The id describes the text only while the text still names
 * that term, so both the field and the actions that read it decide that
 * with one comparison: the trimmed text equals the term's canonical text,
 * ignoring case. This is the comparison the actions use to find an
 * existing term from typed text.
 *
 * @version v0.9.0
 */

/** True when `text` names the term whose canonical text is `canonical`. */
export function termTextMatches(
  text: string | null | undefined,
  canonical: string | null | undefined
): boolean {
  if (text == null || canonical == null) return false;
  return text.trim().toLowerCase() === canonical.trim().toLowerCase();
}

/**
 * The term id a typeahead submits: the selected term's id while the
 * visible text still names it, an empty string once the text differs.
 */
export function submittedTermId(
  text: string,
  selected: { id: string; text: string } | null
): string {
  if (!selected || !selected.id) return "";
  return termTextMatches(text, selected.text) ? selected.id : "";
}

// @version v0.9.0
