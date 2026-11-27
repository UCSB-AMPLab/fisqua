/**
 * Tests — the version an edit form submits
 *
 * This suite pins the version an edit form submits: the version its field
 * values were loaded at. That version is the loader's when the form's
 * fields are loaded (the form is first shown, or shown again for another
 * record or after leaving edit mode), and the version a successful save of
 * the form returned after that save. A loader revalidation in between
 * (after an autosave, a link change or any other action on the page)
 * leaves it alone, even when another editor's save has moved the stored
 * version, so the form's next save meets the conflict instead of
 * overwriting that save.
 *
 * A write to the record from another fetcher on the page (publishing
 * a description) returns the versions it moved from and to; the form
 * takes the new version only when it holds the one moved from, so such
 * a write never hides another editor's save made before it.
 *
 * Responses can arrive out of order: a toggle that moved the record on
 * from the version a save wrote can arrive before that save's response,
 * and the form still ends at the toggle's version.
 *
 * Edit mode belongs to the record it was opened on: after a navigation
 * to another record on the same route, the page is no longer in edit
 * mode, so the inputs loaded for one record never go out with another
 * record's version.
 *
 * `nextFormVersion` is the pure rule `useFormVersion` applies on each
 * render; it is tested here without rendering.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { nextFormVersion, isEditingRecord } from "../../app/lib/use-form-version";

const ok = (updatedAt: number) => ({ ok: true as const, message: "updated", updatedAt });

describe("nextFormVersion", () => {
  it("starts at the loader's version", () => {
    expect(nextFormVersion(null, "r1:edit", 1000, undefined).version).toBe(1000);
  });

  it("keeps the loaded version when the loader revalidates with another editor's version", () => {
    // Loaded at 1000; an autosave POST revalidates the loader while
    // another editor's save has moved the record to 2000.
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined);
    const afterAutosave = nextFormVersion(loaded, "r1:edit", 2000, undefined);
    expect(afterAutosave.version).toBe(1000);
  });

  it("takes the version a successful save of the form returned", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined);
    const saved = nextFormVersion(loaded, "r1:edit", 1000, ok(3000));
    expect(saved.version).toBe(3000);
    // The revalidation after the save does not move it again.
    expect(nextFormVersion(saved, "r1:edit", 3000, saved.saved).version).toBe(3000);
  });

  it("ignores a save response that carries no version", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined);
    const conflict = { ok: false as const, error: "conflict", modifiedAt: 2000 };
    expect(nextFormVersion(loaded, "r1:edit", 2000, conflict).version).toBe(1000);
  });

  it("takes the loader's version again when the form's fields are loaded again", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined);
    const left = nextFormVersion(loaded, "r1:view", 2000, undefined);
    expect(left.version).toBe(2000);
    const other = nextFormVersion(left, "r2:edit", 5000, undefined);
    expect(other.version).toBe(5000);
  });

  it("returns the same state when nothing changed, so the hook does not re-render", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined);
    expect(nextFormVersion(loaded, "r1:edit", 2000, undefined)).toBe(loaded);
  });
});

describe("nextFormVersion with a write from another fetcher on the page", () => {
  it("takes the version moved to when the form holds the version moved from", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    const moved = nextFormVersion(loaded, "r1:edit", 1500, undefined, { ok: true, from: 1000, to: 1500 });
    expect(moved.version).toBe(1500);
  });

  it("keeps its version when the write moved from another one", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    const moved = nextFormVersion(loaded, "r1:edit", 2500, undefined, { ok: true, from: 2000, to: 2500 });
    expect(moved.version).toBe(1000);
  });

  it("takes each write once", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    const write = { ok: true, from: 1000, to: 1500 };
    const moved = nextFormVersion(loaded, "r1:edit", 1500, undefined, write);
    const saved = nextFormVersion(moved, "r1:edit", 1500, { ok: true, message: "updated", updatedAt: 3000 }, write);
    expect(saved.version).toBe(3000);
    expect(nextFormVersion(saved, "r1:edit", 3000, saved.saved, write).version).toBe(3000);
  });

  it("ignores a write that moved nothing", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    expect(nextFormVersion(loaded, "r1:edit", 1000, undefined, { ok: false }).version).toBe(1000);
  });
});

describe("nextFormVersion with responses out of order", () => {
  it("applies a toggle that moved on from the saved version when the save's response arrives after it", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    // The toggle (1500 -> 2000) answers before the save (1000 -> 1500).
    const toggle = { ok: true, from: 1500, to: 2000 };
    const toggled = nextFormVersion(loaded, "r1:edit", 2000, undefined, toggle);
    expect(toggled.version).toBe(1000);
    const saved = nextFormVersion(toggled, "r1:edit", 2000, { ok: true, message: "updated", updatedAt: 1500 }, toggle);
    expect(saved.version).toBe(2000);
  });

  it("applies two toggles that answered in reverse order", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    const second = { ok: true, from: 1500, to: 2000 };
    const first = { ok: true, from: 1000, to: 1500 };
    const a = nextFormVersion(loaded, "r1:edit", 2000, undefined, second);
    expect(a.version).toBe(1000);
    expect(nextFormVersion(a, "r1:edit", 2000, undefined, first).version).toBe(2000);
  });

  it("does not apply a toggle that moved on from another editor's version", () => {
    const loaded = nextFormVersion(null, "r1:edit", 1000, undefined, undefined);
    const toggle = { ok: true, from: 1700, to: 2000 };
    const toggled = nextFormVersion(loaded, "r1:edit", 2000, undefined, toggle);
    const saved = nextFormVersion(toggled, "r1:edit", 2000, { ok: true, message: "updated", updatedAt: 1500 }, toggle);
    expect(saved.version).toBe(1500);
  });
});

describe("isEditingRecord", () => {
  it("is in edit mode for the record edit mode was opened on", () => {
    expect(isEditingRecord("r1", "r1")).toBe(true);
  });

  it("is not in edit mode after a navigation to another record", () => {
    expect(isEditingRecord("r1", "r2")).toBe(false);
    // So the form's key changes with the record, and its version is
    // the new record's loader version only once its fields are loaded
    // again in a new edit mode.
    const editingA = nextFormVersion(null, `r1:${isEditingRecord("r1", "r1")}`, 1000, undefined, undefined);
    const onB = nextFormVersion(editingA, `r2:${isEditingRecord("r1", "r2")}`, 5000, undefined, undefined);
    expect(onB.key).toBe("r2:false");
  });

  it("is not in edit mode before edit mode is opened", () => {
    expect(isEditingRecord(null, "r1")).toBe(false);
  });
});

// @version v0.9.0
