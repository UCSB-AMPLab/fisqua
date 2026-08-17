/**
 * D1 Schema — Drizzle Definitions
 *
 * This module deals with the TypeScript mirror of every table the app
 * reads or writes. Drizzle
 * uses these declarations for two jobs: to produce type-safe query
 * builders so loaders and actions can `select({ title: entries.title })`
 * with full autocomplete, and to generate the SQL migration files under
 * `drizzle/`. The file is the single source of truth for shape; if a
 * column is not here, no query can reference it by name.
 *
 * The tables cluster into four rough groups. First, the template
 * baseline -- `users`, `magicLinks`, `projects`, `projectMembers`,
 * `projectInvites` -- carries authentication and collaborative
 * cataloguing membership. The `users` table includes five role flags
 * (superadmin, collab admin, archive user, user manager, cataloguer)
 * that gate access across the admin back-office.
 *
 * Second, the segmentation and description model: `volumes` and
 * `volumePages` represent bound IIIF volumes at the image level,
 * `entries` represents the tree of documentary units cataloguers
 * segment out of each volume, and `resegmentationFlags` + `qcFlags`
 * capture quality-control signals at the entry and page scope. The
 * `comments` table is the platform's one comment store -- comments are
 * one archival record class. A row targets exactly one of an entry, a
 * page, a QC flag, or a pending decision (four-way DB CHECK), and its
 * author is exactly one of a user or an agency label (CHECK). Page-
 * targeted comments can carry optional image-region coordinates so
 * that a single click becomes a pin and a drag becomes a bounding box.
 * The "region requires a page target" invariant lives in application
 * code because SQLite CHECK cannot express it cleanly alongside the
 * four-way XOR. `activityLog` records every workflow event for the
 * per-user activity page and the project messages feed.
 *
 * Third, the archival data layer: `repositories`, `descriptions`,
 * `entities`, `places`, and the join tables `descriptionEntities` and
 * `descriptionPlaces` -- the source of truth for the published archive.
 * Descriptions form an adjacency-list tree with denormalised depth,
 * child count, and path cache; entity and place records follow
 * ISAAR(CPF) and Linked Places conventions and carry merge pointers
 * for authority consolidation. `drafts` and `changelog` support the
 * autosave and audit loop on the description editor.
 *
 * Fourth, platform bookkeeping: `siteSettings` for superadmin-editable
 * flags, `exportRuns` for the publish pipeline with Cloudflare Workflows
 * tracking columns, and `vocabularyTerms` for the controlled vocabulary
 * hub that governs entity primary-function labels.
 *
 * Fifth, the tenant layer (v0.4): `tenants` carries tenant identity,
 * the four-boolean capability matrix, the descriptive_standard enum,
 * quota fields, and a nullable `disabled_at` column carrying the
 * soft-disable timestamp. `federations` sits one level above tenants
 * (platform > federation > tenant): every tenant carries a
 * `federation_id` and belongs to exactly one federation, standalone
 * tenants being a federation of one. `auditLog` records every operator action
 * that touches tenant data — append-only by trigger (BEFORE UPDATE /
 * BEFORE DELETE both RAISE ABORT), bounded by a CHECK enum on the
 * `action` column. `impersonationHandoffs` is the single-use D1
 * rendezvous between the operator's login-as action on the platform
 * host and the target tenant subdomain's /handoff/impersonation route —
 * mirrors `oauthHandoffs`'s single-use shape but is a separate table
 * to keep the OAuth narrative pure and the role-based impersonation
 * columns clean.
 *
 * Per-standard mandatoriness on `descriptions` runs in app-layer Zod
 * validators (`app/lib/validation/descriptions/`) and is invoked at
 * every write boundary: form submit handlers, `/api/description.save`
 * action, and the bulk import path. SQLite CHECK cannot reference
 * another table to test `tenants.descriptive_standard`, so the
 * union-schema descriptions table holds every per-standard field as
 * nullable, and the validator at the write boundary refuses payloads
 * that omit a field mandatory for the tenant's active standard. Bulk
 * import in particular MUST run the validator before INSERT to defend
 * against malformed external data.
 *
 * A handful of columns use deliberate anti-patterns that future
 * contributors should know about. Self-referencing tree columns
 * (`descriptions.parentId`, `entities.mergedInto`, `places.mergedInto`,
 * `places.parentId`) omit `.references()` to avoid Drizzle's recursive
 * FK declaration order trap; the FK still lives in the SQL migration.
 * The `qcFlags.regionCommentId` column exists in D1 from an earlier
 * iteration but is deprecated -- QC flags are image-level by design
 * and no application code reads or writes it any more; the column is
 * left in the database for migration purity and should be treated as
 * legacy for any future schema work.
 *
 * @version v0.7.0
 */

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  DESCRIPTION_LEVELS,
  RESOURCE_TYPES,
  ENTITY_TYPES,
  CERTAINTY_LEVELS,
  PLACE_TYPES,
  ENTITY_ROLES,
  PLACE_ROLES,
  VOCABULARY_STATUSES,
  VOLUME_STATUSES,
  ENTRY_TYPES,
  RESOURCE_TYPES_ES,
  PROJECT_ROLES,
  COMMENT_AUTHOR_ROLES,
  DESCRIPTIVE_STANDARDS,
  QC_PROBLEM_TYPES,
  QC_RESOLUTION_ACTIONS,
  GEONAMES_FCLASSES,
} from "../lib/validation/enums";
// AUDIT_LOG_ACTIONS lives in a tiny constants module so
// `app/lib/audit.server.ts` (which imports the auditLog table from
// here) can reuse the same source-of-truth array without creating a
// circular dependency. The DB-level CHECK on `audit_log.action`
// (migration 0037) remains the structural source of truth; this
// runtime hint just gives Drizzle TypeScript narrowing.
import { AUDIT_LOG_ACTIONS } from "../lib/audit-actions";

// The nine crowdsourcing-subtree tables declare `tenant_id` NOT NULL
// with NO Drizzle `.default(...)`: `tenantId` is therefore REQUIRED in
// each table's `$inferInsert` type, so TypeScript forces every writer to
// supply it explicitly (resolved from the row's natural parent -- project
// -> volume -> entry/page inheritance -- or the session tenant at the
// roots). The DB-level `DEFAULT '<neogranadina-uuid>'` that migration
// 0042 stamped on these columns remains in the SQLite schema as inert
// metadata: SQLite cannot drop a column default without the table rebuild
// prohibited for these populated cascade-parent tables (0042 header), and
// because no writer omits the column, that default is never consulted.
// The authority tables (entities/places/vocabulary_terms) carry
// `federation_id` as their required scope; drafts sit at a root (session
// tenant), keyed by (record_id, record_type) rather than under a volume.
// entities and places additionally carry an OPTIONAL `tenant_id`
// (migration 0067) whose NULL means "federation-shared" — it is an
// ownership marker inside the federation, not a second required scope,
// and it is the one `tenant_id` in the schema that a writer may leave
// unset.

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["tenant", "platform"] }).notNull().default("tenant"),
    descriptiveStandard: text("descriptive_standard", { enum: [...DESCRIPTIVE_STANDARDS] }),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    crowdsourcingEnabled: integer("crowdsourcing_enabled", { mode: "boolean" }).notNull().default(false),
    vocabularyHubEnabled: integer("vocabulary_hub_enabled", { mode: "boolean" }).notNull().default(true),
    publishPipelineEnabled: integer("publish_pipeline_enabled", { mode: "boolean" }).notNull().default(true),
    multiRepositoryEnabled: integer("multi_repository_enabled", { mode: "boolean" }).notNull().default(false),
    // Gates the entity/place authority surface (migration 0058). DEFAULT
    // true keeps the rollout behaviour-neutral; the greenfield member
    // tenants (komuni, sbmal) launch strings-only with it off.
    authoritiesEnabled: integer("authorities_enabled", { mode: "boolean" }).notNull().default(true),
    // Gates the bulk-import surface (migration 0061). DEFAULT false —
    // bulk upsert is operator-granted per tenant when an import is
    // actually planned.
    importsEnabled: integer("imports_enabled", { mode: "boolean" }).notNull().default(false),
    quotaStorageBytes: integer("quota_storage_bytes"),
    // Soft-disable timestamp (migration 0039). Nullable — NULL means
    // active. When set, getTenantFromRequest 404s the tenant subdomain
    // unless the request pathname starts with /operator/ (the operator
    // carve-out exists so a disabled tenant remains recoverable from
    // the operator surface).
    disabledAt: integer("disabled_at"),
    // The federation this tenant belongs to (federation spec §2 — every
    // tenant is in exactly one federation; a standalone tenant is a
    // federation of one). Declared `.notNull()` so reads type it as
    // `string` and every insert must supply it (there is no safe default
    // federation — see migration 0044's header), but the underlying D1
    // column is nullable-with-FK: migration 0044 adds it via
    // `ADD COLUMN federation_id TEXT REFERENCES federations(id)` (SQLite
    // forbids NOT NULL + REFERENCES on ADD COLUMN, and the table-rebuild
    // alternative is prohibited) and back-fills every current tenant, so
    // no NULL survives. Provisioning a new tenant must create its
    // federation-of-one and set this column in the same batch.
    //
    // `.references()` is deliberately OMITTED: tenants <-> federations is
    // a circular FK pair (federations.leadTenantId already points back
    // here), and declaring both directions in Drizzle triggers the
    // recursive-declaration trap (TS7022) — the same reason the
    // self-referencing tree columns above omit it. The real FK lives in
    // the SQL migration (0044) and the test harness; this is the one
    // side dropped to break the type cycle.
    federationId: text("federation_id").notNull(),
    // Authority code prefixes for records this tenant MAINTAINS
    // (migration 0068). Set only on a tenant that mints its OWN
    // authority records — i.e. one whose federation keeps sharing off,
    // so `requireAuthorityMint` resolves the tenant as the owner. SBMAL
    // carries 'sbmal-e' / 'sbmal-p'; every other tenant is NULL because
    // its mints resolve to the federation row instead.
    //
    // The prefix names the maintaining agency, and is stored rather than
    // derived from anything: it must NOT follow `entities.tenantId`,
    // which is mutable, because a later ownership transfer would then
    // falsify codes already published as citable identifiers. NULL means
    // "no prefix configured", and the mint path throws on it rather than
    // fall back to another institution's mark.
    entityCodePrefix: text("entity_code_prefix"),
    placeCodePrefix: text("place_code_prefix"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tenants_slug_idx").on(table.slug),
    index("tenants_kind_idx").on(table.kind),
    index("tenants_federation_idx").on(table.federationId),
  ],
);

