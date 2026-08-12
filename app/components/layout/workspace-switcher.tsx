/**
 * Workspace name / switcher
 *
 * Renders the current workspace's name in the top bar. For users who can
 * reach more than one workspace (their home tenant plus any tenant in a
 * federation they hold a grant into — computed by the `_auth` layout
 * loader), the name becomes a dropdown listing every reachable workspace.
 * Single-workspace users get plain text: the affordance exists only where
 * there is somewhere to switch to (ruled 2026-08-11).
 *
 * Links are absolute URLs across subdomains. Sessions are host-scoped by
 * design, so a first visit to another workspace may present its sign-in
 * page; a session-carrying handoff is a planned follow-up, not this
 * component's concern.
 *
 * Reads the `_auth` layout's loader data via `useRouteLoaderData` so any
 * header variant (layout chrome, dashboard top bar) renders it without
 * prop-plumbing. Falls back to plain text when the data is absent.
 *
 * @version v0.6.1
 */

import { useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";

type AuthLoaderData = {
  tenantName?: string;
  workspaces?: Array<{ name: string; url: string; current: boolean }> | null;
};

export function WorkspaceSwitcher() {
  const { t } = useTranslation("dashboard");
  const data = useRouteLoaderData("routes/_auth") as AuthLoaderData | undefined;
  const tenantName = data?.tenantName ?? "";
  const workspaces = data?.workspaces ?? null;

  if (!workspaces || workspaces.length < 2) {
    return (
      <span className="font-sans text-sm text-stone-500">{tenantName}</span>
    );
  }

  return (
    <details className="group relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-1 font-sans text-sm text-stone-500 [&::-webkit-details-marker]:hidden"
        aria-label={t("nav.switch_workspace")}
      >
        {tenantName}
        <svg
          className="h-3.5 w-3.5 text-stone-400 transition-transform group-open:rotate-180"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </summary>
      <ul className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-md border border-stone-200 bg-white py-1 shadow-lg">
        {workspaces.map((w) => (
          <li key={w.url}>
            {w.current ? (
              <span className="block px-3 py-1.5 font-sans text-sm font-semibold text-stone-700">
                {w.name}
              </span>
            ) : (
              <a
                href={w.url}
                className="block px-3 py-1.5 font-sans text-sm text-stone-600 no-underline hover:bg-stone-50"
              >
                {w.name}
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
