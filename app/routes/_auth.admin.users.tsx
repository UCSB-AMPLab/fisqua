/**
 * User Admin — List
 *
 * Superadmin-only directory of every user in the system with filter
 * chips for role flags and a search box for name or email. Each row
 * deep-links to the user detail page for edits.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { formatDate } from "../lib/format";
import type { Route } from "./+types/_auth.admin.users";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { asc, eq } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");

  const user = context.get(userContext);
  if (!user.isSuperAdmin && !user.isUserManager) {
    throw new Response("Forbidden", { status: 403 });
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const allUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
      isSuperAdmin: users.isSuperAdmin,
      isCollabAdmin: users.isCollabAdmin,
      isArchiveUser: users.isArchiveUser,
      isUserManager: users.isUserManager,
      isCataloguer: users.isCataloguer,
      lastActiveAt: users.lastActiveAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.name))
    .all();

  // Count project memberships per user
  const allMemberships = await db
    .select({
      userId: projectMembers.userId,
      projectName: projects.name,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .all();

  const membershipsByUser = new Map<string, { projectName: string; role: string }[]>();
  for (const m of allMemberships) {
    const list = membershipsByUser.get(m.userId) || [];
    list.push({ projectName: m.projectName, role: m.role });
    membershipsByUser.set(m.userId, list);
  }

  const usersWithProjects = allUsers.map((u) => ({
    ...u,
    projects: membershipsByUser.get(u.id) || [],
  }));

  return { users: usersWithProjects };
}

// ---------------------------------------------------------------------------
// Action — invite user only (role management moved to detail page)
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");

  const user = context.get(userContext);
  if (!user.isSuperAdmin && !user.isUserManager) {
    throw new Response("Forbidden", { status: 403 });
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "inviteUser") {
    const { handleUsersAction } = await import(
      "./_auth.admin.cataloguing.users.action.server"
    );
    const i18n = await import("i18next");
    const origin = new URL(request.url).origin;
    return handleUsersAction(user, db, formData, env, i18n, origin);
  }

  return { ok: false, error: "Unknown action" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RoleKey =
  | "super_admin"
  | "user_manager"
  | "cataloguing_admin"
  | "cataloguer"
  | "records_admin"
  | "archive_user";

function roleSummary(u: {
  isAdmin: number | boolean;
  isSuperAdmin: number | boolean;
  isCollabAdmin: number | boolean;
  isArchiveUser: number | boolean;
  isUserManager: number | boolean;
  isCataloguer: number | boolean;
}): RoleKey[] {
  const roles: RoleKey[] = [];
  if (u.isSuperAdmin) roles.push("super_admin");
  if (u.isUserManager) roles.push("user_manager");
  if (u.isCollabAdmin) roles.push("cataloguing_admin");
  if (u.isCataloguer) roles.push("cataloguer");
  if (u.isAdmin) roles.push("records_admin");
  if (u.isArchiveUser) roles.push("archive_user");
  return roles;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ROLE_PILL_COLORS: Record<RoleKey, string> = {
  super_admin: "bg-[#8B2942] text-white",
  user_manager: "bg-[#F9EDD4] text-[#8B6914]",
  cataloguing_admin: "bg-[#E0E7F7] text-[#3B5A9A]",
  cataloguer: "bg-[#D6E8DB] text-[#2F6B45]",
  records_admin: "bg-[#E8D6E8] text-[#6B2942]",
  archive_user: "bg-[#CCF0EB] text-[#0D9488]",
};

export default function SystemUsersPage({
  loaderData,
}: Route.ComponentProps) {
  const { users: allUsers } = loaderData;
  const { t } = useTranslation(["user_admin", "sidebar", "admin"]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const inviteFetcher = useFetcher();

  const inviteResult = inviteFetcher.data as
    | { ok: boolean; message?: string; error?: string }
    | undefined;
  const inviteSuccess = inviteResult?.ok === true;

  return (
    <div className="mx-auto max-w-7xl px-8 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold text-[#44403C]">
          {t("sidebar:system_users")}
        </h1>
        <button
          type="button"
          onClick={() => setShowInviteModal(true)}
          className="rounded-lg bg-[#6B1F33] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#8B2942]"
        >
          {t("sidebar:invite_user")}
        </button>
      </div>

      {inviteSuccess && inviteResult?.message && (
        <div className="rounded-lg border border-[#2F6B45] bg-[#D6E8DB] px-4 py-3 font-sans text-sm text-[#44403C]">
          {inviteResult.message}
        </div>
      )}

      {inviteResult && !inviteResult.ok && inviteResult.error && (
        <div className="rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 font-sans text-sm text-[#44403C]">
          {inviteResult.error}
        </div>
      )}

      {showInviteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowInviteModal(false)}
        >
          <div
            role="dialog"
            aria-labelledby="invite-modal-title"
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="invite-modal-title"
              className="font-serif text-lg font-semibold text-[#44403C]"
            >
              {t("sidebar:invite_user")}
            </h2>
            <p className="mt-1 font-sans text-sm text-[#78716C]">
              {t("sidebar:invite_description")}
            </p>
            <inviteFetcher.Form
              method="post"
              className="mt-4 space-y-4"
              onSubmit={() => setShowInviteModal(false)}
            >
              <input type="hidden" name="_action" value="inviteUser" />
              <div>
                <label
                  htmlFor="invite-name"
                  className="mb-1 block font-sans text-xs font-medium text-[#78716C]"
                >
                  {t("sidebar:col_name")}
                </label>
                <input
                  id="invite-name"
                  type="text"
                  name="name"
                  className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
                />
              </div>
              <div>
                <label
                  htmlFor="invite-email"
                  className="mb-1 block font-sans text-xs font-medium text-[#78716C]"
                >
                  {t("sidebar:col_email")} <span className="text-[#DC2626]">*</span>
                </label>
                <input
                  id="invite-email"
                  type="email"
                  name="email"
                  required
                  placeholder={t("admin:placeholder.email")}
                  className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
                />
              </div>
              <div className="flex justify-end gap-3 border-t border-[#E7E5E4] pt-4">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="rounded-lg border border-[#E7E5E4] px-4 py-2 font-sans text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
                >
                  {t("admin:action.cancel")}
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-[#6B1F33] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#8B2942]"
                >
                  {t("sidebar:send_invite")}
                </button>
              </div>
            </inviteFetcher.Form>
          </div>
        </div>
      )}

      {allUsers.length === 0 ? (
        <p className="font-sans text-sm text-[#A8A29E]">{t("no_users")}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[#E7E5E4]">
          <table className="min-w-full divide-y divide-[#E7E5E4]">
            <thead className="bg-[#FAFAF9]">
              <tr>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("col_name")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("col_email")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("col_roles")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("user_admin:col_projects")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                  {t("col_last_login")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {allUsers.map((u) => {
                const roles = roleSummary(u);
                return (
                  <tr key={u.id} className="hover:bg-[#FAFAF9]">
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/users/${u.id}`}
                        className="font-sans text-sm font-semibold text-[#44403C] hover:text-[#8B2942]"
                      >
                        {u.name || u.email.split("@")[0]}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-sans text-sm text-[#78716C]">
                      {u.email}
                    </td>
                    <td className="px-4 py-3">
                      {roles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {roles.map((r) => (
                            <span
                              key={r}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_PILL_COLORS[r] || "bg-[#E7E5E4] text-[#78716C]"}`}
                            >
                              {t(`user_admin:role_${r}`)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-xs text-[#A8A29E]">
                          {t("user_admin:no_roles")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.projects.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {u.projects.map((p, i) => (
                            <span
                              key={i}
                              className="font-sans text-xs text-[#44403C]"
                            >
                              {p.projectName}
                              <span className="ml-0.5 text-[#A8A29E]">
                                ({p.role})
                              </span>
                              {i < u.projects.length - 1 && ", "}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-xs text-[#A8A29E]">
                          &mdash;
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-sans text-xs text-[#A8A29E]">
                      {u.lastActiveAt ? formatDate(u.lastActiveAt) : t("never")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
