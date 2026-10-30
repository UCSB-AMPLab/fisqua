/**
 * Authenticated App Shell
 *
 * This layout is the parent route for everything behind login. It
 * runs the auth guard, loads the sidebar payload — projects the
 * caller belongs to, plus
 * admin visibility flags — and renders the three-column shell:
 * sidebar, top bar, outlet. The shell manages the sidebar collapse
 * state and the mobile drawer, exposing both through the outlet
 * context so nested pages can react.
 *
 * The loader reads `tenantContext` (populated by `authMiddleware`
 * after resolving the request `Host` header) and surfaces the
 * capability flags to the `<Sidebar>` so capability-off nav surfaces
 * are hidden. On a tenant with the digitization capability it also
 * reads whether the user manages capture work or reviews one of the
 * tenant's volumes, which decides the Digitization section's items.
 *
 * Two middlewares run before any loader or action under this layout:
 * `authMiddleware`, which resolves the user and tenant, then
 * `confineMemberAccess`, which keeps a Reader with no other role on
 * `/records` and a member with no role, project membership or grant on
 * `/no-access` (both may also open their settings). The loader passes
 * the same kind of member (`access`) to the sidebar, which shows each
 * kind only what it can open.
 *
 * @version v0.8.0
 */

import { useState, useEffect } from "react";
import { Form, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
} from "../context";
import { Sidebar } from "../components/layout/sidebar";
import { Footer } from "../components/layout/footer";
import { ImpersonationBanner } from "../components/layout/impersonation-banner";
import { WorkspaceSwitcher } from "../components/layout/workspace-switcher";
import type { Route } from "./+types/_auth";

