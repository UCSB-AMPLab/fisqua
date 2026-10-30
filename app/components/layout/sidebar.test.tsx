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
 * As of the 2026-07-10 module-section ruling Entities and
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
 * The area-admin cases pin the split by area: a records admin sees
 * Records management, an authorities admin Authorities, an imports
 * admin Imports, and none of them another area's section.
 *
 * The digitization capability (migration 0098) gates the
 * `Digitization` section, placed after Authorities and before Import
 * and export. Inside it Volumes is for capture managers (those who pass
 * the digitization area, and federation stewards), and Capture QC and Retakes also for a
 * volume's assigned reviewer; Scanner, last, is for capture managers.
 * The cases near the end pin the gate, the roles, the order, the
 * icons and the five sidebar keys in both locales.
 *
 * @version v0.8.0
 */

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { BookOpen, Camera, ClipboardCheck, Repeat } from "lucide-react";
import en from "../../locales/en/sidebar";
import es from "../../locales/es/sidebar";
import {
  Sidebar,
  SidebarView,
  getSidebarSections,
  readFoldedSections,
  sectionHoldsPath,
  writeFoldedSections,
  type SidebarUser,
  type SidebarTenant,
} from "./sidebar";

/**
 * An i18next instance owned by this file, in English. The Workers pool
 * runs files in one shared runtime, so the global instance may or may
 * not have been initialised (in either language) by an earlier file;
 * rendering under this provider makes the labels independent of that.
 */
const i18n = createInstance();
i18n.init({
  lng: "en",
  fallbackLng: "en",
  ns: ["sidebar"],
  defaultNS: "sidebar",
  resources: { en: { sidebar: en } },
  interpolation: { escapeValue: false },
});

function withI18n(node: ReactElement) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

function makeUser(overrides: Partial<SidebarUser> = {}): SidebarUser {
  return {
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    isRecordsAdmin: false,
    isAuthoritiesAdmin: false,
    isImportsAdmin: false,
    hasAnyProjectMembership: false,
    isCaptureManager: false,
    isCaptureReviewer: false,
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
    digitizationEnabled: false,
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

  it("tenant admin only (isAdmin) sees Home + Collab Cat with manage items + Records Management + Authorities (no Publish, no Promote)", () => {
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

  it("hides /admin/publish but keeps Promote when publish_pipeline is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ publishPipelineEnabled: false }),
    );
    expect(allPaths(sections)).not.toContain("/admin/publish");
    // Records management still has its non-publish entries.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    // Promote is a cataloguing feature: the publish pipeline does not
    // gate it, so the cataloguing section keeps it.
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
      "/admin/cataloguing/promote",
    ]);
  });

  it("hides Promote when crowdsourcing is off, whatever the publish pipeline", () => {
    for (const publishPipelineEnabled of [true, false]) {
      const sections = getSidebarSections(
        makeUser({ isSuperAdmin: true }),
        makeTenant({ crowdsourcingEnabled: false, publishPipelineEnabled }),
      );
      expect(allPaths(sections)).not.toContain("/admin/cataloguing/promote");
    }
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
    // Records management keeps its items and gains Pending decisions,
    // whose vocabulary tab is the only one left to open.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/decisions/vocabulary",
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

describe("getSidebarSections: area admins", () => {
  const tenant = makeTenant({ importsEnabled: true, digitizationEnabled: true });

  it("a records admin sees Records management, with Pending decisions leading to the vocabulary tab, and not Authorities or Imports", () => {
    const sections = getSidebarSections(makeUser({ isRecordsAdmin: true }), tenant);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/decisions/vocabulary",
    ]);
    expect(labels(sections)).not.toContain("sidebar:authorities");
    expect(allPaths(sections)).not.toContain("/admin/imports");
  });

  it("an authorities admin sees Authorities and not Records management or Imports", () => {
    const sections = getSidebarSections(makeUser({ isAuthoritiesAdmin: true }), tenant);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/decisions",
    ]);
    expect(labels(sections)).not.toContain("sidebar:records_management");
    expect(allPaths(sections)).not.toContain("/admin/imports");
  });

  it("an imports admin sees Imports and neither module section", () => {
    const sections = getSidebarSections(makeUser({ isImportsAdmin: true }), tenant);
    expect(paths(sections, "sidebar:import_and_export")).toEqual([
      "/admin/imports",
      "/admin/exports",
    ]);
    expect(labels(sections)).not.toContain("sidebar:records_management");
    expect(labels(sections)).not.toContain("sidebar:authorities");
  });

  it("a records admin without the vocabulary hub gets no Pending decisions entry", () => {
    const sections = getSidebarSections(
      makeUser({ isRecordsAdmin: true }),
      makeTenant({ vocabularyHubEnabled: false }),
    );
    expect(allPaths(sections).filter((p) => p.startsWith("/admin/decisions"))).toEqual([]);
  });

  it("an admin of both areas keeps Pending decisions in Authorities, at /admin/decisions", () => {
    const sections = getSidebarSections(
      makeUser({ isRecordsAdmin: true, isAuthoritiesAdmin: true }),
      tenant,
    );
    expect(allPaths(sections).filter((p) => p.startsWith("/admin/decisions"))).toEqual([
      "/admin/decisions",
    ]);
    expect(paths(sections, "sidebar:authorities")).toContain("/admin/decisions");
  });

  it("a workspace admin on a tenant without authorities finds Pending decisions in Records management", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant({ authoritiesEnabled: false }),
    );
    expect(paths(sections, "sidebar:records_management")).toContain("/admin/decisions/vocabulary");
  });

  it("the Authorities section still needs the authorities capability", () => {
    const sections = getSidebarSections(
      makeUser({ isAuthoritiesAdmin: true }),
      makeTenant({ authoritiesEnabled: false }),
    );
    expect(labels(sections)).not.toContain("sidebar:authorities");
  });

  it("no area flag leaves both module sections and Imports hidden", () => {
    const sections = getSidebarSections(makeUser({ isCataloguer: true }), tenant);
    expect(labels(sections)).not.toContain("sidebar:records_management");
    expect(labels(sections)).not.toContain("sidebar:authorities");
    expect(allPaths(sections)).not.toContain("/admin/imports");
  });
});

