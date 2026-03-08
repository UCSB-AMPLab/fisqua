import { Outlet, NavLink } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { getProject } from "../lib/projects.server";
import { requireProjectRole } from "../lib/permissions.server";
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

  return { project, user };
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { project } = loaderData;

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
        <NavLink
          to={`/projects/${project.id}/items`}
          className={({ isActive }) =>
            `border-b-2 px-1 pb-2 text-sm font-medium ${
              isActive
                ? "border-stone-900 text-stone-900"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
            }`
          }
        >
          Items
        </NavLink>
      </div>

      <Outlet />
    </div>
  );
}
