/**
 * Dashboard Section
 *
 * Generic two-column layout wrapper for a dashboard section: a title,
 * an optional call-to-action link, and either one or two content
 * columns. Lets the member dashboard compose Segmentation, Description,
 * and Messages with consistent spacing.
 *
 * @version v0.3.0
 */
import type { ReactNode } from "react";

interface DashboardSectionProps {
  id: string;
  title: string;
  myWorkLabel: string;
  toReviewLabel: string;
  myWorkItems: ReactNode;
  toReviewItems: ReactNode | null;
  myWorkEmpty: string;
  toReviewEmpty: string;
  showToReview: boolean;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-[#E7E5E4] bg-white p-6 text-center text-sm text-[#78716C]">
      {message}
    </div>
  );
}

export function DashboardSection({
  id,
  title,
  myWorkLabel,
  toReviewLabel,
  myWorkItems,
  toReviewItems,
  myWorkEmpty,
  toReviewEmpty,
  showToReview,
}: DashboardSectionProps) {
  const hasMyWork = myWorkItems !== null && myWorkItems !== undefined;
  const hasToReview = toReviewItems !== null && toReviewItems !== undefined;

  return (
    <section id={id}>
      <h2 className="font-serif text-lg font-semibold text-stone-900">
        {title}
      </h2>

      {showToReview ? (
        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* My work column */}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-[#44403C]">
              {myWorkLabel}
            </h3>
            <div className="space-y-3">
              {hasMyWork ? myWorkItems : <EmptyState message={myWorkEmpty} />}
            </div>
          </div>

          {/* To review column */}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-[#44403C]">
              {toReviewLabel}
            </h3>
            <div className="space-y-3">
              {hasToReview ? toReviewItems : <EmptyState message={toReviewEmpty} />}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {hasMyWork ? myWorkItems : <EmptyState message={myWorkEmpty} />}
        </div>
      )}
    </section>
  );
}
