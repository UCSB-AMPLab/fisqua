/**
 * Tests — Standard-Aware Validator Factory
 *
 * This suite is the unit-coverage net for `app/lib/standards/validator-factory.ts`. It asserts
 * that `descriptionValidatorFor(standard, level)` surfaces every
 * required column for each (standard × level) pair, that empty
 * strings are treated as missing alongside null, that multiple
 * missing fields surface together in one safeParse pass (the
 * collect-then-report semantics), and that the factory throws on
 * unknown standards (delegated through `getStandardConfig`).
 *
 * Pure factory test — no DB needed; runs under the workers vitest
 * pool because the project's default vitest config uses it. Per-file
 * cadence only (`npx vitest run tests/standards/...`); the full
 * suite crashes the user's laptop (memory `feedback_no_full_test_suite`).
 *
 * @version v0.4.0
 */

import { describe, it, expect } from "vitest";
import { descriptionValidatorFor } from "../../app/lib/standards/validator-factory";
import { ISADG_CONFIG } from "../../app/lib/standards/isadg";
import { DACS_CONFIG } from "../../app/lib/standards/dacs";
import { RAD_CONFIG } from "../../app/lib/standards/rad";
import type { DescriptionLevel } from "../../app/lib/standards/types";

const CONFIGS = {
  isadg: ISADG_CONFIG,
  dacs: DACS_CONFIG,
  rad: RAD_CONFIG,
} as const;
const STANDARDS = ["isadg", "dacs", "rad"] as const;
const LEVELS: ReadonlyArray<DescriptionLevel> = [
  "fonds",
  "series",
  "file",
  "item",
];

describe("descriptionValidatorFor", () => {
  for (const standard of STANDARDS) {
    for (const level of LEVELS) {
      it(`${standard} × ${level}: empty payload surfaces every required field`, () => {
        const validator = descriptionValidatorFor(standard, level);
        const result = validator.safeParse({});
        expect(result.success).toBe(false);
        if (result.success) return; // type narrow
        const required = CONFIGS[standard].requiredFieldsForLevel(level);
        const missingPaths = new Set(
          result.error.issues.map((i) => String(i.path[0])),
        );
        for (const col of required) {
          expect(missingPaths).toContain(col);
        }
      });

      it(`${standard} × ${level}: empty string is treated as missing`, () => {
        const validator = descriptionValidatorFor(standard, level);
        const required = CONFIGS[standard].requiredFieldsForLevel(level);
        const payload = Object.fromEntries(required.map((c) => [c, ""]));
        const result = validator.safeParse(payload);
        expect(result.success).toBe(false);
      });
    }
  }

  it("multiple missing fields surface together", () => {
    const validator = descriptionValidatorFor("isadg", "fonds");
    const result = validator.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    // ISAD(G) fonds requires 7 fields (referenceCode, title,
    // dateExpression, descriptionLevel, extent, creatorDisplay,
    // scopeContent) — all should appear in a single safeParse pass.
    expect(result.error.issues.length).toBeGreaterThanOrEqual(7);
  });

  it("getStandardConfig throws for unknown standard via factory", () => {
    // The factory delegates to getStandardConfig — passing a bad cast
    // triggers the throw.
    expect(() =>
      descriptionValidatorFor("xx" as never, "fonds"),
    ).toThrow(/Unknown descriptive standard/);
  });
});

/* @version v0.4.0 */
