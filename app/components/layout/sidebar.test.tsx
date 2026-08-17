/**
 * Tests for Sidebar Navigation
 *
 * This test suite is the capability-aware coverage layered on the existing
 * role-permutation cases. The signature of `getSidebarSections` grows a
 * second parameter — a `SidebarTenant` carrying the five capability-flag
 * booleans — so the sidebar can hide whole nav branches whose capability
 * is off on the requesting tenant. Each existing case here passes a
 * default `makeTenant()` (all five capabilities ON, mirroring
 * Neogranadina).
 *
 * As of the 2026-07-10 module-section ruling (phase 3a) Entities and
 * Places move out of Records management into their own `Authorities`
 * section, gated on `authoritiesEnabled`. The assertions below track
 * that structure: Records management holds descriptions / repositories /
 * vocabularies / publish; Authorities holds entities / places.
 *
 * The `imports` capability (migration 0061) gates the Imports ITEM
 * inside the `Import and export` group (ruled 2026-08-15). The group
 * itself is ungated because its other entry, Exports, is: portability
 * is not a product tier, so the group renders for every signed-in
 * person on every tenant, and the cases near the end pin both halves
 * of that — the capability still hides Imports, and nothing hides
 * Exports.
 *
 * The global-search cases pin one of the two items that live in the
 * first, unlabelled section alongside Home: it appears for admins, in
 * that position, and is absent for every non-admin role permutation.
 * The handlists cases pin the other: it sits directly under Home for
 * everyone, on every tenant, because a handlist belongs to a person
 * rather than to a module and carries no capability or role gate.
 *
 * @version v0.7.0
 */

import { describe, it, expect } from "vitest";
import {
  getSidebarSections,
  type SidebarUser,
  type SidebarTenant,
} from "./sidebar";

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

/**
 * Build a `SidebarTenant` with the historical five capabilities ON
 * and `imports` OFF by default — the Neogranadina shape (imports is
 * opt-in, off platform-wide by migration 0061). Override individual
 * flags to flip a single capability in a test case.
 */
