/**
 * Tests — the capture QC viewer's rules
 *
 * This suite pins the rules the capture QC viewer works out without
 * React or a database (`app/lib/capture/viewer.ts`):
 *
 *   - the search parameters: `view` and `show` fall back to Spreads and
 *     All, and `opening` names an opening by its manifest sequence;
 *   - the keys: A, R, `[`, `]`, J, K and G, Escape, and Ctrl or Cmd
 *     with Z (and Shift for redo); every shortcut but Escape ignored
 *     while focus is in an input, a select, a textarea or editable
 *     text, every shortcut ignored while a modal is open, and plain
 *     keys ignored with Ctrl, Cmd or Alt held;
 *   - the reject form: a reason is needed, Other needs a note, and an
 *     opening with two images needs the image to retake;
 *   - an opening's entry for the decisions route: none while undecided,
 *     its rotations by capture id and role, a reason and a side only on
 *     a rejection, and two states with different sides told apart; a
 *     pair's rejection recorded without a side held and sent as both,
 *     when rotated and when undo restores it; clearing a decision: the
 *     clearing entry sent only when an opening leaves a decided state,
 *     its held rotations kept when the clear is saved or laid over a
 *     read, and undo back to undecided only while the unit has not
 *     fetched the decision, judged on the state the screen shows; a
 *     fetch dropped when a decision is written again at a later
 *     revision, and kept when a late save is at the read's own revision
 *     or the write is still outstanding, a changed decision included,
 *     so Clear stays off until the replacement is acknowledged;
 *   - the screen matching what the server will hold: a viewer opened
 *     during a save shows the outstanding write over the loader's state,
 *     a saved batch shows as saved unless a newer change is outstanding,
 *     and a refusal's openings leave the undo history, so undo cannot
 *     bring a refused change back;
 *   - one reconciliation rule: the loader's snapshot at its revision,
 *     then saved entries at a later revision only (a newer read wins
 *     over a cached save), then outstanding entries, then rotations held
 *     on openings still undecided; a read older than a revision already
 *     seen is set aside; undo steps survive except on openings a read
 *     changed;
 *   - another reviewer's change: an opening whose server state is no
 *     longer what the reviewer's change was based on is named, so its
 *     change is dropped and the reviewer told;
 *   - a reviewer's own acknowledged save moving the base forward while
 *     newer work remains;
 *   - a spread zoomed past the column kept reachable from its left edge;
 *   - the scroll settling: a callback scheduled before the view changed
 *     (G within 150 ms of a scroll) never runs;
 *   - unsaved work: a change not yet saved, or a rotation held on an
 *     undecided opening, makes leaving for another page ask first;
 *   - the layout: at 100% a pair fills the column and at 200% one page,
 *     pages under 120 pixels lose their controls, the overview packs
 *     several openings to a row, and only the visible openings and two
 *     either side are mounted.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi } from "vitest";
import {
  ACTIONS_MIN_WIDTH,
  advanceBase,
  afterSaved,
  changedOpenings,
  rowAlignment,
  rowWidth,
  conflictedOpenings,
  createSettler,
  reconcile,
  staleRead,
  dropFromHistory,
  overlayEntries,
  blocksNavigation,
  hasUnsavedWork,
  canApply,
  canSubmitReject,
  clampZoom,
  COLUMN_GAP,
  COLUMN_PADDING,
  entryFor,
  filterIds,
  heldRotation,
  indexOfSequence,
  initialState,
  isTypingTarget,
  layoutRows,
  MARGIN_LEFT,
  MARGIN_RIGHT,
  MAX_NOTE_CHARS,
  mountedRange,
  openingBox,
  PAIR_GAP,
  pageWidth,
  parseShow,
  parseView,
  rotationWord,
  shortcutFor,
  showsActions,
  sameState,
  stateFromEntry,
  topOf,
  turnClockwise,
  visibleRange,
  type OpeningState,
  type ViewerOpening,
} from "../../app/lib/capture/viewer";

function opening(id: number, sequence: number, single = false): ViewerOpening {
  return {
    captuaRecordId: id,
    sequence,
    scannerStatus: "in_review",
    images: single
      ? [{ captureId: `cap-${id}`, role: "single", pageKey: `co-test-img_${id}_c1` }]
      : [
          { captureId: `cap-${id}`, role: "left", pageKey: `co-test-img_${id}_c1` },
          { captureId: `cap-${id}`, role: "right", pageKey: `co-test-img_${id}_c2` },
        ],
    decision: null,
    rotations: [],
    earlier: null,
  };
}

const APPROVED = { decision: "approved" as const, reason: null, side: null, note: null, decidedBy: null, decidedAt: null };
const REJECTED = { decision: "rejected" as const, reason: "blur" as const, side: null, note: "Smeared", decidedBy: null, decidedAt: null };

describe("search parameters", () => {
  it("falls back to Spreads and All", () => {
    expect(parseView(null)).toBe("spreads");
    expect(parseView("sheet")).toBe("sheet");
    expect(parseView("pages")).toBe("pages");
    expect(parseView("nonsense")).toBe("spreads");
    expect(parseShow(null)).toBe("all");
    expect(parseShow("rejected")).toBe("rejected");
    expect(parseShow("approved")).toBe("all");
  });

  it("finds an opening by its manifest sequence, or the first", () => {
    const list = [opening(10, 3), opening(11, 5), opening(12, 9)];
    expect(indexOfSequence(list, "5")).toBe(1);
    expect(indexOfSequence(list, "4")).toBe(0);
    expect(indexOfSequence(list, null)).toBe(0);
    expect(indexOfSequence(list, "x")).toBe(0);
    expect(indexOfSequence([], "1")).toBe(-1);
  });
});

describe("keyboard shortcuts", () => {
  const body = { tagName: "BODY" };

  it("maps each key to its action", () => {
    expect(shortcutFor({ key: "a", target: body })).toBe("approve");
    expect(shortcutFor({ key: "A", shiftKey: true, target: body })).toBe("approve");
    expect(shortcutFor({ key: "r", target: body })).toBe("reject");
    expect(shortcutFor({ key: "[", target: body })).toBe("rotate_left");
    expect(shortcutFor({ key: "]", target: body })).toBe("rotate_right");
    expect(shortcutFor({ key: "j", target: body })).toBe("next");
    expect(shortcutFor({ key: "k", target: body })).toBe("previous");
    expect(shortcutFor({ key: "g", target: body })).toBe("sheet");
    expect(shortcutFor({ key: "Escape", target: body })).toBe("close");
    expect(shortcutFor({ key: "z", ctrlKey: true, target: body })).toBe("undo");
    expect(shortcutFor({ key: "z", metaKey: true, target: body })).toBe("undo");
    expect(shortcutFor({ key: "Z", metaKey: true, shiftKey: true, target: body })).toBe("redo");
    expect(shortcutFor({ key: "x", target: body })).toBeNull();
    expect(shortcutFor({ key: "Enter", target: body })).toBeNull();
  });

  it("ignores every shortcut but Escape while focus is in an input, a select or a textarea", () => {
    for (const tagName of ["INPUT", "SELECT", "TEXTAREA", "input", "textarea"]) {
      const target = { tagName };
      expect(isTypingTarget(target)).toBe(true);
      for (const key of ["a", "r", "[", "]", "j", "k", "g"]) expect(shortcutFor({ key, target })).toBeNull();
      expect(shortcutFor({ key: "z", ctrlKey: true, target })).toBeNull();
      expect(shortcutFor({ key: "Escape", target })).toBe("close");
    }
    const editable = { tagName: "DIV", isContentEditable: true };
    expect(shortcutFor({ key: "a", target: editable })).toBeNull();
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("ignores every shortcut, Escape included, while a modal such as the leave dialog is open", () => {
    const button = { tagName: "BUTTON" };
    for (const key of ["a", "r", "[", "]", "j", "k", "g", "Escape"]) {
      expect(shortcutFor({ key, target: button }, { modalOpen: true })).toBeNull();
    }
    expect(shortcutFor({ key: "z", ctrlKey: true, target: button }, { modalOpen: true })).toBeNull();
    expect(shortcutFor({ key: "a", target: button }, { modalOpen: false })).toBe("approve");
  });

  it("ignores plain keys with Ctrl, Cmd or Alt held", () => {
    expect(shortcutFor({ key: "a", ctrlKey: true, target: body })).toBeNull();
    expect(shortcutFor({ key: "r", metaKey: true, target: body })).toBeNull();
    expect(shortcutFor({ key: "j", altKey: true, target: body })).toBeNull();
    expect(shortcutFor({ key: "z", ctrlKey: true, altKey: true, target: body })).toBeNull();
  });
});

describe("the reject form", () => {
  it("needs a reason, and a note for Other", () => {
    expect(canSubmitReject(null, "")).toBe(false);
    expect(canSubmitReject("blur", "")).toBe(true);
    expect(canSubmitReject("other", "")).toBe(false);
    expect(canSubmitReject("other", "   ")).toBe(false);
    expect(canSubmitReject("other", "Torn corner")).toBe(true);
    expect(canSubmitReject("glare", "x".repeat(MAX_NOTE_CHARS + 1))).toBe(false);
  });

  it("needs the image to retake on an opening with two images, and nothing more on one", () => {
    expect(canSubmitReject("blur", "", true, null)).toBe(false);
    expect(canSubmitReject("blur", "", true, "left")).toBe(true);
    expect(canSubmitReject(null, "", true, "both")).toBe(false);
    expect(canSubmitReject("other", "", true, "right")).toBe(false);
    expect(canSubmitReject("blur", "", false, null)).toBe(true);
  });
});

describe("decisions, rotations and undo", () => {
  it("turns a quarter clockwise and names the turn", () => {
    expect([0, 1, 2, 3].map(turnClockwise)).toEqual([1, 2, 3, 0]);
    expect([0, 1, 2, 3].map(rotationWord)).toEqual(["none", "r90", "r180", "r270"]);
  });

  it("sends nothing for an undecided opening, and holds its rotation", () => {
    const o = opening(1, 1);
    const state: OpeningState = { decision: null, turns: { "right:cap-1": 1 } };
    expect(entryFor(o, state)).toBeNull();
    expect(heldRotation(state)).toBe(true);
    expect(heldRotation({ decision: APPROVED, turns: { "right:cap-1": 1 } })).toBe(false);
  });

  it("names each rotated image by capture id and role, and gives a reason only to a rejection", () => {
    const o = opening(1, 1);
    expect(entryFor(o, { decision: APPROVED, turns: { "right:cap-1": 1, "left:cap-1": 0 } })).toEqual({
      captuaRecordId: 1,
      decision: "approved",
      rotations: [{ captureId: "cap-1", role: "right", quarterTurns: 1 }],
    });
    expect(entryFor(opening(1, 1, true), { decision: REJECTED, turns: {} })).toEqual({
      captuaRecordId: 1,
      decision: "rejected",
      reason: "blur",
      note: "Smeared",
      rotations: [],
    });
  });

  it("holds a pair's rejection recorded without a side as both, and sends it so when rotated", () => {
    const legacy = { ...opening(1, 1), decision: { ...REJECTED, decidedBy: "R", decidedAt: 1 } };
    const state = initialState(legacy);
    expect(state.decision?.side).toBe("both");
    expect(entryFor(legacy, { ...state, turns: { "left:cap-1": 1 } })).toEqual({
      captuaRecordId: 1,
      decision: "rejected",
      reason: "blur",
      side: "both",
      note: "Smeared",
      rotations: [{ captureId: "cap-1", role: "left", quarterTurns: 1 }],
    });
    // Sent as held even from a state that still carries no side.
    expect(entryFor(legacy, { decision: REJECTED, turns: {} })?.side).toBe("both");
    // A single image's rejection names no side.
    const single = { ...opening(2, 2, true), decision: REJECTED };
    expect(initialState(single).decision?.side).toBeNull();
    expect(entryFor(single, initialState(single))).not.toHaveProperty("side");
  });

  it("restores a pair's rejection recorded without a side, as both, by undo after an approval", () => {
    const legacy = { ...opening(1, 1), decision: REJECTED };
    const before = initialState(legacy);
    const after: OpeningState = { decision: APPROVED, turns: before.turns };
    const step = [{ captuaRecordId: 1, before, after }];
    expect(canApply(step, "undo")).toBe(true);
    const restored = entryFor(legacy, step[0].before)!;
    expect(restored).toMatchObject({ decision: "rejected", reason: "blur", side: "both" });
    expect(sameState(stateFromEntry(restored), before)).toBe(true);
  });

  it("sends a rejection's side, never an approval's, and tells two states apart by it", () => {
    const o = opening(1, 1);
    const left = { ...REJECTED, side: "left" as const };
    expect(entryFor(o, { decision: left, turns: {} })).toEqual({
      captuaRecordId: 1,
      decision: "rejected",
      reason: "blur",
      side: "left",
      note: "Smeared",
      rotations: [],
    });
    expect(entryFor(o, { decision: { ...APPROVED, side: "left" }, turns: {} })).not.toHaveProperty("side");
    expect(stateFromEntry(entryFor(o, { decision: left, turns: {} })!).decision?.side).toBe("left");
    expect(sameState({ decision: left, turns: {} }, { decision: { ...left, side: "both" }, turns: {} })).toBe(false);
    expect(sameState({ decision: left, turns: {} }, { decision: { ...left }, turns: {} })).toBe(true);
  });

  it("reads an opening's saved rotations and round-trips an entry", () => {
    const o = { ...opening(1, 1), decision: APPROVED, rotations: [{ captureId: "cap-1", role: "left" as const, quarterTurns: 3 }] };
    const state = initialState(o);
    expect(state.turns).toEqual({ "left:cap-1": 3 });
    const entry = entryFor(o, state)!;
    expect(stateFromEntry(entry).turns).toEqual({ "left:cap-1": 3 });
    expect(stateFromEntry(entry).decision?.decision).toBe("approved");
  });

  it("undoes an opening's first decision back to undecided only while the unit has not fetched it", () => {
    const undecided: OpeningState = { decision: null, turns: {} };
    const turned: OpeningState = { decision: null, turns: { "left:cap-1": 1 } };
    const approved: OpeningState = { decision: APPROVED, turns: {} };
    const rejected: OpeningState = { decision: REJECTED, turns: {} };
    const fetched: OpeningState = { decision: { ...APPROVED, sentAt: 5 }, turns: {} };
    expect(canApply([{ captuaRecordId: 1, before: undecided, after: approved }], "undo")).toBe(true);
    expect(canApply([{ captuaRecordId: 1, before: undecided, after: approved }], "redo")).toBe(true);
    expect(canApply([{ captuaRecordId: 1, before: approved, after: rejected }], "undo")).toBe(true);
    expect(canApply([{ captuaRecordId: 1, before: undecided, after: turned }], "undo")).toBe(true);
    // The unit has fetched the decision: it can be changed, never cleared.
    expect(canApply([{ captuaRecordId: 1, before: undecided, after: fetched }], "undo")).toBe(false);
    expect(canApply([{ captuaRecordId: 1, before: rejected, after: fetched }], "undo")).toBe(true);
    // What the screen shows decides: a read may know the unit has fetched it.
    const step = [{ captuaRecordId: 1, before: undecided, after: approved }];
    expect(canApply(step, "undo", new Map([[1, fetched]]))).toBe(false);
    expect(canApply(step, "undo", new Map([[1, approved]]))).toBe(true);
    expect(
      canApply(
        [
          { captuaRecordId: 1, before: approved, after: rejected },
          { captuaRecordId: 2, before: undecided, after: fetched },
        ],
        "undo",
      ),
    ).toBe(false);
  });

  it("drops a fetch on a decision written again, even when the decision is the same", () => {
    // A fetched approval, rejected and saved, then restored by undo and saved again.
    const fetched: OpeningState = { decision: { ...APPROVED, sentAt: 5 }, turns: {} };
    const again = { captuaRecordId: 1, decision: "approved" as const, rotations: [] };
    const { shown, confirmed } = reconcile({
      loaded: new Map([[1, fetched]]),
      loadedRevision: 1,
      saved: [{ entry: again, revision: 3 }],
      outstanding: [],
    });
    expect(shown.get(1)?.decision?.sentAt).toBeNull();
    expect(confirmed.get(1)?.decision?.sentAt).toBeNull();
    expect(afterSaved(new Map([[1, fetched]]), [again], new Set()).get(1)?.decision?.sentAt).toBeNull();
    expect(overlayEntries(new Map([[1, fetched]]), [again]).get(1)?.decision?.decision).toBe("approved");
    // So the opening can be cleared again, by undo too.
    const step = [{ captuaRecordId: 1, before: { decision: null, turns: {} }, after: fetched }];
    expect(canApply(step, "undo", shown)).toBe(true);
    // A save at or before the read's revision leaves the read's fetch alone.
    const old = reconcile({ loaded: new Map([[1, fetched]]), loadedRevision: 3, saved: [{ entry: again, revision: 3 }], outstanding: [] });
    expect(old.shown.get(1)?.decision?.sentAt).toBe(5);
  });

  it("keeps a fetched decision's restriction until its replacement is acknowledged at a later revision", () => {
    // A fetched approval, rejected: the rejection waits in the queue.
    const fetched: OpeningState = { decision: { ...APPROVED, sentAt: 5 }, turns: {} };
    const rejection = { captuaRecordId: 1, decision: "rejected" as const, reason: "blur" as const, rotations: [] };
    const { shown } = reconcile({ loaded: new Map([[1, fetched]]), loadedRevision: 4, saved: [], outstanding: [rejection] });
    expect(shown.get(1)?.decision).toMatchObject({ decision: "rejected", sentAt: 5 });
    // No Clear and no undo to undecided while the server still holds the fetched approval.
    expect(canApply([{ captuaRecordId: 1, before: { decision: null, turns: {} }, after: shown.get(1)! }], "undo", shown)).toBe(false);
    // Acknowledged at a later revision: the rejection is the server's, and unfetched.
    const acked = afterSaved(shown, [rejection], new Set(), { saved: 5, read: 4 });
    expect(acked.get(1)?.decision).toMatchObject({ decision: "rejected", sentAt: null });
    // A clear laid over the waiting rejection carries no fetch.
    expect(overlayEntries(shown, [{ captuaRecordId: 1, decision: null, rotations: [] }]).get(1)?.decision).toBeNull();
  });

  it("keeps the fetch a read shows when a save answered late is at the read's own revision", () => {
    // Save N commits, the unit fetches it, a read at N is installed, then the save's answer arrives.
    const fetched: OpeningState = { decision: { ...APPROVED, sentAt: 5 }, turns: {} };
    const entry = { captuaRecordId: 1, decision: "approved" as const, rotations: [] };
    const read = new Map([[1, fetched]]);
    expect(afterSaved(read, [entry], new Set(), { saved: 4, read: 4, confirmed: read }).get(1)?.decision?.sentAt).toBe(5);
    // A save past the read is a later write the unit has not fetched.
    expect(afterSaved(read, [entry], new Set(), { saved: 5, read: 4, confirmed: read }).get(1)?.decision?.sentAt).toBeNull();
    // A read installed while the save is still out leaves the read's fetch alone.
    const { shown } = reconcile({ loaded: read, loadedRevision: 4, saved: [], outstanding: [entry] });
    expect(shown.get(1)?.decision?.sentAt).toBe(5);
    expect(canApply([{ captuaRecordId: 1, before: { decision: null, turns: {} }, after: fetched }], "undo", shown)).toBe(false);
  });

  it("sends the entry that clears a decision only when an opening leaves a decided state", () => {
    const o = opening(1, 1);
    const turned: OpeningState = { decision: null, turns: { "left:cap-1": 2 } };
    expect(entryFor(o, turned, { decision: REJECTED, turns: {} })).toEqual({ captuaRecordId: 1, decision: null, rotations: [] });
    // A rotation on an undecided opening stays in the browser.
    expect(entryFor(o, turned, { decision: null, turns: {} })).toBeNull();
    expect(entryFor(o, turned)).toBeNull();
    const cleared = stateFromEntry({ captuaRecordId: 1, decision: null, rotations: [] });
    expect(cleared).toEqual({ decision: null, turns: {} });
  });

  it("keeps the rotations held on a cleared opening when its clear is saved or laid over a read", () => {
    const clearing = { captuaRecordId: 1, decision: null, rotations: [] };
    const held: OpeningState = { decision: null, turns: { "left:cap-1": 1 } };
    // The save lands: the rotations stay, held.
    const saved = afterSaved(new Map([[1, held]]), [clearing], new Set());
    expect(saved.get(1)).toEqual(held);
    expect(heldRotation(saved.get(1)!)).toBe(true);
    // A read that still has the decision, with the clear outstanding.
    const { shown, confirmed } = reconcile({
      loaded: new Map([[1, { decision: APPROVED, turns: { "left:cap-1": 1 } }]]),
      loadedRevision: 3,
      saved: [],
      outstanding: [clearing],
      current: new Map([[1, held]]),
    });
    expect(confirmed.get(1)?.decision?.decision).toBe("approved");
    expect(shown.get(1)).toEqual(held);
  });

  it("takes a filter's openings when it is chosen", () => {
    const list = [opening(1, 1), opening(2, 2), opening(3, 3)];
    const states = new Map<number, OpeningState>([
      [1, { decision: APPROVED, turns: {} }],
      [2, { decision: REJECTED, turns: {} }],
      [3, { decision: null, turns: {} }],
    ]);
    expect([...filterIds(list, states, "undecided")]).toEqual([3]);
    expect([...filterIds(list, states, "rejected")]).toEqual([2]);
    expect([...filterIds(list, states, "all")]).toEqual([1, 2, 3]);
  });
});

describe("the screen and the server", () => {
  const approvedA: OpeningState = { decision: APPROVED, turns: {} };

  it("shows a write still on its way when a viewer is opened during a save", () => {
    // The loader read "approved"; the earlier visit's rejection has not landed yet.
    const loaded = new Map<number, OpeningState>([[1, approvedA]]);
    const rejection = { captuaRecordId: 1, decision: "rejected" as const, reason: "glare" as const, rotations: [] };
    const shown = overlayEntries(loaded, [rejection]);
    expect(shown.get(1)!.decision).toMatchObject({ decision: "rejected", reason: "glare" });
    // Once saved it stays rejected, so approving it again is a change and is sent.
    const after = afterSaved(shown, [rejection], new Set());
    expect(after.get(1)!.decision?.decision).toBe("rejected");
    expect(overlayEntries(loaded, []).get(1)).toBe(approvedA);
  });

  it("shows a saved batch as saved, unless a newer change to the opening is outstanding", () => {
    const local = new Map<number, OpeningState>([[1, approvedA]]);
    const rejection = { captuaRecordId: 1, decision: "rejected" as const, reason: "blur" as const, rotations: [] };
    expect(afterSaved(local, [rejection], new Set()).get(1)!.decision?.decision).toBe("rejected");
    expect(afterSaved(local, [rejection], new Set([1])).get(1)).toBe(approvedA);
  });

  it("drops a refused opening's changes from undo and redo", () => {
    const turned1: OpeningState = { decision: APPROVED, turns: { "left:cap-1": 1 } };
    const turned2: OpeningState = { decision: APPROVED, turns: { "left:cap-1": 2 } };
    const undecided: OpeningState = { decision: null, turns: {} };
    const history = {
      undo: [
        [{ captuaRecordId: 1, before: approvedA, after: turned1 }],
        [{ captuaRecordId: 2, before: undecided, after: { decision: REJECTED, turns: {} } }],
        [
          { captuaRecordId: 3, before: undecided, after: approvedA },
          { captuaRecordId: 1, before: turned1, after: turned2 },
        ],
      ],
      redo: [[{ captuaRecordId: 2, before: undecided, after: approvedA }]],
    };
    // The batch with opening 1's first turn and opening 2's rejection was refused.
    const kept = dropFromHistory(history, new Set([1, 2]));
    expect(kept.undo).toEqual([[{ captuaRecordId: 3, before: undecided, after: approvedA }]]);
    expect(kept.redo).toEqual([]);
    expect(kept.undo.flat().some((c) => c.captuaRecordId === 1 || c.captuaRecordId === 2)).toBe(false);
  });
});

describe("reconciling by revision", () => {
  const approved: OpeningState = { decision: APPROVED, turns: {} };
  const undecided: OpeningState = { decision: null, turns: {} };
  const rejectEntry = { captuaRecordId: 1, decision: "rejected" as const, reason: "glare" as const, rotations: [] };

  it("lays a cached save over the loader only when it is newer than the loader's revision", () => {
    const loaded = new Map<number, OpeningState>([[1, approved]]);
    const at = (revision: number | null) =>
      reconcile({ loaded, loadedRevision: 5, saved: [{ entry: rejectEntry, revision }], outstanding: [] });
    expect(at(4).shown.get(1)!.decision?.decision).toBe("approved");
    expect(at(5).shown.get(1)!.decision?.decision).toBe("approved");
    expect(at(null).shown.get(1)!.decision?.decision).toBe("approved");
    expect(at(6).shown.get(1)!.decision?.decision).toBe("rejected");
    expect(at(6).confirmed.get(1)!.decision?.decision).toBe("rejected");
  });

  it("lays outstanding entries over saved ones, and keeps them out of what is confirmed", () => {
    const loaded = new Map<number, OpeningState>([[1, undecided]]);
    const approveEntry = { captuaRecordId: 1, decision: "approved" as const, rotations: [] };
    const r = reconcile({ loaded, loadedRevision: 1, saved: [{ entry: rejectEntry, revision: 2 }], outstanding: [approveEntry] });
    expect(r.shown.get(1)!.decision?.decision).toBe("approved");
    expect(r.confirmed.get(1)!.decision?.decision).toBe("rejected");
  });

  it("keeps a rotation held on an opening still undecided, and drops it once the server decided the opening", () => {
    const held: OpeningState = { decision: null, turns: { "left:cap-1": 1 } };
    const current = new Map<number, OpeningState>([[1, held], [2, held]]);
    const loaded = new Map<number, OpeningState>([[1, undecided], [2, approved]]);
    const { shown, confirmed } = reconcile({ loaded, loadedRevision: 3, saved: [], outstanding: [], current });
    expect(shown.get(1)).toEqual(held);
    expect(shown.get(2)).toEqual(approved);
    expect(confirmed.get(1)).toEqual(undecided);
  });

  it("sets aside a read older than a revision already seen", () => {
    expect(staleRead(2, 3)).toBe(true);
    expect(staleRead(3, 3)).toBe(false);
    expect(staleRead(4, 3)).toBe(false);
    expect(staleRead(0, null)).toBe(false);
  });

  it("keeps undo steps except on openings a read changed", () => {
    const before = new Map<number, OpeningState>([[1, approved], [2, undecided]]);
    const after = new Map<number, OpeningState>([[1, { decision: REJECTED, turns: {} }], [2, undecided]]);
    const changed = changedOpenings(after, before);
    expect([...changed]).toEqual([1]);
    const history = {
      undo: [[{ captuaRecordId: 1, before: undecided, after: approved }], [{ captuaRecordId: 2, before: undecided, after: { decision: null, turns: { "left:cap-2": 1 } } }]],
      redo: [],
    };
    expect(dropFromHistory(history, changed).undo).toEqual([history.undo[1]]);
  });
});

describe("another reviewer's change", () => {
  const approved: OpeningState = { decision: APPROVED, turns: {} };
  const rejected: OpeningState = { decision: REJECTED, turns: {} };
  const undecided: OpeningState = { decision: null, turns: {} };

  it("names the openings whose server state is no longer what the reviewer's change was based on", () => {
    // Opening 1: A rejected it on top of an approval; B changed it meanwhile.
    // Opening 2: A rejected it on top of an approval; nobody else touched it.
    // Opening 3: A holds a rotation on it, undecided; B approved it.
    const base = new Map<number, OpeningState>([[1, approved], [2, approved], [3, undecided]]);
    const fresh = new Map<number, OpeningState>([
      [1, { decision: { ...APPROVED, decidedBy: "B" }, turns: { "left:cap-1": 1 } }],
      [2, { decision: { ...APPROVED, decidedBy: "B", decidedAt: 9 }, turns: {} }],
      [3, approved],
    ]);
    expect([...conflictedOpenings([1, 2, 3], base, fresh)].sort()).toEqual([1, 3]);
    expect([...conflictedOpenings([4], base, fresh)]).toEqual([]);
    expect([...conflictedOpenings([1], base, new Map([[1, rejected]]))]).toEqual([1]);
  });
});

describe("a reviewer's own save", () => {
  it("moves the base forward while newer work remains, so it is not taken for another reviewer's change", () => {
    const undecided: OpeningState = { decision: null, turns: {} };
    const approvedState: OpeningState = { decision: APPROVED, turns: {} };
    // Approve an undecided opening, then rotate it while the approval is out.
    const approval = { captuaRecordId: 1, decision: "approved" as const, rotations: [] };
    const base = new Map<number, OpeningState>([[1, undecided]]);
    // The approval is acknowledged; the rotation is still to send.
    advanceBase(base, approval, true);
    expect(base.get(1)!.decision?.decision).toBe("approved");
    // A later conflict's read holds the approval: no conflict, the rotation stays.
    const fresh = new Map<number, OpeningState>([[1, approvedState]]);
    expect([...conflictedOpenings([1], base, fresh)]).toEqual([]);
    // Without moving the base, it would have looked like another reviewer's change.
    expect([...conflictedOpenings([1], new Map([[1, undecided]]), fresh)]).toEqual([1]);
    // With no work left, the base goes.
    advanceBase(base, approval, false);
    expect(base.has(1)).toBe(false);
  });
});

describe("the scroll settling", () => {
  it("drops a callback scheduled before the view or layout changed", () => {
    vi.useFakeTimers();
    try {
      const settler = createSettler(150);
      const fired: string[] = [];
      settler.schedule(() => fired.push("spreads"));
      vi.advanceTimersByTime(100);
      // G: the view changes within 150 ms, and the change cancels it.
      settler.cancel();
      vi.advanceTimersByTime(200);
      expect(fired).toEqual([]);
      settler.schedule(() => fired.push("later"));
      vi.advanceTimersByTime(150);
      expect(fired).toEqual(["later"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unsaved work", () => {
  const plain: OpeningState = { decision: null, turns: {} };
  const held: OpeningState = { decision: null, turns: { "left:cap-1": 1 } };
  const decidedTurned: OpeningState = { decision: APPROVED, turns: { "left:cap-1": 1 } };

  it("counts a held rotation as unsaved even when the queue has nothing waiting", () => {
    expect(hasUnsavedWork("saved", [plain, decidedTurned])).toBe(false);
    expect(hasUnsavedWork("saved", [plain, held])).toBe(true);
    for (const status of ["unsaved", "saving", "error"] as const) expect(hasUnsavedWork(status, [plain])).toBe(true);
  });

  it("asks before leaving for another page, never for other search parameters", () => {
    const here = { pathname: "/admin/capture/qc/v-1" };
    expect(blocksNavigation(true, here, { pathname: "/admin/capture/qc" })).toBe(true);
    expect(blocksNavigation(true, here, { pathname: "/admin/capture/qc/v-1" })).toBe(false);
    expect(blocksNavigation(false, here, { pathname: "/admin/capture/qc" })).toBe(false);
  });
});

describe("layout and windowing", () => {
  const WIDTH = 960;

  it("fills the column with a pair at 100% and with one page at 200%", () => {
    const avail = WIDTH - COLUMN_PADDING;
    const pw100 = pageWidth(WIDTH, 1);
    expect(MARGIN_LEFT + 2 * pw100 + PAIR_GAP + MARGIN_RIGHT).toBeLessThanOrEqual(avail);
    expect(MARGIN_LEFT + 2 * pw100 + PAIR_GAP + MARGIN_RIGHT).toBeGreaterThan(avail - 3);
    const pw200 = pageWidth(WIDTH, 2);
    expect(MARGIN_LEFT + pw200 + MARGIN_RIGHT).toBeLessThanOrEqual(avail);
    expect(MARGIN_LEFT + pw200 + MARGIN_RIGHT).toBeGreaterThan(avail - 4);
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(3)).toBe(2);
  });

  it("drops the marginal controls below 120 pixels", () => {
    expect(showsActions(ACTIONS_MIN_WIDTH)).toBe(true);
    expect(showsActions(ACTIONS_MIN_WIDTH - 1)).toBe(false);
    expect(showsActions(pageWidth(WIDTH, 0.25))).toBe(false);
    expect(openingBox(opening(1, 1), "spreads", 100).width).toBe(2 * 100 + PAIR_GAP + 16);
  });

  it("puts one spread to a row at 100% and several in the overview", () => {
    const list = Array.from({ length: 12 }, (_, i) => opening(i + 1, i + 1, i === 4));
    const at = (zoom: number) => {
      const pw = pageWidth(WIDTH, zoom);
      return layoutRows(list.map((o) => openingBox(o, "spreads", pw)), WIDTH);
    };
    expect(at(1).rows.every((r) => r.end - r.start === 1 || list[r.start].images.length === 1)).toBe(true);
    expect(at(0.25).rows.length).toBeLessThan(5);
    expect(at(0.25).rows[0].end - at(0.25).rows[0].start).toBeGreaterThan(2);
    // Single pages stack an opening's two images.
    const pw = pageWidth(WIDTH, 1);
    expect(openingBox(opening(1, 1), "pages", pw).height).toBeGreaterThan(2 * openingBox(opening(1, 1), "spreads", pw).height - 40);
  });

  it("keeps a zoomed spread's left edge within reach, and centres what fits", () => {
    const one = (o: ViewerOpening, zoom: number) => {
      const box = openingBox(o, "spreads", pageWidth(WIDTH, zoom));
      return rowWidth([box], { start: 0, end: 1 });
    };
    const spread = opening(1, 1);
    const single = opening(2, 2, true);
    expect(one(spread, 2)).toBeGreaterThan(WIDTH);
    expect(rowAlignment(one(spread, 2), WIDTH)).toBe("start");
    expect(rowAlignment(one(single, 2), WIDTH)).toBe("center");
    expect(rowAlignment(one(spread, 1), WIDTH)).toBe("center");
    const boxes = [openingBox(spread, "spreads", 100), openingBox(single, "spreads", 100)];
    expect(rowWidth(boxes, { start: 0, end: 2 })).toBe(boxes[0].width + COLUMN_GAP + boxes[1].width);
  });

  it("mounts the visible openings and two either side", () => {
    const list = Array.from({ length: 100 }, (_, i) => opening(i + 1, i + 1));
    const pw = pageWidth(WIDTH, 1);
    const layout = layoutRows(list.map((o) => openingBox(o, "spreads", pw)), WIDTH);
    expect(layout.rows).toHaveLength(100);

    const top = topOf(layout, 50);
    const visible = visibleRange(layout, top, 800)!;
    expect(visible.first).toBe(50);
    expect(visible.last).toBe(51);
    expect(mountedRange(visible, 100)).toEqual({ start: 48, end: 54 });

    const start = mountedRange(visibleRange(layout, 0, 800), 100);
    expect(start).toEqual({ start: 0, end: 4 });
    const end = mountedRange(visibleRange(layout, layout.height + 1000, 800), 100);
    expect(end).toEqual({ start: 97, end: 100 });
    expect(mountedRange(null, 0)).toEqual({ start: 0, end: 0 });
  });
});

// @version v0.8.0
