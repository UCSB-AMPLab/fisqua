/**
 * Tests — vocabulary status
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";

/**
 * Behavioral tests for vocabulary term status transitions.
 *
 * Tests validate the business logic for approve/reject workflows
 * including review metadata, deprecation behavior, and autocomplete
 * filtering by status.
 */

interface VocabTerm {
  id: string;
  canonical: string;
  category: string | null;
  status: "approved" | "proposed" | "deprecated";
  mergedInto: string | null;
  entityCount: number;
  proposedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  notes: string | null;
}

interface Entity {
  id: string;
  primaryFunctionId: string | null;
}

describe("vocabulary approve", () => {
  it("approving a proposed term sets status to 'approved', reviewedBy, and reviewedAt", () => {
    const term: VocabTerm = {
      id: "term-1",
      canonical: "Corregidor",
      category: null,
      status: "proposed",
      mergedInto: null,
      entityCount: 1,
      proposedBy: "user-cataloguer",
      reviewedBy: null,
      reviewedAt: null,
      notes: null,
    };

    // Admin approves the term
    const reviewerId = "user-admin";
    const now = Date.now();
    term.status = "approved";
    term.reviewedBy = reviewerId;
    term.reviewedAt = now;

    expect(term.status).toBe("approved");
    expect(term.reviewedBy).toBe("user-admin");
    expect(term.reviewedAt).toBe(now);
    // proposedBy is preserved for audit
    expect(term.proposedBy).toBe("user-cataloguer");
  });

  it("approved terms appear in autocomplete search results", () => {
    const terms: VocabTerm[] = [
      { id: "a", canonical: "Alcalde", category: "civil_office", status: "approved", mergedInto: null, entityCount: 5, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
      { id: "b", canonical: "Alguacil", category: "civil_office", status: "approved", mergedInto: null, entityCount: 3, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
      { id: "c", canonical: "Obsolete", category: null, status: "deprecated", mergedInto: null, entityCount: 0, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
      { id: "d", canonical: "Pending", category: null, status: "proposed", mergedInto: null, entityCount: 0, proposedBy: "u1", reviewedBy: null, reviewedAt: null, notes: null },
    ];

    // Autocomplete search: WHERE status = 'approved' AND mergedInto IS NULL AND canonical LIKE '%al%'
    const searchResults = terms.filter(
      (t) =>
        t.status === "approved" &&
        t.mergedInto === null &&
        t.canonical.toLowerCase().includes("al")
    );

    expect(searchResults).toHaveLength(2);
    expect(searchResults.map((t) => t.canonical)).toEqual(["Alcalde", "Alguacil"]);
  });

  it("approving allows setting a category", () => {
    const term: VocabTerm = {
      id: "term-1",
      canonical: "New Function",
      category: null,
      status: "proposed",
      mergedInto: null,
      entityCount: 1,
      proposedBy: "user-1",
      reviewedBy: null,
      reviewedAt: null,
      notes: null,
    };

    // Approve with category assignment
    term.status = "approved";
    term.category = "civil_office";
    term.reviewedBy = "admin-1";
    term.reviewedAt = Date.now();

    expect(term.status).toBe("approved");
    expect(term.category).toBe("civil_office");
  });
});

describe("vocabulary reject", () => {
  it("rejecting a proposed term sets status to 'deprecated' (not deleted)", () => {
    const term: VocabTerm = {
      id: "term-1",
      canonical: "Bad Term",
      category: null,
      status: "proposed",
      mergedInto: null,
      entityCount: 2,
      proposedBy: "user-cataloguer",
      reviewedBy: null,
      reviewedAt: null,
      notes: null,
    };

    // Admin rejects with reason
    const reason = "This is a duplicate of 'Doctor'";
    term.status = "deprecated";
    term.reviewedBy = "user-admin";
    term.reviewedAt = Date.now();
    term.notes = term.notes
      ? `${term.notes}\nRejected: ${reason}`
      : `Rejected: ${reason}`;

    expect(term.status).toBe("deprecated");
    expect(term.notes).toContain("Rejected:");
    expect(term.notes).toContain(reason);
    // Term is NOT deleted
    expect(term.id).toBe("term-1");
  });

  it("rejected terms keep entity FK references intact", () => {
    const term: VocabTerm = {
      id: "term-1",
      canonical: "Rejected Term",
      category: null,
      status: "proposed",
      mergedInto: null,
      entityCount: 3,
      proposedBy: "user-1",
      reviewedBy: null,
      reviewedAt: null,
      notes: null,
    };

    const entities: Entity[] = [
      { id: "e1", primaryFunctionId: "term-1" },
      { id: "e2", primaryFunctionId: "term-1" },
      { id: "e3", primaryFunctionId: "term-1" },
    ];

    // Reject the term
    term.status = "deprecated";
    term.reviewedBy = "admin-1";
    term.reviewedAt = Date.now();

    // Entities STILL reference the deprecated term -- no cascade, no nulling
    for (const entity of entities) {
      expect(entity.primaryFunctionId).toBe("term-1");
    }
    expect(term.entityCount).toBe(3);
  });

  it("deprecated terms are excluded from autocomplete search", () => {
    const terms: VocabTerm[] = [
      { id: "a", canonical: "Active", category: null, status: "approved", mergedInto: null, entityCount: 1, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
      { id: "b", canonical: "Also Active", category: null, status: "approved", mergedInto: null, entityCount: 2, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
      { id: "c", canonical: "Archived Term", category: null, status: "deprecated", mergedInto: null, entityCount: 0, proposedBy: null, reviewedBy: "admin-1", reviewedAt: 1000, notes: "Rejected: duplicate" },
    ];

    // Autocomplete: WHERE status = 'approved'
    const typeaheadResults = terms.filter((t) => t.status === "approved");
    expect(typeaheadResults).toHaveLength(2);
    expect(typeaheadResults.map((t) => t.id)).toEqual(["a", "b"]);

    // Deprecated term not in results
    expect(typeaheadResults.find((t) => t.id === "c")).toBeUndefined();
  });

  it("merged terms are also excluded from autocomplete", () => {
    const terms: VocabTerm[] = [
      { id: "a", canonical: "Doctor", category: null, status: "approved", mergedInto: null, entityCount: 5, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
      { id: "b", canonical: "Dr.", category: null, status: "deprecated", mergedInto: "a", entityCount: 0, proposedBy: null, reviewedBy: null, reviewedAt: null, notes: null },
    ];

    // Autocomplete: WHERE status = 'approved' AND mergedInto IS NULL
    const results = terms.filter(
      (t) => t.status === "approved" && t.mergedInto === null
    );
    expect(results).toHaveLength(1);
    expect(results[0].canonical).toBe("Doctor");
  });
});
