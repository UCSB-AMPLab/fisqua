/**
 * Name Variant Input
 *
 * Editable chip list for an entity's or place's known name variants.
 * Users type a new variant and press Enter to append; each chip
 * carries a close button to remove it.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { X } from "lucide-react";

interface NameVariantInputProps {
  value: string[];
  onChange: (variants: string[]) => void;
  addLabel?: string;
}

export function NameVariantInput({
  value,
  onChange,
  addLabel = "Agregar variante",
}: NameVariantInputProps) {
  const [inputValue, setInputValue] = useState("");

  function addVariant() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    if (!value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputValue("");
  }

  function removeVariant(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addVariant();
    }
  }

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {value.map((variant, index) => (
            <span
              key={`${variant}-${index}`}
              className="inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-1 text-xs text-stone-700"
            >
              {variant}
              <button
                type="button"
                onClick={() => removeVariant(index)}
                aria-label={`Remove variant: ${variant}`}
                className="text-stone-400 hover:text-stone-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Add name variant"
          className="flex-1 rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        />
        <button
          type="button"
          onClick={addVariant}
          className="rounded-md border border-stone-200 px-3 py-2 font-sans text-sm font-semibold text-stone-700 hover:bg-stone-50"
        >
          {addLabel}
        </button>
      </div>
    </div>
  );
}
