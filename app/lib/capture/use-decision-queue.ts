/**
 * Capture QC Viewer — The Decision Queue
 *
 * This module deals with getting the viewer's decisions to Fisqua. The
 * viewer has no page action: each change is posted as JSON to the
 * decisions route, `POST /admin/capture/volumes/:volumeId/decisions`
 * (`recordDecisionsAction` in `qc.server.ts`), whose body names the
 * delivery the decisions were made on (`manifestId`), the decision
 * set's revision the page last knew (`expectedRevision`, from the
 * loader and then from each 200 answer, so a write made on an older
 * state, such as the late commit of a request whose connection was
 * lost, is refused rather than landing last), and the openings decided,
 * each entry replacing that opening's decision and rotations whole.
 *
 * `createDecisionQueue` holds the changes. An entry for an opening
 * replaces any earlier one still waiting, so only the latest state of
 * each opening is sent. The first change after a quiet spell starts a
 * window of `BATCH_WINDOW_MS`; everything that arrives inside it goes
 * in one request. While a request is out, new changes wait and go in
 * the next one, so the queue's writes reach the route in the order they
 * were made. A request that fails on the network, or with a 5xx or 429
 * answer, is tried again with `withBoundedRetry`; when the tries run
 * out the entries go back to waiting, the status is `error`, and
 * `retry` sends them again. `settle` sends whatever is left at once,
 * retrying a failed batch, for a viewer that is being left.
 *
 * Some answers are final and are not retried:
 *
 *   - 409 `delivery_changed` (or `no_capture_delivery`): a new handover
 *     replaced the one on screen. The queue stops, and the viewer says
 *     so and asks for a reload.
 *   - 409 `run_started`: processing has started and the decisions are
 *     fixed. The queue stops, and the viewer becomes read only.
 *   - 409 `revision_changed`: another write moved the decision set past
 *     the revision this request expected. The queue takes the answer's
 *     revision, asks the page to read the volume again (`onReread`), and
 *     holds the batch until that read has been applied (`readApplied`).
 *     The page drops the entries for openings another reviewer changed
 *     since the change was made, and the queue sends the rest once more
 *     on the new revision, so no one's decision is overwritten silently;
 *     refused a second
 *     time, it is treated as the refusals below and never retried, the
 *     page is asked to read the volume again, and the refused openings
 *     take no new change (`accepts`) until that read has been applied
 *     (`readApplied`). The revision the queue knows only ever rises, and
 *     every save hands its revision to `onSaved`.
 *   - 409 `decision_sent`: the request cleared a decision the unit had
 *     already fetched. It is refused whole like the refusals below, and
 *     the page is also asked to read the volume again (`onReread`), so
 *     the opening shows its decision as fetched and offers no Clear.
 *   - 413 and 422, and any other refusal (400, 403, 404): the request
 *     was refused whole. The entries of the openings the refusal names
 *     (`causesOf`: the record ids of `decision_sent` and the 422s, the
 *     `records.<i>` paths of a 400) are handed to `onRefused`, so the
 *     viewer puts those openings back as last saved, and any newer
 *     change to the same openings still waiting is dropped with them,
 *     so the screen and the server agree. The batch's other entries go
 *     back to waiting and are sent again. A refusal that names no
 *     opening of the batch, or whose list was cut short, hands back the
 *     whole batch.
 *
 * A disposed queue sends nothing more: its window is cancelled, a
 * backoff between retries is cut short, and a request that answers
 * after it was disposed leaves the waiting entries where they are.
 *
 * Listeners subscribe (`subscribe`) for the status, the saved entries
 * and the refused ones; `snapshot` reports the status the save
 * indicator shows (`saved`, `unsaved` while changes wait, `saving` while
 * a request is out, `error` when retries ran out) and the last refusal.
 *
 * One queue serves a volume's delivery for the life of the page, in
 * `queueFor`'s registry, rather than one per mounted viewer: a viewer
 * left and opened again uses the same queue, so an earlier mount's late
 * writes are sent before the new mount's and cannot overwrite them. A
 * new delivery of the volume disposes the old queue. `attachDecisionQueue`
 * is what a mounted viewer does: it takes the volume's queue and
 * subscribes, handing the listener what the queue has saved for the
 * life of the page (`saved`: the latest entry per opening, with the set
 * revision its save produced and when) and the entries still outstanding (`outstanding`: out,
 * waiting or failed, from this visit or an earlier one), so a viewer
 * opened after a save it did not see still shows it; on detach it unsubscribes
 * and settles the queue, so a
 * decision made just before leaving is sent at once. It is idempotent
 * under React's development double mount: detaching and attaching again
 * leaves a working queue. `useDecisionQueue` runs it in an effect,
 * never during a server render.
 *
 * @version v0.8.0
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { withBoundedRetry } from "../autosave-retry";
import type { DecisionEntry } from "./viewer";

/** How long changes are collected before they are sent together. */
export const BATCH_WINDOW_MS = 500;

