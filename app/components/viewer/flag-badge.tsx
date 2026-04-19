/**
 * Flag Badge
 *
 * Per-page badge that surfaces the count of open QC flags on that
 * page. Clicking the badge opens the per-page QC panel; the badge
 * hides when there are no open flags.
 *
 * @version v0.3.0
 */
import { Flag } from "lucide-react";

export type FlagBadgeProps = {
  count: number;
  onClick?: () => void;
  "aria-label"?: string;
};

/**
 * Pure predicate: should the outer badge render?
 *
 * Rule: hide the badge when `count === 0`, otherwise show it.
 * Non-integer or negative counts (e.g. from a bad loader) also hide it
 * defensively. Exported so tests pin without rendering.
 */
export function shouldRenderFlagBadge(count: number): boolean {
  if (!Number.isFinite(count)) return false;
  if (count === 0) return false;
  return count > 0;
}

export function FlagBadge({
  count,
  onClick,
  "aria-label": ariaLabel,
}: FlagBadgeProps) {
  if (!shouldRenderFlagBadge(count)) return null;

  return (
 <button
 type="button"
 onClick={onClick}
 aria-label={ariaLabel ?? "open-flag-badge"}
 className="relative inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#8B2942] text-white transition-colors hover:bg-[#6e2034] focus:outline-none focus:ring-2 focus:ring-[#8B2942]/40"
 >
 <Flag size={16} color="#FFFFFF" aria-hidden="true" />
 {/* Count bubble -- shown unconditionally once the outer badge is
 visible. No "two-or-more" gate: a single open flag
 still surfaces the exact count. */}
 <span
 className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-[#8B2942] bg-white px-1 font-['DM_Sans'] text-[10px] font-bold text-[#8B2942]"
 >
 {count}
 </span>
 </button>
  );
}

