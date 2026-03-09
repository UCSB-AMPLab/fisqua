import { useState, useRef, useCallback } from "react";
import type { EntryType } from "../../lib/boundary-types";
import { TreeConnector } from "./tree-connector";

type OutlineEntryProps = {
  entry: { id: string; position: number; type: EntryType | null; title: string | null; parentId: string | null };
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
  isReviewerModified?: boolean;
  isReadonly?: boolean;
  isFirstEntry?: boolean;
  onDelete?: (entryId: string) => void;
  children?: React.ReactNode;
};

const TYPE_LABELS: Record<string, string> = {
  item: "Item",
  blank: "En blanco",
  front_matter: "Portada",
  back_matter: "Contraportada",
};

const TYPE_BADGE_COLORS: Record<string, string> = {
  item: "bg-blue-100 text-blue-700",
  blank: "bg-stone-100 text-stone-600",
  front_matter: "bg-amber-100 text-amber-700",
  back_matter: "bg-amber-100 text-amber-700",
};

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
  isReviewerModified,
  isReadonly,
  isFirstEntry,
  onDelete,
  children,
}: OutlineEntryProps) {
  const titleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          {entry.title || "Sin titulo"}
        </span>

        {/* Type badge */}
        {entry.type && (
          <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${isReviewerModified ? "bg-red-100 text-red-700" : TYPE_BADGE_COLORS[entry.type]}`}>
            {TYPE_LABELS[entry.type]}
          </span>
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
            title={confirmDelete ? "Confirmar eliminacion" : "Eliminar limite"}
          >
            {confirmDelete ? "Eliminar?" : "\u00D7"}
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
                Tipo
              </label>
              <select
                id={`type-${entry.id}`}
                className="rounded border border-stone-300 px-2 py-1 text-xs"
                value={entry.type || ""}
                onChange={handleTypeChange}
              >
                <option value="">(sin definir)</option>
                <option value="item">Item</option>
                <option value="blank">En blanco</option>
                <option value="front_matter">Portada</option>
                <option value="back_matter">Contraportada</option>
              </select>
            </div>

            {/* Title input */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-stone-500" htmlFor={`title-${entry.id}`}>
                Titulo
              </label>
              <input
                id={`title-${entry.id}`}
                type="text"
                className="flex-1 rounded border border-stone-300 px-2 py-1 text-xs"
                placeholder="Sin titulo"
                defaultValue={entry.title || ""}
                onChange={handleTitleChange}
                onBlur={handleTitleBlur}
              />
            </div>

            {/* Reference code */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-stone-500">Ref.</span>
              <span className="font-mono text-xs text-stone-600">{refCode}</span>
            </div>

            {/* Indent / Outdent buttons */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canOutdent}
                onClick={onOutdent}
                title="Mover al nivel superior"
              >
                &#8592;
              </button>
              <button
                type="button"
                className="rounded border border-stone-300 px-2 py-0.5 text-xs text-stone-600 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canIndent}
                onClick={onIndent}
                title="Anidar bajo el elemento anterior"
              >
                &#8594;
              </button>
              <span className="ml-1 text-[10px] text-stone-400">Nivel</span>
            </div>
          </div>
        </div>
      )}

      {/* Nested children */}
      {children}
    </div>
  );
}
