/**
 * Team Progress
 *
 * This component is the per-member breakdown rendered at the bottom of
 * the assignments page — one card per project member showing their
 * volume counts grouped by workflow status plus the headline totals
 * (volumes assigned, entries touched). Used so a lead can see, at a
 * glance, which member of the team is sitting on which load.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";
import { StatusBadge } from "../workflow/status-badge";
import { StackedProgressBar } from "../dashboard/progress-bar";

export type TeamMemberStats = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  statusCounts: Record<string, number>;
  totalVolumes: number;
  entryCount: number;
};

type TeamProgressProps = {
  members: TeamMemberStats[];
};

export function TeamProgress({ members }: TeamProgressProps) {
  const { t } = useTranslation("project");

  if (members.length === 0) {
    return (
      <p className="py-4 text-sm text-stone-400">
        {t("team.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-stone-700">{t("team.heading")}</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {members.map((member) => (
          <TeamMemberCard key={member.id} member={member} />
        ))}
      </div>
    </div>
  );
}

function TeamMemberCard({ member }: { member: TeamMemberStats }) {
  const { t } = useTranslation(["project", "workflow"]);

  const completed =
    (member.statusCounts["segmented"] ?? 0) +
    (member.statusCounts["reviewed"] ?? 0) +
    (member.statusCounts["approved"] ?? 0);

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-stone-900">
          {member.name ?? member.email}
        </span>
        <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
          {t(`workflow:role.${member.role}`)}
        </span>
      </div>

      {/* Mini progress bar */}
      <div className="mb-3">
        <StackedProgressBar counts={member.statusCounts} />
      </div>

      {/* Metrics */}
      <div className="flex gap-4 text-xs text-stone-500">
        <span>
          {t("project:team.completed_of", {
            completed,
            total: member.totalVolumes,
          })}
        </span>
        <span>
          <strong className="text-stone-700">{member.entryCount}</strong>{" "}
          {t("project:team.entries")}
        </span>
      </div>
    </div>
  );
}
