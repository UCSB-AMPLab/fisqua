/**
 * Promotion Volume Selector
 *
 * Dropdown of volumes that currently contain at least one promotable
 * entry. Drives the rest of the promotion surface: picking a volume
 * loads its manifest URL into the placeholder IIIF viewer and pulls
 * the promotable-entries list into the table below.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";

interface Volume {
  id: string;
  name: string;
  referenceCode: string;
  promotableCount: number;
}

interface VolumeSelectorProps {
  volumes: Volume[];
  onSelect: (volumeId: string) => void;
}

export function VolumeSelector({ volumes, onSelect }: VolumeSelectorProps) {
  const { t } = useTranslation("promote");

  if (volumes.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="font-sans text-sm text-stone-500">
          {t("volume.empty")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-4 font-sans text-sm font-semibold text-stone-900">
        {t("volume.heading")}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {volumes.map((volume) => (
          <button
            key={volume.id}
            type="button"
            onClick={() => onSelect(volume.id)}
            className="cursor-pointer rounded-lg border border-stone-300 bg-stone-50 p-4 text-left transition-colors hover:border-stone-400"
          >
            <p className="font-mono text-sm text-stone-700">
              {volume.referenceCode}
            </p>
            <p className="mt-1 font-sans text-sm font-medium text-stone-900">
              {volume.name}
            </p>
            <p className="mt-2 font-sans text-xs text-stone-500">
              {volume.promotableCount} approved entries
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
