import { Outlet, NavLink } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { userContext } from "../context";
import { getProject } from "../lib/projects.server";
import { requireProjectRole } from "../lib/permissions.server";
import { projectMembers } from "../db/schema";
import type { Route } from "./+types/_auth.projects.$id";

export async function loader({ params, context }: Route.LoaderArgs) {
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

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-stone-500">
        <a href="/dashboard" className="hover:text-stone-700">
          Dashboard
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
          Settings
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
          Members
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
            Volumes
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
            Assignments
          </NavLink>
        )}
      </div>

      <Outlet />
    </div>
  );
}
