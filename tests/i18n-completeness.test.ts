import { describe, it, expect } from "vitest";
import es from "../app/locales/es";
import en from "../app/locales/en";

/**
 * Recursively extract all leaf keys as dot-notation paths.
 */
function extractKeys(
  obj: Record<string, unknown>,
  prefix = "",
): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      keys.push(...extractKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Recursively extract all leaf string values.
 */
function extractValues(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "object" && value !== null)
      strings.push(...extractValues(value as Record<string, unknown>));
  }
  return strings;
}

const NAMESPACES = [
  "common",
  "auth",
  "dashboard",
  "viewer",
  "workflow",
  "admin",
  "project",
  "description",
  "comments",
] as const;

describe("translation completeness", () => {
  it("every key in es namespace files has a corresponding en key", () => {
    const missing: string[] = [];
    for (const ns of NAMESPACES) {
      const esKeys = extractKeys(
        es[ns] as unknown as Record<string, unknown>,
      );
      const enKeys = new Set(
        extractKeys(en[ns] as unknown as Record<string, unknown>),
      );
      for (const key of esKeys) {
        if (!enKeys.has(key)) {
          missing.push(`${ns}:${key}`);
        }
      }
    }
    expect(missing, `ES keys missing in EN:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  it("every key in en namespace files has a corresponding es key", () => {
    const missing: string[] = [];
    for (const ns of NAMESPACES) {
      const enKeys = extractKeys(
        en[ns] as unknown as Record<string, unknown>,
      );
      const esKeys = new Set(
        extractKeys(es[ns] as unknown as Record<string, unknown>),
      );
      for (const key of enKeys) {
        if (!esKeys.has(key)) {
          missing.push(`${ns}:${key}`);
        }
      }
    }
    expect(missing, `EN keys missing in ES:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  it("no translation value is an empty string", () => {
    const empties: string[] = [];
    for (const ns of NAMESPACES) {
      for (const locale of ["es", "en"] as const) {
        const source = locale === "es" ? es : en;
        const keys = extractKeys(
          source[ns] as unknown as Record<string, unknown>,
        );
        const values = extractValues(
          source[ns] as unknown as Record<string, unknown>,
        );
        // Match keys to values positionally (both use same traversal order)
        values.forEach((val, i) => {
          if (val === "") {
            empties.push(`${locale}/${ns}:${keys[i]}`);
          }
        });
      }
    }
    expect(
      empties,
      `Empty translation values found:\n${empties.join("\n")}`,
    ).toEqual([]);
  });

  it("all 9 namespaces are present in both locales: common, auth, dashboard, viewer, workflow, admin, project, description, comments", () => {
    const esNs = Object.keys(es).sort();
    const enNs = Object.keys(en).sort();
    const expected = [...NAMESPACES].sort();
    expect(esNs).toEqual(expected);
    expect(enNs).toEqual(expected);
  });
});
