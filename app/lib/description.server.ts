/**
 * Description CRUD and Workflow
 *
 * This module deals with every server-side mutation that touches the
 * entry-level description workflow. Saving individual fields from the
 * form, submitting a draft for review, approving or sending back a
 * reviewer's response, reassigning the describer or the reviewer, and
 * promoting a whole volume into the description phase all flow through
 * here so that validation, activity-log writes, and status transitions
 * are consistent across callers. The helpers sit between the route
 * actions (which handle request parsing and permission checks) and the
 * Drizzle queries (which do the actual table writes).
 *
 * @version v0.3.0
 */

import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod/v4";
import { entries, volumes, volumePages, comments } from "../db/schema";
import {
  canDescriptionTransition,
  type DescriptionStatus,
} from "./description-workflow";
import type { WorkflowRole } from "./workflow";
import { logActivity } from "./workflow.server";
import { createComment } from "./comments.server";

// --- Validation schema for submit-for-review ---

const submitSchema = z.object({
  title: z.string().min(1, "Title is required"),
  resourceType: z.enum(["texto", "imagen", "cartografico", "mixto"]),
  dateExpression: z.string().min(1, "Date expression is required"),
  scopeContent: z.string().min(1, "Scope and content is required"),
  language: z.string().min(1, "Language is required"),
  extent: z.string().min(1, "Extent is required"),
});

export type DescriptionFields = {
  translatedTitle?: string | null;
  resourceType?: "texto" | "imagen" | "cartografico" | "mixto" | null;
  dateExpression?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  extent?: string | null;
  scopeContent?: string | null;
  language?: string | null;
  descriptionNotes?: string | null;
  internalNotes?: string | null;
};

/**
 * Save description fields on an entry (autosave).
 * Does NOT change description status.
 */
export async function saveDescription(
  db: DrizzleD1Database<any>,
  entryId: string,
  fields: DescriptionFields
): Promise<void> {
  const now = Date.now();

  await db
    .update(entries)
    .set({
      translatedTitle: fields.translatedTitle ?? null,
      resourceType: fields.resourceType ?? null,
      dateExpression: fields.dateExpression ?? null,
      dateStart: fields.dateStart ?? null,
      dateEnd: fields.dateEnd ?? null,
      extent: fields.extent ?? null,
      scopeContent: fields.scopeContent ?? null,
      language: fields.language ?? null,
      descriptionNotes: fields.descriptionNotes ?? null,
      internalNotes: fields.internalNotes ?? null,
      updatedAt: now,
    })
    .where(eq(entries.id, entryId));
}

export type ValidationError = {
  field: string;
  message: string;
};

/**
 * Validate required fields and submit entry for review.
 * Transitions status to "described" if validation passes.
 * Returns validation errors if required fields are missing.
 */
