import { Link } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { getUserProjects } from "../lib/projects.server";
import type { Route } from "./+types/_auth.dashboard";

export function meta() {
  return [
    { title: "Dashboard" },
    { name: "description", content: "Project dashboard" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const projects = await getUserProjects(db, user.id, user.isAdmin);

  return { user, projects };
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, projects } = loaderData;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-stone-900">Projects</h1>
        {user.isAdmin && (
          <Link
            to="/projects/new"
            className="rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            New project
          </Link>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-sm text-stone-500">No projects yet.</p>
          {user.isAdmin && (
            <Link
              to="/projects/new"
              className="mt-2 inline-block text-sm font-medium text-stone-700 underline hover:text-stone-900"
            >
              Create your first project
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className="block rounded-lg border border-stone-200 p-4 hover:border-stone-300 hover:shadow-sm"
            >
              <h2 className="font-medium text-stone-900">{project.name}</h2>
              {project.description && (
                <p className="mt-1 text-sm text-stone-500">
                  {project.description}
                </p>
              )}
              <div className="mt-3 flex items-center justify-between">
                <div className="flex gap-1">
                  {project.roles.map((role) => (
                    <span
                      key={role}
                      className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600"
                    >
                      {role}
                    </span>
                  ))}
                </div>
                <span className="text-xs text-stone-400">
                  {formatDate(project.updatedAt)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
