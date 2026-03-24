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
