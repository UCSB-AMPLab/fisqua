/**
 * Route Manifest
 *
 * The single source of truth for every URL the app answers. React Router
 * reads this file at build time to generate the type-safe route table,
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
 * only, gated in their own loaders.
 *
 * API endpoints live under `/api/*` and are also mounted inside the
 * auth layout so they inherit the same authentication and context. The
 * viewer and description editor routes break out of the chrome via a
 * path check in `_auth.tsx`.
 *
 * @version v0.3.0
 */

import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // Public routes
  route("login", "routes/login.tsx"),
  route("auth/verify", "routes/auth.verify.tsx"),
  route("auth/github", "routes/auth.github.tsx"),
  route("auth/github/callback", "routes/auth.github.callback.tsx"),
  route("auth/logout", "routes/auth.logout.tsx"),
  route("invite/accept", "routes/invite.accept.tsx"),

  // Authenticated routes
  layout("routes/_auth.tsx", [
    index("routes/_auth._index.tsx"),
    route("dashboard", "routes/_auth.dashboard.tsx"),
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
    route("admin/entities/:id", "routes/_auth.admin.entities.$id.tsx"),
    route("admin/places", "routes/_auth.admin.places.tsx"),
    route("admin/places/new", "routes/_auth.admin.places.new.tsx"),
    route("admin/places/:id", "routes/_auth.admin.places.$id.tsx"),
    route("admin/repositories", "routes/_auth.admin.repositories.tsx"),
    route("admin/repositories/new", "routes/_auth.admin.repositories.new.tsx"),
    route("admin/repositories/:id", "routes/_auth.admin.repositories.$id.tsx"),
    route("admin/publish", "routes/_auth.admin.publish.tsx"),
    route("admin/publish/runs/:exportId", "routes/_auth.admin.publish.runs.$exportId.tsx"),
    route("admin/promote", "routes/_auth.admin.promote.tsx"),

    // Vocabulary management
    layout("routes/_auth.admin.vocabularies.tsx", [
      { path: "admin/vocabularies", file: "routes/_auth.admin.vocabularies._index.tsx" },
      route("admin/vocabularies/functions", "routes/_auth.admin.vocabularies.functions.tsx"),
      route("admin/vocabularies/functions/:id", "routes/_auth.admin.vocabularies.functions.$id.tsx"),
      route("admin/vocabularies/enums", "routes/_auth.admin.vocabularies.enums.tsx"),
      route("admin/vocabularies/review", "routes/_auth.admin.vocabularies.review.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
