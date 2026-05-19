/**
 * Tests — operator audit coverage
 *
 * This suite is the structural backstop that turns "wrap operator action handlers
 * in `withAuditLog`" from a convention into a property the runtime
 * enforces: every action handler under
 * `app/routes/_operator.*.{ts,tsx}` must call the `withAuditLog(...)`
 * wrapper exactly once PER INTENT.
 *
 * The scanner handles multi-intent action handlers (the tenant
 * detail page's `_operator.tenants.$slug.tsx` action switches over
 * `intent` to handle `set_capability`, `soft_disable`, and
 * `re_enable` — each `case` block has its own `withAuditLog`
 * wrapper). It counts wrappers per `case` span and requires at most
 * one per case (zero is allowed for idempotent / no-op branches).
 * Forgetting the wrapper on a new operator action still ships an
 * unauditable mutation; CI fails here before review.
 *
 * Precedent: `tests/db/cross-tenant-coverage.test.ts` is the
 * keystone this mirrors. Same `import.meta.glob({ query: '?raw' })`
 * raw-string read pattern (the workers-pool sandbox blocks
 * `node:fs`); same empty-array failure-message convention; same
 * scanner-as-pure-function shape so the scanner itself is unit
 * testable without depending on the live route surface.
 *
 * ## Why exactly-once
 *
 * More than one `withAuditLog(` call inside a single action handler
 * means the action's database work spans multiple non-atomic batches
 * (each wrapper composes its own `db.batch`). The second batch's
 * failure leaves the first's audit row + work committed — exactly
 * the splitting the wrapper exists to prevent. Two genuinely
 * separate audit-bearing actions in one file is a code smell the
 * keystone surfaces for reviewer judgement, not a hard fail.
 *
 * ## Scanner shape
 *
 * The scanner is exported as a pure function so the unit tests can
 * feed synthetic fixtures without depending on the live glob's
 * contents. For each file:
 *
 *   1. Find every `action` export. Three shapes are recognised:
 *      `export async function action`, `export function action`,
 *      `export const action =`. Each match anchors a "function body"
 *      span: the lines from the match through the next top-level
 *      `export ` (or end-of-file).
 *
 *   2. Within each span, count substring occurrences of
 *      `withAuditLog(`. Zero → "missing" violation. Two or more →
 *      "duplicate" violation.
 *
 *   3. Files with no `action` export are skipped — loader-only
 *      files carry no audit-bearing work and need no wrapper.
 *
 * The forward-only span boundary is deliberately conservative; if a
 * future operator route style declares helper functions in the same
 * file BEFORE the action export, those helpers fall outside the
 * action's span and won't be miscounted as wrapper calls. If two
 * action exports (e.g. for two HTTP methods) appear in one file,
 * each gets its own span and is audited independently.
 *
 * Threat model coverage: an operator action shipping without an
 * audit row is mitigated structurally by the missing-wrapper
 * detection. A multi-batch action splitting atomicity is mitigated
 * by the duplicate-wrapper detection. Bypass via dynamic
 * `action =` construction is out of scope — the keystone is a
 * reviewer aid, not a sandbox.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";

/**
 * Live glob over the operator route surface. The single-level
 * `_operator.*` shell glob mirrors React Router's flat-file
 * convention (filename dots encode hierarchy, not nested
 * directories) — same shape the cross-tenant keystone used for
 * `_auth.admin.*`.
 */
