import type { z } from "zod/v4";
import type { ImportError } from "./types";

/**
 * Validate an array of rows against a Zod schema, collecting errors
 * per-row without aborting the batch.
 *
 * @param rows - Array of raw data objects to validate
 * @param schema - Zod schema to validate against
 * @param tableName - Table name for error reporting
 * @returns Object with valid parsed rows and collected errors
 */
export function validateRows<T>(
  rows: unknown[],
  schema: z.ZodType<T>,
  tableName: string
): { valid: T[]; errors: ImportError[] } {
  const valid: T[] = [];
  const errors: ImportError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const result = schema.safeParse(row);

    if (result.success) {
      valid.push(result.data);
    } else {
      errors.push({
        table: tableName,
        row: i,
        oldId: (row?.id as number | string) ?? i,
        errors: result.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`
        ),
      });
    }
  }

  return { valid, errors };
}
