/**
 * Sidebar Navigation
 *
 * Primary left-hand navigation for the authenticated app. Renders
 * the active project section, the cataloguing / description / admin
 * link groups, and the footer with the signed-in user pill. Item
 * visibility is computed from the caller's role flags via
 * `getSidebarSections`, which keeps sidebar composition testable
 * and free of inline role checks. Supports both a desktop collapsed
 * state and a mobile drawer.
 *
 * @version v0.3.0
 */

import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  FolderOpen,
  Folders,
  FileText,
  Users,
  MapPin,
  Building2,
  UserCog,
  Upload,
  ArrowUpFromLine,
  BookOpen,
  Kanban,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  path: string;
  icon: LucideIcon;
  labelKey: string;
  end?: boolean;
}

export interface NavSection {
  labelKey?: string;
  items: NavItem[];
}

export interface SidebarUser {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
  hasAnyProjectMembership: boolean;
}

/**
 * Pure function that returns the sidebar sections visible to a given user.
 * Single source of truth for sidebar visibility, fully unit-testable.
 */
export function getSidebarSections(user: SidebarUser): NavSection[] {
  const sections: NavSection[] = [
    {
      items: [
        { path: "/", icon: LayoutDashboard, labelKey: "sidebar:home", end: true },
      ],
    },
  ];

  // Collaborative cataloguing — visible if member OR any collab/admin flag
  if (
    user.hasAnyProjectMembership ||
    user.isCollabAdmin ||
    user.isSuperAdmin ||
    user.isAdmin ||
    user.isCataloguer
  ) {
    const collabItems: NavItem[] = [
      { path: "/proyectos", icon: FolderOpen, labelKey: "sidebar:my_projects" },
    ];
    if (user.isCollabAdmin || user.isSuperAdmin) {
      collabItems.push(
        {
          path: "/admin/cataloguing/projects",
          icon: Folders,
          labelKey: "sidebar:all_projects",
        },
        {
          path: "/admin/cataloguing/team",
          icon: UserCog,
          labelKey: "sidebar:manage_users",
        },
      );
    }
    if (user.isSuperAdmin) {
      collabItems.push(
        {
          path: "/admin/cataloguing/promote",
          icon: ArrowUpFromLine,
          labelKey: "sidebar:promote",
        },
      );
    }
    sections.push({
      labelKey: "sidebar:collaborative_cataloguing",
      items: collabItems,
    });
  }

  // Records management — archive admin side
  if (user.isAdmin || user.isSuperAdmin) {
    const items: NavItem[] = [
      { path: "/admin/descriptions", icon: FileText, labelKey: "sidebar:descriptions" },
      { path: "/admin/entities", icon: Users, labelKey: "sidebar:entities" },
      { path: "/admin/places", icon: MapPin, labelKey: "sidebar:places" },
      { path: "/admin/repositories", icon: Building2, labelKey: "sidebar:repositories" },
      { path: "/admin/vocabularies", icon: BookOpen, labelKey: "sidebar:vocabularies" },
    ];
    if (user.isSuperAdmin) {
      items.push({
        path: "/admin/publish",
        icon: Upload,
        labelKey: "sidebar:publish",
      });
    }
    sections.push({ labelKey: "sidebar:records_management", items });
  }

  return sections;
}

const BOTTOM_ITEMS: NavItem[] = [
  { path: "/configuracion", icon: Settings, labelKey: "sidebar:my_settings" },
];

interface SidebarProps {
  user: SidebarUser;
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ user, collapsed, onToggle }: SidebarProps) {
  const { t } = useTranslation("sidebar");

  const sections = getSidebarSections(user);

  return (
    <nav
      aria-label="Main navigation"
      className={`flex flex-col border-r border-stone-200 bg-stone-50 transition-all duration-300 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex flex-1 flex-col gap-1 py-4">
        {sections.map((section, si) => (
          <div key={section.labelKey ?? si}>
            {si > 0 && <div className="mx-4 my-2 border-t border-stone-200" />}
            {section.labelKey && !collapsed && (
              <p className="mx-6 mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.1em] text-stone-400">
                {t(section.labelKey.replace("sidebar:", ""))}
              </p>
            )}
            {section.items.map((item) => (
              <SidebarNavItem
                key={item.path}
                item={item}
                collapsed={collapsed}
                t={t}
              />
            ))}
          </div>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom divider + items */}
        <div className="mx-4 my-2 border-t border-stone-200" />
        {BOTTOM_ITEMS.map((item) => (
          <SidebarNavItem
            key={item.path}
            item={item}
            collapsed={collapsed}
            t={t}
          />
        ))}
        {(user.isSuperAdmin || user.isUserManager) && (
          <SidebarNavItem
            item={{ path: "/admin/users", icon: Users, labelKey: "sidebar:system_users" }}
            collapsed={collapsed}
            t={t}
          />
        )}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("expand") : t("collapse")}
        className="flex justify-center border-t border-stone-200 py-3 text-stone-500 hover:text-indigo"
      >
        {collapsed ? (
          <ChevronRight className="h-5 w-5" />
        ) : (
          <ChevronLeft className="h-5 w-5" />
        )}
      </button>
    </nav>
  );
}

function SidebarNavItem({
  item,
  collapsed,
  t,
}: {
  item: NavItem;
  collapsed: boolean;
  t: (key: string) => string;
}) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.path}
      end={item.end}
      className={({ isActive }) =>
        `relative mx-2 flex items-center gap-3 rounded-md px-4 py-2.5 ${
          collapsed ? "justify-center" : ""
        } ${
          isActive
            ? "bg-white font-semibold text-indigo before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-indigo"
            : "font-sans text-stone-700 hover:bg-white/50"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={`h-5 w-5 flex-shrink-0 ${
              isActive ? "text-indigo" : "text-stone-500"
            }`}
          />
          {!collapsed && (
            <span className="font-sans text-sm">
              {t(item.labelKey.replace("sidebar:", ""))}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
