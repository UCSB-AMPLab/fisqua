/**
 * Capture QC Viewer
 *
 * This component is the capture QC viewer: the full-height page where
 * a reviewer looks at each opening of a volume's current handover and
 * approves it or rejects it for retake, correcting the rotation of an
 * image where the scanner got it wrong. It reads like a scrolling PDF,
 * in the manner of Diva.js and the segmentation viewer: the images fill
 * the column, an opening is a pair or a single image under a thin line
 * in its decision's colour, and its controls sit in the margins
 * (`OpeningRow`). The contact sheet is a mode of the same viewer
 * (`ContactSheet`), and the rail (`CaptureQcRail`) holds the opening's
 * details and the reject form.
 *
 * The page's state is in its search parameters where a link should
 * carry it: `opening` (the current opening's manifest sequence), `view`
 * (`spreads`, `pages` or `sheet`) and `show` (`all`, `undecided` or
 * `rejected`). Zoom stays in the page. A filter is taken when it is
 * chosen and kept while the reviewer works (`filterIds`), so an opening
 * decided under "Undecided" stays in place. Only the openings on screen
 * and two either side are mounted; the rest of the column is held open
 * by spacers of their size (`layoutRows`, `visibleRange`,
 * `mountedRange`). Scrolling away from the current opening makes the
 * first one on screen current once the scroll settles.
 *
 * Every decision is sent by the decision queue (`useDecisionQueue`) to
 * the decisions route, in batches, with the save state in the top bar.
 * A rotation on an undecided opening stays in the browser, marked not
 * saved yet, and goes with the opening's decision. While anything is
 * unsaved, held rotations included (`hasUnsavedWork`), the top bar says
 * so, leaving for another page asks first (`useBlocker` and the shared
 * unsaved-changes dialog), and closing the tab brings up the browser's
 * prompt. A refusal that puts openings back as last saved drops any
 * newer change to them still waiting, in the queue, and every change to
 * them from the undo history. The screen shows what the server will
 * hold once the queue drains: a viewer opened after an earlier visit
 * lays what that visit saved, and its writes still on their way, over
 * the loader's states, and
 * a saved batch shows as saved unless a newer change is outstanding.
 * Every state the screen installs comes from one rule (`reconcile`):
 * the loader's snapshot at its revision, then what the queue saved at a
 * later revision, then what is outstanding, then rotations held on
 * openings still undecided. When another write has moved the decision
 * set on, the queue asks for the volume to be read again; a read older
 * than a revision the queue has seen land is set aside (`staleRead`) and
 * read again, and undo steps on openings a read changed are dropped. A
 * save answered after a newer read was installed stays off the screen
 * (`saveOvertaken`), and after a final conflict the refused openings
 * take no change until a fresh read has been applied. Undo and redo walk
 * the reviewer's own steps. Clear decision, in an opening's margin and
 * in the rail, returns a decided opening to undecided, and so can undo,
 * but only while the unit has not fetched the opening's decision
 * (`canRestore`, `canApply` against the states on screen); the
 * opening's rotations stay as held ones and go with its next decision.
 * A change to a fetched decision keeps the fetch until the route
 * acknowledges it at a later revision, since the server holds the
 * fetched decision until then, so Clear does not come back while the
 * change waits.
 * A clear the route refuses because the unit fetched the decision in
 * the meantime (`decision_sent`) is rolled back like any refusal, and
 * the volume is read again, after which the opening offers no Clear.
 * The keys are those of `shortcutFor`, and none acts while the leave
 * dialog or any other modal is open.
 *
 * Once the delivery's review run has reported its tiles ready
 * (`tiles` is `ready`), the images are those tiles, read straight from
 * B2 with a download authorisation for the delivery on screen
 * (`useReviewAccess`), and drawn by `ReviewImage`, and the contact
 * sheet shows their thumbnails; in any other state, or without that
 * access, each image is a placeholder. An opening an earlier handover
 * rejected and this one brought back with new images can show the
 * rejected images in its place (its Earlier images toggle), read with
 * the access the same answer gives for that earlier delivery. Access is
 * asked for when either kind of tiles can be read, so the earlier images
 * load while the current ones are still being prepared; ready tiles of
 * the current delivery missing from the answer count as unavailable.
 *
 * Banners say what limits the page: no review images yet, images being
 * prepared or failed, or ready images whose access could not be had,
 * all of which still allow decisions; images deleted after processing,
 * said beside the lock that processing brings; a run started on the
 * volume,
 * which makes the page read only; a new handover, which the queue
 * learns from the route and which asks for a reload; and a filter that
 * matches nothing.
 *
 * @version v0.8.0
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, useRevalidator, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Lock,
  Maximize,
  RefreshCw,
  TriangleAlert,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ViewerTopBar } from "../../viewer/viewer-top-bar";
import { UnsavedChangesDialog } from "../../viewer/unsaved-changes-dialog";
import {
  advanceBase,
  rowAlignment,
  rowWidth,
  afterSaved,
  heldRotation,
  createSettler,
  conflictedOpenings,
  saveOvertaken,
  blocksNavigation,
  changedOpenings,
  dropFromHistory,
  reconcile,
  staleRead,
  canApply,
  hasUnsavedWork,
  clampZoom,
  entryFor,
  filterIds,
  imageForSide,
  imageKey,
  indexOfSequence,
  initialState,
  layoutRows,
  mountedRange,
  openingBox,
  pageWidth,
  parseShow,
  parseView,
  shortcutFor,
  stateFromEntry,
  topOf,
  turnClockwise,
  visibleRange,
  COLUMN_GAP,
  COLUMN_TOP,
  ROW_GAP,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type CaptureQcVolume,
  type DecisionEntry,
  type OpeningChange,
  type OpeningState,
  type ShowFilter,
  type TilesState,
  type ViewMode,
} from "../../../lib/capture/viewer";
import { awaitingRetakes } from "../../../lib/capture/status";
import { useDecisionQueue, type DecisionQueueDeps, type SavedEntry } from "../../../lib/capture/use-decision-queue";
import { useReviewAccess, type ReviewAccessState } from "../../../lib/capture/use-review-access";
import type { CaptureQcReason, CaptureQcSide } from "../../../lib/validation/enums";
import { OpeningRow, decisionKey } from "./opening-row";
import { ContactSheet } from "./contact-sheet";
import { CaptureQcRail } from "./capture-qc-rail";

/** The column's size before it is measured, as a server render draws it. */
export const DEFAULT_COLUMN_WIDTH = 960;
export const DEFAULT_VIEWPORT_HEIGHT = 800;
/** Steps of undo kept. */
const HISTORY_LIMIT = 200;
/** How long a scroll must rest before the first opening on screen becomes current. */
const SCROLL_SETTLE_MS = 150;

