/**
 * Media Pipeline — Comparing Two JSON Values
 *
 * This module deals with one question publishing and the manifest
 * refresh both ask: are two JSON values the same, and where do they
 * first differ? `firstDifference(actual, expected)` answers with the
 * JSON path of the first difference, or null when there is none. It
 * imports nothing, so a module of pure functions can use it without
 * loading the publish action.
 *
 * @version v0.9.0
 */

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON path of the first place two JSON values differ, or null when
 * they are equal: the same keys at every level, arrays in the same order
 * and length, scalars strictly equal. Key order does not matter. Keys
 * are walked in the expected value's order, so the path is stable.
 */
export function firstDifference(actual: unknown, expected: unknown, path = "$"): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return path;
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(actual[i], expected[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return path;
    const extra = Object.keys(actual)
      .filter((k) => !Object.prototype.hasOwnProperty.call(expected, k))
      .sort();
    if (extra.length > 0) return `${path}.${extra[0]}`;
    for (const k of Object.keys(expected)) {
      if (!Object.prototype.hasOwnProperty.call(actual, k)) return `${path}.${k}`;
      const d = firstDifference(actual[k], expected[k], `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return actual === expected ? null : path;
}

// @version v0.9.0