// federations sit one scoping level above tenants (platform >
// federation > tenant). Every tenant references exactly one federation
// via tenants.federationId; a standalone tenant is a federation of one
// whose lead is itself. Authorities (entities, places, vocabulary terms)
// become federation-scoped in a later migration, shared across all
// member tenants of a federation. `leadTenantId` is a real FK back to
// tenants, making tenants <-> federations a circular FK pair — see
// migration 0044 for how creation/seeding/teardown sequence around it
// (D1 has no DEFERRED FK support).
export const federations = sqliteTable(
  "federations",
  {
    id: text("id").primaryKey(),
    // Not routable; admin/display only (federations have no host — the
    // lead tenant's host renders federation-level surfaces).
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    leadTenantId: text("lead_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    // Operator-set gate on whether this federation can have members at
    // all (federation spec §5). Default off: every federation starts as
    // a federation-of-one. Neogranadina and AMPL are enabled at
    // provisioning; the platform federation-of-one stays off.
    multiMemberEnabled: integer("multi_member_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    // Operator-set gate on whether this federation's authority space is
    // SHARED by default (migration 0067). Sibling of
    // `multiMemberEnabled` in every respect: boolean, NOT NULL, default
    // off. It governs what new authority minting DEFAULTS to, not what
    // is permitted — off mints tenant-owned entities/places (the minting
    // tenant's id lands in `entities.tenantId` / `places.tenantId`), on
    // mints federation-shared ones (NULL owner, steward-gated as
    // before). A federation whose members genuinely share people and
    // places turns it on; one whose members are unrelated archives
    // co-located for operational reasons leaves it off.
    sharedAuthoritiesEnabled: integer("shared_authorities_enabled", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    // Authority code prefixes for records this federation MAINTAINS
    // (migration 0068) — the shared-space counterpart of the identical
    // pair on `tenants`. A record minted into a shared authority space
    // (`entities.tenantId` NULL) takes its prefix from here; a
    // tenant-owned one takes it from the tenant row. The Neogranadina
    // federation carries 'ne' / 'nl', the series its ~78K existing codes
    // already use; every other federation is NULL until provisioned.
    //
    // Stored as the FINISHED prefix string, not a slug plus a derived
    // type letter, because Neogranadina's form fuses the type letter
    // into a two-letter mnemonic ('ne' = entidad, 'nl' = lugar) while
    // the general form separates it ('sbmal-e', 'sbmal-p'). The
    // generator's `${prefix}-${chars}` covers both with no branching.
    entityCodePrefix: text("entity_code_prefix"),
    placeCodePrefix: text("place_code_prefix"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("federations_slug_idx").on(table.slug),
    index("federations_lead_tenant_idx").on(table.leadTenantId),
  ],
);

// How often the notification sweep may email a user (0074). `15min` is
// the floor because it is the cron tick; `off` writes no outbox rows at
// all — the preference is prospective, so switching back on does not
// replay events accrued while off.
export const DIGEST_FREQUENCIES = [
  "15min",
  "hourly",
  "daily",
  "weekly",
  "off",
] as const;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "restrict" }),
  email: text("email").notNull().unique(),
  name: text("name"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  isSuperAdmin: integer("is_super_admin", { mode: "boolean" }).notNull().default(false),
  isCollabAdmin: integer("is_collab_admin", { mode: "boolean" }).notNull().default(false),
  isArchiveUser: integer("is_archive_user", { mode: "boolean" }).notNull().default(false),
  isUserManager: integer("is_user_manager", { mode: "boolean" }).notNull().default(false),
  isCataloguer: integer("is_cataloguer", { mode: "boolean" }).notNull().default(false),
  // Notification and language preferences (0074). `lastDigestAt` is the
  // sweep's per-user clock: due when now - lastDigestAt >= interval,
  // drift-based rather than wall-clock-anchored. `locale` is persisted
  // from the /configuracion language toggle and read by the digest
  // renderer; NULL falls back to the app's fallback language (es).
  digestFrequency: text("digest_frequency", { enum: [...DIGEST_FREQUENCIES] })
    .notNull()
    .default("hourly"),
  lastDigestAt: integer("last_digest_at"),
  locale: text("locale", { enum: ["en", "es"] }),
  lastActiveAt: integer("last_active_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  githubId: text("github_id").unique(),
});

// federation_memberships (migration 0049) is the grant join table:
// a row `(userId, federationId, role)` lets a user whose HOME tenant is
// elsewhere act in every tenant of `federationId` at the effective role
// its `role` maps to -- generalising the platform -> tenant impersonation
// mechanism one scoping level down (federation spec §3/§4). `role` is a
// bounded enum: `steward` (admin-equivalent in member tenants; full
// member-tenant setup/management) or `staff` (cataloguer/editor-equivalent;
// never member-tenant administration -- invariant I6). Both FKs are
// ON DELETE CASCADE (a membership is meaningless once its user or
// federation is gone). `UNIQUE (userId, federationId)` makes a user's
// role in a federation single-valued -- a role change is an UPDATE, not a
// second row. Grant resolution and effective-role mapping live in
// app/lib/federation.server.ts; this table only stores the grant.
export const federationMemberships = sqliteTable(
  "federation_memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["steward", "staff"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("fed_memberships_user_federation_idx").on(
      table.userId,
      table.federationId,
    ),
    index("fed_memberships_federation_idx").on(table.federationId),
  ],
);

// oauth_handoffs (migration 0038) is the ephemeral, single-use rendezvous
// table that lets the apex GitHub OAuth callback hand a freshly
// authenticated user off to a tenant subdomain. An earlier design tried
// to register one callback URL per tenant in the GitHub OAuth App; that
// model is structurally infeasible because GitHub OAuth Apps allow exactly
// one Authorization callback URL (GitHub Apps — a different product —
// allow multiple). The current design: apex completes OAuth at a single
// registered callback URL, inserts a row here keyed by an opaque 256-bit
// id, and 302s the browser to the tenant subdomain's /handoff?t= route,
// which atomically consumes the row and finalises the session.
//
// Single-use semantics: the consume helper in app/lib/oauth-handoff.server.ts
// issues a single UPDATE … RETURNING that flips consumed=0 to consumed=1
// only when expires_at > now AND consumed = 0. Replay attempts fail at the
// rowcount-zero branch and the route returns 410.
//
// TTL: rows expire 30s after creation. The browser hop is sub-second on
// the happy path; 30s is generous slack for slow mobile networks while
// keeping the replay window narrow if the token leaks via referer or
// browser history.
//
// No foreign keys: the row is ephemeral and the email + return_to_slug
// stored here are re-validated on consume against a fresh user lookup
// and a fresh tenant resolution from the request host. FKs would only
// add a delete-cascade hazard during tenant suspension or user deletion
// without buying any safety the runtime checks don't already give us.
export const oauthHandoffs = sqliteTable("oauth_handoffs", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  githubId: text("github_id").notNull(),
  githubLogin: text("github_login").notNull(),
  returnToSlug: text("return_to_slug").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});

// audit_log (migration 0037) records every operator action that touches
// tenant data. Append-only by trigger (BEFORE UPDATE / BEFORE DELETE
// both RAISE ABORT) and bounded by a CHECK enum on the `action`
// column. Drizzle does not model SQL CHECK constraints or triggers —
// the bounded action enum is enforced via the `enum:` runtime hint
// (TypeScript-level), and the actual CHECK + immutability triggers
// live only in 0037.
//
// Mixed FK delete behaviours: actor_user_id ON DELETE SET NULL paired
// with denormalised actor_user_id_text NOT NULL for forensic
// continuity. actor_tenant_id and target_tenant_id ON DELETE RESTRICT
// — no tenant deletion in v0.4.
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorUserIdText: text("actor_user_id_text").notNull(),
    actorTenantId: text("actor_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    action: text("action", {
      enum: AUDIT_LOG_ACTIONS,
    }).notNull(),
    targetTenantId: text("target_tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
    targetObjectKind: text("target_object_kind"),
    targetObjectId: text("target_object_id"),
    impersonationSessionId: text("impersonation_session_id"),
    details: text("details"),
  },
  (table) => [
    index("audit_log_target_tenant_idx").on(table.targetTenantId, table.createdAt),
    index("audit_log_actor_user_idx").on(table.actorUserId, table.createdAt),
    index("audit_log_created_idx").on(table.createdAt),
  ],
);

