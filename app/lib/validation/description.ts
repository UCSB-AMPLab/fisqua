/**
 * Description Validation Schemas
 *
 * Zod schemas for archival description records, used by the create,
 * edit, autosave, and bulk-import write paths.
 *
 * @version v0.3.0
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
  localIdentifier: z.string().min(1).max(100),
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
  provenance: z.string().optional(),
  scopeContent: z.string().optional(),
  ocrText: z.string().default(""),
  arrangement: z.string().optional(),
  accessConditions: z.string().optional(),
  reproductionConditions: z.string().optional(),
  language: z.string().max(100).optional(),
  locationOfOriginals: z.string().optional(),
  locationOfCopies: z.string().optional(),
  relatedMaterials: z.string().optional(),
  findingAids: z.string().optional(),
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