export type QueueStatus = "saved" | "unsaved" | "saving" | "error";

export type QueueRefusal =
  | { kind: "delivery_changed"; manifestId: string | null }
  | { kind: "run_started" }
  | { kind: "too_large" }
  | { kind: "unknown"; status: 422 }
  | { kind: "revision_changed"; revision: number }
  | { kind: "decision_sent"; captuaRecordIds: number[] }
  | { kind: "refused"; status: number };

export interface QueueSnapshot {
  status: QueueStatus;
  refusal: QueueRefusal | null;
  /** The queue sends nothing more: the handover changed or a run started. */
  stopped: boolean;
}

export interface QueueAnswer {
  status: number;
  body: unknown;
}

/** What the queue posts. */
export interface DecisionsBody {
  manifestId: string;
  records: DecisionEntry[];
  expectedRevision?: number;
}

export interface DecisionQueueDeps {
  manifestId: string;
  /** The set's revision the page last read; without it no revision is sent. */
  revision?: number;
  /** Posts one body; throws on a network failure. */
  send: (body: DecisionsBody) => Promise<QueueAnswer>;
  onChange?: (snapshot: QueueSnapshot) => void;
  onSaved?: (entries: DecisionEntry[], decisionsId: string | null, revision: number | null) => void;
  onRefused?: (entries: DecisionEntry[], refusal: QueueRefusal) => void;
  windowMs?: number;
  retry?: { maxAttempts?: number; baseMs?: number };
}

/** An entry the route saved, the set revision that save produced, and when the queue learned it. */
export interface SavedEntry {
  entry: DecisionEntry;
  revision: number | null;
  savedAt: number;
}

export interface QueueListener {
  onChange?: (snapshot: QueueSnapshot) => void;
  onSaved?: (entries: DecisionEntry[], decisionsId: string | null, revision: number | null) => void;
  onRefused?: (entries: DecisionEntry[], refusal: QueueRefusal) => void;
  /**
   * On attaching: what the queue has saved this page's life (latest per
   * opening) and the entries not yet saved, from this or an earlier visit.
   */
  onAttach?: (outstanding: DecisionEntry[], saved: SavedEntry[]) => void;
  /** Another write moved the set on: read the volume again. */
  onReread?: () => void;
}

export interface DecisionQueue {
  readonly manifestId: string;
  enqueue: (entries: DecisionEntry | DecisionEntry[]) => void;
  /** Sends what is waiting now, without waiting for the window. */
  flush: () => Promise<void>;
  /** Sends again what failed after its retries ran out. */
  retry: () => Promise<void>;
  /** Sends what is left now, retrying a failed batch. */
  settle: () => Promise<void>;
  snapshot: () => QueueSnapshot;
  /** The latest entry per opening not yet saved: out, waiting or failed. */
  outstanding: () => DecisionEntry[];
  /** The latest entry saved per opening, for the life of the page. */
  saved: () => SavedEntry[];
  /** Takes a revision read elsewhere (a loader), keeping the newer of it and its own. */
  knowRevision: (revision: number) => void;
  /** The highest set revision the queue has seen (it never falls); null before any. */
  knownRevision: () => number | null;
  /** Whether the queue takes a change to this opening (not while it waits for a fresh read). */
  accepts: (captuaRecordId: number) => boolean;
  /**
   * A fresh read of the volume at `revision` has been applied: the
   * queue takes its revision, frozen openings take changes again, the
   * entries for `drop` (openings another reviewer changed) are
   * discarded, and a batch held after a conflict is sent on the read's
   * revision.
   */
  readApplied: (revision?: number, drop?: Iterable<number>) => void;
  subscribe: (listener: QueueListener) => () => void;
  /** Clears a refusal the page is no longer showing (one that did not stop the queue). */
  clearRefusal: () => void;
  dispose: () => void;
}

