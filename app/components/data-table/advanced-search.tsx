/**
 * Advanced Search Panel
 *
 * Reusable multi-field search panel for the admin data tables. Emits
 * a structured filter payload on submit that the hosting route can
 * translate into query parameters; controls are rendered declaratively
 * from a field definition array.
 *
 * @version v0.3.0
 */
import { useState } from "react";
import { Form, useSearchParams } from "react-router";

interface AdvancedField {
  name: string;
  label: string;
}

interface AdvancedSearchPanelProps {
  fields: AdvancedField[];
  searchParams: URLSearchParams;
  toggleLabel: string;
  hideLabel: string;
  clearLabel: string;
  searchLabel: string;
  activeLabel: string;
}

/**
 * Check whether any advanced search field has a value in the current URL params.
 */
export function isAdvancedActive(
  searchParams: URLSearchParams,
  fields: AdvancedField[]
): boolean {
  return fields.some((f) => !!searchParams.get(f.name));
}

export function AdvancedSearchPanel({
  fields,
  searchParams,
  toggleLabel,
  hideLabel,
  clearLabel,
  searchLabel,
  activeLabel,
}: AdvancedSearchPanelProps) {
  const active = isAdvancedActive(searchParams, fields);
  const [isOpen, setIsOpen] = useState(active);
  const panelId = "advanced-search-panel";

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-sm text-[#6B1F33] hover:underline"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={() => setIsOpen(!isOpen)}
        >
          {isOpen ? hideLabel : toggleLabel}
        </button>
        {active && !isOpen && (
          <span className="text-xs text-[#78716C]">{activeLabel}</span>
        )}
      </div>

      {isOpen && (
        <Form method="get" id={panelId} className="mt-2 rounded-b-lg border-t border-stone-300 bg-stone-50 p-4">
          <div className="grid grid-cols-3 gap-4">
            {fields.map((field) => (
              <div key={field.name}>
                <label
                  htmlFor={`adv-${field.name}`}
                  className="mb-1 block text-xs text-stone-500"
                >
                  {field.label}
                </label>
                <input
                  id={`adv-${field.name}`}
                  type="text"
                  name={field.name}
                  defaultValue={searchParams.get(field.name) || ""}
                  className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942]"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                // Clear all advanced fields by navigating without params
                const form = document.getElementById(panelId) as HTMLFormElement;
                if (form) {
                  const inputs = form.querySelectorAll<HTMLInputElement>("input[type=text]");
                  inputs.forEach((input) => { input.value = ""; });
                  form.requestSubmit();
                }
              }}
              className="rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm font-semibold text-[#44403C] hover:bg-white"
            >
              {clearLabel}
            </button>
            <button
              type="submit"
              className="rounded-lg bg-[#6B1F33] px-3 py-2 font-sans text-sm font-semibold text-white hover:bg-[#8B2942]"
            >
              {searchLabel}
            </button>
          </div>
        </Form>
      )}
    </div>
  );
}
