import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { formatDate } from "~/lib/format";
import type { Route } from "./+types/_auth.admin.users";

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { desc } = await import("drizzle-orm");
  const { users } = await import("../db/schema");

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
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { getInstance } = await import("~/middleware/i18next");
  const { users } = await import("../db/schema");

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
        <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
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
          <input type="hidden" name="_action" value="createUser" />
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
        <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
          {t("heading.all_users")}
        </h2>

        {allUsers.length === 0 ? (
          <p className="mt-2 font-sans text-sm text-[#A8A29E]">{t("empty.no_users")}</p>
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