describe("getSidebarSections: Digitization", () => {
  const manager = makeUser({ isAdmin: true, isCaptureManager: true });

  it("omits the section when the digitization capability is off, whatever the role", () => {
    for (const user of [manager, makeUser({ isCaptureReviewer: true }), makeUser({ isSuperAdmin: true, isCaptureManager: true })]) {
      const sections = getSidebarSections(user, makeTenant({ digitizationEnabled: false }));
      expect(labels(sections)).not.toContain("sidebar:digitization");
      expect(allPaths(sections).some((p) => p.startsWith("/admin/capture"))).toBe(false);
    }
  });

  it("gives a capture manager Volumes, Capture QC, Retakes and Scanner, in that order, with their icons and keys", () => {
    const sections = getSidebarSections(manager, makeTenant({ digitizationEnabled: true }));
    const section = sections.find((s) => s.labelKey === "sidebar:digitization");
    expect(section?.items.map((i) => [i.path, i.labelKey, i.icon])).toEqual([
      ["/admin/capture/volumes", "sidebar:capture_volumes", BookOpen],
      ["/admin/capture/qc", "sidebar:capture_qc", ClipboardCheck],
      ["/admin/capture/retakes", "sidebar:retakes", Repeat],
      ["/admin/capture/scanner", "sidebar:scanner", Camera],
    ]);
  });

  it("gives an assigned reviewer who manages nothing Capture QC and Retakes", () => {
    const sections = getSidebarSections(makeUser({ isCaptureReviewer: true }), makeTenant({ digitizationEnabled: true }));
    expect(paths(sections, "sidebar:digitization")).toEqual(["/admin/capture/qc", "/admin/capture/retakes"]);
  });

  it("omits the section for someone who neither manages capture work nor reviews a volume", () => {
    for (const user of [makeUser(), makeUser({ isCataloguer: true, hasAnyProjectMembership: true })]) {
      const sections = getSidebarSections(user, makeTenant({ digitizationEnabled: true }));
      expect(labels(sections)).not.toContain("sidebar:digitization");
    }
  });

  it("lists both Retakes and Scanner, now that their screens exist", () => {
    const sections = getSidebarSections(manager, makeTenant({ digitizationEnabled: true }));
    const keys = sections.flatMap((s) => s.items.map((i) => i.labelKey));
    expect(keys).toContain("sidebar:retakes");
    expect(keys).toContain("sidebar:scanner");
  });

  it("puts Digitization after Authorities and before Import and export", () => {
    const sections = getSidebarSections(manager, makeTenant({ digitizationEnabled: true }));
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:digitization",
      "sidebar:import_and_export",
    ]);
  });

  it("carries the section's five keys in both locales", () => {
    expect([en.digitization, en.capture_volumes, en.capture_qc, en.retakes, en.scanner]).toEqual([
      "Digitization",
      "Volumes",
      "Capture QC",
      "Retakes",
      "Scanner",
    ]);
    expect([es.digitization, es.capture_volumes, es.capture_qc, es.retakes, es.scanner]).toEqual([
      "Digitalización",
      "Volúmenes",
      "Revisión de capturas",
      "Capturas por repetir",
      "Escáner",
    ]);
  });
});

