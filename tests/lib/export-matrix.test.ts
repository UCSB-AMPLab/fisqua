/**
 * Tests — export legality matrix
 *
 * Covers `app/lib/export/matrix.ts`, the pure module the export
 * surface's dimming teaches from. What is pinned here is every rule the
 * module's own header states as a promise: the permission tier (PDF for
 * any member, CSV/EAD XML/JSON admin-only), the two encoded formats'
 * need for a descriptive-standard form, the authority scope's closed
 * form axis and closed doors, the ABSENT/dimmed distinction (a role
 * gate hides a tile entirely; the matrix dims one with its reason), and
 * that every dim reason carries the exact machine code the surface maps
 * to a sentence — never English computed here.
 *
 * No database and no fixtures beyond an `ExportMatrixContext` literal:
 * the module takes record class, the workspace's own standard, and
 * `isAdmin` as its only three inputs, so every scenario is built inline.
 *
 * @version v0.7.0
 */
import { describe, it, expect } from "vitest";
import {
  formatRequiresAdmin,
  availableFormats,
  isCombinationLegal,
  assertCombinationLegal,
  ExportCombinationError,
  formTile,
  formatTile,
  doorTile,
} from "../../app/lib/export/matrix";
import type { ExportMatrixContext } from "../../app/lib/export/matrix";

const recordsAdmin: ExportMatrixContext = {
  recordClass: "records",
  ownStandard: "isadg",
  isAdmin: true,
};
const recordsNonAdmin: ExportMatrixContext = {
  recordClass: "records",
  ownStandard: "isadg",
  isAdmin: false,
};
const authorityAdmin: ExportMatrixContext = {
  recordClass: "entities",
  ownStandard: "isadg",
  isAdmin: true,
};
const authorityNonAdmin: ExportMatrixContext = {
  recordClass: "entities",
  ownStandard: "isadg",
  isAdmin: false,
};

describe("the permission tier", () => {
  it("requires admin for csv, ead-xml and json, and not for pdf", () => {
    expect(formatRequiresAdmin("csv")).toBe(true);
    expect(formatRequiresAdmin("ead-xml")).toBe(true);
    expect(formatRequiresAdmin("json")).toBe(true);
    expect(formatRequiresAdmin("pdf")).toBe(false);
  });

  it("leaves a non-admin only the pdf format", () => {
    expect(availableFormats(false)).toEqual(["pdf"]);
    expect(availableFormats(true)).toEqual(["csv", "ead-xml", "json", "pdf"]);
  });
});

describe("records scope, admin", () => {
  it("legalises EAD XML and PDF only under a descriptive-standard form", () => {
    for (const form of ["isadg", "dacs", "rad"] as const) {
      expect(formatTile(recordsAdmin, form, "ead-xml")).toEqual({
        present: true,
        legal: true,
      });
      expect(formatTile(recordsAdmin, form, "pdf")).toEqual({
        present: true,
        legal: true,
      });
    }
  });

  it("renders Dublin Core and canonical as csv and json only, with the exact dim reasons", () => {
    for (const form of ["dc", "canonical"] as const) {
      expect(formatTile(recordsAdmin, form, "csv")).toEqual({
        present: true,
        legal: true,
      });
      expect(formatTile(recordsAdmin, form, "json")).toEqual({
        present: true,
        legal: true,
      });
      expect(formatTile(recordsAdmin, form, "ead-xml")).toEqual({
        present: true,
        legal: false,
        reason: "ead-needs-descriptive-standard",
      });
      expect(formatTile(recordsAdmin, form, "pdf")).toEqual({
        present: true,
        legal: false,
        reason: "pdf-needs-descriptive-standard",
      });
    }
  });
});

describe("authority scope", () => {
  it("closes the descriptive-standard forms with the exact reason", () => {
    for (const form of ["isadg", "dacs", "rad"] as const) {
      expect(formTile(authorityAdmin, form)).toEqual({
        present: true,
        legal: false,
        reason: "descriptive-standard-not-authority",
      });
    }
  });

  it("closes EAD XML and PDF, with the scope's own reasons rather than the form axis's", () => {
    for (const form of ["canonical", "dc"] as const) {
      expect(formatTile(authorityAdmin, form, "ead-xml")).toEqual({
        present: true,
        legal: false,
        reason: "ead-not-authority",
      });
      expect(formatTile(authorityAdmin, form, "pdf")).toEqual({
        present: true,
        legal: false,
        reason: "pdf-needs-descriptive-standard",
      });
    }
  });

  it("legalises canonical and Dublin Core as csv and json", () => {
    for (const form of ["canonical", "dc"] as const) {
      expect(formatTile(authorityAdmin, form, "csv")).toEqual({
        present: true,
        legal: true,
      });
      expect(formatTile(authorityAdmin, form, "json")).toEqual({
        present: true,
        legal: true,
      });
    }
  });

  it("dims the whole-workspace and branch doors, and leaves carried and handlist open", () => {
    expect(doorTile("workspace", "entities")).toEqual({
      present: true,
      legal: false,
      reason: "door-holds-records",
    });
    expect(doorTile("branch", "entities")).toEqual({
      present: true,
      legal: false,
      reason: "door-not-in-hierarchy",
    });
    expect(doorTile("carried", "entities")).toEqual({ present: true, legal: true });
    expect(doorTile("handlist", "entities")).toEqual({ present: true, legal: true });
    // The same four doors stay open under a records scope: only an
    // authority scope closes any of them.
    for (const door of ["workspace", "branch", "carried", "handlist"] as const) {
      expect(doorTile(door, "records")).toEqual({ present: true, legal: true });
    }
  });
});

describe("non-admin role gate", () => {
  it("marks Dublin Core and canonical ABSENT rather than dimmed, under a records scope", () => {
    expect(formTile(recordsNonAdmin, "dc")).toEqual({ present: false });
    expect(formTile(recordsNonAdmin, "canonical")).toEqual({ present: false });
    // The workspace's own descriptive standard stays reachable: a
    // non-admin can still take the pdf finding aid under it.
    expect(formTile(recordsNonAdmin, "isadg")).toEqual({ present: true, legal: true });
  });

  it("leaves an authority scope with no legal combination at all for a non-admin", () => {
    expect(isCombinationLegal(authorityNonAdmin, "canonical", "csv")).toBe(false);
    expect(isCombinationLegal(authorityNonAdmin, "dc", "json")).toBe(false);
    expect(isCombinationLegal(authorityNonAdmin, "canonical", "pdf")).toBe(false);
    expect(isCombinationLegal(authorityNonAdmin, "canonical", "ead-xml")).toBe(false);

    let anyLegal = false;
    for (const form of ["isadg", "dacs", "rad", "dc", "canonical"] as const) {
      for (const format of ["csv", "ead-xml", "json", "pdf"] as const) {
        if (isCombinationLegal(authorityNonAdmin, form, format)) anyLegal = true;
      }
    }
    expect(anyLegal).toBe(false);
  });
});

describe("assertCombinationLegal", () => {
  it("throws ExportCombinationError with format-requires-admin for a non-admin csv attempt", () => {
    const error = (() => {
      try {
        assertCombinationLegal(recordsNonAdmin, "isadg", "csv");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ExportCombinationError);
    expect((error as ExportCombinationError).code).toBe("format-requires-admin");
  });

  it("does not throw for the same pair granted to an admin", () => {
    expect(() => assertCombinationLegal(recordsAdmin, "isadg", "csv")).not.toThrow();
    expect(isCombinationLegal(recordsAdmin, "isadg", "csv")).toBe(true);
  });
});