// impersonation_handoffs (migration 0039) is the single-use D1 row the
// operator login-as flow inserts on platform.fisqua.org and the tenant
// subdomain's /handoff/impersonation route consumes. Mirrors
// oauth_handoffs's single-use shape but is a separate table: keeps the
// OAuth narrative pure, gives audit_log.impersonation_session_id a
// clean FK-conceptual target, and lets the role-based impersonation
// columns (target_tenant_id, target_role) shed the OAuth-shape pollution.
//
// Single-use semantics: consumeImpersonationHandoff in
// app/lib/impersonation-handoff.server.ts issues a single
// UPDATE … RETURNING that flips consumed=0 → consumed=1 only when
// expires_at > now AND consumed = 0. Replay attempts fail at the
// rowcount-zero branch and the handoff route returns 410.
//
// TTL: 30s (IMPERSONATION_HANDOFF_TTL_MS). Browser hop is sub-second on the
// happy path; 30s slack for slow networks; narrow replay window if the
// token leaks via referer or browser history.
export const impersonationHandoffs = sqliteTable(
  "impersonation_handoffs",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    targetTenantId: text("target_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    targetRole: text("target_role", {
      enum: [
        "isAdmin",
        "isSuperAdmin",
        "isCollabAdmin",
        "isArchiveUser",
        "isUserManager",
        "isCataloguer",
      ],
    }).notNull(),
    reason: text("reason"),
    expiresAt: integer("expires_at").notNull(),
    consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("impersonation_handoffs_expires_idx").on(table.expiresAt),
    index("impersonation_handoffs_actor_idx").on(table.actorUserId, table.createdAt),
  ],
);

export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id").notNull().references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("magic_links_token_idx").on(table.token),
    index("magic_links_expires_idx").on(table.expiresAt),
  ]
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  conventions: text("conventions"),       // markdown guidelines
  settings: text("settings"),             // JSON blob for app-specific config
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
});

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: text("role", { enum: [...PROJECT_ROLES] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("pm_project_idx").on(table.projectId),
    index("pm_user_idx").on(table.userId),
    index("pm_project_user_idx").on(table.projectId, table.userId),
  ]
);

export const projectInvites = sqliteTable("project_invites", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  email: text("email").notNull(),
  roles: text("roles").notNull(),
  invitedBy: text("invited_by").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  acceptedAt: integer("accepted_at"),
  createdAt: integer("created_at").notNull(),
});

// --- EXTENSION POINT --- add your domain-specific tables below

export const volumes = sqliteTable(
  "volumes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id),
    name: text("name").notNull(),
    referenceCode: text("reference_code").notNull(),
    manifestUrl: text("manifest_url").notNull(),
    pageCount: integer("page_count").notNull(),
    status: text("status", {
      enum: [...VOLUME_STATUSES],
    })
      .notNull()
      .default("unstarted"),
    assignedTo: text("assigned_to").references(() => users.id),
    assignedReviewer: text("assigned_reviewer").references(() => users.id),
    reviewComment: text("review_comment"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("vol_project_idx").on(table.projectId),
    index("vol_status_idx").on(table.projectId, table.status),
  ]
);

export const volumePages = sqliteTable(
  "volume_pages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    imageUrl: text("image_url").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    label: text("label"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("vp_volume_idx").on(table.volumeId),
    index("vp_volume_pos_idx").on(table.volumeId, table.position),
  ]
);

// Entries carry their own copy of the descriptive fields
// (`translatedTitle` through `descriptionLevel` below) even though the
// same concepts exist as columns on `descriptions`. The split is
// deliberate: an entry's fields are the crowdsourcing WORKING copy --
// draft data with its own review lifecycle (`descriptionStatus`),
// edited through the project workflow -- while a `descriptions` row is
// the canonical archival record read by the catalogue and the export
// pipeline. Promotion (`app/lib/promote/promote.server.ts`) is the one
// bridge between them: it validates an approved entry and copies the
// mapped fields onto a fresh `descriptions` row, recording the link in
// `promotedDescriptionId`. After promotion the description is the
// authoritative copy; the entry keeps its fields as the record of what
// was promoted.
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id),
    parentId: text("parent_id"), // null = top-level entry
    position: integer("position").notNull(), // 0-based sibling order
    startPage: integer("start_page").notNull(), // 1-based page number
    startY: real("start_y").notNull().default(0), // 0.0 = top of page
    endPage: integer("end_page"), // explicit for children, null for top-level
    endY: real("end_y"), // fraction 0-1, null for top-level
    type: text("type", {
      enum: [...ENTRY_TYPES],
    }), // nullable: unset by default
    // Per-project document subtype label (e.g. "Escritura", "Poder", or a
    // free-typed "OTRO" value). Only meaningful when `type = 'item'`; null
    // for every other entry type. Free-form TEXT -- the authoritative list
    // lives in each project's `settings.documentSubtypes` JSON, seeded from
    // `app/_data/document-subtypes.ts :: DEFAULT_DOCUMENT_SUBTYPES`.
    subtype: text("subtype"),
    title: text("title"),
    modifiedBy: text("modified_by").references(() => users.id),
    // Description status and assignment
    descriptionStatus: text("description_status", {
      enum: ["unassigned", "assigned", "in_progress", "described", "reviewed", "approved", "sent_back", "promoted"],
    }).default("unassigned"),
    assignedDescriber: text("assigned_describer").references(() => users.id),
    assignedDescriptionReviewer: text("assigned_description_reviewer").references(() => users.id),
    // Description metadata fields
    translatedTitle: text("translated_title"),
    resourceType: text("resource_type", {
      enum: [...RESOURCE_TYPES_ES],
    }),
    dateExpression: text("date_expression"),
    dateStart: text("date_start"),
    dateEnd: text("date_end"),
    extent: text("extent"),
    scopeContent: text("scope_content"),
    language: text("language"),
    descriptionNotes: text("description_notes"),
    internalNotes: text("internal_notes"),
    descriptionLevel: text("description_level").default("item"),
    promotedDescriptionId: text("promoted_description_id").references(() => descriptions.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("entry_volume_idx").on(table.volumeId),
    index("entry_parent_idx").on(table.parentId),
    index("entry_volume_pos_idx").on(table.volumeId, table.position),
    index("entry_promoted_idx").on(table.promotedDescriptionId),
  ]
);

export const resegmentationFlags = sqliteTable(
  "resegmentation_flags",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    volumeId: text("volume_id").notNull().references(() => volumes.id),
    reportedBy: text("reported_by").notNull().references(() => users.id),
    entryId: text("entry_id").notNull().references(() => entries.id),
    problemType: text("problem_type", {
      enum: ["incorrect_boundaries", "merged_documents", "split_document", "missing_pages", "other"],
    }).notNull(),
    affectedEntryIds: text("affected_entry_ids").notNull(), // JSON array of entry IDs
    description: text("description").notNull(),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("reseg_volume_idx").on(table.volumeId)]
);

// Page-scoped digitisation quality-control flags. Keyed to a volume_page
// so that flags survive entry resegmentation -- an entry's page range may
// change, but the page image does not. Only project leads can transition
// a flag out of 'open'; the app-layer guard lives in `requireProjectRole`
// and the DB CHECK constraints keep the resolution metadata consistent.
//
// `qcFlags` is declared before `comments` because `comments.qcFlagId`
// references it and Drizzle resolves `() => qcFlags.id` at module load.
//
// Legacy column: `region_comment_id` exists in D1 (migration 0031) from an
// earlier iteration that tried to pin a flag to a region-anchored comment.
// Post-ship feedback reverted that direction -- QC flags are image-level
// by design -- but the column is not dropped: per the project's cleanup
// policy we leave unused columns in place and stop reading/writing them.
// The Drizzle schema omits the field; no application code references it.
export const qcFlags = sqliteTable(
  "qc_flags",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => volumePages.id, { onDelete: "cascade" }),
    reportedBy: text("reported_by").notNull().references(() => users.id),
    problemType: text("problem_type", {
      enum: [...QC_PROBLEM_TYPES],
    }).notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: ["open", "resolved", "wontfix"] })
      .notNull()
      .default("open"),
    resolutionAction: text("resolution_action", {
      enum: [...QC_RESOLUTION_ACTIONS],
    }),
    resolverNote: text("resolver_note"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("qc_flags_volume_status_idx").on(table.volumeId, table.status),
    index("qc_flags_page_idx").on(table.pageId),
    index("qc_flags_reporter_idx").on(table.reportedBy),
  ]
);

