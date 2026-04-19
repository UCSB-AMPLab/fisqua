/**
 * Linked Open Data Link Field
 *
 * Input for an external authority identifier (Wikidata, VIAF, TGN)
 * with a click-through link icon that opens the resolved URL in a
 * new tab.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { ExternalLink } from "lucide-react";

type LodService = "wikidata" | "viaf" | "tgn" | "hgis" | "whg";

interface LodLinkFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  service: LodService;
  disabled?: boolean;
  error?: string;
}

const SERVICE_PATTERNS: Record<LodService, RegExp> = {
  wikidata: /^Q\d+$/,
  viaf: /^\d+$/,
  tgn: /^\d+$/,
  hgis: /^[a-zA-Z0-9]+$/,
  whg: /^[a-zA-Z0-9]+$/,
};

const SERVICE_URLS: Record<LodService, (id: string) => string> = {
  wikidata: (id) => `https://www.wikidata.org/wiki/${id}`,
  viaf: (id) => `https://viaf.org/viaf/${id}`,
  tgn: (id) => `https://vocab.getty.edu/tgn/${id}`,
  hgis: (id) => `https://hgis-indias.net/place/${id}`,
  whg: (id) => `https://whgazetteer.org/places/${id}`,
};

export function LodLinkField({
  label,
  value,
  onChange,
  service,
  disabled = false,
  error: externalError,
}: LodLinkFieldProps) {
  const [localError, setLocalError] = useState<string | null>(null);

  function handleBlur() {
    if (!value) {
      setLocalError(null);
      return;
    }
    if (!SERVICE_PATTERNS[service].test(value)) {
      setLocalError("Invalid format");
    } else {
      setLocalError(null);
    }
  }

  const displayError = externalError || localError;
  const hasError = !!displayError;

  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <label className="text-xs font-normal text-[#78716C]">{label}</label>
        {value && !hasError && (
          <a
            href={SERVICE_URLS[service](value)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${service} record in new tab`}
          >
            <ExternalLink className="h-3.5 w-3.5 text-[#6B1F33]" />
          </a>
        )}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
        className={`w-full rounded-lg border px-3 py-2 font-sans text-sm text-[#44403C] focus:outline-none focus:ring-1 ${
          hasError
            ? "border-[#DC2626] focus:border-[#DC2626] focus:ring-[#DC2626]"
            : "border-[#E7E5E4] focus:border-[#8B2942] focus:ring-[#8B2942]"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      />
      {displayError && (
        <p className="mt-1 text-xs text-[#DC2626]">{displayError}</p>
      )}
    </div>
  );
}
