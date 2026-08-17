/**
 * Project Layout
 *
 * This layout is the shared frame for every project-scoped page: the
 * sidebar project selector, the secondary navigation pills (Overview,
 * Volumes, Members, Settings), and the project header. It loads the project
 * record once and passes it to children through the React Router
 * outlet context.
 *
 * The crowdsourcing capability gate lives here rather than on each
 * child: every `/projects/:id/*` page renders through this layout, so
 * one `requireCapability` call closes the whole subtree, and a child
 * added later inherits the gate instead of having to remember it.
 *
 * @version v0.7.0
 */

import { Outlet, NavLink, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext, tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { PROJECT_ROLES } from "../lib/validation/enums";
import type { Route } from "./+types/_auth.projects.$id";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { getProject } = await import("../lib/projects.server");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  requireCapability(tenant, "crowdsourcing");

  const project = await getProject(db, tenant.id, params.id);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  // Check membership (admin bypasses the role check, not the tenant scope)
  await requireProjectRole(db, tenant.id, user.id, params.id, [...PROJECT_ROLES], user.isAdmin);

  // Get user's specific role for conditional UI
  const membership = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, params.id),
        eq(projectMembers.userId, user.id)
      )
    )
    .get();

  return { project, user, userRole: membership?.role || null };
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { project, user, userRole } = loaderData;
  const isLead = userRole === "lead" || user.isAdmin;
  const { t } = useTranslation("project");

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `border-b-2 px-1 pb-2 text-sm font-medium ${
      isActive
        ? "border-stone-900 text-stone-900"
        : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
    }`;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-stone-500">
        <Link to="/admin/cataloguing/projects" className="hover:text-stone-700">
          {t("nav.all_projects")}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-stone-900">{project.name}</span>
      </nav>

      {/* Section navigation */}
      <div className="mb-6 flex gap-4 border-b border-stone-200">
        <NavLink to={`/projects/${project.id}/overview`} className={tabClass}>
          {t("tab.overview")}
        </NavLink>
        {isLead && (
          <NavLink to={`/projects/${project.id}/volumes`} className={tabClass}>
            {t("tab.volumes")}
          </NavLink>
        )}
        {isLead && (
          <NavLink to={`/projects/${project.id}/assignments`} className={tabClass}>
            {t("tab.assignments")}
          </NavLink>
        )}
        {isLead && (
          <NavLink to={`/projects/${project.id}/members`} className={tabClass}>
            {t("tab.users")}
          </NavLink>
        )}
        {isLead && (
          <NavLink to={`/projects/${project.id}/settings`} className={tabClass}>
            {t("tab.general_settings")}
          </NavLink>
        )}
      </div>

      <Outlet />
    </div>
  );
}
