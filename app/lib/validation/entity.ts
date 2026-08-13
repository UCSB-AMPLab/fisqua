/**
 * Entity Validation Schemas
 *
 * This module deals with the Zod schemas that validate entity
 * authority records on every write path -- create, edit, bulk
 * import, and autosave draft. The
 * `entitySchema` captures the full shape the DB expects and is
 * intentionally stricter than the UI form: the admin UI may defer
 * optional fields, but a row committed to `entities` has to satisfy
 * every declared constraint. The `entityCode` regex pins the
 * agency-prefixed code format — a configured prefix, a hyphen, and six
 * characters from the 30-character code alphabet — so external
 * references have a stable shape. It accepts `ne-abc234` (Neogranadina)
 * and `sbmal-e-abc234` (SBMAL) alike: since migration 0068 the prefix
 * names whichever agency maintains the record, so the format can no
 * longer pin one institution's literal. The rule itself lives in
 * `app/lib/validation/authority-code.ts`, shared with the place schema
 * and with the generator's alphabet.
 *
 * Migration `drizzle/0036_union_schema.sql` dropped `legal_status`
 * (0% populated in production audit) and added `dbe_id` (Diccionario
 * Biográfico Electrónico authority ref) and the generic `legacy_ids`
 * JSON column.
 *
 * @version v0.7.0
 */

import { z } from "zod/v4";
import { ENTITY_TYPES } from "./enums";
import { AUTHORITY_CODE_RE } from "./authority-code";

export const entitySchema = z.object({
  id: z.string().uuid(),
  // Agency prefix + 6 characters from the 30-char code alphabet.
  entityCode: z.string().regex(AUTHORITY_CODE_RE),
  displayName: z.string().min(1).max(500),
  sortName: z.string().min(1).max(500),
  surname: z.string().max(200).optional(),
  givenName: z.string().max(200).optional(),
  entityType: z.enum(ENTITY_TYPES),
  honorific: z.string().max(100).optional(),
  primaryFunction: z.string().max(300).optional(),
  nameVariants: z.string().default("[]"), // JSON string
  datesOfExistence: z.string().max(100).optional(),
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
  history: z.string().optional(),
  functions: z.string().optional(),
  sources: z.string().optional(),
  mergedInto: z.string().uuid().nullable().optional(),
  wikidataId: z.string().max(20).nullable().optional(),
  viafId: z.string().max(20).nullable().optional(),
  // Diccionario Biográfico Electrónico authority ref (added in 0036).
  dbeId: z.string().max(20).nullable().optional(),
  // Generic legacy id JSON column (0036). Full Zod shape lives in
  // app/lib/validation/legacy-ids.ts.
  legacyIds: z.string().default("[]"),
  // Free-text notes pair (migration 0059). `notes` may eventually
  // publish; `internalNotes` never leaves the admin surface (excluded
  // from the export pipeline). Both nullable — absent = no note.
  notes: z.string().nullable().optional(),
  internalNotes: z.string().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createEntitySchema = entitySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateEntitySchema = entitySchema
  .partial()
  .required({ id: true });

export const importEntitySchema = entitySchema;
