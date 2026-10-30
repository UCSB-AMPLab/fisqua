/**
 * No Access Page
 *
 * This page is the terminal surface shown when an authenticated member
 * holds nothing that would grant access to the workspace: no role flag,
 * no project membership in it and no federation grant into it. It
 * explains the state in the member's language; the top bar's Log out
 * stays available. A Reader is not sent here: they hold a role, and
 * land on `/records`.
 *
 * Members reach it through `confineMemberAccess`, the `_auth` layout's
 * second middleware, which sends such a member's page requests here
 * from every other path except their settings.
 *
 * @version v0.8.0
 */

import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.no-access";

export async function loader({ context }: Route.LoaderArgs) {
  // Landing page for members with no role, project membership or grant.
  // Intentionally no role check: the layout's middleware sends them here,
  // and a member who has access since gained is not harmed by reading it.
  const user = context.get(userContext);
  return { email: user.email };
}

export default function NoAccessPage() {
  const { t } = useTranslation("no_access");

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center shadow-sm ring-1 ring-stone-100">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
            <ShieldAlert className="h-8 w-8 text-indigo" strokeWidth={1.5} />
          </div>
          <h1 className="mt-4 font-serif text-lg font-semibold text-indigo">
            {t("title")}
          </h1>
          <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">{t("description")}</p>
        </div>
      </div>
    </div>
  );
}

// @version v0.8.0
