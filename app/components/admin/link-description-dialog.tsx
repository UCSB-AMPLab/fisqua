/**
 * Link Description Dialog
 *
 * Modal used on the entities, places, and vocabularies admin surfaces
 * to link a record to one or more archival descriptions. Wraps a
 * typeahead that queries the descriptions FTS index and renders the
 * current link list as chips the operator can remove before saving.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { Search } from "lucide-react";
import type { TFunction } from "i18next";

interface SearchResult {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
}

interface LinkDescriptionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  roles: readonly string[];
  entityOrPlaceId: string;
  recordType: "entity" | "place";
  t: TFunction;
}

export function LinkDescriptionDialog({
  isOpen,
  onClose,
  roles,
  t,
}: LinkDescriptionDialogProps) {
  const searchFetcher = useFetcher();
  const linkFetcher = useFetcher();
  const dialogRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDescription, setSelectedDescription] = useState<SearchResult | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>(roles[0]);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setSelectedDescription(null);
      setSelectedRole(roles[0]);
    }
  }, [isOpen, roles]);

  // Focus dialog when opened
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  // Close on successful link
  useEffect(() => {
    if (linkFetcher.data && "ok" in (linkFetcher.data as Record<string, unknown>) && (linkFetcher.data as Record<string, unknown>).ok) {
      onClose();
    }
  }, [linkFetcher.data, onClose]);

  // Search with debounce
  useEffect(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      return;
    }

    const timer = setTimeout(() => {
      searchFetcher.submit(
        { _action: "search_descriptions", q: searchQuery.trim() },
        { method: "post" }
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const searchResults: SearchResult[] =
    searchFetcher.data && "results" in (searchFetcher.data as Record<string, unknown>)
      ? (searchFetcher.data as { results: SearchResult[] }).results
      : [];

  const duplicateError =
    linkFetcher.data &&
    "error" in (linkFetcher.data as Record<string, unknown>) &&
    (linkFetcher.data as Record<string, unknown>).error === "duplicate_link";

  function handleLink() {
    if (!selectedDescription) return;
    linkFetcher.submit(
      {
        _action: "link_description",
        descriptionId: selectedDescription.id,
        role: selectedRole,
      },
      { method: "post" }
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="link-description-dialog-title"
        tabIndex={-1}
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-lg focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="link-description-dialog-title"
          className="font-serif text-lg font-semibold text-stone-700"
        >
          {t("add_description_link")}
        </h2>

        {/* Search input */}
        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSelectedDescription(null);
            }}
            placeholder={t("search_descriptions")}
            autoFocus
            className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
        </div>

        {/* Search results */}
        {!selectedDescription && searchResults.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-stone-200">
            {searchResults.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => {
                  setSelectedDescription(result);
                  setSearchQuery(result.title);
                }}
                className="flex w-full items-center justify-between border-b border-stone-200 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-stone-50"
              >
                <span className="truncate text-stone-700">{result.title}</span>
                <span className="ml-2 whitespace-nowrap font-mono text-xs text-stone-500">
                  {result.referenceCode}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Selected description + role */}
        {selectedDescription && (
          <div className="mt-4 space-y-3">
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
              {selectedDescription.title}{" "}
              <span className="font-mono text-xs text-stone-500">
                {selectedDescription.referenceCode}
              </span>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-indigo">
                {t("select_role")}
              </label>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {t(`role_${r}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Duplicate error */}
        {duplicateError && (
          <p className="mt-2 text-xs text-madder">
            {t("duplicate_link_error")}
          </p>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("mergeCancel")}
          </button>
          <button
            type="button"
            onClick={handleLink}
            disabled={!selectedDescription || linkFetcher.state === "submitting"}
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("link_button")}
          </button>
        </div>
      </div>
    </div>
  );
}
