/**
 * Reviewer dashboard view.
 * Shows assigned volumes grouped by review status:
 * 1. Awaiting review (segmented) with waiting-time badges
 * 2. Reviewed
 * 3. Approved
 */

import {
  VolumeStatusCard,
  daysSince,
  type VolumeCardData,
} from "./volume-status-card";

export type ReviewerGroups = {
  awaitingReview: VolumeCardData[];
  reviewed: VolumeCardData[];
  approved: VolumeCardData[];
};

type ReviewerDashboardProps = {
  groups: ReviewerGroups;
};

function WaitingBadge({ days }: { days: number }) {
  const urgent = days >= 3;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        urgent
          ? "bg-red-100 text-red-700"
          : "bg-amber-100 text-amber-700"
      }`}
    >
      {days === 0 ? "Today" : `${days}d waiting`}
    </span>
  );
}

function ReviewGroup({
  title,
  volumes,
  showWaiting,
}: {
  title: string;
  volumes: VolumeCardData[];
  showWaiting?: boolean;
}) {
  if (volumes.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
        {title}
        <span className="ml-2 text-xs font-normal">({volumes.length})</span>
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {volumes.map((v) => (
          <div key={v.id} className="relative">
            {showWaiting && (
              <div className="absolute right-2 top-2 z-10">
                <WaitingBadge days={daysSince(v.updatedAt)} />
              </div>
            )}
            <VolumeStatusCard volume={v} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ReviewerDashboard({ groups }: ReviewerDashboardProps) {
  const totalVolumes =
    groups.awaitingReview.length +
    groups.reviewed.length +
    groups.approved.length;

  if (totalVolumes === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-sm text-stone-500">No volumes to review yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <ReviewGroup
        title="Awaiting review"
        volumes={groups.awaitingReview}
        showWaiting
      />
      <ReviewGroup title="Reviewed" volumes={groups.reviewed} />
      <ReviewGroup title="Approved" volumes={groups.approved} />
    </div>
  );
}
