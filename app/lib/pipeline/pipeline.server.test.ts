/**
 * Tests — Description Workflow Pipeline
 *
 * @version v0.3.0
 */
import { describe, it, expect, vi } from "vitest";

// Mock DB-dependent imports so the module loads without cloudflare bindings
vi.mock("~/db/schema", () => ({
  volumes: {},
  entries: {},
  projects: {},
  users: {},
  projectMembers: {},
}));

import {
  groupVolumesByColumn,
  groupEntriesByColumn,
  PIPELINE_COLUMNS,
  type PipelineItem,
} from "./pipeline.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVolumeItem(
  overrides: Partial<PipelineItem> & { status: string }
): PipelineItem & { status: string } {
  return {
    id: "v1",
    name: "Volume 1",
    assignee: null,
    projectId: "p1",
    projectName: "Project 1",
    updatedAt: Math.floor(Date.now() / 1000) - 86400,
    isSentBack: false,
    type: "volume" as const,
    ...overrides,
  };
}

function makeEntryItem(
  overrides: Partial<PipelineItem> & { descriptionStatus: string }
): PipelineItem & { descriptionStatus: string } {
  return {
    id: "e1",
    name: "Entry 1",
    assignee: null,
    projectId: "p1",
    projectName: "Project 1",
    updatedAt: Math.floor(Date.now() / 1000) - 86400,
    isSentBack: false,
    type: "entry" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PIPELINE_COLUMNS", () => {
  it("defines exactly 7 columns", () => {
    expect(PIPELINE_COLUMNS).toHaveLength(7);
  });
});

describe("groupVolumesByColumn", () => {
  it("places 'unstarted' volumes in column 1 (unstarted)", () => {
    const volumes = [makeVolumeItem({ id: "v1", status: "unstarted" })];
    const result = groupVolumesByColumn(volumes);
    expect(result.unstarted).toHaveLength(1);
    expect(result.unstarted[0].id).toBe("v1");
  });

  it("places 'in_progress' and 'sent_back' volumes in column 2 (segmenting)", () => {
    const volumes = [
      makeVolumeItem({ id: "v1", status: "in_progress" }),
      makeVolumeItem({ id: "v2", status: "sent_back" }),
    ];
    const result = groupVolumesByColumn(volumes);
    expect(result.segmenting).toHaveLength(2);
    expect(result.segmenting.map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("places 'segmented' volumes in column 3 (seg_review)", () => {
    const volumes = [makeVolumeItem({ id: "v1", status: "segmented" })];
    const result = groupVolumesByColumn(volumes);
    expect(result.seg_review).toHaveLength(1);
    expect(result.seg_review[0].id).toBe("v1");
  });

  it("places 'reviewed' and 'approved' volumes in column 4 (ready_to_describe)", () => {
    const volumes = [
      makeVolumeItem({ id: "v1", status: "reviewed" }),
      makeVolumeItem({ id: "v2", status: "approved" }),
    ];
    const result = groupVolumesByColumn(volumes);
    expect(result.ready_to_describe).toHaveLength(2);
    expect(result.ready_to_describe.map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("marks sent-back volumes with isSentBack=true", () => {
    const volumes = [
      makeVolumeItem({ id: "v1", status: "sent_back" }),
      makeVolumeItem({ id: "v2", status: "in_progress" }),
    ];
    const result = groupVolumesByColumn(volumes);
    const sentBack = result.segmenting.find((v) => v.id === "v1");
    const inProgress = result.segmenting.find((v) => v.id === "v2");
    expect(sentBack?.isSentBack).toBe(true);
    expect(inProgress?.isSentBack).toBe(false);
  });
});

describe("groupEntriesByColumn", () => {
  it("places 'assigned', 'in_progress', 'sent_back' entries in column 5 (describing)", () => {
    const entries = [
      makeEntryItem({ id: "e1", descriptionStatus: "assigned" }),
      makeEntryItem({ id: "e2", descriptionStatus: "in_progress" }),
      makeEntryItem({ id: "e3", descriptionStatus: "sent_back" }),
    ];
    const result = groupEntriesByColumn(entries);
    expect(result.describing).toHaveLength(3);
    expect(result.describing.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("places 'described' entries in column 6 (desc_review)", () => {
    const entries = [makeEntryItem({ id: "e1", descriptionStatus: "described" })];
    const result = groupEntriesByColumn(entries);
    expect(result.desc_review).toHaveLength(1);
    expect(result.desc_review[0].id).toBe("e1");
  });

  it("places 'reviewed' and 'approved' entries in column 7 (ready_to_promote)", () => {
    const entries = [
      makeEntryItem({ id: "e1", descriptionStatus: "reviewed" }),
      makeEntryItem({ id: "e2", descriptionStatus: "approved" }),
    ];
    const result = groupEntriesByColumn(entries);
    expect(result.ready_to_promote).toHaveLength(2);
    expect(result.ready_to_promote.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("marks sent-back entries with isSentBack=true", () => {
    const entries = [
      makeEntryItem({ id: "e1", descriptionStatus: "sent_back" }),
      makeEntryItem({ id: "e2", descriptionStatus: "assigned" }),
    ];
    const result = groupEntriesByColumn(entries);
    const sentBack = result.describing.find((e) => e.id === "e1");
    const assigned = result.describing.find((e) => e.id === "e2");
    expect(sentBack?.isSentBack).toBe(true);
    expect(assigned?.isSentBack).toBe(false);
  });
});
