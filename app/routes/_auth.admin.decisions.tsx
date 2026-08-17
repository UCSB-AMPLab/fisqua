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
 * Gating. The layout carries the admin guard the sibling admin routes
 * carry and nothing else, because the three tabs are gated on DIFFERENT
 * capabilities: proposals and duplicates on `authorities`, vocabulary
 * on `vocabulary_hub`. Each child loader keeps its own
 * `requireCapability` call — the gate that was already protecting the
 * page before it moved — and the tab bar simply omits a tab whose
 * capability is off, so a tenant never sees a tab that would 404.
 *
 * @version v0.7.0
 */

import { Outlet, NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { hasCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.decisions";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  // Which tabs this tenant may reach at all. Computed here rather than
  // in each child so the bar never renders a link into a 404.
  return {
    authorities: hasCapability(tenant, "authorities"),
    vocabulary: hasCapability(tenant, "vocabulary_hub"),
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