const errorOf = (body: unknown): string | null =>
  body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : null;

/** Paths a refusal lists before it stops (`LISTED_IDS` in `qc.server.ts`). */
const LISTED = 100;

/**
 * The openings of `entries` a refusal names as its cause: the record ids
 * of `decision_sent` and `unknown_records`, the records of
 * `unknown_captures`, and the `records.<i>` paths of `invalid_request`.
 * Null when it names none of them, or may not have named them all (a
 * list cut short), so the whole batch is refused.
 */
function causesOf(answer: QueueAnswer, entries: DecisionEntry[]): Set<number> | null {
  const body = answer.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || body.omitted !== undefined) return null;
  const ids = new Set<number>();
  if (Array.isArray(body.captua_record_ids)) {
    for (const id of body.captua_record_ids) if (typeof id === "number") ids.add(id);
  }
  if (Array.isArray(body.captures)) {
    for (const c of body.captures) {
      const id = (c as { captua_record_id?: unknown } | null)?.captua_record_id;
      if (typeof id === "number") ids.add(id);
    }
  }
  if (body.error === "invalid_request" && typeof body.detail === "string") {
    const paths = [...body.detail.matchAll(/records\.(\d+)/g)];
    if (body.detail.split(", ").length >= LISTED) return null;
    for (const m of paths) {
      const entry = entries[Number(m[1])];
      if (entry) ids.add(entry.captuaRecordId);
    }
  }
  return entries.some((e) => ids.has(e.captuaRecordId)) ? ids : null;
}

/** The refusal a final answer carries; null for an answer worth retrying. */
export function refusalOf(answer: QueueAnswer): QueueRefusal | null {
  const { status, body } = answer;
  if (status >= 500 || status === 429) return null;
  const error = errorOf(body);
  if (status === 409 && error === "run_started") return { kind: "run_started" };
  if (status === 409 && error === "decision_sent") {
    const ids = (body as { captua_record_ids?: unknown } | null)?.captua_record_ids;
    return { kind: "decision_sent", captuaRecordIds: Array.isArray(ids) ? ids.filter((i): i is number => typeof i === "number") : [] };
  }
  if (status === 409 && error === "revision_changed") {
    const revision = (body as { revision?: unknown } | null)?.revision;
    return { kind: "revision_changed", revision: typeof revision === "number" ? revision : 0 };
  }
  if (status === 409) {
    const manifestId = (body as { manifest_id?: unknown } | null)?.manifest_id;
    return { kind: "delivery_changed", manifestId: typeof manifestId === "string" ? manifestId : null };
  }
  if (status === 413) return { kind: "too_large" };
  if (status === 422) return { kind: "unknown", status: 422 };
  return { kind: "refused", status };
}

