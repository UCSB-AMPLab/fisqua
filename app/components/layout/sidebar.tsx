/**
 * Sidebar Navigation
 *
 * This component is the primary left-hand navigation for the authenticated
 * app. Renders the active project section, the cataloguing / description
 * / admin link groups, and the footer with the signed-in user pill. Item
 * visibility is computed from the caller's role flags via
 * `getSidebarSections`, which keeps sidebar composition testable and free
 * of inline role checks. Supports both a desktop collapsed state and a
 * mobile drawer.
 *
 * The item column (sections, spacer, and the bottom items My settings
 * and Users) is the one element that scrolls: `min-h-0` lets it
 * shrink below its content inside the full-height nav, and
 * `overflow-y-auto` scrolls it. A tenant with many capabilities has
 * sections taller than the window, and without this the bottom items
 * were clipped by the layout's `overflow-hidden` row. The spacer keeps
 * the bottom items at the foot of the rail when everything fits; when
 * it does not, they come last in the scroll. The collapse toggle sits
 * outside the scrolling column and stays pinned. The same markup serves
 * the collapsed and expanded rail, and the focused-surface overlay in
 * `_auth.tsx`, whose absolute layer gives the nav its height.
 *
 * `getSidebarSections(user, tenant)` takes a second argument carrying
 * the request tenant's capability booleans
 * (`crowdsourcingEnabled`, `vocabularyHubEnabled`,
 * `publishPipelineEnabled`, `multiRepositoryEnabled`,
 * `authoritiesEnabled`, `importsEnabled`, `digitizationEnabled`).
 * When a
 * capability is off, the corresponding nav surface is omitted
 * entirely — no greyed-out, no "coming soon", no tooltip — matching
 * the platform's immutable-capability posture.
 *
 * The first, unlabelled section carries Home, Handlists and global
 * search, all of which sit above the module sections because they
 * read across all of them, and none of which carries a gate here.
 * Search is member-level (ruled 2026-08-16) with the authorities area
 * gate kept only on its authority reach, inside the surface; a handlist
 * belongs to a person rather than to a module, and the area gate that
 * guards an authority-typed one is enforced on the handlist itself.
 *
 * The module sections are gated by area as well as by capability. A
 * workspace admin (`isAdmin`) and a super admin pass every area; an
 * area admin passes their own: Records management needs the records
 * area, Authorities the authorities area, Imports the imports area,
 * and Digitization follows `isCaptureManager`, which the layout loader
 * computes from the digitization area and federation stewardship. The
 * rule is the one `canAdministerArea` (`user-access.server.ts`) holds,
 * restated here because this module renders in the browser.
 * Pending decisions belongs to Authorities; someone who can open only
 * its vocabulary tab (the records area, without the authority tabs)
 * finds it in Records management instead, leading to that tab.
 *
 * A Reader with no other role (`user.access === "reader"`) gets one
 * section holding Records (`/records`) and nothing else; a member with
 * no access (`"none"`) gets no sections. Both keep the bottom item My
 * settings. A Reader who also holds a staff role keeps every section
 * and has Records in the first one, after Search.
 *
 * The capability gate map is:
 *
 *   - `crowdsourcingEnabled` → entire `Collaborative Cataloguing`
 *     section (My projects, All projects, Team, Promote)
 *   - `vocabularyHubEnabled` → `/admin/vocabularies`
 *   - `publishPipelineEnabled` → `/admin/publish`
 *   - `multiRepositoryEnabled` → `/admin/repositories`
 *   - `authoritiesEnabled` → the entire `Authorities` section
 *     (`/admin/entities`, `/admin/places`, and `/admin/decisions`),
 *     its own grouped section as of the 2026-07-10 module-section
 *     ruling
 *   - `digitizationEnabled` → the `Digitization` section (Volumes,
 *     Capture QC, Retakes, Scanner), placed after Authorities; within it
 *     Volumes and Scanner need `isCaptureManager`, and Capture QC and
 *     Retakes `isCaptureManager` or `isCaptureReviewer`, both computed
 *     by the layout loader
 *   - `importsEnabled` → the `Imports` ITEM inside the
 *     `Import and export` group (`/admin/imports`). The group itself
 *     is ungated: its other entry, Exports, carries no capability and
 *     no role, because portability is not a product tier (the
 *     2026-08-15 export ruling). A tenant with imports off sees the
 *     group holding Exports alone.
 *
 * For a tenant with a capability off the corresponding surface is
 * omitted — the gating is invisible to tenants that carry every
 * flag. The `<Sidebar>` component grew a matching `tenant` prop
 * which the `_auth` layout populates from `tenantContext`.
 *
 * Each labelled section heading is a button that folds and unfolds
 * that section's items, with a chevron and an accessible name from
 * `sidebar:section_show` / `sidebar:section_hide`. The unlabelled first
 * section and the bottom items never fold, and the collapsed rail shows
 * every item because it has no headings. Every section starts open. A
 * person's folded sections are kept in `localStorage`
 * (`fisqua:sidebar:folded`, a JSON array of section label keys); every
 * read and write is wrapped in try/catch so the sidebar renders
 * without storage. `Sidebar` renders everything open on the server and
 * on the first client render, and applies the stored folds in an
 * effect after mount, so hydration matches. The section that holds the
 * current page is always open, whatever was stored. `SidebarView` is
 * the stateless rail; `readFoldedSections`, `writeFoldedSections` and
 * `sectionHoldsPath` are exported for testing.
 *
 * @version v0.8.0
 */

