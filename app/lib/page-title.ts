/**
 * Page Titles
 *
 * This module deals with the text a browser tab shows for a Fisqua
 * page. Every page that renders gets a title of the form
 * `<part> | <part> | Fisqua`, most specific part first: a record's
 * name, then the section it belongs to, then the product name. The
 * separator and the suffix are defined here and nowhere else.
 *
 * `titleLang` reads the language a request was rendered in. The root
 * loader returns it as `lang`, and a `meta()` export receives every
 * matched route's data in `matches`, so a route needs no loader change
 * to know its language; a route whose own loader data carries `lang`
 * (the login and wrong-workspace pages) takes that first. When neither
 * is present the language is English.
 *
 * `label` looks a heading up in the same locale bundles the page
 * renders from, as `"namespace:dotted.key"`, and fills `{{name}}`
 * placeholders from the variables given. It reads the bundles
 * directly because `meta()` runs outside React, with no `t` function
 * in reach. A key missing from the requested language falls back to
 * English, then to the key's last segment, so a tab never shows an
 * empty title.
 *
 * `pageMeta` ties the three together for the common route:
 * `pageMeta(args, heading("capture:retakes.title"))` for a page with a
 * fixed heading, or
 * `pageMeta(args, data?.volume?.referenceCode, heading("descriptions_admin:page_title"))`
 * for a page about one record. Plain strings are used as given;
 * parts that are empty or missing are dropped.
 *
 * @version v0.9.0
 */

import resources from "../locales";
import type { Language } from "./format";

/** The product name every title ends with. */
export const TITLE_SUFFIX = "Fisqua";

/** Separator between the parts of a title. */
export const TITLE_SEPARATOR = " | ";

type Bundles = Record<string, Record<string, unknown>>;

function walk(node: unknown, path: string): string | undefined {
  if (typeof node === "string") return path === "" ? node : undefined;
  if (!node || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  // A literal dotted key wins over drilling, as in i18next.
  if (path in record && typeof record[path] === "string") {
    return record[path] as string;
  }
  const dot = path.indexOf(".");
  if (dot === -1) return undefined;
  for (let at = dot; at !== -1; at = path.indexOf(".", at + 1)) {
    const head = path.slice(0, at);
    if (head in record) {
      const found = walk(record[head], path.slice(at + 1));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function split(ref: string): { ns: string; key: string } {
  const colon = ref.indexOf(":");
  return colon === -1
    ? { ns: "common", key: ref }
    : { ns: ref.slice(0, colon), key: ref.slice(colon + 1) };
}

/**
 * The text of `"namespace:dotted.key"` in one language, or undefined
 * when that language has no such key. No English fallback.
 */
export function lookup(lang: Language, ref: string): string | undefined {
  const { ns, key } = split(ref);
  const all = resources as unknown as Record<string, Bundles>;
  return walk(all[lang]?.[ns], key);
}

/**
 * Resolve `"namespace:dotted.key"` in the given language, filling
 * `{{name}}` placeholders from `vars`.
 */
export function label(
  lang: Language,
  ref: string,
  vars?: Record<string, string | number>,
): string {
  const found =
    lookup(lang, ref) ?? lookup("en", ref) ?? split(ref).key.split(".").pop() ?? ref;
  if (!vars) return found;
  return found.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

type MatchLike = { data?: unknown } | undefined;

/**
 * The language a `meta()` call should write in: the route's own data
 * when it carries `lang`, else the root loader's.
 */
export function titleLang(args: {
  data?: unknown;
  matches?: ReadonlyArray<MatchLike>;
}): Language {
  const own = (args.data as { lang?: unknown } | null | undefined)?.lang;
  if (own === "es" || own === "en") return own;
  const root = (args.matches?.[0]?.data as { lang?: unknown } | undefined)?.lang;
  return root === "es" ? "es" : "en";
}

/** Join title parts, most specific first, ending with the product name. */
export function pageTitle(...parts: Array<string | null | undefined>): string {
  const kept = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part !== "");
  return [...kept, TITLE_SUFFIX].join(TITLE_SEPARATOR);
}

/**
 * One part of a title: text already in hand (a record's name), or a
 * heading reference made with `heading()`, which is looked up in the
 * request's language.
 */
export type TitlePart =
  | string
  | null
  | undefined
  | { ref: string; vars?: Record<string, string | number> };

/** The `meta()` result for a page. */
export function pageMeta(
  args: { data?: unknown; matches?: ReadonlyArray<MatchLike> },
  ...parts: TitlePart[]
): Array<{ title: string }> {
  const lang = titleLang(args);
  const resolved = parts.map((part) =>
    part && typeof part === "object" ? label(lang, part.ref, part.vars) : part,
  );
  return [{ title: pageTitle(...resolved) }];
}

/**
 * The name of the project a `/projects/:id/...` page belongs to, read
 * from the project layout's loader data, or null outside one.
 */
export function projectName(args: {
  matches?: ReadonlyArray<({ id?: string; data?: unknown } | undefined)>;
}): string | null {
  const layout = args.matches?.find((m) => m?.id === "routes/_auth.projects.$id");
  const name = (layout?.data as { project?: { name?: unknown } } | undefined)
    ?.project?.name;
  return typeof name === "string" ? name : null;
}

/** Shorthand for a heading reference in `pageMeta`. */
export function heading(
  ref: string,
  vars?: Record<string, string | number>,
): TitlePart {
  return { ref, vars };
}

/* @version v0.9.0 */
