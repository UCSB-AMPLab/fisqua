/**
 * Capture Pairing — Codes and Collect Secrets
 *
 * This module makes and reads the code a Captua unit shows while it
 * waits to be linked to its workspace, and the secret the unit polls
 * with. It is pure and uses only the global Web Crypto, so the Worker
 * and the operator's commands can both import it.
 *
 * A code is 6 characters of Crockford base 32
 * (`PAIRING_CODE_ALPHABET`), drawn uniformly by `newPairingCode` and
 * displayed as `XXX-XXX` by `formatPairingCode`. `normalizePairingCode`
 * reads what a person typed: it ignores case, spaces (U+0020) and
 * hyphens (U+002D), reads `I` and `L` as `1` and `O` as `0`, and returns
 * null unless exactly 6 alphabet characters remain. Any other
 * whitespace, or any character outside printable ASCII, makes the entry
 * null; the check comes before upper-casing, which would otherwise turn
 * letters such as `ß` or `ı` into ASCII ones.
 *
 * A code has to be approved within `CODE_TTL_MS` of issue and collected
 * within `COLLECT_TTL_MS` of approval; the unit is told to poll every
 * `POLL_SECONDS`. `newCollectSecret` is 32 random bytes as 64 lowercase
 * hex characters. Fisqua stores only the SHA-256 of the code and of the
 * secret.
 *
 * @version v0.9.0
 */

export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_TTL_MS = 120_000;
export const COLLECT_TTL_MS = 120_000;
export const POLL_SECONDS = 5;

const CODE_LENGTH = 6;

export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // The alphabet has 32 symbols and 256 is a multiple of 32, so the low
  // 5 bits of a uniform byte are uniform over the alphabet. No byte has
  // to be rejected.
  let code = "";
  for (const b of bytes) code += PAIRING_CODE_ALPHABET[b & 31];
  return code;
}

export function normalizePairingCode(input: string): string | null {
  const stripped = input.replace(/[ -]/g, "");
  if (!/^[\x21-\x7E]*$/.test(stripped)) return null;
  const code = stripped
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) {
    if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  }
  return code;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function newCollectSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// @version v0.9.0
