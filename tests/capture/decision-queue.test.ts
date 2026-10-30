/**
 * Tests — the capture QC viewer's decision queue
 *
 * This suite drives `createDecisionQueue` (`use-decision-queue.ts`) with
 * a stand-in sender and fake timers, and pins how the viewer's changes
 * reach the decisions route:
 *
 *   - batching: changes made within 500 ms go in one request, with the
 *     delivery's id as `manifestId`, and an opening changed twice is
 *     sent once, as last left; changes made while a request is out go
 *     in the next one;
 *   - retry: a network failure, a 5xx or a 429 is tried again with
 *     bounded backoff; when the tries run out the status is `error`,
 *     nothing more is sent on its own, and `retry` sends the entries
 *     again under any newer change;
 *   - each refusal: 409 `delivery_changed` and 409 `run_started` stop
 *     the queue, and nothing more is sent; 413 and 422 hand the entries
 *     back to be put back as last saved and leave the queue working;
 *     any other refusal does the same; 409 `decision_sent` does too, and
 *     also asks the page to read the volume again; a refusal that names
 *     its openings (record ids, captures, `records.<i>` paths) hands
 *     back only those and sends the rest of the batch again, and one
 *     that names none of the batch, or cuts its list short, hands back
 *     all of it;
 *   - the status the save indicator shows at each step;
 *   - the revision: each request carries the set's revision the queue
 *     last knew, adopted from every 200 answer; a `revision_changed`
 *     refusal asks the page to read the volume again, holds the batch
 *     until that read is applied, drops the entries for openings another
 *     reviewer changed, and sends the rest once more on the read's revision, and a second refusal is shown, not
 *     retried, asks for a fresh read, and freezes its openings until
 *     that read is applied, even for a viewer that attaches later with
 *     an older snapshot; the revision the queue knows never falls, and
 *     a save answered after a newer read gives way to the read's state;
 *   - leaving the viewer: detaching sends what is waiting at once,
 *     without waiting for the window, and tries a failed batch again;
 *   - a disposed queue: a request answering late sends nothing more,
 *     and a backoff between retries is cut short;
 *   - one queue per volume: a viewer opened again takes the same queue,
 *     so an earlier mount's late write goes first and the new one's
 *     last, and is handed the entries still on their way and told
 *     when they are saved, and what was saved before it attached; a new delivery disposes the old queue;
 *   - a refused batch dropping the newer changes to the same openings
 *     still waiting, so nothing is saved that the screen put back;
 *   - React's development double mount (attach, detach, attach again)
 *     leaving a queue that still sends. The suite has no DOM renderer,
 *     so the double mount is driven through `attachDecisionQueue`, the
 *     function the hook's effect runs.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  attachDecisionQueue,
  BATCH_WINDOW_MS,
  createDecisionQueue,
  queueFor,
  refusalOf,
  resetDecisionQueues,
  type QueueAnswer,
  type QueueSnapshot,
} from "../../app/lib/capture/use-decision-queue";
import {
  afterSaved,
  overlayEntries,
  saveOvertaken,
  staleRead,
  type DecisionEntry,
  type OpeningState,
} from "../../app/lib/capture/viewer";

const approve = (id: number): DecisionEntry => ({ captuaRecordId: id, decision: "approved", rotations: [] });
const reject = (id: number): DecisionEntry => ({ captuaRecordId: id, decision: "rejected", reason: "glare", rotations: [] });

type Body = { manifestId: string; records: DecisionEntry[]; expectedRevision?: number };

function harness(answers: Array<QueueAnswer | Error>) {
  const sent: Body[] = [];
  const snapshots: QueueSnapshot[] = [];
  const saved: DecisionEntry[][] = [];
  const refused: Array<{ entries: DecisionEntry[]; kind: string }> = [];
  const queue = createDecisionQueue({
    manifestId: "delivery-1",
    send: async (body) => {
      sent.push(JSON.parse(JSON.stringify(body)));
      const next = answers.shift() ?? { status: 200, body: { decisionsId: "d-x" } };
      if (next instanceof Error) throw next;
      return next;
    },
    onChange: (s) => snapshots.push(s),
    onSaved: (entries) => saved.push(entries),
    onRefused: (entries, r) => refused.push({ entries, kind: r.kind }),
    retry: { maxAttempts: 3, baseMs: 100 },
  });
  return { queue, sent, snapshots, saved, refused };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDecisionQueues();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("batching", () => {
  it("sends the changes of one window in one request, each opening as last left", async () => {
    const h = harness([]);
    h.queue.enqueue(approve(1));
    expect(h.queue.snapshot().status).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS - 100);
    h.queue.enqueue([approve(2), reject(1)]);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].manifestId).toBe("delivery-1");
    expect(h.sent[0].records).toEqual([reject(1), approve(2)]);
    expect(h.saved).toEqual([[reject(1), approve(2)]]);
    expect(h.queue.snapshot().status).toBe("saved");
  });

  it("holds changes made while a request is out for the next one", async () => {
    let release: (a: QueueAnswer) => void = () => {};
    const sent: Body[] = [];
    const queue = createDecisionQueue({
      manifestId: "delivery-1",
      send: (body) => {
        sent.push(JSON.parse(JSON.stringify(body)));
        return new Promise<QueueAnswer>((resolve) => {
          release = resolve;
        });
      },
    });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(queue.snapshot().status).toBe("saving");
    queue.enqueue(approve(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 2);
    expect(sent).toHaveLength(1);
    release({ status: 200, body: { decisionsId: "d-1" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot().status).toBe("unsaved");
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].records).toEqual([approve(2)]);
    release({ status: 200, body: { decisionsId: "d-2" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot().status).toBe("saved");
  });
});

describe("retry", () => {
  it("tries a failed request again with backoff", async () => {
    const h = harness([new Error("network"), { status: 503, body: null }, { status: 200, body: { decisionsId: "d-1" } }]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sent).toHaveLength(3);
    expect(h.saved).toHaveLength(1);
    expect(h.queue.snapshot().status).toBe("saved");
  });

  it("stops at the bound, shows the error, and sends again on retry", async () => {
    const h = harness([
      { status: 500, body: null },
      { status: 429, body: null },
      new Error("network"),
      { status: 200, body: { decisionsId: "d-1" } },
    ]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + 100 + 200);
    expect(h.sent).toHaveLength(3);
    expect(h.queue.snapshot().status).toBe("error");
    h.queue.enqueue(reject(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 4);
    expect(h.sent).toHaveLength(3);
    await h.queue.retry();
    expect(h.sent).toHaveLength(4);
    expect(h.sent[3].records.map((r) => r.captuaRecordId).sort()).toEqual([1, 2]);
    expect(h.queue.snapshot().status).toBe("saved");
  });

  it("keeps a newer change over the failed one when it puts the batch back", async () => {
    const h = harness([new Error("a"), new Error("b"), new Error("c")]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + 50);
    h.queue.enqueue(reject(1));
    await vi.advanceTimersByTimeAsync(400);
    expect(h.queue.snapshot().status).toBe("error");
    await h.queue.retry();
    expect(h.sent[3].records).toEqual([reject(1)]);
  });
});

describe("refusals", () => {
  it("stops on a new handover, and sends nothing more", async () => {
    const h = harness([{ status: 409, body: { error: "delivery_changed", manifest_id: "delivery-2" } }]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(1);
    const snap = h.queue.snapshot();
    expect(snap.stopped).toBe(true);
    expect(snap.refusal).toEqual({ kind: "delivery_changed", manifestId: "delivery-2" });
    h.queue.enqueue(approve(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 2);
    await h.queue.retry();
    expect(h.sent).toHaveLength(1);
  });

  it("stops once a run has started", async () => {
    const h = harness([{ status: 409, body: { error: "run_started", volume_id: "v-1" } }]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.queue.snapshot()).toMatchObject({ stopped: true, refusal: { kind: "run_started" } });
    expect(h.refused).toEqual([{ entries: [approve(1)], kind: "run_started" }]);
    h.queue.enqueue(approve(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 2);
    expect(h.sent).toHaveLength(1);
  });

  it("hands back a batch refused with 422 or 413, without retrying, and keeps working", async () => {
    const h = harness([
      { status: 422, body: { error: "unknown_records", captua_record_ids: [9] } },
      { status: 413, body: { error: "decisions_too_large" } },
      { status: 200, body: { decisionsId: "d-1" } },
    ]);
    h.queue.enqueue(approve(9));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.refused).toEqual([{ entries: [approve(9)], kind: "unknown" }]);
    expect(h.queue.snapshot()).toMatchObject({ status: "saved", stopped: false, refusal: { kind: "unknown" } });

    h.queue.enqueue(reject(3));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.refused[1]).toEqual({ entries: [reject(3)], kind: "too_large" });

    h.queue.enqueue(approve(4));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(3);
    expect(h.saved).toEqual([[approve(4)]]);
  });

  it("hands back a clear refused because the unit has the decision, and asks for a fresh read", async () => {
    const clear: DecisionEntry = { captuaRecordId: 7, decision: null, rotations: [] };
    const h = harness([
      { status: 409, body: { error: "decision_sent", captua_record_ids: [7] } },
      { status: 200, body: { decisionsId: "d-1" } },
    ]);
    let rereads = 0;
    h.queue.subscribe({ onReread: () => (rereads += 1) });
    h.queue.enqueue([clear, approve(8)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent[0].records).toEqual([clear, approve(8)]);
    // Only the clear is handed back to be put back as last saved; never retried.
    expect(h.refused).toEqual([{ entries: [clear], kind: "decision_sent" }]);
    expect(rereads).toBe(1);
    expect(h.queue.snapshot()).toMatchObject({ stopped: false, refusal: { kind: "decision_sent", captuaRecordIds: [7] } });
    // The approval the refusal did not name is sent again on its own.
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].records).toEqual([approve(8)]);
    expect(h.saved).toEqual([[approve(8)]]);
    // The queue keeps working.
    h.queue.enqueue(approve(9));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.saved).toEqual([[approve(8)], [approve(9)]]);
  });

  it("hands back only the openings a refusal names, and sends the rest again", async () => {
    const h = harness([
      { status: 400, body: { error: "invalid_request", detail: "records.1.side" } },
      { status: 200, body: { decisionsId: "d-1" } },
      { status: 422, body: { error: "unknown_captures", captures: [{ captua_record_id: 5, capture_id: "c", role: "left" }] } },
      { status: 200, body: { decisionsId: "d-2" } },
    ]);
    h.queue.enqueue([approve(1), reject(2), approve(3)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.refused).toEqual([{ entries: [reject(2)], kind: "refused" }]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent[1].records).toEqual([approve(1), approve(3)]);
    h.queue.enqueue([approve(5), approve(6)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.refused[1]).toEqual({ entries: [approve(5)], kind: "unknown" });
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent[3].records).toEqual([approve(6)]);
    expect(h.saved).toEqual([[approve(1), approve(3)], [approve(6)]]);
  });

  it("hands back the whole batch when a refusal names none of it, or cuts its list short", async () => {
    const h = harness([
      { status: 422, body: { error: "unknown_records", captua_record_ids: [1], omitted: 3 } },
      { status: 403, body: null },
    ]);
    h.queue.enqueue([approve(1), approve(2)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.refused[0].entries).toEqual([approve(1), approve(2)]);
    h.queue.enqueue([approve(3), approve(4)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.refused[1].entries).toEqual([approve(3), approve(4)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(2);
  });

  it("names every final answer", () => {
    expect(refusalOf({ status: 409, body: { error: "decision_sent", captua_record_ids: [3, 4] } })).toEqual({
      kind: "decision_sent",
      captuaRecordIds: [3, 4],
    });
    expect(refusalOf({ status: 500, body: null })).toBeNull();
    expect(refusalOf({ status: 429, body: null })).toBeNull();
    expect(refusalOf({ status: 409, body: { error: "no_capture_delivery" } })).toEqual({
      kind: "delivery_changed",
      manifestId: null,
    });
    expect(refusalOf({ status: 413, body: { error: "too_large" } })).toEqual({ kind: "too_large" });
    expect(refusalOf({ status: 400, body: { error: "invalid_request" } })).toEqual({ kind: "refused", status: 400 });
    expect(refusalOf({ status: 403, body: null })).toEqual({ kind: "refused", status: 403 });
  });
});

/** A sender whose answers the test releases one by one. */
function gated() {
  const sent: Body[] = [];
  const pending: Array<(a: QueueAnswer | Error) => void> = [];
  const send = (body: Body) => {
    sent.push(JSON.parse(JSON.stringify(body)));
    return new Promise<QueueAnswer>((resolve, reject) => {
      pending.push((a) => (a instanceof Error ? reject(a) : resolve(a)));
    });
  };
  const release = async (a: QueueAnswer | Error = { status: 200, body: { decisionsId: "d" } }) => {
    pending.shift()!(a);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { sent, send, release };
}

describe("the revision", () => {
  it("sends the revision it last knew and takes each answer's", async () => {
    const g = gated();
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 4, send: g.send });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent[0].expectedRevision).toBe(4);
    await g.release({ status: 200, body: { decisionsId: "d-1", revision: 5 } });
    queue.knowRevision(3);
    queue.enqueue(approve(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent[1].expectedRevision).toBe(5);
    await g.release({ status: 200, body: { decisionsId: "d-2", revision: 6 } });
    queue.knowRevision(9);
    queue.enqueue(approve(3));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent[2].expectedRevision).toBe(9);
  });

  it("sends no revision when it knows none", async () => {
    const h = harness([]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect("expectedRevision" in h.sent[0]).toBe(false);
  });

  it("reads again and resends once on the new revision when another write moved the set on", async () => {
    const g = gated();
    let rereads = 0;
    const saved: DecisionEntry[][] = [];
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 1, send: g.send });
    queue.subscribe({ onReread: () => (rereads += 1), onSaved: (e) => saved.push(e) });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // The page applies its fresh read; the held batch is sent.
    queue.readApplied();
    await vi.advanceTimersByTimeAsync(0);
    expect(rereads).toBe(1);
    expect(g.sent).toHaveLength(2);
    expect(g.sent[1]).toEqual({ manifestId: "delivery-1", records: [approve(1)], expectedRevision: 2 });
    await g.release({ status: 200, body: { decisionsId: "d-1", revision: 3 } });
    expect(saved).toEqual([[approve(1)]]);
    expect(queue.snapshot()).toMatchObject({ status: "saved", refusal: null });
  });

  it("records each save's revision, so a read taken before the resend landed is set aside", async () => {
    const g = gated();
    let rereads = 0;
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 1, send: g.send });
    queue.subscribe({ onReread: () => (rereads += 1) });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // The page applies its fresh read; the held batch is sent.
    queue.readApplied();
    await vi.advanceTimersByTimeAsync(0);
    expect(rereads).toBe(1);
    // The page's read is taken now, at revision 2; the resend then lands at 3.
    const readRevision = 2;
    await g.release({ status: 200, body: { decisionsId: "d-1", revision: 3 } });
    expect(queue.knownRevision()).toBe(3);
    expect(queue.saved()).toEqual([{ entry: approve(1), revision: 3, savedAt: expect.any(Number) }]);
    expect(staleRead(readRevision, queue.knownRevision())).toBe(true);
    expect(staleRead(3, queue.knownRevision())).toBe(false);
  });

  it("never lowers its revision, and keeps a save answered after a newer read off the screen", async () => {
    const g = gated();
    const saves: Array<number | null> = [];
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 1, send: g.send });
    queue.subscribe({ onSaved: (_e, _id, revision) => saves.push(revision) });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // The page applies its fresh read; the held batch is sent.
    queue.readApplied();
    await vi.advanceTimersByTimeAsync(0);
    // The resend commits the approval at 3, but its answer is late: another
    // reviewer rejects the opening at 4, and the page applies that read first.
    queue.knowRevision(4);
    await g.release({ status: 200, body: { decisionsId: "d-1", revision: 3 } });
    expect(queue.knownRevision()).toBe(4);
    expect(saves).toEqual([3]);
    expect(saveOvertaken(3, 4)).toBe(true);
    expect(saveOvertaken(5, 4)).toBe(false);
    const read = new Map<number, OpeningState>([[1, { decision: { decision: "rejected", reason: "blur", side: null, note: null, decidedBy: "Other", decidedAt: 1 }, turns: {} }]]);
    expect(afterSaved(read, [approve(1)], new Set(), { saved: 3, read: 4 }).get(1)).toBe(read.get(1));
    expect(afterSaved(read, [approve(1)], new Set(), { saved: 5, read: 4 }).get(1)!.decision?.decision).toBe("approved");
  });

  it("asks for a fresh read after a final conflict, and takes no change to its openings until it is applied", async () => {
    const g = gated();
    let rereads = 0;
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 1, send: g.send });
    queue.subscribe({ onReread: () => (rereads += 1) });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // The page applies its fresh read; the held batch is sent.
    queue.readApplied();
    await vi.advanceTimersByTimeAsync(0);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 3 } });
    expect(rereads).toBe(2);
    expect(queue.snapshot().refusal).toEqual({ kind: "revision_changed", revision: 3 });
    expect(queue.accepts(1)).toBe(false);
    expect(queue.accepts(2)).toBe(true);
    // A rotation on the refused opening is not taken; another opening's change is.
    queue.enqueue({ captuaRecordId: 1, decision: "approved", rotations: [{ captureId: "c", role: "left", quarterTurns: 1 }] });
    queue.enqueue(approve(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent).toHaveLength(3);
    expect(g.sent[2]).toEqual({ manifestId: "delivery-1", records: [approve(2)], expectedRevision: 3 });
    await g.release({ status: 200, body: { decisionsId: "d-2", revision: 4 } });
    // The fresh read is applied; the opening takes changes again.
    queue.readApplied();
    expect(queue.accepts(1)).toBe(true);
    queue.enqueue(reject(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent[3]).toEqual({ manifestId: "delivery-1", records: [reject(1)], expectedRevision: 4 });
  });

  it("puts the newer read back on screen when an outstanding entry turns out overtaken", () => {
    const rejected: OpeningState = { decision: { decision: "rejected", reason: "blur", side: null, note: null, decidedBy: "Other", decidedAt: 1 }, turns: {} };
    // The read at 4 was installed with the outstanding approval laid over it.
    const confirmed = new Map<number, OpeningState>([[1, rejected]]);
    const shown = overlayEntries(confirmed, [approve(1)]);
    expect(shown.get(1)!.decision?.decision).toBe("approved");
    // The approval's answer arrives: saved at 3, below the read.
    const after = afterSaved(shown, [approve(1)], new Set(), { saved: 3, read: 4, confirmed });
    expect(after.get(1)).toBe(rejected);
    // A newer change still outstanding for the opening stays.
    expect(afterSaved(shown, [approve(1)], new Set([1]), { saved: 3, read: 4, confirmed }).get(1)!.decision?.decision).toBe(
      "approved",
    );
  });

  it("keeps a final conflict's refusal and frozen openings for a viewer that attaches after it", async () => {
    const g = gated();
    const first = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", revision: 1, send: g.send, listener: {} });
    first.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    first.detach();
    // The conflicts are answered with no viewer attached (the first read
    // applied as the viewer left).
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // The page applies its fresh read; the held batch is sent.
    first.queue.readApplied();
    await vi.advanceTimersByTimeAsync(0);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 3 } });

    // A viewer attaches with a snapshot read at 2, older than the conflict.
    const second = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", revision: 2, send: g.send, listener: {} });
    expect(second.queue.snapshot().refusal).toEqual({ kind: "revision_changed", revision: 3 });
    expect(second.queue.accepts(1)).toBe(false);
    // The viewer sees its snapshot is stale and reads again.
    expect(staleRead(2, second.queue.knownRevision())).toBe(true);
    // The fresh read at 3 is applied: the opening takes changes, and the refusal can go.
    expect(staleRead(3, second.queue.knownRevision())).toBe(false);
    second.queue.readApplied();
    expect(second.queue.accepts(1)).toBe(true);
    second.queue.clearRefusal();
    expect(second.queue.snapshot().refusal).toBeNull();
  });

  it("holds a conflicted batch for the fresh read, and sends only what no one else changed", async () => {
    const g = gated();
    let rereads = 0;
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 1, send: g.send });
    queue.subscribe({ onReread: () => (rereads += 1) });
    queue.enqueue([approve(1), approve(2)]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    expect(rereads).toBe(1);
    // Nothing goes until the read is applied.
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 4);
    await queue.retry();
    expect(g.sent).toHaveLength(1);
    expect(queue.snapshot().status).toBe("unsaved");
    // The read shows another reviewer changed opening 1: its entry is dropped.
    queue.readApplied(2, [1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(g.sent[1]).toEqual({ manifestId: "delivery-1", records: [approve(2)], expectedRevision: 2 });
    expect(queue.outstanding()).toEqual([approve(2)]);
  });

  it("sends a held batch on the revision of the read that released it", async () => {
    const g = gated();
    const queue = createDecisionQueue({ manifestId: "delivery-1", revision: 1, send: g.send });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // Another write lands before the read; the read applied is at 3.
    queue.readApplied(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(g.sent[1]).toEqual({ manifestId: "delivery-1", records: [approve(1)], expectedRevision: 3 });
  });

  it("shows a second conflict instead of looping", async () => {
    const g = gated();
    const refused: string[] = [];
    const queue = createDecisionQueue({
      manifestId: "delivery-1",
      revision: 1,
      send: g.send,
      onRefused: (_e, r) => refused.push(r.kind),
    });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 2 } });
    // The page applies its fresh read; the held batch is sent.
    queue.readApplied();
    await vi.advanceTimersByTimeAsync(0);
    await g.release({ status: 409, body: { error: "revision_changed", revision: 3 } });
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 4);
    expect(g.sent).toHaveLength(2);
    expect(refused).toEqual(["revision_changed"]);
    expect(queue.snapshot()).toMatchObject({ status: "saved", stopped: false, refusal: { kind: "revision_changed", revision: 3 } });
    // The next change goes on the revision the refusal named.
    queue.enqueue(approve(2));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent[2].expectedRevision).toBe(3);
  });
});

