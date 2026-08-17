/**
 * Comments API — Single Thread
 *
 * This API endpoint owns the per-thread operations on a single
 * comment. PATCH edits the body or anchor of a comment the caller
 * owns; DELETE removes the comment when the caller owns it or when
 * they are the project lead. GET fetches the thread with denormalised
 * author display names.
 *
 * @version v0.7.0
 */
import { userContext, tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { apiErrorToken } from "../lib/api-error.server";
import type { Route } from "./+types/api.comments.$id";

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "PATCH" && request.method !== "DELETE") {
 return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const commentId = params.id;
  if (!commentId) {
 return Response.json({ error: "Missing comment id" }, { status: 400 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { requireEntryAccess, requirePageAccess, requireProjectRole } =
 await import("../lib/permissions.server");
  const { updateCommentRegion, updateCommentBody, softDeleteComment } =
 await import("../lib/comments.server");
  const { logActivity } = await import("../lib/workflow.server");
  const { z } = await import("zod");
  const { eq } = await import("drizzle-orm");
  const { comments, volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Crowdsourcing endpoint: 404 where the tenant does not have the
  // module, matching the member routes that call it.
  requireCapability(tenant, "crowdsourcing");

  if (request.method === "DELETE") {
 // Resolve the comment's anchor + project so we can check lead role
 // BEFORE calling softDeleteComment (the helper takes `isLead` as a
 // boolean -- the route is the single place that talks to
 // requireProjectRole).
 const [row] = await db
 .select({
 volumeId: comments.volumeId,
 pageId: comments.pageId,
 entryId: comments.entryId,
 deletedAt: comments.deletedAt,
 })
 .from(comments)
 .where(eq(comments.id, commentId))
 .limit(1)
 .all();

 if (!row) {
 return Response.json({ error: "Comment not found" }, { status: 404 });
 }

 // Decision comments (volume_id NULL) are ruled through the queue —
 // this volume-side route cannot even authorise them (no volume, no
 // project role), so they are indistinguishable from absent.
 if (row.volumeId === null) {
 return Response.json({ error: "Comment not found" }, { status: 404 });
 }

 const [volume] = await db
 .select({ projectId: volumes.projectId })
 .from(volumes)
 .where(eq(volumes.id, row.volumeId))
 .limit(1)
 .all();

 if (!volume) {
 return Response.json({ error: "Volume not found" }, { status: 404 });
 }

 try {
 const memberships = await requireProjectRole(
 db,
 tenant.id,
 user.id,
 volume.projectId,
 ["lead", "reviewer", "cataloguer"],
 user.isAdmin,
 );
 const isLead =
 memberships.some((m) => m.role === "lead") || user.isAdmin;

 // Belt-and-braces read-access check against the anchor, mirroring
 // the PATCH path. A revoked-but-not-yet-expired membership hits
 // this guard with 403 before softDeleteComment touches the row.
 if (row.pageId) {
 await requirePageAccess(db, tenant.id, row.pageId, user.id, user.isAdmin);
 } else if (row.entryId) {
 await requireEntryAccess(db, tenant.id, row.entryId, user.id, user.isAdmin);
 }

 const result = await softDeleteComment(db, commentId, user.id, isLead);

 await logActivity(db, user.id, "comment_deleted", {
 projectId: volume.projectId,
 volumeId: row.volumeId,
 detail: JSON.stringify({
 commentId,
 cascadedCount: result.cascadedCount,
 pageId: result.pageId,
 entryId: result.entryId,
 parentId: result.parentId,
 }),
 });

 return Response.json({
 ok: true,
 cascadedCount: result.cascadedCount,
 });
 } catch (err) {
 if (err instanceof Response) {
 return Response.json({ error: apiErrorToken(err.status) }, { status: err.status });
 }
  // Server internals never reach the client: the 500 carries the
 // same stable token the catch helper uses for unknown statuses.
 return Response.json({ error: "generic" }, { status: 500 });
 }
  }

  // PATCH body: either a coord-move (task #15) OR a body edit (task #13),
  // never both in one request. Client arms dispatch on which fields are
  // present; the z.union enforces strict separation and rejects mixed
  // payloads with a clean 400.
  let body: any;
  try {
 body = await request.json();
  } catch {
 return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const UpdateCommentBodySchema = z
 .object({ body: z.string().min(1).max(2000) })
 .strict();

  const UpdateCommentRegionSchema = z
 .object({
 regionX: z.number().min(0).max(1),
 regionY: z.number().min(0).max(1),
 regionW: z.number().min(0).max(1).optional(),
 regionH: z.number().min(0).max(1).optional(),
 })
 .strict()
 .refine(
 (v) => (v.regionW === undefined) === (v.regionH === undefined),
 { message: "regionW and regionH must both be set or both omitted" },
 )
 .refine(
 (v) => v.regionW === undefined || v.regionX + v.regionW <= 1,
 { message: "region extends past the image's right edge" },
 )
 .refine(
 (v) => v.regionH === undefined || v.regionY + v.regionH <= 1,
 { message: "region extends past the image's bottom edge" },
 );

  const PatchCommentSchema = z.union([
 UpdateCommentBodySchema,
 UpdateCommentRegionSchema,
  ]);

  const parsed = PatchCommentSchema.safeParse(body);
  if (!parsed.success) {
 return Response.json(
 { error: parsed.error.issues[0]?.message ?? "Invalid body" },
 { status: 400 },
 );
  }

  try {
 // Body-edit arm (task #13 /).
 if ("body" in parsed.data) {
 const { pageId, entryId, volumeId, oldLength, newLength, changed } =
 await updateCommentBody(db, commentId, user.id, parsed.data.body);

 // Belt-and-braces anchor access check, same as coord-edit arm.
 let projectId: string;
 if (pageId) {
 const { volume } = await requirePageAccess(
 db,
 tenant.id,
 pageId,
 user.id,
 user.isAdmin,
 );
 projectId = volume.projectId;
 } else if (entryId) {
 const { volume } = await requireEntryAccess(
 db,
 tenant.id,
 entryId,
 user.id,
 user.isAdmin,
 );
 projectId = volume.projectId;
 } else {
 return Response.json(
 { error: "Comment has no page or entry anchor" },
 { status: 500 },
 );
 }

 // Only log an activity row when the body actually changed; no-op
 // saves should not spam the feed.
 if (changed) {
 await logActivity(db, user.id, "comment_edited", {
 projectId,
 volumeId,
 detail: JSON.stringify({
 commentId,
 pageId,
 entryId,
 oldLength,
 newLength,
 editedAt: Date.now(),
 }),
 });
 }

 return Response.json({ ok: true, changed });
 }

 // Coord-edit arm (task #15 /).
 const { pageId, entryId, volumeId, previousRegion } =
 await updateCommentRegion(db, commentId, user.id, parsed.data);

 // Second-layer access check against the target the comment points
 // to. Either pageAccess or entryAccess applies; region-anchored
 // comments usually have pageId set but entry-region is also
 // possible, so branch.
 let projectId: string;
 if (pageId) {
 const { volume } = await requirePageAccess(
 db,
 tenant.id,
 pageId,
 user.id,
 user.isAdmin,
 );
 projectId = volume.projectId;
 } else if (entryId) {
 const { volume } = await requireEntryAccess(
 db,
 tenant.id,
 entryId,
 user.id,
 user.isAdmin,
 );
 projectId = volume.projectId;
 } else {
 // Region-anchored with neither pageId nor entryId set: shouldn't
 // happen (DB CHECK forbids it) but surface as a server fault.
 return Response.json(
 { error: "Comment has no page or entry anchor" },
 { status: 500 },
 );
 }

 await logActivity(db, user.id, "comment_region_moved", {
 projectId,
 volumeId,
 detail: JSON.stringify({
 commentId,
 pageId,
 entryId,
 previousRegion,
 newRegion: parsed.data,
 }),
 });

 return Response.json({ ok: true });
  } catch (err) {
 if (err instanceof Response) {
 return Response.json({ error: apiErrorToken(err.status) }, { status: err.status });
 }
  // Server internals never reach the client: the 500 carries the
 // same stable token the catch helper uses for unknown statuses.
 return Response.json({ error: "generic" }, { status: 500 });
  }
}

