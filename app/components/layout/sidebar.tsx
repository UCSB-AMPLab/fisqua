/**
 * Sidebar Navigation
 *
 * The sidebar is the primary way users move through the app once signed in.
 * It is the sole navigation surface for the admin back-office -- there are no
 * admin tabs any more -- and it also hosts the user's project workspace and
 * personal settings links. What sections a given user sees depends entirely
 * on the role flags they carry: a member-only cataloguer sees only their own
 * projects list, a collab admin gains the project-management and team pages,
 * a records admin gains the archival descriptions / entities / places /
 * repositories / vocabularies group, and a superadmin gains publish and
 * promote on top.
 *
 * `getSidebarSections` is a pure function that takes the role-flag snapshot
 * and returns the sections visible to that user. Keeping it pure means the
 * visibility rules are fully unit-testable (see `sidebar.test.tsx`) and the
 * component below does no role logic of its own -- it just renders what the
 * function returns.
 *
 * The sidebar supports a collapse state that shrinks it to an icon rail;
 * the toggle is controlled from the parent layout (`_auth.tsx`), which also
 * persists the state in localStorage so a cataloguer who prefers the rail
 * sees it after reload.
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
 * Returns the sidebar sections visible to a given user, based on their
 * role flags and whether they are a member of any project. The output
 * drives what links the sidebar renders; no role logic lives in the
 * component below. Kept as a pure function so the visibility matrix
 * stays fully unit-testable.
 */
export function getSidebarSections(user: SidebarUser): NavSection[] {
  const sections: NavSection[] = [
    {
      items: [
        { path: "/", icon: LayoutDashboard, labelKey: "sidebar:home", end: true },
      ],
    },
  ];

  // Collaborative cataloguing — visible to any project member or collab/admin role.
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

  // Records management — the archival admin surfaces for catalogued material.
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
      className={`flex flex-col border-r border-[#E7E5E4] bg-[#FAFAF9] transition-all duration-300 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex flex-1 flex-col gap-1 py-4">
        {sections.map((section, si) => (
          <div key={section.labelKey ?? si}>
            {si > 0 && <div className="mx-4 my-2 border-t border-[#E7E5E4]" />}
            {section.labelKey && !collapsed && (
              <p className="mx-6 mb-1 text-xs font-medium uppercase tracking-wider text-[#A8A29E]">
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
        <div className="mx-4 my-2 border-t border-[#E7E5E4]" />
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
        className="flex justify-center border-t border-[#E7E5E4] py-3 text-[#78716C] hover:text-[#44403C]"
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
        `mx-2 flex items-center gap-3 rounded px-4 py-3 ${
          collapsed ? "justify-center" : ""
        } ${
          isActive
            ? "bg-white font-semibold text-[#44403C] shadow-sm"
            : "text-[#78716C] hover:bg-white/50"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={`h-5 w-5 flex-shrink-0 ${
              isActive ? "text-[#8B2942]" : "text-[#78716C]"
            }`}
          />
          {!collapsed && (
            <span className="text-sm">{t(item.labelKey.replace("sidebar:", ""))}</span>
          )}
        </>
      )}
    </NavLink>
  );
}
