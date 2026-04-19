/**
 * Authenticated App Shell
 *
 * The parent route for everything behind login. Runs the auth guard,
 * loads the sidebar payload — projects the caller belongs to, plus
 * admin visibility flags — and renders the three-column shell:
 * sidebar, top bar, outlet. The shell manages the sidebar collapse
 * state and the mobile drawer, exposing both through the outlet
 * context so nested pages can react.
 *
 * @version v0.3.0
 */

import { useState, useEffect } from "react";
import { Form, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { Sidebar } from "../components/layout/sidebar";
import { Footer } from "../components/layout/footer";
import type { Route } from "./+types/_auth";

export const middleware = [
  async (args: any, next: any) => {
    const { authMiddleware } = await import("../middleware/auth.server");
    return authMiddleware(args, next);
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { getAppConfig } = await import("../lib/config.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const { appName } = getAppConfig(env);

  : compute hasAnyProjectMembership so the sidebar can show the
  // Collaborative Cataloguing section to project-member-only users.
  const db = drizzle(env.DB);
  const membershipRows = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))
    .limit(1);
  const hasAnyProjectMembership = membershipRows.length > 0;

  return { user, appName, hasAnyProjectMembership };
}

export default function CatalogacionLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const { t } = useTranslation("common");
  const { t: tDashboard } = useTranslation("dashboard");

  const isViewer = location.pathname.includes("/viewer/");
  const isDescriptionEditor = location.pathname.includes("/describe/");
  const showChrome = !isViewer && !isDescriptionEditor;

  // Sidebar collapse state — initialise false, read localStorage on mount
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

  // Full-page escape for viewer and description editor
  if (!showChrome) {
    return <Outlet />;
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Header bar */}
      <header className="flex h-14 items-center justify-between border-b border-[#E7E5E4] bg-[#FAFAF9] px-4">
        <div className="flex items-center">
          <img src="/pomegranate.svg" alt="" className="h-8" aria-hidden="true" />
          <div className="mx-3 h-6 w-px bg-[#E7E5E4]" aria-hidden="true" />
          <span className="font-sans text-sm text-[#78716C]">
            Fisqua: <strong className="font-semibold">Neogranadina</strong>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-sans text-sm text-[#78716C]">
            {loaderData.user.email}
          </span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="font-sans text-sm font-medium text-[#8B2942] hover:underline"
            >
              {tDashboard("nav.log_out")}
            </button>
          </Form>
        </div>
      </header>

      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          user={{
            isAdmin: loaderData.user.isAdmin,
            isSuperAdmin: loaderData.user.isSuperAdmin,
            isCollabAdmin: loaderData.user.isCollabAdmin,
            isArchiveUser: loaderData.user.isArchiveUser,
            isUserManager: loaderData.user.isUserManager,
            isCataloguer: loaderData.user.isCataloguer,
            hasAnyProjectMembership: loaderData.hasAnyProjectMembership,
          }}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
        />
        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex-1 p-6">
            <Outlet />
          </div>
          <Footer />
        </div>
      </div>
    </div>
  );
}
