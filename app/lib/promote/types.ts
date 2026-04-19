/**
 * Promotion Types
 *
 * Shared shapes for the promotion pipeline: the summary row the UI
 * renders, the per-entry payload the action validates, and the
 * manifest contract the frontend reads from R2.
 *
 * @version v0.3.0
 */

import type { entries, descriptions } from "../../db/schema";

/** Input to the pure mapping function */
export interface PromotionInput {
  entry: typeof entries.$inferSelect;
  volumeReferenceCode: string;
  assignedReferenceCode: string;
  repositoryId: string;
  parentDescriptionId: string;
  rootDescriptionId: string;
  parentDepth: number;
  parentPathCache: string;
  userId: string;
}

/** Output from the pure mapping function */
export interface PromotionOutput {
  description: Omit<
    typeof descriptions.$inferInsert,
    "id" | "createdAt" | "updatedAt"
  >;
  manifestSpec: ManifestSpec;
}

/** Specification for building a per-document IIIF manifest */
export interface ManifestSpec {
  referenceCode: string;
  title: string;
  startPage: number;
  startY: number;
  endPage: number | null;
  endY: number | null;
}

/** A page from a volume manifest, used by the manifest builder */
export interface VolumePage {
  position: number;
  width: number;
  height: number;
  imageUrl: string;
  label: string;
}

/** Map of Spanish entry resourceType to English description resourceType */
export const RESOURCE_TYPE_MAP: Record<string, string> = {
  texto: "text",
  imagen: "still_image",
  cartografico: "cartographic",
  mixto: "mixed",
} as const;
