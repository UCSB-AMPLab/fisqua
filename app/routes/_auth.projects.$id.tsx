import { Outlet, NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.projects.$id";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { getProject } = await import("../lib/projects.server");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const project = await getProject(db, params.id);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  // Check membership (admin bypasses)
  await requireProjectRole(db, user.id, params.id, ["lead", "cataloguer", "reviewer"], user.isAdmin);

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
  const canSeeVolumes = userRole === "lead" || user.isAdmin;
  const { t } = useTranslation("project");

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-stone-500">
        <a href="/dashboard" className="hover:text-stone-700">
          {t("dashboard:heading.dashboard", { defaultValue: "Inicio" })}
        </a>
        <span className="mx-2">/</span>
        <span className="text-stone-900">{project.name}</span>
      </nav>

      {/* Section navigation */}
      <div className="mb-6 flex gap-4 border-b border-stone-200">
        <NavLink
          to={`/projects/${project.id}/settings`}
          className={({ isActive }) =>
            `border-b-2 px-1 pb-2 text-sm font-medium ${
              isActive
                ? "border-stone-900 text-stone-900"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
            }`
          }
        >
          {t("tab.settings")}
        </NavLink>
        <NavLink
          to={`/projects/${project.id}/members`}
          className={({ isActive }) =>
            `border-b-2 px-1 pb-2 text-sm font-medium ${
              isActive
                ? "border-stone-900 text-stone-900"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
            }`
          }
        >
          {t("tab.members")}
        </NavLink>
        {canSeeVolumes && (
          <NavLink
            to={`/projects/${project.id}/volumes`}
            className={({ isActive }) =>
              `border-b-2 px-1 pb-2 text-sm font-medium ${
                isActive
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
              }`
            }
          >
            {t("tab.volumes")}
          </NavLink>
        )}
        {canSeeVolumes && (
          <NavLink
            to={`/projects/${project.id}/assignments`}
            className={({ isActive }) =>
              `border-b-2 px-1 pb-2 text-sm font-medium ${
                isActive
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
              }`
            }
          >
            {t("tab.assignments")}
          </NavLink>
        )}
      </div>

      <Outlet />
    </div>
  );
}
