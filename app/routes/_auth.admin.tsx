import { Outlet, NavLink } from "react-router";
import { userContext } from "../context";
import { requireAdmin } from "../lib/permissions.server";
import type { Route } from "./+types/_auth.admin";

export function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  requireAdmin(user);
  return { user };
}

const tabs = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/projects", label: "Projects" },
];

export default function AdminLayout() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-xl font-semibold text-stone-900">Admin</h1>

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
