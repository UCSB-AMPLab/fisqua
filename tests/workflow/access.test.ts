/**
 * Tests — `requireVolumeAccess` role-based gate
 *
 * This suite pins the access-control gate that every volume-scoped
 * route consults before allowing read or write. Three role surfaces
 * get coverage: lead/admin (unrestricted access to any volume in
 * their project), cataloguer (access only to their own assigned
 * volumes and only at appropriate workflow stages), and reviewer
 * (access only to volumes in `segmented` or `reviewed` states).
 *
 * The split matters because the workflow state machine and the access
 * gate together produce the permission matrix — neither alone is
 * sufficient. A cataloguer trying to edit a volume already in review
 * has to be blocked even though the state machine would let them
 * transition it back; conversely, a reviewer can't touch a volume
 * that's still in cataloguing because there's nothing to review yet.
 * Each `it` block backstops one cell of that matrix.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { requireVolumeAccess } from "../../app/lib/permissions.server";

// Helper to create a volume-like object for access checks
function makeVolume(overrides: Partial<{
  assignedTo: string | null;
  assignedReviewer: string | null;
  status: string;
}> = {}) {
  return {
    assignedTo: null as string | null,
    assignedReviewer: null as string | null,
    status: "unstarted" as string,
    ...overrides,
  };
}

describe("requireVolumeAccess", () => {
  const userId = "user-1";
  const otherUserId = "user-2";

  describe("lead/admin access", () => {
    it('returns "edit" for lead', () => {
      const volume = makeVolume();
      expect(requireVolumeAccess(userId, volume, "lead", false)).toBe("edit");
    });

    it('returns "edit" for admin regardless of role', () => {
      const volume = makeVolume();
      expect(requireVolumeAccess(userId, volume, "cataloguer", true)).toBe("edit");
    });

    it('returns "edit" for admin even if not assigned', () => {
      const volume = makeVolume({ assignedTo: otherUserId });
      expect(requireVolumeAccess(userId, volume, "reviewer", true)).toBe("edit");
    });
  });

  describe("cataloguer access", () => {
    it('returns "edit" for assigned cataloguer when status is unstarted', () => {
      const volume = makeVolume({ assignedTo: userId, status: "unstarted" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("edit");
    });

    it('returns "edit" for assigned cataloguer when status is in_progress', () => {
      const volume = makeVolume({ assignedTo: userId, status: "in_progress" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("edit");
    });

    it('returns "edit" for assigned cataloguer when status is sent_back', () => {
      const volume = makeVolume({ assignedTo: userId, status: "sent_back" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("edit");
    });

    it('returns "readonly" for assigned cataloguer when status is segmented', () => {
      const volume = makeVolume({ assignedTo: userId, status: "segmented" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("readonly");
    });

    it('returns "readonly" for assigned cataloguer when status is reviewed', () => {
      const volume = makeVolume({ assignedTo: userId, status: "reviewed" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("readonly");
    });

    it('returns "readonly" for assigned cataloguer when status is approved', () => {
      const volume = makeVolume({ assignedTo: userId, status: "approved" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("readonly");
    });

    it('returns "readonly" for unassigned cataloguer (any status)', () => {
      const statuses = ["unstarted", "in_progress", "segmented", "sent_back", "reviewed", "approved"];
      for (const status of statuses) {
        const volume = makeVolume({ assignedTo: otherUserId, status });
        expect(
          requireVolumeAccess(userId, volume, "cataloguer", false),
          `should be readonly for unassigned cataloguer when status is ${status}`
        ).toBe("readonly");
      }
    });

    it('returns "readonly" when not assigned to anyone', () => {
      const volume = makeVolume({ assignedTo: null, status: "unstarted" });
      expect(requireVolumeAccess(userId, volume, "cataloguer", false)).toBe("readonly");
    });
  });

  describe("reviewer access", () => {
    it('returns "review" for assigned reviewer when status is segmented', () => {
      const volume = makeVolume({ assignedReviewer: userId, status: "segmented" });
      expect(requireVolumeAccess(userId, volume, "reviewer", false)).toBe("review");
    });

    it('returns "review" for assigned reviewer when status is reviewed', () => {
      const volume = makeVolume({ assignedReviewer: userId, status: "reviewed" });
      expect(requireVolumeAccess(userId, volume, "reviewer", false)).toBe("review");
    });

    it('returns "readonly" for assigned reviewer when status is unstarted', () => {
      const volume = makeVolume({ assignedReviewer: userId, status: "unstarted" });
      expect(requireVolumeAccess(userId, volume, "reviewer", false)).toBe("readonly");
    });

    it('returns "readonly" for assigned reviewer when status is in_progress', () => {
      const volume = makeVolume({ assignedReviewer: userId, status: "in_progress" });
      expect(requireVolumeAccess(userId, volume, "reviewer", false)).toBe("readonly");
    });

    it('returns "readonly" for assigned reviewer when status is sent_back', () => {
      const volume = makeVolume({ assignedReviewer: userId, status: "sent_back" });
      expect(requireVolumeAccess(userId, volume, "reviewer", false)).toBe("readonly");
    });

    it('returns "readonly" for assigned reviewer when status is approved', () => {
      const volume = makeVolume({ assignedReviewer: userId, status: "approved" });
      expect(requireVolumeAccess(userId, volume, "reviewer", false)).toBe("readonly");
    });

    it('returns "readonly" for unassigned reviewer', () => {
      const statuses = ["unstarted", "in_progress", "segmented", "sent_back", "reviewed", "approved"];
      for (const status of statuses) {
        const volume = makeVolume({ assignedReviewer: otherUserId, status });
        expect(
          requireVolumeAccess(userId, volume, "reviewer", false),
          `should be readonly for unassigned reviewer when status is ${status}`
        ).toBe("readonly");
      }
    });
  });
});
