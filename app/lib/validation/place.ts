/**
 * Place Validation Schemas
 *
 * Zod schemas that validate place authority records on every write
 * path -- create, edit, bulk import, and autosave draft. The
 * `placeSchema` captures the full Linked Places-adjacent shape with
 * coordinates, historical administrative divisions, and external
 * authority IDs (Wikidata, Getty TGN, WHG, HGIS). The `placeCode`
 * regex pins the `nl-xxxxxx` format (6 lowercase alphanumeric
 * characters from a 32-char alphabet) so external references stay
 * stable across merges and renames.
 *
 * @version v0.3.0
 */

import { z } from "zod/v4";
import { PLACE_TYPES } from "./enums";

export const placeSchema = z.object({
  id: z.string().uuid(),
  placeCode: z.string().regex(/^nl-[a-z2-9]{6}$/), // 6-char from 32-char alphabet
  label: z.string().min(1).max(255),
  displayName: z.string().min(1).max(500),
  placeType: z.enum(PLACE_TYPES).nullable().optional(),
  nameVariants: z.string().default("[]"), // JSON string
  parentId: z.string().uuid().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  coordinatePrecision: z.string().max(20).optional(),
  historicalGobernacion: z.string().max(100).optional(),
  historicalPartido: z.string().max(100).optional(),
  historicalRegion: z.string().max(10).optional(),
  countryCode: z.string().max(3).optional(),
  adminLevel1: z.string().max(100).optional(),
  adminLevel2: z.string().max(100).optional(),
  needsGeocoding: z.boolean().default(true),
  mergedInto: z.string().uuid().nullable().optional()
  tgnId: z.string().max(20).nullable().optional(),
  hgisId: z.string().max(50).nullable().optional(),
  whgId: z.string().max(50).nullable().optional(),
  wikidataId: z.string().max(20).nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createPlaceSchema = placeSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updatePlaceSchema = placeSchema.partial().required({ id: true });

export const importPlaceSchema = placeSchema;
