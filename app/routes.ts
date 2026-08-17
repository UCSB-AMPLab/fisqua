/**
 * Route Manifest
 *
 * This file deals with the single source of truth for every URL the
 * app answers. React Router reads this file at build time to generate
 * the type-safe route table,
 * the server-side loader manifest, and the client-side code-split
 * bundles. Anything that should be reachable over HTTP has to be listed
 * here; anything not listed is a hard 404.
 *
 * The layout is three concentric bands. Public routes at the top handle
 * sign-in and the OAuth dance without requiring a user. Everything else
 * nests inside the `_auth.tsx` layout, which runs the auth middleware
 * and provides the user context. Inside `_auth`, project workspace
 * routes nest further inside `_auth.projects.$id.tsx` so project
 * membership can be verified once per request rather than in every
 * child loader.
 *
 * The admin surfaces live alongside the project routes but under their
 * own URL prefixes: `/admin/cataloguing/*` groups collaborative
 * cataloguing management (projects, team, promote, users), while
 * `/admin/descriptions`, `/admin/entities`, `/admin/places`,
 * `/admin/repositories`, and `/admin/vocabularies` host the archival
 * records admin. `/admin/publish` and `/admin/promote` are superadmin
 * only, gated in their own loaders. `/admin/decisions/*` is the
 * cross-module Pending decisions surface; each of its tabs keeps the
 * capability gate the page carried before it moved there.
 *
 * `/search` is the odd one out: a bare tenant-level path that reads
 * across three admin modules at once. It sits with the other non-admin
 * routes because that is where its nav item lives, and it earns the
 * reach in its own loader — the admin guard plus the `authorities`
 * capability check, so a search never returns a row its viewer could
 * not open directly.
 *
 * `/handlists` is the second tenant-level path of that kind, and it
 * earns its reach differently: a handlist belongs to a person rather
 * than to a module, so there is no guard on the routes at all. What
 * a person may see is decided per handlist inside
 * `handlists.server` — owner, sharee or workspace-visible, plus the
 * admin gate an entities- or places-typed one inherits from the
 * surfaces it points at. `/handlists/add` under the same prefix is an
 * action-only resource route with no UI of its own.
 *
 * `/admin/exports` is the third path that breaks the admin-prefix
 * pattern, and it breaks it deliberately. Getting your own records out
 * is not a privilege the platform grants, so the surface carries no
 * guard at all; what a role changes is which formats the page offers,
 * which is decided inside the page and re-checked server-side when a
 * run starts and when an artifact is downloaded. It keeps the
 * `/admin/` prefix because it sits beside Imports in the sidebar and
 * acts on the workspace as a whole, not because it is admin-gated.
 *
 * API endpoints live under `/api/*` and are also mounted inside the
 * auth layout so they inherit the same authentication and context. The
 * viewer and description editor routes break out of the chrome via a
 * path check in `_auth.tsx`.
 *
 * The `_operator` layout is a SIBLING of `_auth`, not a child: the
 * operator surface runs on the platform host with its own gate
 * (`operatorAuthMiddleware` calling `assertOperator(tenant)`) and its
 * own thin top-bar chrome. Nesting under `_auth` would leak the staff
 * sidebar + the cross-tenant default-deny logic into the operator UI;
 * siblinging keeps the two surfaces structurally distinct. The route
 * prefix `/operator/*` is only reachable on the platform host because
 * `OPERATOR_ROUTE_PREFIXES` includes `/operator`; the same path on a
 * tenant subdomain falls through to React Router's no-match 404
 * because no `/operator/*` route is registered on `_auth`.
 *
 * @version v0.7.0
 */

