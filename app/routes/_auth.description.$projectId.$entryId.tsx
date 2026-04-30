/**
 * Entry Description Editor
 *
 * The full-page description editor for a single entry -- one of the
 * segmented documentary units a cataloguer carved out of a volume.
 * Renders a split-pane layout with the entry's IIIF image tiles on
 * one side and the ISAD(G) description form on the other, with
 * autosave and a review workflow (submit / approve / send back) built
 * in. Entity and place linker dialogs attach authority records to the
 * draft description, and the per-page QC-flag dialog lets cataloguers
 * raise digitisation problems without leaving the editor.
 *
 * Breaks out of the sidebar chrome via a path check in `_auth.tsx` so
 * cataloguers have the full viewport for image and form.
 *
 * @version v0.3.0
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { getSectionCompletion } from "../lib/description-types";
import type { DescriptionEntry, CommentWithAuthor } from "../lib/description-types";
import {
  DESCRIPTION_STATUS_STYLES,
  DESCRIPTION_STATUS_LABELS,
  type DescriptionStatus,
} from "../lib/description-workflow";
import { DescriptionForm } from "../components/description/description-form";
import { DescriptionImageViewer } from "../components/description/description-image-viewer";
import { EntryNav } from "../components/description/entry-nav";
import { SectionTOC } from "../components/description/section-toc";
import { CommentThread } from "../components/comments/comment-thread";
import { FlagQcDialog } from "../components/qc-flags/flag-qc-dialog";
import { ResizableDivider } from "../components/outline/resizable-divider";
import type { Route } from "./+types/_auth.description.$projectId.$entryId";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const {
    loadDescriptionEntry,
    loadVolumeEntriesForDescription,
  } = await import("../lib/description.server");
  const { getCommentsForEntry } = await import("../lib/comments.server");
  const { hasOpenFlags } = await import("../lib/resegmentation.server");
  const { entries, volumes, projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Verify project membership
  const memberships = await requireProjectRole(
    db,
    user.id,
    params.projectId,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  // Load entry data
  const { entry, volume, pages } = await loadDescriptionEntry(
    db,
    params.entryId
  );

  // Verify the entry belongs to this project
  if (volume.projectId !== params.projectId) {
    throw new Response("Entry does not belong to this project", {
      status: 404,
    });
  }

  // Check description access
  const roleOrder = ["lead", "reviewer", "cataloguer"] as const;
  const userRole =
    memberships.length > 0
      ? roleOrder.find((r) => memberships.some((m) => m.role === r)) ??
        "cataloguer"
      : "cataloguer";

  const isLead = userRole === "lead";
  const isAssignedDescriber = entry.assignedDescriber === user.id;
  const isAssignedReviewer = entry.assignedDescriptionReviewer === user.id;

  if (!user.isAdmin && !isLead && !isAssignedDescriber && !isAssignedReviewer) {
    throw new Response("Forbidden", { status: 403 });
  }

  // Load all entries for navigation
  const allEntries = await loadVolumeEntriesForDescription(db, entry.volumeId);

  // Load comments
  const commentsData = await getCommentsForEntry(db, params.entryId);

  // Check for open resegmentation flags
  const isPaused = await hasOpenFlags(db, entry.volumeId);

  // Determine if read-only (reviewer viewing, or entry in non-editable status)
  const editableStatuses = ["assigned", "in_progress", "sent_back"];
  const statusAllowsEdit = editableStatuses.includes(entry.descriptionStatus ?? "");
  const hasEditRole = isLead || isAssignedDescriber;
  const canEdit = hasEditRole && statusAllowsEdit;
  const isReadOnly = !canEdit;

  // Determine why it's read-only so we can tell the user
  let readOnlyReason: string | null = null;
  if (isReadOnly) {
    if (!entry.descriptionStatus || entry.descriptionStatus === "unassigned") {
      readOnlyReason = "unassigned";
    } else if (!hasEditRole) {
      readOnlyReason = "not_assigned";
    } else if (!statusAllowsEdit) {
      readOnlyReason = "status";
    }
  }

  return {
    entry,
    volume,
    pages,
    allEntries,
    comments: commentsData as CommentWithAuthor[],
    currentUser: { id: user.id, email: user.email },
    userRole,
    isPaused,
    isReadOnly,
    readOnlyReason,
    projectId: params.projectId,
  };
}

// --- Save status indicator ---

function DescriptionSaveStatus({
  status,
}: {
  status: "saved" | "saving" | "unsaved";
}) {
  const { t } = useTranslation("description");
  const colors = {
    saved: "bg-verdigris",
    saving: "bg-saffron",
    unsaved: "bg-saffron",
  };
  const labels = {
    saved: t("editor.save_status_saved"),
    saving: t("editor.save_status_saving"),
    unsaved: t("editor.save_status_unsaved"),
  };

  return (
    <span className="flex items-center gap-1.5 text-xs text-stone-500">
      <span
        className={`inline-block h-2 w-2 rounded-full ${colors[status]}`}
      />
      {labels[status]}
    </span>
  );
}

// --- Main component ---

export default function DescriptionEditorRoute({
  loaderData,
}: Route.ComponentProps) {
  const {
    entry: initialEntry,
    volume,
    pages,
    allEntries,
    comments,
    currentUser,
    userRole,
    isPaused,
    isReadOnly,
    readOnlyReason,
    projectId,
  } = loaderData;

  const { t } = useTranslation("description");
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // Local entry state for optimistic updates
  const [entry, setEntry] = useState<DescriptionEntry>(
    initialEntry as DescriptionEntry
  );

  // Sync entry state when route changes (new entry loaded)
  useEffect(() => {
    setEntry(initialEntry as DescriptionEntry);
    setSaveStatus("saved");
  }, [initialEntry.id]);

  // Autosave state
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "saving" | "unsaved"
  >("saved");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntryRef = useRef(initialEntry.id);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  // Track current entry ID to discard stale saves
  useEffect(() => {
    currentEntryRef.current = initialEntry.id;
  }, [initialEntry.id]);

  // Section completion
  const sectionCompletion = useMemo(
    () => getSectionCompletion(entry),
    [entry]
  );

  // Active section tracking for TOC
  const [activeSectionId, setActiveSectionId] = useState("identificacion");

  // Resizable panel
  const MIN_PANEL_PCT = 35;
  const MAX_PANEL_PCT = 60;
  const [formPanelPct, setFormPanelPct] = useState(45);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (deltaX: number) => {
      if (!containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      const deltaPct = (deltaX / containerWidth) * 100;
      setFormPanelPct((pct) =>
        Math.min(MAX_PANEL_PCT, Math.max(MIN_PANEL_PCT, pct + deltaPct))
      );
    },
    []
  );

  // Field change handler with autosave
  const handleFieldChange = useCallback(
    (fieldName: string, value: string) => {
      setEntry((prev) => ({ ...prev, [fieldName]: value || null }));
      setSaveStatus("unsaved");
      setValidationErrors((prev) => {
        if (prev[fieldName]) {
          const next = { ...prev };
          delete next[fieldName];
          return next;
        }
        return prev;
      });

      // Debounced autosave
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        const entryIdAtSave = currentEntryRef.current;
        setSaveStatus("saving");

        fetch("/api/description/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entryId: entryIdAtSave,
            fields: {
              translatedTitle: value === "" ? null : fieldName === "translatedTitle" ? value : undefined,
              resourceType: fieldName === "resourceType" ? (value || null) : undefined,
              dateExpression: fieldName === "dateExpression" ? (value || null) : undefined,
              dateStart: fieldName === "dateStart" ? (value || null) : undefined,
              dateEnd: fieldName === "dateEnd" ? (value || null) : undefined,
              extent: fieldName === "extent" ? (value || null) : undefined,
              scopeContent: fieldName === "scopeContent" ? (value || null) : undefined,
              language: fieldName === "language" ? (value || null) : undefined,
              descriptionNotes: fieldName === "descriptionNotes" ? (value || null) : undefined,
              internalNotes: fieldName === "internalNotes" ? (value || null) : undefined,
            },
          }),
        })
          .then((res) => res.json())
          .then((data: any) => {
            // Discard if navigated to different entry
            if (currentEntryRef.current !== entryIdAtSave) return;
            if (data.ok) {
              setSaveStatus("saved");
            } else {
              setSaveStatus("unsaved");
            }
          })
          .catch(() => {
            if (currentEntryRef.current !== entryIdAtSave) return;
            setSaveStatus("unsaved");
          });
      }, 1500);
    },
    []
  );

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Full-field autosave: send all description fields at once
  const saveAllFields = useCallback(() => {
    const entryIdAtSave = currentEntryRef.current;
    setSaveStatus("saving");

    return fetch("/api/description/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryId: entryIdAtSave,
        fields: {
          translatedTitle: entry.translatedTitle,
          resourceType: entry.resourceType,
          dateExpression: entry.dateExpression,
          dateStart: entry.dateStart,
          dateEnd: entry.dateEnd,
          extent: entry.extent,
          scopeContent: entry.scopeContent,
          language: entry.language,
          descriptionNotes: entry.descriptionNotes,
          internalNotes: entry.internalNotes,
        },
      }),
    })
      .then((res) => res.json())
      .then((data: any) => {
        if (currentEntryRef.current !== entryIdAtSave) return;
        if (data.ok) {
          setSaveStatus("saved");
        }
      })
      .catch(() => {});
  }, [entry]);

  // Submit for review
  const handleSubmitForReview = useCallback(() => {
    // Save first, then submit
    const entryIdAtSave = currentEntryRef.current;

    fetch("/api/description/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryId: entryIdAtSave,
        action: "submit",
      }),
    })
      .then((res) => res.json())
      .then((data: any) => {
        if (data.ok) {
          setEntry((prev) => ({
            ...prev,
            descriptionStatus: "described" as DescriptionStatus,
          }));
          setValidationErrors({});
          revalidator.revalidate();
        } else if (data.validationErrors) {
          const errors: Record<string, string> = {};
          for (const err of data.validationErrors) {
            errors[err.field] = err.message;
          }
          setValidationErrors(errors);
        }
      })
      .catch(() => {});
  }, [revalidator]);

  // Entry navigation
  const currentIndex = allEntries.findIndex((e) => e.id === entry.id);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      const prevEntry = allEntries[currentIndex - 1];
      navigate(`/projects/${projectId}/describe/${prevEntry.id}`);
    }
  }, [currentIndex, allEntries, navigate, projectId]);

  const handleNext = useCallback(() => {
    if (currentIndex < allEntries.length - 1) {
      const nextEntry = allEntries[currentIndex + 1];
      navigate(`/projects/${projectId}/describe/${nextEntry.id}`);
    }
  }, [currentIndex, allEntries, navigate, projectId]);

  // Section TOC data
  const tocSections = useMemo(
    () => [
      {
        id: "identificacion",
        isComplete: sectionCompletion.identificacion,
        label: t("sections.identificacion"),
      },
      {
        id: "descripcion_fisica",
        isComplete: sectionCompletion.fisica,
        label: t("sections.descripcion_fisica"),
      },
      {
        id: "contenido",
        isComplete: sectionCompletion.contenido,
        label: t("sections.contenido"),
      },
      {
        id: "notas",
        isComplete: sectionCompletion.notas,
        label: t("sections.notas"),
      },
    ],
    [sectionCompletion, t]
  );

  const handleSectionClick = useCallback((sectionId: string) => {
    const el = document.getElementById(`section-${sectionId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setActiveSectionId(sectionId);
  }, []);

  // Resegmentation dialog state
  const [showResegDialog, setShowResegDialog] = useState(false);

  // QC flag dialog state (per-page flag raise in the
  // description editor). Single dialog instance at the tree root,
  // pre-filled via the page id and position captured when the
  // per-page flag button is clicked.
  const [flagDialog, setFlagDialog] = useState<{
    open: boolean;
    pageId: string | null;
    pagePosition: number | null;
  }>({ open: false, pageId: null, pagePosition: null });

  const handleFlagPage = useCallback(
    (pageId: string, pagePosition: number) => {
      setFlagDialog({ open: true, pageId, pagePosition });
    },
    []
  );

  const handleFlagDialogClose = useCallback(() => {
    setFlagDialog({ open: false, pageId: null, pagePosition: null });
  }, []);

  const handleFlagCreated = useCallback(() => {
    // Revalidate so any downstream surfaces picking up openQcFlagCount
    // (viewer, volume cards) refresh on the next loader pass.
    revalidator.revalidate();
  }, [revalidator]);

  const handleCommentAdded = useCallback(() => {
    revalidator.revalidate();
  }, [revalidator]);

  // Beforeunload handler for unsaved changes
  useEffect(() => {
    if (saveStatus !== "unsaved") return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 shrink-0 items-center border-b border-stone-200 bg-stone-50 px-4">
        {/* Left: logo + subtitle */}
        <div className="flex items-center gap-2">
          <Link to="/" className="flex items-center">
            <img src="/brand/fisqua-mark.svg" alt="" className="h-6 w-6" aria-hidden="true" />
          </Link>
          <span className="font-sans text-[0.875rem] text-stone-500">
            {t("editor.subtitle")}
          </span>
        </div>

        {/* Centre: entry title */}
        <div className="flex min-w-0 flex-1 justify-center">
          <h1 className="truncate font-serif text-[1.25rem] font-semibold text-stone-700">
            {entry.title || entry.translatedTitle || `#${entry.position + 1}`}
          </h1>
        </div>

        {/* Right: save status + user + logout */}
        <div className="flex items-center gap-3">
          <DescriptionSaveStatus status={saveStatus} />
          <span className="font-sans text-[0.875rem] text-stone-500">
            {currentUser.email}
          </span>
          <Link
            to="/auth/logout"
            className="font-sans text-[0.875rem] font-medium text-indigo hover:underline"
          >
            {t("editor.cerrar_sesion")}
          </Link>
        </div>
      </div>

      {/* Entry navigation bar */}
      <div className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-2">
        <EntryNav
          currentIndex={currentIndex}
          totalEntries={allEntries.length}
          currentEntry={{
            title: entry.title,
            descriptionStatus: entry.descriptionStatus,
          }}
          onPrev={handlePrev}
          onNext={handleNext}
          prevDisabled={currentIndex <= 0}
          nextDisabled={currentIndex >= allEntries.length - 1}
        />

        {/* Report issue button */}
        {!isPaused && userRole !== "lead" && (
          <button
            type="button"
            onClick={() => setShowResegDialog(true)}
            className="flex items-center gap-1.5 rounded-md border border-saffron bg-saffron-tint px-3 py-1.5 font-sans text-[0.8125rem] font-medium text-saffron-deep hover:bg-saffron-tint"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            {t("editor.reportar_problema")}
          </button>
        )}
      </div>

      {/* Read-only notice */}
      {isReadOnly && readOnlyReason && (
        <div className="flex items-center gap-2 border-b border-saffron bg-saffron-tint px-4 py-2 text-sm text-saffron-deep">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {t(`editor.readonly_${readOnlyReason}`)}
        </div>
      )}

      {/* Main split pane */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Form panel */}
        <div
          className="flex shrink-0 overflow-hidden"
          style={{ width: `${formPanelPct}%` }}
        >
          {/* Form scroll area */}
          <div className="flex-1 overflow-y-auto p-4">
            <DescriptionForm
              entry={entry}
              onFieldChange={handleFieldChange}
              sectionCompletion={sectionCompletion}
              isReadOnly={isReadOnly}
              isPaused={isPaused}
              onSubmitForReview={handleSubmitForReview}
              validationErrors={validationErrors}
            />

            {/* Comments section (pass volumeId through the
                legacy shim prop path; Plan 05 migrates to the
                discriminated target prop). */}
            <CommentThread
              entryId={entry.id}
              volumeId={entry.volumeId}
              comments={comments}
              onCommentAdded={handleCommentAdded}
            />
          </div>

          {/* Section TOC sidebar */}
          <SectionTOC
            sections={tocSections}
            onSectionClick={handleSectionClick}
            activeSectionId={activeSectionId}
          />
        </div>

        {/* Resizable divider */}
        <ResizableDivider onResize={handleResize} />

        {/* Image viewer panel */}
        <div className="flex-1 overflow-hidden">
          <DescriptionImageViewer
            pages={pages}
            currentEntryStartPage={entry.startPage}
            currentEntryEndPage={entry.endPage}
            onFlagPage={handleFlagPage}
          />
        </div>
      </div>

      {/* QC flag dialog. Single instance at the tree
          root — opened by handleFlagPage, closed either by submission or
          by the user. `volumeId` is derived from the loaded entry's volume
          so the server-side access check passes. */}
      {flagDialog.open && flagDialog.pageId && flagDialog.pagePosition !== null && (
        <FlagQcDialog
          open={flagDialog.open}
          onClose={handleFlagDialogClose}
          volumeId={volume.id}
          pageId={flagDialog.pageId}
          pagePosition={flagDialog.pagePosition}
          onCreated={handleFlagCreated}
        />
      )}

      {/* Re-segmentation dialog stub -- Plan 06 will provide FlagResegmentationDialog */}
      {showResegDialog && (
        <ResegmentationDialogStub
          onClose={() => {
            setShowResegDialog(false);
            revalidator.revalidate();
          }}
          entryId={entry.id}
          volumeId={volume.id}
          entry={entry}
          volume={volume}
          allEntries={allEntries}
          currentIndex={currentIndex}
        />
      )}
    </div>
  );
}