import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
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
  Import,
  Download,
  ArrowUpFromLine,
  BookOpen,
  ClipboardCheck,
  Repeat,
  Camera,
  GitCompare,
  Kanban,
  List,
  Search,
  Library,
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  path: string;
  icon: LucideIcon;
  labelKey: string;
  end?: boolean;
  /** Right-aligned madder pill count (duplicate candidates). */
  badge?: number;
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
  isRecordsAdmin: boolean;
  isAuthoritiesAdmin: boolean;
  isImportsAdmin: boolean;
  hasAnyProjectMembership: boolean;
  /**
   * Manages capture work on this tenant: a workspace admin, a super
   * admin, the digitization admin, or a steward of its federation. Computed by the layout loader only on a tenant with
   * the digitization capability; false elsewhere.
   */
  isCaptureManager: boolean;
  /** Is the assigned capture QC reviewer of at least one of the tenant's volumes. */
  isCaptureReviewer: boolean;
  /**
   * What kind of member this is (`memberAccessFrom` in
   * `reader.server`): a Reader with no other role sees only Records, a
   * member with no access sees no sections. Omitted means staff.
   */
  access?: "staff" | "reader" | "none";
}

/**
 * Capability-flag surface the sidebar reads. Structurally compatible
 * with the full `Tenant` row from `app/context.ts` — the layout
 * loader can pass the tenant straight through — but narrow enough
 * that unit tests don't need to seed every column of a `tenants`
 * row to exercise the gating logic.
 */
export interface SidebarTenant {
  crowdsourcingEnabled: boolean;
  vocabularyHubEnabled: boolean;
  publishPipelineEnabled: boolean;
  multiRepositoryEnabled: boolean;
  authoritiesEnabled: boolean;
  importsEnabled: boolean;
  digitizationEnabled: boolean;
}

/**
 * Pure function that returns the sidebar sections visible to a given
 * user on a given tenant. Single source of truth for sidebar
 * visibility, fully unit-testable. Capability gates per the map in
 * the file header — sections / items disappear entirely when the
 * matching tenant capability is off.
 */
