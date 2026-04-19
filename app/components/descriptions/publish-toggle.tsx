/**
 * Publish Toggle
 *
 * Switch that flips a description's `isPublished` flag inline without
 * leaving the edit page.
 *
 * @version v0.3.0
 */

import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  StatusBadge,
  getPublishStatus,
} from "~/components/descriptions/status-badges";

// ---------------------------------------------------------------------------
// PublishToggle
// ---------------------------------------------------------------------------

interface PublishToggleProps {
  descriptionId: string;
  isPublished: boolean;
  lastExportedAt: number | null;
  updatedAt: number;
}

export function PublishToggle({
  descriptionId,
  isPublished,
  lastExportedAt,
  updatedAt,
}: PublishToggleProps) {
  const { t } = useTranslation("descriptions_admin");
  const fetcher = useFetcher();

  // Optimistic: if a submission is in flight, flip the displayed state
  const optimisticPublished =
    fetcher.state !== "idle" ? !isPublished : isPublished;

  const actionLabel = optimisticPublished
    ? t("unpublish_action")
    : t("publish_action");

  return (
    <div className="flex items-center gap-2">
      <StatusBadge
        isPublished={optimisticPublished}
        lastExportedAt={lastExportedAt}
        updatedAt={updatedAt}
      />
      <fetcher.Form method="post">
        <input type="hidden" name="_action" value="toggle_publish" />
        <input type="hidden" name="descriptionId" value={descriptionId} />
        <button
          type="submit"
          className="text-xs font-medium text-[#6B1F33] underline hover:text-[#8B2942]"
        >
          {actionLabel}
        </button>
      </fetcher.Form>
    </div>
  );
}
