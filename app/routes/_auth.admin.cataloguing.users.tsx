/**
 * Cataloguing Admin — Users
 *
 * The cataloguing-side user directory: shows every account that holds
 * at least one cataloguing role and lets a cataloguing admin edit
 * per-row role flags. Sensitive toggles — superadmin, collab admin —
 * remain superadmin-only in the UI, even though the route lives in
 * the cataloguing admin subsection.
 *
 * @version v0.3.0
 */

import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { formatDate } from "../lib/format";
import type { Route } from "./+types/_auth.admin.cataloguing.users";

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { desc, eq, or, inArray, sql } = await import("drizzle-orm");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { users, projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  requireCollabAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  : collab-side users only. Include users who either have
  // isCollabAdmin=true or have at least one projectMembers row. Archive-only
  // admins (isAdmin=true, isCollabAdmin=false, no memberships) are excluded.
  const memberUserIds = await db
    .selectDistinct({ userId: projectMembers.userId })
    .from(projectMembers)
    .all();
  const memberIdSet = memberUserIds.map((m) => m.userId);

  const allUsersRaw = await db
    .select()
    .from(users)
    .orderBy(desc(users.createdAt))
    .all();

  const allUsers = allUsersRaw.filter(
    (u) => u.isCollabAdmin || u.isSuperAdmin || memberIdSet.includes(u.id)
  );

  return {
    users: allUsers,
    currentUser: {
      id: user.id,
      isSuperAdmin: user.isSuperAdmin,
      isCollabAdmin: user.isCollabAdmin,
    },
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { handleUsersAction } = await import(
    "./_auth.admin.cataloguing.users.action.server"
  );

  const user = context.get(userContext);
  requireCollabAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  const formData = await request.formData();
  const origin = new URL(request.url).origin;

  return handleUsersAction(user, db, formData, env, i18n, origin);
}

export default function AdminCataloguingUsers({
  loaderData,
}: Route.ComponentProps) {
  const { users: allUsers, currentUser } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("admin");

  return (
    <div className="space-y-8">
      <h1 className="font-display text-4xl font-semibold text-[#44403C]">
        {t("cataloguing_users.title")}
      </h1>

      {/* Invite user form */}
      <section>
        <h2 className="font-sans text-lg font-semibold text-[#44403C]">
          {t("heading.create_user")}
        </h2>

        {actionData?.ok && actionData?.message && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#2F6B45] bg-[#D6E8DB] px-4 py-3 font-sans text-sm text-[#44403C]">
            {actionData.message}
          </div>
        )}
        {actionData && !actionData.ok && actionData?.error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 font-sans text-sm text-[#44403C]">
            {actionData.error}
          </div>
        )}

        <Form method="post" className="mt-4 flex items-end gap-3">
          <input type="hidden" name="_action" value="inviteUser" />
          <div>
            <label
              htmlFor="email"
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
            >
              {t("table.email")}
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder={t("placeholder.email")}
              className="mt-1 block w-64 rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="name"
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
            >
              {t("table.name")}
            </label>
            <input
              type="text"
              id="name"
              name="name"
              className="mt-1 block w-48 rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
          </div>
          {/* isCollabAdmin checkbox is hidden unless current user is superadmin. */}
          {currentUser.isSuperAdmin && (
            <label className="flex items-center gap-2 font-sans text-sm text-[#78716C]">
              <input type="checkbox" name="isCollabAdmin" />
              Collab admin
            </label>
          )}
          <button
            type="submit"
            className="rounded-lg bg-[#8B2942] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#7a2439]"
          >
            {t("action.create_user")}
          </button>
        </Form>
      </section>

      {/* Users table */}
      <section>
        <h2 className="font-sans text-lg font-semibold text-[#44403C]">
          {t("heading.all_users")}
        </h2>

        {allUsers.length === 0 ? (
          <p className="mt-2 font-sans text-sm text-[#A8A29E]">
            {t("empty.no_users")}
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E5E4]">
            <table className="min-w-full divide-y divide-[#E7E5E4]">
              <thead className="bg-[#FAFAF9]">
                <tr>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("table.email")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("table.name")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("table.role")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("table.created")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {allUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-sans text-sm text-[#44403C]">
                      {u.email}
                    </td>
                    <td className="px-4 py-3 font-sans text-sm text-[#78716C]">
                      {u.name || "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      {/* per-row toggles are superadmin-only in the UI. */}
                      {currentUser.isSuperAdmin ? (
                        <div className="flex gap-2">
                          <Form method="post" className="inline">
                            <input
                              type="hidden"
                              name="_action"
                              value="toggleAdmin"
                            />
                            <input type="hidden" name="userId" value={u.id} />
                            <button
                              type="submit"
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${
                                u.isAdmin
                                  ? "bg-[#F9EDD4] text-[#8B6914] hover:bg-[#f3e3be]"
                                  : "bg-[#E7E5E4] text-[#78716C] hover:bg-stone-200"
                              }`}
                            >
                              {u.isAdmin ? t("table.admin") : t("table.user")}
                            </button>
                          </Form>
                          <Form method="post" className="inline">
                            <input
                              type="hidden"
                              name="_action"
                              value="toggleCollabAdmin"
                            />
                            <input type="hidden" name="userId" value={u.id} />
                            <button
                              type="submit"
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${
                                u.isCollabAdmin
                                  ? "bg-[#D6E8DB] text-[#2F6B45] hover:bg-[#c6dccc]"
                                  : "bg-[#E7E5E4] text-[#78716C] hover:bg-stone-200"
                              }`}
                            >
                              Collab
                            </button>
                          </Form>
                        </div>
                      ) : (
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${
                            u.isCollabAdmin || u.isAdmin
                              ? "bg-[#F9EDD4] text-[#8B6914]"
                              : "bg-[#E7E5E4] text-[#78716C]"
                          }`}
                        >
                          {u.isCollabAdmin
                            ? "Collab admin"
                            : u.isAdmin
                              ? t("table.admin")
                              : t("table.user")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-sans text-xs text-[#A8A29E]">
                      {formatDate(u.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
