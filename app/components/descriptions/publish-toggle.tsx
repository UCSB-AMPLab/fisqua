/**
 * Publish Toggle
 *
 * This toggle is the switch that flips a description's `isPublished` flag
 * inline without leaving the edit page. Publishing is administration:
 * with `canChange` false (a federation staff grant, say) it shows the
 * status badge alone, with no control.
 *
 * Its fetcher has a key per description (`publishToggleKey`), so the
 * description page can read the toggle's response, the versions it
 * moved the record from and to, for the edit form's version. The
 * button is enabled only while that fetcher is idle: a second
 * submission in flight would supersede the first's response although
 * its write committed, and the form could not follow that move.
 *
 * @version v0.9.0
 */

import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  StatusBadge,
  getPublishStatus,
} from "~/components/descriptions/status-badges";

/** The key of the publish toggle's fetcher for a description. */
export function publishToggleKey(descriptionId: string): string {
  return `publish-toggle:${descriptionId}`;
}

/** Whether the toggle takes a submission, given its fetcher's state. */
export function publishToggleEnabled(state: "idle" | "submitting" | "loading"): boolean {
  return state === "idle";
}

// ---------------------------------------------------------------------------
// PublishToggle
// ---------------------------------------------------------------------------

interface PublishToggleProps {
  descriptionId: string;
  isPublished: boolean;
  lastExportedAt: number | null;
  updatedAt: number;
  /** Whether the viewer may publish or unpublish; false shows the badge alone. */
  canChange?: boolean;
}

export function PublishToggle({
  descriptionId,
  isPublished,
  lastExportedAt,
  updatedAt,
  canChange = true,
}: PublishToggleProps) {
  const { t } = useTranslation("descriptions_admin");
  const fetcher = useFetcher({ key: publishToggleKey(descriptionId) });

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
      {canChange && (
      <fetcher.Form method="post">
        <input type="hidden" name="_action" value="toggle_publish" />
        <input type="hidden" name="descriptionId" value={descriptionId} />
        <button
          type="submit"
          disabled={!publishToggleEnabled(fetcher.state)}
          className="text-xs font-medium text-indigo-deep underline hover:text-indigo disabled:cursor-wait disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </fetcher.Form>
      )}
    </div>
  );
}

// @version v0.9.0
