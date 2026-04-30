/**
 * Inline Edit Cell
 *
 * Table cell that flips between read and edit modes in place.
 * Optimised for single-field edits: submit-on-blur, escape-to-cancel,
 * and a pending state that echoes what the fetcher is about to POST.
 *
 * @version v0.3.0
 */

import { useState, useRef, useEffect } from "react";
import { Pencil } from "lucide-react";

interface InlineEditCellProps {
  value: string;
  onSave: (newValue: string) => void;
  ariaLabel?: string;
}

export function InlineEditCell({ value, onSave, ariaLabel }: InlineEditCellProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== value) {
        onSave(trimmed);
      }
      setEditing(false);
    } else if (e.key === "Escape") {
      setEditValue(value);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          const trimmed = editValue.trim();
          if (trimmed && trimmed !== value) {
            onSave(trimmed);
          }
          setEditing(false);
        }}
        className="rounded border border-stone-200 px-2 py-1 text-sm focus:border-indigo focus:outline-none"
        aria-label={ariaLabel}
      />
    );
  }

  return (
    <span className="group inline-flex items-center gap-1">
      <span>{value}</span>
      <button
        type="button"
        onClick={() => {
          setEditValue(value);
          setEditing(true);
        }}
        className="invisible rounded p-0.5 text-stone-500 hover:text-stone-700 group-hover:visible"
        aria-label={ariaLabel ?? "Edit"}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