function makeTenant(overrides: Partial<SidebarTenant> = {}): SidebarTenant {
  return {
    crowdsourcingEnabled: true,
    vocabularyHubEnabled: true,
    publishPipelineEnabled: true,
    multiRepositoryEnabled: true,
    authoritiesEnabled: true,
    importsEnabled: false,
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

function allPaths(sections: ReturnType<typeof getSidebarSections>): string[] {
  return sections.flatMap((s) => s.items.map((i) => i.path));
}

describe("getSidebarSections", () => {
  it("superadmin sees all sections including Promote, Publish and Authorities", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:import_and_export",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
      "/admin/cataloguing/promote",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
  });

  it("archive admin only (isAdmin) sees Home + Collab Cat + Records Management + Authorities (no Publish), no manage items", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:import_and_export",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
  });

  it("collab admin only sees Home + Collab Cat (with manage items, no Promote)", () => {
    const sections = getSidebarSections(
      makeUser({ isCollabAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:import_and_export",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([]);
    expect(paths(sections, "sidebar:authorities")).toEqual([]);
  });

  it("member-only user sees Home + Collab Cat (only My projects)", () => {
    const sections = getSidebarSections(
      makeUser({ hasAnyProjectMembership: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:import_and_export",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
    ]);
  });

  it("no-access user sees Home and the ungated Import and export group", () => {
    // Exports carries no capability and no role — portability is not a
    // product tier — so the group renders for every signed-in person,
    // holding Exports alone when imports is off or the person is not
    // an admin.
    const sections = getSidebarSections(makeUser(), makeTenant());
    expect(labels(sections)).toEqual(["<home>", "sidebar:import_and_export"]);
    expect(paths(sections, "sidebar:import_and_export")).toEqual([
      "/admin/exports",
    ]);
  });

  it("isAdmin + isCollabAdmin sees merged section with manage items + Authorities", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true, isCollabAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:import_and_export",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
  });

  // ---------------------------------------------------------------------
  // Capability-off cases
  //
  // For every disabled capability, pair a maximally-capable user
  // (superadmin, all six role flags) with a tenant that has just that
  // one capability turned off, and assert the corresponding nav surface
  // disappears entirely. The other four capabilities stay on so we
  // know the gate is precise — flipping one capability does not
  // collateral-damage another.
  // ---------------------------------------------------------------------

  it("hides Collaborative Cataloguing section when crowdsourcing is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true, isCataloguer: true }),
      makeTenant({ crowdsourcingEnabled: false }),
    );
    // The whole cataloguing branch is hidden. Records management still
    // renders because vocabulary_hub / publish_pipeline / multi_repository
    // remain ON.
    expect(labels(sections)).not.toContain(
      "sidebar:collaborative_cataloguing",
    );
    expect(allPaths(sections)).not.toContain("/proyectos");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/projects");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/team");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/promote");
    // Records management is intact.
    expect(paths(sections, "sidebar:records_management")).toContain(
      "/admin/descriptions",
    );
  });

  it("hides /admin/vocabularies when vocabulary_hub is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ vocabularyHubEnabled: false }),
    );
    expect(allPaths(sections)).not.toContain("/admin/vocabularies");
    // The other records-management entries still render.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/publish",
    ]);
    // Authorities is unaffected.
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
  });

  it("hides /admin/publish and /admin/promote when publish_pipeline is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ publishPipelineEnabled: false }),
    );
    expect(allPaths(sections)).not.toContain("/admin/publish");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/promote");
    // Records management still has its non-publish entries.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    // Collaborative cataloguing keeps its non-promote entries.
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
  });

  it("shows /admin/repositories regardless of the multi_repository flag", () => {
    // The capability gates repository OPERATIONS (create beyond the first,
    // delete of the last), never the surface: a single-repository tenant
    // still reads and edits its one repository.
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ multiRepositoryEnabled: false }),
    );
    expect(allPaths(sections)).toContain("/admin/repositories");
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
  });

  it("attaches the duplicates badge to the Possible duplicates item", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant(),
      { duplicates: 4 },
    );
    const authorities = sections.find(
      (sec) => sec.labelKey === "sidebar:authorities",
    );
    const dup = authorities?.items.find(
      (i) => i.path === "/admin/decisions",
    );
    expect(dup?.badge).toBe(4);
    expect(dup?.labelKey).toBe("sidebar:pending_decisions");
  });

  it("shows the Imports entry only when imports is on", () => {
    const off = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    // Default tenant has imports off — the Import and export group
    // still renders, holding Exports alone.
    expect(allPaths(off)).not.toContain("/admin/imports");
    expect(paths(off, "sidebar:import_and_export")).toEqual(["/admin/exports"]);

    const on = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(labels(on)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:import_and_export",
    ]);
    expect(paths(on, "sidebar:import_and_export")).toEqual([
      "/admin/imports",
      "/admin/exports",
    ]);
  });

  it("hides the Imports entry for a non-admin even when imports is on", () => {
    // Imports keeps its admin gate; Exports does not have one, so the
    // group renders with Exports alone rather than disappearing.
    const sections = getSidebarSections(
      makeUser({ hasAnyProjectMembership: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(allPaths(sections)).not.toContain("/admin/imports");
    expect(paths(sections, "sidebar:import_and_export")).toEqual([
      "/admin/exports",
    ]);
  });

  it("shows Exports on a tenant with every capability off", () => {
    // Ruling 2 (re-ruled 2026-08-15): portability is not a product
    // tier, so no capability flag can take the export surface away.
    const sections = getSidebarSections(
      makeUser(),
      makeTenant({
        crowdsourcingEnabled: false,
        vocabularyHubEnabled: false,
        publishPipelineEnabled: false,
        multiRepositoryEnabled: false,
        authoritiesEnabled: false,
        importsEnabled: false,
      }),
    );
    expect(allPaths(sections)).toContain("/admin/exports");
  });

  it("puts Import and export last, after the module sections", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(labels(sections).at(-1)).toBe("sidebar:import_and_export");
  });

  it("imports capability does not collateral-affect other sections", () => {
    // Turning imports on adds only the Imports section; Records
    // management and Authorities render unchanged.
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
  });

  it("hides the whole Authorities section when authorities is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ authoritiesEnabled: false }),
    );
    expect(labels(sections)).not.toContain("sidebar:authorities");
    expect(allPaths(sections)).not.toContain("/admin/entities");
    expect(allPaths(sections)).not.toContain("/admin/places");
    // Records management is unaffected.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
  });

  // ---------------------------------------------------------------------
  // Global search
  //
  // The item lives in the first, unlabelled section directly after
  // Home and Handlists, and carries no gate (ruled 2026-08-16): search
  // is member-level, and only the authority reach inside the surface
  // keeps the admin gate. The item shows for every role.
  // ---------------------------------------------------------------------

  it("puts Search directly after Home for an archive admin", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant(),
    );
    expect(sections[0].labelKey).toBeUndefined();
    expect(sections[0].items.map((i) => i.path)).toEqual([
      "/",
      "/handlists",
      "/search",
    ]);
    expect(sections[0].items[2].labelKey).toBe("sidebar:search");
  });

  it("puts Search directly after Home for a superadmin", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    expect(sections[0].items.map((i) => i.path)).toEqual([
      "/",
      "/handlists",
      "/search",
    ]);
  });

  it("shows Search to every non-admin role", () => {
    for (const user of [
      makeUser(),
      makeUser({ hasAnyProjectMembership: true }),
      makeUser({ isCollabAdmin: true }),
      makeUser({ isCataloguer: true }),
      makeUser({ isUserManager: true }),
    ]) {
      const sections = getSidebarSections(user, makeTenant());
      expect(sections[0].items.map((i) => i.path)).toEqual([
        "/",
        "/handlists",
        "/search",
      ]);
    }
  });

  it("puts Handlists directly under Home for every role", () => {
    for (const user of [
      makeUser(),
      makeUser({ isAdmin: true }),
      makeUser({ isSuperAdmin: true }),
      makeUser({ isCataloguer: true }),
      makeUser({ isCollabAdmin: true }),
    ]) {
      const sections = getSidebarSections(user, makeTenant());
      expect(sections[0].items[1].path).toBe("/handlists");
      expect(sections[0].items[1].labelKey).toBe("sidebar:handlists");
    }
  });

  it("shows Handlists on a tenant with every capability off", () => {
    // A handlist belongs to no module, so no capability can take it
    // away — the admin gate on an authority-typed one lives on the
    // handlist itself, not on the nav item.
    const sections = getSidebarSections(
      makeUser(),
      makeTenant({
        crowdsourcingEnabled: false,
        vocabularyHubEnabled: false,
        publishPipelineEnabled: false,
        multiRepositoryEnabled: false,
        authoritiesEnabled: false,
        importsEnabled: false,
      }),
    );
    expect(allPaths(sections)).toContain("/handlists");
  });

  it("shows Search regardless of the authorities capability", () => {
    // Records are searchable on every tenant; the authorities
    // categories are what the capability gates, inside the surface.
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant({ authoritiesEnabled: false }),
    );
    expect(allPaths(sections)).toContain("/search");
  });

  it("Neogranadina (all caps on) renders the full section set for a superadmin", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:import_and_export",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
      "/admin/cataloguing/promote",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
  });
});
