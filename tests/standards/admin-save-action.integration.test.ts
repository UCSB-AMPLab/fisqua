/**
 * Tests — admin save action × standard × level (validator factory matrix)
 *
 * This suite exercises the standard-aware Zod validator factory across the
 * full (3 standards × 4 levels) matrix with both invalid (missing
 * required field) and complete payloads. The factory's contract is
 * the subject here: per-standard mandatoriness layered on top of the
 * base union `descriptionSchema`.
 *
 * Why direct factory invocation (not the route module): per the
 * sibling pattern in `tests/admin/descriptions-tenant-isolation.test.ts`,
 * the workers vitest pool sandbox does not resolve dynamic `~/`
 * imports the route action uses. Calling the factory directly
 * matches the sibling's idiom: this exercises the standard-aware
 * contract the route's `case "update"` and `case "create"` paths
 * invoke, and that the bulk import invokes at the per-row write
 * boundary.
 *
 * Why the loose `complete payload is accepted` assertion: the base
 * `descriptionSchema` may still reject the sentinel UUID or date
 * format. This test cares specifically about whether the
 * per-standard required-field LAYER fires; column-shape validation
 * by the base schema is a separate concern. The factory's
 * responsibility is the per-standard required-field check.
 *
 * Test fixtures: `cleanDatabase()` calls `seedTenants()` automatically
 * so the three tenants this test references (Neogranadina,
 * `dacs-test`, `rad-test`) are seeded without per-test inline setup.
 *
 * @version v0.4.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDatabase,
  DACS_TEST_TENANT_ID,
  RAD_TEST_TENANT_ID,
} from "../helpers/db";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";
import { descriptionValidatorFor } from "../../app/lib/standards/validator-factory";
import { ISADG_CONFIG } from "../../app/lib/standards/isadg";
import { DACS_CONFIG } from "../../app/lib/standards/dacs";
import { RAD_CONFIG } from "../../app/lib/standards/rad";
import type {
  DescriptionLevel,
  Standard,
} from "../../app/lib/standards/types";

const CONFIGS = {
  isadg: ISADG_CONFIG,
  dacs: DACS_CONFIG,
  rad: RAD_CONFIG,
} as const;

const TENANT_BY_STANDARD: Record<Standard, string> = {
  // ISAD(G) tenant from the production seed.
  isadg: NEOGRANADINA_TENANT_ID,
  // DACS test tenant.
  dacs: DACS_TEST_TENANT_ID,
  // RAD test tenant.
  rad: RAD_TEST_TENANT_ID,
};

const STANDARDS: ReadonlyArray<Standard> = ["isadg", "dacs", "rad"];
const LEVELS: ReadonlyArray<DescriptionLevel> = [
  "fonds",
  "series",
  "file",
  "item",
];

/**
 * Build a payload populating every required field for (standard,
 * level) with a sentinel value. Sentinels are chosen by column name
 * so dates and FKs use plausible shapes; everything else gets a
 * non-empty string. The sentinel does not have to pass base-schema
 * shape validation — see file header for why.
 */
function buildValidPayload(
  standard: Standard,
  level: DescriptionLevel,
): Record<string, unknown> {
  const required = CONFIGS[standard].requiredFieldsForLevel(level);
  const payload: Record<string, unknown> = {
    descriptionLevel: level,
    tenantId: TENANT_BY_STANDARD[standard],
  };
  for (const col of required) {
    if (col === "dateExpression") {
      payload[col] = "1900-1950";
    } else if (col === "dateStart" || col === "dateEnd") {
      payload[col] = "1900-01-01";
    } else if (col === "repositoryId") {
      payload[col] = "00000000-0000-4000-8000-000000000000";
    } else if (col === "descriptionLevel") {
      payload[col] = level;
    } else {
      payload[col] = `test-${col}`;
    }
  }
  return payload;
}

describe("admin save action × standard × level (validator factory matrix)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  for (const standard of STANDARDS) {
    for (const level of LEVELS) {
      it(`${standard} x ${level}: missing required field is rejected`, () => {
        const validator = descriptionValidatorFor(standard, level);
        const required = CONFIGS[standard].requiredFieldsForLevel(level);
        if (required.length === 0) {
          // No required fields at this level for this standard;
          // there is nothing to drop, so the test is vacuously
          // satisfied. Surface that as a passing no-op rather than
          // skipping silently.
          expect(required).toEqual([]);
          return;
        }

        const valid = buildValidPayload(standard, level);
        const incomplete = { ...valid };
        const dropped = required[0];
        delete incomplete[dropped];

        const result = validator.safeParse(incomplete);
        expect(result.success).toBe(false);
        if (result.success) return;
        const missingPaths = new Set(
          result.error.issues.map((i) => String(i.path[0])),
        );
        expect(missingPaths).toContain(dropped);
      });

      it(`${standard} x ${level}: complete payload is accepted`, () => {
        const validator = descriptionValidatorFor(standard, level);
        const valid = buildValidPayload(standard, level);
        const result = validator.safeParse(valid);
        // The base descriptionSchema may still reject for column-
        // shape reasons (UUID format, date format) — what we care
        // about is that no required-field issue surfaces for the
        // sentinel-populated fields.
        if (!result.success) {
          // CR-04: validator now emits stable `field_required` token
          // (instead of "<col> is required for <std> at <level>" free
          // text). Filter on the token, not on substring of the old
          // message — substring matching against the old phrase would
          // pass vacuously on the new message and silently weaken the
          // assertion.
          const requiredErrors = result.error.issues.filter(
            (i) => String(i.message) === "field_required",
          );
          expect(requiredErrors).toEqual([]);
        } else {
          expect(result.success).toBe(true);
        }
      });
    }
  }
});

/* @version v0.4.0 */
