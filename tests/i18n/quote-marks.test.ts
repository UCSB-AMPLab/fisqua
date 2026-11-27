/**
 * Tests — interface strings quote with curly double quotes
 *
 * This suite reads every leaf string in every English and Spanish
 * locale namespace and refuses guillemets (« ») and straight double
 * quotes. Fisqua's interface text quotes with “ ” in both languages;
 * guillemets are kept for academic prose meant for publication, which
 * never passes through these files. The glob picks up a new namespace
 * without an edit here.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";

const locales = {
  en: import.meta.glob<{ default: unknown }>("../../app/locales/en/*.ts", { eager: true }),
  es: import.meta.glob<{ default: unknown }>("../../app/locales/es/*.ts", { eager: true }),
};

function leaves(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") out.push([path, value]);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out);
  }
}

describe.each(Object.entries(locales))("%s locale strings", (_lang, modules) => {
  it("reads at least ten namespaces", () => {
    expect(Object.keys(modules).length).toBeGreaterThan(10);
  });

  it("quote only with curly double quotes", () => {
    const offending: string[] = [];
    for (const [file, mod] of Object.entries(modules)) {
      const strings: Array<[string, string]> = [];
      leaves(mod.default, "", strings);
      for (const [key, text] of strings) {
        if (/[«»"]/.test(text)) offending.push(`${file.split("/").pop()} ${key}: ${text}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

// @version v0.9.0
