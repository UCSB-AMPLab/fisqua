/**
 * Auth Root Redirect
 *
 * Default landing for a signed-in user hitting the root of the
 * authenticated area. Issues a one-shot redirect into the member
 * dashboard at `/proyectos` so the sidebar never starts on an empty
 * panel.
 *
 * @version v0.3.0
 */

import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  FileText,
  Users,
  MapPin,
  Building2,
  UserCog,
  BookOpen,
  ClipboardList,
  MessageSquare,
} from "lucide-react";
import { userContext } from "../context";
import { ArchiveStatCard } from "../components/dashboard/archive-stat-card";
import { QuickStatBadge } from "../components/dashboard/quick-stat-badge";
import { AnnouncementBanner } from "../components/dashboard/announcement-banner";
import { ProjectCard } from "../components/dashboard/project-card";
import type { Route } from "./+types/_auth._index";

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql, inArray } = await import("drizzle-orm");
  const {
    users,
    projects,
    projectMembers,
    descriptions,
    entities,
    places,
    repositories,
    volumes,
    entries,
    activityLog,
    siteSettings,
  } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // User's projects with roles
  const memberships = await db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))
    .all();

  const projectIds = [...new Set(memberships.map((m) => m.projectId))];
  const userProjects =
    projectIds.length > 0
      ? await db
          .select()
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
      : [];

  // For each project, determine the user's highest role
  const projectsWithRoles = userProjects.map((p) => {
    const roles = memberships
      .filter((m) => m.projectId === p.id)
      .map((m) => m.role);
    const role = roles.includes("lead")
      ? "lead"
      : roles.includes("reviewer")
        ? "reviewer"
        : "cataloguer";
    return { ...p, role };
  });

  // Quick stats (for ALL users).
  // 'unstarted' is included so a just-assigned volume surfaces immediately —
  // it's work the assignee needs to do, same as entries in 'assigned' status.
  const [volumesStat] = await db
    .select({ count: sql<number>`count(*)` })
    .from(volumes)
    .where(
      sql`${volumes.assignedTo} = ${user.id} AND ${volumes.status} IN ('unstarted', 'in_progress', 'sent_back')`
    )
    .all();

  const [entriesStat] = await db
    .select({ count: sql<number>`count(*)` })
    .from(entries)
    .where(
      sql`${entries.assignedDescriber} = ${user.id} AND ${entries.descriptionStatus} IN ('assigned', 'in_progress', 'sent_back')`
    )
    .all();

  // Activity since last login (use lastActiveAt as proxy)
  const lastLogin = user.lastActiveAt ?? 0;
  let messageCount = 0;
  if (projectIds.length > 0) {
    const [msgStat] = await db
      .select({ count: sql<number>`count(*)` })
      .from(activityLog)
      .where(
        sql`${activityLog.projectId} IN (${sql.join(
          projectIds.map((id) => sql`${id}`),
          sql`, `
        )}) AND ${activityLog.createdAt} > ${lastLogin}`
      )
      .all();
    messageCount = Number(msgStat?.count ?? 0);
  }

  const quickStats = {
    volumes: Number(volumesStat?.count ?? 0),
    entries: Number(entriesStat?.count ?? 0),
    messages: messageCount,
  };

  // Format last login as YYYY-MM-DD HH:MM
  let lastLoginFormatted: string | null = null;
  if (user.lastActiveAt) {
    const d = new Date(user.lastActiveAt);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    lastLoginFormatted = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  // Announcement
  const announcementRow = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, "announcement"))
    .get();
  const announcement = announcementRow?.value ?? null;

  // Admin stats (only if admin)
  let stats = null;
  if (user.isAdmin) {
    const [descCount] = await db
      .select({ count: sql`count(*)` })
      .from(descriptions)
      .all();
    const [entityCount] = await db
      .select({ count: sql`count(*)` })
      .from(entities)
      .all();
    const [placeCount] = await db
      .select({ count: sql`count(*)` })
      .from(places)
      .all();
    const [repoCount] = await db
      .select({ count: sql`count(*)` })
      .from(repositories)
      .all();
    const [userCount] = await db
      .select({ count: sql`count(*)` })
      .from(users)
      .all();
    stats = {
      descriptions: Number(descCount?.count ?? 0),
      entities: Number(entityCount?.count ?? 0),
      places: Number(placeCount?.count ?? 0),
      repositories: Number(repoCount?.count ?? 0),
      users: Number(userCount?.count ?? 0),
    };
  }

  return {
    user,
    projects: projectsWithRoles,
    stats,
    quickStats,
    lastLoginFormatted,
    announcement,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { z } = await import("zod");
  const { requireSuperAdmin } = await import("../lib/superadmin.server");
  const { siteSettings } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  requireSuperAdmin(user);

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (typeof intent !== "string") {
    return { ok: false, error: "Missing intent" };
  }

  if (intent === "setAnnouncement") {
    const schema = z.object({
      text: z.string().min(1).max(500),
    });
    const parsed = schema.safeParse({ text: formData.get("text") });
    if (!parsed.success) {
      return { ok: false, error: "Invalid announcement text (1-500 characters)" };
    }

    await db
      .insert(siteSettings)
      .values({
        key: "announcement",
        value: parsed.data.text,
        updatedAt: Date.now(),
        updatedBy: user.id,
      })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: {
          value: parsed.data.text,
          updatedAt: Date.now(),
          updatedBy: user.id,
        },
      });

    return { ok: true };
  }

  if (intent === "clearAnnouncement") {
    await db
      .delete(siteSettings)
      .where(eq(siteSettings.key, "announcement"));

    return { ok: true };
  }

  return { ok: false, error: "Unknown intent" };
}

