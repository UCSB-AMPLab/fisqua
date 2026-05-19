/**
 * Description Validation Schemas
 *
 * This module deals with the Zod schemas for archival description
 * records, used by the create, edit, autosave, and bulk-import write
 * paths.
 *
 * Migration `drizzle/0036_union_schema.sql` dropped `related_materials`
 * (0% populated in production audit). `publication_title` and the
 * DACS/RAD union additions (`admin_biog_history`, `preferred_citation`,
 * `acquisition_info`, `system_of_arrangement`,
 * `physical_characteristics`) landed alongside `legacy_ids` JSON.
 * `local_identifier` was RELAXED to nullable (DACS/RAD do not mandate
 * it). Per-standard mandatoriness lives in the standard-aware
 * validators under `app/lib/standards/` — this base schema captures
 * the union shape only.
 *
 * @version v0.4.0
 */

import { z } from "zod/v4";
import { DESCRIPTION_LEVELS, RESOURCE_TYPES } from "./enums";

export const descriptionSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).default(0),
  rootDescriptionId: z.string().uuid().nullable().optional(),
  depth: z.number().int().min(0).default(0),
  childCount: z.number().int().min(0).default(0),
  pathCache: z.string().default(""),
  descriptionLevel: z.enum(DESCRIPTION_LEVELS),
  resourceType: z.enum(RESOURCE_TYPES).nullable().optional(),
  genre: z.string().default("[]"), // JSON string
  referenceCode: z.string().min(1).max(100),
  // local_identifier RELAXED to nullable in 0036 — see file header.
  localIdentifier: z.string().min(1).max(100).nullable().optional(),
  title: z.string().min(1).max(2000),
  translatedTitle: z.string().max(2000).optional(),
  uniformTitle: z.string().max(500).optional(),
  dateExpression: z.string().max(255).optional(),
  dateStart: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable()
    .optional(),
  dateEnd: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable()
    .optional(),
  dateCertainty: z.string().max(20).optional(),
  extent: z.string().max(1000).optional(),
  dimensions: z.string().max(100).optional(),
  medium: z.string().max(255).optional(),
  imprint: z.string().max(500).optional(),
  editionStatement: z.string().max(500).optional(),
  seriesStatement: z.string().max(500).optional(),
  volumeNumber: z.string().max(50).optional(),
  issueNumber: z.string().max(50).optional(),
  pages: z.string().max(100).optional(),
  // Bibliographic-block "Title of the larger publication" (added 0036).
  publicationTitle: z.string().max(500).optional(),
  provenance: z.string().optional(),
  scopeContent: z.string().optional(),
  ocrText: z.string().default(""),
  arrangement: z.string().optional(),
  accessConditions: z.string().optional(),
  reproductionConditions: z.string().optional(),
  language: z.string().max(100).optional(),
  locationOfOriginals: z.string().optional(),
  locationOfCopies: z.string().optional(),
  findingAids: z.string().optional(),
  // Union-schema additions for DACS + RAD (drizzle/0036).
  adminBiogHistory: z.string().optional(),
  preferredCitation: z.string().optional(),
  acquisitionInfo: z.string().optional(),
  systemOfArrangement: z.string().optional(),
  physicalCharacteristics: z.string().optional(),
  // Generic legacy id JSON column (0036).
  legacyIds: z.string().default("[]"),
  sectionTitle: z.string().max(500).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  creatorDisplay: z.string().max(500).optional(),
  placeDisplay: z.string().max(500).optional(),
  iiifManifestUrl: z.string().url().optional(),
  hasDigital: z.boolean().default(false),
  isPublished: z.boolean().default(true),
  createdBy: z.string().uuid().nullable().optional(),
  updatedBy: z.string().uuid().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createDescriptionSchema = descriptionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateDescriptionSchema = descriptionSchema
  .partial()
  .required({ id: true });

export const importDescriptionSchema = descriptionSchema;
