/**
 * Tests — ISO date-time formatter
 *
 * This suite pins `formatIsoDateTime` — the pure helper that
 * renders a JavaScript epoch-ms timestamp as a deterministic
 * `YYYY-MM-DD HH:MM:SS` string in UTC. The function is the
 * canonical formatter for every audit-log / timestamp display
 * surface in the app (operator dashboard, audit panel, comment
 * footers, reseg-card subtitles) so the format stays
 * locale-independent and copy-paste-friendly.
 *
 * The cases pin the canonical happy path, the epoch-zero edge,
 * and the null / undefined / NaN contract — every malformed
 * input returns the U+2014 em dash so the UI renders a visible
 * placeholder rather than "Invalid Date" or "NaN".
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { formatIsoDateTime } from "../../app/lib/format-date";

describe("formatIsoDateTime", () => {
  it("renders a known timestamp as YYYY-MM-DD HH:MM:SS in UTC", () => {
    // 2024-04-07 08:00:00 UTC
    expect(formatIsoDateTime(1712476800000)).toBe("2024-04-07 08:00:00");
  });

  it("renders epoch 0 as 1970-01-01 00:00:00", () => {
    expect(formatIsoDateTime(0)).toBe("1970-01-01 00:00:00");
  });

  it("returns an em dash for null", () => {
    expect(formatIsoDateTime(null)).toBe("—");
  });

  it("returns an em dash for undefined", () => {
    expect(formatIsoDateTime(undefined)).toBe("—");
  });

  it("returns an em dash for NaN timestamps", () => {
    expect(formatIsoDateTime(Number.NaN)).toBe("—");
  });

  it("never uses the locale-default slash form", () => {
    const result = formatIsoDateTime(Date.UTC(2026, 3, 7, 11, 31, 24));
    expect(result).toBe("2026-04-07 11:31:24");
    expect(result).not.toContain("/");
    expect(result).not.toContain(",");
  });

  it("uses a space separator, not an ISO-8601 T", () => {
    const result = formatIsoDateTime(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(result).toBe("2026-01-01 00:00:00");
    expect(result).not.toContain("T");
  });
});
