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
  route("auth/logout", "routes/auth.logout.tsx"),
  route("invite/accept", "routes/invite.accept.tsx"),

  // Authenticated routes
  layout("routes/_auth.tsx", [
    index("routes/home.tsx"),
    route("dashboard", "routes/_auth.dashboard.tsx"),
    route("projects/new", "routes/_auth.projects.new.tsx"),
    layout("routes/_auth.projects.$id.tsx", [
      { path: "projects/:id", file: "routes/_auth.projects.$id._index.tsx" },
      route("projects/:id/settings", "routes/_auth.projects.$id.settings.tsx"),
      route("projects/:id/members", "routes/_auth.projects.$id.members.tsx"),
      // --- EXTENSION POINT --- add your domain-specific routes below
      route("projects/:id/volumes", "routes/_auth.projects.$id.volumes.tsx"),
      route("projects/:id/assignments", "routes/_auth.projects.$id.assignments.tsx"),
    ]),

    // User activity page -- under _auth, outside project layout
    route(
      "users/:userId/activity",
      "routes/_auth.users.$userId.activity.tsx"
    ),

    // Viewer route -- under _auth for auth, but outside project layout (full-page)
    route(
      "projects/:projectId/volumes/:volumeId",
      "routes/_auth.viewer.$projectId.$volumeId.tsx"
    ),

    // API routes
    route("api/entries/save", "routes/api.entries.save.tsx"),
    route("api/workflow", "routes/api.workflow.tsx"),
    route("api/description/save", "routes/api.description.save.tsx"),
    route("api/comments", "routes/api.comments.tsx"),
    route("api/resegmentation", "routes/api.resegmentation.tsx"),

    // Admin routes
    layout("routes/_auth.admin.tsx", [
      route("admin/users", "routes/_auth.admin.users.tsx"),
      route("admin/projects", "routes/_auth.admin.projects.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
