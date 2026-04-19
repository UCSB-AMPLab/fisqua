/**
 * Tests for Sidebar Navigation
 *
 * @version v0.3.0
 */

import { describe, it, expect } from "vitest";
import { getSidebarSections, type SidebarUser } from "./sidebar";

function makeUser(overrides: Partial<SidebarUser> = {}): SidebarUser {
  return {
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    hasAnyProjectMembership: false,
    ...overrides,
  };
}

function labels(sections: ReturnType<typeof getSidebarSections>) {
  return sections.map((s) => s.labelKey ?? "<home>");
}

function paths(sections: ReturnType<typeof getSidebarSections>, labelKey: string) {
  const section = sections.find((s) => s.labelKey === labelKey);
  return section ? section.items.map((i) => i.path) : [];
}

describe("getSidebarSections", () => {
  it("superadmin sees all sections including Promote and Publish", () => {
    const sections = getSidebarSections(makeUser({ isSuperAdmin: true }));
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
      "/admin/cataloguing/promote",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/entities",
      "/admin/places",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
  });

  it("archive admin only (isAdmin) sees Home + Collab Cat + Records Management (no Publish), no manage items", () => {
    const sections = getSidebarSections(makeUser({ isAdmin: true }));
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/entities",
      "/admin/places",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
  });

  it("collab admin only sees Home + Collab Cat (with manage items, no Promote)", () => {
    const sections = getSidebarSections(makeUser({ isCollabAdmin: true }));
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([]);
  });

  it("member-only user sees Home + Collab Cat (only My projects)", () => {
    const sections = getSidebarSections(
      makeUser({ hasAnyProjectMembership: true })
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
    ]);
  });

  it("no-access user sees only Home", () => {
    const sections = getSidebarSections(makeUser());
    expect(labels(sections)).toEqual(["<home>"]);
  });

  it("isAdmin + isCollabAdmin sees merged section with manage items", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true, isCollabAdmin: true })
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/entities",
      "/admin/places",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
  });
});
