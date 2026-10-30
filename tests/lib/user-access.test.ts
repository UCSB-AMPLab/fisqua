/**
 * Tests — area access
 *
 * This suite covers `app/lib/user-access.server.ts`, the module that
 * says who may administer each of a workspace's four areas. It is pure,
 * so every case is built from a user literal:
 *
 *   - every area against every area-admin flag: an area admin passes
 *     their own area and no other;
 *   - a workspace admin and a super admin pass all four;
 *   - a user with no flag passes none, and `requireArea` refuses them
 *     with the bare 403 `requireAdmin` throws;
 *   - `isWorkspaceAdmin` reads `isAdmin` alone;
 *   - the machine-readable export rule per record class: workspace and
 *     super admins, the class's area admin (records for records,
 *     authorities for entities and places) and the imports admin.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import {
  AREA_ADMIN_FLAGS,
  canAdministerArea,
  isWorkspaceAdmin,
  mayExportMachineReadable,
  requireArea,
  type AccessArea,
  type AccessUser,
  type AreaFlag,
} from "../../app/lib/user-access.server";
import { EXPORT_RECORD_CLASSES } from "../../app/lib/export/matrix";

const AREAS: AccessArea[] = ["records", "authorities", "imports", "digitization"];
const FLAGS: AreaFlag[] = [
  "isRecordsAdmin",
  "isAuthoritiesAdmin",
  "isImportsAdmin",
  "isDigitizationAdmin",
];

function user(overrides: Partial<AccessUser> = {}): AccessUser {
  return {
    isAdmin: false,
    isSuperAdmin: false,
    isRecordsAdmin: false,
    isAuthoritiesAdmin: false,
    isImportsAdmin: false,
    isDigitizationAdmin: false,
    ...overrides,
  };
}

function status(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    return (e as Response).status;
  }
}

describe("AREA_ADMIN_FLAGS", () => {
  it("maps each area to its own flag", () => {
    expect(AREA_ADMIN_FLAGS).toEqual({
      records: "isRecordsAdmin",
      authorities: "isAuthoritiesAdmin",
      imports: "isImportsAdmin",
      digitization: "isDigitizationAdmin",
    });
  });
});

describe("canAdministerArea and requireArea", () => {
  for (const flag of FLAGS) {
    for (const area of AREAS) {
      const own = AREA_ADMIN_FLAGS[area] === flag;
      it(`${flag} ${own ? "passes" : "does not pass"} ${area}`, () => {
        const u = user({ [flag]: true });
        expect(canAdministerArea(u, area)).toBe(own);
        expect(status(() => requireArea(u, area))).toBe(own ? null : 403);
      });
    }
  }

  it("a workspace admin passes every area", () => {
    for (const area of AREAS) {
      expect(canAdministerArea(user({ isAdmin: true }), area)).toBe(true);
      expect(status(() => requireArea(user({ isAdmin: true }), area))).toBeNull();
    }
  });

  it("a super admin passes every area", () => {
    for (const area of AREAS) {
      expect(canAdministerArea(user({ isSuperAdmin: true }), area)).toBe(true);
      expect(status(() => requireArea(user({ isSuperAdmin: true }), area))).toBeNull();
    }
  });

  it("a user with no flag passes no area", () => {
    for (const area of AREAS) {
      expect(canAdministerArea(user(), area)).toBe(false);
      expect(status(() => requireArea(user(), area))).toBe(403);
    }
  });
});

describe("isWorkspaceAdmin", () => {
  it("reads isAdmin alone", () => {
    expect(isWorkspaceAdmin(user({ isAdmin: true }))).toBe(true);
    expect(isWorkspaceAdmin(user({ isSuperAdmin: true }))).toBe(false);
    for (const flag of FLAGS) {
      expect(isWorkspaceAdmin(user({ [flag]: true }))).toBe(false);
    }
  });
});

describe("mayExportMachineReadable", () => {
  const expected: Record<string, Record<(typeof EXPORT_RECORD_CLASSES)[number], boolean>> = {
    none: { records: false, entities: false, places: false },
    isAdmin: { records: true, entities: true, places: true },
    isSuperAdmin: { records: true, entities: true, places: true },
    isRecordsAdmin: { records: true, entities: false, places: false },
    isAuthoritiesAdmin: { records: false, entities: true, places: true },
    isImportsAdmin: { records: true, entities: true, places: true },
    isDigitizationAdmin: { records: false, entities: false, places: false },
  };

  for (const [who, byClass] of Object.entries(expected)) {
    for (const recordClass of EXPORT_RECORD_CLASSES) {
      it(`${who} ${byClass[recordClass] ? "may" : "may not"} export ${recordClass}`, () => {
        const u = who === "none" ? user() : user({ [who]: true });
        expect(mayExportMachineReadable(u, recordClass)).toBe(byClass[recordClass]);
      });
    }
  }
});
