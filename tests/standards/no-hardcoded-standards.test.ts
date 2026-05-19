/**
 * Tests — no hardcoded standards in the description CRUD surface (the grep keystone)
 *
 * This suite is the structural backstop that turns "the per-standard substrate is
 * the only place a standard literal legitimately appears" from a
 * convention into a property the test suite enforces in CI: every
 * admin route, admin form, cataloguing form, locale namespace, and
 * promote-pipeline file in the description CRUD surface MUST go
 * through the standard config + validator factory + tStd resolver
 * instead of pasting `"isadg"` / `"dacs"` / `"rad"` — or the
 * user-facing names `ISAD(G)` / `DACS` / `RAD` — into a switch, a
 * label, a heading, or a copy string. Forgetting that and pasting a
 * raw literal into a freshly added locale row, a new field renderer
 * branch, or a route action fails CI here, before review.
 *
 * ## Precedent
 *
 * `tests/db/cross-tenant-coverage.test.ts` and
 * `tests/i18n-coverage.test.ts` (the project's other meta-greps)
 * both use `import.meta.glob({ query: '?raw' })` to read source files
 * as raw strings. The workers-pool vitest sandbox blocks `node:fs`,
 * so Vite's raw-import is the only viable file-loading path here.
 * This test mirrors their line-walking shape, empty-array failure-
 * message convention, and comment-stripping discipline.
 *
 * ## Two scan passes
 *
 * The keystone runs TWO complementary scan passes over the same
 * in-scope file set, each with the same allowlist:
 *
 *   1. **Lowercase quoted-identifier sweep.** Regex
 *      `/['"](isadg|dacs|rad)['"]/`. Catches places where code branches
 *      on the literal value — `if (standard === "isadg")`, an object
 *      key map `{ isadg: ..., dacs: ..., rad: ... }`, a switch case,
 *      or a Zod enum literal pasted outside the substrate.
 *
 *   2. **Case-insensitive name sweep.**
 *      Regex `/(?<![.\w])(?:ISAD\(G\)|DACS|RAD)(?!\w)/gi`. Catches
 *      user-facing standard NAMES appearing in JSX text content
 *      (between `>` and `<`) or inside string / template literals —
 *      Spanish or English headings such as `"Editar descripción
 *      ISAD(G)"` that pass 1 cannot see because they don't quote the
 *      lowercase enum value. The negative lookbehind `(?<![.\w])`
 *      exempts the legitimate `key.standard` override-key pattern
 *      that `tStd` consumes (`"context.dacs":` in the locale files
 *      is the contract for per-standard label overrides — without
 *      the lookbehind, the case-insensitive name sweep would fire
 *      on the override KEY rather than on user-facing copy). The
 *      trailing `(?!\w)` keeps `radius` / `gradient` / `dacscore`
 *      from tripping the test.
 *
 * Both passes run after `stripComment()` discards `//`, `*`, and
 * `/*` lines, so the narrative-header comments inside in-scope files
 * (which describe what the keystone enforces) do NOT trip the test.
 * The `stripComment()` is intentionally crude — it mirrors the
 * other meta-grep keystones rather than implementing a full
 * tokeniser.
 *
 * ## In-scope file globs
 *
 *   - `app/routes/_auth.admin.descriptions*.{ts,tsx}` — admin
 *     description routes.
 *   - `app/components/descriptions/**` — admin form + tree-browser
 *     surface.
 *   - `app/components/description/**` — cataloguing form surface.
 *   - `app/locales/{en,es}/{description,descriptions}.ts` — admin
 *     and cataloguing namespaces.
 *   - `app/lib/promote/**` — promote pipeline.
 *
 * Routes / components outside this set (the dashboard, the project
 * workspace, the publish pipeline, the operator surface) are NOT
 * covered by this keystone in v0.4. The operator surface in particular
 * is allowlisted explicitly: `app/routes/_operator.tenants.new.tsx`
 * legitimately renders an `<option value="isadg">` dropdown so an
 * operator can pick a standard at tenant create-time.
 *
 * ## Allowlist
 *
 * Files where the literals legitimately live (the standard substrate
 * + the boundaries that consume it):
 *
 *   - `app/lib/standards/types.ts` — the type union itself
 *     (`type Standard = "isadg" | "dacs" | "rad"`).
 *   - `app/lib/standards/registry.ts` — the explicit object-key map
 *     `{ isadg: ISADG_CONFIG, dacs: DACS_CONFIG, rad: RAD_CONFIG }`.
 *   - `app/lib/standards/{isadg,dacs,rad}.ts` — each config declares
 *     `standard: "isadg" | "dacs" | "rad"` as its identity field.
 *   - `app/lib/standards/validator-factory.ts` — accepts `Standard`
 *     parameter; literal MAY appear in error message templates.
 *   - `app/lib/i18n/standard-aware.ts` — the `tStd` resolver composes
 *     `${key}.${standard}` keys; no literal needed but allowed.
 *   - `app/db/schema.ts` — the canonical Drizzle enum
 *     `enum: ["isadg","dacs","rad"]` on `tenants.descriptiveStandard`.
 *   - `app/lib/operator-actions.server.ts` — operator-side Zod parse
 *     for tenant create.
 *   - `app/routes/_operator.tenants.new.tsx` — operator UI dropdown
 *     with `<option value="isadg">`, `<option value="dacs">`,
 *     `<option value="rad">`.
 *
 * Reviewers: adding to this list is a deliberate review-time decision.
 * Each entry must justify why the literal cannot be hoisted to the
 * substrate. Casual additions defeat the purpose of the keystone.
 *
 * ## Locked-set guard
 *
 * A fourth `it()` block asserts that `app/lib/standards/types.ts` —
 * the canonical home of the literal triple — exports exactly
 * `["isadg", "dacs", "rad"]` (every literal in the expected tuple is
 * present, and no extra literal from a sentinel set has been smuggled
 * in). If a fourth standard ships, this assertion fails and forces
 * the developer to audit the keystone allowlist + every consumer in
 * lockstep. Mirrors `tests/db/cross-tenant-coverage.test.ts:468-480`.
 *
 * ## Threat surface
 *
 *   - T-34-06-01: a future locale, component, or route pastes
 *     `"isadg"` outside the substrate. Caught by pass 1.
 *   - T-34-06-02: a heading "Editar descripción ISAD(G)" lands in a
 *     route file. Caught by pass 2 (W2).
 *   - T-34-06-03: a fourth standard ships without an allowlist audit.
 *     Caught by the locked-set guard.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";

// === IN-SCOPE GLOBS ===
//
// React Router flat-file convention encodes the route hierarchy in
// the filename via dots (`_auth.admin.descriptions.$id.tsx`), not
// directory nesting -- so the glob is `_auth.admin.descriptions*`
// (single-level shell glob) rather than `_auth.admin.descriptions/**`.
const adminRouteFiles = import.meta.glob(
  "../../app/routes/_auth.admin.descriptions*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const adminFormFiles = import.meta.glob(
  "../../app/components/descriptions/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const cataloguingFormFiles = import.meta.glob(
  "../../app/components/description/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const localeFiles = import.meta.glob(
  "../../app/locales/{en,es}/{description,descriptions}.ts",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const promoteFiles = import.meta.glob(
  "../../app/lib/promote/**/*.ts",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