export function getSidebarSections(
  user: SidebarUser,
  tenant: SidebarTenant,
  counts?: { duplicates?: number },
): NavSection[] {
  // A Reader with no other role is kept to the records pages, so Records
  // is all they are shown; a member with no access is shown nothing.
  // Home, Handlists, Search and Exports are member-level surfaces that
  // would show either of them unpublished records, and the layout's
  // middleware keeps both away from them.
  const recordsItem: NavItem = {
    path: "/records",
    icon: Library,
    labelKey: "sidebar:records",
  };
  if (user.access === "reader") return [{ items: [recordsItem] }];
  if (user.access === "none") return [];

  const sections: NavSection[] = [
    {
      items: [
        { path: "/", icon: LayoutDashboard, labelKey: "sidebar:home", end: true },
        // Handlists sits at the TOP LEVEL, directly under Home, and
        // ungated. It belongs to no module: one can hold records,
        // entities or places, it is owned by a person rather than by a
        // project, and it is reached from search, from a record and
        // from export. Nesting it under Collaborative cataloguing or
        // Records management would misdescribe both what it can hold
        // and who it belongs to. The admin gate that guards an
        // authority-typed handlist lives on the handlist itself — the
        // index lists what this person may reach and says why when a
        // row cannot be opened — so the nav item needs no role of its
        // own.
        { path: "/handlists", icon: List, labelKey: "sidebar:handlists" },
      ],
    },
  ];

  // Global search sits directly under Home, above the module sections:
  // it reads across all three of them, so it belongs to none. Open to
  // every workspace member (ruled 2026-08-16): a member searching their
  // own handlists is the ordinary case, not the exception. Only the
  // authority reach inside the surface keeps the admin gate — for a
  // non-admin the Entities and Places tabs simply do not exist.
  sections[0].items.push({
    path: "/search",
    icon: Search,
    labelKey: "sidebar:search",
  });

  // A Reader who also holds a staff role keeps everything above and has
  // Records beside it.
  if (user.isArchiveUser) {
    sections[0].items.push(recordsItem);
  }

  // Collaborative cataloguing — visible if member OR any collab/admin
  // flag, AND the tenant has crowdsourcing enabled. When
  // `crowdsourcingEnabled` is false the entire section (including
  // /proyectos) is omitted; dormant role flags on the user
  // (`isCataloguer`, `isCollabAdmin` set from before crowdsourcing
  // was disabled) become no-ops because the section that would
  // surface them is gone and the route-level capability gate 404s
  // any direct hit.
  if (
    tenant.crowdsourcingEnabled &&
    (user.hasAnyProjectMembership ||
      user.isCollabAdmin ||
      user.isSuperAdmin ||
      user.isAdmin ||
      user.isCataloguer)
  ) {
    const collabItems: NavItem[] = [
      { path: "/proyectos", icon: FolderOpen, labelKey: "sidebar:my_projects" },
    ];
    // Same rule as `requireCollabAdmin`, which gates both pages.
    if (user.isCollabAdmin || user.isSuperAdmin || user.isAdmin) {
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
    // Promote is a cataloguing feature: the outer crowdsourcing branch
    // is its capability gate, and the page itself is super-admin-only.
    // The publish pipeline has no part in it.
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

  // Who passes each area (see the file header).
  const anyArea = user.isAdmin || user.isSuperAdmin;
  const recordsArea = anyArea || user.isRecordsAdmin;
  const authoritiesArea = anyArea || user.isAuthoritiesAdmin;
  const importsArea = anyArea || user.isImportsAdmin;
  const authorityDecisions = authoritiesArea && tenant.authoritiesEnabled;
  const vocabularyDecisionsOnly =
    recordsArea && tenant.vocabularyHubEnabled && !authorityDecisions;

  // Records management — archive admin side, for the records area.
  // Per-item gating for the capability-bound entries (repositories,
  // vocabularies, publish); descriptions is always available in the
  // area. Entities and places have their own Authorities section
  // (ruled 2026-07-10) — each module gets its own sidebar section.
  if (recordsArea) {
    const items: NavItem[] = [
      { path: "/admin/descriptions", icon: FileText, labelKey: "sidebar:descriptions" },
    ];
    // Repositories renders for every tenant's admins: the capability gates
    // the OPERATIONS (create beyond the first repository, delete of the
    // last one — the repositories routes), never the surface. A
    // single-repository tenant still reads and edits its one repository.
    items.push({
      path: "/admin/repositories",
      icon: Building2,
      labelKey: "sidebar:repositories",
    });
    if (tenant.vocabularyHubEnabled) {
      items.push({
        path: "/admin/vocabularies",
        icon: BookOpen,
        labelKey: "sidebar:vocabularies",
      });
    }
    // Pending decisions sits with Authorities. When this person can open
    // only its vocabulary tab (the records area without the authority
    // tabs), the entry sits here instead and leads straight to that tab.
    if (vocabularyDecisionsOnly) {
      items.push({
        path: "/admin/decisions/vocabulary",
        icon: GitCompare,
        labelKey: "sidebar:pending_decisions",
      });
    }
    if (user.isSuperAdmin && tenant.publishPipelineEnabled) {
      items.push({
        path: "/admin/publish",
        icon: Upload,
        labelKey: "sidebar:publish",
      });
    }
    sections.push({ labelKey: "sidebar:records_management", items });
  }

  // Authorities — the module's own section, for the authorities area
  // and gated on the authorities capability. When off the whole
  // section is omitted (the route-level gate 404s any direct hit). The
  // Pending decisions entry replaced the standalone Possible duplicates
  // link when the worklist became one tab of that surface; it keeps the
  // candidate-count badge computed by the layout loader.
  if (authorityDecisions) {
    sections.push({
      labelKey: "sidebar:authorities",
      items: [
        { path: "/admin/entities", icon: Users, labelKey: "sidebar:entities" },
        { path: "/admin/places", icon: MapPin, labelKey: "sidebar:places" },
        {
          path: "/admin/decisions",
          icon: GitCompare,
          labelKey: "sidebar:pending_decisions",
          badge: counts?.duplicates,
        },
      ],
    });
  }

  // Digitization — the Captua module's section, gated on the
  // digitization capability and then by role. Volumes is for those who
  // manage capture work (the digitization area and federation stewards); Capture
  // QC and Retakes also for anyone assigned to review one of the
  // tenant's volumes, who sees only their own volumes there. The section
  // is omitted when no item remains.
  //
  // Scanner (`Camera`) is the section's last item, for managers only.
  if (tenant.digitizationEnabled) {
    const digitizationItems: NavItem[] = [];
    if (user.isCaptureManager) {
      digitizationItems.push({
        path: "/admin/capture/volumes",
        icon: BookOpen,
        labelKey: "sidebar:capture_volumes",
      });
    }
    if (user.isCaptureManager || user.isCaptureReviewer) {
      digitizationItems.push({
        path: "/admin/capture/qc",
        icon: ClipboardCheck,
        labelKey: "sidebar:capture_qc",
      });
      digitizationItems.push({
        path: "/admin/capture/retakes",
        icon: Repeat,
        labelKey: "sidebar:retakes",
      });
    }
    if (user.isCaptureManager) {
      digitizationItems.push({
        path: "/admin/capture/scanner",
        icon: Camera,
        labelKey: "sidebar:scanner",
      });
    }
    if (digitizationItems.length > 0) {
      sections.push({ labelKey: "sidebar:digitization", items: digitizationItems });
    }
  }

  // Import and export — the mirror operations, in one group (ruled
  // 2026-08-15, export-decisions decision 1 ruling A). Import and
  // export are read together far more often than either is read beside
  // Descriptions, and both act on the workspace as a whole rather than
  // on a module.
  //
  // THE TWO ENTRIES CARRY DIFFERENT GATES, and the group carries
  // neither. Imports needs the imports area plus the `imports`
  // capability. Exports carries no gate at all:
  // portability is not a product tier (ruling 2, re-ruled), so no
  // capability can take it away, and it is member-level because the
  // TIER decides what a person is offered on the page rather than
  // whether they may open it — a reader sees the PDF finding aid and
  // no evidence that anything else exists. The group therefore renders
  // whenever either entry does, which — since Exports always does — is
  // always, on the same footing as Handlists and Search above.
  const importExportItems: NavItem[] = [];
  if (importsArea && tenant.importsEnabled) {
    importExportItems.push({
      path: "/admin/imports",
      icon: Import,
      labelKey: "sidebar:imports",
    });
  }
  importExportItems.push({
    path: "/admin/exports",
    icon: Download,
    labelKey: "sidebar:exports",
  });
  sections.push({
    labelKey: "sidebar:import_and_export",
    items: importExportItems,
  });

  return sections;
}

const BOTTOM_ITEMS: NavItem[] = [
  { path: "/configuracion", icon: Settings, labelKey: "sidebar:my_settings" },
];

interface SidebarProps {
  user: SidebarUser;
  tenant: SidebarTenant;
  collapsed: boolean;
  onToggle: () => void;
  /** Possible-duplicates badge count from the layout loader. */
  duplicateCount?: number;
}

const FOLDED_KEY = "fisqua:sidebar:folded";

/** Folded section label keys from storage; empty on any failure. */
export function readFoldedSections(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const raw = (storage ?? window.localStorage).getItem(FOLDED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** Persists the folded section label keys; silent when storage fails. */
export function writeFoldedSections(
  folded: string[],
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage ?? window.localStorage).setItem(FOLDED_KEY, JSON.stringify(folded));
  } catch {
    // Storage unavailable: the fold lasts for this page view only.
  }
}

/**
 * Route families a section owns beyond its own links. A page inside a
 * family keeps its section open: project pages live under `/projects/`
 * while the section links to `/proyectos`, and the capture volume and
 * media routes sit under paths no nav item points at. Items can also
 * be absent for a given role, so the families name the whole area.
 */
const SECTION_ROUTE_FAMILIES: Record<string, string[]> = {
  "sidebar:collaborative_cataloguing": ["/proyectos", "/projects", "/admin/cataloguing"],
  "sidebar:records_management": [
    "/admin/descriptions",
    "/admin/repositories",
    "/admin/vocabularies",
    "/admin/publish",
  ],
  "sidebar:authorities": ["/admin/entities", "/admin/places", "/admin/decisions"],
  "sidebar:digitization": ["/admin/capture", "/admin/media"],
  "sidebar:import_and_export": ["/admin/imports", "/admin/exports"],
};

function underPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** True when the current page is one of the section's items or in its route families. */
export function sectionHoldsPath(section: NavSection, pathname: string): boolean {
  const families = section.labelKey ? SECTION_ROUTE_FAMILIES[section.labelKey] ?? [] : [];
  return (
    section.items.some((item) =>
      item.end ? pathname === item.path : underPath(pathname, item.path),
    ) || families.some((base) => underPath(pathname, base))
  );
}

export function Sidebar(props: SidebarProps) {
  // Everything starts open so the server and the first client render
  // agree; the stored folds are applied after mount.
  const [folded, setFolded] = useState<string[]>([]);

  useEffect(() => {
    setFolded(readFoldedSections());
  }, []);

  function toggleSection(labelKey: string) {
    setFolded((current) => {
      const next = current.includes(labelKey)
        ? current.filter((k) => k !== labelKey)
        : [...current, labelKey];
      writeFoldedSections(next);
      return next;
    });
  }

  return (
    <SidebarView {...props} folded={folded} onToggleSection={toggleSection} />
  );
}

export function SidebarView({
  user,
  tenant,
  collapsed,
  onToggle,
  duplicateCount,
  folded,
  onToggleSection,
}: SidebarProps & {
  folded: string[];
  onToggleSection: (labelKey: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  const { pathname } = useLocation();

  const sections = getSidebarSections(user, tenant, {
    duplicates: duplicateCount,
  });

  return (
    <nav
      aria-label={t("common:aria.main_navigation")}
      className={`flex flex-col border-r border-stone-200 bg-stone-50 transition-all duration-300 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div
        data-testid="sidebar-items"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto py-4"
      >
        {sections.map((section, si) => {
          const label = section.labelKey
            ? t(section.labelKey.replace("sidebar:", ""))
            : undefined;
          // Headings (and so folding) exist only on the expanded rail.
          const foldable = !collapsed && section.labelKey !== undefined;
          const open =
            !foldable ||
            !folded.includes(section.labelKey!) ||
            sectionHoldsPath(section, pathname);
          const panelId = section.labelKey
            ? `sidebar-section-${section.labelKey.replace(/\W+/g, "-")}`
            : undefined;
          return (
            <div key={section.labelKey ?? si}>
              {si > 0 && <div className="mx-4 my-2 border-t border-stone-200" />}
              {foldable && (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  aria-label={t(open ? "section_hide" : "section_show", {
                    section: label,
                  })}
                  onClick={() => onToggleSection(section.labelKey!)}
                  className="mx-6 mb-1 flex w-[calc(100%-3rem)] items-center justify-between text-left font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400 hover:text-stone-600"
                >
                  <span>{label}</span>
                  {open ? (
                    <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                  )}
                </button>
              )}
              <div id={panelId}>
                {open &&
                  section.items.map((item) => (
                    <SidebarNavItem
                      key={item.path}
                      item={item}
                      collapsed={collapsed}
                      t={t}
                    />
                  ))}
              </div>
            </div>
          );
        })}

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
        {/* Same rule as `canManageTenantUsers`, which gates the page. */}
        {(user.isSuperAdmin || user.isUserManager || user.isAdmin) && (
          <SidebarNavItem
            item={{ path: "/admin/users", icon: Users, labelKey: "sidebar:users" }}
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
            <span className="flex-1 font-sans text-sm">
              {t(item.labelKey.replace("sidebar:", ""))}
            </span>
          )}
          {!collapsed && item.badge != null && item.badge > 0 && (
            <span className="rounded-full bg-madder-tint px-2 py-0.5 font-sans text-11 nums font-semibold text-madder-deep">
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// @version v0.8.0
