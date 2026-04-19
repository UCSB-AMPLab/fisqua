/**
 * Tests — i18n coverage
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";

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
 * Detect suspected hardcoded English UI strings in JSX content.
 *
 * Returns an array of { file, line, text } for violations found.
 * This is a best-effort heuristic per the plan's requirements.
 */
function findHardcodedStrings(
  files: Record<string, string>,
): { file: string; line: number; text: string }[] {
  const violations: { file: string; line: number; text: string }[] = [];

  // Patterns for lines to skip entirely
  const SKIP_LINE = [
    /^\s*\/\//, // single-line comment
    /^\s*\*/, // multi-line comment continuation
    /^\s*\/\*/, // multi-line comment start
    /^\s*import\s/, // import statement
    /^\s*export\s/, // export statement
    /^\s*console\./, // console calls
    /^\s*type\s+\w+/, // type declarations
    /^\s*interface\s+\w+/, // interface declarations
    /^\s*return\s*;/, // bare return
  ];

  // Match JSX text content: text between > and < that contains English words
  // Also match string literals assigned to user-visible props like title=, label=, placeholder=
  const JSX_TEXT = />([^<>{]+)</g;

  // Common English words that indicate untranslated UI text (3+ letters)
  const ENGLISH_WORDS =
    /\b(the|and|for|are|but|not|you|all|can|her|was|one|our|out|has|his|how|its|may|new|now|old|see|way|who|did|get|let|say|she|too|use|with|from|have|this|that|will|each|make|like|long|look|many|some|them|then|what|when|your|about|after|could|every|first|found|great|little|other|their|these|under|where|which|while|would|should|before|through|delete|cancel|save|submit|create|edit|update|remove|close|open|back|next|previous|loading|search|error|success|warning|confirm|approve|reject|assign|login|logout|welcome|settings|profile|dashboard|status|actions|details|title|description|page|name|email|role|none)\b/i;

  // Patterns that indicate the string is technical, not UI text
  const TECHNICAL = [
    /^[\s\d.,;:!?()\-/\\|@#$%^&*=+[\]{}'"<>~`]+$/, // only punctuation/numbers
    /^[a-z][a-zA-Z]+\(/, // function call
    /^[A-Z_]+$/, // constant name
    /https?:\/\//, // URL
    /^\/[a-z]/, // path
    /\.[a-z]{2,4}$/, // file extension
    /^[a-z]+-[a-z]+/, // kebab-case (CSS class, data attr)
    /^(true|false|null|undefined)$/, // literals
    /^\s*$/, // whitespace only
    /aria-/, // ARIA
    /data-/, // data attributes
    /testid/, // test IDs
    /className/, // className prop
  ];

  for (const [file, content] of Object.entries(files)) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip non-UI lines
      if (SKIP_LINE.some((p) => p.test(line))) continue;

      // Skip lines that use t() or <Trans> (already internationalised)
      if (/\bt\(/.test(line) || /<Trans[\s>]/.test(line)) continue;

      // Look for JSX text content
      let match;
      JSX_TEXT.lastIndex = 0;
      while ((match = JSX_TEXT.exec(line)) !== null) {
        const text = match[1].trim();
        if (!text) continue;

        // Skip technical strings
        if (TECHNICAL.some((p) => p.test(text))) continue;

        // Skip interpolation-only content like {variable}
        if (/^\{[^}]+\}$/.test(text)) continue;

        // Check for English words
        if (ENGLISH_WORDS.test(text)) {
          violations.push({ file, line: i + 1, text });
        }
      }
    }
  }

  return violations;
}

describe("i18n string coverage", () => {
  it("no .tsx files in app/routes/ contain hardcoded English UI strings", () => {
    const violations = findHardcodedStrings(routeFiles);
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: "${v.text}"`)
      .join("\n");
    expect(
      violations,
      `Hardcoded English strings found in routes:\n${formatted}`,
    ).toEqual([]);
  });

  it("no .tsx files in app/components/ contain hardcoded English UI strings", () => {
    const violations = findHardcodedStrings(componentFiles);
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: "${v.text}"`)
      .join("\n");
    expect(
      violations,
      `Hardcoded English strings found in components:\n${formatted}`,
    ).toEqual([]);
  });

  it("no Intl calls use hardcoded 'en' locale", () => {
    const allFiles = { ...routeFiles, ...componentFiles };
    const violations: { file: string; line: number; text: string }[] = [];

    const INTL_EN_PATTERN =
      /Intl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat)\(\s*["']en["']/;

    for (const [file, content] of Object.entries(allFiles)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (INTL_EN_PATTERN.test(lines[i])) {
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
      `Hardcoded 'en' locale in Intl calls:\n${formatted}`,
    ).toEqual([]);
  });
});