export async function submitForReview(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  role: WorkflowRole
): Promise<{ ok: true } | { ok: false; validationErrors: ValidationError[] }> {
  // Load current entry
  const [entry] = await db
    .select({
      title: entries.title,
      translatedTitle: entries.translatedTitle,
      resourceType: entries.resourceType,
      dateExpression: entries.dateExpression,
      scopeContent: entries.scopeContent,
      language: entries.language,
      extent: entries.extent,
      descriptionStatus: entries.descriptionStatus,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  // Validate required fields -- use title (original) or translatedTitle
  const titleValue = entry.title || entry.translatedTitle;

  const result = submitSchema.safeParse({
    title: titleValue,
    resourceType: entry.resourceType,
    dateExpression: entry.dateExpression,
    scopeContent: entry.scopeContent,
    language: entry.language,
    extent: entry.extent,
  });

  if (!result.success) {
    const validationErrors: ValidationError[] = result.error.issues.map(
      (issue) => ({
        field: String(issue.path[0]),
        message: issue.message,
      })
    );
    return { ok: false, validationErrors };
  }

  // Check transition is valid
  const currentStatus = entry.descriptionStatus as DescriptionStatus;
  if (!canDescriptionTransition(currentStatus, "described", role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to described for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: "described", updatedAt: now })
    .where(eq(entries.id, entryId));

  return { ok: true };
}

/**
 * Approve a description entry.
 * Reviewer: described -> reviewed. Lead: reviewed -> approved (or any valid transition).
 */
export async function approveDescription(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  role: WorkflowRole
): Promise<void> {
  const [entry] = await db
    .select({
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const currentStatus = entry.descriptionStatus as DescriptionStatus;

  // Determine target: reviewer approves to "reviewed", lead approves to "approved"
  let targetStatus: DescriptionStatus;
  if (role === "reviewer") {
    targetStatus = "reviewed";
  } else if (role === "lead" && currentStatus === "reviewed") {
    targetStatus = "approved";
  } else if (role === "lead") {
    targetStatus = "reviewed";
  } else {
    throw new Response("Insufficient role for approval", { status: 403 });
  }

  if (!canDescriptionTransition(currentStatus, targetStatus, role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to ${targetStatus} for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: targetStatus, updatedAt: now })
    .where(eq(entries.id, entryId));

  // Find project for activity log
  const [vol] = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (vol) {
    await logActivity(db, userId, "description_status_changed", {
      projectId: vol.projectId,
      volumeId: entry.volumeId,
      detail: JSON.stringify({
        entryId,
        from: currentStatus,
        to: targetStatus,
      }),
    });
  }
}

/**
 * Send back a description entry with reviewer feedback.
 * Creates a comment with the feedback text.
 */
export async function sendBackDescription(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  role: WorkflowRole,
  commentText: string
): Promise<void> {
  const [entry] = await db
    .select({
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const currentStatus = entry.descriptionStatus as DescriptionStatus;

  if (!canDescriptionTransition(currentStatus, "sent_back", role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to sent_back for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: "sent_back", updatedAt: now })
    .where(eq(entries.id, entryId));

  // Create a comment with the feedback
  await createComment(db, {
    target: { kind: "entry", entryId },
    volumeId: entry.volumeId,
    parentId: null,
    authorId: userId,
    authorRole: role,
    text: commentText,
  });

  // Log activity
  const [vol] = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (vol) {
    await logActivity(db, userId, "description_status_changed", {
      projectId: vol.projectId,
      volumeId: entry.volumeId,
      detail: JSON.stringify({
        entryId,
        from: currentStatus,
        to: "sent_back",
      }),
    });
  }
}

/**
 * Load an entry with all description fields, its volume info, and ordered pages.
 */
export async function loadDescriptionEntry(
  db: DrizzleD1Database<any>,
  entryId: string
) {
  const [entry] = await db
    .select()
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const [volume] = await db
    .select()
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  const pages = await db
    .select()
    .from(volumePages)
    .where(eq(volumePages.volumeId, entry.volumeId))
    .orderBy(volumePages.position)
    .all();

  return { entry, volume, pages };
}

/**
 * Load all entries for a volume with their description status,
 * for the entry navigation in the description editor.
 */
export async function loadVolumeEntriesForDescription(
  db: DrizzleD1Database<any>,
  volumeId: string
) {
  return db
    .select({
      id: entries.id,
      position: entries.position,
      startPage: entries.startPage,
      title: entries.title,
      translatedTitle: entries.translatedTitle,
      descriptionStatus: entries.descriptionStatus,
      assignedDescriber: entries.assignedDescriber,
      assignedDescriptionReviewer: entries.assignedDescriptionReviewer,
    })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .orderBy(entries.position)
    .all();
}

/**
 * Assign a describer to an entry.
 * Transitions to "assigned" if currently "unassigned".
 */
export async function assignDescriber(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string
): Promise<void> {
  const [entry] = await db
    .select({
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const now = Date.now();
  const updateData: Record<string, unknown> = {
    assignedDescriber: userId,
    updatedAt: now,
  };

  if (entry.descriptionStatus === "unassigned") {
    updateData.descriptionStatus = "assigned";
  }

  await db.update(entries).set(updateData).where(eq(entries.id, entryId));

  // Log activity
  const [vol] = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (vol) {
    await logActivity(db, userId, "description_assignment_changed", {
      projectId: vol.projectId,
      volumeId: entry.volumeId,
      detail: JSON.stringify({ entryId, assignedDescriber: userId }),
    });
  }
}

/**
 * Assign a description reviewer to an entry.
 */
export async function assignDescriptionReviewer(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string
): Promise<void> {
  const now = Date.now();

  await db
    .update(entries)
    .set({ assignedDescriptionReviewer: userId, updatedAt: now })
    .where(eq(entries.id, entryId));
}

/**
 * Promote all entries in a volume to description phase.
 * Sets descriptionStatus to "unassigned" for all entries.
 * Only works if volume status is "approved".
 */
export async function promoteVolumeToDescription(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<void> {
  const [volume] = await db
    .select({ status: volumes.status })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  if (volume.status !== "approved") {
    throw new Response(
      "Volume must be approved before promoting to description",
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: "unassigned", updatedAt: now })
    .where(eq(entries.volumeId, volumeId));
}

/**
 * Get description progress for a volume.
 * Returns count of entries per description status for progress bar.
 */
export async function getVolumeDescriptionProgress(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: entries.descriptionStatus,
      count: sql<number>`count(*)`,
    })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .groupBy(entries.descriptionStatus)
    .all();

  const progress: Record<string, number> = {};
  for (const row of rows) {
    const status = row.status ?? "unassigned";
    progress[status] = row.count;
  }
  return progress;
}
