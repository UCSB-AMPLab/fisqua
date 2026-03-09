/**
 * Cataloguer dashboard view.
 * Shows assigned volumes grouped by urgency:
 * 1. Needs attention (sent_back with reviewer comments)
 * 2. In progress
 * 3. Ready to start (unstarted)
 * 4. Completed (segmented, approved)
 */

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
  const totalVolumes =
    groups.needsAttention.length +
    groups.inProgress.length +
    groups.readyToStart.length +
    groups.completed.length;

  if (totalVolumes === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-sm text-stone-500">No volumes assigned yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <VolumeGroup title="Needs attention" volumes={groups.needsAttention} />
      <VolumeGroup title="In progress" volumes={groups.inProgress} />
      <VolumeGroup title="Ready to start" volumes={groups.readyToStart} />
      <VolumeGroup title="Completed" volumes={groups.completed} />
    </div>
  );
}
