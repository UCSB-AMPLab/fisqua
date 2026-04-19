/**
 * Category Filter Chips
 *
 * Horizontal strip of toggleable category chips used on the
 * vocabularies admin surfaces to narrow the terms list. Controls
 * its own keyboard focus ring so the chip row behaves like a single
 * listbox for screen readers.
 *
 * @version v0.3.0
 */

import type { TFunction } from "i18next";

interface CategoryFilterChipsProps {
  categories: readonly string[];
  selected: string | null;
  onChange: (category: string | null) => void;
  t: TFunction;
}

export function CategoryFilterChips({
  categories,
  selected,
  onChange,
  t,
}: CategoryFilterChipsProps) {
  const baseClasses =
    "rounded-full px-3 py-1 text-xs font-medium cursor-pointer whitespace-nowrap border";

  return (
    <div className="flex gap-2 overflow-x-auto">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`${baseClasses} ${
          selected === null
            ? "border-[#8B2942] bg-[#F5E6EA] text-[#8B2942]"
            : "border-[#E7E5E4] bg-white text-[#44403C]"
        }`}
      >
        {t("all_filter")}
      </button>
      {categories.map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => onChange(cat)}
          className={`${baseClasses} ${
            selected === cat
              ? "border-[#8B2942] bg-[#F5E6EA] text-[#8B2942]"
              : "border-[#E7E5E4] bg-white text-[#44403C]"
          }`}
        >
          {t(`cat_${cat}`)}
        </button>
      ))}
    </div>
  );
}
