/**
 * Tests — resegmentation cardx
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { formatReporterLine } from "../../app/components/outline/resegmentation-card";

describe("formatReporterLine", () => {
  it("renders reporter name + middle-dot + formatted timestamp using formatIsoDateTime", () => {
    // 2024-05-10T14:00:00Z as epoch ms
    const flag = {
      id: "r-1",
      reporterName: "María López",
      reportedAt: Date.parse("2024-05-10T14:00:00Z"),
      description: "Propuesta de reseg.",
    };
    const line = formatReporterLine(flag);
    expect(line.startsWith("María López ·")).toBe(true);
    // formatIsoDateTime produces a deterministic ISO-style string; we
    // don't hard-pin the exact suffix (the helper owns that format),
    // but we do pin that the output carries the reporter name, the
    // middle-dot separator, and a four-digit year.
    expect(line).toMatch(/María López · /);
    expect(line).toMatch(/\b\d{4}\b/);
  });

  it("accepts an ISO string and parses it before formatting", () => {
    const flag = {
      id: "r-2",
      reporterName: "Juan Cobo",
      reportedAt: "2024-01-15T09:30:00Z",
      description: "x",
    };
    const line = formatReporterLine(flag);
    expect(line.startsWith("Juan Cobo ·")).toBe(true);
    expect(line).toMatch(/\b2024\b/);
  });

  it("uses U+00B7 middle dot as the separator (not a plain ASCII dot)", () => {
    const flag = {
      id: "r-3",
      reporterName: "Ana",
      reportedAt: Date.parse("2024-05-10T14:00:00Z"),
      description: "x",
    };
    // Middle dot is U+00B7. Guard against an accidental swap to a
    // period + space or a bullet point.
    expect(formatReporterLine(flag)).toContain(" · ");
  });
});