// A comment targets exactly one of: an entry, a page, a QC flag, or a
// pending decision -- enforced by a four-way DB CHECK constraint
// (migration 0071 folded the short-lived decision_comments table in;
// comments are one archival record class). Its author is exactly one
// of a user or an agency label ("Fisqua" for the system's own
// comments) -- CHECK-enforced either/or. tenant_id and volume_id stay
// required for the three volume-anchored targets (DB CHECKs); only
// decision-targeted rows may omit them. Page-targeted comments may
// carry image-region coordinates (region_x/y/w/h as REALs in 0-1
// normalised page space); the "region requires page_id" invariant
// lives in `app/lib/comments.server.ts` rather than a CHECK because
// expressing it alongside the four-way XOR would read awkwardly.
export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    // Required unless decision-targeted (DB CHECK); a decision comment
    // copies its decision's tenant (null for federation-level rows).
    tenantId: text("tenant_id"),
    // Denormalised for cheap volume-scoped queries. Required unless
    // decision-targeted (DB CHECK).
    volumeId: text("volume_id").references(() => volumes.id, {
      onDelete: "cascade",
    }),
    // Nullable target columns -- exactly one must be set (DB CHECK).
    entryId: text("entry_id").references(() => entries.id, { onDelete: "cascade" }),
    pageId: text("page_id").references(() => volumePages.id, { onDelete: "cascade" }),
    qcFlagId: text("qc_flag_id").references(() => qcFlags.id, { onDelete: "cascade" }),
    // RESTRICT: a decision carrying its case file is never hard-deleted.
    decisionId: text("decision_id").references(() => pendingDecisions.id, {
      onDelete: "restrict",
    }),
    // Image-region coordinates for page-targeted pins. All four nullable;
    // a single click stores a pin (w=h=0 or NULL), a drag stores a box.
    regionX: real("region_x"),
    regionY: real("region_y"),
    regionW: real("region_w"),
    regionH: real("region_h"),
    parentId: text("parent_id"), // null = top-level, references comments.id for nesting
    // Exactly one of authorId/authorLabel is set (DB CHECK): a person,
    // or an agency ("Fisqua", an import pipeline).
    authorId: text("author_id").references(() => users.id),
    authorLabel: text("author_label"),
    // Role snapshot at post time -- project roles on volume surfaces,
    // tenant roles (admin) on decision threads; null for label authors.
    authorRole: text("author_role", { enum: [...COMMENT_AUTHOR_ROLES] }),
    text: text("text").notNull(),
    // One quoted passage per comment, with its reference ("CMD 134")
    // and an optional epistemic qualifier. The "quoted from this
    // workspace's own catalogue" line is render-time i18n, never stored.
    quote: text("quote"),
    quoteRef: text("quote_ref"),
    note: text("note"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Soft-delete, resolve, and last-edit markers. All nullable; a fresh
    // comment has NULL in all five. `deletedAt` is set by
    // `softDeleteComment` and cascades to replies when the deleted row is
    // a root. `resolvedAt`/`resolvedBy` are set only on roots. `editedAt`
    // tracks the last body edit -- coordinate moves bump `updatedAt` but
    // leave `editedAt` alone so the card's "Editado" chip reflects body
    // edits only.
    deletedAt: integer("deleted_at"),
    deletedBy: text("deleted_by").references(() => users.id),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by").references(() => users.id),
    editedAt: integer("edited_at"),
  },
  (table) => [
    index("comment_volume_idx").on(table.volumeId),
    index("comment_entry_idx").on(table.entryId),
    index("comment_page_idx").on(table.pageId),
    index("comment_qc_flag_idx").on(table.qcFlagId),
    index("comment_parent_idx").on(table.parentId),
    index("comment_decision_idx").on(table.decisionId, table.createdAt),
  ]
);

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    volumeId: text("volume_id").references(() => volumes.id),
    event: text("event", {
      enum: [
        "login",
        "volume_opened",
        "status_changed",
        "review_submitted",
        "assignment_changed",
        "description_status_changed",
        "description_assignment_changed",
        "resegmentation_flagged",
        "comment_added",
        "comment_region_moved",
        "comment_edited",
        "comment_deleted",
        "comment_resolved",
        "comment_unresolved",
        "qc_flag_raised",
        "qc_flag_resolved",
      ],
    }).notNull(),
    detail: text("detail"), // JSON blob for event-specific data
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("al_user_idx").on(table.userId),
    index("al_project_idx").on(table.projectId),
    index("al_created_idx").on(table.createdAt),
  ]
);

// ============================================================================
// Archival management platform tables
// ============================================================================

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    shortName: text("short_name"),
    countryCode: text("country_code").default("COL"),
    country: text("country"),
    city: text("city"),
    address: text("address"),
    website: text("website"),
    notes: text("notes"),
    rightsText: text("rights_text"),
    displayTitle: text("display_title"),
    subtitle: text("subtitle"),
    heroImageUrl: text("hero_image_url"),
    enabled: integer("enabled", { mode: "boolean" }).default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Per-tenant unique (migration 0043): repository codes are unique
    // within a tenant, not globally.
    uniqueIndex("repo_code_idx").on(table.tenantId, table.code),
  ]
);

// The canonical archival record. Crowdsourced description work does
// not happen on this table: it accumulates on `entries` (the working
// copy -- see that table's note) and arrives here via promotion, which
// copies an approved entry's mapped fields onto a fresh row. Rows are
// also created directly by the admin description editor and the bulk
// import scripts.
export const descriptions = sqliteTable(
  "descriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    // Hierarchy (adjacency list with denormalised cache)
    parentId: text("parent_id"), // self-ref; no .references() (see file-level notes)
    position: integer("position").notNull().default(0),
    rootDescriptionId: text("root_description_id"), // self-ref; no .references()
    // Denormalised cache
    depth: integer("depth").notNull().default(0),
    childCount: integer("child_count").notNull().default(0),
    pathCache: text("path_cache").default(""),
    // Classification
    descriptionLevel: text("description_level", { enum: [...DESCRIPTION_LEVELS] }).notNull(),
    resourceType: text("resource_type", { enum: [...RESOURCE_TYPES] }),
    genre: text("genre").default("[]"), // JSON array
    // Identity (ISAD 3.1)
    referenceCode: text("reference_code").notNull(),
    // local_identifier RELAXED to nullable in 0036 (was NOT NULL in v0.3).
    // DACS and RAD do not mandate it; ISAD(G) does not mandate it. The
    // Django export is 99.9% populated so back-filled rows all carry it;
    // this is a forward-looking relaxation for future DACS/RAD tenants.
    localIdentifier: text("local_identifier"),
    title: text("title").notNull(),
    translatedTitle: text("translated_title"),
    uniformTitle: text("uniform_title"),
    // Dates
    dateExpression: text("date_expression"),
    dateStart: text("date_start"), // ISO date string
    dateEnd: text("date_end"), // ISO date string
    dateCertainty: text("date_certainty"),
    // Physical description
    extent: text("extent"),
    dimensions: text("dimensions"),
    medium: text("medium"),
    // Bibliographic
    imprint: text("imprint"),
    editionStatement: text("edition_statement"),
    seriesStatement: text("series_statement"),
    volumeNumber: text("volume_number"),
    issueNumber: text("issue_number"),
    pages: text("pages"),
    // Bibliographic-block "Title of the larger publication" (journal,
    // series, source-edition); 13.6% populated in the legacy data.
    publicationTitle: text("publication_title"),
    // Context (ISAD 3.2)
    provenance: text("provenance"),
    // Content (ISAD 3.3)
    scopeContent: text("scope_content"),
    ocrText: text("ocr_text").default(""),
    arrangement: text("arrangement"),
    // Access (ISAD 3.4)
    accessConditions: text("access_conditions"),
    reproductionConditions: text("reproduction_conditions"),
    language: text("language"),
    // Allied materials (ISAD 3.5)
    locationOfOriginals: text("location_of_originals"),
    locationOfCopies: text("location_of_copies"),
    // related_materials DROPPED in migration 0036 — 0% populated in audit.
    findingAids: text("finding_aids"),
    // Bibliographic continued
    sectionTitle: text("section_title"),
    // Notes (ISAD 3.6)
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    // Denormalised for display/search
    creatorDisplay: text("creator_display"),
    placeDisplay: text("place_display"),
    // Digital
    iiifManifestUrl: text("iiif_manifest_url"),
    hasDigital: integer("has_digital", { mode: "boolean" }).default(false),
    // Workflow
    isPublished: integer("is_published", { mode: "boolean" }).default(false),
    lastExportedAt: integer("last_exported_at"),
    // Union-schema additions: DACS-only and RAD-only fields landed as
    // nullable text columns. Per-standard mandatoriness is enforced at
    // the app-layer Zod boundary, not at the DB layer (see file-level
    // narrative).
    adminBiogHistory: text("admin_biog_history"),         // DACS 5.1
    preferredCitation: text("preferred_citation"),        // DACS 7.1.5
    acquisitionInfo: text("acquisition_info"),            // DACS 5.2 (custodial history)
    systemOfArrangement: text("system_of_arrangement"),   // RAD 1.7B
    physicalCharacteristics: text("physical_characteristics"), // RAD 1.5B
    // Legacy ids JSON column. Zod-validated at the loader/action layer
    // via `app/lib/validation/legacy-ids.ts`.
    legacyIds: text("legacy_ids").notNull().default("[]"),
    // Audit
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("desc_parent_pos_idx").on(table.parentId, table.position),
    index("desc_root_idx").on(table.rootDescriptionId),
    // Per-tenant unique (migration 0043): reference codes are unique
    // within a tenant, not globally.
    uniqueIndex("desc_ref_code_idx").on(table.tenantId, table.referenceCode),
    index("desc_repo_idx").on(table.repositoryId),
    index("desc_local_id_idx").on(table.localIdentifier),
  ]
);

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    // Authority scope is the FEDERATION, not the tenant (federation spec
    // §9 step 3, migrations 0045-0048): entities are managed by the federation
    // and shared by all its members. Declared `.notNull()` so reads type
    // it as `string` and every insert must supply it (no safe default
    // federation — see 0044/0045 headers); the underlying D1 column is
    // nullable-with-FK (0045 adds it via ADD COLUMN, 0046 backfills;
    // the table-rebuild alternative is prohibited), but the backfill
    // leaves no NULL. tenant_id was dropped by 0048.
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "restrict" }),
    // OPTIONAL owner one level below the federation (migration 0067).
    // Deliberately NULLABLE at both the DB and the type layer, because
    // NULL is a meaningful value here rather than a gap:
    //
    //   set  -> tenant-owned. Visible to that tenant only; mutated by
    //           that tenant's own admins with no steward gate.
    //   NULL -> federation-shared. Visible to every member tenant;
    //           mutated only by a federation steward (the 2026-07-08
    //           rule, unchanged).
    //
    // INVARIANT: when `tenantId` is set, this row's `federationId` MUST
    // equal that tenant's federation. Ownership NARROWS scope; it never
    // moves a record between federations. Upheld by construction — the
    // owner is only ever the REQUEST tenant, whose federation is the one
    // the query already filters on — not by a DB constraint (SQLite has
    // no cross-table CHECK).
    //
    // The unique code index below stays (federationId, entityCode):
    // codes are unique federation-wide whether or not a record is owned,
    // so an owned record can later be shared without a collision.
    // Reads must never filter on `federationId` alone — go through
    // `authorityScope()` in `app/lib/authority-ownership.server.ts`.
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "restrict",
    }),
    // `<agency prefix>-xxxxxx`: `ne-abc234` for a record Neogranadina
    // maintains, `sbmal-e-abc234` for one SBMAL maintains (migration
    // 0068). The prefix names the MAINTAINING agency and is issued once
    // — it is not derived from `tenantId`, which is transferable.
    entityCode: text("entity_code"),
    displayName: text("display_name").notNull(),
    sortName: text("sort_name").notNull(),
    surname: text("surname"),
    givenName: text("given_name"),
    entityType: text("entity_type", { enum: [...ENTITY_TYPES] }).notNull(),
    honorific: text("honorific"),
    primaryFunction: text("primary_function"),
    primaryFunctionId: text("primary_function_id").references(() => vocabularyTerms.id, { onDelete: "set null" }),
    nameVariants: text("name_variants").default("[]"), // JSON array
    datesOfExistence: text("dates_of_existence"),
    dateStart: text("date_start"), // ISO date string
    dateEnd: text("date_end"), // ISO date string
    history: text("history"),
    // legal_status DROPPED in migration 0036 — 0% populated in audit.
    functions: text("functions"),
    sources: text("sources"),
    mergedInto: text("merged_into"), // self-ref; no .references()
    wikidataId: text("wikidata_id"),
    viafId: text("viaf_id"),
    // dbe_id (Diccionario Biográfico Electrónico authority ref) +
    // legacy_ids JSON column.
    dbeId: text("dbe_id"),
    legacyIds: text("legacy_ids").notNull().default("[]"),
    // Notes pair mirroring descriptions' ISAD 3.6 columns (migration
    // 0059): `notes` may eventually publish; `internal_notes` never
    // leaves the admin surface.
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Codes are unique per FEDERATION (invariant I5), not global —
    // migration 0048 swapped this from UNIQUE(entity_code).
    uniqueIndex("entity_code_idx").on(table.federationId, table.entityCode),
    index("entity_sort_name_idx").on(table.sortName),
    index("entity_wikidata_idx").on(table.wikidataId),
    index("entity_pf_id_idx").on(table.primaryFunctionId),
  ]
);

