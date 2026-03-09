/**
 * Assignments tab route (lead-only).
 * Manages volume-to-user assignments with individual and bulk operations.
 * Shows stacked progress bar, assignment table, and team progress.
 */

import { useState } from "react";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, sql, inArray } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { logActivity } from "../lib/workflow.server";
import { volumes, projectMembers, users, entries } from "../db/schema";
import { StackedProgressBar } from "../components/dashboard/progress-bar";
import {
  AssignmentTable,
  type VolumeRow,
  type MemberOption,
} from "../components/assignments/assignment-table";
import { BulkToolbar } from "../components/assignments/bulk-toolbar";
import {
  TeamProgress,
  type TeamMemberStats,
} from "../components/assignments/team-progress";
import type { Route } from "./+types/_auth.projects.$id.assignments";

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Lead-only access
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  // Fetch all volumes for this project
  const projectVolumes = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      pageCount: volumes.pageCount,
      status: volumes.status,
      assignedTo: volumes.assignedTo,
      assignedReviewer: volumes.assignedReviewer,
    })
    .from(volumes)
    .where(eq(volumes.projectId, params.id))
    .orderBy(volumes.name)
    .all();

  // Fetch project members
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

  // Compute status counts for progress bar
  const statusCounts: Record<string, number> = {};
  for (const vol of projectVolumes) {
    statusCounts[vol.status] = (statusCounts[vol.status] ?? 0) + 1;
  }

  // Compute per-member stats for team progress
  const memberStatsMap = new Map<string, TeamMemberStats>();

  for (const m of members) {
    if (m.role === "lead") continue; // leads don't get progress cards
    if (!memberStatsMap.has(m.id)) {
      memberStatsMap.set(m.id, {
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        statusCounts: {},
        totalVolumes: 0,
        entryCount: 0,
      });
    }
  }

  // Count assigned volumes per member by status
  for (const vol of projectVolumes) {
    if (vol.assignedTo && memberStatsMap.has(vol.assignedTo)) {
      const stats = memberStatsMap.get(vol.assignedTo)!;
      stats.statusCounts[vol.status] = (stats.statusCounts[vol.status] ?? 0) + 1;
      stats.totalVolumes += 1;
    }
    if (vol.assignedReviewer && memberStatsMap.has(vol.assignedReviewer)) {
      const stats = memberStatsMap.get(vol.assignedReviewer)!;
      stats.statusCounts[vol.status] = (stats.statusCounts[vol.status] ?? 0) + 1;
      stats.totalVolumes += 1;
    }
  }

  // Count entries per assigned user (supporting metric)
  const volumeIds = projectVolumes.map((v) => v.id);
  if (volumeIds.length > 0) {
    const entryCounts = await db
      .select({
        volumeId: entries.volumeId,
        count: sql<number>`count(*)`,
      })
      .from(entries)
      .where(inArray(entries.volumeId, volumeIds))
      .groupBy(entries.volumeId)
      .all();

    const entryCountByVolume = new Map(
      entryCounts.map((e) => [e.volumeId, e.count])
    );

    for (const vol of projectVolumes) {
      const count = entryCountByVolume.get(vol.id) ?? 0;
      if (vol.assignedTo && memberStatsMap.has(vol.assignedTo)) {
        memberStatsMap.get(vol.assignedTo)!.entryCount += count;
      }
    }
  }

  const teamMembers = Array.from(memberStatsMap.values());

  return {
    volumes: projectVolumes as VolumeRow[],
    cataloguers,
    reviewers,
    statusCounts,
    teamMembers,
    projectId: params.id,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Lead-only access
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  if (actionType === "assign") {
    const volumeId = formData.get("volumeId") as string;
    const cataloguerId = formData.get("cataloguerId") as string | null;
    const reviewerId = formData.get("reviewerId") as string | null;

    if (!volumeId) {
      return Response.json({ error: "volumeId required" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (cataloguerId !== null) {
      updateData.assignedTo = cataloguerId === "" ? null : cataloguerId;
    }
    if (reviewerId !== null) {
      updateData.assignedReviewer = reviewerId === "" ? null : reviewerId;
    }

    await db.update(volumes).set(updateData).where(
      and(eq(volumes.id, volumeId), eq(volumes.projectId, params.id))
    );

    await logActivity(db, user.id, "assignment_changed", {
      projectId: params.id,
      volumeId,
      detail: JSON.stringify({
        cataloguerId: cataloguerId || null,
        reviewerId: reviewerId || null,
      }),
    });

    return Response.json({ ok: true });
  }

  if (actionType === "bulk-assign") {
    const volumeIdsJson = formData.get("volumeIds") as string;
    const cataloguerId = formData.get("cataloguerId") as string | null;
    const reviewerId = formData.get("reviewerId") as string | null;

    let volumeIds: string[];
    try {
      volumeIds = JSON.parse(volumeIdsJson);
    } catch {
      return Response.json({ error: "Invalid volumeIds" }, { status: 400 });
    }

    if (!Array.isArray(volumeIds) || volumeIds.length === 0) {
      return Response.json({ error: "No volumes specified" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (cataloguerId) {
      updateData.assignedTo =
        cataloguerId === "__unassign__" ? null : cataloguerId;
    }
    if (reviewerId) {
      updateData.assignedReviewer =
        reviewerId === "__unassign__" ? null : reviewerId;
    }

    // Chunk to stay under D1 batch limit (89 per RESEARCH.md pitfall 3)
    const CHUNK_SIZE = 89;
    for (let i = 0; i < volumeIds.length; i += CHUNK_SIZE) {
      const chunk = volumeIds.slice(i, i + CHUNK_SIZE);
      const stmts: any[] = chunk.map((vid) =>
        db.update(volumes).set(updateData).where(
          and(eq(volumes.id, vid), eq(volumes.projectId, params.id))
        )
      );
      await db.batch(stmts as any);
    }

    // Log activity for each (chunked)
    for (let i = 0; i < volumeIds.length; i += CHUNK_SIZE) {
      const chunk = volumeIds.slice(i, i + CHUNK_SIZE);
      for (const vid of chunk) {
        await logActivity(db, user.id, "assignment_changed", {
          projectId: params.id,
          volumeId: vid,
          detail: JSON.stringify({
            cataloguerId: cataloguerId || null,
            reviewerId: reviewerId || null,
            bulk: true,
          }),
        });
      }
    }

    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export default function AssignmentsRoute({ loaderData }: Route.ComponentProps) {
  const {
    volumes: projectVolumes,
    cataloguers,
    reviewers,
    statusCounts,
    teamMembers,
  } = loaderData;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-stone-900">Assignments</h2>

      {/* Stacked progress bar */}
      <StackedProgressBar counts={statusCounts} />

      {/* Bulk toolbar */}
      <BulkToolbar
        selectedCount={selectedIds.size}
        selectedIds={selectedIds}
        cataloguers={cataloguers}
        reviewers={reviewers}
        onClear={() => setSelectedIds(new Set())}
      />

      {/* Assignment table */}
      <AssignmentTable
        volumes={projectVolumes}
        cataloguers={cataloguers}
        reviewers={reviewers}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
      />

      {/* Team progress */}
      <TeamProgress members={teamMembers} />
    </div>
  );
}
