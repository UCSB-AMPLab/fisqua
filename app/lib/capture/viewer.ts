/**
 * Capture QC Viewer — Shapes, Layout, Shortcuts and Decisions
 *
 * This module deals with everything the capture QC viewer works out
 * without React or a database: the shape of what its loader returns,
 * how its scrolling column is laid out and windowed, which key does
 * what, and how a reviewer's change becomes what the decisions route
 * takes. It is pure, so the route, its components, the decision queue
 * and the tests share one definition of each rule.
 *
 * The data. `CaptureQcVolume` is what `loadCaptureQcVolume`
 * (`viewer.server.ts`) answers: the volume, its reviewer, its current
 * delivery (posted back as `manifestId`) and that delivery's ordinal
 * among the volume's handovers, the openings in manifest `sequence`
 * order with their images, decisions and rotations, the set's counts,
 * whether the user may decide and whether a run has locked the
 * decisions, and `tiles`, the state of the review images. An image is
 * named by its capture id and its role together, as the decisions
 * route names it, since both halves of a spread carry one capture id.
 * A decision carries `sentAt`, when the unit first fetched a decision
 * set carrying it, and an opening carries `earlier` (`ViewerEarlier`)
 * when an earlier handover rejected it and this one brought new images:
 * the rejected images, which the viewer can show in their place.
 *
 * The layout. The viewer reads like a scrolling PDF: images fill the
 * column, and an opening is a pair or a single image under a thin line
 * in its decision's colour, with its controls in the margins. In
 * Spreads, 100% puts a pair across the column and 200% one page;
 * 25% leaves pages narrow enough that openings sit several to a row,
 * the whole volume in overview. Pages narrower than
 * `ACTIONS_MIN_WIDTH` lose their marginal controls and their margins
 * shrink. Single pages stacks an opening's images. Until the review
 * images give true sizes, every page is drawn at `PAGE_RATIO`.
 * `layoutRows` packs openings into rows; `visibleRange` finds the
 * openings a scroll position shows and `mountedRange` adds
 * `WINDOW_BUFFER` openings either side, so only those are mounted and
 * the rest of the column is held open by spacers.
 *
 * The shortcuts. `shortcutFor` maps a key event to an action: A
 * approve, R reject, `[` and `]` turn the left (or single) and right
 * image a quarter clockwise, J and K next and previous, G the contact
 * sheet, Escape closes the reject form, Ctrl or Cmd with Z undoes and
 * with Shift and Z redoes. While focus is in an input, a select or a
 * textarea every shortcut but Escape is ignored, so typing a note
 * never decides an opening, and while a modal is open (the leave
 * dialog among them) every shortcut is ignored.
 *
 * The decisions. `OpeningState` is an opening as the reviewer has left
 * it: its decision, if any (a rejection of an opening with two images
 * names the side to retake, its `side`; one recorded without a side is
 * held and sent as `both`, the whole opening), and the quarter-turns of
 * each image.
 * `entryFor` turns it into one record of the decisions route's body,
 * which replaces the opening's decision and rotations whole; an
 * undecided opening gives none, so a rotation on it stays in the
 * browser until it is decided (`heldRotation`). A decision is cleared,
 * by the Clear decision control or by undo, with an entry whose
 * decision is null, which `entryFor` gives for an undecided state
 * reached from a decided one; the opening's rotations stay in the
 * browser as held ones. A decision may be cleared only while the unit
 * has not fetched it (`sentAt` null); after that the reviewer changes
 * it instead. Undo restores an opening's earlier state by sending it
 * again: `canRestore` says when that is possible.
 * The screen always shows what the server will hold once the queue has
 * drained, by one rule (`reconcile`): the loader's snapshot at its
 * revision, then what the queue saved at a later revision, then what is
 * still outstanding, then rotations held on openings still undecided. A
 * read older than the highest revision the queue has seen is set aside
 * (`staleRead`). A saved batch is shown as saved unless a newer change
 * is still outstanding or the screen already holds a read at a higher
 * revision than the save (`afterSaved`, `saveOvertaken`), and openings rolled back by a
 * refusal or changed by a fresh read leave the undo history
 * (`dropFromHistory`, `changedOpenings`). After a conflict, an opening
 * another reviewer changed since the reviewer's own change was made
 * keeps the other reviewer's state, and the reviewer's change is dropped
 * and reported (`conflictedOpenings`). `hasUnsavedWork` counts held rotations with the queue's own unsaved
 * changes, and `blocksNavigation` decides when leaving must ask first.
 *
 * @version v0.8.0
 */

