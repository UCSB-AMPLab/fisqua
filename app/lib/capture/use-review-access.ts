/**
 * Capture QC Viewer — Access to the Review Tiles
 *
 * This module deals with keeping the capture QC viewer able to read a
 * volume's review tiles from B2. It asks the review-access route,
 * `GET /admin/capture/volumes/:volumeId/review-access`
 * (`reviewAccessLoader` in `review-access.server.ts`), for a download
 * authorisation token limited to one delivery's prefix, and asks again
 * before that token expires.
 *
 * `createReviewAccess` holds the state. It reads the route on `start`
 * and takes the delivery the viewer shows (`deliveryId`, the loader's
 * `manifestId`) rather than whichever is `current` by then, so a
 * handover that arrives while the page is open never puts its images
 * under the openings of the one on screen. It keeps every delivery's
 * token and base address the answer gives, `bases` by delivery id, each
 * `{downloadUrl}/file/{bucket}/{prefix}`, under which each page's tiles
 * sit at `{page key}/`; `base` is the delivery on screen's, or null
 * when the answer holds only earlier deliveries (the current one's tiles
 * are still being prepared, while an earlier one's can be read). Earlier
 * deliveries' tiles are those the viewer compares a retaken opening
 * with. It asks again
 * `REFRESH_EARLY_MS` (five minutes) before `expires`, never sooner than
 * `MIN_DELAY_MS` from now, so an answer that is already near its end
 * cannot make it ask in a tight loop. A read that has no answer after
 * `READ_TIMEOUT_MS` is aborted and counts as failed. A refresh that
 * fails keeps the token it has and tries again every `RETRY_MS`. The
 * token's expiry is watched by its own timer, apart from any read: at
 * `expires` the state is `unavailable` and `token()` answers null, even
 * while a refresh is still on its way, until a later try succeeds.
 * `token()` also compares the clock with `expires` itself, since a
 * browser can run a suspended tab's timers late; past it, it makes the
 * same change the timer would, once.
 * `token(deliveryId)` answers the newest live token for a delivery, the
 * one on screen when none is named, so a tile address built when the
 * tile is loaded (`reviewTileSource`) carries it. Every token of one
 * answer shares its `expires`.
 *
 * The states: `loading` until the first answer; `ready`, with the base
 * address and the token's expiry; `none` when the volume has no review
 * tiles to read (404 `no_review_tiles`, or 409 `no_review_bucket` for a
 * federation without a review-tiles bucket); and `unavailable` for any
 * other failure, an answer with no usable delivery included. A
 * first read that fails is not tried again. The viewer keeps its
 * placeholders in every state but `ready`. A disposed instance clears
 * its timers, aborts a read on its way, asks nothing more and drops
 * answers that arrive late.
 *
 * `useReviewAccess` runs one instance for a volume's delivery in an
 * effect, never during a server render, and disposes it on unmount or
 * when either changes. With `enabled` false it asks nothing and reports
 * `none`.
 *
 * @version v0.8.0
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** How long before the token's expiry a new one is asked for. */
const REFRESH_EARLY_MS = 5 * 60 * 1000;
/** The shortest wait before asking again after an answer. */
const MIN_DELAY_MS = 30 * 1000;
/** How long to wait before trying a failed refresh again. */
const RETRY_MS = 60 * 1000;
/** How long one read of the route may take before it is abandoned. */
const READ_TIMEOUT_MS = 30 * 1000;

export type ReviewAccessState =
  | { status: "loading" }
  | { status: "ready"; base: string | null; bases: Record<string, string>; expires: number }
  | { status: "none" }
  | { status: "unavailable" };

type Read =
  | { ok: true; base: string | null; bases: Record<string, string>; tokens: Record<string, string>; expires: number }
  | { ok: false; kind: "none" | "unavailable" };

function reviewAccessUrl(volumeId: string): string {
  return `/admin/capture/volumes/${encodeURIComponent(volumeId)}/review-access`;
}

