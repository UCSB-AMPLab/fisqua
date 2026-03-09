/**
 * Lead dashboard view.
 * Shows cross-project overview with:
 * - Attention items at top (volumes waiting >3d, inactive members, unassigned)
 * - Project cards with stacked progress bars and team lists
 */

import { Link } from "react-router";
import { StackedProgressBar } from "./progress-bar";
import { StatusBadge } from "../workflow/status-badge";

export type AttentionItem = {
  type: "waiting" | "inactive" | "unassigned";
  description: string;
  link: string;
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

function relativeTime(timestamp: number | null): string {
  if (!timestamp) return "Never";
  const now = Date.now();
  const diff = now - timestamp;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(diff / (1000 * 60 * 60));

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  return "Just now";
}

const ROLE_BADGE_STYLES: Record<string, string> = {
  lead: "bg-indigo-100 text-indigo-700",
  cataloguer: "bg-blue-100 text-blue-700",
  reviewer: "bg-purple-100 text-purple-700",
};

function AttentionSection({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-red-600">
        Needs attention
        <span className="ml-2 text-xs font-normal">({items.length})</span>
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item, i) => (
          <Link
            key={i}
            to={item.link}
            className="block rounded-lg border border-red-200 bg-red-50 p-4 hover:border-red-300 hover:shadow-sm"
          >
            <p className="text-sm text-red-800">{item.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

function ProjectCard({ project }: { project: ProjectOverview }) {
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
          {project.totalVolumes} volumes
        </span>
      </div>

      <div className="mt-3">
        <StackedProgressBar counts={project.statusCounts} />
      </div>

      {project.teamMembers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-stone-500">Team</h3>
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
                    {member.name || "Unnamed"}
                  </Link>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      ROLE_BADGE_STYLES[member.role] ?? "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {member.role}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-stone-400">
                  <span>{member.volumeCount} vol.</span>
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
  if (projects.length === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-sm text-stone-500">No projects yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AttentionSection items={attentionItems} />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Projects
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
