import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Entry, EntryType } from "../../lib/boundary-types";
import { TreeConnector } from "./tree-connector";

type OutlineEntryProps = {
  entry: Entry;
  refCode: string;
  pageRange: string;
  depth: number;
  isLast: boolean;
  isHighlighted: boolean;
  isExpanded: boolean;
  hasChildren: boolean;
  canIndent: boolean;
  canOutdent: boolean;
  onToggle: () => void;
  onScrollTo: () => void;
  onSetType: (type: EntryType | null) => void;
  onSetTitle: (title: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onSetNote: (note: string) => void;
  onSetReviewerComment: (comment: string) => void;
  accessLevel: "edit" | "review" | "readonly";
  onHeightChange?: () => void;
  isReviewerModified?: boolean;
  isReadonly?: boolean;
  isFirstEntry?: boolean;
  onDelete?: (entryId: string) => void;
  children?: React.ReactNode;
};

const TYPE_BADGE_COLORS: Record<string, string> = {
  item: "bg-blue-100 text-blue-700",
  blank: "bg-stone-100 text-stone-600",
  front_matter: "bg-amber-100 text-amber-700",
  back_matter: "bg-amber-100 text-amber-700",
};

function formatRelativeTime(timestamp: number): string {
  const rtf = new Intl.RelativeTimeFormat("es-CO", { numeric: "auto" });
  const diffMs = timestamp - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHr / 24);

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");
  return rtf.format(diffDay, "day");
}

const NOTE_MAX_LENGTH = 500;