import type { CaptureQcReason, CaptureQcSide } from "../validation/enums";

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

export type ImageRole = "left" | "right" | "single";

export interface ViewerImage {
  captureId: string;
  role: ImageRole;
  pageKey: string;
}

export interface ViewerRotation {
  captureId: string;
  role: ImageRole;
  quarterTurns: number;
}

export interface ViewerDecision {
  decision: "approved" | "rejected";
  reason: CaptureQcReason | null;
  /** The image a rejection of a two-image opening asks to retake; null otherwise. */
  side: CaptureQcSide | null;
  note: string | null;
  /** The decider's name as recorded; null for a decision not saved yet. */
  decidedBy: string | null;
  decidedAt: number | null;
  /**
   * When the unit first fetched a decision set carrying this decision;
   * null, or absent, while it has not. Only an unfetched decision can
   * be cleared.
   */
  sentAt?: number | null;
}

/**
 * An earlier handover's rejection of an opening that the current
 * handover brought back with new images: the delivery that rejected it,
 * which handover of the volume that was, the images it rejected (left,
 * right, then a single) and the rejection. Given only while that
 * delivery's review images can be read.
 */
export interface ViewerEarlier {
  deliveryId: string;
  handover: number;
  images: ViewerImage[];
  decision: ViewerDecision;
}

export interface ViewerOpening {
  captuaRecordId: number;
  /** The record's `sequence` in the manifest: "Opening n". */
  sequence: number;
  /** The record's status in the manifest, as the unit set it. */
  scannerStatus: string;
  /** Left, right, then a single image. */
  images: ViewerImage[];
  decision: ViewerDecision | null;
  rotations: ViewerRotation[];
  /** The latest earlier handover's rejection, when this handover's images are new; null otherwise. */
  earlier: ViewerEarlier | null;
}

/**
 * The state of the current delivery's review images, from its review
 * runs: `none` without a review-tiles bucket or a review run,
 * `preparing` while a run can still report, `failed` when none can and
 * none finished, `ready` once one reported its tiles ready, and
 * `purged` once a purge of them has started, whether it finished or
 * failed. Only `ready` makes the viewer ask for access to the tiles
 * (`useReviewAccess`).
 */
export type TilesState =
  | { state: "none" }
  | { state: "preparing" }
  | { state: "failed" }
  | { state: "ready" }
  | { state: "purged" };

export interface CaptureQcVolume {
  volume: { id: string; referenceCode: string; title: string | null };
  reviewer: { id: string; name: string } | null;
  delivery: {
    /** The current delivery's id, posted as `manifestId`. */
    manifestId: string;
    /** Which handover of the volume this is, from 1. */
    handover: number;
    receivedAt: number;
    /** Its records `rejected`: retakes the unit owes, which are not openings. */
    rejectedRecords: number;
  };
  openings: ViewerOpening[];
  counts: { openings: number; images: number; approved: number; rejected: number; decided: number };
  /** The decision set's revision, 0 before any decision: sent back as `expectedRevision`. */
  revision: number;
  canDecide: boolean;
  /** A run has started on the volume; its decisions are fixed. */
  locked: boolean;
  tiles: TilesState;
}

// ---------------------------------------------------------------------------
// Search parameters
// ---------------------------------------------------------------------------