const operatorRouteFiles = import.meta.glob(
  "../../app/routes/_operator.*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * Per-file audit-coverage violation. `problem` distinguishes the
 * missing-wrapper case from the multi-wrapper case; reviewers need
 * different fixes for each.
 */
export interface AuditCoverageViolation {
  file: string;
  line: number;
  problem: "missing" | "duplicate";
  snippet: string;
}

/**
 * Find every `action` export in a file's source text and return the
 * line index (0-based) where the export starts. Three shapes are
 * recognised; helper functions named `action` inside other contexts
 * are not picked up because the regex anchors on `export `.
 */
function findActionExports(content: string): number[] {
  const lines = content.split("\n");
  const matches: number[] = [];
  // The patterns are anchored on the line's start (after optional
  // leading whitespace, which `export` declarations rarely have but
  // we tolerate). Each pattern looks for the literal identifier
  // `action` followed by either a paren (function) or `=`
  // (assignment).
  const PATTERNS = [
    /^\s*export\s+async\s+function\s+action\s*[(<]/, // export async function action(
    /^\s*export\s+function\s+action\s*[(<]/,         // export function action(
    /^\s*export\s+const\s+action\s*=/,               // export const action =
  ];
  for (let i = 0; i < lines.length; i++) {
    if (PATTERNS.some((p) => p.test(lines[i]))) matches.push(i);
  }
  return matches;
}

/**
 * Capture the action handler's "body span" — the lines from the
 * action export through the next top-level `export ` declaration or
 * end-of-file. The forward window is deliberately bounded so an
 * unrelated helper that happens to call `withAuditLog` in a
 * different file context cannot accidentally satisfy a different
 * action's coverage check.
 */
function captureActionSpan(content: string, startLine: number): string {
  const lines = content.split("\n");
  const collected: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    if (i > startLine && /^\s*export\s+/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

/**
 * Detect whether a span contains a `switch (...)` over an `intent`
 * (or similarly named) discriminator. Multi-intent action handlers
 * use this shape; single-intent handlers do not. The detection is
 * conservative: only `switch (intent)` and `switch (String(...))` /
 * `switch (formData.get(...))` shapes count, so a chained ternary or
 * if-else cascade still falls under the single-handler rule.
 */
function isMultiIntentSwitch(span: string): boolean {
  return /\bswitch\s*\(\s*(?:String\s*\(|formData\.get\s*\(|[A-Za-z_$][A-Za-z0-9_$]*)/.test(
    span,
  );
}

/**
 * Split a multi-intent action body into one substring per `case` arm.
 * Each arm starts at a `case "<literal>":` line and continues forward
 * until the next `case `, the next `default:`, or the end of the
 * function body (we use the action span as the outer bound). The
 * returned array entries are `{ label, body }` where `label` is the
 * literal in quotes (e.g. `"set_capability"`) and `body` is the lines
 * for that arm (excluding the `case` line itself).
 *
 * `default:` arms are dropped because they typically just emit a
 * 4xx Response and never write to the DB; counting wrappers there
 * would only produce false-missing violations.
 */
function splitCases(span: string): Array<{ label: string; body: string }> {
  const lines = span.split("\n");
  const arms: Array<{ label: string; body: string; startIdx: number }> = [];
  let current: { label: string; body: string; startIdx: number } | null = null;
  const caseRegex = /^\s*case\s+["'`]([^"'`]+)["'`]\s*:/;
  const defaultRegex = /^\s*default\s*:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const caseMatch = line.match(caseRegex);
    if (caseMatch) {
      if (current) arms.push(current);
      current = { label: caseMatch[1], body: "", startIdx: i };
      continue;
    }
    if (defaultRegex.test(line)) {
      // Close the previous arm and stop collecting (default: is dropped).
      if (current) arms.push(current);
      current = null;
      continue;
    }
    if (current) {
      current.body += line + "\n";
    }
  }
  if (current) arms.push(current);
  return arms.map(({ label, body }) => ({ label, body }));
}

/**
 * Scan a map of `{ filePath: rawContent }` for audit-coverage
 * violations. Pure function — does not touch the live glob, does not
 * read disk, does not depend on a Vitest harness. Unit tests feed
 * synthetic fixtures directly.
 *
 * When an action body is a multi-intent switch, the scanner counts
 * wrappers per `case` arm. Each arm may contain 0 or 1 wrapper
 * (zero allowed for no-op idempotent branches; >1 is a duplicate
 * violation). Single-intent action bodies require exactly one
 * wrapper.
 */
export function scanOperatorRoutesForAuditCoverage(
  files: Record<string, string>,
): AuditCoverageViolation[] {
  const violations: AuditCoverageViolation[] = [];
  const auditCallRegex = /\bwithAuditLog\s*\(/g;

  for (const [file, content] of Object.entries(files)) {
    // Skip the test file itself if the glob ever picks it up.
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;

    const exportLines = findActionExports(content);
    for (const startLine of exportLines) {
      const span = captureActionSpan(content, startLine);

      const allLines = content.split("\n");
      const snippet = allLines
        .slice(startLine, Math.min(allLines.length, startLine + 4))
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" ↵ ")
        .slice(0, 240);

      if (isMultiIntentSwitch(span)) {
        // Multi-intent — score each `case` arm independently.
        const cases = splitCases(span);
        // The action body must contain at least one case with a
        // wrapper; otherwise it is structurally identical to a
        // single-intent action that forgot the wrapper.
        let totalWithWrapper = 0;
        for (const arm of cases) {
          const occurrences = (arm.body.match(auditCallRegex) ?? []).length;
          if (occurrences > 1) {
            violations.push({
              file,
              line: startLine + 1,
              problem: "duplicate",
              snippet: `[case "${arm.label}"] ${snippet}`,
            });
          }
          if (occurrences > 0) totalWithWrapper++;
        }
        if (totalWithWrapper === 0) {
          violations.push({
            file,
            line: startLine + 1,
            problem: "missing",
            snippet,
          });
        }
        continue;
      }

      // Single-intent — count wrappers across the whole action body.
      // `withAuditLog(` substring count — case-sensitive, paren-bounded
      // so `withAuditLogParams` (the type) does not falsely match.
      const occurrences = (span.match(auditCallRegex) ?? []).length;
      if (occurrences === 0) {
        violations.push({
          file,
          line: startLine + 1,
          problem: "missing",
          snippet,
        });
      } else if (occurrences > 1) {
        violations.push({
          file,
          line: startLine + 1,
          problem: "duplicate",
          snippet,
        });
      }
    }
  }
  return violations;
}

describe("audit coverage on operator routes", () => {
  it("every action handler in app/routes/_operator.*.{ts,tsx} calls withAuditLog exactly once", () => {
    const violations = scanOperatorRoutesForAuditCoverage(operatorRouteFiles);
    const formatted = violations
      .map(
        (v) =>
          `  ${v.file}:${v.line}: [${v.problem}] ${v.snippet}`,
      )
      .join("\n");
    expect(
      violations,
      `Operator action handlers missing or duplicating withAuditLog:\n${formatted}\n\n` +
        `Wrap the action's database work in \`withAuditLog({ action: ..., ... }, async (tx) => ({ workStatements: [...], result }))\` ` +
        `multiple wrappers per action handler split atomicity across non-atomic batches; combine into one.`,
    ).toEqual([]);
  });
});

describe("scanner unit tests (synthetic fixtures)", () => {
  it("missing wrapper — action handler with no withAuditLog call surfaces as 'missing'", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.example.tsx": [
        "import { redirect } from 'react-router';",
        "",
        "export async function action({ request, context }) {",
        "  const formData = await request.formData();",
        "  const slug = formData.get('slug');",
        "  // No wrapper here — should fail the keystone.",
        "  return redirect('/operator/tenants');",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("missing");
    expect(violations[0].file).toBe("synthetic/_operator.example.tsx");
  });

  it("single wrapper — action handler with exactly one withAuditLog call passes", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.good.tsx": [
        "import { withAuditLog } from '~/lib/audit.server';",
        "",
        "export async function action({ request, context }) {",
        "  return await withAuditLog(",
        "    db,",
        "    { action: 'create_tenant', /* ... */ },",
        "    async (tx) => ({ workStatements: [], result: 'ok' }),",
        "  );",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toEqual([]);
  });

  it("duplicate wrappers — action handler with two withAuditLog calls surfaces as 'duplicate'", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.bad.tsx": [
        "import { withAuditLog } from '~/lib/audit.server';",
        "",
        "export async function action({ request, context }) {",
        "  await withAuditLog(db, { action: 'create_tenant' }, async () => ({ workStatements: [], result: null }));",
        "  await withAuditLog(db, { action: 'set_capability' }, async () => ({ workStatements: [], result: null }));",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("duplicate");
  });

  it("loader-only file — no action export, no violation surfaced", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.list.tsx": [
        "export async function loader({ context }) {",
        "  // Cross-tenant read; no audit row required for loaders.",
        "  return { items: [] };",
        "}",
        "",
        "export default function ListPage() {",
        "  return <div>Items</div>;",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toEqual([]);
  });

  it("type alias `withAuditLogParams` — does NOT count as a wrapper call", () => {
    // Defensive test: the substring `withAuditLog` appears in the
    // type alias too; the regex requires a paren after the name to
    // count as a call. A type-only mention should not satisfy the
    // exactly-once detector and leave a missing violation in place.
    const fixture: Record<string, string> = {
      "synthetic/_operator.types-only.tsx": [
        "import type { WithAuditLogParams } from '~/lib/audit.server';",
        "",
        "export async function action({ request, context }) {",
        "  const params: WithAuditLogParams = { /* ... */ } as any;",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("missing");
  });
});

describe("multi-intent scanner unit tests", () => {
  it("multi-intent switch — each case arm with one withAuditLog passes", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.multi-good.tsx": [
        "import { withAuditLog } from '~/lib/audit.server';",
        "",
        "export async function action({ request, context }) {",
        "  const formData = await request.formData();",
        "  const intent = String(formData.get('intent'));",
        "  switch (intent) {",
        "    case 'set_capability': {",
        "      await withAuditLog(db, { action: 'set_capability' }, async () => ({ workStatements: [], result: null }));",
        "      return { saved: true };",
        "    }",
        "    case 'soft_disable': {",
        "      await withAuditLog(db, { action: 'soft_disable_tenant' }, async () => ({ workStatements: [], result: null }));",
        "      return { disabled: true };",
        "    }",
        "    case 're_enable': {",
        "      await withAuditLog(db, { action: 'set_capability' }, async () => ({ workStatements: [], result: null }));",
        "      return { reenabled: true };",
        "    }",
        "    default:",
        "      return new Response('Unknown intent', { status: 400 });",
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toEqual([]);
  });

  it("multi-intent switch — a case with TWO wrappers surfaces as 'duplicate'", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.multi-bad.tsx": [
        "import { withAuditLog } from '~/lib/audit.server';",
        "",
        "export async function action({ request, context }) {",
        "  const formData = await request.formData();",
        "  const intent = String(formData.get('intent'));",
        "  switch (intent) {",
        "    case 'set_capability': {",
        "      await withAuditLog(db, { action: 'set_capability' }, async () => ({ workStatements: [], result: null }));",
        "      await withAuditLog(db, { action: 'set_capability' }, async () => ({ workStatements: [], result: null }));",
        "      return { saved: true };",
        "    }",
        "    default:",
        "      return new Response('Unknown intent', { status: 400 });",
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("duplicate");
    expect(violations[0].snippet).toContain("set_capability");
  });

  it("multi-intent switch — every case missing wrapper surfaces as 'missing'", () => {
    const fixture: Record<string, string> = {
      "synthetic/_operator.multi-empty.tsx": [
        "export async function action({ request, context }) {",
        "  const formData = await request.formData();",
        "  const intent = String(formData.get('intent'));",
        "  switch (intent) {",
        "    case 'a': return { a: true };",
        "    case 'b': return { b: true };",
        "    default: return new Response('Unknown', { status: 400 });",
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    const violations = scanOperatorRoutesForAuditCoverage(fixture);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("missing");
  });
});

describe("operator route surface lights up once action handlers exist", () => {
  // Action handlers under app/routes/_operator.* light up this assertion.
  // (`_operator.tenants.new.tsx`, `_operator.tenants.$slug.tsx`).
  // From this point on the live operator-glob is non-empty and the
  // keystone is doing real work — every action handler must wrap its
  // DB writes in `withAuditLog`. The placeholder is now a live
  // assertion.
  it("operator routes have at least one file", () => {
    expect(Object.keys(operatorRouteFiles).length).toBeGreaterThan(0);
  });
});

// @version v0.4.0
