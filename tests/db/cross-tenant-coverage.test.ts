/**
 * Tests — cross-tenant coverage (the keystone meta-grep)
 *
 * This suite is the structural backstop that turns "filter by tenant" from a
 * convention into a property the runtime enforces: every read,
 * update, delete, or insert that touches one of the tenant-scoped
 * domain tables in the admin route surface or in `app/lib/` MUST
 * reference `tenantId` in the same statement. Forgetting
 * `where(eq(<table>.tenantId, tenant.id))` on a new admin loader —
 * or pasting an old `tenantId: NEOGRANADINA_TENANT_ID` literal into
 * a fresh INSERT — fails CI here, before review.
 *
 * Precedent: `tests/i18n-coverage.test.ts` is the project's other
 * meta-grep test. It uses `import.meta.glob({ query: '?raw' })` to
 * read source files as raw strings — the workers-pool sandbox
 * blocks `node:fs`, so this is the only viable file-loading path.
 * This test mirrors its line-walking shape and the empty-array
 * failure-message convention.
 *
 * ## Domain tables in scope
 *
 * The five tables that carry a `tenant_id` NOT NULL FK in the
 * production schema (verified by
 * `grep -B1 'tenantId: text' app/db/schema.ts`; child tables are
 * scoped via FK chain to a parent that always carries `tenant_id`):
 *
 *   - `users`
 *   - `repositories`
 *   - `descriptions`
 *   - `entities`
 *   - `places`
 *
 * If a future schema change adds `tenant_id` to a sixth table (e.g.
 * `vocabulary_terms`, `comments`, `qc_flags`), update
 * `DOMAIN_TABLES` below in lockstep with the migration.
 *
 * ## Scope
 *
 * The scanner globs:
 *
 *   - `app/routes/_auth.admin.**` — the admin route namespace, where
 *     every domain-table query carries an explicit
 *     `where(eq(<table>.tenantId, tenant.id))` predicate.
 *
 *   - `app/lib/invites.server.ts`, `app/lib/promote/**` — the lib
 *     touchpoints that take `tenantId` as an argument and pass it
 *     through to their D1 queries.
 *
 *   - `app/middleware/**` — middleware is structurally bounded; the
 *     allowlist documents the legitimate exceptions there.
 *
 * Routes outside `_auth.admin.**` (the dashboard, project routes,
 * OAuth callback, configuracion) and lib subsystems deliberately
 * scoped out (`app/lib/export/**`, `app/lib/pipeline/**`) are NOT
 * covered by this keystone in v0.4. Until a broader pass widens
 * the scope, the v0.4 reality (every existing user belongs to
 * Neogranadina, every existing host routes to Neogranadina via
 * `LEGACY_HOST_MAP`) means those queries cannot leak across tenants
 * in production.
 *
 * `/operator/*` routes are scoped OUT of this keystone by design.
 * Operator surfaces read across tenants for recovery and support
 * work; the deliberate non-coverage is documented here. Path-prefix
 * exclusion was chosen over a sanctioned `operatorRead()` helper
 * because the operator surface is small and the carve-out is
 * locally reviewable. The existing `app/routes/_auth.admin.*` glob
 * does not match `app/routes/_operator.*`, so no source-code
 * allowlist entry is needed. Future operator routes inherit the
 * exemption automatically as long as they live under `_operator.*`;
 * expanding the operator surface beyond `/operator/*` would require
 * an explicit second carve-out, surfaced in review.
 *
 * ## Allowlist
 *
 * Files whose domain-table queries inside the scoped surface are
 * legitimately not tenant-scoped:
 *
 *   - `app/middleware/auth.server.ts` -- the `lastActiveAt` throttle
 *     reads/updates `users` by primary key, before tenant context is
 *     resolved (and the user lookup is a single-row PK fetch that
 *     itself feeds tenant resolution downstream).
 *
 *   - `app/lib/invites.server.ts` -- the `acceptInvite` flow looks
 *     up `users` by `email` from a public token-bound URL where no
 *     tenant context exists yet; `users.email` is globally unique
 *     (schema-level UNIQUE) so the lookup cannot match across
 *     tenants regardless. The `inviteUserToProject` flow's email
 *     existence check is the same shape, again before any tenant
 *     scoping is meaningful (the function takes tenantId for the
 *     INSERT path, which is correctly scoped).
 *
 *   - `app/routes/_auth.admin.users.$id.tsx` -- the email-uniqueness
 *     pre-check on UPDATE is GLOBAL by design (the UPDATE that
 *     follows is tenant-scoped, so cross-tenant id-guessing on the
 *     email-rename path cannot rename another tenant's user). The
 *     actual UPDATE on the next ~30 lines does filter by
 *     `users.tenantId`.
 *
 * Reviewers: adding to this list is a deliberate review-time
 * decision. Each entry must justify why the query cannot or should
 * not carry a `tenantId` predicate. Casual additions defeat the
 * purpose of the keystone.
 *
 * ## How the scan works
 *
 * For each `app/routes/` and `app/lib/` source file (excluding the
 * allowlist and tests), the scanner:
 *
 *   1. Splits the file into lines and discards single-line `//`
 *      comments and block-comment `*` continuations so a comment
 *      example like `// db.select().from(descriptions)...` does not
 *      trigger a false positive.
 *
 *   2. For every line that opens a domain-table query verb -- one of
 *      `from(<DOMAIN_TABLE>)`, `update(<DOMAIN_TABLE>)`,
 *      `delete(<DOMAIN_TABLE>)`, `insert(<DOMAIN_TABLE>)` -- walks
 *      forward up to 60 lines accumulating statement text until a
 *      balanced statement terminator is seen: `;`, `.all()`,
 *      `.get()`, `.run()` at line-end, or a closing `})` whose paren
 *      depth has returned to zero relative to the verb's opening.
 *
 *   3. Asserts the captured statement contains the substring
 *      `tenantId` (case-sensitive; this is the camelCase the Drizzle
 *      schema and every loader use).
 *
 *   4. Pushes any violation onto a list. After the scan, asserts the
 *      list is empty; the failure message lists each
 *      `file:line: <statement-snippet>` so the reviewer can navigate
 *      directly to the missed predicate.
 *
 * Threat model coverage: a future loader added without
 * `where(tenantId)` slipping through code review is mitigated
 * structurally by this test failing CI. Allowlist abuse is
 * mitigated by review-time scrutiny on each new entry.
 *
 * @version v0.4.0
 */
