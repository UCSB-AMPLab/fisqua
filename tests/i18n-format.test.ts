/**
 * Tests — locale-aware date / number formatting
 *
 * This suite pins the three shared formatters that back every
 * user-facing date and number rendering: `relativeTime`
 * ("hace 1 hora" / "1 hour ago"), `formatDate` ("3 de julio de 1593" /
 * "July 3, 1593"), and `formatNumber` (locale-appropriate thousands
 * grouping). All three are pure wrappers over
 * `Intl.RelativeTimeFormat`, `Intl.DateTimeFormat`, and
 * `Intl.NumberFormat`, and each takes the active UI language as a
 * required argument.
 *
 * The contract under test is that the language argument — not a
 * module-level constant — decides the output. An earlier revision of
 * this suite asserted Spanish output unconditionally, which encoded
 * "always Colombian Spanish, for every user" as the intended
 * behaviour and made the English half of a bilingual app untestable.
 * Every assertion below is therefore run against both languages: the
 * same timestamp and the same number, formatted twice, must differ in
 * exactly the ways the two locales differ.
 *
 * Cases also pin the null-input contract (`relativeTime` returns the
 * U+2014 em dash for null in either language so the UI renders a
 * visible placeholder rather than "null" or "undefined"), the
 * relative-time bucketing (minutes / hours / days as the Intl
 * implementation decides), the language-narrowing helper that maps a
 * raw i18next language string onto the app's two-value union, and the
 * pre-1600 date round-trip (the cataloguer's corpus runs back to the
 * 1500s, so date helpers can't assume the Unix epoch is the earliest
 * reasonable input).
 *
 * @version v0.7.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  relativeTime,
  formatDate,
  formatNumber,
  toLanguage,
} from "../app/lib/format";

describe("locale-aware formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("relativeTime", () => {
    it("returns a dash for null input in either language", () => {
      expect(relativeTime(null, "es")).toBe("—");
      expect(relativeTime(null, "en")).toBe("—");
    });

    it("buckets an hour-old timestamp to hours in both languages", () => {
      vi.useFakeTimers();
      const oneHourAgo = Date.now() - 3600000;
      expect(relativeTime(oneHourAgo, "es")).toMatch(/hace 1 hora/);
      expect(relativeTime(oneHourAgo, "en")).toMatch(/1 hour ago/);
    });

    it("buckets a minutes-old timestamp to minutes in both languages", () => {
      vi.useFakeTimers();
      const fiveMinutesAgo = Date.now() - 5 * 60000;
      expect(relativeTime(fiveMinutesAgo, "es")).toMatch(/hace 5 minutos/);
      expect(relativeTime(fiveMinutesAgo, "en")).toMatch(/5 minutes ago/);
    });

    it("buckets a days-old timestamp to days in both languages", () => {
      vi.useFakeTimers();
      const threeDaysAgo = Date.now() - 3 * 86400000;
      expect(relativeTime(threeDaysAgo, "es")).toMatch(/hace 3 días/);
      expect(relativeTime(threeDaysAgo, "en")).toMatch(/3 days ago/);
    });

    it("collapses a just-now timestamp to the second bucket", () => {
      vi.useFakeTimers();
      const now = Date.now();
      expect(relativeTime(now - 500, "es")).toMatch(/ahora/);
      expect(relativeTime(now - 500, "en")).toMatch(/now/);
    });
  });

  describe("formatDate", () => {
    it("renders the same pre-1600 timestamp in each language's long form", () => {
      // July 3, 1593 — well before the Unix epoch, and inside the
      // period the catalogued corpus actually covers.
      const timestamp = new Date(1593, 6, 3).getTime();
      expect(formatDate(timestamp, "es")).toMatch(/3 de julio de 1593/);
      expect(formatDate(timestamp, "en")).toMatch(/July 3, 1593/);
    });

    it("produces different output per language for the same timestamp", () => {
      const timestamp = new Date(2026, 7, 12).getTime();
      expect(formatDate(timestamp, "es")).not.toBe(
        formatDate(timestamp, "en"),
      );
      expect(formatDate(timestamp, "es")).toMatch(/12 de agosto de 2026/);
      expect(formatDate(timestamp, "en")).toMatch(/August 12, 2026/);
    });
  });

  describe("formatNumber", () => {
    it("groups thousands with a period in Spanish and a comma in English", () => {
      expect(formatNumber(20545, "es")).toBe("20.545");
      expect(formatNumber(20545, "en")).toBe("20,545");
    });

    it("groups larger magnitudes consistently in both languages", () => {
      expect(formatNumber(1234567, "es")).toBe("1.234.567");
      expect(formatNumber(1234567, "en")).toBe("1,234,567");
    });
  });

  describe("toLanguage", () => {
    it("narrows region-tagged and bare language strings onto the union", () => {
      expect(toLanguage("en")).toBe("en");
      expect(toLanguage("en-US")).toBe("en");
      expect(toLanguage("en-GB")).toBe("en");
      expect(toLanguage("es")).toBe("es");
      expect(toLanguage("es-CO")).toBe("es");
    });

    it("falls back to Spanish for unknown or absent languages", () => {
      // Mirrors the middleware's `fallbackLanguage: "es"`.
      expect(toLanguage(undefined)).toBe("es");
      expect(toLanguage(null)).toBe("es");
      expect(toLanguage("fr")).toBe("es");
    });
  });
});