/**
 * A decided state as it is while its write waits: until the route
 * acknowledges the write at a later revision, the server still holds the
 * decision the opening had (`from`), so the fetch recorded on that one
 * applies, and Clear and undo to undecided stay off for a fetched
 * decision. A fetch recorded on a state restored by undo is its own,
 * older, and never carried.
 */
function whileUnsaved(from: OpeningState | undefined, to: OpeningState): OpeningState {
  if (to.decision === null) return to;
  const sentAt = from?.decision?.sentAt ?? null;
  return (to.decision.sentAt ?? null) === sentAt ? to : { ...to, decision: { ...to.decision, sentAt } };
}

export interface CaptureQcViewerProps {
  data: CaptureQcVolume;
  /** A sender other than `fetch`, for tests. */
  send?: DecisionQueueDeps["send"];
}

export function CaptureQcViewer({ data, send }: CaptureQcViewerProps) {
  const { t } = useTranslation(["capture", "viewer"]);
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get("view"));
  const show = parseShow(params.get("show"));
  const total = data.openings.length;

  const byId = useMemo(() => new Map(data.openings.map((o) => [o.captuaRecordId, o])), [data.openings]);
  const [states, setStates] = useState(() => new Map(data.openings.map((o) => [o.captuaRecordId, initialState(o)])));
  const statesRef = useRef(states);
  statesRef.current = states;
  const confirmed = useRef<Map<number, OpeningState> | null>(null);
  if (confirmed.current === null) confirmed.current = new Map(states);
  const [history, setHistory] = useState<{ undo: OpeningChange[][]; redo: OpeningChange[][] }>({ undo: [], redo: [] });

  // The filter, taken when it is chosen.
  const [filter, setFilter] = useState(() => ({ show, ids: filterIds(data.openings, states, show) }));
  let shownIds = filter.ids;
  if (filter.show !== show) {
    shownIds = filterIds(data.openings, states, show);
    setFilter({ show, ids: shownIds });
  }
  const visible = useMemo(() => data.openings.filter((o) => shownIds.has(o.captuaRecordId)), [data.openings, shownIds]);

  const [currentId, setCurrentId] = useState<number | null>(() => {
    const i = indexOfSequence(data.openings, params.get("opening"));
    return i >= 0 ? data.openings[i].captuaRecordId : null;
  });
  const current =
    currentId !== null && shownIds.has(currentId) ? currentId : visible.length > 0 ? visible[0].captuaRecordId : null;
  const currentOpening = current !== null ? byId.get(current) ?? null : null;
  const currentState = current !== null ? states.get(current) ?? null : null;
  const currentIndex = current !== null ? visible.findIndex((o) => o.captuaRecordId === current) : -1;

  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  // Openings showing the earlier handover's rejected images, and those the reviewer cleared.
  const [comparing, setComparing] = useState<Set<number>>(() => new Set());
  const [cleared, setCleared] = useState<Set<number>>(() => new Set());

  // The decision queue, and what the screen shows: by one rule
  // (`reconcile`), the loader's snapshot at its revision, what the queue
  // saved at a later revision, what is still outstanding, and rotations
  // held on openings still undecided.
  const revalidator = useRevalidator();
  const queueApi = useRef<{
    outstanding: () => DecisionEntry[];
    saved: () => SavedEntry[];
    knownRevision: () => number | null;
    accepts: (id: number) => boolean;
    readApplied: (revision?: number, drop?: Iterable<number>) => void;
  }>({ outstanding: () => [], saved: () => [], knownRevision: () => null, accepts: () => true, readApplied: () => {} });
  const rereadWanted = useRef(false);
  // The revision of the read the screen was last built from.
  const readRevision = useRef(data.revision);
  const display = useCallback((next: Map<number, OpeningState>) => {
    if (next === statesRef.current) return;
    statesRef.current = next;
    setStates(next);
  }, []);
  const install = useCallback(
    (read: CaptureQcVolume, saved: SavedEntry[], outstanding: DecisionEntry[], drop?: Set<number>) => {
      const loaded = new Map(read.openings.map((o) => [o.captuaRecordId, initialState(o)]));
      const { shown, confirmed: held } = reconcile({
        loaded,
        loadedRevision: read.revision,
        saved,
        outstanding,
        current: drop ? new Map([...statesRef.current].filter(([id]) => !drop.has(id))) : statesRef.current,
      });
      confirmed.current = held;
      readRevision.current = Math.max(readRevision.current, read.revision);
      const changed = changedOpenings(shown, statesRef.current);
      display(shown);
      // A step on an opening the read changed would undo the server's state.
      if (changed.size > 0) setHistory((h) => dropFromHistory(h, changed));
    },
    [display],
  );
  // What each opening's unsaved work was based on: what was confirmed
  // when the reviewer first changed it.
  const baseRef = useRef(new Map<number, OpeningState>());
  const [changedByOther, setChangedByOther] = useState<number[]>([]);
  /**
   * A fresh read applied. An opening another reviewer changed since the
   * reviewer's own change keeps the read's state: the reviewer's entry
   * and held rotation are dropped, its undo steps go, and the reviewer
   * is told. The rest of the reviewer's work is laid over the read, and
   * the queue sends what it held.
   */
  const applyRead = useCallback(
    (read: CaptureQcVolume, saved: SavedEntry[], outstanding: DecisionEntry[]) => {
      const loaded = new Map(read.openings.map((o) => [o.captuaRecordId, initialState(o)]));
      const fresh = reconcile({ loaded, loadedRevision: read.revision, saved, outstanding: [] }).confirmed;
      const work = new Set(outstanding.map((e) => e.captuaRecordId));
      for (const [id, state] of statesRef.current) if (heldRotation(state)) work.add(id);
      const conflicted = conflictedOpenings(work, baseRef.current, fresh);
      install(
        read,
        saved,
        outstanding.filter((e) => !conflicted.has(e.captuaRecordId)),
        conflicted,
      );
      for (const id of conflicted) baseRef.current.delete(id);
      if (conflicted.size > 0) {
        setHistory((h) => dropFromHistory(h, conflicted));
        setChangedByOther(read.openings.filter((o) => conflicted.has(o.captuaRecordId)).map((o) => o.sequence));
      }
      queueApi.current.readApplied(read.revision, conflicted);
    },
    [install],
  );
  const dataRef = useRef(data);
  dataRef.current = data;
  const onAttach = useCallback(
    (entries: DecisionEntry[], saved: SavedEntry[]) => {
      if (!staleRead(dataRef.current.revision, queueApi.current.knownRevision())) {
        applyRead(dataRef.current, saved, entries);
      } else {
        install(dataRef.current, saved, entries);
        // The snapshot is older than a revision the queue saw (a conflict
        // answered while no viewer was attached): read again, and the
        // fresh read releases any frozen openings.
        rereadWanted.current = true;
        revalidator.revalidate();
      }
    },
    [applyRead, install, revalidator],
  );

  // A fresh read of the volume (after another write moved the set on).
  // A read older than a revision the queue has seen land is set aside,
  // and read again if a fresh read was asked for.
  const firstData = useRef(data);
  useEffect(() => {
    if (data === firstData.current) return;
    firstData.current = data;
    if (staleRead(data.revision, queueApi.current.knownRevision())) {
      if (rereadWanted.current) revalidator.revalidate();
      return;
    }
    rereadWanted.current = false;
    // Frozen openings take changes again, and a batch held after a conflict is sent.
    applyRead(data, queueApi.current.saved(), queueApi.current.outstanding());
  }, [data, applyRead, revalidator]);

  const onSaved = useCallback(
    (entries: DecisionEntry[], _id: string | null, revision: number | null) => {
      // A save answered after a newer read was installed is saved, but
      // the newer read's state wins for its openings, on screen and in
      // what is confirmed, and no undo step can post the overtaken entry.
      const read = readRevision.current;
      const pending = new Set(queueApi.current.outstanding().map((e) => e.captuaRecordId));
      if (saveOvertaken(revision, read)) {
        display(afterSaved(statesRef.current, entries, pending, { saved: revision, read, confirmed: confirmed.current! }));
        const ids = new Set(entries.map((e) => e.captuaRecordId).filter((id) => !pending.has(id)));
        if (ids.size > 0) setHistory((h) => dropFromHistory(h, ids));
        return;
      }
      // A read at the save's own revision already holds it, with what it
      // knows of the unit's fetches: that read stays what is confirmed.
      if (revision === null || read < revision) {
        for (const e of entries) confirmed.current!.set(e.captuaRecordId, stateFromEntry(e));
      }
      display(afterSaved(statesRef.current, entries, pending, { saved: revision, read, confirmed: confirmed.current! }));
      for (const e of entries) {
        const shownState = statesRef.current.get(e.captuaRecordId);
        const stillWorking = pending.has(e.captuaRecordId) || (shownState !== undefined && heldRotation(shownState));
        advanceBase(baseRef.current, e, stillWorking);
      }
    },
    [display],
  );
  const onRefused = useCallback(
    (entries: DecisionEntry[]) => {
      const next = new Map(statesRef.current);
      const ids = new Set<number>();
      for (const e of entries) {
        ids.add(e.captuaRecordId);
        baseRef.current.delete(e.captuaRecordId);
        const before = confirmed.current!.get(e.captuaRecordId);
        if (before) next.set(e.captuaRecordId, before);
      }
      display(next);
      // A refused change must not come back through undo or redo.
      setHistory((h) => dropFromHistory(h, ids));
    },
    [display],
  );
  const queue = useDecisionQueue({
    volumeId: data.volume.id,
    manifestId: data.delivery.manifestId,
    onSaved,
    onRefused,
    onAttach,
    onReread: () => {
      rereadWanted.current = true;
      revalidator.revalidate();
    },
    revision: data.revision,
    send,
  });
  queueApi.current = {
    outstanding: queue.outstanding,
    saved: queue.saved,
    knownRevision: queue.knownRevision,
    accepts: queue.accepts,
    readApplied: queue.readApplied,
  };
  const deliveryChanged = queue.refusal?.kind === "delivery_changed";
  const locked = data.locked || queue.refusal?.kind === "run_started";
  const canDecide = data.canDecide && !locked && !deliveryChanged;

  // Access to the review tiles of the delivery on screen, asked for
  // only once its review run has reported them ready.
  // Access is asked for once the current delivery's tiles are ready, or
  // when an opening can be compared with an earlier delivery's tiles,
  // which the loader offers only while they are ready.
  const comparable = useMemo(() => data.openings.some((o) => o.earlier !== null), [data.openings]);
  const reviewAccess = useReviewAccess(data.volume.id, data.delivery.manifestId, data.tiles.state === "ready" || comparable);
  const reviewBase = reviewAccess.state.status === "ready" ? reviewAccess.state.base : null;
  const reviewBases = reviewAccess.state.status === "ready" ? reviewAccess.state.bases : null;
  const imageAccess = useMemo(
    () => (reviewBase !== null ? { base: reviewBase, token: () => reviewAccess.token() } : null),
    [reviewBase, reviewAccess.token],
  );
  // The earlier deliveries' access, for the rejected images an opening can show.
  const earlierAccess = useMemo(() => {
    const out = new Map<string, { base: string; token: () => string | null }>();
    for (const [id, base] of Object.entries(reviewBases ?? {})) {
      if (id !== data.delivery.manifestId) out.set(id, { base, token: () => reviewAccess.token(id) });
    }
    return out;
  }, [reviewBases, reviewAccess.token, data.delivery.manifestId]);

  // Work not yet saved, held rotations included, shows as unsaved and
  // makes leaving ask first: in-app with the router's blocker, and on
  // closing or reloading the tab with the browser's own prompt.
  const unsaved = hasUnsavedWork(queue.status, states.values());
  const saveStatus = queue.status === "saved" && unsaved ? "unsaved" : queue.status;
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    blocksNavigation(unsaved, currentLocation, nextLocation),
  );
  useEffect(() => {
    if (!unsaved || typeof window === "undefined") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // Geometry and windowing.
  const rootRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState({ width: DEFAULT_COLUMN_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT });
  const flowView = view === "pages" ? "pages" : "spreads";
  const pw = pageWidth(geom.width, zoom);
  const boxes = useMemo(() => visible.map((o) => openingBox(o, flowView, pw)), [visible, flowView, pw]);
  const layout = useMemo(() => layoutRows(boxes, geom.width), [boxes, geom.width]);
  const [scrollTop, setScrollTop] = useState(() => Math.max(0, topOf(layout, currentIndex) - COLUMN_TOP));
  const scrollToCurrent = useRef(true);

  useEffect(() => {
    const el = columnRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = el.clientWidth || DEFAULT_COLUMN_WIDTH;
      const height = el.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
      setGeom((g) => {
        if (g.width === width && g.height === height) return g;
        // A new width moves the openings, so the current one is brought back into view.
        if (g.width !== width) scrollToCurrent.current = true;
        return { width, height };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bring the current opening into view after a move, a zoom or a change of view.
  useEffect(() => {
    if (!scrollToCurrent.current || view === "sheet") return;
    scrollToCurrent.current = false;
    const el = columnRef.current;
    if (!el || currentIndex < 0) return;
    const top = Math.max(0, topOf(layout, currentIndex) - COLUMN_TOP);
    el.scrollTop = top;
    setScrollTop(top);
  }, [layout, currentIndex, view]);

  // Cancelled whenever the view or the layout changes, so a callback
  // scheduled for one layout never reads a scroll position of another.
  const settler = useRef(createSettler(SCROLL_SETTLE_MS));
  const onScroll = () => {
    const el = columnRef.current;
    if (!el || view === "sheet") return;
    setScrollTop(el.scrollTop);
    settler.current.schedule(() => {
      const range = visibleRange(layout, el.scrollTop, el.clientHeight || geom.height);
      if (!range || (currentIndex >= range.first && currentIndex <= range.last)) return;
      setCurrentId(visible[range.first].captuaRecordId);
    });
  };
  useEffect(() => () => settler.current.cancel(), [view, layout]);

  // The current opening in the address, without reloading the page.
  const currentSequence = currentOpening?.sequence ?? null;
  useEffect(() => {
    if (currentSequence === null || params.get("opening") === String(currentSequence)) return;
    const next = new URLSearchParams(params);
    next.set("opening", String(currentSequence));
    setParams(next, { replace: true, preventScrollReset: true });
  }, [currentSequence, params, setParams]);

  const setParam = (name: "view" | "show", value: ViewMode | ShowFilter) => {
    const next = new URLSearchParams(params);
    next.set(name, value);
    scrollToCurrent.current = true;
    setParams(next, { replace: true, preventScrollReset: true });
  };

  // Changing openings. Each change is sent with the state it left, so
  // a decided opening made undecided sends the entry that clears it.
  const sendStates = (changes: Array<[number, OpeningState, OpeningState]>) => {
    const entries: DecisionEntry[] = [];
    for (const [id, state, from] of changes) {
      const opening = byId.get(id);
      const entry = opening ? entryFor(opening, state, from) : null;
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) queue.enqueue(entries);
  };
  // Openings made undecided from a decided state show "Decision cleared." in their history.
  const noteCleared = (changes: Array<[number, OpeningState, OpeningState]>) => {
    const changed = changes.filter(([, after, from]) => (after.decision === null) !== (from.decision === null));
    if (changed.length === 0) return;
    setCleared((c) => {
      const next = new Set(c);
      for (const [id, after] of changed) {
        if (after.decision === null) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const noteBase = (ids: number[]) => {
    for (const id of ids) {
      if (!baseRef.current.has(id)) baseRef.current.set(id, confirmed.current!.get(id) ?? statesRef.current.get(id)!);
    }
  };

  const commit = (changes: Array<{ id: number; after: OpeningState }>) => {
    if (!canDecide) return;
    const next = new Map(statesRef.current);
    const step: OpeningChange[] = [];
    for (const c of changes) {
      const before = next.get(c.id);
      // An opening waiting for a fresh read after a final conflict takes no change.
      if (!before || !queueApi.current.accepts(c.id)) continue;
      const after = whileUnsaved(before, c.after);
      step.push({ captuaRecordId: c.id, before, after });
      next.set(c.id, after);
    }
    if (step.length === 0) return;
    noteBase(step.map((c) => c.captuaRecordId));
    statesRef.current = next;
    setStates(next);
    setHistory((h) => ({ undo: [...h.undo, step].slice(-HISTORY_LIMIT), redo: [] }));
    const sent: Array<[number, OpeningState, OpeningState]> = step.map((s) => [s.captuaRecordId, s.after, s.before]);
    noteCleared(sent);
    sendStates(sent);
  };

  const approve = (id: number | null) => {
    if (id === null) return;
    const state = statesRef.current.get(id);
    if (!state || state.decision?.decision === "approved") return;
    commit([
      {
        id,
        after: { decision: { decision: "approved", reason: null, side: null, note: null, decidedBy: null, decidedAt: null }, turns: state.turns },
      },
    ]);
  };

  const reject = (id: number | null, reason: CaptureQcReason, note: string | null, side: CaptureQcSide | null) => {
    if (id === null) return;
    const state = statesRef.current.get(id);
    if (!state) return;
    commit([
      { id, after: { decision: { decision: "rejected", reason, side, note, decidedBy: null, decidedAt: null }, turns: state.turns } },
    ]);
    setRejectOpen(false);
  };

  // Only a decision the unit has not fetched can be cleared; the
  // opening's rotations stay as held ones.
  const clear = (id: number | null) => {
    if (id === null) return;
    const state = statesRef.current.get(id);
    if (!state?.decision || (state.decision.sentAt ?? null) !== null) return;
    commit([{ id, after: { decision: null, turns: state.turns } }]);
    setRejectOpen(false);
  };

  const rotate = (id: number | null, side: "left" | "right") => {
    if (id === null) return;
    const opening = byId.get(id);
    const state = statesRef.current.get(id);
    const image = opening ? imageForSide(opening, side) : null;
    if (!opening || !state || !image) return;
    const key = imageKey(image);
    commit([{ id, after: { decision: state.decision, turns: { ...state.turns, [key]: turnClockwise(state.turns[key] ?? 0) } } }]);
  };

  const travel = (direction: "undo" | "redo") => {
    if (!canDecide) return;
    const stack = direction === "undo" ? history.undo : history.redo;
    const step = stack[stack.length - 1];
    if (!step || !canApply(step, direction, statesRef.current)) return;
    if (step.some((c) => !queueApi.current.accepts(c.captuaRecordId))) return;
    const next = new Map(statesRef.current);
    const restored: Array<[number, OpeningState, OpeningState]> = step.map((c) => {
      const from = statesRef.current.get(c.captuaRecordId) ?? (direction === "undo" ? c.after : c.before);
      return [c.captuaRecordId, whileUnsaved(from, direction === "undo" ? c.before : c.after), from];
    });
    noteBase(restored.map(([id]) => id));
    for (const [id, state] of restored) next.set(id, state);
    statesRef.current = next;
    setStates(next);
    setHistory((h) =>
      direction === "undo"
        ? { undo: h.undo.slice(0, -1), redo: [...h.redo, step] }
        : { undo: [...h.undo, step], redo: h.redo.slice(0, -1) },
    );
    noteCleared(restored);
    sendStates(restored);
  };
  const lastUndo = history.undo[history.undo.length - 1];
  const lastRedo = history.redo[history.redo.length - 1];
  const canUndo = canDecide && lastUndo !== undefined && canApply(lastUndo, "undo", states);
  const canRedo = canDecide && lastRedo !== undefined && canApply(lastRedo, "redo", states);

  const toggleCompare = (id: number) =>
    setComparing((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const makeCurrent = (id: number) => {
    setCurrentId(id);
  };
  const move = (delta: number) => {
    if (visible.length === 0) return;
    const i = Math.min(visible.length - 1, Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + delta));
    setCurrentId(visible[i].captuaRecordId);
    scrollToCurrent.current = true;
  };
  const changeZoom = (delta: number) => {
    setZoom((z) => clampZoom(z + delta));
    scrollToCurrent.current = true;
  };
  const openReject = () => {
    if (!canDecide || current === null) return;
    setRailCollapsed(false);
    setRejectOpen(true);
  };
  const toggleFullscreen = () => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void rootRef.current?.requestFullscreen?.();
  };
  const approveSelected = () => {
    const ids = [...selected].filter((id) => statesRef.current.get(id)?.decision?.decision !== "approved");
    commit(
      ids.map((id) => ({
        id,
        after: {
          decision: { decision: "approved", reason: null, side: null, note: null, decidedBy: null, decidedAt: null },
          turns: statesRef.current.get(id)!.turns,
        },
      })),
    );
    setSelected(new Set());
  };

  // The keys, read through a ref so the listener stays put.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    // Nothing acts behind the leave dialog or any other modal.
    const modalOpen =
      blocker.state === "blocked" ||
      (typeof document !== "undefined" && document.querySelector('[aria-modal="true"]') !== null);
    const action = shortcutFor(e, { modalOpen });
    if (action === null) return;
    switch (action) {
      case "approve":
        approve(current);
        break;
      case "reject":
        openReject();
        break;
      case "rotate_left":
        rotate(current, "left");
        break;
      case "rotate_right":
        rotate(current, "right");
        break;
      case "next":
        move(1);
        break;
      case "previous":
        move(-1);
        break;
      case "sheet":
        setParam("view", view === "sheet" ? "spreads" : "sheet");
        break;
      case "close":
        if (!rejectOpen) return;
        setRejectOpen(false);
        break;
      case "undo":
        travel("undo");
        break;
      case "redo":
        travel("redo");
        break;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Counts over every opening, as the reviewer has left them.
  const counts = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const s of states.values()) {
      if (s.decision?.decision === "approved") approved += 1;
      else if (s.decision?.decision === "rejected") rejected += 1;
    }
    return { approved, rejected, undecided: total - approved - rejected };
  }, [states, total]);

  const announcement =
    currentOpening && currentState
      ? t("viewer.rail.announce", {
          n: currentOpening.sequence,
          total,
          decision: t(decisionKey(currentState.decision)),
        })
      : "";

  const heading = [data.volume.referenceCode, data.volume.title, t("queue.title")].filter(Boolean).join(" · ");
  const range = mountedRange(visibleRange(layout, scrollTop, geom.height), visible.length);

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-white">
      <ViewerTopBar
        volumeName={heading}
        backTo="/admin/capture/qc"
        backLabel={t("viewer.back")}
        saveStatus={saveStatus}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => travel("undo")}
        onRedo={() => travel("redo")}
        onRetrySave={() => void queue.retry()}
      />

      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 bg-white px-3 py-1 font-sans text-xs">
        <div className="flex items-center gap-1">
          <IconButton label={t("viewer:toolbar.zoom_out")} onClick={() => changeZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>
            <ZoomOut size={14} aria-hidden="true" />
          </IconButton>
          <span className="min-w-[4ch] text-center font-medium tabular-nums text-stone-600">{Math.round(zoom * 100)}%</span>
          <IconButton label={t("viewer:toolbar.zoom_in")} onClick={() => changeZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>
            <ZoomIn size={14} aria-hidden="true" />
          </IconButton>
        </div>

        <div role="group" aria-label={t("viewer.view_label")} className="flex items-center gap-1">
          <Toggle pressed={view === "pages"} onClick={() => setParam("view", "pages")} label={t("viewer.view_pages")} />
          <Toggle pressed={view === "spreads"} onClick={() => setParam("view", "spreads")} label={t("viewer.view_spreads")} />
          <Toggle pressed={view === "sheet"} onClick={() => setParam("view", "sheet")} label={t("viewer.view_sheet")} />
        </div>

        <div role="group" aria-label={t("viewer.show_label")} className="flex items-center gap-1">
          <Toggle pressed={show === "undecided"} onClick={() => setParam("show", "undecided")} label={t("viewer.show_undecided")} />
          <Toggle pressed={show === "rejected"} onClick={() => setParam("show", "rejected")} label={t("viewer.show_rejected")} />
          <Toggle pressed={show === "all"} onClick={() => setParam("show", "all")} label={t("viewer.show_all")} />
        </div>

        {view === "sheet" && canDecide ? (
          <div className="flex items-center gap-2">
            <span className="font-semibold text-stone-600">{t("viewer.sheet.selected", { count: selected.size })}</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
              className="h-7 rounded border border-stone-200 bg-white px-2 font-semibold text-indigo hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {t("viewer.sheet.clear")}
            </button>
            <button
              type="button"
              onClick={approveSelected}
              disabled={selected.size === 0}
              className="inline-flex h-7 items-center gap-1.5 rounded bg-verdigris px-2 font-semibold text-parchment hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Check size={14} aria-hidden="true" />
              {t("viewer.sheet.approve_selected")}
            </button>
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <IconButton label={t("viewer.previous")} onClick={() => move(-1)} disabled={currentIndex <= 0}>
            <ChevronLeft size={14} aria-hidden="true" />
          </IconButton>
          <span className="whitespace-nowrap font-semibold text-stone-700">
            {currentOpening ? t("viewer.position", { n: currentOpening.sequence, total }) : null}
          </span>
          <IconButton
            label={t("viewer.next")}
            onClick={() => move(1)}
            disabled={currentIndex < 0 || currentIndex >= visible.length - 1}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </IconButton>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="ml-2 inline-flex h-7 items-center gap-1.5 rounded border border-stone-200 bg-white px-2 font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Maximize size={14} aria-hidden="true" />
            {t("viewer:toolbar.fullscreen")}
          </button>
        </div>
      </div>

      <CaptureQcBanners
        tiles={data.tiles}
        images={reviewAccess.state.status === "ready" && reviewBase === null ? "unavailable" : reviewAccess.state.status}
        locked={locked}
        deliveryChanged={deliveryChanged}
        emptyFilter={visible.length === 0}
      />

      <div className="flex min-h-0 flex-1">
        <div ref={columnRef} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto bg-stone-100">
          {visible.length === 0 ? null : view === "sheet" ? (
            <ContactSheet
              openings={visible}
              states={states}
              currentId={current}
              zoom={zoom}
              selected={selected}
              canDecide={canDecide}
              access={imageAccess}
              onOpen={(id) => {
                setCurrentId(id);
                scrollToCurrent.current = true;
                setParam("view", "spreads");
              }}
              onToggle={(id) =>
                setSelected((s) => {
                  const next = new Set(s);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          ) : (
            <WindowedColumn layout={layout} boxes={boxes} range={range} columnWidth={geom.width}>
              {(i) => {
                const o = visible[i];
                const box = boxes[i];
                return (
                  <OpeningRow
                    key={o.captuaRecordId}
                    opening={o}
                    state={states.get(o.captuaRecordId)!}
                    view={flowView}
                    pw={pw}
                    width={box.width}
                    height={box.height}
                    current={o.captuaRecordId === current}
                    canDecide={canDecide}
                    access={imageAccess}
                    comparing={comparing.has(o.captuaRecordId)}
                    earlierAccess={o.earlier ? earlierAccess.get(o.earlier.deliveryId) ?? null : null}
                    onCurrent={() => makeCurrent(o.captuaRecordId)}
                    onApprove={() => approve(o.captuaRecordId)}
                    onReject={openReject}
                    onRotate={(side) => rotate(o.captuaRecordId, side)}
                    onClear={() => clear(o.captuaRecordId)}
                    onCompare={() => toggleCompare(o.captuaRecordId)}
                  />
                );
              }}
            </WindowedColumn>
          )}
        </div>

        <CaptureQcRail
          referenceCode={data.volume.referenceCode}
          reviewerName={data.reviewer?.name ?? null}
          imageCount={data.counts.images}
          openingCount={total}
          counts={counts}
          awaitingRetakes={
            !locked &&
            awaitingRetakes({ openings: total, rejectedRecords: data.delivery.rejectedRecords }, counts.approved === total)
          }
          opening={currentOpening}
          state={currentState}
          handover={data.delivery.handover}
          receivedAt={data.delivery.receivedAt}
          canDecide={canDecide}
          rejectOpen={rejectOpen}
          onClear={() => clear(current)}
          cleared={current !== null && cleared.has(current) && currentState?.decision === null}
          onReject={(reason, note, side) => reject(current, reason, note, side)}
          onCancelReject={() => setRejectOpen(false)}
          refusal={queue.refusal}
          changedByOther={changedByOther}
          announcement={announcement}
          collapsed={railCollapsed}
          onToggle={() => setRailCollapsed((c) => !c)}
        />
      </div>

      <UnsavedChangesDialog
        open={blocker.state === "blocked"}
        titleLabel={t("viewer:save_status.unsaved_dialog_title")}
        bodyLabel={t("viewer:save_status.unsaved_dialog_body")}
        stayLabel={t("viewer:save_status.unsaved_dialog_stay")}
        leaveLabel={t("viewer:save_status.unsaved_dialog_leave")}
        onStay={() => blocker.reset?.()}
        onLeave={() => {
          // What is waiting is sent before the page goes; a held rotation cannot be.
          void queue.settle();
          blocker.proceed?.();
        }}
      />
    </div>
  );
}

/**
 * The column's rows. Rows that hold a mounted opening are drawn, with
 * any of their openings outside the window as empty boxes of the same
 * size; the rows above and below are one spacer each.
 */
function WindowedColumn({
  layout,
  boxes,
  range,
  columnWidth,
  children,
}: {
  layout: ReturnType<typeof layoutRows>;
  boxes: Array<{ width: number; height: number }>;
  columnWidth: number;
  range: { start: number; end: number };
  children: (index: number) => ReactNode;
}) {
  const rows = layout.rows.filter((r) => r.end > range.start && r.start < range.end);
  if (rows.length === 0) return <div style={{ height: layout.height }} />;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const below = Math.max(0, layout.height - (last.top + last.height + ROW_GAP));
  return (
    <div className="px-4">
      <div style={{ height: first.top }} aria-hidden="true" />
      {rows.map((r) => (
        <div
          key={r.start}
          className="flex items-start"
          style={{
            height: r.height,
            marginBottom: ROW_GAP,
            gap: COLUMN_GAP,
            // A row wider than the column starts at its left edge, so its
            // left image and controls stay within reach of the scroll.
            justifyContent: rowAlignment(rowWidth(boxes, r), columnWidth) === "start" ? "flex-start" : "center",
          }}
        >
          {Array.from({ length: r.end - r.start }, (_, k) => r.start + k).map((i) =>
            i >= range.start && i < range.end ? (
              children(i)
            ) : (
              <div
                key={`s${i}`}
                aria-hidden="true"
                data-spacer={i}
                className="shrink-0"
                style={{ width: boxes[i].width, height: boxes[i].height }}
              />
            ),
          )}
        </div>
      ))}
      <div style={{ height: below }} aria-hidden="true" />
    </div>
  );
}

export interface CaptureQcBannersProps {
  tiles: TilesState;
  /** The state of access to the review tiles (`useReviewAccess`). */
  images?: ReviewAccessState["status"];
  locked: boolean;
  deliveryChanged: boolean;
  emptyFilter: boolean;
}

/** The banners under the toolbar: what limits the page (see the file header). */
export function CaptureQcBanners({ tiles, images, locked, deliveryChanged, emptyFilter }: CaptureQcBannersProps) {
  const { t } = useTranslation("capture");
  const banners: Array<{ key: string; tone: string; icon: ReactNode }> = [];
  const info = <Info className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />;
  if (deliveryChanged) {
    banners.push({
      key: "viewer.banner_delivery_changed",
      tone: "bg-saffron-tint text-saffron-deep",
      icon: <RefreshCw className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />,
    });
  } else if (locked) {
    banners.push({
      key: "viewer.banner_locked",
      tone: "bg-stone-100 text-stone-600",
      icon: <Lock className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />,
    });
  } else if (tiles.state === "ready" && images === "unavailable") {
    banners.push({ key: "viewer.banner_images_unavailable", tone: "bg-stone-100 text-stone-600", icon: info });
  } else if (tiles.state === "none") {
    banners.push({ key: "viewer.banner_no_tiles", tone: "bg-indigo-tint text-indigo", icon: info });
  } else if (tiles.state === "preparing") {
    banners.push({ key: "viewer.banner_preparing", tone: "bg-indigo-tint text-indigo", icon: info });
  } else if (tiles.state === "failed") {
    banners.push({
      key: "viewer.banner_failed",
      tone: "bg-madder-tint text-madder-deep",
      icon: <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />,
    });
  }
  // Tiles are purged after processing, which locks the volume, so the
  // purge is said beside the lock rather than in its place.
  if (tiles.state === "purged" && !deliveryChanged) {
    banners.push({ key: "viewer.banner_purged", tone: "bg-stone-100 text-stone-600", icon: info });
  }
  if (emptyFilter) banners.push({ key: "viewer.empty_filter", tone: "bg-stone-100 text-stone-600", icon: info });
  if (banners.length === 0) return null;
  return (
    <div className="shrink-0">
      {banners.map((b) => (
        <p
          key={b.key}
          role={b.key === "viewer.banner_delivery_changed" ? "alert" : "status"}
          data-banner={b.key.replace("viewer.", "")}
          className={`flex items-center gap-2 border-b border-stone-200 px-4 py-2 font-sans text-sm ${b.tone}`}
        >
          {b.icon}
          {t(b.key)}
        </p>
      ))}
    </div>
  );
}

function Toggle({ pressed, onClick, label }: { pressed: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`h-7 rounded border px-2 font-semibold ${
        pressed ? "border-indigo bg-indigo-tint text-indigo" : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded text-stone-600 hover:bg-stone-100 focus:outline-none focus:ring-2 focus:ring-indigo/40 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// @version v0.8.0
