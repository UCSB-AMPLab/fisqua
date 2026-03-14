import { Outlet, NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.admin";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("../lib/permissions.server");
  const user = context.get(userContext);
  requireAdmin(user);
  return { user };
}

export default function AdminLayout() {
  const { t } = useTranslation("admin");

  const tabs = [
    { to: "/admin/users", label: t("tab.users") },
    { to: "/admin/projects", label: t("tab.projects") },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-xl font-semibold text-stone-900">{t("heading.admin")}</h1>

      <nav className="mt-4 flex gap-1 border-b border-stone-200">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                isActive
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-700 hover:border-stone-300"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6">
        <Outlet />
      </div>
    </div>
  );
}