export const places = sqliteTable(
  "places",
  {
    id: text("id").primaryKey(),
    // Federation-scoped authority (see entities.federationId; 0045 adds
    // the column, 0047 backfills). tenant_id was dropped by 0048.
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "restrict" }),
    // OPTIONAL owner, identical in meaning and invariant to
    // `entities.tenantId` (migration 0067): set = tenant-owned (that
    // tenant's admins mutate it freely), NULL = federation-shared
    // (steward-gated). When set, `federationId` MUST equal that tenant's
    // federation — ownership narrows scope, never moves a record between
    // federations. Reads go through `authorityScope()` in
    // `app/lib/authority-ownership.server.ts`, never through a bare
    // `federationId` filter.
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "restrict",
    }),
    // `<agency prefix>-xxxxxx`, same rule as `entities.entityCode`:
    // `nl-abc234` for Neogranadina, `sbmal-p-abc234` for SBMAL
    // (migration 0068).
    placeCode: text("place_code"),
    label: text("label").notNull(),
    displayName: text("display_name").notNull(),
    placeType: text("place_type", { enum: [...PLACE_TYPES] }),
    nameVariants: text("name_variants").default("[]"), // JSON array
    parentId: text("parent_id"), // self-ref; no .references()
    latitude: real("latitude"),
    longitude: real("longitude"),
    // Four-value vocabulary (exact/approximate/centroid/uncertain,
    // NULL = not recorded) enforced at the app-layer Zod boundary, not
    // by a DB CHECK; migration 0060 mapped the legacy v2_* pipeline
    // codes into it and archived the originals in legacy_ids. Rows
    // predating the vocabulary may hold values outside the enum -- the
    // Drizzle `enum:` hint is deliberately absent.
    coordinatePrecision: text("coordinate_precision"),
    // historical_gobernacion, historical_partido, historical_region,
    // country_code, admin_level_1, admin_level_2, wikidata_id all
    // DROPPED in migration 0036 — 0% populated in audit.
    // needs_geocoding DROPPED in migration 0060: coordinate status is
    // derived from (latitude, coordinate_precision) instead of stored.
    mergedInto: text("merged_into"), // self-ref; no .references()
    tgnId: text("tgn_id"),
    hgisId: text("hgis_id"),
    whgId: text("whg_id"),
    // fclass (5-value GeoNames feature class) + legacy_ids JSON
    // column. The DB-level CHECK on fclass
    // (`IS NULL OR IN ('P','H','A','T','S')`) lives in the migration;
    // Drizzle's `enum:` hint here is the TypeScript-side mirror.
    fclass: text("fclass", { enum: [...GEONAMES_FCLASSES] }),
    legacyIds: text("legacy_ids").notNull().default("[]"),
    // Notes pair mirroring descriptions' ISAD 3.6 columns (migration
    // 0059): `notes` may eventually publish; `internal_notes` never
    // leaves the admin surface.
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Codes are unique per FEDERATION (invariant I5) — migration 0048
    // swapped this from UNIQUE(place_code).
    uniqueIndex("place_code_idx").on(table.federationId, table.placeCode),
    index("place_label_idx").on(table.label),
    index("place_tgn_idx").on(table.tgnId),
  ]
);

export const entityFunctions = sqliteTable(
  "entity_functions",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    honorific: text("honorific"),
    function: text("function").notNull(),
    dateStart: text("date_start"), // ISO date string
    dateEnd: text("date_end"), // ISO date string
    dateNote: text("date_note"),
    certainty: text("certainty", { enum: [...CERTAINTY_LEVELS] }).default("probable"),
    source: text("source"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("ef_entity_idx").on(table.entityId),
  ]
);

export const descriptionEntities = sqliteTable(
  "description_entities",
  {
    id: text("id").primaryKey(),
    descriptionId: text("description_id")
      .notNull()
      .references(() => descriptions.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    role: text("role", { enum: [...ENTITY_ROLES] }).notNull(),
    roleNote: text("role_note"),
    // Dual-track: verbatim Spanish (or original source string) preserved
    // next to the canonical English `role`. Nullable, no CHECK — the
    // migration is `0040_role_raw.sql`.
    roleRaw: text("role_raw"),
    sequence: integer("sequence").notNull().default(0),
    honorific: text("honorific"), // documentary styling
    function: text("function"), // documentary styling
    nameAsRecorded: text("name_as_recorded"), // documentary styling
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("de_desc_idx").on(table.descriptionId),
    index("de_entity_role_idx").on(table.entityId, table.role),
    uniqueIndex("de_unique_idx").on(table.descriptionId, table.entityId, table.role),
  ]
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    recordId: text("record_id").notNull(),
    recordType: text("record_type").notNull(), // 'description' | 'repository' | 'entity' | 'place'
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    snapshot: text("snapshot").notNull(), // JSON blob of form state
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Per-tenant uniqueness (migration 0050): entities/places are
    // federation-SHARED records, so two tenants may each hold a draft on
    // the same (recordId, recordType) -- the uniqueness domain is the
    // tenant, not the platform.
    uniqueIndex("drafts_record_idx").on(
      table.tenantId,
      table.recordId,
      table.recordType,
    ),
    index("drafts_user_idx").on(table.userId),
  ]
);