// === ALLOWLIST (where the literals legitimately live) ===
//
// Each entry carries a one-line justification. Reviewers should refuse
// additions that do not. Path strings match the keys Vite produces from
// `import.meta.glob` (relative to this test file, with `../../` prefix).
const ALLOWLIST_FILES: ReadonlyArray<string> = [
  // Each standard config declares `standard: "isadg" | "dacs" | "rad"` as
  // its identity field; the literal IS the file's identity declaration.
  "../../app/lib/standards/isadg.ts",
  "../../app/lib/standards/dacs.ts",
  "../../app/lib/standards/rad.ts",
  // Registry — explicit object key map { isadg: ISADG_CONFIG, ... }.
  "../../app/lib/standards/registry.ts",
  // Type union — `type Standard = "isadg" | "dacs" | "rad"`.
  "../../app/lib/standards/types.ts",
  // Validator factory — accepts `Standard` parameter. Issue messages
  // are stable i18n tokens (CR-04), so no `dacs`/`rad`/`isadg` literal
  // is expected to appear in user-facing strings; the file remains
  // allowlisted because the typed parameter signature still references
  // the union members.
  "../../app/lib/standards/validator-factory.ts",
  // Resolver wrapper — composes `${key}.${standard}` keys; no literal
  // needed today, but allowed if a future shape adds one.
  "../../app/lib/i18n/standard-aware.ts",
  // Drizzle schema — canonical enum: ["isadg","dacs","rad"] on
  // `tenants.descriptiveStandard`.
  "../../app/db/schema.ts",
  // Operator-side Zod parse for tenant create — accepts a literal
  // standard from the operator's form submission.
  "../../app/lib/operator-actions.server.ts",
  // Operator UI — <option value="isadg"> / <option value="dacs"> /
  // <option value="rad"> in the tenant create form.
  "../../app/routes/_operator.tenants.new.tsx",
];

// === SCAN PRIMITIVES ===

