/**
 * Tests — i18n plurals
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import i18next from "i18next";
import resources from "../app/locales";

describe("Spanish pluralisation", () => {
  beforeAll(async () => {
    await i18next.init({
      lng: "es",
      resources,
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  });

  it("document_count returns '1 documento' for count=1", () => {
    expect(i18next.t("domain.document_count", { count: 1 })).toBe(
      "1 documento",
    );
  });

  it("document_count returns '3 documentos' for count=3", () => {
    expect(i18next.t("domain.document_count", { count: 3 })).toBe(
      "3 documentos",
    );
  });

  it("document_count returns '0 documentos' for count=0", () => {
    expect(i18next.t("domain.document_count", { count: 0 })).toBe(
      "0 documentos",
    );
  });

  it("volume_count returns '1 unidad compuesta' for count=1", () => {
    expect(i18next.t("domain.volume_count", { count: 1 })).toBe(
      "1 unidad compuesta",
    );
  });

  it("volume_count uses abbreviated form for count > 1", () => {
    expect(i18next.t("domain.volume_count", { count: 5 })).toBe("5 uds.");
  });

  it("days_waiting returns correct one/other forms", () => {
    expect(i18next.t("dashboard:days_waiting", { count: 1 })).toBe(
      "1 día en espera",
    );
    expect(i18next.t("dashboard:days_waiting", { count: 3 })).toBe(
      "3 días en espera",
    );
  });

  it("bulk.selected returns correct one/other forms", () => {
    expect(i18next.t("workflow:bulk.selected", { count: 1 })).toBe(
      "1 unidad compuesta seleccionada",
    );
    expect(i18next.t("workflow:bulk.selected", { count: 3 })).toBe(
      "3 uds. seleccionadas",
    );
  });
});