export const changelog = sqliteTable(
  "changelog",
  {
    id: text("id").primaryKey(),
    recordId: text("record_id").notNull(),
    recordType: text("record_type").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    note: text("note"),
    diff: text("diff").notNull(), // JSON: { fieldName: { old, new } }
    // Stewardship journal columns (migration 0063). runId: which
    // stewardship run caused this row; NULL = ordinary hand edit. No
    // FK — journal rows must stay readable regardless of runs. kind:
    // the effect discriminator; per-kind diff contract in the
    // stewardship record spec §3. Rows are append-only at the DB level
    // (0063 triggers) — never UPDATE or DELETE through this table.
    runId: text("run_id"),
    kind: text("kind", { enum: ["create", "update", "delete", "link", "unlink"] })
      .notNull()
      .default("update"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("changelog_record_idx").on(table.recordId, table.recordType, table.createdAt),
    index("changelog_run_idx").on(table.runId),
  ]
);

export const descriptionPlaces = sqliteTable(
  "description_places",
  {
    id: text("id").primaryKey(),
    descriptionId: text("description_id")
      .notNull()
      .references(() => descriptions.id, { onDelete: "cascade" }),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "restrict" }),
    role: text("role", { enum: [...PLACE_ROLES] }).notNull(),
    roleNote: text("role_note"),
    // Dual-track: verbatim Spanish preserved next to canonical English
    // `role`. Nullable, no CHECK — see `drizzle/0040_role_raw.sql`.
    roleRaw: text("role_raw"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("dp_desc_idx").on(table.descriptionId),
    index("dp_place_role_idx").on(table.placeId, table.role),
    uniqueIndex("dp_unique_idx").on(table.descriptionId, table.placeId, table.role),
  ]
);

export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").references(() => users.id),
});

export const exportRuns = sqliteTable(
  "export_runs",
  {
    id: text("id").primaryKey(),
    triggeredBy: text("triggered_by")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["pending", "running", "complete", "error"],
    }).notNull().default("pending"),
    // Selective export config
    selectedFonds: text("selected_fonds").notNull(), // JSON array of fonds ref codes
    selectedTypes: text("selected_types").notNull(), // JSON array: ["descriptions","repositories","entities","places"]
    // The federation this aggregated publish run published (migration
    // 0055; federation spec §3/§9 step 8). Publishing is a
    // federation-level operation -- the lead publishes all member
    // tenants -- so the run's attribution is the federation, not one
    // tenant. Nullable at BOTH the DB and Drizzle layers: historical
    // rows predate federation-aware publishing and have no correct
    // federation to backfill, and (unlike tenants.federationId) this
    // column is not a scoping root, so a NULL on a legacy run is
    // harmless. New runs set it explicitly at insert. `.references()` is
    // safe here (no circular-FK cycle -- export_runs is only ever
    // referenced, never referenced-by, in the federation graph).
    federationId: text("federation_id").references(() => federations.id),
    // Progress tracking
    currentStep: text("current_step"),   // e.g. "descriptions:co-ahr-gob"
    stepsCompleted: integer("steps_completed").notNull().default(0),
    totalSteps: integer("total_steps").notNull().default(0),
    // Results
    recordCounts: text("record_counts"), // JSON: { "descriptions:co-ahr-gob": 45000, ... }
    // Workflows tracking — per-step heartbeats and the Cloudflare Workflow instance id
    workflowInstanceId: text("workflow_instance_id"),
    currentStepStartedAt: integer("current_step_started_at"),
    currentStepCompletedAt: integer("current_step_completed_at"),
    lastHeartbeatAt: integer("last_heartbeat_at"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("export_runs_status_idx").on(table.status),
    index("export_runs_created_idx").on(table.createdAt),
  ]
);

// The commit envelope for bulk operations (migration 0062; stewardship
// record spec §2): one row per import or revert run, carrying the
// REQUIRED operator message, attribution, revert linkage, artifact
// pointers, and the export_runs-shaped Workflow lifecycle columns.
// Mutability contract (spec §6): only the lifecycle/linkage columns
// (status, step tracking, heartbeats, errorMessage, started/completedAt,
// revertedByRunId) are ever updated — by the Workflow and the revert
// stamp. Rows are never deleted. revertsRunId/revertedByRunId/profileId
// carry NO FK: ledger rows must stay referenceable forever (the
// authority_operations.source_id rule), and a run must outlive its
// profile.
export const stewardshipRuns = sqliteTable(
  "stewardship_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    federationId: text("federation_id").references(() => federations.id),
    kind: text("kind", { enum: ["import", "revert"] }).notNull(),
    message: text("message").notNull(),
    justification: text("justification"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["pending", "running", "complete", "error"],
    }).notNull().default("pending"),
    revertsRunId: text("reverts_run_id"),
    revertedByRunId: text("reverted_by_run_id"),
    profileId: text("profile_id"),
    profileVersion: integer("profile_version"),
    sourceArtifact: text("source_artifact"),
    reportArtifact: text("report_artifact"),
    recordCounts: text("record_counts"), // JSON: { created, updated, linked, rejected, ... }
    // Audit snapshot of the readiness-check acceptances (0066), copied
    // from the upload row when the run is minted — never from client
    // input — so the run shows which incompleteness the operator
    // knowingly accepted.
    acceptedFindings: text("accepted_findings"), // JSON: [{ classKeys, counts, acceptedBy, acceptedAt }]
    workflowInstanceId: text("workflow_instance_id"),
    currentStep: text("current_step"),
    stepsCompleted: integer("steps_completed").notNull().default(0),
    totalSteps: integer("total_steps").notNull().default(0),
    currentStepStartedAt: integer("current_step_started_at"),
    currentStepCompletedAt: integer("current_step_completed_at"),
    lastHeartbeatAt: integer("last_heartbeat_at"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("stewardship_runs_tenant_idx").on(table.tenantId, table.createdAt),
    index("stewardship_runs_status_idx").on(table.status),
    index("stewardship_runs_reverts_idx").on(table.revertsRunId),
  ]
);

// Named, per-tenant, versioned mapping profiles (migration 0064;
// imports spec §2): `bindings` is the Zod-validated JSON mapping of
// CSV HEADER NAMES to description fields, each with an optional
// transform spec. A profile is a single mutable row whose `version`
// increments on every bindings edit; runs pin (profileId,
// profileVersion) on stewardship_runs, so drift is detectable and
// revert never replays a mapping (the journal's before-images carry
// the effects). sharedWithFederation (spec §7.3) marks lead-tenant
// profiles readable by federation members — app-layer enforced.
// starterKey marks seeded starter profiles (phase 7); NULL =
// operator-authored. Nothing references this table by FK: runs and
// uploads keep FK-free profileId pointers so they outlive deletion.
export const importProfiles = sqliteTable(
  "import_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    bindings: text("bindings").notNull(), // JSON: ProfileBindings (Zod-validated)
    starterKey: text("starter_key"),
    sharedWithFederation: integer("shared_with_federation", { mode: "boolean" })
      .notNull()
      .default(false),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: text("updated_by").references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("import_profiles_tenant_name_unq").on(table.tenantId, table.name),
    index("import_profiles_tenant_idx").on(table.tenantId, table.updatedAt),
  ]
);

// The metadata row behind every staged CSV upload (migration 0065;
// imports spec §§1, 4). The staged FILE lives in the staging store
// (B2 in production, the local R2 binding in dev/tests — spec §7.4);
// artifactKey points at it. Carries what the upload → profile →
// dry-run → commit flow needs without re-fetching the object; the
// dry-run report artifact is written before and independently of any
// commit. Lifecycle: staged → committed (runId stamped) | discarded —
// discard is a status flip, never a DELETE. runId carries a real FK
// (stewardship_runs rows are never deleted); profileId is FK-free,
// mirroring stewardshipRuns.profileId.
export const importUploads = sqliteTable(
  "import_uploads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    filename: text("filename").notNull(),
    artifactKey: text("artifact_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    rowCount: integer("row_count"),
    headers: text("headers"), // JSON: string[] of parsed header names
    profileId: text("profile_id"),
    profileVersion: integer("profile_version"),
    reportArtifact: text("report_artifact"),
    // Readiness check (0066; readiness-check design §3.5). Findings are
    // pinned to (profileId, profileVersion) and recomputed on drift;
    // decisions record accepted class keys and never carry to a
    // re-upload.
    checkFindings: text("check_findings"), // JSON: { profileId, profileVersion, computedAt, findings }
    checkDecisions: text("check_decisions"), // JSON: [{ classKeys, acceptedBy, acceptedAt }]
    status: text("status", {
      enum: ["staged", "committed", "discarded"],
    }).notNull().default("staged"),
    runId: text("run_id").references(() => stewardshipRuns.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("import_uploads_tenant_idx").on(table.tenantId, table.createdAt),
    index("import_uploads_status_idx").on(table.status),
  ]
);

// ============================================================================
// Controlled vocabulary
// ============================================================================

export const vocabularyTerms = sqliteTable(
  "vocabulary_terms",
  {
    id: text("id").primaryKey(),
    // Federation-scoped authority (federation spec §9 step 3, migration
    // 0045). vocabulary_terms was a tenant-blind global table before the
    // lift; the review-queue proposer-tenant visibility logic is
    // superseded by this column. Same nullable-with-FK-at-DB /
    // notNull-at-type pattern as entities.federationId (0045 backfills
    // every existing term to the Neogranadina federation).
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "restrict" }),
    canonical: text("canonical").notNull(),
    category: text("category"),
    status: text("status", { enum: [...VOCABULARY_STATUSES] }).notNull().default("approved"),
    mergedInto: text("merged_into"),
    entityCount: integer("entity_count").notNull().default(0),
    proposedBy: text("proposed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: integer("reviewed_at"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("vt_canonical_idx").on(table.canonical),
    index("vt_category_idx").on(table.category),
    index("vt_status_idx").on(table.status),
    // Federation lookup index (migration 0045) — vocab reads/mutations
    // scope by federation_id.
    index("vt_federation_idx").on(table.federationId),
  ]
);