/**
 * Pass 1: lowercase quoted identifiers used as variable values.
 * Captures `"isadg"`, `'dacs'`, `"rad"` — the literal triple inside
 * single OR double quotes.
 */
const STANDARD_LITERALS = /['"](isadg|dacs|rad)['"]/g;

/**
 * Pass 2 (W2): user-facing standard NAMES in JSX text content or
 * string / template literals. Three sub-patterns OR'd, all
 * case-insensitive via the `i` flag:
 *
 *   - `ISAD\(G\)` — case-insensitive `ISAD(G)` literal.
 *   - `DACS`      — bare word DACS, no `radius` / `dacscore` hits.
 *   - `RAD`       — bare word RAD, no `radius` / `gradient` hits.
 *
 * The negative lookbehind `(?<![.\w])` exempts the legitimate
 * `key.standard` override-key pattern that `tStd` consumes — locale
 * rows like `"context.dacs": "Biographical/Historical Note"` and
 * `"title.rad": "Title proper"` are the contract for
 * `tStd(t, "sections.context", "dacs")` to resolve. Without the
 * lookbehind, the case-insensitive sweep would fire on the override KEY
 * (`.dacs` / `.rad` suffix) rather than on user-facing copy. We also
 * exclude word characters in the lookbehind so `DACS` inside an
 * identifier (`oldDACS`) is not flagged separately.
 *
 * The trailing `(?!\w)` is the equivalent of `\b` for the
 * end-of-match boundary — keeps `radius` / `gradient` / `dacscore`
 * from tripping the test.
 *
 * We deliberately do NOT try to constrain to JSX text vs strings at
 * the regex level — that's brittle. Instead we scan every non-comment
 * line and rely on the allowlist to suppress legitimate occurrences in
 * narrative headers / known-limitation comments inside the substrate
 * files. Comment-stripping already removes pure `//` and `*` lines, so
 * any non-allowlisted file with a name match is a real violation.
 *
 * Note for future maintainers: if the per-standard locale-override
 * encoding changes from dotted-key strings (`"context.dacs":`) to
 * nested objects (`context: { dacs: "..." }`), the bare object-key
 * `dacs:` will be flagged by this regex and the locale file will need
 * an explicit allowlist entry. That's the correct signal — the
 * encoding change deserves a re-audit of the keystone.
 */
const STANDARD_NAMES_TEXT = /(?<![.\w])(?:ISAD\(G\)|DACS|RAD)(?!\w)/gi;

/**
 * Strip comment-only lines so narrative-header references like
 * "// the literal triple 'isadg' / 'dacs' / 'rad'" do NOT trip the
 * scanner. Mirrors `tests/db/cross-tenant-coverage.test.ts:245-251`.
 *
 * Also strips trailing line comments (everything after `//`) so a
 * code-with-trailing-comment line like
 *   `const x = 1; // example: standard === "isadg"`
 * still has its actual code scanned but the comment text removed.
 *
 * The trailing-comment stripper is crude — it could mis-handle a
 * `'string with // inside'` literal, but the keystone's targets
 * (`isadg` / `dacs` / `rad` and `ISAD(G)` / `DACS` / `RAD`) are
 * unlikely to appear inside strings that themselves contain `//`,
 * which matches the cross-tenant keystone's accepted false-positive
 * surface.
 */
function stripComment(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) return "";
  if (trimmed.startsWith("*")) return "";
  if (trimmed.startsWith("/*")) return "";
  const lineCommentIdx = line.indexOf("//");
  if (lineCommentIdx >= 0) {
    return line.slice(0, lineCommentIdx);
  }
  return line;
}

interface LiteralViolation {
  file: string;
  line: number;
  literal: string;
}

interface NameViolation {
  file: string;
  line: number;
  match: string;
}

function scanFiles(files: Record<string, string>): LiteralViolation[] {
  const violations: LiteralViolation[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (ALLOWLIST_FILES.includes(file)) continue;
    const lines = content.split("\n");
    lines.forEach((rawLine, i) => {
      const line = stripComment(rawLine);
      if (!line) return;
      STANDARD_LITERALS.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STANDARD_LITERALS.exec(line)) !== null) {
        violations.push({ file, line: i + 1, literal: m[1] });
      }
    });
  }
  return violations;
}

function scanFilesForNames(files: Record<string, string>): NameViolation[] {
  const violations: NameViolation[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (ALLOWLIST_FILES.includes(file)) continue;
    const lines = content.split("\n");
    lines.forEach((rawLine, i) => {
      const line = stripComment(rawLine);
      if (!line) return;
      STANDARD_NAMES_TEXT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STANDARD_NAMES_TEXT.exec(line)) !== null) {
        violations.push({ file, line: i + 1, match: m[0] });
      }
    });
  }
  return violations;
}