/**
 * Temporary stub for FlagResegmentationDialog.
 * Will be replaced when Plan 06 executes and creates the real component.
 */
function ResegmentationDialogStub({
  onClose,
  entryId,
  volumeId,
  entry,
  volume,
  allEntries,
  currentIndex,
}: {
  onClose: () => void;
  entryId: string;
  volumeId: string;
  entry: DescriptionEntry;
  volume: any;
  allEntries: any[];
  currentIndex: number;
}) {
  const { t } = useTranslation("description");
  const [problemType, setProblemType] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Get neighbouring entries
  const neighbourEntries = allEntries.filter(
    (_e, i) => Math.abs(i - currentIndex) <= 3 && i !== currentIndex
  );

  const [selectedAffected, setSelectedAffected] = useState<Set<string>>(
    () => new Set()
  );

  const canSubmit = problemType && description.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitting(true);

    fetch("/api/resegmentation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volumeId,
        entryId,
        problemType,
        affectedEntryIds: JSON.stringify(Array.from(selectedAffected)),
        description,
      }),
    })
      .then((res) => res.json())
      .then((data: any) => {
        if (data.ok) {
          onClose();
        }
        setSubmitting(false);
      })
      .catch(() => setSubmitting(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-lg bg-white p-6">
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-saffron-tint">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C68A2E"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 className="font-display text-[1.5rem] font-semibold text-stone-700">
            {t("resegmentation.reportar_problema")}
          </h2>
        </div>

        {/* Warning */}
        <div className="mb-4 rounded-lg bg-saffron-tint p-3 text-[0.875rem] text-saffron-deep">
          {t("resegmentation.warning")}
        </div>

        {/* Problem type */}
        <div className="mb-4">
          <p className="mb-2 font-sans text-[0.875rem] font-medium text-stone-700">
            {t("resegmentation.tipo_problema")}
          </p>
          <div className="space-y-2">
            {[
              {
                value: "incorrect_boundaries",
                label: t("resegmentation.limites_incorrectos"),
                desc: t("resegmentation.limites_incorrectos_desc"),
              },
              {
                value: "merged_documents",
                label: t("resegmentation.documentos_fusionados"),
                desc: t("resegmentation.documentos_fusionados_desc"),
              },
              {
                value: "split_document",
                label: t("resegmentation.documento_dividido"),
                desc: t("resegmentation.documento_dividido_desc"),
              },
              {
                value: "missing_pages",
                label: t("resegmentation.paginas_faltantes"),
                desc: "",
              },
              {
                value: "other",
                label: t("resegmentation.otro"),
                desc: "",
              },
            ].map((opt) => (
              <label
                key={opt.value}
                className="font-medium flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-stone-50"
              >
                <input
                  type="radio"
                  name="problemType"
                  value={opt.value}
                  checked={problemType === opt.value}
                  onChange={() => setProblemType(opt.value)}
                  className="mt-0.5 accent-saffron"
                />
                <div>
                  <span className="font-sans text-[0.875rem] font-medium text-stone-700">
                    {opt.label}
                  </span>
                  {opt.desc && (
                    <p className="font-sans text-[0.75rem] text-stone-500">
                      {opt.desc}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Affected entries */}
        {neighbourEntries.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 font-sans text-[0.875rem] font-medium text-stone-700">
              {t("resegmentation.entradas_afectadas")}
            </p>
            <div className="max-h-32 overflow-y-auto rounded border border-stone-200 p-2">
              {neighbourEntries.map((ne) => (
                <label
                  key={ne.id}
                  className="flex items-center gap-2 py-1 font-sans text-[0.8125rem] font-medium text-indigo"
                >
                  <input
                    type="checkbox"
                    checked={selectedAffected.has(ne.id)}
                    onChange={(e) => {
                      setSelectedAffected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) {
                          next.add(ne.id);
                        } else {
                          next.delete(ne.id);
                        }
                        return next;
                      });
                    }}
                  />
                  #{ne.position + 1}{" "}
                  {ne.title || ne.translatedTitle || t("viewer:no_title")}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        <div className="mb-4">
          <textarea
            className="min-h-[100px] w-full rounded border border-stone-200 p-3 font-sans text-[0.875rem] text-stone-700 placeholder:text-stone-400 focus:border-saffron focus:outline-none focus:ring-1 focus:ring-saffron"
            placeholder={t("resegmentation.descripcion_placeholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-2 font-sans text-[0.875rem] text-stone-500 hover:bg-stone-100"
          >
            {t("resegmentation.cancelar")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="rounded bg-saffron px-4 py-2 font-sans text-[0.875rem] font-medium text-white hover:bg-saffron-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("resegmentation.enviar_reporte")}
          </button>
        </div>
      </div>
    </div>
  );
}
