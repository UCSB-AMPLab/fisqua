/**
 * Drafts Banner
 *
 * Sticky notice shown above admin tables when unsaved draft records
 * exist. Tells the operator how many drafts are pending and exposes
 * the shortcut to the review surface so no draft disappears off the
 * edge of the screen.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";

interface DraftsBannerProps {
  userName: string;
  updatedAt: number;
  namespace?: string;
}

/**
 * Amber warning banner displayed when another admin has unsaved draft changes
 * on the same record. Renders the conflict_banner i18n key with the conflicting
 * user's name and the timestamp of their last autosave.
 */
export function DraftsBanner({
  userName,
  updatedAt,
  namespace = "descriptions_admin",
}: DraftsBannerProps) {
  const { t } = useTranslation(namespace);

  return (
    <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3 text-sm text-saffron-deep">
      {t("conflict_banner", {
        name: userName,
        time: new Date(updatedAt).toLocaleString(),
      })}
    </div>
  );
}
