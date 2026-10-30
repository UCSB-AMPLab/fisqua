/**
 * Tests — media pipeline raw SQL tenant scope
 *
 * The cross-tenant keystone (`tests/db/cross-tenant-coverage.test.ts`)
 * reads query-builder calls (`from(t)`, `update(t)`, `delete(t)`,
 * `insert(t)`) and cannot see SQL written inside a `sql` template: an
 * `INSERT ... SELECT` run through `db.run(sql`...`)`, an `EXISTS` guard
 * inside `.where()`, or a subquery inside `.set()`. This suite covers
 * that gap for the media pipeline modules.
 *
 * It reads every `app/lib/pipeline/*.server.ts` file, and the capture
 * link's `app/lib/capture/*.server.ts`, whose writes register pipeline
 * volumes and whose tables carry a tenant too, as raw text, finds
 * each `sql` template (nested `${...}` expressions included), and keeps
 * the ones that name a media pipeline table. Each of those must carry a
 * tenant predicate: `tenant_id =` with an optional table alias
 * (`rv.tenant_id = ${...}`), or `${<table>.tenantId} =`. A bare
 * `tenant_id` does not count, because an `INSERT`'s column list names
 * the column without scoping anything. A template must also carry at
 * least as many tenant predicates as it has `FROM pipeline_...` or
 * `JOIN pipeline_...` references, so a guard that reads two tables
 * cannot pass on one predicate.
 *
 * The few statements that are cross-tenant by design (the scheduled
 * sweep's) are listed in `ALLOWED_UNSCOPED`, each with its reason. An
 * entry that matches no template fails the suite, so an exemption
 * cannot outlive its statement.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";

const sources = import.meta.glob(["../../app/lib/pipeline/*.server.ts", "../../app/lib/capture/*.server.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const PIPELINE_TABLES = [
  "pipeline_recipe_declarations",
  "pipeline_volumes",
  "pipeline_volume_pages",
  "pipeline_runs",
  "pipeline_run_chunks",
  "pipeline_run_volumes",
  "pipeline_review_items",
  "pipeline_gate_passes",
  "pipeline_publications",
  // The capture link (0093), whose writes register pipeline volumes.
  "capture_scanners",
  "capture_deliveries",
  "capture_images",
  // Capture QC (0094), whose guards read pipeline volumes and runs.
  "capture_qc_sets",
  "capture_qc_decisions",
  "capture_qc_rotations",
  "capture_qc_reviewers",
  // The unit's fetches of a decision set (0100).
  "capture_qc_fetches",
  // A delivery's review runs (0103).
  "capture_review_runs",
] as const;

const TABLE_ALT = PIPELINE_TABLES.join("|");
const NAMES_TABLE = new RegExp(`\\b(?:${TABLE_ALT})\\b`);
const FROM_OR_JOIN = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:${TABLE_ALT})\\b`, "gi");
const RAW_PREDICATE = /\b(?:\w+\.)?tenant_id\s*=/g;
const BOUND_PREDICATE = /\$\{\s*[\w.]+\.tenantId\s*\}\s*=/g;

/**
 * Statements that may name a pipeline table without a tenant predicate,
 * each identified by its file and a substring of its own text.
 */
type Allowed = { file: string; match: string; reason: string };
const ALLOWED_UNSCOPED: ReadonlyArray<Allowed> = [];

type Template = { file: string; line: number; text: string };

/** Skips a quoted string starting at `i`; returns the index after it. */
function skipString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") j++;
    j++;
  }
  return j + 1;
}

/**
 * Returns the index just past the closing backtick of the template
 * whose opening backtick is at `open`, stepping over `${...}`
 * expressions and any templates nested inside them.
 */
function skipTemplate(src: string, open: number): number {
  let i = open + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && src[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "`") {
          i = skipTemplate(src, i);
          continue;
        }
        if (c === '"' || c === "'") {
          i = skipString(src, i);
          continue;
        }
        if (c === "{") depth++;
        if (c === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return src.length;
}

/** Every `sql` template in a source file, with its starting line. */
function sqlTemplates(file: string, src: string): Template[] {
  const out: Template[] = [];
  const opener = /\bsql`/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(src)) !== null) {
    const open = m.index + 3;
    const end = skipTemplate(src, open);
    out.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      text: src.slice(open, end),
    });
    // Nested templates are checked again on their own, so the scan
    // resumes inside this one rather than after it.
    opener.lastIndex = open + 1;
  }
  return out;
}

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** Templates that name a pipeline table and lack enough tenant predicates. */
function unscopedTemplates(files: Record<string, string>): Template[] {
  const violations: Template[] = [];
  for (const [file, src] of Object.entries(files)) {
    for (const t of sqlTemplates(file, src)) {
      if (!NAMES_TABLE.test(t.text)) continue;
      if (ALLOWED_UNSCOPED.some((a) => file.endsWith(a.file) && t.text.includes(a.match))) continue;
      const predicates = count(RAW_PREDICATE, t.text) + count(BOUND_PREDICATE, t.text);
      const required = Math.max(1, count(FROM_OR_JOIN, t.text));
      if (predicates < required) violations.push(t);
    }
  }
  return violations;
}

describe("media pipeline raw SQL carries a tenant predicate", () => {
  it("reads the pipeline modules", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it("every sql template naming a pipeline table is tenant-scoped", () => {
    const violations = unscopedTemplates(sources).map(
      (t) => `${t.file}:${t.line}: ${t.text.replace(/\s+/g, " ").slice(0, 160)}`,
    );
    expect(violations).toEqual([]);
  });

  it("every allowlist entry matches a template", () => {
    const all = Object.entries(sources).flatMap(([file, src]) => sqlTemplates(file, src));
    const stale = ALLOWED_UNSCOPED.filter(
      (a) => !all.some((t) => t.file.endsWith(a.file) && t.text.includes(a.match)),
    );
    expect(stale).toEqual([]);
  });
});