export const VIEW_MODES = ["spreads", "pages", "sheet"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const SHOW_FILTERS = ["all", "undecided", "rejected"] as const;
export type ShowFilter = (typeof SHOW_FILTERS)[number];

export function parseView(value: string | null): ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value ?? "") ? (value as ViewMode) : "spreads";
}

export function parseShow(value: string | null): ShowFilter {
  return (SHOW_FILTERS as readonly string[]).includes(value ?? "") ? (value as ShowFilter) : "all";
}

/** The opening a sequence number names, or the first; -1 when there are none. */
export function indexOfSequence(openings: Pick<ViewerOpening, "sequence">[], sequence: string | null): number {
  if (openings.length === 0) return -1;
  const n = Number(sequence);
  const found = sequence !== null && Number.isInteger(n) ? openings.findIndex((o) => o.sequence === n) : -1;
  return found >= 0 ? found : 0;
}

// ---------------------------------------------------------------------------
// Opening state, rotation and decisions
// ---------------------------------------------------------------------------

/** An image's key in an opening's turns: its role and capture id. */
export function imageKey(image: { captureId: string; role: string }): string {
  return `${image.role}:${image.captureId}`;
}

export interface OpeningState {
  decision: ViewerDecision | null;
  /** Quarter-turns clockwise, 0 to 3, by `imageKey`. */
  turns: Record<string, number>;
}

/**
 * A decision as the viewer holds it. A rejection of an opening with two
 * images recorded without a side (before rejections named one) applies
 * to the whole opening, which is `both`; holding it as `both` lets it be
 * sent again, rotated or restored by undo, under the route's rule that every
 * rejection of a pair names a side.
 */
function heldDecision(opening: Pick<ViewerOpening, "images">, decision: ViewerDecision | null): ViewerDecision | null {
  if (decision?.decision === "rejected" && decision.side === null && opening.images.length > 1) {
    return { ...decision, side: "both" };
  }
  return decision;
}

export function initialState(opening: ViewerOpening): OpeningState {
  const turns: Record<string, number> = {};
  for (const r of opening.rotations) turns[imageKey(r)] = ((r.quarterTurns % 4) + 4) % 4;
  return { decision: heldDecision(opening, opening.decision), turns };
}

/** A quarter-turn further clockwise. */
export function turnClockwise(turns: number): number {
  return (turns + 1) % 4;
}

/** The image `[` (left) or `]` (right) turns: the left or single image, or the right one. */
export function imageForSide(opening: Pick<ViewerOpening, "images">, side: "left" | "right"): ViewerImage | null {
  if (side === "right") return opening.images.find((i) => i.role === "right") ?? null;
  return opening.images.find((i) => i.role === "left") ?? opening.images.find((i) => i.role === "single") ?? null;
}

/** Whether the opening is a pair, shown as two pages side by side. */
export function isPair(opening: Pick<ViewerOpening, "images">): boolean {
  return opening.images.length > 1;
}

/** The rotation word's key suffix under `viewer.rotation`. */
export function rotationWord(turns: number): "none" | "r90" | "r180" | "r270" {
  return (["none", "r90", "r180", "r270"] as const)[((turns % 4) + 4) % 4];
}

/** A rotation on an undecided opening, held in the browser until it is decided. */
export function heldRotation(state: OpeningState): boolean {
  return state.decision === null && Object.values(state.turns).some((t) => t > 0);
}

/**
 * Whether the viewer holds work not yet saved: a change waiting, out or
 * failed, or a rotation held on an undecided opening, which is not sent
 * until the opening is decided.
 */
export function hasUnsavedWork(status: "saved" | "unsaved" | "saving" | "error", states: Iterable<OpeningState>): boolean {
  if (status !== "saved") return true;
  for (const s of states) if (heldRotation(s)) return true;
  return false;
}

/** Whether leaving for `to` must ask first: work not saved, and another page (not just other search parameters). */
export function blocksNavigation(unsaved: boolean, from: { pathname: string }, to: { pathname: string }): boolean {
  return unsaved && from.pathname !== to.pathname;
}

