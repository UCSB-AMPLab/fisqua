/**
 * Admin Tab Bar
 *
 * Thin pill-tab navigation component shared across the admin surfaces.
 * Renders as unstyled anchor tags so the caller can use it with either
 * React Router `NavLink` or plain URL-driven tabs.
 *
 * @version v0.3.0
 */

import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";

const TABS = [
  { to: "/admin/cataloguing/projects", labelKey: "cataloguing_admin:tab_projects" },
  { to: "/admin/cataloguing/team", labelKey: "cataloguing_admin:tab_team" },
  {
    to: "/admin/cataloguing/promote",
    labelKey: "cataloguing_admin:tab_promote",
    superadminOnly: true,
  },
] as const;

export function TabBar({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const { t } = useTranslation("cataloguing_admin");

  return (
    <nav className="flex border-b border-stone-200">
      {TABS.map((tab) => {
        if ("superadminOnly" in tab && tab.superadminOnly && !isSuperAdmin) {
          return null;
        }
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `px-4 py-3 text-sm transition-colors duration-150 ${
                isActive
                  ? "border-b-2 border-indigo font-semibold text-stone-700"
                  : "font-normal text-stone-500 hover:text-stone-700"
              }`
            }
          >
            {t(tab.labelKey)}
          </NavLink>
        );
      })}
    </nav>
  );
}
