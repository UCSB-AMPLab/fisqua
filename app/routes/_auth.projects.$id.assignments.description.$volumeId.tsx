/**
 * Per-volume description entry assignment page.
 *
 * Shows all entries in a volume with their description status,
 * assignment dropdowns, bulk selection, and re-segmentation warning.
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, sql, inArray, isNotNull } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import {
  loadVolumeEntriesForDescription,
  assignDescriber,
  assignDescriptionReviewer,
} from "../lib/description.server";
import { getOpenFlags } from "../lib/resegmentation.server";
import { volumes, projectMembers, users } from "../db/schema";
import {
  DescriptionAssignmentTable,
  type DescriptionEntryRow,
} from "../components/assignments/description-assignment-table";
import type { MemberOption } from "../components/assignments/assignment-table";
import type { Route } from "./+types/_auth.projects.$id.assignments.description.$volumeId";

/** Description status colours for progress bar segments */
const DESC_STATUS_ORDER = [
  "unassigned",
  "assigned",
  "in_progress",
  "described",
  "reviewed",
  "approved",
  "sent_back",
];

const DESC_SEGMENT_COLORS: Record<string, string> = {
  unassigned: "bg-[#A8A29E]",
  assigned: "bg-[#3B5A9A]",
  in_progress: "bg-[#8B6914]",
  described: "bg-[#7C3AED]",
  reviewed: "bg-[#0D9488]",
  approved: "bg-[#2F6B45]",
  sent_back: "bg-[#8B2942]",
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  // Load volume info
  const [volume] = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      projectId: volumes.projectId,
    })
    .from(volumes)
    .where(
      and(eq(volumes.id, params.volumeId), eq(volumes.projectId, params.id))
    )
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  // Load entries with description fields
  const entryRows = await loadVolumeEntriesForDescription(db, params.volumeId);

  // Load project members
  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, params.id))
    .all();

  const cataloguers: MemberOption[] = members
    .filter((m) => m.role === "cataloguer")
    .map((m) => ({ id: m.id, name: m.name, email: m.email }));

  const reviewers: MemberOption[] = members
    .filter((m) => m.role === "reviewer")
    .map((m) => ({ id: m.id, name: m.name, email: m.email }));

  // Check for open resegmentation flags
  const openFlags = await getOpenFlags(db, params.volumeId);

  // Compute description progress
  const progress: Record<string, number> = {};
  for (const entry of entryRows) {
    const status = entry.descriptionStatus ?? "unassigned";
    progress[status] = (progress[status] ?? 0) + 1;
  }

  return {
    volume,
    entries: entryRows as DescriptionEntryRow[],
    cataloguers,
    reviewers,
    openFlags,
    progress,
    projectId: params.id,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  if (actionType === "assign-entry") {
    const entryId = formData.get("entryId") as string;
    const describerId = formData.get("describerId") as string | null;
    const reviewerId = formData.get("reviewerId") as string | null;

    if (!entryId) {
      return Response.json({ error: "entryId required" }, { status: 400 });
    }

    if (describerId) {
      await assignDescriber(db, entryId, describerId);
    }
    if (reviewerId) {
      await assignDescriptionReviewer(db, entryId, reviewerId);
    }

    return Response.json({ ok: true });
  }

  if (actionType === "bulk-assign-entries") {
    const entryIdsJson = formData.get("entryIds") as string;
    const describerId = formData.get("describerId") as string | null;
    const reviewerId = formData.get("reviewerId") as string | null;

    let entryIds: string[];
    try {
      entryIds = JSON.parse(entryIdsJson);
    } catch {
      return Response.json({ error: "Invalid entryIds" }, { status: 400 });
    }

    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      return Response.json({ error: "No entries specified" }, { status: 400 });
    }

    for (const eid of entryIds) {
      if (describerId) {
        await assignDescriber(db, eid, describerId);
      }
      if (reviewerId) {
        await assignDescriptionReviewer(db, eid, reviewerId);
      }
    }

    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export default function DescriptionVolumeAssignmentRoute({
  loaderData,
}: Route.ComponentProps) {
  const {
    volume,
    entries: entryRows,
    cataloguers,
    reviewers,
    openFlags,
    progress,
    projectId,
  } = loaderData;
  const { t } = useTranslation("description");

  const total = Object.values(progress).reduce(
    (sum: number, n: number) => sum + n,
    0
  );

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="text-sm text-stone-500">
        <Link to={`/projects/${projectId}`} className="hover:text-stone-700">
          Proyecto
        </Link>
        <span className="mx-2">/</span>
        <Link
          to={`/projects/${projectId}/assignments`}
          className="hover:text-stone-700"
        >
          Asignaciones
        </Link>
        <span className="mx-2">/</span>
        <span className="text-stone-700">{volume.name}</span>
      </nav>

      {/* Volume header */}
      <div>
        <h1 className="font-['Crimson_Text'] text-4xl font-semibold text-[#44403C]">
          {volume.name}
        </h1>
      </div>

      {/* Resegmentation warning */}
      {openFlags.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
          <p className="text-sm text-amber-800">
            {t("assignment.alerta_resegmentacion")}
          </p>
        </div>
      )}

      {/* Progress bar */}
      {total > 0 && (
        <div className="space-y-2">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-stone-100">
            {DESC_STATUS_ORDER.map((status) => {
              const count = (progress as Record<string, number>)[status] ?? 0;
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={status}
                  className={`${DESC_SEGMENT_COLORS[status] ?? "bg-stone-300"} transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${t(`status.${status}`)}: ${count}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
            {DESC_STATUS_ORDER.map((status) => {
              const count = (progress as Record<string, number>)[status] ?? 0;
              if (count === 0) return null;
              return (
                <span key={status} className="flex items-center gap-1">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${DESC_SEGMENT_COLORS[status] ?? "bg-stone-300"}`}
                  />
                  {t(`status.${status}`)} ({count})
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Entry assignment table */}
      <DescriptionAssignmentTable
        entries={entryRows}
        cataloguers={cataloguers}
        reviewers={reviewers}
        projectId={projectId}
        volumeId={volume.id}
      />
    </div>
  );
}
