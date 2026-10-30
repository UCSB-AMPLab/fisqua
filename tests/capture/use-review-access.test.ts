/**
 * Tests — access to the review tiles
 *
 * This suite drives `createReviewAccess` (`use-review-access.ts`) with a
 * stand-in for the review-access route and fake timers, and pins how
 * the capture QC viewer keeps a download authorisation for the review
 * tiles:
 *
 *   - the first read: the delivery on screen, chosen by id rather than
 *     by `current`, its token and its base address
 *     `{downloadUrl}/file/{bucket}/{prefix}`, and every delivery's base
 *     (`bases`) and token (`token(deliveryId)`), all ending together;
 *   - the refresh: asked for five minutes before `expires`, never
 *     sooner than 30 seconds after an answer, and the new token answered
 *     by `token()` from then on;
 *   - a failed refresh: the token in hand kept while it lives, a new try
 *     every minute, `unavailable` once the token has expired, and
 *     `ready` again when a try succeeds;
 *   - expiry watched apart from the reads: a refresh that never answers
 *     is aborted after 30 seconds and tried again, and at `expires` the
 *     state is `unavailable` and `token()` null, whatever the reads are
 *     doing, and `token()` asked past `expires` before the timer has run
 *     (a suspended tab) answers null and makes the same change once;
 *   - a failed first read: `none` for 404 `no_review_tiles` and 409
 *     `no_review_bucket`, `unavailable` for any other answer, a network
 *     failure or an answer with no usable delivery, and nothing asked
 *     again;
 *   - an answer holding only an earlier delivery (the current one's
 *     tiles still being prepared): ready, with no base for the delivery
 *     on screen and the earlier delivery's base and token;
 *   - a disposed instance: nothing more asked, a read on its way
 *     aborted, no timer left, and a late answer dropped.
 *
 * The suite has no DOM renderer, so `useReviewAccess`, which runs one
 * instance in an effect, is not rendered here.
 *
 * Every value here is a test value.
 *
 * @version v0.8.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReviewAccess, type ReviewAccessState } from "../../app/lib/capture/use-review-access";

const T0 = Date.UTC(2026, 9, 26, 12);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function answer(token: string, expiresAt: number, extra: object[] = []) {
  return {
    status: 200,
    body: {
      downloadUrl: "https://f000.backblazeb2.test",
      bucket: "review-tiles",
      expires: new Date(expiresAt).toISOString(),
      deliveries: [
        ...extra,
        { deliveryId: "delivery-1", prefix: "co-test/delivery-1/", authorizationToken: token, current: false },
      ],
    },
  };
}

/** "hang": a read that never answers, until its signal aborts it. */
type Reply = { status: number; body: unknown } | Error | Promise<{ status: number; body: unknown }> | "hang";

