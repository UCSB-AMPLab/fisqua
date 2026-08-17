/**
 * Authority Code Format
 *
 * This module deals with the one shape rule that entity codes and place
 * codes share, kept in a single place so the two validators cannot drift
 * apart from each other or from the generator that mints the codes.
 *
 * An authority code is an agency prefix, a hyphen, and six characters:
 * `ne-abc234` for a record Neogranadina maintains, `sbmal-e-abc234` for
 * one the Santa Barbara Mission Archive-Library maintains. The prefix
 * names the maintaining agency and is configured per agency (migration
 * 0068), so the format cannot pin a literal prefix the way it used to;
 * what it CAN pin is the prefix's shape and, exactly, the six characters
 * that follow.
 *
 * Two facts live here:
 *
 *   - `AUTHORITY_CODE_ALPHABET` is the 30-character alphabet the
 *     generator draws from. It omits `i`, `l`, `o`, `u`, `0` and `1`:
 *     the first four because they are read aloud and transcribed wrongly
 *     in Spanish-language archival work, the digits because they are
 *     indistinguishable from `l` and `O` in most faces. It is the SOURCE
 *     of the character class below rather than a parallel statement of
 *     it — `app/lib/codes.server.ts` imports this constant, so generator
 *     and validator cannot disagree about which characters are legal.
 *
 *   - `AUTHORITY_CODE_RE` is the format the validators apply. The prefix
 *     segment is one to four groups of lowercase letters and digits,
 *     each closed by a hyphen (`ne-`, `sbmal-e-`), which admits every
 *     configured prefix while still rejecting a bare six-character
 *     string, a leading or doubled hyphen, uppercase, and anything with
 *     punctuation or whitespace in it. The trailing six characters are
 *     pinned to the real alphabet.
 *
 * Note on the character class: it is written as ranges
 * (`a-h`, `j`, `k`, `m`, `n`, `p-t`, `v-z`, `2-9`) that enumerate the
 * alphabet above exactly. The older `[a-z2-9]` it replaces was wrong in
 * both directions — it admitted `i`, `l`, `o` and `u`, which the
 * generator never emits, and its comment claimed a 32-character alphabet
 * that has never existed.
 *
 * @version v0.7.0
 */

/**
 * The characters an authority code's six-character tail is drawn from.
 * Thirty of them: no `i`, `l`, `o`, `u`, `0` or `1`.
 */
export const AUTHORITY_CODE_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";

/**
 * The same alphabet as a regular-expression character class. Kept
 * beside the alphabet it mirrors; the pairing is asserted in
 * `tests/admin/authority-code-prefix.test.ts`, which walks every
 * character of `AUTHORITY_CODE_ALPHABET` against it and every excluded
 * character against its negation.
 */
export const AUTHORITY_CODE_CHAR_CLASS = "[a-hjkmnp-tv-z2-9]";

/**
 * A configured agency prefix followed by six alphabet characters.
 * Accepts `ne-abc234` and `sbmal-e-abc234`; rejects `abc234` (no
 * prefix), `ne-abc23` / `ne-abc2345` (wrong length), `ne-abci23`
 * (character outside the alphabet), `NE-abc234` (uppercase),
 * `-ne-abc234` and `ne--abc234` (empty prefix segment).
 */
export const AUTHORITY_CODE_RE = new RegExp(
  `^(?:[a-z0-9]{1,24}-){1,4}${AUTHORITY_CODE_CHAR_CLASS}{6}$`,
);
