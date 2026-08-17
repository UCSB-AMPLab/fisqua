/**
 * Tests — i18n key resolution
 *
 * This suite is the structural backstop that pins every translation
 * key a source file *asks for* to a key the bundles actually *carry*.
 * Its sibling `i18n-completeness.test.ts` compares the two bundles
 * against each other, so it can only see a key that exists on one
 * side and not the other. A key that exists in neither — a typo like
 * `toolbar.zoomOut` for `toolbar.zoom_out`, or a whole namespace that
 * was never registered — produces no EN/ES difference at all and is
 * invisible to it. That is the gap this file closes: it reads the
 * call sites rather than the bundles.
 *
 * The scan parses each file with the TypeScript compiler's own
 * parser rather than grepping lines, because the namespace a key
 * resolves against is a scoping fact, not a textual one: a key is
 * either prefixed (`t("viewer:outline.no_title")`), or it inherits
 * the namespace from the `useTranslation()` call that produced the
 * `t` binding — including aliased destructuring such as
 * `const { t: te } = useTranslation("entities")` and multi-namespace
 * arrays, where i18next tries each namespace in order. Unprefixed
 * keys whose binding cannot be traced to a `useTranslation()` in the
 * same file (a `t` received as a function parameter, for instance)
 * are counted and reported, never failed — guessing their namespace
 * would manufacture false alarms.
 *
 * Three things fail the suite. A static key missing from either
 * bundle. A namespace passed to `useTranslation()` that no bundle
 * registers. And a `t()` call carrying a prose `defaultValue`: those
 * are how the missing keys hid, because i18next returns the
 * defaultValue whenever the key does not resolve — regardless of the
 * active language — so a Spanish fallback string reaches an English
 * reader and nothing anywhere reports a fault.
 *
 * Keys assembled at runtime (`` t(`status.${status}`) ``) cannot be
 * resolved statically. They are counted and surfaced in the passing
 * assertion's message so the size of that unmeasurable surface stays
 * visible and cannot quietly grow.
 *
 * Plural suffixes are honoured: a key counts as present when the
 * bundle carries `key`, `key_one`, `key_other` or any other CLDR
 * plural form. The `descriptions` namespace is aliased to
 * `descriptions_admin`, mirroring the bundle index.
 *
 * @version v0.7.0
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import en from "../app/locales/en";
import es from "../app/locales/es";

const sourceFiles = import.meta.glob("../app/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// The bundles themselves declare keys, they never consume them.
const SCANNED = Object.entries(sourceFiles).filter(
  ([file]) => !file.includes("/app/locales/"),
);

/** `en.ts` imports `./en/descriptions` and re-exports it under this name. */
const NS_ALIAS: Record<string, string> = {
  descriptions: "descriptions_admin",
};

/** i18next's configured `defaultNS` — see `app/middleware/i18next.ts`. */
const DEFAULT_NS = "common";

const PLURAL_SUFFIXES = [
  "_zero",
  "_one",
  "_two",
  "_few",
  "_many",
  "_other",
];

const bundles = { en, es } as const;

const NAMESPACES = new Set(Object.keys(en));

type Bundle = Record<string, unknown>;

/**
 * Whether `ns:key` resolves in one bundle. i18next's own `deepFind`
 * tries the whole dotted key as a single property before splitting on
 * the separator, so both `{ field: { displayName } }` and the flat
 * `{ "field.displayName": … }` several namespaces use are legitimate
 * — this mirrors that order. A path landing on a nested object counts
 * as present: addressing a block is a different defect from a key
 * that does not exist.
 */
function resolves(bundle: Bundle, ns: string, key: string): boolean {
  const nsObj = bundle[NS_ALIAS[ns] ?? ns];
  if (!nsObj || typeof nsObj !== "object") return false;

  const walk = (path: string[]): boolean => {
    let node: unknown = nsObj;
    for (const segment of path) {
      if (!node || typeof node !== "object") return false;
      node = (node as Record<string, unknown>)[segment];
    }
    return node !== undefined;
  };

  const present = (candidate: string): boolean =>
    walk([candidate]) || walk(candidate.split("."));

  if (present(key)) return true;
  return PLURAL_SUFFIXES.some((suffix) => present(`${key}${suffix}`));
}

interface KeyUse {
  file: string;
  line: number;
  /**
   * Candidate namespaces, in i18next's own resolution order — or an
   * empty list when the translator arrived as a prop and its namespace
   * is not a static fact of this file. An empty list is checked
   * against every namespace at once: a key present under some other
   * namespace is unverifiable, but a key present under none is a miss
   * whatever the prop carries.
   */
  namespaces: string[];
  key: string;
  raw: string;
}

interface Finding {
  file: string;
  line: number;
  detail: string;
}

const staticUses: KeyUse[] = [];
const namespaceUses: Finding[] = [];
const defaultValueUses: Finding[] = [];
let dynamicCount = 0;
let unscopedCount = 0;

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** The text of a literal that is fully known at parse time. */
function staticText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isJsxExpression(node)) return staticText(node.expression);
  return undefined;
}

/** The namespaces a `useTranslation(...)` argument list requests. */
function namespacesFromArgument(arg: ts.Node | undefined): string[] {
  if (!arg) return [DEFAULT_NS];
  const single = staticText(arg);
  if (single) return [single];
  if (ts.isArrayLiteralExpression(arg)) {
    const names = arg.elements
      .map((element) => staticText(element))
      .filter((name): name is string => Boolean(name));
    if (names.length) return names;
  }
  return [];
}

function optionsProperty(
  args: readonly ts.Expression[],
  name: string,
): ts.PropertyAssignment | undefined {
  const options = args[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return options.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  );
}

