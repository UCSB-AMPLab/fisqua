/**
 * No-Access Landing Page
 *
 * The soft landing for an authenticated user who holds no role flags
 * and belongs to no project. Rather than surface a confusing empty
 * dashboard or a raw 403, the auth layout sends them here so they see
 * a clear "you are signed in, but there is nothing for you yet"
 * message. Useful during onboarding -- an admin may have created the
 * account but not yet granted a role -- and as a graceful fallback
 * for the reserved `isArchiveUser` role which has no UI surface of
 * its own.
 *
 * The loader intentionally performs no role check. Routing the user
 * here is the `_auth.tsx` layout's responsibility; this file only
 * renders the page.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.no-access";

export async function loader({ context }: Route.LoaderArgs) {
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
