/**
 * Archive Stat Card
 *
 * Headline-sized number card used on the member dashboard to surface
 * archive-wide totals: volumes in progress, entries approved this
 * month, open QC flags. Purely presentational — numbers come from the
 * route loader.
 *
 * @version v0.3.0
 */
import type { LucideIcon } from "lucide-react";

type ArchiveStatCardProps = {
  icon: LucideIcon;
  label: string;
  value: number | string;
};

export function ArchiveStatCard({ icon: Icon, label, value }: ArchiveStatCardProps) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-tint">
          <Icon className="h-5 w-5 text-indigo" />
        </div>
        <div>
          <p className="text-sm text-stone-500">{label}</p>
          <p className="font-heading text-2xl font-semibold text-indigo">{value}</p>
        </div>
      </div>
    </div>
  );
}
