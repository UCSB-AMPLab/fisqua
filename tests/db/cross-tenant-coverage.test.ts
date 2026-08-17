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
 * The scoped tables in the production schema:
 *
 *   - `users`, `repositories`, `descriptions` — tenant-scoped
 *     (`tenant_id` NOT NULL FK)
 *   - `projects`, `volumes`, `volumePages`, `entries`, `qcFlags`,
 *     `comments`, `resegmentationFlags`, `activityLog`, `drafts` — the
 *     crowdsourcing subtree, tenant-scoped since migration 0042; their
 *     loader predicates landed in federation step 4 alongside the writer
 *     plumbing, so the guard holds them against regression too.
 *   - `entities`, `places`, `vocabulary_terms` — federation-scoped
 *     (`federation_id`, migrations 0045-0048)
 *
 * If a future schema change adds a scope column to another table, update
 * TENANT_TABLES / FEDERATION_TABLES below in lockstep with the migration.
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
 *   - The eight crowdsourcing writer libs (projects, drafts, volumes,
 *     entries, comments, qc-flags, resegmentation, workflow `.server.ts`
 *     modules) — added in federation step 4 so writer regressions fail
 *     CI. Six of them are allowlisted for their parent-FK-scoped
 *     reads/deletes (each with a justification below); their inserts
 *     remain compile-guarded because tenantId is required in every
 *     crowdsourcing insert type.
 *
 *   - `app/middleware/**` — middleware is structurally bounded; the
 *     allowlist documents the legitimate exceptions there.
 *
 *   - The MEMBER-FACING CROWDSOURCING SURFACE, added in v0.7:
 *     `_auth.proyectos.tsx`, `_auth.projects.*`, `_auth.viewer.*`,
 *     `_auth.description.*`, `_auth.users.*`, every `api.*` endpoint,
 *     plus `app/lib/pipeline/**`, `app/lib/description.server.ts` and
 *     `app/lib/activity.server.ts`. These sat outside the keystone
 *     through v0.4-v0.6 on the reasoning that every host resolved to
 *     Neogranadina anyway. Federation grants ended that: a steward is
 *     now routinely served on a host that is not their home tenant,
 *     and a membership-derived query on these surfaces renders their
 *     home tenant's work under someone else's name.
 *
 * Still outside: `app/lib/export/**`, `_auth.dashboard.tsx`,
 * `_auth.configuracion.tsx`, and the pre-session auth routes. The
 * dashboard is the reference implementation for the correct shape but
 * resolves actor and cataloguer names by id from rows it has already
 * tenant-scoped, which the scanner would read as violations.
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
 * ## Two exemption lists, deliberately separate
 *
 * `STATEMENT_EXEMPTIONS` is the narrow one: a single statement,
 * identified by a `match` substring of its own text, that cannot
 * carry the predicate (it runs before tenant context exists, keys on
 * a globally-unique column, or is a PK/parent-FK statement in a
 * called lib whose route guard did the scoping). It replaced the old
 * whole-file `ALLOWLIST_FILES`, which blinded the scanner to every
 * OTHER statement in an exempted file — three cross-tenant writes
 * survived a full audit that way, hidden behind one legitimate
 * global email pre-check in the same file. Files are never exempt
 * anymore; statements are, one reviewed reason at a time. The
 * conversion audit (2026-08-13) found the blanket list was also
 * simply stale: two of its nine files needed no exemption at all.
 *
 * `PARENT_FK_EXEMPTIONS` is the route-level one, and it is where the
 * whole member surface lands. Those files query by a resource id that
 * a request-tenant-carrying guard — `requireProjectRole`,
 * `requireEntryAccess`, `requireDescriptionAccess`, `requirePageAccess`
 * — has already resolved and refused if it belongs to another tenant.
 * A `tenantId` predicate there would be redundant with the guard, not
 * additional to it, so the scanner cannot classify the statement.
 * Each entry names the guard in `requires`, and a test asserts the
 * string is still in the file: delete the guard and the file fails
 * the keystone rather than quietly losing its boundary. For both
 * lists, a test fails any entry that no longer suppresses a
 * violation, so carve-outs cannot outlive their reason.
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
 *   3. Asserts the captured statement contains a `tenantId` reference
 *      in a genuine VALUE position (case-sensitive; this is the
 *      camelCase the Drizzle schema and every loader use). Two things
 *      are neutralised first so they cannot satisfy the check: type
 *      annotations (`tenantId: string` in a signature is a
 *      declaration, not a predicate) and HOME-TENANT references
 *      (`user.tenantId`, `currentUser.tenantId` — scoping by the
 *      caller's home tenant is the bug, so it must not read as the
 *      fix). What the check still cannot distinguish is `tenant.id`
 *      from any other right-hand side: `eq(volumes.tenantId, x)`
 *      passes whatever `x` is. Reading the right-hand side properly
 *      needs a real parse, not a line walker; the guard-anchored
 *      exemptions below carry the part of the load this cannot.
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
 * Migration 0045 lifted entities/places (and vocabulary_terms) to
 * federation scope, so this keystone now requires a `federationId`
 * predicate on entities/places queries and a `tenantId` predicate on the
 * tenant-scoped tables (users/repositories/descriptions). See the
 * TENANT_TABLES / FEDERATION_TABLES split below.
 *
 * @version v0.7.0
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