export function createDecisionQueue(deps: DecisionQueueDeps): DecisionQueue {
  const windowMs = deps.windowMs ?? BATCH_WINDOW_MS;
  let waiting = new Map<number, DecisionEntry>();
  let sending: Map<number, DecisionEntry> | null = null;
  const savedOf = new Map<number, SavedEntry>();
  let revision: number | null = deps.revision ?? null;
  // A conflict is answered by one resend on the new revision, never more.
  let resentOnConflict = false;
  // The highest revision seen; it only ever rises.
  const raise = (n: number) => {
    if (revision === null || n > revision) revision = n;
  };
  // Openings waiting for a fresh read after a final conflict.
  const frozen = new Set<number>();
  // After a first conflict, nothing is sent until a fresh read is applied.
  let awaitingRead = false;
  let inFlight = false;
  let failed = false;
  let stopped = false;
  let refusal: QueueRefusal | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const abort = new AbortController();
  const listeners = new Set<QueueListener>();
  if (deps.onChange || deps.onSaved || deps.onRefused) {
    listeners.add({ onChange: deps.onChange, onSaved: deps.onSaved, onRefused: deps.onRefused });
  }

  const status = (): QueueStatus => {
    if (inFlight) return "saving";
    if (failed) return "error";
    return waiting.size > 0 ? "unsaved" : "saved";
  };
  const snapshot = (): QueueSnapshot => ({ status: status(), refusal, stopped });
  const emit = () => {
    if (disposed) return;
    const snap = snapshot();
    for (const l of listeners) l.onChange?.(snap);
  };

  const schedule = () => {
    if (disposed || timer !== null || inFlight || failed || stopped || awaitingRead || waiting.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, windowMs);
  };

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed || inFlight || stopped || awaitingRead || waiting.size === 0) return;
    const batch = waiting;
    waiting = new Map();
    sending = batch;
    inFlight = true;
    failed = false;
    emit();

    const entries = [...batch.values()];
    let final: { answer: QueueAnswer; refusal: QueueRefusal | null } | null = null;
    const result = await withBoundedRetry(
      async () => {
        if (disposed) return { ok: false, error: "aborted" };
        const answer = await deps.send({
          manifestId: deps.manifestId,
          records: entries,
          ...(revision !== null ? { expectedRevision: revision } : {}),
        });
        if (answer.status === 200) {
          final = { answer, refusal: null };
          return { ok: true };
        }
        const r = refusalOf(answer);
        if (r === null) return { ok: false, error: `HTTP ${answer.status}` };
        final = { answer, refusal: r };
        return { ok: true };
      },
      { ...deps.retry, signal: abort.signal },
    );
    inFlight = false;
    sending = null;
    if (disposed) return;

    const settled = final as { answer: QueueAnswer; refusal: QueueRefusal | null } | null;
    if (!result.ok || settled === null) {
      // Retries ran out: put the batch back under anything newer.
      for (const [id, entry] of batch) if (!waiting.has(id)) waiting.set(id, entry);
      failed = true;
      emit();
      return;
    }
    if (settled.refusal?.kind === "revision_changed" && !resentOnConflict) {
      // Another write moved the set on. Take its revision, have the page
      // read the volume again, and hold this batch until that read has
      // been applied (`readApplied`), which drops the entries for openings
      // another reviewer changed and sends the rest once more.
      raise(settled.refusal.revision);
      resentOnConflict = true;
      awaitingRead = true;
      for (const [id, entry] of batch) if (!waiting.has(id)) waiting.set(id, entry);
      for (const l of listeners) l.onReread?.();
      emit();
      return;
    }
    resentOnConflict = false;
    if (settled.refusal?.kind === "revision_changed") {
      // A second conflict is final. Its openings take no new change until
      // a fresh read of the volume has been applied (`readApplied`), so
      // nothing is built on the state the refusal rolls them back to.
      raise(settled.refusal.revision);
      for (const e of entries) frozen.add(e.captuaRecordId);
      for (const l of listeners) l.onReread?.();
    }
    if (settled.refusal === null) {
      const body = settled.answer.body as { decisionsId?: unknown; revision?: unknown } | null;
      const produced = typeof body?.revision === "number" ? body.revision : null;
      if (produced !== null) raise(produced);
      const id = typeof body?.decisionsId === "string" ? body.decisionsId : null;
      const at = Date.now();
      for (const e of entries) savedOf.set(e.captuaRecordId, { entry: e, revision: produced, savedAt: at });
      for (const l of listeners) l.onSaved?.(entries, id, produced);
    } else {
      refusal = settled.refusal;
      if (refusal.kind === "delivery_changed" || refusal.kind === "run_started") stopped = true;
      // Only the openings the refusal names were refused; the rest of the
      // batch goes back to waiting, under any newer change, and is sent again.
      const causes = stopped || refusal.kind === "revision_changed" ? null : causesOf(settled.answer, entries);
      const refused = causes === null ? entries : entries.filter((e) => causes.has(e.captuaRecordId));
      if (causes !== null) {
        for (const e of entries) if (!causes.has(e.captuaRecordId) && !waiting.has(e.captuaRecordId)) waiting.set(e.captuaRecordId, e);
      }
      // The refused openings go back to their saved state, so a newer
      // change to them still waiting goes too.
      for (const e of refused) waiting.delete(e.captuaRecordId);
      for (const l of listeners) l.onRefused?.(refused, refusal);
      // A clear refused because the unit has the decision: the page reads
      // the volume again, which shows the decision as fetched.
      if (refusal.kind === "decision_sent") for (const l of listeners) l.onReread?.();
    }
    emit();
    schedule();
  }

  async function retry(): Promise<void> {
    if (stopped || disposed) return;
    failed = false;
    await flush();
  }

  return {
    manifestId: deps.manifestId,
    enqueue(input) {
      if (stopped || disposed) return;
      const list = (Array.isArray(input) ? input : [input]).filter((e) => !frozen.has(e.captuaRecordId));
      if (list.length === 0) return;
      for (const entry of list) waiting.set(entry.captuaRecordId, entry);
      emit();
      schedule();
    },
    flush,
    retry,
    settle: () => (failed ? retry() : flush()),
    snapshot,
    knownRevision: () => revision,
    knowRevision: raise,
    accepts: (id) => !frozen.has(id),
    readApplied(readRevision, drop) {
      // The read's revision is taken first, so a batch held after a
      // conflict is sent on it, not on the revision before the read.
      if (readRevision !== undefined) raise(readRevision);
      frozen.clear();
      for (const id of drop ?? []) waiting.delete(id);
      if (awaitingRead) {
        awaitingRead = false;
        emit();
        void flush();
      }
    },
    saved() {
      return [...savedOf.values()];
    },
    outstanding() {
      const all = new Map(sending ?? []);
      for (const [id, e] of waiting) all.set(id, e);
      return [...all.values()];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clearRefusal() {
      // A final conflict's refusal stays while its openings wait for a fresh read.
      if (stopped || refusal === null || frozen.size > 0) return;
      refusal = null;
      emit();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      abort.abort();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// One queue per volume
// ---------------------------------------------------------------------------

const registry = new Map<string, DecisionQueue>();

/**
 * The volume's queue for a delivery: the one already serving it, or a
 * new one, disposing a queue left from an earlier delivery.
 */
export function queueFor(
  volumeId: string,
  manifestId: string,
  make: () => DecisionQueue,
): DecisionQueue {
  const existing = registry.get(volumeId);
  if (existing && existing.manifestId === manifestId) return existing;
  existing?.dispose();
  const queue = make();
  registry.set(volumeId, queue);
  return queue;
}

/** Disposes and forgets every queue; for tests. */
export function resetDecisionQueues(): void {
  for (const q of registry.values()) q.dispose();
  registry.clear();
}

export interface AttachOptions {
  volumeId: string;
  manifestId: string;
  /** The set's revision the attaching page read. */
  revision?: number;
  send: DecisionQueueDeps["send"];
  listener: QueueListener;
  /** Queue settings other than the sender, for tests. */
  windowMs?: number;
  retry?: DecisionQueueDeps["retry"];
}

/**
 * What a mounted viewer does with its volume's queue: take it, listen,
 * and on detach stop listening and send what is left.
 */
export function attachDecisionQueue(options: AttachOptions): { queue: DecisionQueue; detach: () => void } {
  const queue = queueFor(options.volumeId, options.manifestId, () =>
    createDecisionQueue({
      manifestId: options.manifestId,
      revision: options.revision,
      send: options.send,
      windowMs: options.windowMs,
      retry: options.retry,
    }),
  );
  if (options.revision !== undefined) queue.knowRevision(options.revision);
  queue.clearRefusal();
  const unsubscribe = queue.subscribe(options.listener);
  options.listener.onAttach?.(queue.outstanding(), queue.saved());
  options.listener.onChange?.(queue.snapshot());
  return {
    queue,
    detach: () => {
      unsubscribe();
      void queue.settle();
    },
  };
}

/** Posts a decisions body to the route, as JSON. */
export function postDecisions(volumeId: string) {
  return async (body: DecisionsBody): Promise<QueueAnswer> => {
    const res = await fetch(`/admin/capture/volumes/${encodeURIComponent(volumeId)}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };
}

export interface UseDecisionQueueOptions {
  volumeId: string;
  manifestId: string;
  onSaved?: QueueListener["onSaved"];
  onRefused?: QueueListener["onRefused"];
  onAttach?: QueueListener["onAttach"];
  onReread?: QueueListener["onReread"];
  /** The set's revision the page read. */
  revision?: number;
  /** A sender other than `fetch`, for tests. */
  send?: DecisionQueueDeps["send"];
}

export function useDecisionQueue(options: UseDecisionQueueOptions) {
  const callbacks = useRef({
    onSaved: options.onSaved,
    onRefused: options.onRefused,
    onAttach: options.onAttach,
    onReread: options.onReread,
  });
  callbacks.current = {
    onSaved: options.onSaved,
    onRefused: options.onRefused,
    onAttach: options.onAttach,
    onReread: options.onReread,
  };
  const [snap, setSnap] = useState<QueueSnapshot>({ status: "saved", refusal: null, stopped: false });
  const queueRef = useRef<DecisionQueue | null>(null);
  const { volumeId, manifestId, send } = options;
  const revisionRef = useRef(options.revision);
  revisionRef.current = options.revision;
  // A fresh read of the volume brings its revision to the queue.
  useEffect(() => {
    if (options.revision !== undefined) queueRef.current?.knowRevision(options.revision);
  }, [options.revision]);

  // Taken in an effect, so a server render never touches the registry
  // and a development double mount attaches again to the same queue.
  useEffect(() => {
    // The attach handover is passed on once the queue is in place, so the
    // viewer can already ask the queue about it.
    let handover: [DecisionEntry[], SavedEntry[]] | null = null;
    const { queue, detach } = attachDecisionQueue({
      volumeId,
      manifestId,
      send: send ?? postDecisions(volumeId),
      listener: {
        onChange: setSnap,
        onSaved: (entries, id, revision) => callbacks.current.onSaved?.(entries, id, revision),
        onRefused: (entries, r) => callbacks.current.onRefused?.(entries, r),
        onAttach: (entries, saved) => {
          handover = [entries, saved];
        },
        onReread: () => callbacks.current.onReread?.(),
      },
      revision: revisionRef.current,
    });
    queueRef.current = queue;
    if (handover) callbacks.current.onAttach?.(handover[0], handover[1]);
    return () => {
      queueRef.current = null;
      detach();
    };
  }, [volumeId, manifestId, send]);

  const enqueue = useCallback((entries: DecisionEntry | DecisionEntry[]) => queueRef.current?.enqueue(entries), []);
  const retry = useCallback(async () => {
    await queueRef.current?.retry();
  }, []);
  const outstanding = useCallback(() => queueRef.current?.outstanding() ?? [], []);
  const saved = useCallback(() => queueRef.current?.saved() ?? [], []);
  const knownRevision = useCallback(() => queueRef.current?.knownRevision() ?? null, []);
  const accepts = useCallback((id: number) => queueRef.current?.accepts(id) ?? true, []);
  const readApplied = useCallback(
    (revision?: number, drop?: Iterable<number>) => queueRef.current?.readApplied(revision, drop),
    [],
  );
  const settle = useCallback(async () => {
    await queueRef.current?.settle();
  }, []);
  return { ...snap, enqueue, retry, settle, outstanding, saved, knownRevision, accepts, readApplied };
}

// @version v0.8.0
