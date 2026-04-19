/**
 * Tests — workflow
 *
 * @version v0.3.0
 */
import { describe, test, expect } from "vitest";
import {
  getValidDescriptionTransitions,
  canDescriptionTransition,
  type DescriptionStatus,
} from "../../app/lib/description-workflow";
import type { WorkflowRole } from "../../app/lib/workflow";

describe("Description workflow state machine (DESC-03)", () => {
  describe("cataloguer transitions", () => {
    test("assigned -> in_progress", () => {
      const targets = getValidDescriptionTransitions("assigned", "cataloguer");
      expect(targets).toEqual(["in_progress"]);
    });

    test("in_progress -> described", () => {
      const targets = getValidDescriptionTransitions("in_progress", "cataloguer");
      expect(targets).toEqual(["described"]);
    });

    test("sent_back -> in_progress", () => {
      const targets = getValidDescriptionTransitions("sent_back", "cataloguer");
      expect(targets).toEqual(["in_progress"]);
    });

    test("unassigned returns empty array", () => {
      const targets = getValidDescriptionTransitions("unassigned", "cataloguer");
      expect(targets).toEqual([]);
    });

    test("described returns empty array", () => {
      const targets = getValidDescriptionTransitions("described", "cataloguer");
      expect(targets).toEqual([]);
    });

    test("reviewed returns empty array", () => {
      const targets = getValidDescriptionTransitions("reviewed", "cataloguer");
      expect(targets).toEqual([]);
    });

    test("approved returns empty array", () => {
      const targets = getValidDescriptionTransitions("approved", "cataloguer");
      expect(targets).toEqual([]);
    });
  });

  describe("reviewer transitions", () => {
    test("described -> reviewed or sent_back", () => {
      const targets = getValidDescriptionTransitions("described", "reviewer");
      expect(targets).toEqual(["reviewed", "sent_back"]);
    });

    test("unassigned returns empty array", () => {
      const targets = getValidDescriptionTransitions("unassigned", "reviewer");
      expect(targets).toEqual([]);
    });

    test("assigned returns empty array", () => {
      const targets = getValidDescriptionTransitions("assigned", "reviewer");
      expect(targets).toEqual([]);
    });

    test("in_progress returns empty array", () => {
      const targets = getValidDescriptionTransitions("in_progress", "reviewer");
      expect(targets).toEqual([]);
    });

    test("reviewed returns empty array", () => {
      const targets = getValidDescriptionTransitions("reviewed", "reviewer");
      expect(targets).toEqual([]);
    });

    test("approved returns empty array", () => {
      const targets = getValidDescriptionTransitions("approved", "reviewer");
      expect(targets).toEqual([]);
    });
  });

  describe("lead transitions", () => {
    test("unassigned -> assigned", () => {
      const targets = getValidDescriptionTransitions("unassigned", "lead");
      expect(targets).toContain("assigned");
    });

    test("assigned has multiple targets", () => {
      const targets = getValidDescriptionTransitions("assigned", "lead");
      expect(targets.length).toBeGreaterThan(1);
      expect(targets).toContain("in_progress");
    });

    test("described -> reviewed, approved, or sent_back", () => {
      const targets = getValidDescriptionTransitions("described", "lead");
      expect(targets).toContain("reviewed");
      expect(targets).toContain("approved");
      expect(targets).toContain("sent_back");
    });

    test("reviewed -> approved or sent_back", () => {
      const targets = getValidDescriptionTransitions("reviewed", "lead");
      expect(targets).toContain("approved");
      expect(targets).toContain("sent_back");
    });

    test("approved -> reviewed or described", () => {
      const targets = getValidDescriptionTransitions("approved", "lead");
      expect(targets).toContain("reviewed");
      expect(targets).toContain("described");
    });

    test("sent_back -> in_progress or described", () => {
      const targets = getValidDescriptionTransitions("sent_back", "lead");
      expect(targets).toContain("in_progress");
      expect(targets).toContain("described");
    });
  });

  describe("canDescriptionTransition", () => {
    test("returns true for valid transitions", () => {
      expect(canDescriptionTransition("assigned", "in_progress", "cataloguer")).toBe(true);
      expect(canDescriptionTransition("described", "reviewed", "reviewer")).toBe(true);
      expect(canDescriptionTransition("unassigned", "assigned", "lead")).toBe(true);
    });

    test("returns false for invalid transitions", () => {
      expect(canDescriptionTransition("unassigned", "in_progress", "cataloguer")).toBe(false);
      expect(canDescriptionTransition("assigned", "approved", "cataloguer")).toBe(false);
      expect(canDescriptionTransition("in_progress", "approved", "reviewer")).toBe(false);
    });
  });
});
