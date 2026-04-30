/**
 * Cataloguer dashboard view.
 * Shows assigned volumes grouped by urgency:
 * 1. Needs attention (sent_back with reviewer comments)
 * 2. In progress
 * 3. Ready to start (unstarted)
 * 4. Completed (segmented, approved)
 */

import { useTranslation } from "react-i18next";
import { VolumeStatusCard, type VolumeCardData } from "./volume-status-card";

export type CataloguerGroups = {
  needsAttention: VolumeCardData[];
  inProgress: VolumeCardData[];
  readyToStart: VolumeCardData[];
  completed: VolumeCardData[];
};

type CataloguerDashboardProps = {
  groups: CataloguerGroups;
};

function VolumeGroup({
  title,
  volumes,
  emptyText,
}: {
  title: string;
  volumes: VolumeCardData[];
  emptyText?: string;
}) {
  if (volumes.length === 0 && !emptyText) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
        {title}
        {volumes.length > 0 && (
          <span className="ml-2 text-xs font-normal">({volumes.length})</span>
        )}
      </h2>
      {volumes.length === 0 && emptyText ? (
        <p className="mt-2 text-sm text-stone-400">{emptyText}</p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {volumes.map((v) => (
            <VolumeStatusCard key={v.id} volume={v} />
          ))}
        </div>
      )}
    </section>
  );
}

export function CataloguerDashboard({ groups }: CataloguerDashboardProps) {
  const { t } = useTranslation("dashboard");
  const totalVolumes =
    groups.needsAttention.length +
    groups.inProgress.length +
    groups.readyToStart.length +
    groups.completed.length;

  if (totalVolumes === 0) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-indigo-tint to-white">
            <svg className="h-7 w-7 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
          </div>
          <h3 className="mt-4 font-serif text-[18px] font-semibold text-indigo">{t("empty.no_assignments_title")}</h3>
          <p className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto">
            {t("empty.no_assignments_body")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <VolumeGroup title={t("group.needs_attention")} volumes={groups.needsAttention} />
      <VolumeGroup title={t("group.in_progress")} volumes={groups.inProgress} />
      <VolumeGroup title={t("group.ready_to_start")} volumes={groups.readyToStart} />
      <VolumeGroup title={t("group.completed")} volumes={groups.completed} />
    </div>
  );
}