describe("leaving the viewer", () => {
  it("sends a decision made just before leaving at once", async () => {
    const g = gated();
    const { queue, detach } = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener: {} });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(100);
    detach();
    await vi.advanceTimersByTimeAsync(0);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0].records).toEqual([approve(1)]);
  });

  it("tries a failed batch again on leaving", async () => {
    const h = harness([new Error("a"), new Error("b"), new Error("c")]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS + 300);
    expect(h.queue.snapshot().status).toBe("error");
    await h.queue.settle();
    expect(h.sent).toHaveLength(4);
    expect(h.queue.snapshot().status).toBe("saved");
  });
});

describe("a disposed queue", () => {
  it("sends nothing more when a request answers after it was disposed", async () => {
    const g = gated();
    const queue = createDecisionQueue({ manifestId: "delivery-1", send: g.send });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    queue.enqueue(approve(2));
    queue.dispose();
    await g.release();
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 4);
    expect(g.sent).toHaveLength(1);
    queue.enqueue(approve(3));
    await queue.retry();
    await queue.settle();
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 4);
    expect(g.sent).toHaveLength(1);
  });

  it("cuts a backoff short", async () => {
    const h = harness([new Error("a"), new Error("b"), new Error("c")]);
    h.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(h.sent).toHaveLength(1);
    h.queue.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sent).toHaveLength(1);
  });
});

