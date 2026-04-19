/**
 * Promotion Field Mapping
 *
 * Canonical list of ISAD(G) fields that promotion copies from a
 * crowdsourced volume entry into the long-lived archival description.
 * Kept as a single source of truth so the promote action, the preview
 * table, and the per-field validation stay in lockstep.
 *
 * @version v0.3.0
 */
import type { PromotionInput, PromotionOutput } from "./types";
import { RESOURCE_TYPE_MAP } from "./types";

/**
 * Pure mapping function: transforms a crowdsourcing entry into a partial
 * description object and a manifest specification.
 *
 * Maps the 12 shared fields, renames descriptionNotes to notes,
 * forces descriptionLevel to "item", and translates Spanish resource
 * type enums to English (Pitfall 1).
 *
 * No I/O — all database writes and manifest uploads happen in the caller.
 */
export function mapEntryToDescription(
  input: PromotionInput
): PromotionOutput {
  const {
    entry,
    assignedReferenceCode,
    repositoryId,
    parentDescriptionId,
    rootDescriptionId,
    parentDepth,
    parentPathCache,
    userId,
  } = input;

  const mappedResourceType = entry.resourceType
    ? (RESOURCE_TYPE_MAP[entry.resourceType] ?? undefined)
    : undefined;

  const title = entry.title ?? "Untitled";

  return {
    description: {
      repositoryId,
      parentId: parentDescriptionId,
      rootDescriptionId,
      position: 0, // computed by caller based on existing children
      depth: parentDepth + 1,
      childCount: 0,
      pathCache: parentPathCache
        ? `${parentPathCache} > ${title}`
        : title,
      descriptionLevel: "item", // always item
      resourceType: mappedResourceType as any,
      referenceCode: assignedReferenceCode,
      localIdentifier: assignedReferenceCode,
      title,
      translatedTitle: entry.translatedTitle ?? undefined,
      dateExpression: entry.dateExpression ?? undefined,
      dateStart: entry.dateStart ?? undefined,
      dateEnd: entry.dateEnd ?? undefined,
      extent: entry.extent ?? undefined,
      scopeContent: entry.scopeContent ?? undefined,
      language: entry.language ?? undefined,
      notes: entry.descriptionNotes ?? undefined, // renamed
      internalNotes: entry.internalNotes ?? undefined, // direct
      hasDigital: true,
      isPublished: false, // staff publishes later
      iiifManifestUrl: undefined, // set after manifest upload
      createdBy: userId,
      updatedBy: userId,
    },
    manifestSpec: {
      referenceCode: assignedReferenceCode,
      title,
      startPage: entry.startPage,
      startY: entry.startY,
      endPage: entry.endPage ?? null,
      endY: entry.endY ?? null,
    },
  };
}