export const middleware = [
  async (args: any, next: any) => {
    const { authMiddleware } = await import("../middleware/auth.server");
    return authMiddleware(args, next);
  },
  // Keeps a Reader with no other role inside /records and a member with
  // no role, project membership or grant on /no-access.
  async (args: any, next: any) => {
    const { confineMemberAccess } = await import("../lib/reader.server");
    return confineMemberAccess(args, next);
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { getAppConfig } = await import("../lib/config.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { projectMembers, projects } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  // Read the impersonation envelope so the layout can render the
  // persistent banner. Always populated (the middleware attaches
  // `null` when no envelope is active) per the
  // `impersonationContext` contract in `app/context.ts`.
  const impersonating = context.get(impersonationContext);
  const env = context.cloudflare.env;
  const { appName } = getAppConfig(env);

  // Compute hasAnyProjectMembership so the sidebar can show the
  // Collaborative Cataloguing section to project-member-only users.
  // Memberships held on other tenants' projects must not raise the
  // section here: it is the affordance that leads into the
  // crowdsourcing tree, and on this host that tree holds this
  // tenant's work only.
  const db = drizzle(env.DB);
  const membershipRows = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(
      and(
        eq(projectMembers.userId, user.id),
        eq(projects.tenantId, tenant.id),
      ),
    )
    .limit(1);
  const hasAnyProjectMembership = membershipRows.length > 0;

  // What kind of member this is, for the sidebar: a Reader with no
  // other role sees only the records pages, a member with no access
  // sees none. The same rule `confineMemberAccess` enforces.
  const { memberAccess } = await import("../lib/reader.server");
  const access = await memberAccess(db, tenant, user, {
    hasGrant: context.get(grantContext) !== null,
    isImpersonating: impersonating !== null,
  });

  // Surface only the capability flags the sidebar needs;
  // structurally matches `SidebarTenant` so the prop typecheck is a
  // simple shape match rather than a wider Tenant cast. Keeping the
  // payload narrow also avoids accidentally serialising capability
  // flags that future surfaces gate on but the layout itself does
  // not consume.
  const tenantCaps = {
    crowdsourcingEnabled: tenant.crowdsourcingEnabled,
    vocabularyHubEnabled: tenant.vocabularyHubEnabled,
    publishPipelineEnabled: tenant.publishPipelineEnabled,
    multiRepositoryEnabled: tenant.multiRepositoryEnabled,
    authoritiesEnabled: tenant.authoritiesEnabled,
    importsEnabled: tenant.importsEnabled,
    digitizationEnabled: tenant.digitizationEnabled,
  };

  // Who the user is to capture work, for the Digitization section: read
  // only where the capability is on, since the section is gone elsewhere.
  let capture = { manager: false, reviewer: false };
  if (tenant.digitizationEnabled) {
    const { captureAccess } = await import("../lib/capture/screens.server");
    capture = await captureAccess(db, tenant, user);
  }

  // Pending-decisions badge for its sidebar entry: the whole open
  // queue, not one tab — candidate duplicate pairs plus open authority
  // proposals plus proposed vocabulary terms. Computed only for those
  // who pass the authorities area on authorities-on tenants AND only while the current request is
  // inside the authorities section: the duplicates part is two
  // GROUP BY scans over lower(display_name) (which no index serves)
  // plus a join over the separate ledger rows, and running that on
  // every admin navigation is disproportionate for a badge. Pages
  // outside /admin/entities, /admin/places, and /admin/decisions
  // render the nav entry without a pill; within the section the pill
  // is always fresh.
  // The duplicates part is the CHEAP approximation (exact
  // lowercase-name collision pairs minus dismissed pairs), not the
  // worklist's accent-normalised number; see `getDuplicateBadgeCounts`.
  let duplicateCount = 0;
  const { canAdministerArea } = await import("../lib/user-access.server");
  const pathname = new URL(request.url).pathname;
  const inAuthoritiesSection =
    pathname.startsWith("/admin/entities") ||
    pathname.startsWith("/admin/places") ||
    pathname.startsWith("/admin/decisions");
  if (
    inAuthoritiesSection &&
    tenant.authoritiesEnabled &&
    canAdministerArea(user, "authorities")
  ) {
    const { getDuplicateBadgeCounts } = await import(
      "../lib/authority-duplicates.server"
    );
    const { loadPendingDecisionCounts } = await import(
      "../lib/pending-decisions.server"
    );
    // Duplicates are counted over what this tenant can see: the shared
    // space and its own records, never another tenant's private ones.
    // Vocabulary proposals join the count only for someone who can open
    // the vocabulary tab (the records area, on a tenant with the hub).
    const [counts, pending] = await Promise.all([
      getDuplicateBadgeCounts(db, tenant.federationId, tenant.id),
      loadPendingDecisionCounts(db, tenant),
    ]);
    const vocabularyTab =
      canAdministerArea(user, "records") && tenant.vocabularyHubEnabled;
    duplicateCount =
      counts.entities +
      counts.places +
      pending.authorityProposals +
      (vocabularyTab ? pending.vocabularyProposals : 0);
  }

  // Surface a narrow `impersonating` payload for the banner. Empty
  // shape (null) when no envelope is active. We deliberately do NOT
  // expose `sessionId` or `lastActivityAt` to client-side render —
  // role + tenant name are sufficient for the banner copy.
  const impersonatingForBanner = impersonating
    ? { role: impersonating.role, tenantName: tenant.name }
    : null;

  // Workspace switcher (multi-workspace users only): the user's home
  // tenant plus every active tenant in a federation they hold a grant
  // into. Single-workspace users get `null` and the top bar renders
  // the tenant name as plain text — the switcher affordance exists
  // only where there is somewhere to switch to. Links are absolute
  // (sessions are host-scoped; a first hop may ask for a sign-in).
  let workspaces: Array<{ name: string; url: string; current: boolean }> | null =
    null;
  {
    const { federationMemberships, tenants } = await import("../db/schema");
    const { inArray, isNull, and: andOp, eq: eqOp } = await import("drizzle-orm");
    const grants = await db
      .select({ federationId: federationMemberships.federationId })
      .from(federationMemberships)
      .where(eqOp(federationMemberships.userId, user.id))
      .all();
    if (grants.length > 0) {
      const fedIds = grants.map((g) => g.federationId);
      const reachable = await db
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
        .from(tenants)
        .where(
          andOp(
            inArray(tenants.federationId, fedIds),
            eqOp(tenants.status, "active"),
            isNull(tenants.disabledAt),
          ),
        )
        .all();
      const home = await db
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
        .from(tenants)
        .where(eqOp(tenants.id, user.tenantId))
        .get();
      const byId = new Map(reachable.map((t) => [t.id, t]));
      if (home) byId.set(home.id, home);
      if (byId.size > 1) {
        const reqUrl = new URL(request.url);
        const hostSuffix = reqUrl.hostname.split(".").slice(1).join(".");
        workspaces = [...byId.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t2) => ({
            name: t2.name,
            url: `${reqUrl.protocol}//${t2.slug}.${hostSuffix}${reqUrl.port ? ":" + reqUrl.port : ""}/dashboard`,
            current: t2.id === tenant.id,
          }));
      }
    }
  }

  return {
    user,
    appName,
    tenantName: tenant.name,
    workspaces,
    hasAnyProjectMembership,
    access,
    tenant: tenantCaps,
    impersonating: impersonatingForBanner,
    duplicateCount,
    capture,
  };
}

export default function CatalogacionLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const { t } = useTranslation("common");
  const { t: tDashboard } = useTranslation("dashboard");

  // Detect the focused work surfaces — volume viewer, description
  // editor and capture QC viewer. Their URL paths are
  // /projects/:projectId/volumes/:volumeId,
  // /projects/:projectId/describe/:entryId and
  // /admin/capture/qc/:volumeId; matching by file name
  // substrings ("/viewer/", "/describe/") miss the volume URL because
  // the route file name contains "viewer" but the URL does not.
  const isViewer = /^\/projects\/[^/]+\/volumes\/[^/]+\/?$/.test(
    location.pathname,
  );
  const isDescriptionEditor = /^\/projects\/[^/]+\/describe\/[^/]+\/?$/.test(
    location.pathname,
  );
  const isCaptureViewer = /^\/admin\/capture\/qc\/[^/]+\/?$/.test(location.pathname);
  // All three render their own full-height layouts, so the chrome's content
  // slot drops its padding and overflow behaviour for them and defaults
  // the sidebar to its narrow rail to maximise working space.
  const isFocusedSurface = isViewer || isDescriptionEditor || isCaptureViewer;

  // Sidebar collapse state — initialise false, read localStorage on mount
  const [collapsed, setCollapsed] = useState(false);
  // Per-visit override for focused surfaces. The narrow rail is the
  // default on viewer/describer, but the toggle still works; resets to
  // `null` (i.e. back to default) when navigating between focused and
  // non-focused routes so the saved preference doesn't get clobbered.
  const [focusedOverride, setFocusedOverride] = useState<boolean | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    setFocusedOverride(null);
  }, [isFocusedSurface]);

  const effectiveCollapsed = isFocusedSurface
    ? (focusedOverride ?? true)
    : collapsed;

  const toggleCollapsed = () => {
    if (isFocusedSurface) {
      setFocusedOverride((prev) => !(prev ?? true));
      return;
    }
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Persistent impersonation banner. Renders above the existing
          chrome on every tenant subdomain page during an operator
          impersonation envelope. Cannot be dismissed; the only exit
          is the End-impersonation button which posts to
          `/end-impersonation`. */}
      {loaderData.impersonating ? (
        <ImpersonationBanner
          role={loaderData.impersonating.role}
          tenantName={loaderData.impersonating.tenantName}
        />
      ) : null}
      {/* Header bar — wordmark in verdigris (Spectral 22px), partner
          name in stone-500 sans. Per design-system §Chrome. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-stone-200 bg-stone-50 px-4">
        <div className="flex items-center">
          <img
            src="/brand/fisqua-mark.svg"
            alt=""
            className="h-7 w-7"
            aria-hidden="true"
          />
          <span className="ml-2 font-display text-2xl font-semibold leading-none text-verdigris">
            Fisqua
          </span>
          <div className="mx-3 h-5 w-px bg-stone-200" aria-hidden="true" />
          <WorkspaceSwitcher />
        </div>
        <div className="flex items-center gap-3">
          <span className="font-sans text-sm text-stone-500">
            {loaderData.user.email}
          </span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="font-sans text-sm font-medium text-indigo hover:underline"
            >
              {tDashboard("nav.log_out")}
            </button>
          </Form>
        </div>
      </header>

      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {isFocusedSurface ? (
          // On focused surfaces the sidebar floats above the work area
          // when expanded, so the viewer/describer keeps its column
          // widths instead of reflowing. The fixed-width 64 px slot in
          // the flex row matches the collapsed rail; the absolute layer
          // overlays when the user expands.
          <div className="relative w-16 shrink-0">
            <div className="absolute inset-y-0 left-0 z-30 flex">
              <Sidebar
                user={{
                  isAdmin: loaderData.user.isAdmin,
                  isSuperAdmin: loaderData.user.isSuperAdmin,
                  isCollabAdmin: loaderData.user.isCollabAdmin,
                  isArchiveUser: loaderData.user.isArchiveUser,
                  isUserManager: loaderData.user.isUserManager,
                  isCataloguer: loaderData.user.isCataloguer,
                  isRecordsAdmin: loaderData.user.isRecordsAdmin,
                  isAuthoritiesAdmin: loaderData.user.isAuthoritiesAdmin,
                  isImportsAdmin: loaderData.user.isImportsAdmin,
                  hasAnyProjectMembership: loaderData.hasAnyProjectMembership,
                  access: loaderData.access,
                  isCaptureManager: loaderData.capture.manager,
                  isCaptureReviewer: loaderData.capture.reviewer,
                }}
                tenant={loaderData.tenant}
                collapsed={effectiveCollapsed}
                onToggle={toggleCollapsed}
                duplicateCount={loaderData.duplicateCount}
              />
            </div>
          </div>
        ) : (
          <Sidebar
            user={{
              isAdmin: loaderData.user.isAdmin,
              isSuperAdmin: loaderData.user.isSuperAdmin,
              isCollabAdmin: loaderData.user.isCollabAdmin,
              isArchiveUser: loaderData.user.isArchiveUser,
              isUserManager: loaderData.user.isUserManager,
              isCataloguer: loaderData.user.isCataloguer,
              isRecordsAdmin: loaderData.user.isRecordsAdmin,
              isAuthoritiesAdmin: loaderData.user.isAuthoritiesAdmin,
              isImportsAdmin: loaderData.user.isImportsAdmin,
              hasAnyProjectMembership: loaderData.hasAnyProjectMembership,
              access: loaderData.access,
              isCaptureManager: loaderData.capture.manager,
              isCaptureReviewer: loaderData.capture.reviewer,
            }}
            tenant={loaderData.tenant}
            collapsed={effectiveCollapsed}
            onToggle={toggleCollapsed}
            duplicateCount={loaderData.duplicateCount}
          />
        )}
        <div
          className={
            isFocusedSurface
              ? "flex min-w-0 flex-1 flex-col"
              : "relative flex flex-1 flex-col"
          }
        >
          <div
            className={
              isFocusedSurface
                ? "min-h-0 flex-1"
                : "flex-1 overflow-y-auto px-6 pb-16 pt-6"
            }
          >
            <Outlet />
          </div>
          {!isFocusedSurface && <Footer />}
        </div>
      </div>
    </div>
  );
}

// @version v0.8.0
