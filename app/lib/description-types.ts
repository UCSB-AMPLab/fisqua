/**
 * Description Types
 *
 * This module deals with the shared TypeScript types for the
 * item-level description workflow — entry shape, comment target
 * kinds, and the denormalised data the loader hands the editor
 * component.
 *
 * @version v0.4.0
 */

import type { DescriptionStatus } from "./description-workflow";
import type { ResourceTypeEs, ProjectRole } from "./validation/enums";

/**
 * Entry fields relevant to the description form context.
 */
export type DescriptionEntry = {
  id: string;
  volumeId: string;
  position: number;
  startPage: number;
  endPage: number | null;
  title: string | null;
  translatedTitle: string | null;
  resourceType: ResourceTypeEs | null;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  extent: string | null;
  scopeContent: string | null;
  language: string | null;
  descriptionNotes: string | null;
  internalNotes: string | null;
  descriptionLevel: string | null;
  descriptionStatus: DescriptionStatus;
  assignedDescriber: string | null;
  assignedDescriptionReviewer: string | null;
};

/**
 * Comment matching the comments table structure.
 *
 * Exactly one of `entryId`, `pageId`, or `qcFlagId` is set on every row;
 * the DB CHECK constraint and `createComment()` guard enforce this.
 * `volumeId` is denormalised for cheap volume-scoped loader queries.
 *
 * The schema adds `qcFlagId` (three-way target discrimination) and the
 * `region[XYWH]` coordinates (0-1 normalised image-region pins on
 * page-targeted comments).
 */
export type Comment = {
  id: string;
  volumeId: string;
  entryId: string | null;
  pageId: string | null;
  qcFlagId: string | null;
  regionX: number | null;
  regionY: number | null;
  regionW: number | null;
  regionH: number | null;
  parentId: string | null;
  authorId: string;
  authorRole: ProjectRole;
  text: string;
  createdAt: number;
  updatedAt: number;
  // Soft-delete, resolve, and last-edit markers.
  // `deletedAt` is intentionally absent from the UI-facing type -- the
  // loader / read helpers filter `deleted_at IS NULL` so soft-deleted
  // rows never reach the client. `editedAt` drives the "Editado" chip;
  // `resolvedAt` + `resolvedBy` drive the "Resuelto" chip and the
  // collapsed-by-default behaviour on resolved threads.
  editedAt?: number | null;
  resolvedAt?: number | null;
  resolvedBy?: string | null;
};

/**
 * Comment with author email for display in UI.
 */
export type CommentWithAuthor = Comment & {
  authorEmail: string | null;
  authorName?: string | null;
};

/**
 * Resegmentation flag matching the resegmentation_flags table structure.
 */
export type ResegmentationFlag = {
  id: string;
  volumeId: string;
  reportedBy: string;
  entryId: string;
  problemType:
    | "incorrect_boundaries"
    | "merged_documents"
    | "split_document"
    | "missing_pages"
    | "other";
  affectedEntryIds: string; // JSON array of entry IDs
  description: string;
  status: "open" | "resolved";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
};

/**
 * Section completion state for the cataloguing description form.
 * Each section is true when its required fields are filled.
 *
 * Property names align with the English column-name keys used in the
 * cataloguing namespace (`identity`, `physical_description`,
 * `content`, `notes`). The cataloguing form component and the entry
 * route consume these names directly.
 */
export type SectionCompletion = {
  identity: boolean;
  physical_description: boolean;
  content: boolean;
  notes: boolean;
};

/**
 * Fields needed for section completion evaluation.
 */
type DescriptionFields = {
  title: string | null;
  resourceType: string | null;
  dateExpression: string | null;
  scopeContent: string | null;
  language: string | null;
  extent: string | null;
};

/**
 * Pure function to compute section completion state from entry fields.
 *
 * - identity: title + resourceType + dateExpression
 * - content: scopeContent + language
 * - physical_description: extent
 * - notes: always complete (both fields optional)
 */
export function getSectionCompletion(fields: DescriptionFields): SectionCompletion {
  return {
    identity: Boolean(fields.title && fields.resourceType && fields.dateExpression),
    content: Boolean(fields.scopeContent && fields.language),
    physical_description: Boolean(fields.extent),
    notes: true,
  };
}
