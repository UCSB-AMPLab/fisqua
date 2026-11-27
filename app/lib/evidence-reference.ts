/**
 * Evidence reference — the reference code a proposal's evidence names
 *
 * This module deals with reading the reference code an authority
 * proposal cites (`payload.evidenceRef`) the one way every reader of it
 * must agree on. The decision page and the queue look the code up to
 * offer and link the evidence description, and `ruleAuthorityProposal`
 * looks it up to write the evidence link; if they read the code
 * differently, the page can hide the link controls for a description
 * the ruling then requires a role for.
 *
 * `evidenceReference` gives the code with surrounding whitespace
 * removed, or null when the proposal cites none. It holds no server
 * code, so the pages' components use it as well as their loaders.
 *
 * @version v0.9.0
 */

/** The reference code a proposal cites, trimmed, or null when it cites none. */
export function evidenceReference(evidenceRef: string | null | undefined): string | null {
  const ref = evidenceRef?.trim();
  return ref ? ref : null;
}

// @version v0.9.0
