/**
 * Coordinate Input
 *
 * This component is the paired latitude/longitude number input with
 * optional precision. Used on the place edit form.
 *
 * @version v0.7.0
 */

import { useTranslation } from "react-i18next";

interface CoordinateInputProps {
  latitude: number | null;
  longitude: number | null;
  precision: string;
  onLatChange: (v: number | null) => void;
  onLngChange: (v: number | null) => void;
  onPrecisionChange: (v: string) => void;
  disabled?: boolean;
}

export function CoordinateInput({
  latitude,
  longitude,
  precision,
  onLatChange,
  onLngChange,
  onPrecisionChange,
  disabled = false,
}: CoordinateInputProps) {
  const { t } = useTranslation("places");

  function handleNumberChange(
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (v: number | null) => void
  ) {
    const val = e.target.value;
    if (val === "") {
      setter(null);
    } else {
      const num = parseFloat(val);
      if (!isNaN(num)) setter(num);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-indigo">
            {t("coord.latitude")}
          </label>
          <input
            type="number"
            min={-90}
            max={90}
            step="any"
            value={latitude ?? ""}
            onChange={(e) => handleNumberChange(e, onLatChange)}
            disabled={disabled}
            aria-label={t("coord.latitude")}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-indigo">
            {t("coord.longitude")}
          </label>
          <input
            type="number"
            min={-180}
            max={180}
            step="any"
            value={longitude ?? ""}
            onChange={(e) => handleNumberChange(e, onLngChange)}
            disabled={disabled}
            aria-label={t("coord.longitude")}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>
      <div className="mt-4">
        <label className="mb-1 block text-xs font-medium text-indigo">
          {t("coord.precision")}
        </label>
        <select
          value={precision}
          onChange={(e) => onPrecisionChange(e.target.value)}
          disabled={disabled}
          className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="approximate">{t("coord.precision_approximate")}</option>
          <option value="exact">{t("coord.precision_exact")}</option>
          <option value="centroid">{t("coord.precision_centroid")}</option>
        </select>
      </div>
    </div>
  );
}
