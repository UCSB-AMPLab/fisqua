import { useState, useCallback } from "react";

type TocSection = {
  id: string;
  isComplete: boolean;
  label: string;
};

type SectionTOCProps = {
  sections: TocSection[];
  onSectionClick: (sectionId: string) => void;
  activeSectionId?: string;
};

export function SectionTOC({
  sections,
  onSectionClick,
  activeSectionId,
}: SectionTOCProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-3 border-l border-[#E7E5E4] bg-[#FAFAF9] py-4">
      {sections.map((section) => {
        const isActive = activeSectionId === section.id;
        return (
          <div key={section.id} className="relative">
            <button
              type="button"
              className={`rounded-full ${
                section.isComplete
                  ? "bg-[#14B8A6]"
                  : "border border-[#E7E5E4] bg-transparent"
              } ${
                isActive
                  ? "h-3 w-3 ring-2 ring-[#14B8A6] ring-offset-1"
                  : "h-2.5 w-2.5"
              }`}
              onClick={() => onSectionClick(section.id)}
              onMouseEnter={() => setHoveredId(section.id)}
              onMouseLeave={() => setHoveredId(null)}
              aria-label={section.label}
            />
            {hoveredId === section.id && (
              <div className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-[#44403C] px-2 py-1 font-sans text-[0.75rem] text-white">
                {section.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
