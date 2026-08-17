/**
 * Tests — i18n coverage (hardcoded-string scan)
 *
 * This suite is the structural backstop against hardcoded strings
 * creeping into the rendered surface. It uses Vite's
 * `import.meta.glob` to slurp every `.tsx` file under `app/routes/`
 * and `app/components/`, plus `app/root.tsx` — which renders the
 * app-wide error boundary and sat outside every glob until this
 * release — and parses each one with the TypeScript compiler's own
 * parser.
 *
 * Parsing replaced a line-by-line regex, and the change is what the
 * rule is for. The old extractor matched `>text<` on a single line,
 * so any text Prettier moved onto its own line was invisible; it read
 * only what sits between tags, so `placeholder`, `aria-label`, `alt`
 * and `title` — the attributes a screen reader actually announces —
 * were never examined at all; and it decided what counted as UI text
 * by testing against a closed list of English words, which missed
 * nine of the thirteen words in the strings it was meant to catch and
 * could never have flagged a hardcoded *Spanish* string. Walking the
 * syntax tree removes all three limits at once: a `JsxText` node is a
 * `JsxText` node however it is wrapped, and an attribute value is a
 * first-class node rather than a stretch of characters the regex
 * never reached.
 *
 * What counts as user-facing text is now a shape test rather than a
 * vocabulary: two or more Latin-script words separated by a space.
 * That reads as prose in either language, which matters because the
 * worst offender in the sweep behind this rewrite was a component
 * hardcoded in English and Spanish simultaneously. Values that are
 * deliberately untranslated — proper nouns, a required third-party
 * attribution, kebab-case technical tokens used as test handles —
 * live in `ALLOWED` below. The old header promised such an allowlist
 * and none existed; this one is real, and every entry is a triaged
 * exclusion rather than a silenced failure.
 *
 * A second assertion covers `meta()` exports, which no guard had ever
 * looked at: every one of the six in the tree shipped a literal
 * title, five of them Spanish-only, so the browser tab contradicted
 * the page under it. `_index.tsx` shows the working channel — the
 * loader resolves the locale and `meta()` reads it from loader data —
 * so the rule is simply that a `meta()` carrying literal `title:` or
 * `description:` text must demonstrably branch on a language value.
 *
 * The last two assertions are a separate rule with a wider scope:
 * they forbid any literal locale tag passed to an `Intl.*`
 * constructor or a `toLocale*` method, and the argument-less
 * `toLocaleString()` besides, anywhere under `app/`. The first
 * previously forbade only the literal `"en"` and ran only over the
 * routes-and-components glob, so a formatter pinned to `"es-CO"`
 * inside `app/lib/format.ts` was invisible twice over — wrong locale
 * literal and wrong file scope. A Spanish pin is exactly as
 * locale-blind as an English one, and a `.ts` helper is exactly as
 * user-facing as the component that renders its output.
 *
 * @version v0.7.0
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";

const routeFiles = import.meta.glob("../app/routes/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const componentFiles = import.meta.glob("../app/components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * `app/root.tsx` renders the app-wide `ErrorBoundary`, so its strings
 * reach every visitor on the worst day. It matched neither glob above
 * until this release.
 */
