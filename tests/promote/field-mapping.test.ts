/**
 * Tests — field mapping
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { mapEntryToDescription } from "../../app/lib/promote/field-mapping";
import { RESOURCE_TYPE_MAP } from "../../app/lib/promote/types";
import type { PromotionInput } from "../../app/lib/promote/types";

/** Minimal valid entry with all required fields populated */
function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-001",
    volumeId: "vol-001",
    parentId: null,
    position: 0,
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    type: "item" as const,
    title: "Test Document",
    modifiedBy: null,
    descriptionStatus: "approved" as const,
    assignedDescriber: null,
    assignedDescriptionReviewer: null,
    translatedTitle: null,
    resourceType: "texto" as const,
    dateExpression: null,
    dateStart: null,
    dateEnd: null,
    extent: null,
    scopeContent: null,
    language: null,
    descriptionNotes: null,
    internalNotes: null,
    descriptionLevel: "item",
    promotedDescriptionId: null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

/** Wrap an entry with the required promotion context */
function makePromotionInput(
  entryOverrides: Record<string, unknown> = {},
  contextOverrides: Partial<PromotionInput> = {}
): PromotionInput {
  return {
    entry: makeEntry(entryOverrides) as PromotionInput["entry"],
    volumeReferenceCode: "AHRB-001",
    assignedReferenceCode: "AHRB-001-d001",
    repositoryId: "repo-001",
    parentDescriptionId: "desc-parent-001",
    rootDescriptionId: "desc-root-001",
    parentDepth: 2,
    parentPathCache: "Fonds > Volume",
    userId: "user-001",
    ...contextOverrides,
  };
}

describe("mapEntryToDescription", () => {
  it("maps all 12 entry fields correctly", () => {
    const input = makePromotionInput({
      title: "Carta de Juan",
      translatedTitle: "Letter from Juan",
      resourceType: "texto",
      dateExpression: "1820-03-15",
      dateStart: "1820-03-15",
      dateEnd: "1820-03-16",
      extent: "2 folios",
      scopeContent: "A letter about trade.",
      language: "spa",
      descriptionNotes: "Some notes",
      internalNotes: "Internal remark",
      descriptionLevel: "file",
    });

    const result = mapEntryToDescription(input);

    expect(result.description.title).toBe("Carta de Juan");
    expect(result.description.translatedTitle).toBe("Letter from Juan");
    expect(result.description.resourceType).toBe("text");
    expect(result.description.dateExpression).toBe("1820-03-15");
    expect(result.description.dateStart).toBe("1820-03-15");
    expect(result.description.dateEnd).toBe("1820-03-16");
    expect(result.description.extent).toBe("2 folios");
    expect(result.description.scopeContent).toBe("A letter about trade.");
    expect(result.description.language).toBe("spa");
    expect(result.description.notes).toBe("Some notes");
    expect(result.description.internalNotes).toBe("Internal remark");
    expect(result.description.descriptionLevel).toBe("item");
  });

  it("translates resourceType 'texto' to 'text'", () => {
    const input = makePromotionInput({ resourceType: "texto" });
    const result = mapEntryToDescription(input);
    expect(result.description.resourceType).toBe("text");
  });

  it("translates resourceType 'imagen' to 'still_image'", () => {
    const input = makePromotionInput({ resourceType: "imagen" });
    const result = mapEntryToDescription(input);
    expect(result.description.resourceType).toBe("still_image");
  });

  it("translates resourceType 'cartografico' to 'cartographic'", () => {
    const input = makePromotionInput({ resourceType: "cartografico" });
    const result = mapEntryToDescription(input);
    expect(result.description.resourceType).toBe("cartographic");
  });

  it("translates resourceType 'mixto' to 'mixed'", () => {
    const input = makePromotionInput({ resourceType: "mixto" });
    const result = mapEntryToDescription(input);
    expect(result.description.resourceType).toBe("mixed");
  });

  it("handles null resourceType by passing through as undefined", () => {
    const input = makePromotionInput({ resourceType: null });
    const result = mapEntryToDescription(input);
    expect(result.description.resourceType).toBeUndefined();
  });

  it("sets descriptionLevel to 'item' regardless of entry value", () => {
    const input = makePromotionInput({ descriptionLevel: "file" });
    const result = mapEntryToDescription(input);
    expect(result.description.descriptionLevel).toBe("item");
  });

  it("sets isPublished to false", () => {
    const input = makePromotionInput();
    const result = mapEntryToDescription(input);
    expect(result.description.isPublished).toBe(false);
  });

  it("sets hasDigital to true", () => {
    const input = makePromotionInput();
    const result = mapEntryToDescription(input);
    expect(result.description.hasDigital).toBe(true);
  });

  it("populates manifestSpec with entry page coordinates", () => {
    const input = makePromotionInput({
      startPage: 5,
      startY: 0.3,
      endPage: 7,
      endY: 0.8,
    });
    const result = mapEntryToDescription(input);
    expect(result.manifestSpec).toEqual({
      referenceCode: "AHRB-001-d001",
      title: "Test Document",
      startPage: 5,
      startY: 0.3,
      endPage: 7,
      endY: 0.8,
    });
  });

  it("uses 'Untitled' for null entry title", () => {
    const input = makePromotionInput({ title: null });
    const result = mapEntryToDescription(input);
    expect(result.description.title).toBe("Untitled");
    expect(result.manifestSpec.title).toBe("Untitled");
  });

  it("maps descriptionNotes to notes field", () => {
    const input = makePromotionInput({ descriptionNotes: "Field notes" });
    const result = mapEntryToDescription(input);
    expect(result.description.notes).toBe("Field notes");
  });

  it("leaves all non-mapped ISAD(G) fields as undefined", () => {
    const input = makePromotionInput();
    const result = mapEntryToDescription(input);
    // These ISAD(G) fields should not be populated by the mapping
    expect(result.description.uniformTitle).toBeUndefined();
    expect(result.description.dateCertainty).toBeUndefined();
    expect(result.description.dimensions).toBeUndefined();
    expect(result.description.medium).toBeUndefined();
    expect(result.description.imprint).toBeUndefined();
    expect(result.description.provenance).toBeUndefined();
    expect(result.description.arrangement).toBeUndefined();
    expect(result.description.accessConditions).toBeUndefined();
    expect(result.description.reproductionConditions).toBeUndefined();
    expect(result.description.locationOfOriginals).toBeUndefined();
    expect(result.description.locationOfCopies).toBeUndefined();
    expect(result.description.relatedMaterials).toBeUndefined();
    expect(result.description.findingAids).toBeUndefined();
  });
});

describe("RESOURCE_TYPE_MAP", () => {
  it("maps all 4 Spanish-English resource type pairs", () => {
    expect(RESOURCE_TYPE_MAP).toEqual({
      texto: "text",
      imagen: "still_image",
      cartografico: "cartographic",
      mixto: "mixed",
    });
  });
});
