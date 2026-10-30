/**
 * Pending Decisions Layout
 *
 * This layout is the parent route for the Pending decisions surface —
 * the one place a workspace answers the questions its own tooling
 * could not answer for it. Three tabs, three kinds of question:
 *
 *   Proposals          authority records an import or bulk load
 *                      proposed but could not resolve; ruled accept /
 *                      amend / reject against `pending_decisions`.
 *   Possible duplicates  the deterministic duplicates scan over
 *                      entities and places, with the persisted
 *                      "not a duplicate" subtracted.
 *   Vocabulary         the draft vocabulary terms awaiting review,
 *                      moved here from the vocabularies hub. Its own
 *                      status machine is untouched by the move.
 *
 * Gating. The tabs belong to two areas: proposals and duplicates to
 * authorities, vocabulary to records. The layout admits a user who
 * administers either area and refuses everyone else with a 403. Each
 * child loader carries its own area guard and its own
 * `requireCapability` call, and the tab bar shows a tab only when the
 * tenant has its capability and the user administers its area, so no
 * one sees a tab that would 404 or 403.
 *
 * @version v0.8.0
 */

import { Outlet, NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { hasCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.decisions";

export async function loader({ context }: Route.LoaderArgs) {
  const { canAdministerArea } = await import("../lib/user-access.server");

  const user = context.get(userContext);
  const authoritiesAdmin = canAdministerArea(user, "authorities");
  const recordsAdmin = canAdministerArea(user, "records");
  if (!authoritiesAdmin && !recordsAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

  // Which tabs this user may reach on this tenant. Computed here rather
  // than in each child so the bar never renders a link into a 404 or
  // a 403.
  return {
    authorities: authoritiesAdmin && hasCapability(tenant, "authorities"),
    vocabulary: recordsAdmin && hasCapability(tenant, "vocabulary_hub"),
  };
}

export default function AdminDecisionsLayout({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("decisions");
  const { authorities, vocabulary } = loaderData;

  const tabs = [
    {
      to: "/admin/decisions",
      label: t("tabProposals"),
      end: true,
      show: authorities,
    },
    {
      to: "/admin/decisions/duplicates",
      label: t("tabDuplicates"),
      end: false,
      show: authorities,
    },
    {
      to: "/admin/decisions/vocabulary",
      label: t("tabVocabulary"),
      end: false,
      show: vocabulary,
    },
  ].filter((tab) => tab.show);

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-7">
      <h1 className="font-serif text-[2rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {t("surfaceName")}
      </h1>
      <p className="mt-2 max-w-[60ch] font-serif text-base leading-[1.6] text-indigo-soft">
        {t("surfaceIntro")}
      </p>

      <nav className="mt-4 flex border-b border-stone-200">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              `px-4 py-3 text-sm transition-colors duration-150 ${
                isActive
                  ? "border-b-2 border-indigo font-semibold text-stone-700"
                  : "font-normal text-stone-500 hover:text-stone-700"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