async function readAccess(
  fetchFn: typeof fetch,
  volumeId: string,
  deliveryId: string,
  signal: AbortSignal,
): Promise<Read> {
  let res: Response;
  try {
    res = await fetchFn(reviewAccessUrl(volumeId), { headers: { Accept: "application/json" }, signal });
  } catch {
    return { ok: false, kind: "unavailable" };
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const none =
      (res.status === 404 && body?.error === "no_review_tiles") ||
      (res.status === 409 && body?.error === "no_review_bucket");
    return { ok: false, kind: none ? "none" : "unavailable" };
  }
  const expires = Date.parse(body?.expires);
  if (
    typeof body?.downloadUrl !== "string" ||
    typeof body?.bucket !== "string" ||
    !Array.isArray(body?.deliveries) ||
    !Number.isFinite(expires)
  ) {
    return { ok: false, kind: "unavailable" };
  }
  const root = `${body.downloadUrl.replace(/\/+$/, "")}/file/${body.bucket}/`;
  const bases: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const d of body.deliveries) {
    if (typeof d?.deliveryId !== "string" || typeof d?.prefix !== "string" || typeof d?.authorizationToken !== "string") continue;
    bases[d.deliveryId] = `${root}${d.prefix}`;
    tokens[d.deliveryId] = d.authorizationToken;
  }
  // The delivery on screen may have no tiles yet while an earlier one's
  // can be read; an answer with no usable delivery at all is a failure.
  if (Object.keys(bases).length === 0) return { ok: false, kind: "unavailable" };
  return { ok: true, base: bases[deliveryId] ?? null, bases, tokens, expires };
}

export function createReviewAccess(options: {
  volumeId: string;
  /** The delivery on screen. */
  deliveryId: string;
  fetch?: typeof fetch;
  onChange?: (state: ReviewAccessState) => void;
}) {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  let state: ReviewAccessState = { status: "loading" };
  let tokens: Record<string, string> | null = null;
  let tokenExpires = 0;
  let hadAccess = false;
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let abortTimer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  let started = false;

  const set = (next: ReviewAccessState) => {
    state = next;
    options.onChange?.(next);
  };
  const clear = (t: ReturnType<typeof setTimeout> | null) => {
    if (t !== null) clearTimeout(t);
    return null;
  };
  const schedule = (delay: number) => {
    readTimer = clear(readTimer);
    readTimer = setTimeout(() => {
      readTimer = null;
      void read();
    }, delay);
  };
  // The token's end, watched apart from any read: a refresh still on
  // its way when the token expires cannot leave it in use.
  const expire = () => {
    expiryTimer = clear(expiryTimer);
    tokens = null;
    if (state.status !== "unavailable") set({ status: "unavailable" });
  };
  const watchExpiry = (at: number) => {
    expiryTimer = clear(expiryTimer);
    expiryTimer = setTimeout(expire, Math.max(0, at - Date.now()));
  };

  async function read(): Promise<void> {
    const ac = new AbortController();
    controller = ac;
    abortTimer = setTimeout(() => ac.abort(), READ_TIMEOUT_MS);
    const result = await readAccess(fetchFn, options.volumeId, options.deliveryId, ac.signal);
    if (disposed) return;
    abortTimer = clear(abortTimer);
    controller = null;
    if (result.ok) {
      hadAccess = true;
      tokens = result.tokens;
      tokenExpires = result.expires;
      set({ status: "ready", base: result.base, bases: result.bases, expires: result.expires });
      watchExpiry(result.expires);
      schedule(Math.max(MIN_DELAY_MS, result.expires - REFRESH_EARLY_MS - Date.now()));
      return;
    }
    if (!hadAccess) {
      set({ status: result.kind });
      return;
    }
    // A failed refresh: the token in hand serves until the expiry timer ends it.
    schedule(RETRY_MS);
  }

  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      void read();
    },
    /** The newest token for a delivery (the one on screen by default) while it lives, read when a tile is loaded. */
    // Checked against the clock too, since a suspended tab can run the
    // expiry timer late.
    token: (deliveryId: string = options.deliveryId): string | null => {
      if (tokens !== null && Date.now() >= tokenExpires) expire();
      return tokens?.[deliveryId] ?? null;
    },
    snapshot: (): ReviewAccessState => state,
    dispose(): void {
      disposed = true;
      readTimer = clear(readTimer);
      expiryTimer = clear(expiryTimer);
      abortTimer = clear(abortTimer);
      controller?.abort();
      controller = null;
    },
  };
}

/**
 * The review tiles' access for a volume's delivery: its state, and a
 * stable function answering the newest token for a delivery, the one on
 * screen when none is named.
 */
export function useReviewAccess(volumeId: string, deliveryId: string, enabled = true) {
  const [state, setState] = useState<ReviewAccessState>(() => (enabled ? { status: "loading" } : { status: "none" }));
  const tokenRef = useRef<(deliveryId?: string) => string | null>(() => null);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "none" });
      return;
    }
    const access = createReviewAccess({ volumeId, deliveryId, onChange: setState });
    tokenRef.current = access.token;
    setState({ status: "loading" });
    access.start();
    return () => {
      access.dispose();
      tokenRef.current = () => null;
    };
  }, [volumeId, deliveryId, enabled]);

  const token = useCallback((id?: string) => tokenRef.current(id), []);
  return { state, token };
}

// @version v0.8.0
