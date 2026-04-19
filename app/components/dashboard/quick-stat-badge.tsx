/**
 * Quick Stat Badge
 *
 * Inline pill that pairs a small icon with a number and label. Used
 * inside project cards, dashboard sections, and anywhere a terse
 * count needs its own visual footprint.
 *
 * @version v0.3.0
 */
import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";

type QuickStatBadgeProps = {
  icon: LucideIcon;
  label: string;
  value: number;
  href: string;
};

export function QuickStatBadge({ icon: Icon, label, value, href }: QuickStatBadgeProps) {
  return (
    <Link
      to={href}
      className="rounded-lg border border-[#E7E5E4] bg-white p-4 hover:shadow-sm transition-shadow"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#F5E6EA]">
          <Icon className="h-5 w-5 text-[#8B2942]" />
        </div>
        <div>
          <p className="font-serif text-lg font-semibold text-[#8B2942]">{value}</p>
          <p className="text-xs text-[#A8A29E]">{label}</p>
        </div>
      </div>
    </Link>
  );
}
