/**
 * Typeahead Input
 *
 * Debounced autocomplete input used across the admin surfaces. Fires
 * a controlled fetcher on change, renders the current suggestions as
 * a keyboard-navigable popover, and emits the selected record to the
 * parent form.
 *
 * @version v0.3.0
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useFetcher } from "react-router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  canonical: string;
  category: string | null;
}

interface TypeaheadInputProps {
  name: string;
  defaultValue?: string;
  defaultTermId?: string;
  defaultTermStatus?: string;
  searchEndpoint: string;
  placeholder?: string;
  onPropose?: (canonical: string) => void;
}

// ---------------------------------------------------------------------------
// TypeaheadInput
// ---------------------------------------------------------------------------

export function TypeaheadInput({
  name,
  defaultValue = "",
  defaultTermId = "",
  defaultTermStatus,
  searchEndpoint,
  placeholder,
  onPropose,
}: TypeaheadInputProps) {
  const [query, setQuery] = useState(defaultValue);
  const [selectedTermId, setSelectedTermId] = useState(defaultTermId);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isProposed, setIsProposed] = useState(defaultTermStatus === "proposed");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const fetcher = useFetcher<{ searchResults?: SearchResult[] }>();
  const results = fetcher.data?.searchResults ?? [];

  // Debounced search
  const triggerSearch = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (q.length >= 2) {
          fetcher.submit(
            { _action: "search-functions", q },
            { method: "post", action: searchEndpoint }
          );
        }
      }, 300);
    },
    [fetcher, searchEndpoint]
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Open dropdown when results arrive
  useEffect(() => {
    if (results.length > 0 && query.length >= 2) {
      setIsOpen(true);
      setSelectedIndex(-1);
    }
  }, [results, query]);

  const handleSelect = (result: SearchResult) => {
    setQuery(result.canonical);
    setSelectedTermId(result.id);
    setIsProposed(false);
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  const handlePropose = () => {
    if (!query.trim()) return;
    // Check if query matches any result
    const match = results.find(
      (r) => r.canonical.toLowerCase() === query.trim().toLowerCase()
    );
    if (match) {
      handleSelect(match);
      return;
    }
    // No match -- propose new term
    setSelectedTermId(""); // clear term ID, server will create proposed term
    setIsProposed(true);
    setIsOpen(false);
    if (onPropose) onPropose(query.trim());
  };

  const handleInputChange = (value: string) => {
    setQuery(value);
    setIsProposed(false);
    if (value.length < 2) {
      setIsOpen(false);
      setSelectedTermId("");
    } else {
      triggerSearch(value);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter") {
        e.preventDefault();
        handlePropose();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < results.length) {
          handleSelect(results[selectedIndex]);
        } else {
          handlePropose();
        }
        break;
      case "Escape":
        setIsOpen(false);
        setSelectedIndex(-1);
        break;
    }
  };

  const handleBlur = (e: React.FocusEvent) => {
    // Delay closing so clicks on dropdown items register
    setTimeout(() => {
      if (!listRef.current?.contains(document.activeElement)) {
        setIsOpen(false);
      }
    }, 200);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={placeholder}
          autoComplete="off"
          className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
        />
        {isProposed && (
          <span className="whitespace-nowrap rounded-full bg-[#FEF3C7] px-2 py-0.5 text-xs font-semibold text-[#78350F]">
            Proposed
          </span>
        )}
      </div>

      {/* Hidden inputs for form submission */}
      <input type="hidden" name={name} value={query} />
      <input type="hidden" name={`${name}Id`} value={selectedTermId} />

      {/* Dropdown */}
      {isOpen && results.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-[#E7E5E4] bg-white shadow-lg"
          role="listbox"
        >
          {results.map((result, i) => (
            <li
              key={result.id}
              role="option"
              aria-selected={i === selectedIndex}
              className={`cursor-pointer px-3 py-2 text-sm ${
                i === selectedIndex
                  ? "bg-[#F5E6EA] text-[#44403C]"
                  : "text-[#44403C] hover:bg-[#FAFAF9]"
              }`}
              onMouseDown={() => handleSelect(result)}
            >
              <span>{result.canonical}</span>
              {result.category && (
                <span className="ml-2 text-xs text-[#A8A29E]">
                  {result.category}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