function harness(replies: Reply[]) {
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  const states: ReviewAccessState[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    signals.push(init!.signal!);
    const next = replies.shift();
    if (next === undefined) throw new Error("no reply left");
    if (next === "hang") {
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (next instanceof Error) throw next;
    const r = await next;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  const access = createReviewAccess({
    volumeId: "vol-1",
    deliveryId: "delivery-1",
    fetch: fetchStub as unknown as typeof fetch,
    onChange: (s) => states.push(s),
  });
  return { access, urls, signals, states, fetchStub };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the first read", () => {
  it("takes the delivery on screen by id, its token and its base address", async () => {
    const newer = {
      deliveryId: "delivery-2",
      prefix: "co-test/delivery-2/",
      authorizationToken: "token-newer",
      current: true,
    };
    const { access, urls } = harness([answer("token-1", T0 + HOUR, [newer])]);
    expect(access.snapshot()).toEqual({ status: "loading" });
    expect(access.token()).toBeNull();
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual(["/admin/capture/volumes/vol-1/review-access"]);
    expect(access.snapshot()).toEqual({
      status: "ready",
      base: "https://f000.backblazeb2.test/file/review-tiles/co-test/delivery-1/",
      bases: {
        "delivery-1": "https://f000.backblazeb2.test/file/review-tiles/co-test/delivery-1/",
        "delivery-2": "https://f000.backblazeb2.test/file/review-tiles/co-test/delivery-2/",
      },
      expires: T0 + HOUR,
    });
    expect(access.token()).toBe("token-1");
    access.dispose();
  });

  it("keeps every delivery's base and token, answering each by id until they expire", async () => {
    const earlier = { deliveryId: "delivery-0", prefix: "co-test/delivery-0/", authorizationToken: "token-0", current: false };
    const { access } = harness([answer("token-1", T0 + HOUR, [earlier]), answer("token-1b", T0 + 2 * HOUR)]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(access.token("delivery-0")).toBe("token-0");
    expect(access.token("delivery-1")).toBe("token-1");
    expect(access.token()).toBe("token-1");
    expect(access.token("delivery-9")).toBeNull();
    // A refresh without the earlier delivery leaves it no token.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(access.token("delivery-0")).toBeNull();
    expect(access.token()).toBe("token-1b");
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(access.token("delivery-1")).toBeNull();
    access.dispose();
  });

  it("starts once", async () => {
    const { access, fetchStub } = harness([answer("token-1", T0 + HOUR)]);
    access.start();
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    access.dispose();
  });
});

describe("the refresh", () => {
  it("asks again five minutes before the token expires and answers the new token", async () => {
    const { access, fetchStub } = harness([answer("token-1", T0 + HOUR), answer("token-2", T0 + 2 * HOUR)]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(55 * MINUTE - 1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(access.token()).toBe("token-1");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(access.token()).toBe("token-2");
    expect(access.snapshot()).toMatchObject({ status: "ready", expires: T0 + 2 * HOUR });
    access.dispose();
  });

  it("waits at least 30 seconds after an answer that is near its end", async () => {
    const { access, fetchStub } = harness([answer("token-1", T0 + 2 * MINUTE), answer("token-2", T0 + HOUR)]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30 * 1000 - 1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(access.token()).toBe("token-2");
    access.dispose();
  });
});

describe("a failed refresh", () => {
  it("keeps the token while it lives, tries every minute, and is unavailable once it has expired", async () => {
    const { access, fetchStub, states } = harness([
      answer("token-1", T0 + HOUR),
      { status: 503, body: { error: "review_storage_unavailable" } },
      new Error("network"),
      { status: 503, body: { error: "review_storage_unavailable" } },
      { status: 503, body: { error: "review_storage_unavailable" } },
      { status: 503, body: { error: "review_storage_unavailable" } },
      { status: 503, body: { error: "review_storage_unavailable" } },
      answer("token-2", T0 + 2 * HOUR),
    ]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    // The refresh at 55 minutes fails, and so do the tries at 56 to 59.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(access.snapshot().status).toBe("ready");
    expect(access.token()).toBe("token-1");
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(6);
    expect(access.snapshot().status).toBe("ready");
    // The try at 60 minutes fails after the token has expired.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(7);
    expect(access.snapshot()).toEqual({ status: "unavailable" });
    // The try at 61 minutes succeeds.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(8);
    expect(access.snapshot()).toMatchObject({ status: "ready", expires: T0 + 2 * HOUR });
    expect(access.token()).toBe("token-2");
    expect(states.map((s) => s.status)).toEqual(["ready", "unavailable", "ready"]);
    access.dispose();
  });
});

describe("expiry", () => {
  it("ends the token at expires while a refresh hangs, aborts the hung read, and keeps trying", async () => {
    const { access, fetchStub, signals, states } = harness([
      answer("token-1", T0 + HOUR),
      "hang",
      "hang",
      "hang",
      "hang",
      "hang",
      "hang",
      answer("token-2", T0 + 2 * HOUR),
    ]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    // The refresh at 55 minutes hangs; it is aborted 30 seconds later.
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(signals[1].aborted).toBe(true);
    expect(access.snapshot().status).toBe("ready");
    // A try a minute after the abort, which hangs too.
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    // Just before expires the token still serves, with a read on its way.
    await vi.advanceTimersByTimeAsync(T0 + HOUR - 1 - Date.now());
    expect(access.token()).toBe("token-1");
    expect(access.snapshot().status).toBe("ready");
    await vi.advanceTimersByTimeAsync(1);
    expect(access.snapshot()).toEqual({ status: "unavailable" });
    expect(access.token()).toBeNull();
    // Tries go on every 90 seconds (30 to time out, 60 to wait) until one succeeds.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(fetchStub).toHaveBeenCalledTimes(8);
    expect(access.snapshot()).toMatchObject({ status: "ready", expires: T0 + 2 * HOUR });
    expect(access.token()).toBe("token-2");
    expect(states.map((s) => s.status)).toEqual(["ready", "unavailable", "ready"]);
    access.dispose();
  });

  it("ends the token when asked past expires, before a late expiry timer runs", async () => {
    const { access, states } = harness([answer("token-1", T0 + HOUR)]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    // A suspended tab: the clock moves on and no timer has run.
    vi.setSystemTime(T0 + HOUR - 1);
    expect(access.token()).toBe("token-1");
    vi.setSystemTime(T0 + HOUR + 5 * MINUTE);
    expect(access.token()).toBeNull();
    expect(access.snapshot()).toEqual({ status: "unavailable" });
    expect(access.token()).toBeNull();
    expect(states.map((s) => s.status)).toEqual(["ready", "unavailable"]);
    access.dispose();
  });

  it("ends the token at expires even with the refresh still to come", async () => {
    // An answer that expires sooner than the 30-second floor on the refresh.
    const { access, fetchStub } = harness([answer("token-1", T0 + 10 * 1000), answer("token-2", T0 + HOUR)]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * 1000);
    expect(access.snapshot()).toEqual({ status: "unavailable" });
    expect(access.token()).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20 * 1000);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(access.token()).toBe("token-2");
    access.dispose();
  });

  it("is unavailable when the first read hangs past the timeout, and asks nothing more", async () => {
    const { access, fetchStub, signals } = harness(["hang"]);
    access.start();
    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(signals[0].aborted).toBe(true);
    expect(access.snapshot()).toEqual({ status: "unavailable" });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    access.dispose();
  });
});

describe("an earlier delivery's tiles alone", () => {
  it("is ready with no base for the delivery on screen, and answers the earlier delivery's token", async () => {
    // The current delivery's tiles are still being prepared; an earlier one's can be read.
    const { access } = harness([
      {
        status: 200,
        body: {
          downloadUrl: "https://f000.backblazeb2.test",
          bucket: "review-tiles",
          expires: new Date(T0 + HOUR).toISOString(),
          deliveries: [{ deliveryId: "delivery-0", prefix: "co-test/delivery-0/", authorizationToken: "token-0", current: false }],
        },
      },
    ]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(access.snapshot()).toEqual({
      status: "ready",
      base: null,
      bases: { "delivery-0": "https://f000.backblazeb2.test/file/review-tiles/co-test/delivery-0/" },
      expires: T0 + HOUR,
    });
    expect(access.token()).toBeNull();
    expect(access.token("delivery-0")).toBe("token-0");
    access.dispose();
  });
});

describe("a failed first read", () => {
  const cases: Array<[string, Reply, ReviewAccessState["status"]]> = [
    ["404 no_review_tiles", { status: 404, body: { error: "no_review_tiles" } }, "none"],
    ["409 no_review_bucket", { status: 409, body: { error: "no_review_bucket" } }, "none"],
    ["503 review_storage_unavailable", { status: 503, body: { error: "review_storage_unavailable" } }, "unavailable"],
    ["a bare 403", { status: 403, body: null }, "unavailable"],
    ["a network failure", new Error("network"), "unavailable"],
    [
      "an answer with no usable delivery",
      {
        status: 200,
        body: {
          downloadUrl: "https://f000.backblazeb2.test",
          bucket: "review-tiles",
          expires: new Date(T0 + HOUR).toISOString(),
          deliveries: [{ deliveryId: "delivery-2", prefix: "co-test/delivery-2/" }],
        },
      },
      "unavailable",
    ],
  ];
  for (const [name, reply, status] of cases) {
    it(`is ${status} after ${name}, and asks nothing more`, async () => {
      const { access, fetchStub } = harness([reply]);
      access.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(access.snapshot()).toEqual({ status });
      expect(access.token()).toBeNull();
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      access.dispose();
    });
  }
});

describe("a disposed instance", () => {
  it("asks nothing more and leaves no timer", async () => {
    const { access, fetchStub } = harness([answer("token-1", T0 + HOUR)]);
    access.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    access.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("aborts a read on its way and clears its timeout", async () => {
    const { access, signals, states } = harness([answer("token-1", T0 + HOUR), "hang"]);
    access.start();
    await vi.advanceTimersByTimeAsync(55 * MINUTE);
    expect(signals[1].aborted).toBe(false);
    access.dispose();
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(states.map((s) => s.status)).toEqual(["ready"]);
  });

  it("drops an answer that arrives late", async () => {
    let release!: (r: { status: number; body: unknown }) => void;
    const late = new Promise<{ status: number; body: unknown }>((resolve) => {
      release = resolve;
    });
    const { access, states } = harness([late]);
    access.start();
    access.dispose();
    release(answer("token-1", T0 + HOUR));
    await vi.advanceTimersByTimeAsync(0);
    expect(access.snapshot()).toEqual({ status: "loading" });
    expect(access.token()).toBeNull();
    expect(states).toEqual([]);
  });
});

// @version v0.8.0