/** One record of the decisions route's body; a null decision clears the opening's. */
export interface DecisionEntry {
  captuaRecordId: number;
  decision: "approved" | "rejected" | null;
  reason?: CaptureQcReason;
  side?: CaptureQcSide;
  note?: string;
  rotations: ViewerRotation[];
}

/**
 * The entry that records `state`. An undecided state gives the entry
 * that clears the opening's decision when it is reached from a decided
 * one (`from`), and none otherwise: a rotation on an undecided opening
 * stays in the browser.
 */
export function entryFor(opening: ViewerOpening, state: OpeningState, from?: OpeningState | null): DecisionEntry | null {
  if (state.decision === null) {
    return from?.decision ? { captuaRecordId: opening.captuaRecordId, decision: null, rotations: [] } : null;
  }
  const rotations: ViewerRotation[] = [];
  for (const image of opening.images) {
    const turns = state.turns[imageKey(image)] ?? 0;
    if (turns > 0) rotations.push({ captureId: image.captureId, role: image.role, quarterTurns: turns });
  }
  const d = heldDecision(opening, state.decision)!;
  return {
    captuaRecordId: opening.captuaRecordId,
    decision: d.decision,
    ...(d.decision === "rejected" && d.reason !== null ? { reason: d.reason } : {}),
    ...(d.decision === "rejected" && d.side !== null ? { side: d.side } : {}),
    ...(d.note !== null && d.note.length > 0 ? { note: d.note } : {}),
    rotations,
  };
}

/** The state an entry records: what the opening is once the route has saved it. */
export function stateFromEntry(entry: DecisionEntry): OpeningState {
  const turns: Record<string, number> = {};
  for (const r of entry.rotations) turns[imageKey(r)] = r.quarterTurns;
  if (entry.decision === null) return { decision: null, turns };
  return {
    decision: {
      decision: entry.decision,
      reason: entry.reason ?? null,
      side: entry.side ?? null,
      note: entry.note ?? null,
      decidedBy: null,
      decidedAt: null,
    },
    turns,
  };
}

/** Whether two states record the same decision and rotations (who decided aside). */
export function sameState(a: OpeningState, b: OpeningState): boolean {
  const da = a.decision;
  const db = b.decision;
  if ((da === null) !== (db === null)) return false;
  if (
    da &&
    db &&
    (da.decision !== db.decision ||
      da.reason !== db.reason ||
      (da.side ?? null) !== (db.side ?? null) ||
      (da.note ?? null) !== (db.note ?? null))
  ) {
    return false;
  }
  const keys = new Set([...Object.keys(a.turns), ...Object.keys(b.turns)]);
  for (const k of keys) if ((a.turns[k] ?? 0) !== (b.turns[k] ?? 0)) return false;
  return true;
}

/**
 * A state as it is once sent again: every write gives the decision a
 * newer revision, which the unit has not fetched.
 */
function unsent(state: OpeningState): OpeningState {
  return (state.decision?.sentAt ?? null) === null ? state : { ...state, decision: { ...state.decision!, sentAt: null } };
}

/**
 * The states the screen shows once the queue has drained: `states` with
 * each outstanding entry laid over its opening. A viewer opened while
 * an earlier visit's writes are still on their way starts from the
 * loader's states and these entries, not from the loader alone.
 *
 * `later` says the entries are writes known to be later than `states`
 * (saves acknowledged at a higher revision): the decision they write
 * has a revision the unit has not fetched, so any fetch is dropped. An
 * entry whose revision is not known yet (one outstanding) may not have
 * landed, so the fetch of the decision it replaces still applies: it is
 * kept on the state shown, which keeps Clear off until the write is
 * acknowledged.
 */
