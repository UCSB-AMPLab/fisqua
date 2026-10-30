/**
 * Tests — ISO date-time formatter
 *
 * This suite pins `formatIsoDateTime` — the pure helper that renders a
 * JavaScript epoch-ms timestamp as a deterministic
 * `YYYY-MM-DD HH:MM:SS` string in the time zone it is given, the
 * reader's own. The function is the canonical formatter for the
 * operational histories (import and publish runs, QC cards,
 * resegmentation cards) and, sliced, for the mono day and clock stamps
 * elsewhere, so the format stays locale-independent and
 * copy-paste-friendly.
 *
 * The cases pin the canonical shape, the same instant on three
 * calendars (a timestamp just after UTC midnight is still the previous
 * day in Los Angeles and Bogotá and already the next in Tokyo), the
 * default zone when none is passed, and the null / undefined / NaN
 * contract — every malformed input returns the U+2014 em dash so the
 * UI renders a visible placeholder rather than "Invalid Date" or
 * "NaN". Every expectation names its zone, so the suite passes
 * whatever zone the process running it is in.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { formatIsoDateTime } from "../../app/lib/format-date";

// 2026-10-26T04:46:08.454Z
const NEAR_MIDNIGHT = 1792989968454;

describe("formatIsoDateTime", () => {
  it("renders a known timestamp as YYYY-MM-DD HH:MM:SS in the given zone", () => {
    // 2024-04-07 08:00:00 UTC
    expect(formatIsoDateTime(1712476800000, "UTC")).toBe("2024-04-07 08:00:00");
    expect(formatIsoDateTime(1712476800000, "America/Bogota")).toBe(
      "2024-04-07 03:00:00",
    );
  });

  it("renders epoch 0 as 1970-01-01 00:00:00 in UTC", () => {
    expect(formatIsoDateTime(0, "UTC")).toBe("1970-01-01 00:00:00");
  });

  it("puts one instant on the reader's own calendar", () => {
    expect(formatIsoDateTime(NEAR_MIDNIGHT, "America/Los_Angeles")).toBe(
      "2026-10-25 21:46:08",
    );
    expect(formatIsoDateTime(NEAR_MIDNIGHT, "America/Bogota")).toBe(
      "2026-10-25 23:46:08",
    );
    expect(formatIsoDateTime(NEAR_MIDNIGHT, "Asia/Tokyo")).toBe(
      "2026-10-26 13:46:08",
    );
  });

  it("uses America/Los_Angeles when no zone is passed", () => {
    expect(formatIsoDateTime(NEAR_MIDNIGHT)).toBe("2026-10-25 21:46:08");
  });

  it("writes midnight as 00, not 24", () => {
    expect(formatIsoDateTime(Date.UTC(2026, 0, 1, 0, 0, 0), "UTC")).toBe(
      "2026-01-01 00:00:00",
    );
  });

  it("returns an em dash for null", () => {
    expect(formatIsoDateTime(null, "UTC")).toBe("—");
  });

  it("returns an em dash for undefined", () => {
    expect(formatIsoDateTime(undefined, "UTC")).toBe("—");
  });

  it("returns an em dash for NaN timestamps", () => {
    expect(formatIsoDateTime(Number.NaN, "UTC")).toBe("—");
  });

  it("never uses the locale-default slash form", () => {
    const result = formatIsoDateTime(Date.UTC(2026, 3, 7, 11, 31, 24), "UTC");
    expect(result).toBe("2026-04-07 11:31:24");
    expect(result).not.toContain("/");
    expect(result).not.toContain(",");
  });

  it("uses a space separator, not an ISO-8601 T", () => {
    const result = formatIsoDateTime(Date.UTC(2026, 0, 1, 0, 0, 0), "UTC");
    expect(result).toBe("2026-01-01 00:00:00");
    expect(result).not.toContain("T");
  });
});

/* @version v0.8.0 */