for (const [file, content] of SCANNED) {
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const record = (
    node: ts.Node,
    namespaces: string[],
    rawKey: string,
  ): void => {
    const separator = rawKey.indexOf(":");
    const scoped =
      separator > 0 ? [rawKey.slice(0, separator)] : namespaces;
    if (!scoped.length) unscopedCount += 1;
    staticUses.push({
      file,
      line: lineOf(sf, node),
      namespaces: scoped,
      key: separator > 0 ? rawKey.slice(separator + 1) : rawKey,
      raw: rawKey,
    });
  };

  // A file often declares several components, each with its own
  // `useTranslation()`, so the namespace a bare `t("key")` inherits is
  // whichever binding is in scope at the call site — not whichever one
  // the file happens to declare last.
  const isScopeBoundary = (node: ts.Node): boolean =>
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node);

  const bindTranslators = (
    node: ts.VariableDeclaration,
    scope: Map<string, string[]>,
  ): void => {
    if (
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isIdentifier(node.initializer.expression) ||
      node.initializer.expression.text !== "useTranslation"
    ) {
      return;
    }
    const namespaces = namespacesFromArgument(node.initializer.arguments[0]);
    for (const ns of namespaces) {
      if (!NAMESPACES.has(NS_ALIAS[ns] ?? ns)) {
        namespaceUses.push({
          file,
          line: lineOf(sf, node.initializer),
          detail: `useTranslation("${ns}") — no such namespace in the bundles`,
        });
      }
    }
    if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (
          ts.isIdentifier(property) &&
          property.text === "t" &&
          ts.isIdentifier(element.name)
        ) {
          scope.set(element.name.text, namespaces);
        }
      }
    } else if (ts.isIdentifier(node.name)) {
      scope.set(`${node.name.text}.t`, namespaces);
    }
  };

  const visit = (node: ts.Node, outer: Map<string, string[]>): void => {
    const scope = isScopeBoundary(node) ? new Map(outer) : outer;

    if (ts.isVariableDeclaration(node)) bindTranslators(node, scope);

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let namespaces: string[] | undefined;
      if (ts.isIdentifier(callee)) {
        namespaces =
          scope.get(callee.text) ?? (callee.text === "t" ? [] : undefined);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "t"
      ) {
        namespaces = scope.get(`${callee.expression.getText(sf)}.t`) ?? [];
      }

      if (namespaces) {
        const nsOption = staticText(
          optionsProperty(node.arguments, "ns")?.initializer,
        );
        const keyNamespaces = nsOption ? [nsOption] : namespaces;
        const key = staticText(node.arguments[0]);
        if (key === undefined) dynamicCount += 1;
        else record(node, keyNamespaces, key);

        const fallback =
          optionsProperty(node.arguments, "defaultValue")?.initializer ??
          (node.arguments.length > 1 ? node.arguments[1] : undefined);
        const fallbackText = staticText(fallback);
        if (fallbackText && /\S\s+\S/.test(fallbackText)) {
          defaultValueUses.push({
            file,
            line: lineOf(sf, node),
            detail: `${key ?? "<dynamic>"} -> "${fallbackText}"`,
          });
        }
      }
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText(sf) === "Trans") {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const attr = (name: string) =>
          staticText(
            attributes.find((a) => a.name.getText(sf) === name)?.initializer,
          );
        const key = attr("i18nKey");
        const ns = attr("ns");
        if (key === undefined) dynamicCount += 1;
        else record(node, ns ? [ns] : (scope.get("t") ?? []), key);
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sf, new Map());
}

describe("i18n key resolution", () => {
  it("every static t() / <Trans> key resolves in both bundles", () => {
    const missing: string[] = [];
    for (const use of staticUses) {
      const candidates = use.namespaces.length
        ? use.namespaces
        : [...NAMESPACES];
      const found = (Object.keys(bundles) as (keyof typeof bundles)[]).filter(
        (locale) =>
          candidates.some((ns) =>
            resolves(bundles[locale] as Bundle, ns, use.key),
          ),
      );
      if (found.length < 2) {
        const where = use.namespaces.length
          ? use.namespaces.join(" | ")
          : "any namespace";
        const absent = found.length
          ? `missing in ${found[0] === "en" ? "es" : "en"}`
          : "missing in both locales";
        missing.push(
          `  ${use.file}:${use.line}: "${use.raw}" (${where}) — ${absent}`,
        );
      }
    }
    expect(
      missing,
      `Translation keys that do not resolve. ` +
        `${staticUses.length} static keys checked, of which ${unscopedCount} ` +
        `only against the union of all namespaces (translator passed in as a ` +
        `prop); a further ${dynamicCount} keys are built at runtime and ` +
        `cannot be checked at all:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("every useTranslation namespace exists in the bundles", () => {
    const formatted = namespaceUses
      .map((v) => `  ${v.file}:${v.line}: ${v.detail}`)
      .join("\n");
    expect(
      namespaceUses,
      `Namespace requested by a component but registered in neither bundle — ` +
        `every key read through it silently falls through:\n${formatted}`,
    ).toEqual([]);
  });

  it("no t() call carries a prose defaultValue", () => {
    const formatted = defaultValueUses
      .map((v) => `  ${v.file}:${v.line}: ${v.detail}`)
      .join("\n");
    expect(
      defaultValueUses,
      `A prose defaultValue is returned whenever the key fails to resolve, ` +
        `in every language alike — which is how nine Spanish strings reached ` +
        `the English UI. Add the key to both bundles instead:\n${formatted}`,
    ).toEqual([]);
  });
});