describe("one queue per volume", () => {
  it("gives a viewer opened again the same queue, so a late write cannot overwrite a newer one", async () => {
    const g = gated();
    const first = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener: {} });
    first.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent).toHaveLength(1);
    first.detach();

    const second = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener: {} });
    expect(second.queue).toBe(first.queue);
    second.queue.enqueue(reject(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent).toHaveLength(1);

    await g.release();
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent.map((b) => b.records[0].decision)).toEqual(["approved", "rejected"]);
    await g.release();
    expect(second.queue.snapshot().status).toBe("saved");
  });

  it("hands a viewer opened during a save the entries still on their way, then tells it they were saved", async () => {
    const g = gated();
    const first = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener: {} });
    first.queue.enqueue(reject(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    first.detach();

    const attached: DecisionEntry[][] = [];
    const saved: DecisionEntry[][] = [];
    const second = attachDecisionQueue({
      volumeId: "v-1",
      manifestId: "delivery-1",
      send: g.send,
      listener: { onAttach: (e) => attached.push(e), onSaved: (e) => saved.push(e) },
    });
    expect(attached).toEqual([[reject(1)]]);
    expect(second.queue.outstanding()).toEqual([reject(1)]);
    await g.release();
    expect(saved).toEqual([[reject(1)]]);
    expect(second.queue.outstanding()).toEqual([]);
  });

  it("hands a viewer opened after a save it did not see what was saved", async () => {
    const g = gated();
    const first = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener: {} });
    first.queue.enqueue(reject(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    first.detach();
    // The save lands between the loader's read and the new viewer attaching.
    await g.release();

    let attached: { outstanding: DecisionEntry[]; saved: DecisionEntry[] } | null = null;
    attachDecisionQueue({
      volumeId: "v-1",
      manifestId: "delivery-1",
      send: g.send,
      listener: { onAttach: (o, s) => (attached = { outstanding: o, saved: s.map((x) => x.entry) }) },
    });
    expect(attached).toEqual({ outstanding: [], saved: [reject(1)] });

    // The loader read the earlier approval; the screen shows the rejection.
    const loaded = new Map<number, OpeningState>([
      [1, { decision: { decision: "approved", reason: null, side: null, note: null, decidedBy: "R", decidedAt: 1 }, turns: {} }],
    ]);
    const shown = overlayEntries(loaded, [...attached!.saved, ...attached!.outstanding]);
    expect(shown.get(1)!.decision).toMatchObject({ decision: "rejected", reason: "glare" });
  });

  it("disposes the queue of an earlier delivery", async () => {
    const g = gated();
    const old = queueFor("v-1", "delivery-1", () => createDecisionQueue({ manifestId: "delivery-1", send: g.send }));
    const fresh = queueFor("v-1", "delivery-2", () => createDecisionQueue({ manifestId: "delivery-2", send: g.send }));
    expect(fresh).not.toBe(old);
    old.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS * 2);
    expect(g.sent).toHaveLength(0);
    expect(queueFor("v-1", "delivery-2", () => createDecisionQueue({ manifestId: "x", send: g.send }))).toBe(fresh);
  });
});