export function OutlineEntry({
  entry,
  refCode,
  pageRange,
  depth,
  isLast,
  isHighlighted,
  isExpanded,
  hasChildren,
  canIndent,
  canOutdent,
  onToggle,
  onScrollTo,
  onSetType,
  onSetTitle,
  onIndent,
  onOutdent,
  onSetNote,
  onSetReviewerComment,
  accessLevel,
  onHeightChange,
  isReviewerModified,
  isFirstEntry,
  onDelete,
  children,
}: OutlineEntryProps) {
  const { t } = useTranslation("viewer");
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isReadonly = accessLevel === "readonly";

  const [commentsOpen, setCommentsOpen] = useState(
    Boolean(entry.note || entry.reviewerComment)
  );

  const handleToggleComments = useCallback(() => {
    setCommentsOpen((prev) => !prev);
    // Notify virtualiser of height change
    if (onHeightChange) {
      // Use requestAnimationFrame to let the DOM update first
      requestAnimationFrame(() => onHeightChange());
    }
  }, [onHeightChange]);

  const handleClick = useCallback(() => {
    onToggle();
    onScrollTo();
  }, [onToggle, onScrollTo]);

  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      onSetType(value === "" ? null : (value as EntryType));
    },
    [onSetType]
  );

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
      titleTimeoutRef.current = setTimeout(() => {
        onSetTitle(value);
      }, 400);
    },
    [onSetTitle]
  );

  const handleTitleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      if (titleTimeoutRef.current) clearTimeout(titleTimeoutRef.current);
      onSetTitle(e.target.value);
    },
    [onSetTitle]
  );

  const handleNoteChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
      noteTimeoutRef.current = setTimeout(() => {
        onSetNote(value);
      }, 400);
    },
    [onSetNote]
  );

  const handleNoteBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      if (noteTimeoutRef.current) clearTimeout(noteTimeoutRef.current);
      onSetNote(e.target.value);
    },
    [onSetNote]
  );

  const handleCommentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      if (commentTimeoutRef.current) clearTimeout(commentTimeoutRef.current);
      commentTimeoutRef.current = setTimeout(() => {
        onSetReviewerComment(value);
      }, 400);
    },
    [onSetReviewerComment]
  );

  const handleCommentBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      if (commentTimeoutRef.current) clearTimeout(commentTimeoutRef.current);
      onSetReviewerComment(e.target.value);
    },
    [onSetReviewerComment]
  );

  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirmDelete) {
        onDelete?.(entry.id);
        setConfirmDelete(false);
      } else {
        setConfirmDelete(true);
        // Auto-reset after 3 seconds
        setTimeout(() => setConfirmDelete(false), 3000);
      }
    },
    [confirmDelete, entry.id, onDelete]
  );

  // Track note/comment character counts via refs to avoid re-renders
  const [noteLength, setNoteLength] = useState(entry.note?.length || 0);
  const [commentLength, setCommentLength] = useState(entry.reviewerComment?.length || 0);

  const handleNoteInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setNoteLength(e.target.value.length);
      handleNoteChange(e);
    },
    [handleNoteChange]
  );

  const handleCommentInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setCommentLength(e.target.value.length);
      handleCommentChange(e);
    },
    [handleCommentChange]
  );

  // Determine border/background styles based on state
  let borderClass: string;
  let bgClass: string;
  if (isReviewerModified) {
    borderClass = "border-l-2 border-red-500";
    bgClass = "bg-red-50";
  } else if (isHighlighted) {
    borderClass = "border-l-2 border-blue-500";
    bgClass = "bg-blue-50";
  } else {
    borderClass = "border-l-2 border-transparent";
    bgClass = "";
  }

  const titleColor = isReviewerModified
    ? entry.title ? "text-red-700" : "italic text-red-400"
    : entry.title ? "text-stone-800" : "italic text-stone-400";

  const typeLabel = entry.type ? t(`outline.type.${entry.type}`) : null;

  return (
    <div>
      {/* Summary line */}
      <div
        className={`flex cursor-pointer items-center gap-1.5 px-2 py-1.5 transition-colors hover:bg-stone-50 ${borderClass} ${bgClass}`}
        onClick={handleClick}
      >
        <TreeConnector depth={depth} isLast={isLast} hasChildren={hasChildren} />

        {/* Sequence badge */}
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-stone-200 text-xs font-medium text-stone-600">
          {entry.position + 1}
        </span>

        {/* Page range */}
        <span className={`shrink-0 text-xs ${isReviewerModified ? "text-red-500" : "text-stone-500"}`}>{pageRange}</span>

        {/* Title */}
        <span className={`min-w-0 truncate text-sm ${titleColor}`}>
          {entry.title || t("outline.no_title")}
        </span>

        {/* Type badge */}
        {entry.type && typeLabel && (
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${isReviewerModified ? "bg-red-100 text-red-700" : TYPE_BADGE_COLORS[entry.type]}`}>
            {typeLabel}
          </span>
        )}

        {/* Note/comment dot indicators */}
        {entry.note && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title={t("outline.has_note")} />
        )}
        {entry.reviewerComment && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" title={t("outline.has_reviewer_comment")} />
        )}

        {/* Delete button (hidden in readonly mode and for first entry) */}
        {!isReadonly && !isFirstEntry && onDelete && (
          <button
            type="button"
            className={`shrink-0 rounded px-1 py-0.5 text-xs ${
              confirmDelete
                ? "bg-red-100 text-red-700 hover:bg-red-200"
                : "text-stone-400 hover:text-red-600"
            }`}
            onClick={handleDeleteClick}
            title={confirmDelete ? t("outline.confirm_delete_tooltip") : t("outline.delete_boundary")}
          >
            {confirmDelete ? t("outline.confirm_delete") : "\u00D7"}
          </button>
        )}

        {/* Expand indicator */}
        <span className="ml-auto shrink-0 text-xs text-stone-400">
          {isExpanded ? "\u25B4" : "\u25BE"}
        </span>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div
          className="border-l-2 border-transparent bg-stone-50 px-4 py-2"
          style={{ marginLeft: depth * 20 + 20 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-2">
            {/* Type dropdown */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-stone-500" htmlFor={`type-${entry.id}`}>
                {t("outline.type_label")}
              </label>
              <select
                id={`type-${entry.id}`}
                className="rounded border border-stone-300 px-2 py-1 text-xs"
                value={entry.type || ""}
                onChange={handleTypeChange}
              >
                <option value="">{t("outline.no_type")}</option>
                <option value="item">{t("outline.type.item")}</option>
                <option value="blank">{t("outline.type.blank")}</option>
                <option value="front_matter">{t("outline.type.front_matter")}</option>
                <option value="back_matter">{t("outline.type.back_matter")}</option>
              </select>
            </div>

            {/* Title input */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-stone-500" htmlFor={`title-${entry.id}`}>
                {t("outline.title_label")}
              </label>
              <input
                id={`title-${entry.id}`}
                type="text"
                className="flex-1 rounded border border-stone-300 px-2 py-1 text-xs"
                placeholder={t("outline.no_title")}
                defaultValue={entry.title || ""}
                onChange={handleTitleChange}
                onBlur={handleTitleBlur}
              />
            </div>

            {/* Reference code */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-stone-500">{t("outline.ref_label")}</span>
              <span className="font-mono text-xs text-stone-600">{refCode}</span>
            </div>

            {/* Indent / Outdent buttons */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canOutdent}
                onClick={onOutdent}
                title={t("outline.outdent_tooltip")}
              >
                &#8592;
              </button>
              <button
                type="button"
                className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canIndent}
                onClick={onIndent}
                title={t("outline.indent_tooltip")}
              >
                &#8594;
              </button>
              <span className="ml-1 text-[10px] text-stone-400">{t("outline.level_label")}</span>
            </div>

            {/* Comments toggle */}
            <button
              type="button"
              onClick={handleToggleComments}
              className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700"
            >
              <span>{commentsOpen ? "\u25B4" : "\u25BE"}</span>
              <span>{t("outline.comments_label")}</span>
            </button>

            {/* Collapsible comments section */}
            <div className="comments-collapse" data-open={commentsOpen}>
              <div>
                <div className="space-y-3 rounded-md bg-pale-rose/30 p-3">
                  {/* Cataloguer note */}
                  <div>
                    <label
                      className="font-serif text-xs font-medium italic text-stone-600"
                      htmlFor={`note-${entry.id}`}
                    >
                      {t("outline.cataloguer_note_label")}
                    </label>
                    <textarea
                      id={`note-${entry.id}`}
                      className="mt-1 w-full resize-y rounded border border-stone-200 bg-white/80 p-2 font-serif text-sm italic text-stone-800 focus:border-stone-400 focus:outline-none"
                      rows={2}
                      maxLength={NOTE_MAX_LENGTH}
                      readOnly={accessLevel !== "edit"}
                      defaultValue={entry.note || ""}
                      placeholder={accessLevel === "edit" ? t("outline.cataloguer_note_placeholder") : ""}
                      onChange={handleNoteInput}
                      onBlur={handleNoteBlur}
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-stone-400">
                        {entry.noteUpdatedBy && entry.noteUpdatedAt
                          ? `${entry.noteUpdatedBy} \u00B7 ${formatRelativeTime(entry.noteUpdatedAt)}`
                          : ""}
                      </span>
                      <span className="text-[10px] text-stone-400">
                        {noteLength}/{NOTE_MAX_LENGTH}
                      </span>
                    </div>
                  </div>

                  {/* Reviewer comment */}
                  <div>
                    <label
                      className="font-serif text-xs font-medium italic text-stone-600"
                      htmlFor={`comment-${entry.id}`}
                    >
                      {t("outline.reviewer_comment_field_label")}
                    </label>
                    <textarea
                      id={`comment-${entry.id}`}
                      className="mt-1 w-full resize-y rounded border border-stone-200 bg-white/80 p-2 font-serif text-sm italic text-stone-800 focus:border-stone-400 focus:outline-none"
                      rows={2}
                      maxLength={NOTE_MAX_LENGTH}
                      readOnly={accessLevel !== "review"}
                      defaultValue={entry.reviewerComment || ""}
                      placeholder={accessLevel === "review" ? t("outline.reviewer_comment_placeholder") : ""}
                      onChange={handleCommentInput}
                      onBlur={handleCommentBlur}
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-stone-400">
                        {entry.reviewerCommentUpdatedBy && entry.reviewerCommentUpdatedAt
                          ? `${entry.reviewerCommentUpdatedBy} \u00B7 ${formatRelativeTime(entry.reviewerCommentUpdatedAt)}`
                          : ""}
                      </span>
                      <span className="text-[10px] text-stone-400">
                        {commentLength}/{NOTE_MAX_LENGTH}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Nested children */}
      {children}
    </div>
  );
}
