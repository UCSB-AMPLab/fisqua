/** 30-char alphabet: no i/l/o/u/0/1 to avoid visual ambiguity */
export const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";

/**
 * Generate a batch of unique neogranadina codes using in-memory Set
 * for collision avoidance.
 *
 * @param prefix - "ne" for entities, "nl" for places
 * @param count - Number of unique codes to generate
 * @returns Array of unique codes in {prefix}-{6chars} format
 */
export function generateUniqueCodes(
  prefix: "ne" | "nl",
  count: number
): string[] {
  const codes = new Set<string>();
  let retries = 0;
  const maxRetries = 100;

  while (codes.size < count) {
    const chars = Array.from({ length: 6 }, () =>
      ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    ).join("");
    const code = `${prefix}-${chars}`;

    if (codes.has(code)) {
      retries++;
      if (retries > maxRetries) {
        throw new Error(
          `Failed to generate unique ${prefix} code after ${maxRetries} collision retries`
        );
      }
      continue;
    }

    codes.add(code);
    retries = 0;
  }

  return [...codes];
}
