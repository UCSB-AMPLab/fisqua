/**
 * Tests — autosave bounded-retry helper
 *
 * This suite pins the contract of `withBoundedRetry` from
 * `app/lib/autosave-retry.ts` — the pure helper that both editor
 * autosave paths compose against. Earlier versions of the editor
 * silently retried autosave failures forever via
 * `setTimeout(MARK_DIRTY, 3000)` (viewer side) or swallowed them
 * with a bare `.catch()` (description editor side).
 * `withBoundedRetry` replaces both patterns with a bounded retry +
 * exponential backoff that settles to a discriminated
 * `{ ok: false, error, attempts }` after exhausting its budget, so
 * callers can render an error UI without a try/catch dance.
 *
 * These tests use vitest's fake timers and `vi.advanceTimersByTimeAsync`
 * (not the sync variant — the helper awaits microtasks between timer
 * ticks, and the sync advance would deadlock). Each behaviour case is
 * one `it(...)` block; the suite is pure (no React, no D1, no fetch).
 *
 * @version v0.4.1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withBoundedRetry,
  type SaveResult,
} from "../../app/lib/autosave-retry";

describe("withBoundedRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on first attempt: returns {ok:true} immediately, saveFn called once", async () => {
    const saveFn = vi.fn().mockResolvedValue({ ok: true });

    const result = await withBoundedRetry(saveFn);

    expect(result).toEqual({ ok: true });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on retry: {ok:false} once then {ok:true} resolves after one 1000ms backoff", async () => {
    const saveFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "transient" })
      .mockResolvedValueOnce({ ok: true });

    const promise = withBoundedRetry(saveFn);

    // First attempt fires immediately; helper now waits 1000ms.
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(saveFn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and settles to {ok:false, error, attempts:3} after exactly 3 failed attempts", async () => {
    const saveFn = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "HTTP 500" });

    const promise = withBoundedRetry(saveFn);

    // Backoffs after attempts 1 and 2: 1000ms + 2000ms = 3000ms total.
    // No backoff AFTER the third failure — the helper just settles.
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result).toEqual({
      ok: false,
      error: "HTTP 500",
      attempts: 3,
    });
    expect(saveFn).toHaveBeenCalledTimes(3);
  });

  it("treats throws as failed attempts: throw once then {ok:true} resolves to {ok:true}", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blew up"))
      .mockResolvedValueOnce({ ok: true });

    const promise = withBoundedRetry(saveFn);

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(saveFn).toHaveBeenCalledTimes(2);
  });

  it("captures the last thrown error in the settled result when all attempts throw", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("third"));

    const promise = withBoundedRetry(saveFn);
    await vi.advanceTimersByTimeAsync(3000);

    const result = (await promise) as Extract<SaveResult, { ok: false }>;
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toBe("third");
  });

  it("exponential backoff timing matches base * 2^(n-1) - with maxAttempts=4, baseMs=100, waits are 100/200/400ms", async () => {
    const saveFn = vi.fn().mockResolvedValue({ ok: false, error: "x" });

    const promise = withBoundedRetry(saveFn, { maxAttempts: 4, baseMs: 100 });

    // After attempt 1: helper waits 100ms before attempt 2.
    expect(saveFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(saveFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveFn).toHaveBeenCalledTimes(2);

    // After attempt 2: 200ms before attempt 3.
    await vi.advanceTimersByTimeAsync(199);
    expect(saveFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveFn).toHaveBeenCalledTimes(3);

    // After attempt 3: 400ms before attempt 4.
    await vi.advanceTimersByTimeAsync(399);
    expect(saveFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveFn).toHaveBeenCalledTimes(4);

    const result = await promise;
    expect(result).toEqual({ ok: false, error: "x", attempts: 4 });
  });

  it("does not throw on save failure - failure is in the return type (no try/catch needed at the caller)", async () => {
    const saveFn = vi.fn().mockResolvedValue({ ok: false, error: "boom" });

    // The whole point of the contract: callers can `const r = await
    // withBoundedRetry(...)` and discriminate on `r.ok` without a
    // try/catch around the await.
    const promise = withBoundedRetry(saveFn);
    await vi.advanceTimersByTimeAsync(3000);

    // If the helper threw, this expect would reject. Instead we get a
    // resolved discriminated union.
    await expect(promise).resolves.toMatchObject({ ok: false });
  });

  it("AbortSignal aborts mid-backoff: aborting during the 1s wait resolves to {ok:false, error:'aborted', attempts:<so-far>}", async () => {
    const saveFn = vi.fn().mockResolvedValue({ ok: false, error: "x" });
    const controller = new AbortController();

    const promise = withBoundedRetry(saveFn, { signal: controller.signal });

    // Let the first failed attempt land, then abort during the backoff
    // wait (before the second attempt fires).
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledTimes(1);

    controller.abort();
    // Drain microtasks so the abort listener runs.
    await vi.advanceTimersByTimeAsync(0);

    const result = (await promise) as Extract<SaveResult, { ok: false }>;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
    // Helper made one attempt before the abort.
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
  });

  it("AbortSignal already aborted before first attempt: returns {ok:false, error:'aborted', attempts:0} without calling saveFn", async () => {
    const saveFn = vi.fn().mockResolvedValue({ ok: true });
    const controller = new AbortController();
    controller.abort();

    const result = (await withBoundedRetry(saveFn, {
      signal: controller.signal,
    })) as Extract<SaveResult, { ok: false }>;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
    expect(result.attempts).toBe(0);
    expect(saveFn).not.toHaveBeenCalled();
  });
});

/* @version v0.4.1 */
