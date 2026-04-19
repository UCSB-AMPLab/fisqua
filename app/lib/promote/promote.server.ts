/**
 * Crowdsourced Promotion
 *
 * Server-side engine for turning a reviewed crowdsourcing volume entry
 * into a published archival description. Loads the entry, validates
 * its reference code and field payload, copies the mapped ISAD(G)
 * fields onto a fresh `descriptions` row, writes the promotion manifest
 * to R2, and records the audit trail. Batch size is capped so a single
 * superadmin click cannot fan out into an unbounded workload.
 *
 * @version v0.3.0
 */
import { eq, and, isNull, inArray, sql, desc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  entries,
  descriptions,
  volumes,
  volumePages,
} from "../../db/schema";
import { mapEntryToDescription } from "./field-mapping";
import { buildDocumentManifest } from "./manifest-builder";
import { parseManifest } from "../iiif.server";
import type { VolumePage } from "./types";

/** D1 batch limit per established pattern in entries.server.ts */
const CHUNK_SIZE = 89;

/** Maximum entries per promotion batch */
const MAX_BATCH_SIZE = 200;

/** Reference code validation: alphanumeric + hyphens, max 50 chars */
const REFERENCE_CODE_PATTERN = /^[a-zA-Z0-9-]{1,50}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromotionArgs {
  db: DrizzleD1Database<any>;
  manifestsBucket: R2Bucket;
  entries: Array<{ entryId: string; referenceCode: string }>;
  volumeId: string;
  userId: string;
  manifestBaseUrl: string;
}

export interface PromotionResult {
  promoted: Array<{
    entryId: string;
    descriptionId: string;
    referenceCode: string;
  }>;
  skipped: Array<{ entryId: string; referenceCode: string; reason: string }>;
  errors: Array<{ entryId: string; error: string }>;
}

export interface VolumeWithCount {
  id: string;
  name: string;
  referenceCode: string;
  promotableCount: number;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * List volumes that have at least one promotable entry:
 * type = 'item', descriptionStatus = 'approved', promotedDescriptionId IS NULL.
 */
export async function getVolumesWithPromotableEntries(
  db: DrizzleD1Database<any>
): Promise<VolumeWithCount[]> {
  const rows = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      referenceCode: volumes.referenceCode,
    })
    .from(volumes)
    .all();

  const result: VolumeWithCount[] = [];

  for (const vol of rows) {
    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(entries)
      .where(
        and(
          eq(entries.volumeId, vol.id),
          eq(entries.type, "item"),
          eq(entries.descriptionStatus, "approved"),
          isNull(entries.promotedDescriptionId)
        )
      )
      .all();

    const count = countRows[0]?.count ?? 0;
    if (count > 0) {
      result.push({ ...vol, promotableCount: count });
    }
  }

  return result;
}

/**
 * Load promotable and already-promoted entries for a volume.
 */
export async function getPromotableEntries(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<{
  promotable: Array<typeof entries.$inferSelect>;
  alreadyPromoted: Array<typeof entries.$inferSelect>;
}> {
  const promotable = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.volumeId, volumeId),
        eq(entries.type, "item"),
        eq(entries.descriptionStatus, "approved"),
        isNull(entries.promotedDescriptionId)
      )
    )
    .orderBy(entries.position)
    .all();

  const alreadyPromoted = await db
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.volumeId, volumeId),
        eq(entries.type, "item"),
        eq(entries.descriptionStatus, "promoted"),
        sql`${entries.promotedDescriptionId} IS NOT NULL`
      )
    )
    .orderBy(entries.position)
    .all();

  return { promotable, alreadyPromoted };
}

// ---------------------------------------------------------------------------
// Main promotion orchestration
// ---------------------------------------------------------------------------

/**
 * Promote approved entries into the description hierarchy.
 *
 * Steps (per Research Pattern 3 and Pitfall 6 ordering):
 * a. Validate inputs (type, status, volumeId, idempotency, ref code format & uniqueness)
 * b. Load parent context (description matching volume referenceCode)
 * c. Load volume manifest and parse pages
 * d. Map entries to descriptions (pure)
 * e. Build IIIF manifests (pure)
 * f. Insert descriptions into D1 (batched)
 * g. Upload manifests to R2
 * h. Update entries (batched)
 * i. Update parent denorm cache
 * j. Return results
 */