const rootFiles = import.meta.glob("../app/root.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Every source file under `app/`, for the hardcoded-locale assertion
 * only. The two globs above are scoped to routes and components
 * because the string heuristic reads JSX; a locale literal, by
 * contrast, is just as wrong inside a plain `.ts` helper — and in
 * fact `app/lib/format.ts` pinned `es-CO` for three releases without
 * ever entering the scanned set.
 */
const allSourceFiles = import.meta.glob("../app/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * Attribute values a screen reader or a tooltip renders as prose. An
 * `alt` is included because a decorative image carries `alt=""`,
 * which the shape test below passes over anyway, so anything left is
 * a described image.
 */
const TRANSLATABLE_ATTRIBUTES = new Set([
  "placeholder",
  "aria-label",
  "alt",
  "title",
]);

/**
 * Triaged exclusions: strings that are correct untranslated. Proper
 * nouns and the lab's attribution line (a condition of the MapTiler
 * and institutional credits), plus kebab-case tokens used as test and
 * automation handles rather than announced prose. An entry here is a
 * decision on the record, not a silenced failure — the rule below has
 * no other escape hatch.
 */
const ALLOWED = new Set([
  "",
  "Fisqua",
  "Neogranadina",
  "AMP Lab, UC Santa Barbara",
  "MapTiler",
  "region-pin",
  "open-flag-badge",
]);

/**
 * The shape test that replaced the closed English word-list: two or
 * more Latin-script words with a space between them. Language-blind
 * by design — a hardcoded Spanish string is exactly as untranslated
 * as a hardcoded English one — and it passes over the single tokens,
 * numerals, punctuation, class names and paths that make up most of
 * what sits inside JSX.
 */
function isProse(value: string): boolean {
  const text = value.trim();
  if (!text || ALLOWED.has(text)) return false;
  if (!/\s/.test(text)) return false;
  if (/https?:\/\//.test(text)) return false;
  const words = text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{2,}/g) ?? [];
  return words.length >= 2;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function parse(file: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Every literal string an attribute value is built from. A template
 * is reduced to its fixed parts, so `` `Remove variant: ${name}` ``
 * still reads as prose. Anything produced by a call — `t(...)` above
 * all — is skipped: the value is computed, and whether it resolves is
 * `i18n-keys.test.ts`'s question, not this one's.
 */
function literalStrings(node: ts.Node): string[] {
  const found: string[] = [];
  const walk = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) return;
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    ) {
      found.push(current.text);
      return;
    }
    if (ts.isTemplateExpression(current)) {
      found.push(
        [
          current.head.text,
          ...current.templateSpans.map((span) => span.literal.text),
        ].join(" "),
      );
      return;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
}

/**
 * Flag prose in `JsxText` nodes and in translatable attributes.
 * `<Trans>` children are skipped whole: their text is the translated
 * markup i18next reassembles, not a hardcoded string.
 */
function findHardcodedStrings(files: Record<string, string>): Violation[] {
  const violations: Violation[] = [];

  for (const [file, content] of Object.entries(files)) {
    const sf = parse(file, content);

    const visit = (node: ts.Node, insideTrans: boolean): void => {
      let trans = insideTrans;

      if (ts.isJsxElement(node)) {
        trans =
          trans || node.openingElement.tagName.getText(sf) === "Trans";
      }

      if (ts.isJsxText(node) && !trans && isProse(node.text)) {
        violations.push({
          file,
          line: lineOf(sf, node),
          text: node.text.trim(),
        });
      }

      if (
        ts.isJsxAttribute(node) &&
        node.initializer &&
        TRANSLATABLE_ATTRIBUTES.has(node.name.getText(sf))
      ) {
        for (const value of literalStrings(node.initializer)) {
          if (isProse(value)) {
            violations.push({
              file,
              line: lineOf(sf, node),
              text: `${node.name.getText(sf)}="${value.trim()}"`,
            });
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, trans));
    };
    visit(sf, false);
  }

  return violations;
}

/**
 * Flag literal `title:` / `description:` values inside a `meta()`
 * export. A file that reads a language value somewhere — the
 * loader-to-`meta` channel `_index.tsx` established — is exempt: it
 * is branching on the locale, which is the whole point.
 */
function findHardcodedMeta(files: Record<string, string>): Violation[] {
  const violations: Violation[] = [];
  // `content` is here because React Router writes a page description as
  // `{ name: "description", content: … }`, so a rule reading only a
  // `description:` property would cover the tab title and nothing else.
  const META_FIELDS = new Set(["title", "description", "content"]);

  for (const [file, content] of Object.entries(files)) {
    if (/\blang\b/.test(content)) continue;
    const sf = parse(file, content);

    const inspect = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        META_FIELDS.has(node.name.text)
      ) {
        for (const value of literalStrings(node.initializer)) {
          if (value.trim()) {
            violations.push({
              file,
              line: lineOf(sf, node),
              text: `${node.name.text}: "${value.trim()}"`,
            });
          }
        }
      }
      ts.forEachChild(node, inspect);
    };

    const findMeta = (node: ts.Node): void => {
      const exported = ts
        .getCombinedModifierFlags(node as ts.Declaration)
        .valueOf();
      const isExported = (exported & ts.ModifierFlags.Export) !== 0;
      if (
        isExported &&
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "meta"
      ) {
        inspect(node);
      }
      if (
        isExported &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "meta"
      ) {
        inspect(node);
      }
      ts.forEachChild(node, findMeta);
    };
    findMeta(sf);
  }

  return violations;
}

describe("i18n string coverage", () => {
  it("no route or root-level .tsx file renders a hardcoded string", () => {
    const violations = findHardcodedStrings({ ...routeFiles, ...rootFiles });
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: "${v.text}"`)
      .join("\n");
    expect(
      violations,
      `Hardcoded user-facing strings in routes — wrap in t() or, if the string is correct untranslated, add it to ALLOWED in this file:\n${formatted}`,
    ).toEqual([]);
  });

  it("no component .tsx file renders a hardcoded string", () => {
    const violations = findHardcodedStrings(componentFiles);
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: "${v.text}"`)
      .join("\n");
    expect(
      violations,
      `Hardcoded user-facing strings in components — wrap in t() or, if the string is correct untranslated, add it to ALLOWED in this file:\n${formatted}`,
    ).toEqual([]);
  });

  it("no meta() export hardcodes its title or description", () => {
    const violations = findHardcodedMeta({ ...routeFiles, ...rootFiles });
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
      .join("\n");
    expect(
      violations,
      `meta() strings that never branch on the active language — read the locale from loader data as app/routes/_index.tsx does:\n${formatted}`,
    ).toEqual([]);
  });

  it("no Intl or toLocale* call hardcodes a locale tag", () => {
    const violations: { file: string; line: number; text: string }[] = [];

    // Any string-literal first argument to an `Intl.*` constructor or a
    // `toLocale*` method. The previous form of this rule forbade only
    // the literal `"en"`, which let `"es-CO"` and `"en-US"` through —
    // and since a Spanish-pinned formatter is exactly as locale-blind
    // as an English-pinned one, the asymmetry is what allowed
    // `app/lib/format.ts` to ship a hardcoded `es-CO`. The locale must
    // always derive from the active language, never from a literal.
    const HARDCODED_LOCALE_PATTERNS = [
      /\bIntl\.[A-Za-z]+\(\s*["'`]/,
      /\.toLocale[A-Za-z]*\(\s*["'`]/,
    ];

    for (const [file, content] of Object.entries(allSourceFiles)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (HARDCODED_LOCALE_PATTERNS.some((p) => p.test(lines[i]))) {
          violations.push({
            file,
            line: i + 1,
            text: lines[i].trim(),
          });
        }
      }
    }

    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
      .join("\n");
    expect(
      violations,
      `Hardcoded locale tag in an Intl / toLocale* call — format through the active language instead (see app/lib/format.ts):\n${formatted}`,
    ).toEqual([]);
  });

  it("no toLocale* call at all — formatting goes through app/lib/format.ts", () => {
    const violations: { file: string; line: number; text: string }[] = [];

    // The previous assertion catches a hardcoded tag; this one catches
    // the argument-LESS form, which is subtler and just as wrong:
    // `n.toLocaleString()` renders in the runtime's default locale, so
    // the number inside a carefully translated sentence follows the
    // server's locale on the SSR pass and the visitor's OS locale
    // after hydration — an i18n bug and a hydration mismatch at once
    // (eight such leaks shipped at the interpolation boundary before
    // this rule). Every date and number formats through the helpers in
    // app/lib/format.ts (components via useFormatters), which own the
    // language-to-Intl-tag mapping.
    const TO_LOCALE_CALL = /\.toLocale[A-Za-z]*\(/;

    for (const [file, content] of Object.entries(allSourceFiles)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (TO_LOCALE_CALL.test(lines[i])) {
          violations.push({ file, line: i + 1, text: lines[i].trim() });
        }
      }
    }

    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
      .join("\n");
    expect(
      violations,
      `toLocale* call outside app/lib/format.ts — use formatDate/formatDateTime/formatNumber/relativeTime (components: useFormatters) so the output follows the active UI language:\n${formatted}`,
    ).toEqual([]);
  });
});
