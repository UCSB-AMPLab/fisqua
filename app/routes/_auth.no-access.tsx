/**
 * No Access Page
 *
 * Terminal surface shown when an authenticated user does not hold
 * any role that would grant access to the app. Explains the state
 * in both English and Spanish and offers the operator a sign-out
 * link. Never rendered through normal navigation — only reached
 * via a redirect from role-aware loaders.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.no-access";

export async function loader({ context }: Route.LoaderArgs) {
  // Fall-through landing page for authenticated users with no assigned role.
  // Intentionally no role check — this is where the auth layout sends
  // placeholder isArchiveUser-only users.
  const user = context.get(userContext);
  return { email: user.email };
}

export default function NoAccessPage() {
  const { t } = useTranslation("no_access");

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center shadow-sm ring-1 ring-stone-100">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-pale-rose to-white">
            <ShieldAlert className="h-8 w-8 text-burgundy" strokeWidth={1.5} />
          </div>
          <h1 className="mt-4 font-serif text-lg font-semibold text-stone-900">
            {t("title")}
          </h1>
          <p className="mt-2 text-sm text-stone-500">{t("description")}</p>
        </div>
      </div>
    </div>
  );
}
