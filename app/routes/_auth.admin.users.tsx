/**
 * User Admin — List
 *
 * This page is the directory of every user in the request tenant, with
 * role pills and project counts. Each row deep-links to the user detail
 * page for edits.
 *
 * Reaching it takes `canManageTenantUsers`: a super admin, a user
 * manager, or a tenant admin. The tenant admin is the addition — on a
 * records-management tenant they are the only person in a position to
 * put a newly invited colleague to work, and gating the directory on
 * the platform roles left a federation steward able to send invitations
 * and unable to do anything with them afterwards.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Loader filters `users` by `tenant.id`; the
 * action plumbs `tenant.id` into `handleUsersAction` so the invite
 * path attributes the new user row to the calling tenant.
 *
 * The invite modal carries an opening-role picker, shown only to a
 * caller who may assign the tenant-scoped roles. It offers those two
 * roles and "no role"; the platform roles are not on offer here and
 * the action refuses them regardless of what the body says.
 *
 * Invite feedback runs through the shared `SaveFeedbackBanner` /
 * `SaveButton` pair. The banner sits on the page rather than inside
 * the invite modal because the modal closes on submit — a result
 * rendered inside it would be unmounted before it could be read.
 *
 * @version v0.7.0
 */

import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { useFormatters } from "../lib/use-formatters";
import {
  SaveButton,
  SaveFeedbackBanner,
  isPendingSubmission,
} from "~/components/admin/save-feedback";
import type { Route } from "./+types/_auth.admin.users";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { asc, eq } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");

  const { canAssignTenantRoles, canManageTenantUsers } = await import(
    "../lib/permissions.server"
  );

  const user = context.get(userContext);
  if (!canManageTenantUsers(user)) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

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
    .where(eq(users.tenantId, tenant.id))
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
    .where(eq(projects.tenantId, tenant.id))
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

  return {
    users: usersWithProjects,
    // Drives the invite modal's role picker. A caller who cannot hand
    // out the tenant-scoped roles is not offered the field at all,
    // rather than shown a control whose every value the action refuses.
    canAssignTenantRoles: canAssignTenantRoles(user),
  };
}

// ---------------------------------------------------------------------------
// Action — invite user only (role management moved to detail page)
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { canManageTenantUsers } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  if (!canManageTenantUsers(user)) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

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
    return handleUsersAction(user, tenant.id, db, formData, env, i18n, origin);
  }

  // No `error` text: the branch is not reachable from the UI, so the
  // feedback banner falls back to the localised "not saved" line
  // rather than surfacing an untranslated developer string.
  return { ok: false };
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
  super_admin: "bg-indigo text-parchment",
  user_manager: "bg-saffron-tint text-saffron-deep",
  cataloguing_admin: "bg-indigo-tint text-indigo",
  cataloguer: "bg-verdigris-tint text-verdigris",
  records_admin: "bg-sage-tint text-sage-deep",
  archive_user: "bg-verdigris-tint text-verdigris",
};

export default function SystemUsersPage({
  loaderData,
}: Route.ComponentProps) {
  const { users: allUsers, canAssignTenantRoles } = loaderData;
  const { t } = useTranslation(["user_admin", "sidebar", "admin"]);
  const { formatDate } = useFormatters();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const inviteFetcher = useFetcher();

  const inviting = isPendingSubmission(
    inviteFetcher.state,
    inviteFetcher.formData ?? undefined,
    "inviteUser",
  );

  return (
    <div className="mx-auto max-w-7xl px-8 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold text-stone-700">
          {t("sidebar:system_users")}
        </h1>
        <button
          type="button"
          onClick={() => setShowInviteModal(true)}
          className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          {t("sidebar:invite_user")}
        </button>
      </div>

      {/* Save feedback — transient on success, persistent on failure. */}
      <SaveFeedbackBanner
        source={inviteFetcher.data}
        pending={inviting}
        labels={{
          success: t("common:save.saved"),
          error: t("common:save.failed"),
        }}
      />

      {showInviteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowInviteModal(false)}
        >
          <div
            role="dialog"
            aria-labelledby="invite-modal-title"
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="invite-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("sidebar:invite_user")}
            </h2>
            <p className="mt-1 font-sans text-sm text-stone-500">
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
                  className="mb-1 block font-sans text-xs font-medium text-indigo"
                >
                  {t("sidebar:col_name")}
                </label>
                <input
                  id="invite-name"
                  type="text"
                  name="name"
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div>
                <label
                  htmlFor="invite-email"
                  className="mb-1 block font-sans text-xs font-medium text-indigo"
                >
                  {t("sidebar:col_email")} <span className="text-madder">*</span>
                </label>
                <input
                  id="invite-email"
                  type="email"
                  name="email"
                  required
                  placeholder={t("admin:placeholder.email")}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              {/* Opening role. Only the tenant-scoped roles are on
                  offer, and only to a caller who may assign them —
                  the same split `assignableRoleFlags` enforces
                  server-side. Without this the invited user landed on
                  an empty dashboard, because every records-management
                  surface requires Records admin. */}
              {canAssignTenantRoles && (
                <div>
                  <label
                    htmlFor="invite-role"
                    className="mb-1 block font-sans text-xs font-medium text-indigo"
                  >
                    {t("user_admin:invite_role_label")}
                  </label>
                  <select
                    id="invite-role"
                    name="role"
                    defaultValue="none"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                  >
                    <option value="none">
                      {t("user_admin:invite_role_none")}
                    </option>
                    <option value="records_admin">
                      {t("user_admin:role_records_admin")}
                    </option>
                    <option value="archive_user">
                      {t("user_admin:role_archive_user")}
                    </option>
                  </select>
                  <p className="mt-1 font-sans text-xs text-stone-400">
                    {t("user_admin:invite_role_hint")}
                  </p>
                </div>
              )}
              <div className="flex justify-end gap-3 border-t border-stone-200 pt-4">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="rounded-md border border-stone-200 px-4 py-2 font-sans text-sm font-semibold text-stone-700 hover:bg-stone-50"
                >
                  {t("admin:action.cancel")}
                </button>
                <SaveButton
                  pending={inviting}
                  label={t("sidebar:send_invite")}
                  pendingLabel={t("common:save.saving")}
                />
              </div>
            </inviteFetcher.Form>
          </div>
        </div>
      )}

      {allUsers.length === 0 ? (
        <p className="font-sans text-sm text-stone-400">{t("sidebar:no_users")}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200">
          <table className="min-w-full divide-y divide-stone-200">
            <thead className="bg-stone-50">
              <tr>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_name")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_email")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_roles")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("user_admin:col_projects")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_last_login")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {allUsers.map((u) => {
                const roles = roleSummary(u);
                return (
                  <tr key={u.id} className="hover:bg-stone-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/users/${u.id}`}
                        className="font-sans text-sm font-semibold text-stone-700 hover:text-indigo"
                      >
                        {u.name || u.email.split("@")[0]}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-sans text-sm text-stone-500">
                      {u.email}
                    </td>
                    <td className="px-4 py-3">
                      {roles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {roles.map((r) => (
                            <span
                              key={r}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_PILL_COLORS[r] || "bg-stone-200 text-stone-500"}`}
                            >
                              {t(`user_admin:role_${r}`)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-xs text-stone-400">
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
                              className="font-sans text-xs text-stone-700"
                            >
                              {p.projectName}
                              <span className="ml-0.5 text-stone-400">
                                ({p.role})
                              </span>
                              {i < u.projects.length - 1 && ", "}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-xs text-stone-400">
                          &mdash;
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-sans text-xs text-stone-400">
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
