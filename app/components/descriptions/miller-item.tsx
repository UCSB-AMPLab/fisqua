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
  fonds: "bg-[#E0E7F7] text-[#3B5A9A]",
  subfonds: "bg-[#CCF0EB] text-[#0D9488]",
  collection: "bg-[#CCF0EB] text-[#0D9488]",
  series: "bg-[#F5E6EA] text-[#8B2942]",
  subseries: "bg-[#FEF3C7] text-[#78350F]",
  section: "bg-[#FEF3C7] text-[#78350F]",
  volume: "bg-[#F5F5F4] text-[#44403C]",
  file: "bg-[#F5F5F4] text-[#44403C]",
  item: "bg-[#F5F5F4] text-[#78716C]",
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
    LEVEL_BADGE_STYLES[item.descriptionLevel] || "bg-[#F5F5F4] text-[#78716C]";

  const levelLabel =
    t(`level_${item.descriptionLevel}`, { defaultValue: item.descriptionLevel });

  let containerClass =
    "px-4 py-2 border-b border-[#F5F5F4] cursor-pointer transition-colors";

  if (isSelected) {
    containerClass += " bg-[#6B1F33] text-white";
  } else if (isAncestor) {
    containerClass += " bg-[rgba(107,31,51,0.5)] text-white";
  } else {
    containerClass += " hover:bg-[#FAFAF9]";
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
              className={`text-xs ${isSelected || isAncestor ? "text-white/70" : "text-[#78716C]"}`}
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
              isSelected || isAncestor ? "text-white/70" : "text-[#A8A29E]"
            }`}
          >
            ({item.childCount})
          </span>
        )}

        {/* Expand arrow */}
        {item.childCount > 0 && (
          <ChevronRight
            className={`h-4 w-4 flex-none ${
              isSelected || isAncestor ? "text-white/70" : "text-[#A8A29E]"
            }`}
          />
        )}
      </div>
    </div>
  );
}
