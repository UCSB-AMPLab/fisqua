/**
 * Miller Item
 *
 * One row inside a Miller column — reference code, title, child-count
 * chevron, and selected/hover state.
 *
 * @version v0.3.0
 */

import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TreeItem } from "./miller-columns";

// ---------------------------------------------------------------------------
// Level badge colour mapping per UI-SPEC
// ---------------------------------------------------------------------------

const LEVEL_BADGE_STYLES: Record<string, string> = {
  fonds: "bg-indigo-tint text-indigo",
  subfonds: "bg-verdigris-tint text-verdigris",
  collection: "bg-verdigris-tint text-verdigris",
  series: "bg-indigo-tint text-indigo",
  subseries: "bg-saffron-tint text-saffron-deep",
  section: "bg-saffron-tint text-saffron-deep",
  volume: "bg-stone-100 text-stone-700",
  file: "bg-stone-100 text-stone-700",
  item: "bg-stone-100 text-stone-500",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MillerItemProps {
  item: TreeItem;
  isSelected: boolean;
  isAncestor: boolean;
  onClick: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MillerItem({
  item,
  isSelected,
  isAncestor,
  onClick,
}: MillerItemProps) {
  const { t } = useTranslation("descriptions_admin");

  const badgeStyle =
    LEVEL_BADGE_STYLES[item.descriptionLevel] || "bg-stone-100 text-stone-500";

  const levelLabel =
    t(`level_${item.descriptionLevel}`, { defaultValue: item.descriptionLevel });

  let containerClass =
    "px-4 py-2 border-b border-stone-100 cursor-pointer transition-colors";

  if (isSelected) {
    containerClass += " bg-indigo-deep text-parchment";
  } else if (isAncestor) {
    containerClass += " bg-indigo/50 text-parchment";
  } else {
    containerClass += " hover:bg-stone-50";
  }

  return (
    <div
      className={containerClass}
      onClick={onClick}
      role="treeitem"
      aria-selected={isSelected}
    >
      <div className="flex items-center gap-2">
        {/* Content area */}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-sans text-sm leading-snug">
            {item.title}
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <span
              className={`text-xs ${isSelected || isAncestor ? "text-white/70" : "text-stone-500"}`}
            >
              {item.referenceCode}
            </span>
          </div>
        </div>

        {/* Level badge */}
        <span
          className={`inline-block flex-none whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
            isSelected || isAncestor
              ? "bg-white/20 text-white"
              : badgeStyle
          }`}
        >
          {levelLabel}
        </span>

        {/* Child count */}
        {item.childCount > 0 && (
          <span
            className={`flex-none text-xs ${
              isSelected || isAncestor ? "text-white/70" : "text-stone-400"
            }`}
          >
            ({item.childCount})
          </span>
        )}

        {/* Expand arrow */}
        {item.childCount > 0 && (
          <ChevronRight
            className={`h-4 w-4 flex-none ${
              isSelected || isAncestor ? "text-white/70" : "text-stone-400"
            }`}
          />
        )}
      </div>
    </div>
  );
}
