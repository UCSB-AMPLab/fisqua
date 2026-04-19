/**
 * Tests — transitions
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  getValidTransitions,
  canTransition,
  type VolumeStatus,
  type WorkflowRole,
} from "../../app/lib/workflow";

describe("workflow state machine", () => {
  describe("cataloguer transitions", () => {
    it("can go unstarted -> in_progress", () => {
      expect(canTransition("unstarted", "in_progress", "cataloguer")).toBe(true);
    });

    it("can go in_progress -> segmented", () => {
      expect(canTransition("in_progress", "segmented", "cataloguer")).toBe(true);
    });

    it("can go sent_back -> in_progress", () => {
      expect(canTransition("sent_back", "in_progress", "cataloguer")).toBe(true);
    });

    it("has exactly 3 valid transitions total", () => {
      const statuses: VolumeStatus[] = [
        "unstarted",
        "in_progress",
        "segmented",
        "sent_back",
        "reviewed",
        "approved",
      ];

      let totalTransitions = 0;
      for (const s of statuses) {
        totalTransitions += getValidTransitions(s, "cataloguer").length;
      }
      expect(totalTransitions).toBe(3);
    });

    it("cannot go unstarted -> segmented", () => {
      expect(canTransition("unstarted", "segmented", "cataloguer")).toBe(false);
    });

    it("cannot go in_progress -> reviewed", () => {
      expect(canTransition("in_progress", "reviewed", "cataloguer")).toBe(false);
    });

    it("cannot go segmented -> anything", () => {
      expect(getValidTransitions("segmented", "cataloguer")).toEqual([]);
    });

    it("cannot go reviewed -> anything", () => {
      expect(getValidTransitions("reviewed", "cataloguer")).toEqual([]);
    });

    it("cannot go approved -> anything", () => {
      expect(getValidTransitions("approved", "cataloguer")).toEqual([]);
    });
  });

  describe("reviewer transitions", () => {
    it("can go segmented -> reviewed", () => {
      expect(canTransition("segmented", "reviewed", "reviewer")).toBe(true);
    });

    it("can go reviewed -> approved", () => {
      expect(canTransition("reviewed", "approved", "reviewer")).toBe(true);
    });

    it("can go reviewed -> sent_back", () => {
      expect(canTransition("reviewed", "sent_back", "reviewer")).toBe(true);
    });

    it("has exactly 3 valid transitions total", () => {
      const statuses: VolumeStatus[] = [
        "unstarted",
        "in_progress",
        "segmented",
        "sent_back",
        "reviewed",
        "approved",
      ];

      let totalTransitions = 0;
      for (const s of statuses) {
        totalTransitions += getValidTransitions(s, "reviewer").length;
      }
      expect(totalTransitions).toBe(3);
    });

    it("cannot go unstarted -> anything", () => {
      expect(getValidTransitions("unstarted", "reviewer")).toEqual([]);
    });

    it("cannot go in_progress -> anything", () => {
      expect(getValidTransitions("in_progress", "reviewer")).toEqual([]);
    });

    it("cannot go sent_back -> anything", () => {
      expect(getValidTransitions("sent_back", "reviewer")).toEqual([]);
    });

    it("cannot go approved -> anything", () => {
      expect(getValidTransitions("approved", "reviewer")).toEqual([]);
    });
  });

  describe("lead transitions", () => {
    it("can transition from any status to any other status", () => {
      const statuses: VolumeStatus[] = [
        "unstarted",
        "in_progress",
        "segmented",
        "sent_back",
        "reviewed",
        "approved",
      ];

      for (const from of statuses) {
        for (const to of statuses) {
          if (from === to) continue; // same status is not a transition
          expect(
            canTransition(from, to, "lead"),
            `lead should be able to go from ${from} to ${to}`
          ).toBe(true);
        }
      }
    });

    it("getValidTransitions returns all other statuses for each status", () => {
      const statuses: VolumeStatus[] = [
        "unstarted",
        "in_progress",
        "segmented",
        "sent_back",
        "reviewed",
        "approved",
      ];

      for (const from of statuses) {
        const valid = getValidTransitions(from, "lead");
        const expected = statuses.filter((s) => s !== from);
        expect(valid.sort()).toEqual(expected.sort());
      }
    });
  });

  describe("getValidTransitions returns correct arrays", () => {
    it("cataloguer unstarted -> [in_progress]", () => {
      expect(getValidTransitions("unstarted", "cataloguer")).toEqual(["in_progress"]);
    });

    it("cataloguer in_progress -> [segmented]", () => {
      expect(getValidTransitions("in_progress", "cataloguer")).toEqual(["segmented"]);
    });

    it("cataloguer sent_back -> [in_progress]", () => {
      expect(getValidTransitions("sent_back", "cataloguer")).toEqual(["in_progress"]);
    });

    it("reviewer segmented -> [reviewed]", () => {
      expect(getValidTransitions("segmented", "reviewer")).toEqual(["reviewed"]);
    });

    it("reviewer reviewed -> [approved, sent_back]", () => {
      expect(getValidTransitions("reviewed", "reviewer").sort()).toEqual(
        ["approved", "sent_back"].sort()
      );
    });
  });

  describe("canTransition returns boolean correctly", () => {
    it("returns true for valid transition", () => {
      expect(canTransition("unstarted", "in_progress", "cataloguer")).toBe(true);
    });

    it("returns false for invalid transition", () => {
      expect(canTransition("unstarted", "approved", "cataloguer")).toBe(false);
    });

    it("returns false for same-status transition", () => {
      expect(canTransition("unstarted", "unstarted", "cataloguer")).toBe(false);
    });
  });
});
