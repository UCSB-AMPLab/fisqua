/**
 * Tests — typeahead term matching
 *
 * This suite pins the rule that a typeahead's term id is submitted only
 * while the visible text still names the selected term, and that the
 * comparison is trimmed and case-insensitive.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { submittedTermId, termTextMatches } from "../../app/lib/typeahead-term";

describe("termTextMatches", () => {
  it("ignores case and surrounding whitespace", () => {
    expect(termTextMatches("  alcalde ", "Alcalde")).toBe(true);
  });
  it("is false for different text or missing values", () => {
    expect(termTextMatches("Alcalde mayor", "Alcalde")).toBe(false);
    expect(termTextMatches(null, "Alcalde")).toBe(false);
  });
});

describe("submittedTermId", () => {
  const selected = { id: "t1", text: "Alcalde" };
  it("keeps the id while the text names the selected term", () => {
    expect(submittedTermId("Alcalde", selected)).toBe("t1");
    expect(submittedTermId("alcalde ", selected)).toBe("t1");
  });
  it("clears the id once the text differs", () => {
    expect(submittedTermId("Alcalde mayor", selected)).toBe("");
    expect(submittedTermId("Alcald", selected)).toBe("");
    expect(submittedTermId("", selected)).toBe("");
  });
  it("is empty when nothing is selected", () => {
    expect(submittedTermId("Alcalde", null)).toBe("");
    expect(submittedTermId("Alcalde", { id: "", text: "Alcalde" })).toBe("");
  });
});

// @version v0.9.0
