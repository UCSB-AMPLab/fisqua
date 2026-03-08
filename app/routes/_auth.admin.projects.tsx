import { Link } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { projects, projectMembers, users } from "../db/schema";
import type { Route } from "./+types/_auth.admin.projects";

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Get all projects
  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt))
    .all();

  // Get member counts and leads for each project
  const projectDetails = await Promise.all(
    allProjects.map(async (project) => {
      const members = await db
        .select({
          userId: projectMembers.userId,
          role: projectMembers.role,
          userName: users.name,
          userEmail: users.email,
        })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.id))
        .where(eq(projectMembers.projectId, project.id))
        .all();

      // Count unique members
      const uniqueMembers = new Set(members.map((m) => m.userId));
      const memberCount = uniqueMembers.size;

      // Get lead names
      const leads = members
        .filter((m) => m.role === "lead")
        .map((m) => m.userName || m.userEmail);

      return {
        ...project,
        memberCount,
        leads,
      };
    })
  );

  return { projects: projectDetails };
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function AdminProjects({ loaderData }: Route.ComponentProps) {
  const { projects: allProjects } = loaderData;

  return (
    <div>
      <h2 className="text-lg font-medium text-stone-900">All projects</h2>

      {allProjects.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">No projects yet.</p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
          <table className="min-w-full divide-y divide-stone-200">
            <thead className="bg-stone-50">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                  Project
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                  Lead(s)
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                  Members
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {allProjects.map((project) => (
                <tr key={project.id}>
                  <td className="px-4 py-3">
                    <Link
                      to={`/projects/${project.id}`}
                      className="text-sm font-medium text-stone-900 hover:underline"
                    >
                      {project.name}
                    </Link>
                    {project.description && (
                      <p className="mt-0.5 text-xs text-stone-400 truncate max-w-xs">
                        {project.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone-500">
                    {project.leads.length > 0
                      ? project.leads.join(", ")
                      : "\u2014"}
                  </td>
                  <td className="px-4 py-3 text-sm text-stone-500">
                    {project.memberCount}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-400">
                    {formatDate(project.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
