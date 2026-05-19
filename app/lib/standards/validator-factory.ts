/**
 * Standard-Aware Validator Factory
 *
 * This factory deals with the per-standard, per-level Zod validators
 * for archival descriptions. Public API:
 * `descriptionValidatorFor(standard, level)` returns a Zod schema;
 * consumers call `.safeParse(...)` themselves. The bulk import
 * pipeline is the second consumer, so per-standard mandatoriness
 * lives exclusively here rather than being re-implemented at each
 * write boundary.
 *
 * Composition idiom: layer per-standard required-field checks on top
 * of the base union schema (`descriptionSchema` in
 * `app/lib/validation/description.ts`, where every column is
 * nullable) using Zod v4's `.check()` primitive. The factory iterates
 * `requiredFieldsForLevel(level)` from the matching `StandardConfig`
 * and pushes a custom issue for each missing column.
 *
 * Pitfall 1 (Zod v4 short-circuit on the v3-style refinement API):
 * we MUST use `.check()` here, not the v3-era refinement primitive.
 * The v3 primitive does not exist on v4 schemas; even where
 * pre-release v4 codepaths exposed it, it short-circuits against the
 * base schema's atomic checks and surfaces only one error at a time.
 * `.check()` is the v4-canonical sequencing primitive — it collects
 * ALL required-field issues in a single safeParse pass, which matters
 * because a malicious payload omitting multiple required fields
 * cannot slip through one-error-at-a-time UX.
 * [CITED: https://github.com/colinhacks/zod/issues/5290]
 *
 * Type cast: `(ctx.value as Record<string, unknown>)` is required
 * because the base schema's parsed type narrows column types; the
 * factory operates on the post-base-validation parsed object surface
 * via Record indexing, which is the v4-canonical shape for
 * `.check()` callbacks that read arbitrary column names from a
 * config-driven loop.
 *
 * Empty-string-as-missing: a value of `""` is treated as missing
 * alongside `null`/`undefined` because forms POST empty inputs as
 * empty strings (not nulls). Without this, an unfilled required
 * input would silently pass validation and land an empty cell in the
 * database. Mirrors the form layer's existing convention.
 *
 * Issue messages as i18n tokens: the `message` field on each pushed
 * issue is a STABLE TOKEN (`"field_required"`), not a free-text
 * English string. Renderers look the token up against the active
 * locale (`error_required`). Surfacing raw `"<col> is required for
 * <standard> at <level> level"` would leak engineering English plus
 * internal column names plus the lowercase user-facing standard name
 * (`dacs`/`rad`) into the user UI — a cataloguer in a Spanish
 * session would see that string verbatim.
 *
 * Base-schema lift via `.partial()`: Zod v4 short-circuits — if the
 * base parse has any issues, the chained `.check()` callback does
 * NOT run. The base `descriptionSchema` has hard `.string().min(1)`
 * checks on `id`, `repositoryId`, `referenceCode`, `title`, etc.,
 * which would fire on an empty payload and silence the per-standard
 * mandatoriness pass. We lift the base schema via `.partial()` so
 * every column becomes optional at the base layer; this lets
 * `.check()` always run and emit ALL required-field issues for the
 * (standard, level) pair from a single source. Identifier fields
 * the base schema previously enforced (`id`, `referenceCode`,
 * `title`, etc.) now ride on each standard's `requiredAt: ALL_LEVELS`
 * declarations, so coverage is preserved — the authority simply moves
 * from base schema to per-standard config.
 *
 * @version v0.4.0
 */

import { z } from "zod/v4";
import { descriptionSchema } from "../validation/description";
import { getStandardConfig } from "./registry";
import type { DescriptionLevel, Standard } from "./types";

/**
 * Build a per-standard, per-level Zod schema. Composes on top of the
 * base union `descriptionSchema` (every column nullable in the DB);
 * this factory layers per-standard mandatoriness via `.check()` (Zod
 * v4 idiom — replaces the v3-era refinement primitive which
 * short-circuits per github.com/colinhacks/zod/issues/5290 and
 * surfaces only one error at a time; `.check()` collects ALL
 * required-field issues in a single pass).
 *
 * Public API: returns a Zod schema; consumers call
 * `.safeParse(...)` themselves. The bulk-import pipeline is the
 * second consumer.
 */
export function descriptionValidatorFor(
  standard: Standard,
  level: DescriptionLevel,
): z.ZodType {
  const config = getStandardConfig(standard);
  const requiredColumns = config.requiredFieldsForLevel(level);
  return descriptionSchema.partial().check((ctx) => {
    for (const col of requiredColumns) {
      const value = (ctx.value as Record<string, unknown>)[col];
      if (value == null || value === "") {
        ctx.issues.push({
          code: "custom",
          // Stable i18n token. Renderers must translate this via
          // `t("error_required")` rather than displaying the message
          // verbatim.
          message: "field_required",
          path: [col],
          input: value,
        });
      }
    }
  });
}

/* @version v0.4.0 */
