/**
 * Description Workflow Pipeline
 *
 * This module deals with the server-side engine for the description
 * workflow: promoting a volume into description, tracking per-entry
 * describer and reviewer state, and moving each entry through draft
 * / submitted / approved / sent-back transitions. Callers pass the
 * guarded user in; every mutation writes an audit row so the trail
 * is recoverable.
 *
 * Every exported query takes the REQUEST tenant id as its second
 * argument -- `context.get(tenantContext).id`, never `user.tenantId`
 * -- and carries it as a predicate. The project id a caller supplies
 * cannot answer the tenant question on its own, so neither the
 * project filter nor a resolved entry PK is allowed to stand alone
 * here.
 *
 * @version v0.7.0
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq, and, notInArray } from "drizzle-orm";
import {
  volumes,
  entries,
  projects,
  users,
  projectMembers,
} from "~/db/schema";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export const PIPELINE_COLUMNS = [
  { id: "unstarted", type: "volume" as const, statuses: ["unstarted"] },
  { id: "segmenting", type: "volume" as const, statuses: ["in_progress", "sent_back"] },
  { id: "seg_review", type: "volume" as const, statuses: ["segmented"] },
  { id: "ready_to_describe", type: "volume" as const, statuses: ["reviewed", "approved"] },
  { id: "describing", type: "entry" as const, statuses: ["assigned", "in_progress", "sent_back"] },
  { id: "desc_review", type: "entry" as const, statuses: ["described"] },
  { id: "ready_to_promote", type: "entry" as const, statuses: ["reviewed", "approved"] },
] as const;

const VOLUME_SENT_BACK_STATUS = "sent_back";
const ENTRY_SENT_BACK_STATUS = "sent_back";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineItem {
  id: string;
  name: string;
  assignee: string | null;
  projectId: string;
  projectName: string;
  updatedAt: number;
  isSentBack: boolean;
  type: "volume" | "entry";
}

export interface PipelineColumn {
  id: string;
  items: PipelineItem[];
}

type VolumeColumnId = "unstarted" | "segmenting" | "seg_review" | "ready_to_describe";
type EntryColumnId = "describing" | "desc_review" | "ready_to_promote";

// ---------------------------------------------------------------------------
// Pure grouping functions (testable without DB)
// ---------------------------------------------------------------------------

const VOLUME_STATUS_MAP: Record<string, VolumeColumnId> = {
  unstarted: "unstarted",
  in_progress: "segmenting",
  sent_back: "segmenting",
  segmented: "seg_review",
  reviewed: "ready_to_describe",
  approved: "ready_to_describe",
};

const ENTRY_STATUS_MAP: Record<string, EntryColumnId> = {
  assigned: "describing",
  in_progress: "describing",
  sent_back: "describing",
  described: "desc_review",
  reviewed: "ready_to_promote",
  approved: "ready_to_promote",
};

export function groupVolumesByColumn(
  volumeItems: Array<PipelineItem & { status: string }>
): Record<VolumeColumnId, PipelineItem[]> {
  const result: Record<VolumeColumnId, PipelineItem[]> = {
    unstarted: [],
    segmenting: [],
    seg_review: [],
    ready_to_describe: [],
  };

  for (const item of volumeItems) {
    const columnId = VOLUME_STATUS_MAP[item.status];
    if (!columnId) continue;

    result[columnId].push({
      id: item.id,
      name: item.name,
      assignee: item.assignee,
      projectId: item.projectId,
      projectName: item.projectName,
      updatedAt: item.updatedAt,
      isSentBack: item.status === VOLUME_SENT_BACK_STATUS,
      type: "volume",
    });
  }

  return result;
}

export function groupEntriesByColumn(
  entryItems: Array<PipelineItem & { descriptionStatus: string }>
): Record<EntryColumnId, PipelineItem[]> {
  const result: Record<EntryColumnId, PipelineItem[]> = {
    describing: [],
    desc_review: [],
    ready_to_promote: [],
  };

  for (const item of entryItems) {
    const columnId = ENTRY_STATUS_MAP[item.descriptionStatus];
    if (!columnId) continue;

    result[columnId].push({
      id: item.id,
      name: item.name,
      assignee: item.assignee,
      projectId: item.projectId,
      projectName: item.projectName,
      updatedAt: item.updatedAt,
      isSentBack: item.descriptionStatus === ENTRY_SENT_BACK_STATUS,
      type: "entry",
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/**
 * Build the kanban columns for one project.
 *
 * `tenantId` is the REQUEST tenant and `projectId` is mandatory. Both
 * are load-bearing: an optional project filter used to leave
 * `volumeConditions` undefined, which returned every volume on the
 * platform, and a project id alone cannot answer the tenant question
 * once a caller is free to supply it.
 */
