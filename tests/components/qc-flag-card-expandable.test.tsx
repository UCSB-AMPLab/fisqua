/**
 * Tests — qc flag card expandablex
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { shouldForwardResolve } from "../../app/components/qc-flags/qc-flag-card-expandable";

describe("shouldForwardResolve", () => {
  it("returns true for lead + open -- + happy path", () => {
    expect(shouldForwardResolve("lead", "open")).toBe(true);
  });

  it("returns false for lead + resolved -- open-only", () => {
    expect(shouldForwardResolve("lead", "resolved")).toBe(false);
  });

  it("returns false for lead + wontfix -- open-only", () => {
    expect(shouldForwardResolve("lead", "wontfix")).toBe(false);
  });

  it("returns false for cataloguer + open -- lead-only", () => {
    expect(shouldForwardResolve("cataloguer", "open")).toBe(false);
  });

  it("returns false for reviewer + open -- lead-only", () => {
    expect(shouldForwardResolve("reviewer", "open")).toBe(false);
  });

  it("returns false for cataloguer + resolved", () => {
    expect(shouldForwardResolve("cataloguer", "resolved")).toBe(false);
  });

  it("returns false for reviewer + wontfix", () => {
    expect(shouldForwardResolve("reviewer", "wontfix")).toBe(false);
  });
});