export function overlayEntries(
  states: Map<number, OpeningState>,
  entries: DecisionEntry[],
  later = false,
): Map<number, OpeningState> {
  const next = new Map(states);
  for (const e of entries) {
    const current = next.get(e.captuaRecordId);
    if (!current) continue;
    const saved = stateFromEntry(e);
    // A cleared opening already undecided keeps the rotations held on it.
    if (saved.decision === null && current.decision === null) continue;
    if (!sameState(current, saved)) {
      // Until a write is known to be later, the server may still hold the
      // decision it replaces, and that one's fetch applies.
      const held = current.decision?.sentAt ?? null;
      next.set(e.captuaRecordId, later || held === null || saved.decision === null ? saved : { ...saved, decision: { ...saved.decision, sentAt: held } });
    } else if (later && (current.decision?.sentAt ?? null) !== null) next.set(e.captuaRecordId, unsent(current));
  }
  return next;
}

/**
 * The states shown after a batch is saved: each saved opening shows the
 * saved state, unless a newer change to it is still outstanding
 * (`pending`), which is what the server will hold in the end. When the
 * screen already holds a read at the save's revision or a later one
 * (`revisions.read`), that read's state stands, with what it knows of
 * the unit's fetches (`revisions.confirmed`); only a save at a later
 * revision than the read drops a fetch on an unchanged decision.
 */
export function afterSaved(
  states: Map<number, OpeningState>,
  saved: DecisionEntry[],
  pending: Set<number>,
  revisions?: { saved: number | null; read: number; confirmed?: Map<number, OpeningState> },
): Map<number, OpeningState> {
  if (revisions && revisions.saved !== null && revisions.read >= revisions.saved) {
    // The read holds this save, or overtook it: an entry laid over it as
    // outstanding gives way to the read's own state, unless a newer
    // change is outstanding. Rotations held on an opening the read also
    // shows undecided stay.
    const next = new Map(states);
    for (const e of saved) {
      const read = revisions.confirmed?.get(e.captuaRecordId);
      const shown = next.get(e.captuaRecordId);
      if (!read || pending.has(e.captuaRecordId)) continue;
      if (read.decision === null && shown?.decision === null) continue;
      next.set(e.captuaRecordId, read);
    }
    return next;
  }
  return overlayEntries(
    states,
    saved.filter((e) => !pending.has(e.captuaRecordId)),
    true,
  );
}

/**
 * Whether a save answered late is already overtaken: the screen holds a
 * read at a higher revision than the save produced. The save counts as
 * saved, but the newer read stays on screen.
 */
export function saveOvertaken(savedRevision: number | null, readRevision: number): boolean {
  return savedRevision !== null && readRevision > savedRevision;
}

/** A saved entry and the set revision its save produced (null when the answer gave none). */
export interface RevisedEntry {
  entry: DecisionEntry;
  revision: number | null;
}

/**
 * What the screen shows, by one rule: the loader's snapshot at revision
 * `loadedRevision`, then every entry the queue saved at a later
 * revision (one saved at or before it is already in the snapshot, or
 * was overtaken by a newer write the server holds), then the entries
 * still outstanding, then any rotation held on an opening still
 * undecided after all that. `confirmed` is the same without the
 * outstanding entries and held rotations: what the server holds.
 */
export function reconcile(input: {
  loaded: Map<number, OpeningState>;
  loadedRevision: number;
  saved: RevisedEntry[];
  outstanding: DecisionEntry[];
  /** What the screen shows now, for its held rotations. */
  current?: Map<number, OpeningState>;
}): { shown: Map<number, OpeningState>; confirmed: Map<number, OpeningState> } {
  const newer = input.saved
    .filter((s) => s.revision !== null && s.revision > input.loadedRevision)
    .map((s) => s.entry);
  const confirmed = overlayEntries(input.loaded, newer, true);
  const shown = overlayEntries(confirmed, input.outstanding);
  for (const [id, state] of input.current ?? []) {
    const now = shown.get(id);
    if (now && now.decision === null && heldRotation(state)) shown.set(id, { decision: null, turns: { ...state.turns } });
  }
  return { shown, confirmed };
}

