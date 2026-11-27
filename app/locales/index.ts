/**
 * Locale Resource Bundle
 *
 * This module deals with the top-level i18next resource map — the
 * `{ es, en }` shape that both the server middleware (`i18nextMiddleware`)
 * and the client hydration entry (`entry.client.tsx`) load to wire
 * up Spanish and English translations. Each per-language entry is a
 * pre-aggregated namespace map built by `./es.ts` and `./en.ts`.
 * Spanish is listed first because Fisqua's fallback language is `es`.
 *
 * Spanish's CLDR plural rules put exact millions (1,000,000,
 * 2,000,000, …) in the `many` category, and i18next renders the bare
 * key name when a plural key has no `_many` form. The Spanish strings
 * are written with `_one` and `_other` only, so the Spanish entry here
 * is the authored bundle with every plural key that lacks a `_many`
 * given one with the text of its `_other`. A key counts as a plural
 * only when it has both a `_one` and an `_other` form; a lone `_other`
 * key (such as an "Other" option label) is left as written. A key
 * that carries its own `_many` keeps it. The authored files stay as written, so the EN/ES
 * symmetry tests compare them like with like; English passes through
 * unchanged.
 *
 * @version v0.9.0
 */
import type { Resource } from "i18next";
import es from "./es";
import en from "./en";

const OTHER = "_other";

/**
 * A copy of `node` in which every `<key>_other` string with a
 * `<key>_one` sibling and no `<key>_many` sibling gains a `<key>_many`
 * with the same text, at every depth.
 * The input is not modified.
 */
export function addManyFromOther<T extends Record<string, unknown>>(node: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? addManyFromOther(value as Record<string, unknown>)
        : value;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== "string" || !key.endsWith(OTHER)) continue;
    const base = key.slice(0, -OTHER.length);
    if (typeof node[`${base}_one`] !== "string") continue;
    const many = `${base}_many`;
    if (!(many in out)) out[many] = value;
  }
  return out as T;
}

export default { es: addManyFromOther(es), en } satisfies Resource;

// @version v0.9.0
