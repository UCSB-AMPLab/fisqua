import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { userContext } from "../context";
import { users } from "../db/schema";
import { getInstance } from "~/middleware/i18next";
import { formatDate } from "~/lib/format";
import type { Route } from "./+types/_auth.admin.users";

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const allUsers = await db
    .select()
    .from(users)
    .orderBy(desc(users.createdAt))
    .all();

  return { users: allUsers };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "toggleAdmin": {
      const targetUserId = formData.get("userId") as string;

      // Prevent self-demotion
      if (targetUserId === user.id) {
        return { ok: false, error: i18n.t("admin:error.self_admin") };
      }

      const targetUser = await db
        .select()
        .from(users)
        .where(eq(users.id, targetUserId))
        .get();

      if (!targetUser) {
        return { ok: false, error: i18n.t("admin:error.user_not_found") };
      }

      await db
        .update(users)
        .set({ isAdmin: !targetUser.isAdmin, updatedAt: Date.now() })
        .where(eq(users.id, targetUserId));

      const messageKey = targetUser.isAdmin
        ? "admin:error.admin_toggled_off"
        : "admin:error.admin_toggled_on";
      return {
        ok: true,
        message: i18n.t(messageKey, { email: targetUser.email }),
      };
    }

    case "createUser": {
      const email = (formData.get("email") as string || "").trim().toLowerCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: i18n.t("admin:error.invalid_email") };
      }

      // Check for duplicate
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .get();

      if (existing) {
        return { ok: false, error: i18n.t("admin:error.duplicate_email") };
      }

      const now = Date.now();
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email,
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      });

      return { ok: true, message: i18n.t("admin:error.user_created", { email }) };
    }

    default:
      return { ok: false, error: i18n.t("admin:error.unknown_action") };
  }
}

export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { users: allUsers } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("admin");

  return (
    <div className="space-y-8">
      {/* Create user form */}
      <section>
        <h2 className="text-lg font-medium text-stone-900">{t("heading.create_user")}</h2>

        {actionData?.ok && actionData?.message && (
          <p className="mt-2 text-sm text-green-600">{actionData.message}</p>
        )}
        {actionData && !actionData.ok && actionData?.error && (
          <p className="mt-2 text-sm text-red-600">{actionData.error}</p>
        )}

        <Form method="post" className="mt-4 flex items-end gap-3">
          <input type="hidden" name="_action" value="createUser" />
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-stone-700"
            >
              {t("table.email")}
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder={t("placeholder.email")}
              className="mt-1 block w-64 rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-burgundy-light focus:ring-1 focus:ring-burgundy-light focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="rounded-md bg-burgundy-deep px-4 py-2 text-sm font-medium text-white hover:bg-burgundy"
          >
            {t("action.create_user")}
          </button>
        </Form>
      </section>

      {/* Users table */}
      <section>
        <h2 className="text-lg font-medium text-stone-900">{t("heading.all_users")}</h2>

        {allUsers.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">{t("empty.no_users")}</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    {t("table.email")}
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    {t("table.name")}
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    {t("table.role")}
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    {t("table.created")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {allUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 text-sm text-stone-900">
                      {u.email}
                    </td>
                    <td className="px-4 py-3 text-sm text-stone-500">
                      {u.name || "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      <Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="_action"
                          value="toggleAdmin"
                        />
                        <input type="hidden" name="userId" value={u.id} />
                        <button
                          type="submit"
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            u.isAdmin
                              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                              : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                          }`}
                        >
                          {u.isAdmin ? t("table.admin") : t("table.user")}
                        </button>
                      </Form>
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-400">
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