/**
 * Whether a read of the volume is older than what the page already
 * knows: its revision is below the highest the queue has seen. Such a
 * read is set aside, never shown.
 */
export function staleRead(readRevision: number, known: number | null): boolean {
  return known !== null && readRevision < known;
}

/** The openings whose state differs between two maps. */
export function changedOpenings(a: Map<number, OpeningState>, b: Map<number, OpeningState>): Set<number> {
  const out = new Set<number>();
  for (const [id, state] of a) {
    const other = b.get(id);
    if (!other || !sameState(state, other)) out.add(id);
  }
  return out;
}

/**
 * The openings another reviewer changed under the reviewer's own work:
 * of the openings with work not yet saved (`work`), those whose state
 * in a fresh read (`fresh`, what the server holds) is no longer the
 * state the reviewer's change was based on (`base`, what was confirmed
 * when the change was made). Their own change is dropped and the read's
 * state shown, so no one's decision is overwritten silently.
 */
export function conflictedOpenings(
  work: Iterable<number>,
  base: Map<number, OpeningState>,
  fresh: Map<number, OpeningState>,
): Set<number> {
  const out = new Set<number>();
  for (const id of work) {
    const b = base.get(id);
    const f = fresh.get(id);
    if (b && f && !sameState(b, f)) out.add(id);
  }
  return out;
}

/**
 * An opening's base after one of the reviewer's own saves is
 * acknowledged: while newer work on it remains, the base moves forward
 * to the saved state, so the reviewer's own save is never taken for
 * another reviewer's change; with no work left, the base goes.
 */
export function advanceBase(base: Map<number, OpeningState>, saved: DecisionEntry, stillWorking: boolean): void {
  if (stillWorking) base.set(saved.captuaRecordId, stateFromEntry(saved));
  else base.delete(saved.captuaRecordId);
}

/** A timer for "once the scroll rests" that a change of view or layout cancels. */
export function createSettler(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule(fn: () => void) {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    cancel,
  };
}

export interface History {
  undo: OpeningChange[][];
  redo: OpeningChange[][];
}

/**
 * The history without any change to `ids`: after a refusal puts those
 * openings back as last saved, no undo or redo can bring a refused
 * change back. A step left empty goes too.
 */
export function dropFromHistory(history: History, ids: Set<number>): History {
  const strip = (steps: OpeningChange[][]) =>
    steps.map((step) => step.filter((c) => !ids.has(c.captuaRecordId))).filter((step) => step.length > 0);
  return { undo: strip(history.undo), redo: strip(history.redo) };
}

/** One opening's change: its state before and after. */
export interface OpeningChange {
  captuaRecordId: number;
  before: OpeningState;
  after: OpeningState;
}

/**
 * Whether the viewer can put an opening back from `from` to `to`. A
 * decided state is sent again. An undecided state is restored when
 * `from` is undecided too (a held rotation, never sent), or by clearing
 * `from`'s decision, which is possible only while the unit has not
 * fetched it.
 */
export function canRestore(from: OpeningState, to: OpeningState): boolean {
  return to.decision !== null || from.decision === null || (from.decision.sentAt ?? null) === null;
}

/**
 * Whether a whole step of history can be undone (`before`) or redone
 * (`after`). `shown`, the states on screen, gives each opening's state
 * as it now is, which may know that the unit has fetched its decision.
 */
export function canApply(step: OpeningChange[], direction: "undo" | "redo", shown?: Map<number, OpeningState>): boolean {
  return step.every((c) => {
    const from = shown?.get(c.captuaRecordId) ?? (direction === "undo" ? c.after : c.before);
    return canRestore(from, direction === "undo" ? c.before : c.after);
  });
}

// ---------------------------------------------------------------------------
// The reject form
// ---------------------------------------------------------------------------

/** The longest note the decisions route accepts, in characters (`MAX_NOTE_CHARS` in `link.server.ts`). */
export const MAX_NOTE_CHARS = 2000;

