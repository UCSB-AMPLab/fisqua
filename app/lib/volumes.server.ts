import { eq, and } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { volumes, volumePages } from "../db/schema";
import type { ParsedManifest } from "./iiif.server";

/**
 * Number of page rows per INSERT statement.
 * 7 columns per row * 12 rows = 84 bound params (under D1's 100 limit).
 */
const PAGE_CHUNK_SIZE = 12;

type Volume = typeof volumes.$inferSelect;

export interface VolumeListItem {
  id: string;
  name: string;
  referenceCode: string;
  pageCount: number;
  status: string;
  assignedTo: string | null;
  assignedReviewer: string | null;
  firstPageImageUrl: string | null;
}

/**
 * Creates a volume and all its pages from a parsed IIIF manifest.
 * Pages are inserted in chunks to stay within D1's bound parameter limit.
 */
export async function createVolume(
  db: DrizzleD1Database<any>,
  projectId: string,
  manifest: ParsedManifest
): Promise<Volume> {
  const now = Date.now();
  const volumeId = crypto.randomUUID();

  const volumeRow: typeof volumes.$inferInsert = {
    id: volumeId,
    projectId,
    name: manifest.name,
    referenceCode: manifest.referenceCode,
    manifestUrl: manifest.manifestUrl,
    pageCount: manifest.pageCount,
    status: "unstarted",
    createdAt: now,
    updatedAt: now,
  };

  // Insert volume row first
  await db.insert(volumes).values(volumeRow);

  // Chunk pages and insert via batch
  if (manifest.pages.length > 0) {
    const chunks: (typeof volumePages.$inferInsert)[][] = [];

    for (let i = 0; i < manifest.pages.length; i += PAGE_CHUNK_SIZE) {
      chunks.push(
        manifest.pages.slice(i, i + PAGE_CHUNK_SIZE).map((page) => ({
          id: crypto.randomUUID(),
          volumeId,
          position: page.position,
          imageUrl: page.imageUrl,
          width: page.width,
          height: page.height,
          createdAt: now,
        }))
      );
    }

    // db.batch sends all statements in a single round-trip
    const statements = chunks.map((chunk) =>
      db.insert(volumePages).values(chunk)
    );

    if (statements.length === 1) {
      await statements[0];
    } else {
      await db.batch(statements as any);
    }
  }

  return {
    id: volumeId,
    projectId,
    name: manifest.name,
    referenceCode: manifest.referenceCode,
    manifestUrl: manifest.manifestUrl,
    pageCount: manifest.pageCount,
    status: "unstarted",
    assignedTo: null,
    assignedReviewer: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Returns all volumes for a project with the first page's image URL
 * for use as a thumbnail.
 */
export async function getProjectVolumes(
  db: DrizzleD1Database<any>,
  projectId: string
): Promise<VolumeListItem[]> {
  const volumeRows = await db
    .select()
    .from(volumes)
    .where(eq(volumes.projectId, projectId))
    .all();

  const result: VolumeListItem[] = [];

  for (const vol of volumeRows) {
    // Get first page for thumbnail
    const firstPage = await db
      .select({ imageUrl: volumePages.imageUrl })
      .from(volumePages)
      .where(
        and(
          eq(volumePages.volumeId, vol.id),
          eq(volumePages.position, 1)
        )
      )
      .get();

    result.push({
      id: vol.id,
      name: vol.name,
      referenceCode: vol.referenceCode,
      pageCount: vol.pageCount,
      status: vol.status,
      assignedTo: vol.assignedTo,
      assignedReviewer: vol.assignedReviewer,
      firstPageImageUrl: firstPage?.imageUrl || null,
    });
  }

  return result;
}

/**
 * Deletes a volume and all its pages.
 * Only volumes with status "unstarted" can be deleted.
 * Manually deletes pages before the volume to avoid reliance
 * on D1's foreign key pragma for cascade behavior.
 */
export async function deleteVolume(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<void> {
  const volume = await db
    .select({ status: volumes.status })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  if (volume.status !== "unstarted") {
    throw new Response(
      "Only volumes with status 'unstarted' can be deleted",
      { status: 400 }
    );
  }

  // Delete pages first (manual cascade)
  await db
    .delete(volumePages)
    .where(eq(volumePages.volumeId, volumeId));

  // Delete the volume
  await db.delete(volumes).where(eq(volumes.id, volumeId));
}
