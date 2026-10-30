/**
 * Digitization Screens — Shared Parts
 *
 * This module holds the pieces the Volumes screen and the Capture QC
 * queue share: the page header (the section's eyebrow, the page title
 * and its introduction), the empty state, the state badge, and the
 * stacked bar of approved, rejected and undecided openings.
 *
 * The badge keeps the one badge shape of the design system
 * (`BADGE_SHAPE`, uppercase, no dot) and its status colour pairs: stone
 * for received, superseded and the other states nothing is happening
 * to, indigo for work under way (preparing review images, processing),
 * saffron for partial progress (in capture QC), madder for what is sent
 * back or has gone wrong (retakes requested, refused, failed, review
 * images failed),
 * verdigris for approved, and sage for published.
 *
 * @version v0.8.0
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { BADGE_SHAPE } from "../workflow/status-badge";
import type { ScreenState } from "../../lib/capture/screens";

const STATE_STYLES: Record<ScreenState, string> = {
  received: "bg-stone-100 text-stone-600",
  preparing_review: "bg-indigo-tint text-indigo",
  in_capture_qc: "bg-saffron-tint text-saffron-deep",
  retakes_requested: "bg-madder-tint text-madder-deep",
  approved: "bg-verdigris-tint text-verdigris-deep",
  processing: "bg-indigo-tint text-indigo",
  published: "bg-sage-tint text-sage-deep",
  failed: "bg-madder-tint text-madder-deep",
  review_failed: "bg-madder-tint text-madder-deep",
  refused: "bg-madder-tint text-madder-deep",
  superseded: "bg-stone-100 text-stone-600",
};

export function CaptureStateBadge({ state, rejected }: { state: ScreenState; rejected?: number }) {
  const { t } = useTranslation("capture");
  const label =
    state === "retakes_requested" && rejected !== undefined && rejected > 0
      ? t("state.retakes_requested_count", { count: rejected })
      : t(`state.${state}`);
  return <span className={`${BADGE_SHAPE} ${STATE_STYLES[state]}`}>{label}</span>;
}

export function CapturePageHeader({ title, intro }: { title: string; intro: string }) {
  const { t } = useTranslation("sidebar");
  return (
    <header>
      <p className="font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
        {t("digitization")}
      </p>
      <h1 className="mt-1 font-serif text-3xl font-semibold text-stone-700">{title}</h1>
      <p className="mt-2 max-w-2xl font-sans text-sm text-stone-500">{intro}</p>
    </header>
  );
}

export function CaptureEmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body?: ReactNode }) {
  return (
    <div className="mt-6 rounded-lg border border-stone-200 px-5 py-14 text-center">
      <span className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
        <Icon className="h-7 w-7 text-indigo" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <b className="mt-3.5 block font-serif text-lg font-semibold text-indigo">{title}</b>
      {body ? (
        <small className="mx-auto mt-1.5 block max-w-[44ch] font-serif text-sm leading-relaxed text-stone-500">
          {body}
        </small>
      ) : null}
    </div>
  );
}

/**
 * The openings of a delivery as one bar: approved, then rejected for
 * retake, then undecided (the empty track).
 */
export function DecisionBar({ approved, rejected, total }: { approved: number; rejected: number; total: number }) {
  const { t } = useTranslation("capture");
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");
  const none = approved + rejected === 0;
  return (
    <div
      role="img"
      aria-label={none ? t("queue.progress_none") : t("queue.progress_label")}
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-stone-200"
    >
      <div className="bg-verdigris" style={{ width: pct(approved) }} />
      <div className="bg-madder" style={{ width: pct(rejected) }} />
    </div>
  );
}

// @version v0.8.0
