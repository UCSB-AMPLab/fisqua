/**
 * Miller Item
 *
 * This component is one row inside a Miller column — reference code,
 * title, level pill, child-count chevron, and selected/hover state. Inside the
 * Descriptions screen's actions provider a description row also carries
 * the small actions button (`DescriptionActionsTrigger`), which opens
 * the add-to-handlist and add-to-queue menu without selecting the row;
 * a repository row carries none.
 *
 * The title takes the full width of the first line, up to two lines.
 * The level pill follows the reference code on the second line and
 * wraps below it when the level name is long; the right side of the
 * first line holds only the child count, the actions button and the
 * chevron.
 *
 * @version v0.9.0
 */

import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TreeItem } from "./miller-columns";
import { DescriptionActionsTrigger } from "./description-actions";

// ---------------------------------------------------------------------------
// Level badge colour mapping
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
          {/* Second line: reference code, then the level pill. The pill
              sits here, not beside the title, so a long description-level name
              never takes width from the title. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={`text-xs ${isSelected || isAncestor ? "text-white/70" : "text-stone-500"}`}
            >
              {item.referenceCode}
            </span>
            <span
              data-testid="level-pill"
              className={`inline-block rounded-full px-1.5 py-px text-10 font-medium ${
                isSelected || isAncestor
                  ? "bg-white/20 text-white"
                  : badgeStyle
              }`}
            >
              {levelLabel}
            </span>
          </div>
        </div>

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

        <DescriptionActionsTrigger target={item} tone={isSelected || isAncestor ? "dark" : "light"} />

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

// @version v0.9.0