describe("no hardcoded standards in description CRUD surface", () => {
  it("description routes, components, locales, and promote mapping do not contain literal 'isadg'/'dacs'/'rad'", () => {
    const allFiles = {
      ...adminRouteFiles,
      ...adminFormFiles,
      ...cataloguingFormFiles,
      ...localeFiles,
      ...promoteFiles,
    };
    const violations = scanFiles(allFiles);
    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: '${v.literal}'`)
      .join("\n");
    expect(
      violations,
      `Hardcoded standard literals found:\n${formatted}\n\n` +
        `If a literal legitimately belongs in this file (e.g., a new standard registry), ` +
        `add the file to ALLOWLIST_FILES with a one-line justification. ` +
        `Otherwise, route the value through getStandardConfig() / tStd() / ` +
        `descriptionValidatorFor() — the per-standard substrate is the only legitimate place a literal appears.`,
    ).toEqual([]);
  });

  it("description CRUD surface does not contain user-facing 'ISAD(G)' / 'DACS' / 'RAD' name strings (case-insensitive sweep)", () => {
    const allFiles = {
      ...adminRouteFiles,
      ...adminFormFiles,
      ...cataloguingFormFiles,
      ...localeFiles,
      ...promoteFiles,
    };
    const nameViolations = scanFilesForNames(allFiles);
    const formatted = nameViolations
      .map((v) => `  ${v.file}:${v.line}: '${v.match}'`)
      .join("\n");
    expect(
      nameViolations,
      `User-facing standard names found in copy:\n${formatted}\n\n` +
        `Neutralise the copy (e.g. "Editar descripción" instead of "Editar descripción ISAD(G)") ` +
        `or route through tStd / a per-standard label key. If the name LEGITIMATELY belongs ` +
        `(narrative header, known-limitation comment), add the file to ALLOWLIST_FILES.`,
    ).toEqual([]);
  });

  it("ALLOWLIST_FILES entries all exist on disk (no stale references)", () => {
    // Combine the in-scope globs PLUS the substrate / boundary files
    // that the allowlist references. The substrate files do not appear
    // in any in-scope glob, so we glob them here just for the existence
    // check.
    const allowlistGlob = import.meta.glob(
      [
        "../../app/lib/standards/*.ts",
        "../../app/lib/i18n/standard-aware.ts",
        "../../app/db/schema.ts",
        "../../app/lib/operator-actions.server.ts",
        "../../app/routes/_operator.tenants.new.tsx",
      ],
      { query: "?raw", import: "default", eager: true },
    ) as Record<string, string>;

    const missing = ALLOWLIST_FILES.filter((p) => !(p in allowlistGlob));
    expect(
      missing,
      `Stale ALLOWLIST_FILES entries (file no longer exists):\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("locked-set guard: standard literals are exactly ['isadg', 'dacs', 'rad']", () => {
    // Mirrors `tests/db/cross-tenant-coverage.test.ts:468-480`.
    //
    // If a fourth standard is added (e.g. 'mads' or 'other'), this
    // assertion fails — forcing the developer to audit ALLOWLIST_FILES
    // and every consumer (renderer, validator factory, locale, route)
    // in lockstep.
    const expectedTuple = ["isadg", "dacs", "rad"] as const;
    const typesContent = import.meta.glob(
      "../../app/lib/standards/types.ts",
      { query: "?raw", import: "default", eager: true },
    ) as Record<string, string>;
    const content = Object.values(typesContent)[0] ?? "";
    expect(
      content.length,
      "Could not load app/lib/standards/types.ts via raw-import",
    ).toBeGreaterThan(0);

    // Every expected literal must appear in types.ts (the canonical
    // home of the type union).
    for (const lit of expectedTuple) {
      expect(content, `types.ts is missing literal "${lit}"`).toContain(
        `"${lit}"`,
      );
    }

    // Sentinel: scan the file for the expected triple PLUS two
    // sentinel literals that, if present, indicate a fourth standard
    // has been smuggled in. The set of literals actually found must be
    // a subset of the expected tuple.
    const allLiterals = [
      ...content.matchAll(/['"](isadg|dacs|rad|mads|other)['"]/g),
    ].map((m) => m[1]);
    const unique = new Set(allLiterals);
    for (const u of unique) {
      expect(
        expectedTuple as readonly string[],
        `Unexpected standard literal "${u}" found in types.ts — ` +
          `audit ALLOWLIST_FILES and every consumer (renderer, validator, locale, route).`,
      ).toContain(u);
    }
  });
});

/* @version v0.4.0 */