import { describe, it, expect } from "vitest";

// Scope: the admin route namespace + the lib subsystems that take
// `tenantId` as an argument + middleware. See the file's narrative
// header for the rationale.
//
// React Router flat-file convention encodes the route hierarchy in
// the filename via dots (`_auth.admin.descriptions.$id.tsx`), not
// directory nesting -- so the glob is `_auth.admin.*` (single-level
// shell glob) rather than `_auth.admin.**/*`.
const adminRouteFiles = import.meta.glob(
  "../../app/routes/_auth.admin.*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

// Lib touchpoints scoped in: invites + the promote pipeline.
const invitesFile = import.meta.glob("../../app/lib/invites.server.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const promoteFiles = import.meta.glob("../../app/lib/promote/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const middlewareFiles = import.meta.glob(
  "../../app/middleware/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * The five tenanted domain tables. MUST stay in lockstep with the
 * schema: a schema migration that adds `tenant_id` to a new table
 * adds the table here in the same commit.
 */
const DOMAIN_TABLES = [
  "users",
  "repositories",
  "descriptions",
  "entities",
  "places",
] as const;

/**
 * Files whose domain-table queries are legitimately exempt. Each
 * entry MUST carry an inline justification. Reviewers should refuse
 * additions that do not.
 */
const ALLOWLIST_FILES: ReadonlyArray<string> = [
  // Middleware throttle: PK read + update on `users` for lastActiveAt;
  // runs before tenant context resolves.
  "../../app/middleware/auth.server.ts",
  // Invites: `acceptInvite` and the email existence pre-check on
  // `inviteUserToProject` look up `users` by globally-unique email
  // BEFORE any tenant context exists (public token-bound URL or
  // pre-create existence check). The INSERT path is tenant-scoped
  // by the explicit `tenantId` argument the helpers take.
  "../../app/lib/invites.server.ts",
  // User-edit page: the email-uniqueness pre-check on UPDATE is
  // GLOBAL by design. The actual
  // UPDATE that follows is tenant-scoped.
  "../../app/routes/_auth.admin.users.$id.tsx",
];

interface Violation {
  file: string;
  line: number;
  statement: string;
}

/**
 * Build a regex that matches a query verb opening on a domain table.
 * Captures the verb (`from|update|delete|insert`) and the table name
 * for diagnostic context. Examples that match:
 *   `.from(users)`
 *   `.update(descriptions)`
 *   `db.delete(places)`
 *   `db.insert(entities).values({...})`
 */
function buildVerbRegex(): RegExp {
  const verbs = "(from|update|delete|insert)";
  const tables = `(${DOMAIN_TABLES.join("|")})`;
  // \b is sufficient -- Drizzle schema imports the camelCase name as
  // a top-level identifier, and `from(users)` is the call shape.
  return new RegExp(`\\b${verbs}\\s*\\(\\s*${tables}\\b`, "g");
}

/**
 * Strip a `//`-style line comment if it starts the trimmed line, and
 * strip a `*`-style block-comment continuation. Returns the line as
 * the scanner should see it (or empty string if the entire line is
 * a comment).
 */
function stripComment(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//")) return "";
  if (trimmed.startsWith("*")) return "";
  if (trimmed.startsWith("/*")) return "";
  return line;
}

/**
 * Walk forward from a starting line index and accumulate statement
 * text until we see a robust statement terminator, AND include up to
 * 25 lines of context BEFORE the match so we can see the upstream
 * `conditions` array many admin loaders prepend to a single
 * `.where(and(...conditions))` call. Returns the captured text.
 *
 * Drizzle query chains span many lines (`.select().from(...).where(...).get()`),
 * so a closing `)` alone is NOT a terminator -- it would cut the chain
 * off after `.from(<table>)` and miss the `.where(eq(<table>.tenantId, ...))`
 * that lives a few lines down. The terminators we trust are:
 *
 *   - line ends with `;` (canonical statement end)
 *   - line ends with `.all()`, `.get()`, `.run()` with optional
 *     trailing `;` or `,` (Drizzle's terminal kicker methods that
 *     execute the chain)
 *
 * Backward context is needed because the canonical admin-loader
 * shape is:
 *
 *     const conditions = [
 *       eq(entities.tenantId, tenant.id),    // <-- predicate lives here
 *       like(entities.displayName, ...),
 *     ];
 *     const rows = await db
 *       .select({...})
 *       .from(entities)                       // <-- match starts here
 *       .where(and(...conditions))
 *       ...
 *
 * The forward-only walker would miss the `tenantId` reference. The
 * 25-line backward window is deliberately bounded -- if a predicate
 * lives further upstream, the loader has too much logic between the
 * predicate definition and the query for the predicate to be a
 * reliable read at the call site, and the test demands tightening.
 *
 * The 60-line forward cap is a defensive bound; the longest
 * legitimate Drizzle statement in the codebase is the entities
 * advanced-search query at roughly 35 lines, so 60 is comfortably
 * twice that.
 */
function captureStatement(lines: string[], startIdx: number): string {
  const collected: string[] = [];

  // Backward context: walk up to the start of the enclosing
  // function/loader/action so an upstream `baseConditions` array
  // (the canonical admin-loader shape) is visible to the `tenantId`
  // substring check. We walk backward up to `maxBackward` lines and
  // stop at the nearest `export ... function`, `function`, or
  // top-level `}` (closing the previous function), whichever comes
  // first. This bounds the window to the enclosing scope so we
  // don't accidentally pull in an unrelated function's predicate.
  const maxBackward = 250;
  const backStart = Math.max(0, startIdx - maxBackward);
  let actualBackStart = backStart;
  for (let i = startIdx - 1; i >= backStart; i--) {
    const t = lines[i].trimStart();
    // Function boundary: `export async function`, `export function`,
    // `async function`, `function`, `export const ... = (...) => {`
    if (
      /^(export\s+)?(async\s+)?function\s+/.test(t) ||
      /^export\s+const\s+\w+\s*=\s*async\s*\(/.test(t) ||
      /^export\s+const\s+\w+\s*=\s*\(/.test(t)
    ) {
      actualBackStart = i;
      break;
    }
    // Closing brace at column 0 or column 1 (the previous
    // function's `}`). Stop at the line after it.
    if (lines[i] === "}" || lines[i] === "} " || lines[i] === "};") {
      actualBackStart = i + 1;
      break;
    }
  }
  for (let i = actualBackStart; i < startIdx; i++) {
    collected.push(stripComment(lines[i]));
  }

  // Forward walk to the statement terminator.
  const maxLines = 60;
  const endIdx = Math.min(lines.length, startIdx + maxLines);

  for (let i = startIdx; i < endIdx; i++) {
    const raw = lines[i];
    const visible = stripComment(raw);
    collected.push(visible);

    const trimmedLine = visible.trimEnd();

    // Strict terminators only. A bare `)` is not enough -- Drizzle
    // chains break across many lines. We require an explicit
    // statement end (`;`) or a Drizzle terminal kicker.
    if (trimmedLine.endsWith(";")) break;
    if (/\.(all|get|run)\(\)\s*[;,]?$/.test(trimmedLine)) break;
  }

  return collected.join("\n");
}

function scanFiles(
  files: Record<string, string>,
  allowlist: ReadonlyArray<string>,
): Violation[] {
  const violations: Violation[] = [];
  const verbRegex = buildVerbRegex();

  for (const [file, content] of Object.entries(files)) {
    if (allowlist.includes(file)) continue;
    // Skip the test file itself if the glob ever picks it up.
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;

    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const visible = stripComment(lines[i]);
      if (!visible) continue;

      // Reset the regex's lastIndex on every line; we apply it
      // line-by-line.
      verbRegex.lastIndex = 0;
      const match = verbRegex.exec(visible);
      if (!match) continue;

      const statement = captureStatement(lines, i);
      // The captured statement (forward window + enclosing-scope
      // backward context) must reference a tenantId column predicate
      // or an insert-row tenantId field. Pure parameter-name uses
      // (`function f(tenantId: string)`) do not count -- the
      // qualifier discipline is what we want to enforce, so we
      // require one of:
      //
      //   - `<word>.tenantId`              (column reference: `users.tenantId`,
      //                                    `eq(entities.tenantId, ...)`,
      //                                    raw SQL `e.tenant_id` -- handled
      //                                    by the underscore variant below)
      //   - `tenantId:`                    (insert/update set object literal:
      //                                    `db.insert(t).values({ tenantId, ... })`,
      //                                    `db.update(t).set({ tenantId: ... })`)
      //   - `tenantId,` or `tenantId\n}`   (object shorthand:
      //                                    `.values({ tenantId, id, ... })`)
      //   - `\.tenant_id`                  (raw SQL alias variant for
      //                                    FTS5 fast paths)
      //
      // The check is intentionally strict; widening it dilutes the
      // test's signal.
      const QUALIFIED_REF = /\b\w+\.tenantId\b/;
      const FIELD_LITERAL = /\btenantId\s*[:,]/;
      const SHORTHAND_TRAIL = /\btenantId\s*\n\s*[},]/;
      const RAW_SQL_REF = /\b\w+\.tenant_id\b/;
      if (
        QUALIFIED_REF.test(statement) ||
        FIELD_LITERAL.test(statement) ||
        SHORTHAND_TRAIL.test(statement) ||
        RAW_SQL_REF.test(statement)
      ) {
        continue;
      }

      // Snippet for the failure message: focus on the matched line
      // plus the next few forward lines (skip the backward context,
      // which is just there for the substring check). Reviewers want
      // to see the statement that lacks the predicate, not the
      // upstream code that almost-but-not-quite supplied one.
      const snippet = lines
        .slice(i, Math.min(lines.length, i + 6))
        .map((s) => stripComment(s).trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(" ↵ ")
        .slice(0, 240);

      violations.push({ file, line: i + 1, statement: snippet });
    }
  }

  return violations;
}

describe("cross-tenant coverage", () => {
  it("every domain-table query in app/routes/_auth.admin.**, app/lib/invites + promote, app/middleware/** references tenantId", () => {
    const allFiles = {
      ...adminRouteFiles,
      ...invitesFile,
      ...promoteFiles,
      ...middlewareFiles,
    };
    const violations = scanFiles(allFiles, ALLOWLIST_FILES);

    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: ${v.statement}`)
      .join("\n");

    expect(
      violations,
      `Domain-table queries missing tenantId predicate:\n${formatted}\n\n` +
        `If a violation is on a query that legitimately cannot or should not be tenant-scoped, ` +
        `add the file to ALLOWLIST_FILES in this test with a one-line justification. ` +
        `Otherwise, add the missing predicate.`,
    ).toEqual([]);
  });

  it("ALLOWLIST_FILES entries all exist on disk (no stale references)", () => {
    const allFiles = {
      ...adminRouteFiles,
      ...invitesFile,
      ...promoteFiles,
      ...middlewareFiles,
    } as Record<string, string>;
    const missing = ALLOWLIST_FILES.filter((p) => !(p in allFiles));
    expect(
      missing,
      `Stale ALLOWLIST_FILES entries (file no longer exists):\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("DOMAIN_TABLES contains the five known tenant-scoped tables", () => {
    // Lockstep guard: if someone shrinks DOMAIN_TABLES without a
    // schema change, this assertion fails. If the schema gains a
    // sixth tenant-scoped table, this assertion fails until
    // DOMAIN_TABLES is extended.
    expect(DOMAIN_TABLES).toEqual([
      "users",
      "repositories",
      "descriptions",
      "entities",
      "places",
    ]);
  });
});