describe("Sidebar: scrolling", () => {
  const everything = makeTenant({ importsEnabled: true, digitizationEnabled: true });
  const superAdmin = makeUser({
    isAdmin: true,
    isSuperAdmin: true,
    isUserManager: true,
    isCollabAdmin: true,
    isCaptureManager: true,
  });

  function render(collapsed: boolean) {
    return renderToStaticMarkup(
      withI18n(<MemoryRouter>
        <Sidebar
          user={superAdmin}
          tenant={everything}
          collapsed={collapsed}
          onToggle={() => {}}
        />
      </MemoryRouter>),
    );
  }

  for (const collapsed of [false, true]) {
    const rail = collapsed ? "collapsed" : "expanded";

    it(`scrolls the item column in the ${rail} rail`, () => {
      const html = render(collapsed);
      const column = html.match(/<div[^>]*data-testid="sidebar-items"[^>]*>/);
      expect(column).not.toBeNull();
      expect(column![0]).toContain("min-h-0");
      expect(column![0]).toContain("overflow-y-auto");
    });

    it(`keeps the bottom items after the sections in the ${rail} rail`, () => {
      const html = render(collapsed);
      const scroll = html.indexOf('data-testid="sidebar-items"');
      const lastSection = html.indexOf('href="/admin/exports"');
      const settings = html.indexOf('href="/configuracion"');
      const users = html.indexOf('href="/admin/users"');
      expect(lastSection).toBeGreaterThan(scroll);
      expect(settings).toBeGreaterThan(lastSection);
      expect(users).toBeGreaterThan(settings);
      // Both are inside the scrolling column, before the collapse toggle.
      const toggle = html.lastIndexOf("<button");
      expect(users).toBeLessThan(toggle);
    });
  }

  it("keeps the collapse toggle outside the scrolling column", () => {
    const html = render(false);
    const column = html.indexOf('data-testid="sidebar-items"');
    const toggle = html.lastIndexOf("<button");
    expect(toggle).toBeGreaterThan(column);
    // The column's closing tag comes before the button opens.
    expect(html.slice(column, toggle)).toMatch(/<\/div>$/);
  });
});

