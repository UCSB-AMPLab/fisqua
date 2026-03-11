/**
 * Lead dashboard view.
 * Shows cross-project overview with:
 * - Attention items at top (volumes waiting >3d, inactive members, unassigned)
 * - Project cards with stacked progress bars and team lists
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { StackedProgressBar } from "./progress-bar";
import { relativeTime } from "~/lib/format";

export type AttentionItem = {
  type: "waiting" | "inactive" | "unassigned";
  link: string;
  // waiting
  volumeName?: string;
  days?: number;
  // inactive
  memberName?: string | null;
  // unassigned
  count?: number;
  projectName?: string;
};

export type TeamMember = {
  id: string;
  name: string | null;
  role: string;
  lastActiveAt: number | null;
  volumeCount: number;
};

export type ProjectOverview = {
  id: string;
  name: string;
  statusCounts: Record<string, number>;
  totalVolumes: number;
  teamMembers: TeamMember[];
};

type LeadDashboardProps = {
  projects: ProjectOverview[];
  attentionItems: AttentionItem[];
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  lead: "bg-indigo-100 text-indigo-700",
  cataloguer: "bg-blue-100 text-blue-700",
  reviewer: "bg-purple-100 text-purple-700",
};

function AttentionSection({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation("dashboard");

  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600">
        {t("group.needs_attention")}
        <span className="ml-2 text-xs font-normal">({items.length})</span>
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item, i) => (
          <Link
            key={i}
            to={item.link}
            className="block rounded-lg border border-red-200 bg-red-50 p-4 hover:border-red-300 hover:shadow-sm"
          >
            <p className="text-sm text-red-800">
              <AttentionItemDescription item={item} />
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

function AttentionItemDescription({ item }: { item: AttentionItem }) {
  const { t } = useTranslation(["dashboard", "common"]);

  if (item.type === "waiting") {
    const daysText = item.days === 0
      ? t("dashboard:today")
      : t("dashboard:days_waiting", { count: item.days });
    return <>{`"${item.volumeName}" \u2014 ${daysText}`}</>;
  }

  if (item.type === "unassigned") {
    const volumeText = t("common:domain.volume_count_full", { count: item.count });
    return <>{`${volumeText} sin asignar en "${item.projectName}"`}</>;
  }

  if (item.type === "inactive") {
    const name = item.memberName ?? t("dashboard:unnamed");
    const daysText = t("dashboard:days_waiting", { count: item.days });
    return <>{`${name} \u2014 ${daysText} sin actividad`}</>;
  }

  return null;
}

function ProjectCard({ project }: { project: ProjectOverview }) {
  const { t } = useTranslation(["dashboard", "common", "workflow"]);

  return (
    <div className="rounded-lg border border-stone-200 p-4">
      <div className="flex items-center justify-between">
        <Link
          to={`/projects/${project.id}`}
          className="font-medium text-stone-900 hover:underline"
        >
          {project.name}
        </Link>
        <span className="text-xs text-stone-400">
          {t("common:domain.volume_count", { count: project.totalVolumes })}
        </span>
      </div>

      <div className="mt-3">
        <StackedProgressBar counts={project.statusCounts} />
      </div>

      {project.teamMembers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-stone-500">{t("dashboard:group.team")}</h3>
          <div className="mt-2 divide-y divide-stone-100">
            {project.teamMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between py-1.5"
              >
                <div className="flex items-center gap-2">
                  <Link
                    to={`/users/${member.id}/activity`}
                    className="text-sm text-stone-700 hover:underline"
                  >
                    {member.name || t("dashboard:unnamed")}
                  </Link>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      ROLE_BADGE_STYLES[member.role] ?? "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {t(`workflow:role.${member.role}`)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-stone-400">
                  <span>{member.volumeCount} {t("dashboard:vol_abbr")}</span>
                  <span>{relativeTime(member.lastActiveAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function LeadDashboard({
  projects,
  attentionItems,
}: LeadDashboardProps) {
  const { t } = useTranslation("dashboard");

  if (projects.length === 0) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-pale-rose to-white">
            <svg className="h-8 w-8 text-burgundy" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="mt-4 font-serif text-lg font-semibold text-stone-900">{t("empty.no_projects_title")}</h3>
          <p className="mt-2 text-sm text-stone-500">
            {t("empty.no_lead_projects_body")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AttentionSection items={attentionItems} />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          {t("group.projects")}
          <span className="ml-2 text-xs font-normal">({projects.length})</span>
        </h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </section>
    </div>
  );
}