export default function HomePage({ loaderData }: Route.ComponentProps) {
  const {
    user,
    projects: projectsWithRoles,
    stats,
    quickStats,
    lastLoginFormatted,
    announcement,
  } = loaderData;
  const { t } = useTranslation("dashboard");
  const setFetcher = useFetcher();
  const clearFetcher = useFetcher();

  // Determine role subtitle
  let roleSubtitle: string;
  if (user.isAdmin) {
    roleSubtitle = t("role.admin");
  } else {
    const projectCount = projectsWithRoles.length;
    const roles = projectsWithRoles.map((p) => p.role);
    if (roles.includes("lead")) {
      roleSubtitle = t("role.lead", { count: projectCount });
    } else if (roles.includes("reviewer")) {
      roleSubtitle = t("role.reviewer", { count: projectCount });
    } else {
      roleSubtitle = t("role.cataloguer", { count: projectCount });
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Greeting */}
      <h1 className="font-display text-4xl font-semibold text-[#44403C]">
        {t("greeting", { name: user.name || user.email })}
      </h1>
      <p className="mt-1 text-sm text-[#78716C]">{roleSubtitle}</p>

      {/* Last login */}
      {lastLoginFormatted && (
        <p className="mt-2 text-xs text-[#A8A29E]">
          {t("last_login", { date: lastLoginFormatted })}
        </p>
      )}

      {/* Quick stats */}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickStatBadge
          icon={BookOpen}
          label={t("stat_volumes")}
          value={quickStats.volumes}
          href="/proyectos#segmentation"
        />
        <QuickStatBadge
          icon={ClipboardList}
          label={t("stat_entries")}
          value={quickStats.entries}
          href="/proyectos#description"
        />
        <QuickStatBadge
          icon={MessageSquare}
          label={t("stat_messages")}
          value={quickStats.messages}
          href="/proyectos#messages"
        />
      </div>

      {/* Announcement banner */}
      {announcement && (
        <div className="mt-6">
          <AnnouncementBanner text={announcement} />
        </div>
      )}

      {/* Superadmin announcement form */}
      {user.isSuperAdmin && (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-[#A8A29E]">
            {t("announcement_label")}
          </p>
          <setFetcher.Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="setAnnouncement" />
            <textarea
              name="text"
              rows={2}
              maxLength={500}
              defaultValue={announcement ?? ""}
              className="flex-1 rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#44403C] focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg bg-[#8B2942] px-3 py-2 text-xs font-semibold text-white hover:bg-[#7a2439]"
            >
              {t("set_announcement")}
            </button>
          </setFetcher.Form>
          {announcement && (
            <clearFetcher.Form method="post" className="inline">
              <input type="hidden" name="intent" value="clearAnnouncement" />
              <button
                type="submit"
                className="text-xs font-medium text-[#8B2942] hover:underline"
              >
                {t("clear_announcement")}
              </button>
            </clearFetcher.Form>
          )}
        </div>
      )}

      {/* Admin stat cards */}
      {stats && (
        <div className="mt-8 grid grid-cols-5 gap-4">
          <ArchiveStatCard
            icon={FileText}
            label={t("stats.descriptions")}
            value={stats.descriptions}
          />
          <ArchiveStatCard
            icon={Users}
            label={t("stats.entities")}
            value={stats.entities}
          />
          <ArchiveStatCard
            icon={MapPin}
            label={t("stats.places")}
            value={stats.places}
          />
          <ArchiveStatCard
            icon={Building2}
            label={t("stats.repositories")}
            value={stats.repositories}
          />
          <ArchiveStatCard
            icon={UserCog}
            label={t("stats.users")}
            value={stats.users}
          />
        </div>
      )}

      {/* Project cards */}
      <div className="mt-8">
        {projectsWithRoles.length > 0 ? (
          <div className="grid grid-cols-2 gap-6">
            {projectsWithRoles.map((p) => (
              <ProjectCard key={p.id} project={p} role={p.role} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-[#E7E5E4] bg-white p-8 text-center">
            <p className="text-sm font-medium text-[#44403C]">
              {t("empty.no_projects_assigned")}
            </p>
            <p className="mt-1 text-sm text-[#78716C]">
              {t("empty.no_projects_assigned_body")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