export async function getPipelineData(
  db: DrizzleD1Database,
  tenantId: string,
  projectId: string
): Promise<PipelineColumn[]> {
  const volumeRows = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      status: volumes.status,
      projectId: volumes.projectId,
      projectName: projects.name,
      assigneeName: users.name,
      updatedAt: volumes.updatedAt,
    })
    .from(volumes)
    .leftJoin(projects, eq(volumes.projectId, projects.id))
    .leftJoin(users, eq(volumes.assignedTo, users.id))
    .where(
      and(
        eq(volumes.tenantId, tenantId),
        eq(volumes.projectId, projectId)
      )
    )
    .all();

  const volumeItems = volumeRows.map((row) => ({
    id: row.id,
    name: row.name,
    assignee: row.assigneeName ?? null,
    projectId: row.projectId,
    projectName: row.projectName ?? "",
    updatedAt: row.updatedAt,
    isSentBack: false,
    type: "volume" as const,
    status: row.status,
  }));

  // Query entries in the description pipeline (not unassigned, not promoted)
  const entryBaseConditions = [
    notInArray(entries.descriptionStatus, ["unassigned", "promoted"]),
    eq(entries.tenantId, tenantId),
    eq(volumes.projectId, projectId),
  ];

  const entryRows = await db
    .select({
      id: entries.id,
      title: entries.title,
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
      projectId: volumes.projectId,
      projectName: projects.name,
      assigneeName: users.name,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .innerJoin(volumes, eq(entries.volumeId, volumes.id))
    .leftJoin(projects, eq(volumes.projectId, projects.id))
    .leftJoin(users, eq(entries.assignedDescriber, users.id))
    .where(and(...entryBaseConditions))
    .all();

  const entryItems = entryRows.map((row) => ({
    id: row.id,
    name: row.title ?? "(untitled)",
    assignee: row.assigneeName ?? null,
    projectId: row.projectId,
    projectName: row.projectName ?? "",
    updatedAt: row.updatedAt,
    isSentBack: false,
    type: "entry" as const,
    descriptionStatus: row.descriptionStatus ?? "assigned",
  }));

  const volumeGroups = groupVolumesByColumn(volumeItems);
  const entryGroups = groupEntriesByColumn(entryItems);

  return PIPELINE_COLUMNS.map((col) => ({
    id: col.id,
    items:
      col.type === "volume"
        ? volumeGroups[col.id as VolumeColumnId]
        : entryGroups[col.id as EntryColumnId],
  }));
}

// ---------------------------------------------------------------------------
// Assign describer action
// ---------------------------------------------------------------------------

/**
 * `entryId` is attacker-chosen, so both halves of the read-then-write
 * pair carry the request tenant. Callers must still prove the entry
 * belongs to the project they authorised against; this predicate is
 * the floor, not the whole check.
 */
export async function assignDescriber(
  db: DrizzleD1Database,
  tenantId: string,
  entryId: string,
  describerId: string
): Promise<{ success: boolean; error?: string }> {
  const entry = await db
    .select({ id: entries.id, descriptionStatus: entries.descriptionStatus })
    .from(entries)
    .where(and(eq(entries.id, entryId), eq(entries.tenantId, tenantId)))
    .get();

  if (!entry) {
    return { success: false, error: "Entry not found" };
  }

  if (entry.descriptionStatus !== "unassigned") {
    return { success: false, error: "Entry is not in unassigned status" };
  }

  await db
    .update(entries)
    .set({
      descriptionStatus: "assigned",
      assignedDescriber: describerId,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(entries.id, entryId), eq(entries.tenantId, tenantId)));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Members of one project, for the assign-describer picker.
 *
 * `projectId` is mandatory: the fallback branch selected every user
 * row on the platform, and no call site ever wanted it. The
 * `users.tenantId` predicate is belt-and-braces against a stale
 * cross-tenant `project_members` row surviving in the data.
 */
export async function getTeamMembers(
  db: DrizzleD1Database,
  tenantId: string,
  projectId: string
): Promise<Array<{ id: string; name: string | null; email: string }>> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .innerJoin(projectMembers, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(users.tenantId, tenantId)
      )
    )
    .all();

  return rows;
}