/**
 * Whether the reject form can be sent: a reason, a note for `other`, and
 * for an opening with two images (`needsSide`) the side to retake.
 */
export function canSubmitReject(
  reason: CaptureQcReason | null,
  note: string,
  needsSide = false,
  side: CaptureQcSide | null = null,
): boolean {
  if (reason === null) return false;
  if (needsSide && side === null) return false;
  const length = Array.from(note.trim()).length;
  if (length > MAX_NOTE_CHARS) return false;
  return reason !== "other" || length > 0;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function matchesShow(decision: ViewerDecision | null, show: ShowFilter): boolean {
  if (show === "undecided") return decision === null;
  if (show === "rejected") return decision?.decision === "rejected";
  return true;
}

/**
 * The record ids a filter shows. It is taken when the filter is chosen
 * and kept while the reviewer works, so an opening approved under
 * "Undecided" stays where it is rather than vanishing under the cursor.
 */
export function filterIds(
  openings: ViewerOpening[],
  states: Map<number, OpeningState>,
  show: ShowFilter,
): Set<number> {
  return new Set(
    openings
      .filter((o) => matchesShow(states.get(o.captuaRecordId)?.decision ?? o.decision, show))
      .map((o) => o.captuaRecordId),
  );
}

// ---------------------------------------------------------------------------
// Layout and windowing
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.25;
export const ZOOM_DEFAULT = 1;

/** Height over width of a page drawn without its true size. */
export const PAGE_RATIO = 1.4;
/** A page narrower than this loses its marginal controls. */
export const ACTIONS_MIN_WIDTH = 120;
export const MARGIN_LEFT = 64;
export const MARGIN_RIGHT = 48;
/** The margins left to a page too narrow for its controls. */
export const NARROW_MARGIN = 8;
/** The gap that joins the two pages of a pair. */
export const PAIR_GAP = 2;
/** The line above an opening: its number, page keys and decision. */
export const HEADER_HEIGHT = 20;
/** Between rows, and between the stacked pages of an opening. */
export const ROW_GAP = 48;
/** Between openings side by side in a row. */
export const COLUMN_GAP = 24;
/** The column's horizontal padding, both sides together. */
export const COLUMN_PADDING = 32;
/** The column's top padding. */
export const COLUMN_TOP = 8;
/** Openings mounted beyond the visible ones, on each side. */
export const WINDOW_BUFFER = 2;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom / ZOOM_STEP) * ZOOM_STEP));
}

/** A page's width: at 100% a pair fills the column, at 200% one page. */
export function pageWidth(columnWidth: number, zoom: number): number {
  const avail = Math.max(0, columnWidth - COLUMN_PADDING);
  const full = (avail - MARGIN_LEFT - MARGIN_RIGHT - PAIR_GAP) / 2;
  return Math.max(16, Math.floor(full * zoom));
}

export function showsActions(pw: number): boolean {
  return pw >= ACTIONS_MIN_WIDTH;
}

export function pageHeight(pw: number): number {
  return Math.round(pw * PAGE_RATIO);
}

export interface Box {
  width: number;
  height: number;
}

/** An opening's box in the column, margins and header line included. */
export function openingBox(opening: Pick<ViewerOpening, "images">, view: "spreads" | "pages", pw: number): Box {
  const margins = showsActions(pw) ? MARGIN_LEFT + MARGIN_RIGHT : 2 * NARROW_MARGIN;
  const count = Math.max(1, opening.images.length);
  const ph = pageHeight(pw);
  if (view === "pages") {
    return { width: margins + pw, height: HEADER_HEIGHT + count * ph + (count - 1) * ROW_GAP };
  }
  return { width: margins + (count > 1 ? 2 * pw + PAIR_GAP : pw), height: HEADER_HEIGHT + ph };
}

export interface Row {
  /** The first opening's index, and one past the last. */
  start: number;
  end: number;
  top: number;
  height: number;
}

export interface Layout {
  rows: Row[];
  /** The column's whole height. */
  height: number;
}

