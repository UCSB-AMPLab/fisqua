/**
 * Tests — Spanish exact millions take the plural form
 *
 * This suite pins that Spanish exact millions take the plural form.
 * Spanish's CLDR plural rules put exact millions (1,000,000, 2,000,000, …)
 * in the `many` category, and i18next looks for a `_many` key there. The
 * Spanish strings are written with `_one` and `_other` only, so the
 * resource map in `app/locales/index.ts` gives every Spanish plural key
 * (one with both `_one` and `_other`) a `_many` with the text of its
 * `_other` when it builds the bundle; a lone `_other` key gets none. The
 * suite pins that on a real i18next instance over the same resource map
 * the server middleware and the client entry load: for a million, i18next
 * renders the `_other` text, for one `_one`, for two `_other`. It also
 * pins that a key carrying its own `_many` keeps it, that the authored
 * Spanish files stay untouched (so the EN/ES symmetry check in
 * `i18n-completeness.test.ts` still compares like with like), and that
 * English is unchanged.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { createInstance } from "i18next";
import resources, { addManyFromOther } from "../app/locales";
import en from "../app/locales/en";
import es from "../app/locales/es";

async function translator(lng: "en" | "es") {
  const i18n = createInstance();
  await i18n.init({
    lng,
    fallbackLng: "es",
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false },
  });
  return i18n.t.bind(i18n);
}

describe("Spanish plural keys at exact millions", () => {
  it.each([
    [1_000_000, "pares candidatos · ordenados de mayor a menor coincidencia"],
    [2_000_000, "pares candidatos · ordenados de mayor a menor coincidencia"],
    [1, "par candidato"],
    [2, "pares candidatos · ordenados de mayor a menor coincidencia"],
  ])("authorities:dupCountLine with count %i", async (count, expected) => {
    const t = await translator("es");
    expect(t("authorities:dupCountLine", { count })).toBe(expected);
  });

  it("a nested plural key renders its _other text for a million", async () => {
    const t = await translator("es");
    expect(t("domain.document_count", { count: 1_000_000 })).toBe(
      t("domain.document_count", { count: 3 }).replace("3", "1000000"),
    );
  });

  it("no Spanish plural key renders as its bare name for a million", () => {
    const missing: string[] = [];
    const walk = (node: Record<string, unknown>, path: string) => {
      for (const [key, value] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        if (value && typeof value === "object") {
          walk(value as Record<string, unknown>, here);
        } else if (key.endsWith("_other")) {
          const base = key.slice(0, -"_other".length);
          if (typeof node[`${base}_one`] !== "string") continue;
          if (typeof node[`${base}_many`] !== "string") missing.push(here);
        }
      }
    };
    walk(resources.es as Record<string, unknown>, "");
    expect(missing, `Spanish plural keys with no _many:\n${missing.join("\n")}`).toEqual([]);
  });

  it("a lone _other key with no _one sibling gets no _many", () => {
    const built = addManyFromOther({
      ns: { subtype_other: "Otro", nested: { changed_by_other: "Otra persona" } },
    }) as Record<string, Record<string, unknown>>;
    expect(built.ns).not.toHaveProperty("subtype_many");
    expect(built.ns.nested).not.toHaveProperty("changed_by_many");
    const viewer = (resources.es as Record<string, Record<string, unknown>>).viewer;
    expect(JSON.stringify(viewer)).not.toMatch(/subtype_many/);
    const capture = (resources.es as Record<string, Record<string, unknown>>).capture;
    expect(JSON.stringify(capture)).not.toMatch(/changed_by_many/);
  });

  it("a key with its own _many keeps it", () => {
    const built = addManyFromOther({
      ns: {
        own_one: "uno",
        own_many: "de millones",
        own_other: "varios",
        plain_one: "uno",
        plain_other: "varios",
        nested: { deep_one: "uno", deep_other: "varios" },
      },
    }) as Record<string, Record<string, unknown>>;
    expect(built.ns.own_many).toBe("de millones");
    expect(built.ns.plain_many).toBe("varios");
    expect((built.ns.nested as Record<string, string>).deep_many).toBe("varios");
  });

  it("leaves the authored Spanish bundle without _many keys", () => {
    expect(JSON.stringify(es)).not.toMatch(/_many"/);
    expect(resources.es).not.toBe(es);
  });

  it("leaves English exactly as authored", async () => {
    expect(resources.en).toBe(en);
    const t = await translator("en");
    expect(t("authorities:dupCountLine", { count: 1 })).toBe("candidate pair");
    expect(t("authorities:dupCountLine", { count: 1_000_000 })).toBe(
      "candidate pairs · sorted by match strength",
    );
  });
});

// @version v0.9.0