describe("a refused batch", () => {
  it("drops the newer changes to its openings still waiting", async () => {
    const g = gated();
    const refused: DecisionEntry[][] = [];
    const queue = createDecisionQueue({
      manifestId: "delivery-1",
      send: g.send,
      onRefused: (entries) => refused.push(entries),
    });
    queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    queue.enqueue([reject(1), approve(2)]);
    await g.release({ status: 413, body: { error: "decisions_too_large" } });
    expect(refused).toEqual([[approve(1)]]);
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent).toHaveLength(2);
    expect(g.sent[1].records).toEqual([approve(2)]);
    await g.release();
    expect(queue.snapshot().status).toBe("saved");
  });
});

describe("the development double mount", () => {
  it("leaves a queue that still sends after attach, detach and attach again", async () => {
    const g = gated();
    const statuses: string[] = [];
    const listener = { onChange: (s: QueueSnapshot) => statuses.push(s.status) };
    const a = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener });
    a.detach();
    const b = attachDecisionQueue({ volumeId: "v-1", manifestId: "delivery-1", send: g.send, listener });
    expect(b.queue).toBe(a.queue);
    b.queue.enqueue(approve(1));
    await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS);
    expect(g.sent).toHaveLength(1);
    await g.release();
    expect(statuses.at(-1)).toBe("saved");
    expect(statuses).toContain("saving");
  });
});

// @version v0.8.0
