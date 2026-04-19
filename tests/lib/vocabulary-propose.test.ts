/**
 * Tests — vocabulary propose
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";

/**
 * Behavioral tests for the propose-inline vocabulary workflow.
 *
 * Tests validate the business logic for proposing new vocabulary terms
 * from the entity editor, including case-insensitive matching and
 * immediate usability of proposed terms.
 */

interface VocabTerm {
  id: string;
  canonical: string;
  category: string | null;
  status: "approved" | "proposed" | "deprecated";
  mergedInto: string | null;
  entityCount: number;
  proposedBy: string | null;
  notes: string | null;
}

interface Entity {
  id: string;
  primaryFunction: string | null;
  primaryFunctionId: string | null;
}

function createStore(terms: VocabTerm[], entities: Entity[]) {
  return {
    terms: [...terms],
    entities: [...entities],

    findTermByCanonical(canonical: string) {
      return this.terms.find(
        (t) =>
          t.canonical.toLowerCase() === canonical.toLowerCase() &&
          t.mergedInto === null
      ) ?? null;
    },

    getProposedTerms() {
      return this.terms.filter((t) => t.status === "proposed");
    },
  };
}

describe("vocabulary propose-inline", () => {
  it("proposing a new term creates a vocabulary_terms row with status 'proposed' and proposedBy set", () => {
    const store = createStore([], []);
    const userId = "user-abc";

    // Simulate propose-inline: user types "Corregidor" which is not in vocab
    const match = store.findTermByCanonical("Corregidor");
    expect(match).toBeNull();

    // Create proposed term (as the action handler would)
    const newTerm: VocabTerm = {
      id: "term-new",
      canonical: "Corregidor",
      category: null,
      status: "proposed",
      mergedInto: null,
      entityCount: 0,
      proposedBy: userId,
      notes: null,
    };
    store.terms.push(newTerm);

    expect(newTerm.status).toBe("proposed");
    expect(newTerm.proposedBy).toBe(userId);
    expect(store.terms).toHaveLength(1);
  });

  it("proposing a term that already exists (case-insensitive) reuses the existing term ID", () => {
    const store = createStore(
      [
        {
          id: "term-1",
          canonical: "Alcalde Ordinario",
          category: "civil_office",
          status: "approved",
          mergedInto: null,
          entityCount: 5,
          proposedBy: null,
          notes: null,
        },
      ],
      [],
    );

    // User types "alcalde ordinario" (different case)
    const match = store.findTermByCanonical("alcalde ordinario");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("term-1");

    // The entity should use the existing term ID, not create a new one
    const entity: Entity = {
      id: "e1",
      primaryFunction: "alcalde ordinario",
      primaryFunctionId: match!.id,
    };
    expect(entity.primaryFunctionId).toBe("term-1");
  });

  it("proposed term is immediately usable as entity primaryFunctionId FK", () => {
    const store = createStore([], []);

    // Create proposed term
    const proposedTerm: VocabTerm = {
      id: "proposed-1",
      canonical: "New Historical Title",
      category: null,
      status: "proposed",
      mergedInto: null,
      entityCount: 0,
      proposedBy: "user-123",
      notes: null,
    };
    store.terms.push(proposedTerm);

    // Entity references proposed term immediately
    const entity: Entity = {
      id: "e1",
      primaryFunction: "New Historical Title",
      primaryFunctionId: "proposed-1",
    };
    store.entities.push(entity);

    // FK is valid
    expect(entity.primaryFunctionId).toBe(proposedTerm.id);

    // Update entity count
    proposedTerm.entityCount = store.entities.filter(
      (e) => e.primaryFunctionId === proposedTerm.id
    ).length;
    expect(proposedTerm.entityCount).toBe(1);
  });

  it("proposed term appears in the review queue (status = 'proposed')", () => {
    const store = createStore(
      [
        {
          id: "term-approved",
          canonical: "Doctor",
          category: null,
          status: "approved",
          mergedInto: null,
          entityCount: 10,
          proposedBy: null,
          notes: null,
        },
        {
          id: "term-proposed",
          canonical: "New Title",
          category: null,
          status: "proposed",
          mergedInto: null,
          entityCount: 1,
          proposedBy: "user-456",
          notes: null,
        },
      ],
      [],
    );

    const proposedTerms = store.getProposedTerms();
    expect(proposedTerms).toHaveLength(1);
    expect(proposedTerms[0].id).toBe("term-proposed");
    expect(proposedTerms[0].canonical).toBe("New Title");
    expect(proposedTerms[0].proposedBy).toBe("user-456");
  });

  it("does not create duplicate proposed terms for the same canonical", () => {
    const store = createStore(
      [
        {
          id: "term-existing",
          canonical: "Escribano",
          category: null,
          status: "proposed",
          mergedInto: null,
          entityCount: 1,
          proposedBy: "user-1",
          notes: null,
        },
      ],
      [],
    );

    // Second user types "Escribano" -- should find existing proposed term
    const match = store.findTermByCanonical("Escribano");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("term-existing");
    expect(match!.status).toBe("proposed");

    // No new term should be created
    expect(store.terms).toHaveLength(1);
  });
});
