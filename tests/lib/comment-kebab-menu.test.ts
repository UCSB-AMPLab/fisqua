/**
 * Tests — comment kebab menu
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import { getKebabItems } from "../../app/components/comments/comment-kebab-menu";

describe("getKebabItems -- rule enumeration", () => {
  const base = {
    isAuthor: false,
    isLead: false,
    isResolved: false,
    isRoot: true,
    isDeleted: false,
  };

  it("returns [] when the comment is deleted, regardless of other flags", () => {
    expect(
      getKebabItems({
        ...base,
        isAuthor: true,
        isLead: true,
        isDeleted: true,
      }),
    ).toEqual([]);
  });

  it("author on an unresolved root gets edit + delete + resolve", () => {
    const items = getKebabItems({ ...base, isAuthor: true });
    expect(items.map((i) => i.action)).toEqual([
      "edit",
      "delete",
      "resolve",
    ]);
    expect(items.find((i) => i.action === "delete")?.destructive).toBe(true);
  });

  it("non-author non-lead on an unresolved root gets resolve only", () => {
    const items = getKebabItems({ ...base });
    expect(items.map((i) => i.action)).toEqual(["resolve"]);
  });

  it("lead on someone else's unresolved root gets delete + resolve", () => {
    const items = getKebabItems({ ...base, isLead: true });
    expect(items.map((i) => i.action)).toEqual(["delete", "resolve"]);
  });

  it("lead on a resolved root gets delete + reopen, NOT resolve", () => {
    const items = getKebabItems({
      ...base,
      isLead: true,
      isResolved: true,
    });
    expect(items.map((i) => i.action)).toEqual(["delete", "reopen"]);
  });

  it("non-lead on a resolved root gets NOTHING resolve-like", () => {
    // Cataloguer looking at a resolved thread they didn't author:
    // no re-open affordance.
    const items = getKebabItems({ ...base, isResolved: true });
    expect(items).toEqual([]);
  });

  it("replies never render resolve or reopen, even for lead", () => {
    const items = getKebabItems({
      ...base,
      isAuthor: true,
      isLead: true,
      isRoot: false,
    });
    expect(items.map((i) => i.action)).toEqual(["edit", "delete"]);
  });

  it("author on own reply gets edit + delete", () => {
    const items = getKebabItems({
      ...base,
      isAuthor: true,
      isRoot: false,
    });
    expect(items.map((i) => i.action)).toEqual(["edit", "delete"]);
  });

  it("reader on someone else's reply gets nothing", () => {
    const items = getKebabItems({ ...base, isRoot: false });
    expect(items).toEqual([]);
  });
});
