/**
 * Search Popover
 *
 * Keyboard-driven search dropdown that queries the descriptions FTS5
 * index as the user types and surfaces matching records.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, Loader2 } from "lucide-react";

interface SearchResult {
  id: string;
  displayName: string;
  code: string | null;
}

interface SearchPopoverProps {
  type: "entity" | "place";
  onSelect: (item: { id: string; name: string; code: string }) => void;
  onClose: () => void;
  excludeIds?: string[];
}

export function SearchPopover({
  type,
  onSelect,
  onClose,
  excludeIds = [],
}: SearchPopoverProps) {
  const { t } = useTranslation("descriptions_admin");
  const fetcher = useFetcher<SearchResult[]>();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const doSearch = useCallback(
    (q: string) => {
      const endpoint =
        type === "entity"
          ? `/admin/entities?_search=true&q=${encodeURIComponent(q)}`
          : `/admin/places?_search=true&q=${encodeURIComponent(q)}`;
      fetcher.load(endpoint);
    },
    [type, fetcher]
  );

  function handleChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length >= 2) {
      debounceRef.current = setTimeout(() => doSearch(value.trim()), 300);
    }
  }

  const results = (fetcher.data ?? []).filter(
    (r) => !excludeIds.includes(r.id)
  );
  const isLoading = fetcher.state === "loading";

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 mt-1 w-96 rounded-lg border border-[#E7E5E4] bg-white p-4 shadow-lg"
    >
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#A8A29E]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={
            type === "entity" ? t("search_entity") : t("search_place")
          }
          className="w-full rounded-lg border border-[#E7E5E4] py-2 pl-10 pr-3 text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
        />
      </div>

      <div className="mt-2 max-h-64 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-[#A8A29E]" />
          </div>
        )}

        {!isLoading && query.trim().length >= 2 && results.length === 0 && (
          <p className="py-4 text-center text-sm text-[#78716C]">
            {t("no_results")}
          </p>
        )}

        {!isLoading &&
          results.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() =>
                onSelect({
                  id: item.id,
                  name: item.displayName,
                  code: item.code ?? "",
                })
              }
              className="flex w-full items-center justify-between rounded px-3 py-2 text-left hover:bg-[#FAFAF9]"
            >
              <span className="text-sm text-[#44403C]">
                {item.displayName}
              </span>
              {item.code && (
                <span className="text-xs text-[#A8A29E]">{item.code}</span>
              )}
            </button>
          ))}
      </div>
    </div>
  );
}