// Crowdsourcing writer libs (federation step 4): the eight app/lib
// modules that write the nine tenant-scoped crowdsourcing tables.
// Scanned so a writer regression (an insert dropping its explicit
// tenantId, or a scoped query losing its predicate) fails CI.
// Enumerated explicitly rather than `app/lib/*.server.ts` so the
// allowlist stays small and each inclusion is deliberate.
const crowdsourcingWriterFiles = import.meta.glob(
  [
    "../../app/lib/projects.server.ts",
    "../../app/lib/drafts.server.ts",
    "../../app/lib/volumes.server.ts",
    "../../app/lib/entries.server.ts",
    "../../app/lib/comments.server.ts",
    "../../app/lib/qc-flags.server.ts",
    "../../app/lib/resegmentation.server.ts",
    "../../app/lib/workflow.server.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const middlewareFiles = import.meta.glob(
  "../../app/middleware/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

// Member-facing crowdsourcing surface. Outside the keystone until
// v0.7: `/proyectos`, the `/projects/*` tree, the full-page viewer and
// description editor, the per-user activity page, and every
// crowdsourcing `api.*` endpoint. These are the surfaces a federation
// grant-holder reaches on a member tenant's host, so they are exactly
// where a membership-derived query leaks the caller's home tenant.
const memberRouteFiles = import.meta.glob(
  [
    "../../app/routes/_auth.proyectos.tsx",
    "../../app/routes/_auth.projects.*.tsx",
    "../../app/routes/_auth.viewer.*.tsx",
    "../../app/routes/_auth.description.*.tsx",
    "../../app/routes/_auth.users.*.tsx",
    "../../app/routes/api.*.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

// Lib subsystems the member surface calls that the v0.4 keystone
// scoped out: the kanban pipeline, the description reader/writer, and
// the activity feeds.
const memberLibFiles = import.meta.glob(
  [
    "../../app/lib/pipeline/**/*.ts",
    "../../app/lib/description.server.ts",
    "../../app/lib/activity.server.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * The six scoped domain tables the keystone guards. MUST stay in
 * lockstep with the schema. Split by scoping level after migrations
 * 0045-0048 lifted entities/places from tenant to federation scope:
 *
 *   - TENANT_TABLES: queries must carry a `tenantId` predicate.
 *   - FEDERATION_TABLES (authorities): queries must carry a
 *     `federationId` predicate (resolved from the session tenant's
 *     federation). vocabularyTerms joined this set with the lift — it
 *     gained a federation_id NOT NULL column in 0045 and every vocab
 *     surface now filters by it, so the guard holds those predicates
 *     against regression too. authorityOperations joined with migration
 *     0057 (federation_id NOT NULL FK): the ledger is federation-scoped,
 *     so any future admin read surface over it must carry the predicate.
 */
const TENANT_TABLES = [
  "users",
  "repositories",
  "descriptions",
  // Crowdsourcing subtree — gained a NOT NULL tenant_id in migration 0042;
  // their loader predicates land alongside the writer plumbing in
  // federation sequence step 4, so the guard now holds them too.
  "projects",
  "volumes",
  "volumePages",
  "entries",
  "qcFlags",
  "comments",
  "resegmentationFlags",
  "activityLog",
  "drafts",
] as const;
const FEDERATION_TABLES = [
  "entities",
  "places",
  "vocabularyTerms",
  "authorityOperations",
] as const;
const DOMAIN_TABLES = [...TENANT_TABLES, ...FEDERATION_TABLES] as const;

/**
 * Statement-level exemptions — the replacement for the whole-file
 * allowlist this test used to carry.
 *
 * A whole-file exemption blinds the scanner to EVERY statement in the
 * file, and that cost us: three cross-tenant writes lived undisturbed
 * in a blanket-allowlisted route through a full audit and two
 * remediation passes, because the one legitimate global query in the
 * file exempted the other twenty statements with it. A file is never
 * exempt; a STATEMENT is, and only with a justification the scanner
 * can re-check.
 *
 * Each entry names the file, a `match` substring that must appear in
 * the captured statement text (forward portion only — backward
 * context cannot satisfy it), and the reason the statement cannot or
 * should not carry the predicate. Two tests keep the list honest: a
 * stale entry whose file is gone fails, and an entry that suppresses
 * no violation fails — carve-outs cannot outlive their reason. A
 * `match` may suppress several statements in its file only when they
 * are the same shape for the same reason (e.g. the four comment
 * mutators' identical PK fetches).
 *
 * Reviewers: an addition here is a review-time decision about ONE
 * statement. If a whole family of new statements needs exempting,
 * that is a design smell in the code, not a reason for a broader
 * entry.
 */
interface StatementExemption {
  /** Glob-relative path, as it appears in `import.meta.glob` keys. */
  file: string;
  /** Substring of the captured statement (forward text) it exempts. */
  match: string;
  /** One line: why this statement cannot carry the predicate. */
  why: string;
}

const STATEMENT_EXEMPTIONS: ReadonlyArray<StatementExemption> = [
  // ------------------------------------------------------------------
  // Pre-tenant-context statements: no tenant exists to scope by yet.
  // ------------------------------------------------------------------
  {
    file: "../../app/middleware/auth.server.ts",
    match: "eq(users.id, userId)",
    why: "lastActiveAt throttle reads and updates the session user by PK before tenant context resolves",
  },
  {
    file: "../../app/lib/invites.server.ts",
    match: "eq(users.email, invite.email)",
    why: "acceptInvite resolves a user by globally-unique email (schema UNIQUE) from a public token-bound URL, before any tenant context exists",
  },
  // ------------------------------------------------------------------
  // Crowdsourcing writer libs: statements keyed by a PK or parent FK
  // that the calling route resolved through a request-tenant-carrying
  // access guard. INSERTs stay covered by the type system regardless:
  // tenantId is REQUIRED in each table's insert type.
  // ------------------------------------------------------------------
  {
    file: "../../app/lib/entries.server.ts",
    match: ".orderBy(entries.position)",
    why: "loadEntries keys on the parent volumeId the calling route resolved through its access guard",
  },
  {
    file: "../../app/lib/comments.server.ts",
    match: ".leftJoin(users, eq(comments.authorId, users.id))",
    why: "the four read helpers key on a parent anchor (entry/page/qcFlag/volume) the calling route resolved through its access guard",
  },
  {
    file: "../../app/lib/comments.server.ts",
    match: "eq(comments.id, commentId)",
    why: "mutators fetch-then-write by comment PK after their own checks (404 on absent or decision comments, author/lead gate, deleted gate); the anchor was guard-resolved at the route",
  },
  {
    file: "../../app/lib/comments.server.ts",
    match: "deletedBy: userId",
    why: "soft-delete cascade UPDATE keys on the guarded root comment's PK and its replies' parent_id, captured in the `where` built above it",
  },
  {
    file: "../../app/lib/qc-flags.server.ts",
    match: "eq(qcFlags.id, flagId)",
    why: "resolveQcFlag fetch-then-write by flag PK; the route resolved the flag's volume through its page/project guard first",
  },
  {
    file: "../../app/lib/qc-flags.server.ts",
    match: "eq(qcFlags.volumeId, volumeId)",
    why: "flag reads key on the parent volumeId the calling route resolved through its access guard",
  },
  {
    file: "../../app/lib/resegmentation.server.ts",
    match: "eq(resegmentationFlags.id, flagId)",
    why: "resolveResegmentationFlag fetch-then-write by flag PK; the route resolved the flag's volume through its project guard first",
  },
  {
    file: "../../app/lib/resegmentation.server.ts",
    match: "eq(resegmentationFlags.volumeId, volumeId)",
    why: "flag reads key on the parent volumeId the calling route resolved through its access guard",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(volumes.projectId, projectId)",
    why: "getProjectVolumes keys on the projectId the calling route resolved through the project-role guard",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "inArray(qcFlags.volumeId, volumeIds)",
    why: "open-flag sidecar count keys on volume ids selected from the guarded project's own volumes",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(volumePages.volumeId, vol.id)",
    why: "thumbnail read keys on a volume id selected from the guarded project's own volumes",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(volumes.id, volumeId)",
    why: "delete paths fetch and finally delete the volume by the PK the admin route guard resolved",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(entries.volumeId, volumeId)",
    why: "forceDelete cascade: entry collection and deletion key on the guarded volume id",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "inArray(comments.entryId, batch)",
    why: "forceDelete cascade: comment deletion keys on entry ids selected from the guarded volume",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "inArray(resegmentationFlags.entryId, batch)",
    why: "forceDelete cascade: flag deletion keys on entry ids selected from the guarded volume",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(activityLog.volumeId, volumeId)",
    why: "forceDelete cascade: activity-log deletion keys on the guarded volume id",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(resegmentationFlags.volumeId, volumeId)",
    why: "forceDelete cascade: volume-scoped flag deletion keys on the guarded volume id",
  },
  {
    file: "../../app/lib/volumes.server.ts",
    match: "eq(volumePages.volumeId, volumeId)",
    why: "forceDelete cascade: page deletion keys on the guarded volume id",
  },
];

/**
 * PARENT-FK exemptions — the member crowdsourcing surface.
 *
 * A different shape of exception from `STATEMENT_EXEMPTIONS`, and given
 * its own list so it cannot be confused with one. These files query
 * domain tables by a resource primary key or a parent foreign key
 * (`params.id`, `volumeId`, `entryId`, `pageId`, `commentId`) that a
 * request-tenant-carrying guard has ALREADY resolved and refused if
 * it belongs to another tenant. Re-stating `tenantId` on each
 * statement would be redundant with the guard, not additional to it,
 * so the scanner cannot classify them and a bare `tenantId` predicate
 * is not the right fix.
 *
 * What keeps this from being a blank cheque: every entry names the
 * thing that actually does the scoping, in `requires`, and the test
 * asserts that string is still present in the file. Delete the guard
 * call and the exemption stops applying — the file fails the keystone
 * instead of silently losing its boundary. That is the F-1/F-5
 * regression class (a guard removed, or an action added without one),
 * which is precisely what the plain file allowlist above cannot see.
 *
 * Reviewers: an entry here is a claim that EVERY domain-table
 * statement in the file is parent-FK scoped. Adding one because a
 * single aggregate query is inconvenient to scope is an abuse of the
 * mechanism — scope that query instead.
 */
interface ParentFkExemption {
  /** Glob-relative path, as it appears in `import.meta.glob` keys. */
  file: string;
  /** One line: what makes every statement in this file parent-FK. */
  why: string;
  /** Substring that must remain in the file for `why` to hold. */
  requires: string;
}

const PARENT_FK_EXEMPTIONS: ReadonlyArray<ParentFkExemption> = [
  {
    file: "../../app/routes/_auth.projects.$id.settings.tsx",
    why: "every statement keys on params.id (or a volume of it) after the lead guard resolves the project inside the request tenant",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/_auth.projects.$id.assignments.tsx",
    why: "volume and entry reads/writes are linked to params.id in the same statement, behind the lead guard",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/_auth.projects.$id.assignments.description.$volumeId.tsx",
    why: "the volume read is linked to params.id in the same statement, behind the lead guard",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/_auth.projects.$id.volumes.$volumeId.manage.tsx",
    why: "volume reads/writes are linked to params.id behind the lead guard; the user lookups resolve ids taken from that volume's own rows",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/_auth.projects.$id.overview.tsx",
    why: "the entry->volume linkage read exists to prove the submitted entry belongs to params.id, which the guard already bound to the request tenant",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/_auth.viewer.$projectId.$volumeId.tsx",
    why: "volume, page and project reads key on params behind the project guard; the reporter lookups resolve ids taken from this volume's own flags",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/api.workflow.tsx",
    why: "the volume read is linked to the submitted projectId in the same statement, behind the project guard",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/api.comments.tsx",
    why: "the QC-flag and volume reads resolve the comment's anchor for the access guard that follows",
    requires: "requireEntryAccess",
  },
  {
    file: "../../app/routes/api.comments.$id.tsx",
    why: "the comment and volume reads resolve the target back to its project, which the guard then checks against the request tenant",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/api.comments.$id.resolve.tsx",
    why: "the comment and volume reads resolve the target back to its project, which the guard then checks against the request tenant",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/api.qc-flags.tsx",
    why: "page, flag and volume reads resolve the flag's anchor for the page/project guards that follow",
    requires: "requirePageAccess",
  },
  {
    file: "../../app/routes/api.resegmentation.tsx",
    why: "flag and volume reads resolve the flag's anchor for the project guard that follows",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/routes/api.entries.save.tsx",
    why: "the volume reads and the status bump key on a volumeId the entry guard already resolved inside the request tenant",
    requires: "requireProjectRole(",
  },
  {
    file: "../../app/lib/description.server.ts",
    why: "a called module, not a route: every entryId and volumeId it takes was resolved by requireDescriptionAccess or requireEntryAccess at the call site",
    requires: "requireDescriptionAccess",
  },
];

const PARENT_FK_FILES: ReadonlyArray<string> = PARENT_FK_EXEMPTIONS.map(
  (e) => e.file,
);

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
function captureStatement(
  lines: string[],
  startIdx: number,
): { full: string; forward: string } {
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

  // Forward walk to the statement terminator. Kept separate from the
  // backward context so statement-level exemptions can match against
  // the statement ITSELF -- a `match` satisfied only by upstream
  // context would exempt a different statement than the one reviewed.
  const forwardLines: string[] = [];
  const maxLines = 60;
  const endIdx = Math.min(lines.length, startIdx + maxLines);

  for (let i = startIdx; i < endIdx; i++) {
    const raw = lines[i];
    const visible = stripComment(raw);
    forwardLines.push(visible);

    const trimmedLine = visible.trimEnd();

    // Strict terminators only. A bare `)` is not enough -- Drizzle
    // chains break across many lines. We require an explicit
    // statement end (`;`) or a Drizzle terminal kicker.
    if (trimmedLine.endsWith(";")) break;
    if (/\.(all|get|run)\(\)\s*[;,]?$/.test(trimmedLine)) break;
  }

  const forward = forwardLines.join("\n");
  return { full: [...collected, forward].join("\n"), forward };
}

function scanFiles(
  files: Record<string, string>,
  allowlist: ReadonlyArray<string>,
  exemptions: ReadonlyArray<StatementExemption> = [],
  usedExemptions?: Set<StatementExemption>,
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

      // match[2] is the captured table name; federation-scoped
      // authorities (entities/places) must carry a `federationId`
      // predicate, every other guarded table a `tenantId` predicate.
      const matchedTable = match[2];
      const isFederationScoped = (FEDERATION_TABLES as readonly string[]).includes(
        matchedTable,
      );

      const { full: statement, forward } = captureStatement(lines, i);
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
      const col = isFederationScoped ? "federationId" : "tenantId";
      const rawCol = isFederationScoped ? "federation_id" : "tenant_id";

      // Neutralise TypeScript TYPE ANNOTATIONS before the predicate
      // check. `tenantId: string` in a function signature, interface, or
      // return-type literal is a DECLARATION, not a value use -- and the
      // backward context window routinely includes the enclosing
      // function's signature, so without this step a helper that TAKES a
      // tenantId parameter would satisfy `FIELD_LITERAL` even after its
      // query dropped the actual predicate (empirically demonstrated by
      // the 2026-07-08 adversarial review: deleting
      // `eq(entries.tenantId, tenantId)` from a tenantId-parameterised
      // promote query passed the scan). Stripping `tenantId: string`
      // (also `?:`, number, boolean) leaves only genuine value contexts
      // (`tenantId: tenant.id`, `{ tenantId, ... }`, `x.tenantId`) able
      // to satisfy the check.
      const sanitized = statement
        .replace(
          new RegExp(`\\b${col}\\??\\s*:\\s*(string|number|boolean)\\b`, "g"),
          "__TYPE_ANNOTATION__",
        )
        // Neutralise HOME-TENANT references. `user.tenantId` is the
        // caller's HOME tenant, which under a federation grant is not
        // the tenant the request is being served for. It must never be
        // what satisfies this check -- concretely, a `user.tenantId`
        // read anywhere in the enclosing scope (the backward context
        // window routinely pulls one in) would otherwise make an
        // entirely unscoped statement look predicated. The pattern
        // matches any identifier ENDING in `user`/`User` (`user`,
        // `currentUser`, `targetUser`, `sessionUser`) and deliberately
        // does NOT match the Drizzle column `users.tenantId`, where
        // the `s` sits between `user` and the dot.
        .replace(
          new RegExp(`\\b\\w*[uU]ser\\.${col}\\b`, "g"),
          "__HOME_TENANT__",
        );

      const QUALIFIED_REF = new RegExp(`\\b\\w+\\.${col}\\b`);
      const FIELD_LITERAL = new RegExp(`\\b${col}\\s*[:,]`);
      const SHORTHAND_TRAIL = new RegExp(`\\b${col}\\s*\\n\\s*[},]`);
      const RAW_SQL_REF = new RegExp(`\\b\\w+\\.${rawCol}\\b`);
      if (
        QUALIFIED_REF.test(sanitized) ||
        FIELD_LITERAL.test(sanitized) ||
        SHORTHAND_TRAIL.test(sanitized) ||
        RAW_SQL_REF.test(sanitized)
      ) {
        continue;
      }

      // Statement-level exemption: the match must live in the FORWARD
      // text (the statement itself), never in the backward context, so
      // an exemption cannot accidentally cover a neighbouring query.
      const applicable = exemptions.filter(
        (e) => e.file === file && forward.includes(e.match),
      );
      if (applicable.length > 0) {
        for (const e of applicable) usedExemptions?.add(e);
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

/** Every file the keystone scans, from all seven globs. */
function allScannedFiles(): Record<string, string> {
  return {
    ...adminRouteFiles,
    ...invitesFile,
    ...promoteFiles,
    ...crowdsourcingWriterFiles,
    ...middlewareFiles,
    ...memberRouteFiles,
    ...memberLibFiles,
  } as Record<string, string>;
}

describe("cross-tenant coverage", () => {
  it("every domain-table query in the admin namespace, the member crowdsourcing surface, and the scanned libs references its scoping predicate (tenantId, or federationId for authorities)", () => {
    const violations = scanFiles(
      allScannedFiles(),
      PARENT_FK_FILES,
      STATEMENT_EXEMPTIONS,
    );

    const formatted = violations
      .map((v) => `  ${v.file}:${v.line}: ${v.statement}`)
      .join("\n");

    expect(
      violations,
      `Domain-table queries missing their scoping predicate ` +
        `(tenantId for tenant tables; federationId for entities/places):\n${formatted}\n\n` +
        `If a violation is on ONE statement that legitimately cannot or should not be ` +
        `scoped, add a STATEMENT_EXEMPTIONS entry with a match substring and a one-line ` +
        `justification — whole files are never exempt. ` +
        `If every domain-table statement in the file is keyed on a resource id that a ` +
        `request-tenant-carrying guard already resolved, add a PARENT_FK_EXEMPTIONS ` +
        `entry naming that guard in \`requires\`. Otherwise, add the missing predicate.`,
    ).toEqual([]);
  });

  it("STATEMENT_EXEMPTIONS entries all exist on disk and each suppresses at least one statement", () => {
    const allFiles = allScannedFiles();
    const missing = STATEMENT_EXEMPTIONS.filter((e) => !(e.file in allFiles));
    expect(
      missing.map((e) => e.file),
      `Stale STATEMENT_EXEMPTIONS entries (file no longer exists):\n${missing
        .map((e) => e.file)
        .join("\n")}`,
    ).toEqual([]);

    // An exemption that suppresses nothing is dead weight: the
    // statement has since been scoped, rewritten, or removed. Drop the
    // entry rather than leaving a standing carve-out.
    const used = new Set<StatementExemption>();
    scanFiles(allFiles, PARENT_FK_FILES, STATEMENT_EXEMPTIONS, used);
    const unnecessary = STATEMENT_EXEMPTIONS.filter(
      (e) => e.file in allFiles && !used.has(e),
    );
    expect(
      unnecessary.map((e) => `${e.file} — "${e.match}"`),
      `STATEMENT_EXEMPTIONS entries that suppress nothing — remove them:\n${unnecessary
        .map((e) => `${e.file} — "${e.match}"`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("PARENT_FK_EXEMPTIONS entries all exist on disk and still need the exemption", () => {
    const allFiles = allScannedFiles();
    const missing = PARENT_FK_FILES.filter((p) => !(p in allFiles));
    expect(
      missing,
      `Stale PARENT_FK_EXEMPTIONS entries (file no longer exists or left the glob):\n${missing.join("\n")}`,
    ).toEqual([]);

    // An exemption that suppresses nothing is dead weight: the file
    // has since been scoped properly, or the queries are gone. Drop
    // the entry rather than leaving a standing carve-out.
    const unscanned = scanFiles(allFiles, []);
    const violatingFiles = new Set(unscanned.map((v) => v.file));
    const unnecessary = PARENT_FK_FILES.filter(
      (p) => p in allFiles && !violatingFiles.has(p),
    );
    expect(
      unnecessary,
      `PARENT_FK_EXEMPTIONS entries that suppress nothing — remove them:\n${unnecessary.join("\n")}`,
    ).toEqual([]);
  });

  it("every PARENT_FK_EXEMPTIONS entry still contains the guard it claims scopes it", () => {
    // The tripwire that keeps the exemption honest. `requires` names
    // the request-tenant-carrying guard (or, for a called lib, the
    // contract its header states) that does the scoping the scanner
    // cannot see. If that string disappears, the reason for the
    // exemption disappeared with it and the entry must be re-argued.
    const allFiles = allScannedFiles();
    const broken = PARENT_FK_EXEMPTIONS.filter((e) => {
      const content = allFiles[e.file];
      return content !== undefined && !content.includes(e.requires);
    }).map((e) => `${e.file} no longer contains "${e.requires}" — ${e.why}`);

    expect(
      broken,
      `PARENT-FK exemptions whose stated guard is gone:\n${broken.join("\n")}`,
    ).toEqual([]);
  });

  it("DOMAIN_TABLES contains the guarded tables, split by scope", () => {
    // Lockstep guard: if someone shrinks the guarded set without a
    // schema change, this assertion fails. entities/places/vocabularyTerms
    // are federation-scoped after migrations 0045-0048; the crowdsourcing
    // subtree joined the tenant-scoped set in step 4 (migration 0042 gave
    // each a NOT NULL tenant_id).
    expect(TENANT_TABLES).toEqual([
      "users",
      "repositories",
      "descriptions",
      "projects",
      "volumes",
      "volumePages",
      "entries",
      "qcFlags",
      "comments",
      "resegmentationFlags",
      "activityLog",
      "drafts",
    ]);
    expect(FEDERATION_TABLES).toEqual([
      "entities",
      "places",
      "vocabularyTerms",
      "authorityOperations",
    ]);
    expect(DOMAIN_TABLES).toEqual([
      "users",
      "repositories",
      "descriptions",
      "projects",
      "volumes",
      "volumePages",
      "entries",
      "qcFlags",
      "comments",
      "resegmentationFlags",
      "activityLog",
      "drafts",
      "entities",
      "places",
      "vocabularyTerms",
      "authorityOperations",
    ]);
  });
});
