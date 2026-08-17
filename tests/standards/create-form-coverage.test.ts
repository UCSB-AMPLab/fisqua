/**
 * Tests — the create form can satisfy every level it offers
 *
 * The new-description page renders a fixed identity set plus whatever
 * the chosen level additionally requires, and it finds those extra
 * fields by walking the tenant's `StandardConfig.sections` for a
 * matching `FieldConfig`. That indirection is what this suite guards.
 *
 * ## The bug this exists to prevent
 *
 * The page used to post a fixed six fields while the action validated
 * against `requiredFieldsForLevel(level)`. Since ISAD(G) asks a fonds
 * for dates, extent, creator and scope — none of them on the form —
 * creation succeeded at exactly the two levels that require nothing
 * more (section, volume) and failed at every other, with no field for
 * the cataloguer to fill. An adopter hit it on their first day of
 * cataloguing after migrating their data in.
 *
 * The form is now data-driven, so the failure mode moved: a column can
 * be required at some level and yet have no `FieldConfig` anywhere in
 * that standard's sections, in which case the loader silently omits an
 * input the validator will still demand, and the level is unfillable
 * again — same dead end, quieter cause. That is the invariant asserted
 * below, across the whole (standard x level) matrix rather than the
 * four levels the sibling factory suite samples.
 *
 * These are pure config assertions: no route module is imported (the
 * workers pool does not resolve the dynamic `~/` imports a route
 * action uses — see `admin-save-action.integration.test.ts`), and the
 * page's own identity list is imported from the route as a value, not
 * duplicated, so a change there is a change here.
 *
 * @version v0.7.0
 */

import { describe, it, expect } from "vitest";
import { ISADG_CONFIG } from "../../app/lib/standards/isadg";
import { DACS_CONFIG } from "../../app/lib/standards/dacs";
import { RAD_CONFIG } from "../../app/lib/standards/rad";
import { DESCRIPTION_LEVELS } from "../../app/lib/validation/enums";
import { IDENTITY_COLUMNS } from "../../app/routes/_auth.admin.descriptions.new";
import type {
  DescriptionLevel,
  StandardConfig,
} from "../../app/lib/standards/types";

const CONFIGS: ReadonlyArray<StandardConfig> = [
  ISADG_CONFIG,
  DACS_CONFIG,
  RAD_CONFIG,
];

/** Every column the standard declares a field for, in any section. */
function configuredColumns(config: StandardConfig): Set<string> {
  const columns = new Set<string>();
  for (const section of config.sections) {
    for (const field of section.fields) columns.add(field.column);
  }
  return columns;
}

/** The primitive the create form would render this column with. */
function primitiveFor(
  config: StandardConfig,
  column: string,
): string | undefined {
  for (const section of config.sections) {
    for (const field of section.fields) {
      if (field.column === column) return field.primitive;
    }
  }
  return undefined;
}

describe("create form coverage — every level it offers is fillable", () => {
  for (const config of CONFIGS) {
    const columns = configuredColumns(config);

    for (const level of DESCRIPTION_LEVELS) {
      it(`${config.standard} x ${level}: every required column is renderable`, () => {
        const required = config.requiredFieldsForLevel(
          level as DescriptionLevel,
        );
        // Anything the identity block already renders is covered by
        // the page itself; the rest must be findable in the config.
        const missing = required
          .filter((column) => !IDENTITY_COLUMNS.includes(column))
          .filter((column) => !columns.has(column));
        expect(
          missing,
          `${config.standard} requires ${missing.join(", ")} at level "${level}", ` +
            `but no section declares a field for those columns — the create ` +
            `form cannot render an input for them, so the level cannot be ` +
            `created at all. Either add a FieldConfig in ` +
            `app/lib/standards/${config.standard}.ts or drop the column from ` +
            `that level's required list.`,
        ).toEqual([]);
      });
    }
  }

  it("the identity columns the page hard-codes are real columns in every standard", () => {
    // IDENTITY_COLUMNS is the page's claim that it already renders
    // these. A typo, or a rename in the configs, would quietly move a
    // column from "already on the form" to "on neither half".
    for (const config of CONFIGS) {
      const columns = configuredColumns(config);
      const unknown = IDENTITY_COLUMNS.filter((c) => !columns.has(c));
      expect(
        unknown,
        `The create form claims to render ${unknown.join(", ")}, but ` +
          `${config.standard} declares no such column.`,
      ).toEqual([]);
    }
  });

  it("a column declared in two sections has exactly one required declaration", () => {
    // A config may declare the same column twice on purpose — DACS
    // puts `accessConditions` in both the conditions area and the
    // rights area, under different labels. The edit page renders both;
    // the create form must render ONE input per column, and it picks
    // the declaration whose `requiredAt` is non-empty. If two
    // declarations of the same column were both required, that pick
    // would be arbitrary and the form would silently drop one label's
    // meaning.
    const ambiguous: string[] = [];
    for (const config of CONFIGS) {
      const requiredDecls = new Map<string, number>();
      for (const section of config.sections) {
        for (const field of section.fields) {
          if (field.requiredAt.length === 0) continue;
          requiredDecls.set(
            field.column,
            (requiredDecls.get(field.column) ?? 0) + 1,
          );
        }
      }
      for (const [column, n] of requiredDecls) {
        if (n > 1) ambiguous.push(`${config.standard}.${column} (${n})`);
      }
    }
    expect(
      ambiguous,
      `These columns carry more than one required declaration, so the create ` +
        `form cannot tell which section owns the field:\n${ambiguous.join("\n")}`,
    ).toEqual([]);
  });

  it("every level-required extra renders as a text input or a textarea", () => {
    // The page maps `textarea` to a textarea and everything else to a
    // text input. A required column configured as a composite
    // primitive (a linker, a checkbox) would render as a bare text box
    // that posts a value the column cannot hold.
    const RENDERABLE = new Set(["text", "textarea", "date", "date-range"]);
    const offenders: string[] = [];
    for (const config of CONFIGS) {
      for (const level of DESCRIPTION_LEVELS) {
        for (const column of config.requiredFieldsForLevel(
          level as DescriptionLevel,
        )) {
          if (IDENTITY_COLUMNS.includes(column)) continue;
          const primitive = primitiveFor(config, column);
          if (primitive && !RENDERABLE.has(primitive)) {
            offenders.push(
              `${config.standard}.${column} at ${level} is "${primitive}"`,
            );
          }
        }
      }
    }
    expect(
      [...new Set(offenders)],
      `These columns are required at a level but use a primitive the create ` +
        `form cannot render as a plain input:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

/* @version v0.7.0 */
