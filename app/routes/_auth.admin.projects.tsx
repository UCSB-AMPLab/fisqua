import { Form, Link, useActionData, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { formatDate } from "~/lib/format";
import type { Route } from "./+types/_auth.admin.projects";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, desc, isNull, isNotNull } = await import("drizzle-orm");
  const { requireAdmin } = await import("../lib/permissions.server");
  const {
    projects,
    projectMembers,
    users,
  } = await import("../db/schema");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const url = new URL(request.url);
  const showArchived = url.searchParams.get("archived") === "true";

  // Get active or archived projects
  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(showArchived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt))
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

      const uniqueMembers = new Set(members.map((m) => m.userId));
      const memberCount = uniqueMembers.size;

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

  return { projects: projectDetails, showArchived };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireAdmin } = await import("../lib/permissions.server");
  const { getInstance } = await import("~/middleware/i18next");
  const {
    projects,
    projectMembers,
    projectInvites,
    volumes,
    volumePages,
    entries,
    activityLog,
  } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  requireAdmin(user);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;
  const projectId = formData.get("projectId") as string;

  if (!projectId) {
    return { ok: false, error: i18n.t("admin:error.missing_project_id") };
  }

  if (intent === "archiveProject") {
    await db
      .update(projects)
      .set({ archivedAt: Date.now() })
      .where(eq(projects.id, projectId));

    return { ok: true, message: i18n.t("admin:error.project_archived") };
  }

  if (intent === "unarchiveProject") {
    await db
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, projectId));

    return { ok: true, message: i18n.t("admin:error.project_restored") };
  }

  if (intent === "deleteProject") {
    // Cascade delete in dependency order
    const projectVolumes = await db
      .select({ id: volumes.id })
      .from(volumes)
      .where(eq(volumes.projectId, projectId))
      .all();
    const volumeIds = projectVolumes.map((v) => v.id);

    for (const volId of volumeIds) {
      await db.delete(entries).where(eq(entries.volumeId, volId));
      await db.delete(volumePages).where(eq(volumePages.volumeId, volId));
    }

    await db.delete(volumes).where(eq(volumes.projectId, projectId));
    await db.delete(activityLog).where(eq(activityLog.projectId, projectId));
    await db
      .delete(projectInvites)
      .where(eq(projectInvites.projectId, projectId));
    await db
      .delete(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));

    return { ok: true, message: i18n.t("admin:error.project_deleted") };
  }

  return { ok: false, error: i18n.t("admin:error.unknown_action") };
}

export default function AdminProjects({ loaderData }: Route.ComponentProps) {
  const { projects: allProjects, showArchived } = loaderData;
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation(["admin", "common"]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
            {showArchived ? t("admin:heading.archived_projects") : t("admin:heading.all_projects")}
          </h2>
          <Link
            to={showArchived ? "/admin/projects" : "/admin/projects?archived=true"}
            className="font-sans text-xs text-[#78716C] hover:text-[#44403C]"
          >
            {showArchived ? t("admin:action.show_active") : t("admin:action.show_archived")}
          </Link>
        </div>
        {!showArchived && (
          <Link
            to="/projects/new"
            className="rounded-lg bg-[#8B2942] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#7a2439]"
          >
            {t("admin:action.new_project")}
          </Link>
        )}
      </div>

      {actionData?.message && (
        <div
          className={`mt-3 rounded-lg border px-4 py-3 font-sans text-sm ${actionData.ok ? "border-[#2F6B45] bg-[#D6E8DB] text-[#44403C]" : "border-[#8B2942] bg-[#F5E6EA] text-[#44403C]"}`}
        >
          {actionData.message}
        </div>
      )}
      {actionData && !actionData.ok && actionData.error && (
        <div className="mt-3 rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 font-sans text-sm text-[#44403C]">
          {actionData.error}
        </div>
      )}

      {allProjects.length === 0 ? (
        <p className="mt-4 font-sans text-sm text-[#A8A29E]">
          {showArchived
            ? t("admin:empty.no_archived")
            : t("admin:empty.no_projects")}
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E5E4]">
          <table className="min-w-full divide-y divide-[#E7E5E4]">
            <thead className="bg-[#FAFAF9]">
              <tr>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("admin:table.project")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("admin:table.lead")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("admin:table.members")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {showArchived ? t("admin:table.archived") : t("admin:table.created")}
                </th>
                <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("admin:table.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {allProjects.map((project) => (
                <tr key={project.id}>
                  <td className="px-4 py-3">
                    <Link
                      to={`/projects/${project.id}`}
                      className="font-serif text-sm font-semibold text-[#44403C] hover:underline"
                    >
                      {project.name}
                    </Link>
                    {project.description && (
                      <p className="mt-0.5 max-w-xs truncate font-sans text-xs text-[#A8A29E]">
                        {project.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-sans text-sm text-[#78716C]">
                    {project.leads.length > 0
                      ? project.leads.join(", ")
                      : "\u2014"}
                  </td>
                  <td className="px-4 py-3 font-sans text-sm text-[#78716C]">
                    {project.memberCount}
                  </td>
                  <td className="px-4 py-3 font-sans text-xs text-[#A8A29E]">
                    {formatDate(
                      showArchived && project.archivedAt
                        ? project.archivedAt
                        : project.createdAt
                    )}
                  </td>
                  <td className="px-4 py-3 space-x-3 text-right">
                    {showArchived ? (
                      <>
                        <Form method="post" className="inline">
                          <input type="hidden" name="_action" value="unarchiveProject" />
                          <input type="hidden" name="projectId" value={project.id} />
                          <button
                            type="submit"
                            className="font-sans text-xs text-[#78716C] hover:text-[#44403C]"
                          >
                            {t("admin:action.restore")}
                          </button>
                        </Form>
                        <Form method="post" className="inline">
                          <input type="hidden" name="_action" value="deleteProject" />
                          <input type="hidden" name="projectId" value={project.id} />
                          <button
                            type="submit"
                            className="font-sans text-xs text-[#8B2942] hover:underline"
                            onClick={(e) => {
                              if (
                                !confirm(
                                  t("admin:error.delete_confirm", { name: project.name })
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            {t("common:button.delete")}
                          </button>
                        </Form>
                      </>
                    ) : (
                      <Form method="post" className="inline">
                        <input type="hidden" name="_action" value="archiveProject" />
                        <input type="hidden" name="projectId" value={project.id} />
                        <button
                          type="submit"
                          className="font-sans text-xs text-[#78716C] hover:text-[#44403C]"
                        >
                          {t("admin:action.archive")}
                        </button>
                      </Form>
                    )}
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
