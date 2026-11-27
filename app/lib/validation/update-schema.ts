/**
 * Update schemas without defaults
 *
 * This module builds the schema an edit action validates against from a
 * record's full schema. A full schema's defaults (`legacyIds` "[]",
 * `nameVariants` "[]") are right for a create or an import, where an
 * absent field means "none yet". On an update an absent field means
 * "not submitted", and Zod v4's `.partial()` keeps a field's default,
 * so a partial schema hands the default back for a field the request
 * never carried; spread into the UPDATE, that overwrites the stored
 * value. `updateSchemaFrom` strips every default before making the
 * fields optional, so a field absent from the input is absent from the
 * output, and only `id` is required.
 *
 * The two helpers below are the rest of that rule at the action's two
 * ends. `submittedFields` reads a form request: `has` says whether the
 * request carries a field at all, and an edit action reads a field only
 * when it does, so an input the page did not submit is never read as
 * blank. `fieldsToWrite` turns the parsed values into the columns the
 * UPDATE sets and the changelog compares: a field the request did not
 * carry is left out, and so is a blank value whose stored value is
 * already blank ("" or NULL), which stays as stored rather than being
 * rewritten (and logged) as a change from "" to NULL.
 *
 * @version v0.9.0
 */

import { z } from "zod/v4";

type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K];
};

/** The shape of `schema` with every top-level default removed. */
export function shapeWithoutDefaults<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): WithoutDefaults<T> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] =
      field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
  }
  return shape as unknown as WithoutDefaults<T>;
}

/**
 * A partial update schema for `schema`: no defaults, every field
 * optional except `id`.
 */
export function updateSchemaFrom<T extends z.ZodRawShape & { id: z.ZodType }>(
  schema: z.ZodObject<T>,
) {
  return z
    .object(shapeWithoutDefaults(schema))
    .partial()
    .extend({ id: schema.shape.id as T["id"] });
}

/** A form request's fields: whether it carries one, and its trimmed text ("" when absent). */
export function submittedFields(formData: FormData) {
  return {
    has: (name: string) => formData.has(name),
    trimmed: (name: string) => ((formData.get(name) as string | null) ?? "").trim(),
  };
}

function isBlank(value: unknown): boolean {
  return value == null || value === "";
}

/**
 * The columns an update writes: every value in `updates` that is not
 * undefined, except a blank one whose value in `stored` is blank too.
 */
export function fieldsToWrite(
  updates: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (isBlank(value) && isBlank(stored?.[key])) continue;
    out[key] = value;
  }
  return out;
}
