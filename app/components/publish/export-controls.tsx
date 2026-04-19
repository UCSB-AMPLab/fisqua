/**
 * Publish Export Controls
 *
 * The fonds and data-type pickers plus the Publish button on the
 * dashboard. Holds selection state locally and routes the Publish
 * click through the `PublishWarningModal` so a careless click never
 * kicks off a multi-minute run.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PublishWarningModal } from "./publish-warning-modal";

const DATA_TYPES = ["descriptions", "repositories", "entities", "places"] as const;

interface ExportControlsProps {
  fondsList: string[];
  disabled?: boolean;
  totalRecordCount: number;
  onExport: (selectedFonds: string[], selectedTypes: string[]) => void;
}

export function ExportControls({
  fondsList,
  disabled,
  totalRecordCount,
  onExport,
}: ExportControlsProps) {
  const { t } = useTranslation("publish");

  const [selectedFonds, setSelectedFonds] = useState<Set<string>>(
    new Set(fondsList)
  );
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    new Set(DATA_TYPES)
  );
  const [showWarning, setShowWarning] = useState(false);

  function handleConfirmedExport() {
    setShowWarning(false);
    onExport(Array.from(selectedFonds), Array.from(selectedTypes));
  }

  function toggleFonds(code: string) {
    setSelectedFonds((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleType(type: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function selectAllFonds() {
    setSelectedFonds(new Set(fondsList));
  }

  function deselectAllFonds() {
    setSelectedFonds(new Set());
  }

  const canExport =
    !disabled && selectedFonds.size > 0 && selectedTypes.size > 0;

  return (
    <section className="space-y-4">
      <h2 className="font-sans text-lg font-semibold text-stone-800">
        {t("controls.title")}
      </h2>

      {/* Fonds selection */}
      <div className="rounded-lg border border-stone-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-sans text-sm font-medium text-stone-700">
            {t("controls.selectFonds")}
          </h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAllFonds}
              className="font-sans text-xs text-[#8B2942] hover:underline"
            >
              {t("controls.selectAll")}
            </button>
            <span className="text-stone-300">|</span>
            <button
              type="button"
              onClick={deselectAllFonds}
              className="font-sans text-xs text-[#8B2942] hover:underline"
            >
              {t("controls.deselectAll")}
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {fondsList.map((code) => (
            <label
              key={code}
              className="flex items-center gap-2 font-sans text-sm text-stone-700"
            >
              <input
                type="checkbox"
                checked={selectedFonds.has(code)}
                onChange={() => toggleFonds(code)}
                className="rounded border-stone-300 text-[#8B2942] focus:ring-[#8B2942]"
              />
              {code}
            </label>
          ))}
        </div>
      </div>

      {/* Data type selection */}
      <div className="rounded-lg border border-stone-200 p-4">
        <h3 className="font-sans text-sm font-medium text-stone-700">
          {t("controls.selectTypes")}
        </h3>
        <div className="mt-3 flex flex-wrap gap-4">
          {DATA_TYPES.map((type) => (
            <label
              key={type}
              className="flex items-center gap-2 font-sans text-sm text-stone-700"
            >
              <input
                type="checkbox"
                checked={selectedTypes.has(type)}
                onChange={() => toggleType(type)}
                className="rounded border-stone-300 text-[#8B2942] focus:ring-[#8B2942]"
              />
              {t(`controls.${type}`)}
            </label>
          ))}
        </div>
      </div>

      {/* Export trigger */}
      <button
        type="button"
        disabled={!canExport}
        onClick={() => setShowWarning(true)}
        className="rounded-lg bg-[#8B2942] px-5 py-2.5 font-sans text-sm font-semibold text-white hover:bg-[#7a2439] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {disabled ? t("controls.exporting") : t("controls.triggerExport")}
      </button>

      <PublishWarningModal
        open={showWarning}
        totalRecordCount={totalRecordCount}
        onConfirm={handleConfirmedExport}
        onCancel={() => setShowWarning(false)}
      />
    </section>
  );
}