// authority_operations (migration 0057) is the append-only ledger of
// irreversible authority mutations: entity/place/vocabulary_term merge,
// split, and delete. It is the durable system of record — the free-text
// `entities.sources` merge/split notes stay human-readable in place and
// `merged_into` stays the live pointer the app filters on, but neither
// survives a later edit. Written in the same D1 batch as the mutation it
// records (app/lib/authority-operations.server.ts) so the ledger row and
// the mutation commit atomically. Append-only by trigger (BEFORE UPDATE /
// BEFORE DELETE both RAISE ABORT, bare form) and bounded by CHECK enums on
// record_type + operation — as with audit_log, Drizzle models neither, so
// the `enum:` hints below are the TypeScript-side mirror of the SQL CHECKs
// in 0057. source_id / target_id carry NO foreign key: a deleted record
// must stay referenceable (delete: source_id = the gone record) and a
// merge loser / split parent may be deleted later.
export const authorityOperations = sqliteTable(
  "authority_operations",
  {
    id: text("id").primaryKey(),
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "restrict" }),
    recordType: text("record_type", {
      enum: ["entity", "place", "vocabulary_term"],
    }).notNull(),
    // resolve (per-entity creation provenance, written only by the
    // pipeline provenance backfill — spec §10) and separate (a refuted
    // merge: the do-not-relink record automated extraction consults)
    // are reserved for the backfill; the admin routes write only the
    // first three.
    operation: text("operation", {
      enum: ["merge", "split", "delete", "resolve", "separate"],
    }).notNull(),
    // merge: the loser · split: the parent · delete: the deleted record.
    sourceId: text("source_id").notNull(),
    // merge: the winner · split: the new record · delete: NULL.
    targetId: text("target_id"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    detail: text("detail"), // JSON, nullable
    createdAt: integer("created_at").notNull(), // epoch ms
  },
  (table) => [
    index("authority_operations_federation_idx").on(table.federationId),
    index("authority_operations_source_idx").on(table.sourceId),
    index("authority_operations_target_idx").on(table.targetId),
  ]
);

// ---------------------------------------------------------------------------
// Pending decisions (migration 0069; pairs reshaped by 0072): the
// queue where a workspace's open questions wait for a ruling, kept
// afterwards as the audit trail of who ruled what, on which evidence,
// and what it produced. Two kinds: 'authority-proposal' (created open;
// accept mints or links and stamps result_id) and 'duplicate-pair' (a
// pair the scan flagged, made durable — the scan itself stays live and
// unpersisted, so a row exists only once something durable happens: a
// comment lands on the pair, or it is ruled. Ruled 'merged' stamps the
// survivor in result_id; ruled 'kept_both' is the persisted "not a
// duplicate" the scan subtracts. source_ref carries the sorted pairKey
// so the lazy get-or-create can find an existing row. 0072 absorbed
// the earlier 'duplicate-dismissal' kind into this shape).
// Vocabulary proposals do NOT get rows here: vocabulary_terms keeps its
// own status machine and the surface reads it directly.
//
// tenant_id follows the 0067 ownership shape: set = the tenant's own
// question (its admins rule); NULL = shared-space question (steward
// rules). payload is JSON because the kinds carry different shapes and
// no query filters on its parts; everything the queue filters on is a
// real column.
// ---------------------------------------------------------------------------

export const PENDING_DECISION_KINDS = [
  "authority-proposal",
  "duplicate-pair",
] as const;

// accepted / amended / rejected rule proposals; merged / kept_both rule
// duplicate pairs. Rulings are final: a ruled row 409s any re-rule.
export const PENDING_DECISION_RULINGS = [
  "accepted",
  "amended",
  "rejected",
  "merged",
  "kept_both",
] as const;

export const pendingDecisions = sqliteTable(
  "pending_decisions",
  {
    id: text("id").primaryKey(),
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "restrict" }),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "restrict",
    }),
    kind: text("kind", { enum: [...PENDING_DECISION_KINDS] }).notNull(),
    payload: text("payload").notNull().default("{}"), // JSON
    sourceModule: text("source_module").notNull(),
    sourceRef: text("source_ref"),
    status: text("status", { enum: ["open", "ruled"] })
      .notNull()
      .default("open"),
    ruling: text("ruling", { enum: [...PENDING_DECISION_RULINGS] }),
    rulingNote: text("ruling_note"),
    resultId: text("result_id"),
    ruledBy: text("ruled_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    ruledAt: integer("ruled_at"),
    // Proposer identity (0071): null for pipeline filings, which speak
    // through a label-authored comment; set for human-filed proposals.
    filedByUserId: text("filed_by_user_id").references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_pending_decisions_queue").on(
      table.federationId,
      table.status,
      table.kind,
    ),
    // One decision row per duplicate pair (0073). Partial: proposals
    // reuse source_ref for non-unique provenance strings.
    uniqueIndex("idx_pending_decisions_pair_key")
      .on(table.federationId, table.sourceRef)
      .where(sql`kind = 'duplicate-pair' AND source_ref IS NOT NULL`),
  ]
);

// Decision threads live in `comments` (decision_id target) since
// migration 0071 folded the short-lived decision_comments table in --
// comments are one archival record class.

// ---------------------------------------------------------------------------
// Notification outbox (0074). Tier-1 email notifications never send
// inline: each event fans out one row per recipient at action time
// (snapshotting the recipient set -- the actor never gets a row, and
// neither does a recipient whose digest_frequency is 'off'), and the
// 15-minute cron sweep coalesces every pending row for a due recipient
// into one digest email. sent_at NULL = pending; the sweep sends via
// Resend first and marks after, so a failure between the two retries
// next tick (a rare double email is accepted over a silently lost
// one). decision_id is RESTRICT for the same reason comments' is: a
// decision carrying its case file is never hard-deleted.
// ---------------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  "decision_ruled",
  "decision_comment",
  "proposal_filed",
] as const;

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: [...NOTIFICATION_KINDS] }).notNull(),
    decisionId: text("decision_id")
      .notNull()
      .references(() => pendingDecisions.id, { onDelete: "restrict" }),
    // Who acted; null when the actor is an agency (a pipeline comment).
    actorUserId: text("actor_user_id").references(() => users.id),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [
    // The sweep's read: pending rows (sent_at NULL) grouped by
    // recipient.
    index("idx_notification_outbox_pending").on(table.userId, table.sentAt),
  ]
);

// ---------------------------------------------------------------------------
// External authority links (0076). What an outside vocabulary calls a
// record we already hold: one row per (record, scheme, external id).
//
// The registry sits BESIDE the authority record rather than inside it,
// because the columns entities/places already carry for this
// (wikidata_id, viaf_id, tgn_id) are one-per-scheme and cannot say who
// matched, on what evidence, or whether the match still holds. A row
// here names the maintaining agency's federation, the record, the
// scheme, the identifier the scheme issued, the label it carried at
// match time, and how the match was made.
//
// `scheme` is deliberately open text, not an enum: the set of
// vocabularies a partner reconciles against is a deployment fact, not a
// platform one, and a new scheme must not need a migration. The
// enumerated column is `matched_by`, which is about US — hand-picked by
// a cataloguer, confirmed off a reconciliation candidate, or carried in
// by an import.
//
// `decision_id` is the audit trail when the match was confirmed while
// ruling a proposal: RESTRICT, for the same reason comments' decision
// FK is — a decision carrying its case file is never hard-deleted.
// `status` lets a link be retired without losing the record of it, and
// `label_checked_at` stamps the last time the remote label was
// re-read, so drift can be found later. UNIQUE(record_type, record_id,
// scheme, external_id) makes a repeat confirmation a no-op.
// ---------------------------------------------------------------------------

export const EXTERNAL_LINK_RECORD_TYPES = [
  "entity",
  "place",
  "vocabulary_term",
] as const;

export const EXTERNAL_LINK_MATCHED_BY = [
  "hand-picked",
  "reconciled-confirmed",
  "import",
] as const;

export const EXTERNAL_LINK_STATUSES = [
  "active",
  "deprecated",
  "redirected",
] as const;

export const externalAuthorityLinks = sqliteTable(
  "external_authority_links",
  {
    id: text("id").primaryKey(),
    federationId: text("federation_id")
      .notNull()
      .references(() => federations.id, { onDelete: "restrict" }),
    recordType: text("record_type", {
      enum: [...EXTERNAL_LINK_RECORD_TYPES],
    }).notNull(),
    recordId: text("record_id").notNull(),
    // Open by design — see the note above.
    scheme: text("scheme").notNull(),
    externalId: text("external_id").notNull(),
    matchedLabel: text("matched_label").notNull(),
    matchedBy: text("matched_by", {
      enum: [...EXTERNAL_LINK_MATCHED_BY],
    }).notNull(),
    decisionId: text("decision_id").references(() => pendingDecisions.id, {
      onDelete: "restrict",
    }),
    status: text("status", { enum: [...EXTERNAL_LINK_STATUSES] })
      .notNull()
      .default("active"),
    labelCheckedAt: integer("label_checked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("eal_record_scheme_idx").on(
      table.recordType,
      table.recordId,
      table.scheme,
      table.externalId,
    ),
    index("eal_federation_scheme_idx").on(table.federationId, table.scheme),
  ]
);

