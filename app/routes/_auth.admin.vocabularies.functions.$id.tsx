/**
 * Vocabularies — Function Detail
 *
 * Detail view for one function-style vocabulary term: label in every
 * active locale, linked descriptions, current status, and the full
 * audit trail. Mutations route through the shared admin dialogs
 * (merge, split, link-description) so each workflow stays consistent
 * with the rest of the vocabularies hub.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Form, Link, redirect, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { userContext } from "../context";
import { FUNCTION_CATEGORIES } from "~/lib/validation/enums";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { VocabularyStatusBadge } from "~/components/admin/vocabulary-status-badge";
import type { Route } from "./+types/_auth.admin.vocabularies.functions.$id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VocabTerm {
  id: string;
  canonical: string;
  category: string | null;
  status: string;
  entityCount: number;
  notes: string | null;
  mergedInto: string | null;
  proposedBy: string | null;
}

interface LinkedEntity {
  id: string;
  displayName: string;
  entityType: string;
  entityCode: string | null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql } = await import("drizzle-orm");
  const { vocabularyTerms, entities } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const term = await db
    .select()
    .from(vocabularyTerms)
    .where(eq(vocabularyTerms.id, id))
    .get();

  if (!term) {
    throw new Response("Not found", { status: 404 });
  }

  // If merged, redirect to the target
  if (term.mergedInto) {
    throw redirect(`/admin/vocabularies/functions/${term.mergedInto}`);
  }

  // Fetch linked entities (first page)
  const pageSize = 25;
  const linkedEntities = (await db
    .select({
      id: entities.id,
      displayName: entities.displayName,
      entityType: entities.entityType,
      entityCode: entities.entityCode,
    })
    .from(entities)
    .where(eq(entities.primaryFunctionId, id))
    .limit(pageSize)
    .all()) as LinkedEntity[];

  // Count total linked entities
  const [{ count: totalLinked }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(entities)
    .where(eq(entities.primaryFunctionId, id))
    .all();

  return { term: term as VocabTerm, linkedEntities, totalLinked };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { vocabularyTerms, entities, changelog } = await import("~/db/schema");
  const { vocabularyTermSchema } = await import("~/lib/validation/vocabulary");

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const now = Math.floor(Date.now() / 1000);
  const id = params.id;

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  if (intent === "save") {
    const canonical = (formData.get("canonical") as string)?.trim();
    const category = (formData.get("category") as string) || null;
    const status = (formData.get("status") as string) || "approved";
    const notes = (formData.get("notes") as string)?.trim() || null;

    const parsed = vocabularyTermSchema.safeParse({
      canonical,
      category: category || undefined,
      status,
      notes,
    });
    if (!parsed.success) {
      return { error: "Invalid input", fieldErrors: parsed.error.format() };
    }

    const existing = await db
      .select()
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, id))
      .get();
    if (!existing) return { error: "Term not found" };

    await db
      .update(vocabularyTerms)
      .set({
        canonical: parsed.data.canonical,
        category: parsed.data.category ?? null,
        status: parsed.data.status,
        notes: parsed.data.notes ?? null,
        updatedAt: now,
      })
      .where(eq(vocabularyTerms.id, id));

    // Changelog
    const diff: Record<string, { old: unknown; new: unknown }> = {};
    if (existing.canonical !== parsed.data.canonical) {
      diff.canonical = { old: existing.canonical, new: parsed.data.canonical };
    }
    if (existing.category !== (parsed.data.category ?? null)) {
      diff.category = { old: existing.category, new: parsed.data.category ?? null };
    }
    if (existing.status !== parsed.data.status) {
      diff.status = { old: existing.status, new: parsed.data.status };
    }
    if (existing.notes !== (parsed.data.notes ?? null)) {
      diff.notes = { old: existing.notes, new: parsed.data.notes ?? null };
    }

    if (Object.keys(diff).length > 0) {
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: id,
        recordType: "vocabulary_term",
        userId: user.id,
        note: `Updated: ${parsed.data.canonical}`,
        diff: JSON.stringify(diff),
        createdAt: now,
      });
    }

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------
  if (intent === "merge") {
    const targetId = formData.get("targetId") as string;
    if (!targetId) return { error: "Missing target" };
    if (targetId === id) return { error: "Cannot merge into self" };

    const target = await db
      .select()
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, targetId))
      .get();
    if (!target) return { error: "Target not found" };

    const source = await db
      .select()
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, id))
      .get();
    if (!source) return { error: "Source not found" };

    // Parse selected entity IDs
    const linkIdsRaw = formData.get("linkIds") as string;
    let entityIds: string[] = [];
    try {
      entityIds = JSON.parse(linkIdsRaw || "[]");
    } catch {
      entityIds = [];
    }

    // Reassign selected entities to target
    if (entityIds.length > 0) {
      await db
        .update(entities)
        .set({ primaryFunctionId: targetId, updatedAt: now })
        .where(inArray(entities.id, entityIds));
    }

    // Deprecate source and set mergedInto
    await db
      .update(vocabularyTerms)
      .set({
        mergedInto: targetId,
        status: "deprecated",
        updatedAt: now,
      })
      .where(eq(vocabularyTerms.id, id));

    // Update entity counts on both
    const [{ count: targetCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(eq(entities.primaryFunctionId, targetId))
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: targetCount, updatedAt: now })
      .where(eq(vocabularyTerms.id, targetId));

    const [{ count: sourceCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(eq(entities.primaryFunctionId, id))
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: sourceCount, updatedAt: now })
      .where(eq(vocabularyTerms.id, id));

    // Changelog
    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Merged "${source.canonical}" into "${target.canonical}" (${entityIds.length} entities reassigned)`,
      diff: JSON.stringify({
        mergedInto: { old: null, new: targetId },
        status: { old: source.status, new: "deprecated" },
      }),
      createdAt: now,
    });

    throw redirect(`/admin/vocabularies/functions/${targetId}`);
  }

  // ---------------------------------------------------------------------------
  // Split
  // ---------------------------------------------------------------------------
  if (intent === "split") {
    const newName = (formData.get("newName") as string)?.trim();
    if (!newName) return { error: "New term name is required" };

    const parsed = vocabularyTermSchema.safeParse({ canonical: newName });
    if (!parsed.success) return { error: "Invalid name" };

    const source = await db
      .select()
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, id))
      .get();
    if (!source) return { error: "Source not found" };

    // Parse selected entity IDs
    const linkIdsRaw = formData.get("linkIds") as string;
    let entityIds: string[] = [];
    try {
      entityIds = JSON.parse(linkIdsRaw || "[]");
    } catch {
      entityIds = [];
    }

    // Create new term
    const newId = crypto.randomUUID();
    await db.insert(vocabularyTerms).values({
      id: newId,
      canonical: parsed.data.canonical,
      category: source.category,
      status: "approved",
      entityCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Move selected entities to new term
    if (entityIds.length > 0) {
      await db
        .update(entities)
        .set({ primaryFunctionId: newId, updatedAt: now })
        .where(inArray(entities.id, entityIds));
    }

    // Update entity counts on both
    const [{ count: sourceCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(eq(entities.primaryFunctionId, id))
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: sourceCount, updatedAt: now })
      .where(eq(vocabularyTerms.id, id));

    const [{ count: newCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(eq(entities.primaryFunctionId, newId))
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: newCount, updatedAt: now })
      .where(eq(vocabularyTerms.id, newId));

    // Changelog
    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Split "${source.canonical}": created "${parsed.data.canonical}" with ${entityIds.length} entities`,
      diff: JSON.stringify({
        split: { newTermId: newId, newCanonical: parsed.data.canonical, entitiesMoved: entityIds.length },
      }),
      createdAt: now,
    });

    throw redirect(`/admin/vocabularies/functions/${newId}`);
  }

  // ---------------------------------------------------------------------------
  // Deprecate
  // ---------------------------------------------------------------------------
  if (intent === "deprecate") {
    const existing = await db
      .select()
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, id))
      .get();
    if (!existing) return { error: "Term not found" };

    await db
      .update(vocabularyTerms)
      .set({ status: "deprecated", updatedAt: now })
      .where(eq(vocabularyTerms.id, id));

    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Deprecated: ${existing.canonical}`,
      diff: JSON.stringify({
        status: { old: existing.status, new: "deprecated" },
      }),
      createdAt: now,
    });

    return { success: true };
  }

  return { error: "Unknown intent" };
}

// ---------------------------------------------------------------------------
// Entity type badge styles (reused from entities page)
// ---------------------------------------------------------------------------

const TYPE_BADGE_STYLES: Record<string, string> = {
  person: "bg-[#E0E7F7] text-[#3B5A9A]",
  family: "bg-[#CCF0EB] text-[#0D9488]",
  corporate: "bg-[#F5E6EA] text-[#8B2942]",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminVocabularyFunctionDetailPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { term, linkedEntities, totalLinked } = loaderData;
  const { t } = useTranslation("vocabularies");
  const fetcher = useFetcher();

  // Merge dialog state
  const [showMerge, setShowMerge] = useState(false);

  // Split dialog state
  const [showSplit, setShowSplit] = useState(false);

  // Check URL for action=merge (linked from listing kebab menu)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("action") === "merge") {
      setShowMerge(true);
    }
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-[#78716C]">
        <Link to="/admin/vocabularies" className="hover:underline">
          {t("page_title")}
        </Link>
        <span className="mx-1">/</span>
        <Link to="/admin/vocabularies/functions" className="hover:underline">
          {t("vocab_primary_functions")}
        </Link>
        <span className="mx-1">/</span>
        <span className="text-[#44403C]">{term.canonical}</span>
      </nav>

      {/* Page heading */}
      <div className="flex items-center gap-3">
        <h1 className="font-serif text-lg font-semibold text-[#44403C]">
          {term.canonical}
        </h1>
        <VocabularyStatusBadge
          status={term.status as "approved" | "proposed" | "deprecated"}
        />
      </div>

      {/* Action result messages */}
      {actionData && "error" in actionData && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionData.error}
        </div>
      )}
      {actionData && "success" in actionData && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {t("save_term")} ✓
        </div>
      )}

      {/* Edit form card */}
      <Form method="post" className="mt-6 rounded-lg border border-[#E7E5E4] p-6">
        <input type="hidden" name="intent" value="save" />

        <div className="space-y-4">
          {/* Canonical label */}
          <div>
            <label
              htmlFor="canonical"
              className="block text-sm font-medium text-[#44403C]"
            >
              {t("field_canonical")}
            </label>
            <input
              id="canonical"
              name="canonical"
              type="text"
              defaultValue={term.canonical}
              required
              className="mt-1 w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
            />
          </div>

          {/* Category */}
          <div>
            <label
              htmlFor="category"
              className="block text-sm font-medium text-[#44403C]"
            >
              {t("field_category")}
            </label>
            <select
              id="category"
              name="category"
              defaultValue={term.category ?? ""}
              className="mt-1 w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
            >
              <option value="">{"\u2014"}</option>
              {FUNCTION_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`cat_${cat}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div>
            <label
              htmlFor="status"
              className="block text-sm font-medium text-[#44403C]"
            >
              {t("field_status")}
            </label>
            <select
              id="status"
              name="status"
              defaultValue={term.status}
              className="mt-1 w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
            >
              <option value="approved">{t("status_approved")}</option>
              <option value="proposed">{t("status_proposed")}</option>
              <option value="deprecated">{t("status_deprecated")}</option>
            </select>
          </div>

          {/* Notes */}
          <div>
            <label
              htmlFor="notes"
              className="block text-sm font-medium text-[#44403C]"
            >
              {t("field_notes")}
            </label>
            <textarea
              id="notes"
              name="notes"
              defaultValue={term.notes ?? ""}
              rows={3}
              className="mt-1 w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
            />
          </div>
        </div>

        {/* Save button */}
        <div className="mt-6">
          <button
            type="submit"
            className="rounded-lg bg-[#8B2942] px-4 py-2 text-sm font-semibold text-white hover:bg-[#6B1F33]"
          >
            {t("save_term")}
          </button>
        </div>
      </Form>

      {/* Linked entities section */}
      <div className="mt-8">
        <CollapsibleSection title={`${t("linked_entities")} (${totalLinked})`}>
          {linkedEntities.length === 0 ? (
            <p className="py-4 text-sm text-[#78716C]">
              {t("no_linked_entities")}
            </p>
          ) : (
            <div className="space-y-2">
              {linkedEntities.map((entity) => (
                <div
                  key={entity.id}
                  className="flex items-center gap-3 rounded border border-[#E7E5E4] px-3 py-2"
                >
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      TYPE_BADGE_STYLES[entity.entityType] ?? ""
                    }`}
                  >
                    {entity.entityType}
                  </span>
                  <Link
                    to={`/admin/entities/${entity.id}`}
                    className="text-sm font-semibold text-[#6B1F33] hover:underline"
                  >
                    {entity.displayName}
                  </Link>
                  {entity.entityCode && (
                    <span className="text-xs text-[#78716C]">
                      {entity.entityCode}
                    </span>
                  )}
                </div>
              ))}
              {totalLinked > linkedEntities.length && (
                <p className="py-2 text-xs text-[#78716C]">
                  {t("n_terms", {
                    count: totalLinked - linkedEntities.length,
                  })}{" "}
                  more...
                </p>
              )}
            </div>
          )}
        </CollapsibleSection>
      </div>

      {/* Action buttons */}
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setShowMerge(true)}
          className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
        >
          {t("merge_into")}
        </button>
        <button
          type="button"
          onClick={() => setShowSplit(true)}
          className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
        >
          {t("split_term")}
        </button>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="deprecate" />
          <button
            type="submit"
            className="rounded-lg border border-red-600 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
            onClick={(e) => {
              if (
                !confirm(
                  t("deprecate_confirm", {
                    term: term.canonical,
                    count: totalLinked,
                  })
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            {t("deprecate_term")}
          </button>
        </fetcher.Form>
      </div>

      {/* Merge dialog */}
      {showMerge && (
        <VocabMergeDialog
          sourceId={term.id}
          sourceName={term.canonical}
          linkedEntities={linkedEntities}
          onClose={() => setShowMerge(false)}
        />
      )}

      {/* Split dialog */}
      {showSplit && (
        <VocabSplitDialog
          sourceId={term.id}
          sourceName={term.canonical}
          linkedEntities={linkedEntities}
          onClose={() => setShowSplit(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vocab Merge Dialog (inline, vocabulary-specific)
// ---------------------------------------------------------------------------

function VocabMergeDialog({
  sourceId,
  sourceName,
  linkedEntities,
  onClose,
}: {
  sourceId: string;
  sourceName: string;
  linkedEntities: LinkedEntity[];
  onClose: () => void;
}) {
  const { t } = useTranslation("vocabularies");
  const dialogRef = useRef<HTMLDivElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    { id: string; displayName: string; code: string | null }[]
  >([]);
  const [selectedTarget, setSelectedTarget] = useState<{
    id: string;
    displayName: string;
  } | null>(null);
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(
    () => new Set(linkedEntities.map((e) => e.id))
  );

  // Focus dialog
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Search with debounce
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          intent: "search-terms",
          q: searchQuery.trim(),
          exclude: sourceId,
        });
        const res = await fetch(`/admin/vocabularies/functions?${params}`);
        if (res.ok) {
          setSearchResults(await res.json());
        }
      } catch {
        // Silently fail
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, sourceId]);

  // Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function toggleEntity(id: string) {
    setSelectedEntityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="merge-dialog-title"
          className="font-serif text-lg font-semibold text-[#44403C]"
        >
          {t("merge_into")}
        </h2>
        <p className="mt-1 text-sm text-[#78716C]">
          Merge &ldquo;{sourceName}&rdquo; into another function.
        </p>

        {/* Search for target */}
        {!selectedTarget && (
          <>
            <div className="relative mt-4">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#78716C]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("search_placeholder")}
                autoFocus
                className="w-full rounded-lg border border-[#E7E5E4] py-2 pl-9 pr-3 text-sm focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
              />
            </div>
            {searchResults.length > 0 && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-[#E7E5E4]">
                {searchResults.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() =>
                      setSelectedTarget({
                        id: result.id,
                        displayName: result.displayName,
                      })
                    }
                    className="flex w-full items-center justify-between border-b border-[#E7E5E4] px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[#FAFAF9]"
                  >
                    <span className="text-[#44403C]">
                      {result.displayName}
                    </span>
                    {result.code && (
                      <span className="text-xs text-[#78716C]">
                        {result.code}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Entity reassignment (when target is selected) */}
        {selectedTarget && linkedEntities.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-[#78716C]">
              Select entities to move to &ldquo;{selectedTarget.displayName}
              &rdquo;:
            </p>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {linkedEntities.map((entity) => (
                <label
                  key={entity.id}
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[#FAFAF9]"
                >
                  <input
                    type="checkbox"
                    checked={selectedEntityIds.has(entity.id)}
                    onChange={() => toggleEntity(entity.id)}
                    className="h-4 w-4 rounded border-[#E7E5E4] text-[#8B2942]"
                  />
                  <span className="text-sm">{entity.displayName}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Selected target display */}
        {selectedTarget && (
          <div className="mt-4 rounded-lg border border-[#E7E5E4] bg-[#FAFAF9] px-3 py-2 text-sm">
            Target: <strong>{selectedTarget.displayName}</strong>
            <button
              type="button"
              onClick={() => setSelectedTarget(null)}
              className="ml-2 text-xs text-[#8B2942] hover:underline"
            >
              Change
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
          >
            Cancel
          </button>
          {selectedTarget && (
            <Form method="post">
              <input type="hidden" name="intent" value="merge" />
              <input type="hidden" name="targetId" value={selectedTarget.id} />
              <input
                type="hidden"
                name="linkIds"
                value={JSON.stringify(Array.from(selectedEntityIds))}
              />
              <button
                type="submit"
                className="rounded-lg bg-[#6B1F33] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8B2942]"
              >
                {t("merge_into")}
              </button>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vocab Split Dialog (inline, vocabulary-specific)
// ---------------------------------------------------------------------------

function VocabSplitDialog({
  sourceId,
  sourceName,
  linkedEntities,
  onClose,
}: {
  sourceId: string;
  sourceName: string;
  linkedEntities: LinkedEntity[];
  onClose: () => void;
}) {
  const { t } = useTranslation("vocabularies");
  const dialogRef = useRef<HTMLDivElement>(null);

  const [newName, setNewName] = useState("");
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(
    () => new Set()
  );

  // Focus dialog
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function toggleEntity(id: string) {
    setSelectedEntityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="split-dialog-title"
        tabIndex={-1}
        className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="split-dialog-title"
          className="font-serif text-lg font-semibold text-[#44403C]"
        >
          {t("split_term")}
        </h2>
        <p className="mt-1 text-sm text-[#78716C]">
          Split &ldquo;{sourceName}&rdquo; into a new function.
        </p>

        {/* New term name */}
        <div className="mt-4">
          <label
            htmlFor="split-new-name"
            className="block text-sm font-medium text-[#44403C]"
          >
            New function name
          </label>
          <input
            id="split-new-name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Enter new function name..."
            autoFocus
            className="mt-1 w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
          />
        </div>

        {/* Entity selection */}
        {linkedEntities.length > 0 && (
          <div className="mt-4">
            <p className="text-sm text-[#78716C]">
              Select entities to move to the new function:
            </p>
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {linkedEntities.map((entity) => (
                <label
                  key={entity.id}
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[#FAFAF9]"
                >
                  <input
                    type="checkbox"
                    checked={selectedEntityIds.has(entity.id)}
                    onChange={() => toggleEntity(entity.id)}
                    className="h-4 w-4 rounded border-[#E7E5E4] text-[#8B2942]"
                  />
                  <span className="text-sm">{entity.displayName}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
          >
            Cancel
          </button>
          <Form method="post">
            <input type="hidden" name="intent" value="split" />
            <input type="hidden" name="newName" value={newName} />
            <input
              type="hidden"
              name="linkIds"
              value={JSON.stringify(Array.from(selectedEntityIds))}
            />
            <button
              type="submit"
              disabled={!newName.trim()}
              className="rounded-lg bg-[#6B1F33] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8B2942] disabled:opacity-50"
            >
              {t("split_term")}
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}
