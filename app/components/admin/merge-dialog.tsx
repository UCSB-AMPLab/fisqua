/**
 * Merge Dialog
 *
 * This dialog deals with merging two records — used across entities,
 * places, and vocabulary terms. Shows a side-by-side comparison, collects
 * the winning field values, and emits the merge payload; the commit itself
 * runs through the parent form action so the audit log stays owned by the
 * server.
 *
 * The search for the record or term to merge into loads the list
 * route's `_search` JSON through a fetcher (`mergeSearchPath`), which
 * runs that route's loader alone; a plain fetch of the address would be
 * a document request, which renders the list page and fails.
 *
 * @version v0.9.0
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Form, useFetcher } from "react-router";
import { currentSearchResults, mergeSearchPath } from "~/lib/merge-search";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import {
  LinkReassignmentList,
  type DescriptionLink,
} from "./link-reassignment-list";

interface SearchResult {
  id: string;
  displayName: string;
  code: string;
}

interface MergeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sourceId: string;
  sourceName: string;
  /**
   * Informational only — the component body does NOT branch on this
   * value. It records which authority surface the dialog is serving
   * (entities, places, or vocabulary terms) for the consumer's own
   * clarity; all label resolution flows through `i18nNamespace`.
   */
  entityType: "entity" | "place" | "vocabulary";
  links: DescriptionLink[];
  searchEndpoint: string;
  i18nNamespace: string;
  /**
   * The source record's `updatedAt`. When provided (entities/places), it
   * rides the merge submission as a hidden `_updatedAt` so the server can
   * reject a merge staged against a record modified since the form loaded
   * — the same optimistic-lock guard the update intent uses. Omitted for
   * vocabulary terms, whose action does not carry the guard.
   */
  recordUpdatedAt?: number | string;
}

export function MergeDialog({
  isOpen,
  onClose,
  sourceId,
  sourceName,
  entityType,
  links,
  searchEndpoint,
  i18nNamespace,
  recordUpdatedAt,
}: MergeDialogProps) {
  const { t } = useTranslation(i18nNamespace);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Steps: 1 = select target, 2 = reassign links
  const [step, setStep] = useState<1 | 2>(1);
  const [searchQuery, setSearchQuery] = useState("");
  // The list route answers `_search` with JSON; a fetcher runs its loader
  // alone and returns the array (`mergeSearchPath`).
  const searchFetcher = useFetcher<SearchResult[]>();
  // The query the last load was made for: an earlier query's answer is not shown.
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<SearchResult | null>(
    null
  );
  const [selectedLinkIds, setSelectedLinkIds] = useState<Set<string>>(
    () => new Set(links.map((l) => l.id))
  );

  // Reset when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setSearchQuery("");
      setSelectedTarget(null);
      setSelectedLinkIds(new Set(links.map((l) => l.id)));
    }
  }, [isOpen, links]);

  // Focus trap: focus the dialog when opened
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen, step]);

  // Search with debounce
  useEffect(() => {
    if (!searchQuery.trim() || step !== 1) return;
    const timer = setTimeout(() => {
      setRequestedFor(searchQuery.trim());
      searchFetcher.load(mergeSearchPath(searchEndpoint, searchQuery, sourceId));
    }, 300);
    return () => clearTimeout(timer);
    // `load` is stable across renders; the fetcher object is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchEndpoint, sourceId, step]);
  const searchResults: SearchResult[] =
    step === 1 ? currentSearchResults<SearchResult>(searchQuery, requestedFor, searchFetcher.data, searchFetcher.state) : [];

  const handleSelectTarget = useCallback(
    (result: SearchResult) => {
      setSelectedTarget(result);
      if (links.length > 0) {
        setStep(2);
      }
      // If no links, stay on step 1 but show confirm button
    },
    [links.length]
  );

  const handleToggleLink = useCallback((id: string) => {
    setSelectedLinkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedLinkIds(new Set(links.map((l) => l.id)));
  }, [links]);

  const handleDeselectAll = useCallback(() => {
    setSelectedLinkIds(new Set());
  }, []);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const showConfirmOnStep1 = selectedTarget && links.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="merge-dialog-title"
        tabIndex={-1}
        className="max-w-2xl rounded-lg bg-white p-6 shadow-lg focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Step 1: Select target */}
        {step === 1 && (
          <>
            <h2
              id="merge-dialog-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("mergeTitle")}
            </h2>

            <div className="relative mt-4">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("mergeSearch")}
                autoFocus
                className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              />
            </div>

            {/* Search results */}
            {searchResults.length > 0 && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-stone-200">
                {searchResults.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => handleSelectTarget(result)}
                    className="flex w-full items-center justify-between border-b border-stone-200 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-stone-50"
                  >
                    <span className="text-stone-700">
                      {result.displayName}
                    </span>
                    <span className="text-xs text-stone-500">
                      {result.code}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Confirm button when no links to reassign */}
            {showConfirmOnStep1 && (
              <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
                {t("mergeReassignSubtitle", {
                  name: sourceName,
                  count: 0,
                })}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("mergeCancel")}
              </button>
              {showConfirmOnStep1 && (
                <Form method="post">
                  <input type="hidden" name="_action" value="merge" />
                  {recordUpdatedAt != null && (
                    <input
                      type="hidden"
                      name="_updatedAt"
                      value={String(recordUpdatedAt)}
                    />
                  )}
                  <input
                    type="hidden"
                    name="targetId"
                    value={selectedTarget.id}
                  />
                  <input type="hidden" name="linkIds" value="[]" />
                  <button
                    type="submit"
                    className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
                  >
                    {t("mergeConfirm")}
                  </button>
                </Form>
              )}
            </div>
          </>
        )}

        {/* Step 2: Reassign links */}
        {step === 2 && selectedTarget && (
          <>
            <h2
              id="merge-dialog-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("mergeReassignTitle")}
            </h2>
            <p className="mt-1 text-sm text-stone-500">
              {t("mergeReassignSubtitle", {
                name: sourceName,
                count: links.length,
              })}
            </p>

            <div className="mt-4">
              <LinkReassignmentList
                links={links}
                selectedIds={selectedLinkIds}
                onToggle={handleToggleLink}
                defaultChecked={true}
                loadMoreLabel={t("loadMore")}
                selectAllLabel={t("selectAll")}
                deselectAllLabel={t("deselectAll")}
                onSelectAll={handleSelectAll}
                onDeselectAll={handleDeselectAll}
              />
            </div>

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("mergeCancel")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="merge" />
                {recordUpdatedAt != null && (
                  <input
                    type="hidden"
                    name="_updatedAt"
                    value={String(recordUpdatedAt)}
                  />
                )}
                <input
                  type="hidden"
                  name="targetId"
                  value={selectedTarget.id}
                />
                <input
                  type="hidden"
                  name="linkIds"
                  value={JSON.stringify(Array.from(selectedLinkIds))}
                />
                <button
                  type="submit"
                  className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
                >
                  {t("mergeConfirm")}
                </button>
              </Form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// @version v0.9.0