// ---------------------------------------------------------------------------
// Carried scopes (0077). A search selection handed forward to the
// export surface: the records a person ticked (or the whole matching
// set they took), materialised as a list of ids at carry time.
//
// The set is stored, not the query. A carry is a promise about a fixed
// set of records — the export must produce what was ticked, not what
// the same question would answer later — and storing the query would
// also hand the export code a second copy of the search's scope rules
// to get wrong. "All matching" is therefore resolved to ids under the
// SAME scoped statement the results page ran, at the moment of the
// carry, and every consumer downstream reads a list.
//
// `constraint_summary` is display-only: the pills as they read on
// screen plus the faceted total, so the export page can say what the
// set was chosen under without re-deriving it. Nothing reads it back as
// structure.
//
// `record_type` speaks the search tabs' vocabulary ('records' for
// descriptions), because that is what the export page says to a person.
// member_ids carries no FK: it spans three tables, and a JSON array
// could not carry one — the polymorphic precedent is 0076's record_id.
//
// tenant_id + user_id are the whole of the read gate: the consuming
// query keys on both, so another person's scope is indistinguishable
// from one that never existed. tenant_id RESTRICTs like every tenant
// FK; user_id CASCADEs because an unconsumed selection is scratch state
// that should leave with the person who made it.
// ---------------------------------------------------------------------------

export const CARRIED_SCOPE_RECORD_TYPES = [
  "records",
  "entities",
  "places",
] as const;

export const carriedScopes = sqliteTable(
  "carried_scopes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recordType: text("record_type", {
      enum: [...CARRIED_SCOPE_RECORD_TYPES],
    }).notNull(),
    /** JSON, display-only: { pills: [{ label }], total }. */
    constraintSummary: text("constraint_summary").notNull().default("{}"),
    /** JSON array of the member ids, in the order the page showed them. */
    memberIds: text("member_ids").notNull().default("[]"),
    /** What the person was told they were taking (the faceted total). */
    total: integer("total").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Set by the export surface when the scope is spent; never here. */
    consumedAt: integer("consumed_at"),
  },
  (table) => [
    index("carried_scopes_owner_idx").on(
      table.tenantId,
      table.userId,
      table.createdAt,
    ),
  ]
);

// ---------------------------------------------------------------------------
// Handlists (0078). An ordered, named, persistent set of references a
// person keeps and works from — the archival term, and it carries the
// rule: a handlist is true of its material at the moment it was drawn
// up. It is a SNAPSHOT (it never grows on its own) and it REFERENCES
// rather than contains (removing a member touches no record).
//
// `record_type` speaks the search tabs' vocabulary ('records' for
// descriptions) and is what makes a handlist a coherent export scope. It
// is NULL until the first member arrives and immutable after — the app
// fixes it on that first add, so the column is nullable rather than
// carrying a placeholder.
//
// tenant_id RESTRICTs like every tenant FK. owner_id RESTRICTs too,
// deliberately: a person leaving must not take their colleagues' shared
// working sets with them, so the user delete is blocked until ownership
// is transferred. `workspace_visible` is the third visibility arm beside
// owner and share.
//
// handlist_members.member_id carries NO foreign key — it spans three
// tables (the 0076/0077 polymorphic precedent), and the absence is also
// semantic: a member deleted from the workspace stays as a tombstone,
// shown but uncounted for export, because a handlist may never lie about
// its count. `position` is explicit because the order is carried into
// the export; `created_at` is the arrival stamp the integrity read
// compares an authority split against. UNIQUE (handlist_id, member_id)
// is what makes a repeat add a no-op.
//
// handlist_shares: viewer reads, editor adds/removes/reorders; the owner
// alone renames, shares, deletes and transfers. Both FKs CASCADE — a
// share is meaningless once its handlist or its person is gone. Sharing
// conveys no module access and no export right.
// ---------------------------------------------------------------------------

export const HANDLIST_RECORD_TYPES = ["records", "entities", "places"] as const;

export const HANDLIST_SHARE_ROLES = ["viewer", "editor"] as const;

export const handlists = sqliteTable(
  "handlists",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    /** NULL until the first member fixes it; immutable afterwards. */
    recordType: text("record_type", { enum: [...HANDLIST_RECORD_TYPES] }),
    workspaceVisible: integer("workspace_visible", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("handlists_owner_idx").on(table.tenantId, table.ownerId)]
);

export const handlistMembers = sqliteTable(
  "handlist_members",
  {
    id: text("id").primaryKey(),
    handlistId: text("handlist_id")
      .notNull()
      .references(() => handlists.id, { onDelete: "cascade" }),
    /** A description, entity or place id — no FK; see the note above. */
    memberId: text("member_id").notNull(),
    position: integer("position").notNull(),
    addedBy: text("added_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("handlist_members_member_idx").on(
      table.handlistId,
      table.memberId,
    ),
    index("handlist_members_position_idx").on(table.handlistId, table.position),
  ]
);

export const handlistShares = sqliteTable(
  "handlist_shares",
  {
    id: text("id").primaryKey(),
    handlistId: text("handlist_id")
      .notNull()
      .references(() => handlists.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: [...HANDLIST_SHARE_ROLES] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("handlist_shares_user_idx").on(table.handlistId, table.userId),
  ]
);

// ---------------------------------------------------------------------------
// Workspace export runs (0079). The ledger behind the self-service
// export surface: one row per export a workspace took of its own
// records, recorded so the workspace can always say what left, in what
// shape, and when.
//
// This is NOT `export_runs`, which belongs to the publish pipeline: that
// table is federation-attributed, has no tenant scoping root, and is
// driven by a Cloudflare Workflow. A self-service export belongs to one
// workspace and one person and runs inside a request's waitUntil. The
// two lifecycles were kept apart rather than merged behind a `kind`
// column — see the 0079 migration header for the full reasoning.
//
// The three axes are recorded as they were chosen: `scope_kind` +
// `scope_descriptor` (what), `form` (the descriptive shape), `format`
// (the serialisation). `scope_descriptor` is the ledger row's OWN WORDS
// — a branch's code and title chain, a carried scope's pills and
// arithmetic, a handlist's id and name — and is never re-resolved, so
// renaming the branch or editing the handlist cannot rewrite history.
//
// `record_class` says what kind of thing the scope holds, in the search
// tabs' vocabulary. It reshapes both other axes (an authority scope has
// no descriptive-standard form and no finding aid), which is why the
// legality matrix keys on it. `include_authorities` is Not applicable
// for an authority scope and keeps its default there.
//
// Lifecycle: running → completed | failed | cancelled. `stage` is an
// unconstrained machine code for the dialog's working line (a new
// emitter may add stages without a migration); progress_done/total feed
// "800 of 1,204 records"; `failure` is JSON {code, detail} so the failed
// row can be rendered in the reader's language rather than replaying a
// stored English sentence. `r2_key` is nulled by the 30-day read-time
// sweep, which is what lets a history row outlive its own artifact.
// ---------------------------------------------------------------------------

export const WORKSPACE_EXPORT_SCOPE_KINDS = [
  "workspace",
  "branch",
  "carried",
  "handlist",
] as const;

export const WORKSPACE_EXPORT_RECORD_CLASSES = [
  "records",
  "entities",
  "places",
] as const;

export const WORKSPACE_EXPORT_FORMS = [
  "isadg",
  "dacs",
  "rad",
  "dc",
  "canonical",
] as const;

export const WORKSPACE_EXPORT_FORMATS = [
  "csv",
  "ead-xml",
  "json",
  "pdf",
] as const;

export const WORKSPACE_EXPORT_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const workspaceExportRuns = sqliteTable(
  "workspace_export_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    scopeKind: text("scope_kind", {
      enum: [...WORKSPACE_EXPORT_SCOPE_KINDS],
    }).notNull(),
    /** JSON, display + re-run provenance only: never re-resolved. */
    scopeDescriptor: text("scope_descriptor").notNull().default("{}"),
    recordClass: text("record_class", {
      enum: [...WORKSPACE_EXPORT_RECORD_CLASSES],
    }),
    includeAuthorities: integer("include_authorities", { mode: "boolean" })
      .notNull()
      .default(true),
    form: text("form", { enum: [...WORKSPACE_EXPORT_FORMS] }),
    format: text("format", { enum: [...WORKSPACE_EXPORT_FORMATS] }),
    status: text("status", { enum: [...WORKSPACE_EXPORT_STATUSES] })
      .notNull()
      .default("running"),
    /** Machine code for the working line; deliberately unconstrained. */
    stage: text("stage"),
    progressDone: integer("progress_done"),
    progressTotal: integer("progress_total"),
    countRecords: integer("count_records"),
    countEntities: integer("count_entities"),
    countPlaces: integer("count_places"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    /** Nulled by the 30-day sweep once the object is deleted. */
    r2Key: text("r2_key"),
    /** JSON {code, detail} — never a stored English sentence. */
    failure: text("failure"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("workspace_export_runs_tenant_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ]
);
