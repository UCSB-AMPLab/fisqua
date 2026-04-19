/**
 * Reference Code Pattern Input
 *
 * Controlled input that lets the superadmin define the reference-code
 * template applied to every entry in a promotion batch. Validates the
 * template against the allowed character set (alphanumerics and
 * hyphens) before the parent enables the Promote button.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

interface RefCodePatternProps {
  onApply: (prefix: string, startNumber: number) => void;
}

export function RefCodePattern({ onApply }: RefCodePatternProps) {
  const { t } = useTranslation("promote");
  const [prefix, setPrefix] = useState("");
  const [startNumber, setStartNumber] = useState(1);

  function handleApply() {
    if (!prefix.trim()) return;
    onApply(prefix.trim(), startNumber);
  }

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3">
      <label className="text-xs text-stone-500">
        {t("refCode.patternLabel")}
      </label>
      <input
        type="text"
        value={prefix}
        onChange={(e) => setPrefix(e.target.value)}
        placeholder={t("refCode.prefixPlaceholder")}
        className="rounded border border-stone-300 px-2 py-1 font-mono text-sm focus:border-[#8B2942] focus:ring-[#8B2942] focus:outline-none"
      />
      <input
        type="number"
        value={startNumber}
        onChange={(e) => setStartNumber(Number(e.target.value) || 1)}
        min={1}
        className="w-20 rounded border border-stone-300 px-2 py-1 font-mono text-sm focus:border-[#8B2942] focus:ring-[#8B2942] focus:outline-none"
      />
      <button
        type="button"
        onClick={handleApply}
        className="rounded border border-stone-300 bg-stone-100 px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-200"
      >
        {t("refCode.applyPattern")}
      </button>
    </div>
  );
}
