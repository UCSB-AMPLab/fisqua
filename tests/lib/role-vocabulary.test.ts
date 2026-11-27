/**
 * Tests — the relationship-role constants
 *
 * This suite is the structural backstop for the relationship-role constants.
 * It pins two contracts so drift fails loudly:
 *
 *  1. ENTITY_ROLES / PLACE_ROLES equal the CANONICAL zasqua-backend role
 *     sets measured directly from `catalog/models.py`
 *     (`DescriptionEntity.Role` = 33 values in 7 groups;
 *     `DescriptionPlace.Role` = 7 values). The expected arrays below are
 *     the canonical lists transcribed from source; adding or removing a
 *     Fisqua enum value without updating this checkpoint fails here,
 *     forcing a deliberate reconciliation against zasqua rather than a
 *     silent change. (The survey doc's "34 entity roles" was a miscount —
 *     the source has 33, identical to Fisqua's set; there is no missing
 *     value to add.)
 *
 *  2. ENTITY_ROLE_GROUPS is a partition of ENTITY_ROLES — every enum
 *     value sits in exactly one of the 7 groups, no duplicates, nothing
 *     extra.
 *
 * The pickers do not read these constants: they take their options from
 * the federation's lists (`tests/lib/role-options.test.ts`).
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  ENTITY_ROLES,
  PLACE_ROLES,
  ENTITY_ROLE_GROUPS,
} from "../../app/lib/validation/enums";

// Canonical zasqua-backend vocabulary, transcribed from
// `catalog/models.py` `DescriptionEntity.Role` (7 groups) and
// `DescriptionPlace.Role`. Sorted comparison decouples the check from
// Fisqua's (schema-pinned) array order while still catching any
// membership drift.
const CANONICAL_ENTITY_ROLES = [
  // 1. Production & mentions
  "creator", "author", "editor", "publisher", "mentioned", "subject", "official",
  // 2. Correspondence
  "sender", "recipient",
  // 3. Notarial attestation
  "scribe", "witness", "notary",
  // 4. Legal proceedings
  "plaintiff", "defendant", "petitioner", "judge", "appellant", "fiador", "apoderado", "victim",
  // 5. Family & inheritance
  "heir", "albacea", "spouse",
  // 6. Transactions
  "grantor", "donor", "seller", "buyer", "mortgagor", "mortgagee", "creditor", "debtor",
  // 7. Visual materials
  "photographer", "artist",
];

const CANONICAL_PLACE_ROLES = [
  "created", "subject", "mentioned", "sent_from", "sent_to", "published", "venue",
];

const EXPECTED_GROUP_KEYS = [
  "production", "correspondence", "notarial",
  "legal", "family", "transactions", "visual",
];

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("role vocabulary matches the canonical zasqua-backend sets", () => {
  it("ENTITY_ROLES has exactly the 33 canonical entity roles", () => {
    expect(ENTITY_ROLES.length).toBe(33);
    expect(CANONICAL_ENTITY_ROLES.length).toBe(33);
    expect(sorted(ENTITY_ROLES)).toEqual(sorted(CANONICAL_ENTITY_ROLES));
  });

  it("PLACE_ROLES has exactly the 7 canonical place roles", () => {
    expect(PLACE_ROLES.length).toBe(7);
    expect(CANONICAL_PLACE_ROLES.length).toBe(7);
    expect(sorted(PLACE_ROLES)).toEqual(sorted(CANONICAL_PLACE_ROLES));
  });

  it("ENTITY_ROLES has no duplicate values", () => {
    expect(new Set(ENTITY_ROLES).size).toBe(ENTITY_ROLES.length);
  });
});

describe("ENTITY_ROLE_GROUPS partitions ENTITY_ROLES", () => {
  it("has the 7 expected groups in order", () => {
    expect(ENTITY_ROLE_GROUPS.map((g) => g.key)).toEqual(EXPECTED_GROUP_KEYS);
  });

  it("every group role is a member of ENTITY_ROLES", () => {
    const enumSet = new Set<string>(ENTITY_ROLES);
    for (const group of ENTITY_ROLE_GROUPS) {
      for (const role of group.roles) {
        expect(enumSet.has(role)).toBe(true);
      }
    }
  });

  it("the union of all groups equals ENTITY_ROLES with no duplicates", () => {
    const flat = ENTITY_ROLE_GROUPS.flatMap((g) => [...g.roles]);
    expect(flat.length).toBe(ENTITY_ROLES.length);
    expect(new Set(flat).size).toBe(flat.length);
    expect(sorted(flat)).toEqual(sorted(ENTITY_ROLES));
  });

  it("every ENTITY_ROLES value sits in exactly one group", () => {
    for (const role of ENTITY_ROLES) {
      const groups = ENTITY_ROLE_GROUPS.filter((g) =>
        (g.roles as readonly string[]).includes(role),
      );
      expect(groups.length).toBe(1);
    }
  });
});

// @version v0.9.0
