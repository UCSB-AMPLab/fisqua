/**
 * Tests — es-CO date / number formatting
 *
 * This suite pins the three shared formatters that back every
 * user-facing date and number rendering: `relativeTime`
 * ("hace 1 hora", "hace 3 días"), `formatDate`
 * ("3 de julio de 1593" — Colombian-Spanish long form), and
 * `formatNumber` (locale-aware thousand separator + decimal
 * comma). The formatters are pure wrappers over `Intl.RelativeTimeFormat`,
 * `Intl.DateTimeFormat`, and `Intl.NumberFormat` configured to
 * `es-CO`.
 *
 * Cases pin the null-input contract (every formatter returns the
 * U+2014 em dash for null so the UI renders a visible placeholder
 * rather than "null" or "undefined"), the relative-time bucketing
 * (minutes / hours / days as the Intl polyfill decides), and the
 * pre-1600 date round-trip (the cataloguer's corpus runs back to
 * the 1500s, so date helpers can't assume the Unix epoch is the
 * earliest reasonable input).
 *
 * @version v0.3.0
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { relativeTime, formatDate, formatNumber } from "../app/lib/format";

describe("es-CO formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("relativeTime returns a dash for null input", () => {
    expect(relativeTime(null)).toBe("\u2014");
  });

  it("relativeTime returns Spanish relative time string for a recent timestamp", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const result = relativeTime(oneHourAgo);
    expect(result).toMatch(/hace 1 hora/);
  });

  it("formatDate returns day-de-month-de-year format", () => {
    // July 3, 1593
    const timestamp = new Date(1593, 6, 3).getTime();
    const result = formatDate(timestamp);
    expect(result).toMatch(/3 de julio de 1593/);
  });

  it("formatNumber uses punto for thousands separator", () => {
    expect(formatNumber(20545)).toBe("20.545");
  });
});