/** Openings packed into rows across the column, in order. */
export function layoutRows(boxes: Box[], columnWidth: number): Layout {
  const avail = Math.max(1, columnWidth - COLUMN_PADDING);
  const rows: Row[] = [];
  let top = COLUMN_TOP;
  let i = 0;
  while (i < boxes.length) {
    const start = i;
    let width = boxes[i].width;
    let height = boxes[i].height;
    i += 1;
    while (i < boxes.length && width + COLUMN_GAP + boxes[i].width <= avail) {
      width += COLUMN_GAP + boxes[i].width;
      height = Math.max(height, boxes[i].height);
      i += 1;
    }
    rows.push({ start, end: i, top, height });
    top += height + ROW_GAP;
  }
  // The last row's gap stays below it as the column's bottom padding.
  return { rows, height: top };
}

/** The openings of the rows a scroll position shows; null for an empty column. */
export function visibleRange(
  layout: Layout,
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } | null {
  const { rows } = layout;
  if (rows.length === 0) return null;
  const bottom = scrollTop + Math.max(1, viewportHeight);
  let first = -1;
  let last = -1;
  for (const r of rows) {
    if (r.top + r.height < scrollTop) continue;
    if (r.top > bottom) break;
    if (first < 0) first = r.start;
    last = r.end - 1;
  }
  if (first < 0) {
    // Scrolled past the end: the last row.
    const r = rows[rows.length - 1];
    return { first: r.start, last: r.end - 1 };
  }
  return { first, last };
}

/** The visible openings and `buffer` more on each side: the ones mounted. */
export function mountedRange(
  visible: { first: number; last: number } | null,
  count: number,
  buffer = WINDOW_BUFFER,
): { start: number; end: number } {
  if (!visible || count === 0) return { start: 0, end: 0 };
  return { start: Math.max(0, visible.first - buffer), end: Math.min(count, visible.last + buffer + 1) };
}

/** A row's width: its openings and the gaps between them. */
export function rowWidth(boxes: Box[], row: Pick<Row, "start" | "end">): number {
  let width = 0;
  for (let i = row.start; i < row.end; i += 1) width += boxes[i].width + (i > row.start ? COLUMN_GAP : 0);
  return width;
}

/**
 * How a row sits in the column: centred while it fits, and from its left
 * edge once it is wider (a zoomed spread), so its left image and the
 * controls in its left margin stay within reach of the scroll.
 */
export function rowAlignment(width: number, columnWidth: number): "center" | "start" {
  return width <= Math.max(0, columnWidth - COLUMN_PADDING) ? "center" : "start";
}

/** The top of the row an opening sits in. */
export function topOf(layout: Layout, index: number): number {
  const row = layout.rows.find((r) => index >= r.start && index < r.end);
  return row ? row.top : 0;
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

export type ShortcutAction =
  | "approve"
  | "reject"
  | "rotate_left"
  | "rotate_right"
  | "next"
  | "previous"
  | "sheet"
  | "close"
  | "undo"
  | "redo";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

/** Whether focus is somewhere the reviewer types: an input, a select, a textarea or editable text. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

const PLAIN_KEYS: Record<string, ShortcutAction> = {
  a: "approve",
  r: "reject",
  "[": "rotate_left",
  "]": "rotate_right",
  j: "next",
  k: "previous",
  g: "sheet",
};

export function shortcutFor(e: KeyLike, context: { modalOpen?: boolean } = {}): ShortcutAction | null {
  // A modal (the leave dialog among them) handles its own keys.
  if (context.modalOpen) return null;
  if (e.key === "Escape") return "close";
  if (isTypingTarget(e.target)) return null;
  const command = Boolean(e.ctrlKey || e.metaKey);
  if (command && !e.altKey && e.key.toLowerCase() === "z") return e.shiftKey ? "redo" : "undo";
  if (command || e.altKey) return null;
  return PLAIN_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? null;
}

// @version v0.8.0
