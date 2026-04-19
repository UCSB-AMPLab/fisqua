/**
 * Coordinate Input
 *
 * Paired latitude/longitude number input with optional precision.
 * Used on the place edit form.
 *
 * @version v0.3.0
 */

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
          <label className="mb-1 block text-xs font-normal text-[#78716C]">
            Latitude
          </label>
          <input
            type="number"
            min={-90}
            max={90}
            step="any"
            value={latitude ?? ""}
            onChange={(e) => handleNumberChange(e, onLatChange)}
            disabled={disabled}
            aria-label="Latitude"
            className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942] disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-normal text-[#78716C]">
            Longitude
          </label>
          <input
            type="number"
            min={-180}
            max={180}
            step="any"
            value={longitude ?? ""}
            onChange={(e) => handleNumberChange(e, onLngChange)}
            disabled={disabled}
            aria-label="Longitude"
            className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942] disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>
      <div className="mt-4">
        <label className="mb-1 block text-xs font-normal text-[#78716C]">
          Precision
        </label>
        <select
          value={precision}
          onChange={(e) => onPrecisionChange(e.target.value)}
          disabled={disabled}
          className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] focus:border-[#8B2942] focus:outline-none focus:ring-1 focus:ring-[#8B2942] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="approximate">Aproximada</option>
          <option value="exact">Exacta</option>
          <option value="centroid">Centroide</option>
        </select>
      </div>
    </div>
  );
}