export async function promoteEntries(
  args: PromotionArgs
): Promise<PromotionResult> {
  const { db, manifestsBucket, entries: inputEntries, volumeId, userId, manifestBaseUrl } = args;

  const promoted: PromotionResult["promoted"] = [];
  const skipped: PromotionResult["skipped"] = [];
  const errors: PromotionResult["errors"] = [];

  // batch size limit
  if (inputEntries.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Batch size ${inputEntries.length} exceeds maximum of ${MAX_BATCH_SIZE}`
    );
  }

  // validate reference code format
  for (const item of inputEntries) {
    if (!REFERENCE_CODE_PATTERN.test(item.referenceCode)) {
      errors.push({
        entryId: item.entryId,
        error: `Invalid reference code format: ${item.referenceCode}`,
      });
    }
  }
  // Remove entries with invalid ref codes from further processing
  const validEntries = inputEntries.filter(
    (item) => !errors.some((e) => e.entryId === item.entryId)
  );

  if (validEntries.length === 0) {
    return { promoted, skipped, errors };
  }

  // ---- (a) Validate inputs ----

  const entryIds = validEntries.map((e) => e.entryId);
  const loadedEntries = await db
    .select()
    .from(entries)
    .where(inArray(entries.id, entryIds))
    .all();

  const entryMap = new Map(loadedEntries.map((e) => [e.id, e]));
  const refCodeMap = new Map(
    validEntries.map((e) => [e.entryId, e.referenceCode])
  );

  // Validate each entry
  const toProcess: Array<{
    entry: typeof entries.$inferSelect;
    referenceCode: string;
  }> = [];

  for (const item of validEntries) {
    const entry = entryMap.get(item.entryId);
    if (!entry) {
      errors.push({ entryId: item.entryId, error: "Entry not found" });
      continue;
    }
    // verify entry belongs to volume
    if (entry.volumeId !== volumeId) {
      errors.push({
        entryId: item.entryId,
        error: "Entry does not belong to the specified volume",
      });
      continue;
    }
    // only items
    if (entry.type !== "item") {
      errors.push({
        entryId: item.entryId,
        error: `Only item entries can be promoted, got type: ${entry.type}`,
      });
      continue;
    }
    if (entry.descriptionStatus !== "approved") {
      // already promoted — skip, don't error
      if (
        entry.descriptionStatus === "promoted" &&
        entry.promotedDescriptionId
      ) {
        skipped.push({
          entryId: item.entryId,
          referenceCode: item.referenceCode,
          reason: `Already promoted -> ${entry.promotedDescriptionId}`,
        });
        continue;
      }
      errors.push({
        entryId: item.entryId,
        error: `Entry must have status 'approved', got: ${entry.descriptionStatus}`,
      });
      continue;
    }
    toProcess.push({ entry, referenceCode: item.referenceCode });
  }

  if (toProcess.length === 0) {
    return { promoted, skipped, errors };
  }

  // Pitfall 5: check reference code uniqueness against descriptions table
  const refCodes = toProcess.map((p) => p.referenceCode);
  const existingDescs = await db
    .select({ referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(inArray(descriptions.referenceCode, refCodes))
    .all();

  const existingRefCodes = new Set(existingDescs.map((d) => d.referenceCode));
  const duplicateEntries = toProcess.filter((p) =>
    existingRefCodes.has(p.referenceCode)
  );
  for (const dup of duplicateEntries) {
    errors.push({
      entryId: dup.entry.id,
      error: `Duplicate reference code: ${dup.referenceCode} already exists in descriptions`,
    });
  }
  const uniqueToProcess = toProcess.filter(
    (p) => !existingRefCodes.has(p.referenceCode)
  );

  if (uniqueToProcess.length === 0) {
    return { promoted, skipped, errors };
  }

  // ---- (b) Load parent context ----

  const volume = await db
    .select()
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    throw new Error(`Volume not found: ${volumeId}`);
  }

  // find description matching volume's referenceCode
  const parentDescription = await db
    .select()
    .from(descriptions)
    .where(eq(descriptions.referenceCode, volume.referenceCode))
    .get();

  if (!parentDescription) {
    throw new Error(
      `No description found matching volume reference code: ${volume.referenceCode}. ` +
        `The volume's parent description must exist before promotion.`
    );
  }

  // ---- (c) Load volume manifest pages ----

  const pages = await db
    .select()
    .from(volumePages)
    .where(eq(volumePages.volumeId, volumeId))
    .orderBy(volumePages.position)
    .all();

  const volumePageList: VolumePage[] = pages.map((p) => ({
    position: p.position,
    width: p.width,
    height: p.height,
    imageUrl: p.imageUrl,
    label: p.label ?? String(p.position),
  }));

  // If no local pages, try fetching from manifest URL
  if (volumePageList.length === 0) {
    const parsed = await parseManifest(volume.manifestUrl);
    volumePageList.push(...parsed.pages);
  }

  // ---- (d) Map entries to descriptions (pure) ----

  // Get current max position under parent
  const maxPosRows = await db
    .select({ maxPos: sql<number>`coalesce(max(${descriptions.position}), -1)` })
    .from(descriptions)
    .where(eq(descriptions.parentId, parentDescription.id))
    .all();
  let nextPosition = (maxPosRows[0]?.maxPos ?? -1) + 1;

  const mappings: Array<{
    entry: typeof entries.$inferSelect;
    descriptionId: string;
    referenceCode: string;
    descriptionData: Record<string, any>;
    manifest: object;
  }> = [];

  for (const { entry, referenceCode } of uniqueToProcess) {
    const descriptionId = crypto.randomUUID();
    const result = mapEntryToDescription({
      entry,
      volumeReferenceCode: volume.referenceCode,
      assignedReferenceCode: referenceCode,
      repositoryId: parentDescription.repositoryId,
      parentDescriptionId: parentDescription.id,
      rootDescriptionId:
        parentDescription.rootDescriptionId ?? parentDescription.id,
      parentDepth: parentDescription.depth,
      parentPathCache: parentDescription.pathCache ?? "",
      userId,
    });

    // Set position and iiifManifestUrl
    const descData = {
      ...result.description,
      position: nextPosition++,
      iiifManifestUrl: `${manifestBaseUrl}/${referenceCode}/manifest.json`,
    };

    // ---- (e) Build manifest (pure) ----
    const manifest = buildDocumentManifest(
      result.manifestSpec,
      volumePageList,
      manifestBaseUrl
    );

    mappings.push({
      entry,
      descriptionId,
      referenceCode,
      descriptionData: descData,
      manifest,
    });
  }

  // ---- (f) Insert descriptions into D1 ----

  const now = Date.now();
  const insertStmts = mappings.map((m) =>
    db.insert(descriptions).values({
      id: m.descriptionId,
      ...m.descriptionData,
      createdAt: now,
      updatedAt: now,
    } as typeof descriptions.$inferInsert)
  );

  for (let i = 0; i < insertStmts.length; i += CHUNK_SIZE) {
    const chunk = insertStmts.slice(i, i + CHUNK_SIZE);
    await db.batch(chunk as any);
  }

  // ---- (g) Upload manifests to R2 ----

  for (const m of mappings) {
    await manifestsBucket.put(
      `${m.referenceCode}.json`,
      JSON.stringify(m.manifest),
      { httpMetadata: { contentType: "application/ld+json" } }
    );
  }

  // ---- (h) Update entries ----

  const updateStmts = mappings.map((m) =>
    db
      .update(entries)
      .set({
        promotedDescriptionId: m.descriptionId,
        descriptionStatus: "promoted" as const,
        updatedAt: now,
      })
      .where(eq(entries.id, m.entry.id))
  );

  for (let i = 0; i < updateStmts.length; i += CHUNK_SIZE) {
    const chunk = updateStmts.slice(i, i + CHUNK_SIZE);
    await db.batch(chunk as any);
  }

  // ---- (i) Update parent denorm cache ----

  const promotedCount = mappings.length;
  await db
    .update(descriptions)
    .set({
      childCount: sql`${descriptions.childCount} + ${promotedCount}`,
      updatedAt: now,
    })
    .where(eq(descriptions.id, parentDescription.id));

  // ---- (j) Return results ----

  for (const m of mappings) {
    promoted.push({
      entryId: m.entry.id,
      descriptionId: m.descriptionId,
      referenceCode: m.referenceCode,
    });
  }

  return { promoted, skipped, errors };
}