describe("Sidebar: folding sections", () => {
  const tenant = makeTenant({ importsEnabled: true, digitizationEnabled: true });
  const admin = makeUser({ isAdmin: true, isSuperAdmin: true, isCaptureManager: true });
  const RECORDS = "sidebar:records_management";

  function view(opts: {
    folded?: string[];
    collapsed?: boolean;
    path?: string;
  }) {
    return renderToStaticMarkup(
      withI18n(<MemoryRouter initialEntries={[opts.path ?? "/"]}>
        <SidebarView
          user={admin}
          tenant={tenant}
          collapsed={opts.collapsed ?? false}
          onToggle={() => {}}
          folded={opts.folded ?? []}
          onToggleSection={() => {}}
        />
      </MemoryRouter>),
    );
  }

  it("shows every item when nothing is folded", () => {
    const html = view({});
    expect(html).toContain('href="/admin/descriptions"');
    expect(html).toContain('href="/admin/entities"');
  });

  it("hides a folded section's items and keeps the others", () => {
    const html = view({ folded: [RECORDS] });
    expect(html).not.toContain('href="/admin/descriptions"');
    expect(html).not.toContain('href="/admin/repositories"');
    expect(html).toContain('href="/admin/entities"');
    expect(html).toContain('href="/configuracion"');
  });

  it("never folds the unlabelled section or the bottom items", () => {
    const html = view({ folded: [RECORDS, "sidebar:authorities", "sidebar:digitization"] });
    expect(html).toContain('href="/handlists"');
    expect(html).toContain('href="/search"');
    expect(html).toContain('href="/configuracion"');
    expect(html).toContain('href="/admin/users"');
  });

  it("gives each labelled heading aria-expanded and aria-controls", () => {
    const html = view({ folded: [RECORDS] });
    const buttons = html.match(/<button[^>]*aria-controls="sidebar-section-[^"]*"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(5);
    const records = buttons.find((b) => b.includes('aria-controls="sidebar-section-sidebar-records_management"'));
    expect(records).toContain('aria-expanded="false"');
    expect(records).toContain('aria-label="Show Records management"');
    expect(html).toContain('id="sidebar-section-sidebar-records_management"');
    const authorities = buttons.find((b) => b.includes("authorities"));
    expect(authorities).toContain('aria-expanded="true"');
    expect(authorities).toContain('aria-label="Hide Authorities"');
  });

  it("forces open the section that holds the current page", () => {
    const html = view({ folded: [RECORDS], path: "/admin/descriptions/42" });
    expect(html).toContain('href="/admin/descriptions"');
    expect(html).toMatch(/aria-expanded="true"[^>]*aria-controls="sidebar-section-sidebar-records_management"/);
  });

  it("matches the home route only exactly", () => {
    const sections = getSidebarSections(admin, tenant);
    const records = sections.find((s) => s.labelKey === RECORDS)!;
    expect(sectionHoldsPath(records, "/")).toBe(false);
    expect(sectionHoldsPath(records, "/admin/descriptionsX")).toBe(false);
    expect(sectionHoldsPath(records, "/admin/descriptions")).toBe(true);
  });

  it("keeps a section open on pages in its route families", () => {
    const cases: Array<[string, string]> = [
      ["sidebar:collaborative_cataloguing", "/projects/abc/overview"],
      ["sidebar:collaborative_cataloguing", "/projects/abc/assignments"],
      ["sidebar:collaborative_cataloguing", "/admin/cataloguing/users"],
      ["sidebar:digitization", "/admin/capture/volumes/v1/decisions"],
      ["sidebar:digitization", "/admin/media/volumes/v1/publish"],
      ["sidebar:import_and_export", "/admin/exports/runs/r1"],
      ["sidebar:import_and_export", "/admin/imports/runs/r1/report"],
    ];
    for (const [key, path] of cases) {
      const html = view({ folded: [key], path });
      const id = `sidebar-section-${key.replace(/\W+/g, "-")}`;
      expect(html, `${key} at ${path}`).toMatch(
        new RegExp(`aria-expanded="true"[^>]*aria-controls="${id}"`),
      );
    }
  });

  it("folds a section on a page outside its families", () => {
    const html = view({ folded: ["sidebar:collaborative_cataloguing"], path: "/handlists" });
    expect(html).toMatch(
      /aria-expanded="false"[^>]*aria-controls="sidebar-section-sidebar-collaborative_cataloguing"/,
    );
  });

  it("shows every item and no section buttons on the collapsed rail", () => {
    const html = view({ collapsed: true, folded: [RECORDS, "sidebar:authorities"] });
    expect(html).toContain('href="/admin/descriptions"');
    expect(html).toContain('href="/admin/entities"');
    expect(html).not.toContain("aria-controls");
  });

  it("renders the connected Sidebar fully open on first render", () => {
    const html = renderToStaticMarkup(
      withI18n(<MemoryRouter>
        <Sidebar user={admin} tenant={tenant} collapsed={false} onToggle={() => {}} />
      </MemoryRouter>),
    );
    expect(html).toContain('href="/admin/descriptions"');
    expect(html).not.toContain('aria-expanded="false"');
  });

  it("reads the stored folds and ignores malformed values", () => {
    const store = (v: string | null) => ({ getItem: () => v });
    expect(readFoldedSections(store(JSON.stringify([RECORDS])))).toEqual([RECORDS]);
    expect(readFoldedSections(store(JSON.stringify([RECORDS, 3, null])))).toEqual([RECORDS]);
    expect(readFoldedSections(store("not json"))).toEqual([]);
    expect(readFoldedSections(store('{"a":1}'))).toEqual([]);
    expect(readFoldedSections(store(null))).toEqual([]);
  });

  it("survives storage that throws", () => {
    const boom = () => {
      throw new Error("denied");
    };
    expect(readFoldedSections({ getItem: boom })).toEqual([]);
    expect(() => writeFoldedSections([RECORDS], { setItem: boom })).not.toThrow();
    // No window.localStorage in this runtime: the default path also falls back.
    expect(readFoldedSections()).toEqual([]);
    expect(() => writeFoldedSections([RECORDS])).not.toThrow();
  });

  it("writes the folds as a JSON array", () => {
    let saved = "";
    writeFoldedSections([RECORDS], { setItem: (_k, v) => void (saved = v) });
    expect(JSON.parse(saved)).toEqual([RECORDS]);
  });
});

// @version v0.8.0
