/**
 * Tests — publish route
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { requireSuperAdmin } from "../../app/lib/superadmin.server";

/**
 * Recreate the PublishRequestSchema from api.publish.tsx — the original
 * is module-scoped and built dynamically from DB-derived fonds list,
 * so we rebuild it with a sample list to validate the same constraints.
 */
const VALID_TYPES = [
  "descriptions",
  "repositories",
  "entities",
  "places",
] as const;

// Simulates the DB-derived fonds list that the route fetches at runtime
const SAMPLE_FONDS = ["co-ahr-gob", "co-ahr-not", "pe-bn-man"];

const PublishRequestSchema = z.object({
  selectedFonds: z
    .array(
      z.string().refine((val) => SAMPLE_FONDS.includes(val), {
        message: "Invalid fonds code",
      })
    )
    .nonempty("selectedFonds must contain at least one fonds code"),
  selectedTypes: z
    .array(z.enum(VALID_TYPES))
    .nonempty("selectedTypes must contain at least one type"),
});

describe("requireSuperAdmin", () => {
  it("throws redirect for non-superadmin user", () => {
    const user = { id: "u1", isSuperAdmin: false, isAdmin: true };
    expect(() => requireSuperAdmin(user)).toThrow();
  });

  it("does not throw for superadmin user", () => {
    const user = { id: "u2", isSuperAdmin: true, isAdmin: true };
    expect(() => requireSuperAdmin(user)).not.toThrow();
  });
});

describe("PublishRequestSchema", () => {
  it("accepts valid input with known fonds and types", () => {
    const input = {
      selectedFonds: ["co-ahr-gob"],
      selectedTypes: ["descriptions"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts all sample fonds and all types", () => {
    const input = {
      selectedFonds: [...SAMPLE_FONDS],
      selectedTypes: [...VALID_TYPES],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects invalid fonds code", () => {
    const input = {
      selectedFonds: ["invalid-fonds"],
      selectedTypes: ["descriptions"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects empty selectedFonds array", () => {
    const input = {
      selectedFonds: [],
      selectedTypes: ["descriptions"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects empty selectedTypes array", () => {
    const input = {
      selectedFonds: ["co-ahr-gob"],
      selectedTypes: [],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects invalid type", () => {
    const input = {
      selectedFonds: ["co-ahr-gob"],
      selectedTypes: ["invalid-type"],
    };
    const result = PublishRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
