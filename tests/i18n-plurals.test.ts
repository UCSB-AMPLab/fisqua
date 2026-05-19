/**
 * Tests — Spanish pluralisation
 *
 * This suite pins the i18next pluralisation contract on the Spanish
 * locale: every key carrying a `_one` / `_other` variant in the
 * `es/` bundle resolves through `t(key, { count })` to the right
 * variant. Spanish uses a simple two-form plural rule (count===1 vs
 * count!==1), and the cases here pin both forms for representative
 * keys across the namespaces (document_count, comment_count,
 * volume_count, ...).
 *
 * The suite spins up a real i18next instance via `i18next.init` so
 * the test exercises the actual resolution path the app uses at
 * runtime, not a stubbed translator. A regression here usually
 * means a pluralisation suffix was misnamed (e.g. `_plural` instead
 * of `_other`) — i18next then silently falls back to the bare key
 * and the count parameter never substitutes.
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
