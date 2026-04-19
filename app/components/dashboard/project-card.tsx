/**
 * Project Card
 *
 * Card rendering one project on the member dashboard: name, short
 * description, the caller's role in the project, and the headline
 * counts (volumes / entries / open items). Clicking the card deep-
 * links into the project overview.
 *
 * @version v0.3.0
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";

type ProjectCardProps = {
  project: {
    id: string;
    name: string;
    description?: string | null;
  };
  role: string;
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-[#D6E8DB] text-[#2F6B45]",
  cataloguer: "bg-[#E0E7F7] text-[#3B5A9A]",
  reviewer: "bg-[#CCF0EB] text-[#0D9488]",
  admin: "bg-[#F5E6EA] text-[#8B2942]",
};

export function ProjectCard({ project, role }: ProjectCardProps) {
  const { t } = useTranslation(["workflow", "dashboard"]);

  const badgeColor = ROLE_BADGE_COLORS[role] || "bg-stone-100 text-stone-600";

  return (
    <div className="rounded-lg border border-[#E7E5E4] bg-white p-6 transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="font-heading text-lg font-semibold text-[#44403C]">
            {project.name}
          </h3>
          {project.description && (
            <p className="mt-1 text-sm text-[#78716C] line-clamp-2">
              {project.description}
            </p>
          )}
          <span
            className={`mt-3 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${badgeColor}`}
          >
            {t(`workflow:role.${role}`)}
          </span>
        </div>
        <Link
          to={`/projects/${project.id}`}
          className="shrink-0 rounded p-1 text-[#8B2942] hover:bg-[#F5E6EA]"
          aria-label={project.name}
        >
          <ArrowRight className="h-5 w-5" />
        </Link>
      </div>
    </div>
  );
}