import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // Marketing landing + workspace picker (apex)
  index("routes/_index.tsx"),

  // Public routes
  route("login", "routes/login.tsx"),
  route("auth/verify", "routes/auth.verify.tsx"),
  route("auth/github", "routes/auth.github.tsx"),
  route("auth/github/callback", "routes/auth.github.callback.tsx"),
  route("auth/github/handoff", "routes/auth.github.handoff.tsx"),
  route("auth/logout", "routes/auth.logout.tsx"),
  // Interstitial shown when a user lands on a tenant subdomain that
  // doesn't match their account's tenant. Public route, no auth
  // middleware: the callers (auth.verify, auth.github.handoff,
  // authMiddleware) 302 here with ?home=<home-slug> after clearing or
  // refusing to mint the wrong-tenant session.
  route("wrong-workspace", "routes/wrong-workspace.tsx"),
  // Tenant-subdomain handoff for operator login-as.
  route("handoff/impersonation", "routes/handoff.impersonation.tsx"),
  // Clears the impersonating envelope. Top-level
  // (NOT under `_auth`) so the cleanup is reachable both with AND
  // without an active envelope; nesting under `_auth` would route the
  // request through `requireTenantUser`'s default-deny and 403 a stale
  // banner-driven POST.
  route("end-impersonation", "routes/end-impersonation.tsx"),
  route("invite/accept", "routes/invite.accept.tsx"),

  // Authenticated routes
  layout("routes/_auth.tsx", [
    route("dashboard", "routes/_auth.dashboard.tsx"),
    // Global search — one query over records, entities, and places.
    // A tenant route rather than an admin one by URL, but its loader
    // carries the admin guard its three destination surfaces carry.
    route("search", "routes/_auth.search.tsx"),
    // Handlists — the working sets a person keeps. Tenant-level paths
    // rather than admin ones, for the same reason `/search` is: the
    // nav item sits at the top level beside Home, because a handlist
    // belongs to a person rather than to a module and can hold
    // records, entities OR places. Unlike search there is no admin
    // guard on the loaders: the gate an authority-typed handlist takes
    // is the one `handlists.server` applies to the handlist itself, so
    // the index lists everything this person may reach and the detail
    // page renders the refusal in place rather than 403ing the URL.
    //
    // `/handlists/add` is an action-only resource route — the add-to-
    // handlist picker posts to it from search and from record detail
    // pages. The literal segment outranks `:id`, so a handlist can
    // never be shadowed by it.
    route("handlists", "routes/_auth.handlists.tsx"),
    route("handlists/add", "routes/_auth.handlists.add.tsx"),
    route("handlists/:id", "routes/_auth.handlists.$id.tsx"),
    route("proyectos", "routes/_auth.proyectos.tsx"),
    route("no-access", "routes/_auth.no-access.tsx"),
    route("configuracion", "routes/_auth.configuracion.tsx"),
    route("projects/new", "routes/_auth.projects.new.tsx"),
    layout("routes/_auth.projects.$id.tsx", [
      { path: "projects/:id", file: "routes/_auth.projects.$id._index.tsx" },
      route("projects/:id/overview", "routes/_auth.projects.$id.overview.tsx"),
      route("projects/:id/settings", "routes/_auth.projects.$id.settings.tsx"),
      route("projects/:id/members", "routes/_auth.projects.$id.members.tsx"),
      // --- EXTENSION POINT --- add your domain-specific routes below
      route("projects/:id/volumes", "routes/_auth.projects.$id.volumes.tsx"),
      route("projects/:id/volumes/:volumeId/manage", "routes/_auth.projects.$id.volumes.$volumeId.manage.tsx"),
      route("projects/:id/assignments", "routes/_auth.projects.$id.assignments.tsx"),
      route("projects/:id/assignments/description/:volumeId", "routes/_auth.projects.$id.assignments.description.$volumeId.tsx"),
    ]),

    // User activity page — under _auth, outside project layout
    route(
      "users/:userId/activity",
      "routes/_auth.users.$userId.activity.tsx"
    ),

    // Viewer route — full-page, chrome is hidden by `_auth.tsx`
    route(
      "projects/:projectId/volumes/:volumeId",
      "routes/_auth.viewer.$projectId.$volumeId.tsx"
    ),

    // Description editor — full-page, chrome is hidden by `_auth.tsx`
    route(
      "projects/:projectId/describe/:entryId",
      "routes/_auth.description.$projectId.$entryId.tsx"
    ),

    // API routes
    route("api/entries/save", "routes/api.entries.save.tsx"),
    route("api/workflow", "routes/api.workflow.tsx"),
    route("api/description/save", "routes/api.description.save.tsx"),
    route("api/comments", "routes/api.comments.tsx"),
    route("api/comments/:id", "routes/api.comments.$id.tsx"),
    route("api/comments/:id/resolve", "routes/api.comments.$id.resolve.tsx"),
    route("api/resegmentation", "routes/api.resegmentation.tsx"),
    route("api/qc-flags", "routes/api.qc-flags.tsx"),
    route("api/publish", "routes/api.publish.tsx"),

    // Admin routes — unified cataloguing admin panel
    layout("routes/_auth.admin.cataloguing.tsx", [
      { path: "admin/cataloguing", file: "routes/_auth.admin.cataloguing._index.tsx" },
      route("admin/cataloguing/projects", "routes/_auth.admin.cataloguing.projects.tsx"),
      route("admin/cataloguing/team", "routes/_auth.admin.cataloguing.team.tsx"),
      route("admin/cataloguing/promote", "routes/_auth.admin.cataloguing.promote.tsx"),
      route("admin/cataloguing/users", "routes/_auth.admin.cataloguing.users.tsx"),
    ]),

    // System users (superadmin only, outside cataloguing layout)
    route("admin/users", "routes/_auth.admin.users.tsx"),
    route("admin/users/:id", "routes/_auth.admin.users.$id.tsx"),
    route("admin/descriptions", "routes/_auth.admin.descriptions.tsx"),
    route("admin/descriptions/new", "routes/_auth.admin.descriptions.new.tsx"),
    route("admin/descriptions/:id", "routes/_auth.admin.descriptions.$id.tsx"),
    route("admin/descriptions/api/children/:parentId", "routes/_auth.admin.descriptions.api.children.$parentId.tsx"),
    route("admin/entities", "routes/_auth.admin.entities.tsx"),
    route("admin/entities/new", "routes/_auth.admin.entities.new.tsx"),
    route("admin/entities/duplicates", "routes/_auth.admin.entities.duplicates.tsx"),
    route("admin/entities/:id", "routes/_auth.admin.entities.$id.tsx"),
    route("admin/entities/:id/merge", "routes/_auth.admin.entities.$id.merge.tsx"),
    route("admin/entities/:id/split", "routes/_auth.admin.entities.$id.split.tsx"),
    route("admin/entities/:id/history", "routes/_auth.admin.entities.$id.history.tsx"),
    route("admin/places", "routes/_auth.admin.places.tsx"),
    route("admin/places/new", "routes/_auth.admin.places.new.tsx"),
    route("admin/places/duplicates", "routes/_auth.admin.places.duplicates.tsx"),
    route("admin/places/:id", "routes/_auth.admin.places.$id.tsx"),
    route("admin/places/:id/merge", "routes/_auth.admin.places.$id.merge.tsx"),
    route("admin/places/:id/split", "routes/_auth.admin.places.$id.split.tsx"),
    route("admin/places/:id/history", "routes/_auth.admin.places.$id.history.tsx"),
    route("admin/repositories", "routes/_auth.admin.repositories.tsx"),
    route("admin/repositories/new", "routes/_auth.admin.repositories.new.tsx"),
    route("admin/repositories/:id", "routes/_auth.admin.repositories.$id.tsx"),
    route("admin/publish", "routes/_auth.admin.publish.tsx"),
    route("admin/publish/runs/:exportId", "routes/_auth.admin.publish.runs.$exportId.tsx"),
    route("admin/promote", "routes/_auth.admin.promote.tsx"),
    route("admin/imports", "routes/_auth.admin.imports.tsx"),
    route("admin/imports/template", "routes/_auth.admin.imports.template.tsx"),
    route(
      "admin/imports/profiles/:profileId",
      "routes/_auth.admin.imports.profiles.$profileId.tsx",
    ),
    route(
      "admin/imports/uploads/:uploadId",
      "routes/_auth.admin.imports.uploads.$uploadId.tsx",
    ),
    route(
      "admin/imports/uploads/:uploadId/download/:kind",
      "routes/_auth.admin.imports.uploads.$uploadId.download.$kind.tsx",
    ),
    route("admin/imports/runs", "routes/_auth.admin.imports.runs.tsx"),
    route(
      "admin/imports/runs/:runId",
      "routes/_auth.admin.imports.runs.$runId.tsx",
    ),
    route(
      "admin/imports/runs/:runId/report",
      "routes/_auth.admin.imports.runs.$runId.report.tsx",
    ),

    // Exports — the self-service surface, and the three ways an
    // artifact or a run is reached from it. Unlike every other
    // `/admin/*` path here, the surface carries NO admin guard: the
    // permission tier decides what the page offers (the PDF finding
    // aid for any member, the machine-readable formats for admins),
    // not whether the page may be opened. Its loader and action are
    // member-level for the same reason, and the tier is applied
    // server-side inside `startExportRun` and again on the download.
    //
    // The literal segments outrank one another in the order they are
    // written, and none of the three collides: `download`, `runs` and
    // `aid` are all fixed words followed by a run id.
    route("admin/exports", "routes/_auth.admin.exports.tsx"),
    route(
      "admin/exports/download/:runId",
      "routes/_auth.admin.exports.download.$runId.tsx",
    ),
    // Polled by the dialog and by an in-progress history row. A
    // resource route rather than a reload of the surface, whose loader
    // resolves a scope and sweeps the retention window.
    route(
      "admin/exports/runs/:runId",
      "routes/_auth.admin.exports.runs.$runId.tsx",
    ),
    // The stored, rendered finding aid — served as HTML in a new tab
    // rather than downloaded, which is why "Open again" and not
    // "Download" is what history offers for a PDF run.
    route(
      "admin/exports/aid/:runId",
      "routes/_auth.admin.exports.aid.$runId.tsx",
    ),
    // The browse surfaces' half of "Send to export": a list stashes
    // the ids it holds and lands on the same carried tile the search
    // page's own carry lands on. Action-only.
    route("admin/exports/carry", "routes/_auth.admin.exports.carry.tsx"),

    // Pending decisions — the questions the workspace has not
    // answered yet, gathered from three modules into one surface:
    // authority proposals, the possible-duplicates worklist, and the
    // vocabulary review queue. The old addresses of the latter two
    // (`admin/entities/duplicates`, `admin/places/duplicates`,
    // `admin/vocabularies/review`) stay registered as redirects.
    layout("routes/_auth.admin.decisions.tsx", [
      { path: "admin/decisions", file: "routes/_auth.admin.decisions._index.tsx" },
      route("admin/decisions/duplicates", "routes/_auth.admin.decisions.duplicates.tsx"),
      route("admin/decisions/vocabulary", "routes/_auth.admin.decisions.vocabulary.tsx"),
    ]),
    // The proposal detail page sits OUTSIDE the tab layout on purpose:
    // it is the considered, full-screen lane, not a fourth tab. The
    // literal tab segments above win the match over `:id`.
    //
    // The pair collation page ("Look closer") is the same lane for a
    // duplicate pair, and is likewise a static segment that outranks
    // `:id`. It addresses its pair by query string (`?type=&a=&b=`)
    // rather than by path, because a pair has two ids and no id of its
    // own until someone comments on it or rules it.
    route(
      "admin/decisions/pair",
      "routes/_auth.admin.decisions.pair.tsx",
    ),
    route("admin/decisions/:id", "routes/_auth.admin.decisions.$id.tsx"),

    // Vocabulary management
    layout("routes/_auth.admin.vocabularies.tsx", [
      { path: "admin/vocabularies", file: "routes/_auth.admin.vocabularies._index.tsx" },
      route("admin/vocabularies/functions", "routes/_auth.admin.vocabularies.functions.tsx"),
      route("admin/vocabularies/functions/:id", "routes/_auth.admin.vocabularies.functions.$id.tsx"),
      route("admin/vocabularies/enums", "routes/_auth.admin.vocabularies.enums.tsx"),
      route("admin/vocabularies/review", "routes/_auth.admin.vocabularies.review.tsx"),
    ]),
  ]),

  // Operator surface — platform-host-only top-level layout.
  // Sibling of `_auth`; gated by `operatorAuthMiddleware`. The bare
  // `operator` prefix redirects to the tenant list -- without it the
  // prefix has no route of its own and falls through to a no-match.
  layout("routes/_operator.tsx", [
    { path: "operator", file: "routes/_operator._index.tsx" },
    { path: "operator/tenants", file: "routes/_operator.tenants._index.tsx" },
    { path: "operator/tenants/new", file: "routes/_operator.tenants.new.tsx" },
    { path: "operator/tenants/:slug", file: "routes/_operator.tenants.$slug.tsx" },
    { path: "operator/tenants/:slug/login-as", file: "routes/_operator.tenants.$slug.login-as.tsx" },
  ]),
] satisfies RouteConfig;
