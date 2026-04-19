/**
 * Tests — validation
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";

// These imports require the validation files to exist.
// That is expected -- these are RED tests for Wave 0.
import {
  descriptionSchema,
  createDescriptionSchema,
  updateDescriptionSchema,
  importDescriptionSchema,
} from "../../app/lib/validation/description";
import {
  entitySchema,
} from "../../app/lib/validation/entity";
import {
  placeSchema,
} from "../../app/lib/validation/place";
import {
  repositorySchema,
} from "../../app/lib/validation/repository";
import {
  descriptionEntitySchema,
  descriptionPlaceSchema,
} from "../../app/lib/validation/junctions";
import {
  ENTITY_ROLES,
  PLACE_ROLES,
} from "../../app/lib/validation/enums";

describe("Zod validation schemas", () => {
  describe("descriptionSchema", () => {
    it("validates a complete description object", () => {
      const valid = {
        id: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        descriptionLevel: "fonds",
        referenceCode: "CO-TEST-001",
        localIdentifier: "001",
        title: "Test Fonds",
        isPublished: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const result = descriptionSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("createDescriptionSchema strips id field from output", () => {
      const withId = {
        id: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        descriptionLevel: "fonds",
        referenceCode: "CO-TEST-002",
        localIdentifier: "002",
        title: "Should Strip ID",
      };

      const result = createDescriptionSchema.safeParse(withId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect("id" in result.data).toBe(false);
      }
    });

    it("updateDescriptionSchema allows partial objects but requires id", () => {
      const partial = {
        id: crypto.randomUUID(),
        title: "Updated Title",
      };

      const result = updateDescriptionSchema.safeParse(partial);
      expect(result.success).toBe(true);

      // Without id should fail
      const noId = { title: "No ID" };
      const noIdResult = updateDescriptionSchema.safeParse(noId);
      expect(noIdResult.success).toBe(false);
    });

    it("importDescriptionSchema accepts objects with id (same as base)", () => {
      const withId = {
        id: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        descriptionLevel: "item",
        referenceCode: "CO-TEST-003",
        localIdentifier: "003",
        title: "Imported Item",
        isPublished: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const result = importDescriptionSchema.safeParse(withId);
      expect(result.success).toBe(true);
    });
  });

  describe("entitySchema", () => {
    it("validates entityCode format (ne-xxxxxx with 32-char alphabet)", () => {
      const valid = {
        id: crypto.randomUUID(),
        entityCode: "ne-abc234",
        displayName: "Test Entity",
        sortName: "Entity, Test",
        entityType: "person",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const result = entitySchema.safeParse(valid);
      expect(result.success).toBe(true);

      // Invalid code format
      const invalid = { ...valid, entityCode: "ne-ABCDEF" };
      const invalidResult = entitySchema.safeParse(invalid);
      expect(invalidResult.success).toBe(false);
    });
  });

  describe("placeSchema", () => {
    it("validates placeCode format (nl-xxxxxx with 32-char alphabet)", () => {
      const valid = {
        id: crypto.randomUUID(),
        placeCode: "nl-abc234",
        label: "Tunja",
        displayName: "Tunja, Boyaca",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const result = placeSchema.safeParse(valid);
      expect(result.success).toBe(true);

      // Invalid code format
      const invalid = { ...valid, placeCode: "nl-ABCDEF" };
      const invalidResult = placeSchema.safeParse(invalid);
      expect(invalidResult.success).toBe(false);
    });
  });

  describe("repositorySchema", () => {
    it("validates a complete repository object", () => {
      const valid = {
        id: crypto.randomUUID(),
        code: "ahrb",
        name: "Archivo Historico Regional de Boyaca",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const result = repositorySchema.safeParse(valid);
      expect(result.success).toBe(true);
    });
  });

  describe("junction schemas", () => {
    it("descriptionEntitySchema validates role against ENTITY_ROLES enum", () => {
      const valid = {
        id: crypto.randomUUID(),
        descriptionId: crypto.randomUUID(),
        entityId: crypto.randomUUID(),
        role: "author",
        createdAt: Date.now(),
      };

      const result = descriptionEntitySchema.safeParse(valid);
      expect(result.success).toBe(true);

      // Invalid role
      const invalid = { ...valid, role: "invalid_role" };
      const invalidResult = descriptionEntitySchema.safeParse(invalid);
      expect(invalidResult.success).toBe(false);

      // Verify ENTITY_ROLES contains expected values
      expect(ENTITY_ROLES).toContain("author");
      expect(ENTITY_ROLES).toContain("recipient");
      expect(ENTITY_ROLES).toContain("notary");
    });

    it("descriptionPlaceSchema validates role against PLACE_ROLES enum", () => {
      const valid = {
        id: crypto.randomUUID(),
        descriptionId: crypto.randomUUID(),
        placeId: crypto.randomUUID(),
        role: "created",
        createdAt: Date.now(),
      };

      const result = descriptionPlaceSchema.safeParse(valid);
      expect(result.success).toBe(true);

      // Invalid role
      const invalid = { ...valid, role: "invalid_role" };
      const invalidResult = descriptionPlaceSchema.safeParse(invalid);
      expect(invalidResult.success).toBe(false);

      // Verify PLACE_ROLES contains expected values
      expect(PLACE_ROLES).toContain("created");
      expect(PLACE_ROLES).toContain("sent_from");
    });
  });
});
