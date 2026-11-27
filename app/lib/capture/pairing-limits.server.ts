/**
 * Capture Pairing — Rate Counters
 *
 * This module counts hits against the fixed-window limits of the
 * pairing routes: code requests per client address, and wrong code
 * entries per user and per workspace. `countHit` keeps one row per
 * limit key in `capture_pairing_limits` and counts in a single UPSERT,
 * so concurrent requests are counted exactly: `countHit` inserts the
 * first hit of a key, restarts the count at 1 when the stored window is
 * older than this request's window, and otherwise adds 1 to the stored
 * count, and reads back the count and the window it belongs to. The
 * stored window never moves backwards: a request whose `now` falls in a
 * window older than the stored one is counted in the stored window.
 *
 * A window is `floor(now / windowMs) * windowMs`. Hits 1 to `limit` in
 * a window are ok; every later hit in the same window is refused with
 * `retryAfterSeconds`, the whole seconds until the end of the window the
 * count belongs to, rounded up and at least 1. `countHit` increments the
 * stored count for a refused hit too, and gives the window the hit was
 * counted in (`windowStart`).
 *
 * `uncountHit` gives one hit back, in one UPDATE, only where the stored
 * window is still the one the hit was counted in and the count is above
 * zero. A give-back that arrives after the count has moved to a newer
 * window changes nothing, so it cannot let an extra hit into that
 * window. A caller that must refuse every entry past a limit, right or
 * wrong, counts every entry first, which holds under concurrent
 * requests, and gives the hit back once the entry turns out to be
 * right.
 *
 * The caller builds the keys (`codes-ip:<sha256 of the client
 * address>`, `entry-user:<userId>`, `entry-tenant:<tenantId>`); this
 * module only counts.
 *
 * @version v0.9.0
 */
import { and, eq, gt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { capturePairingLimits } from "../../db/schema";

/** Whether the hit is within the limit, and the window it was counted in (`windowStart`). */
export type CountResult = { ok: true; windowStart: number } | { ok: false; retryAfterSeconds: number; windowStart: number };

export async function countHit(
  db: DrizzleD1Database<any>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<CountResult> {
  const window = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .insert(capturePairingLimits)
    .values({ key, windowStart: window, count: 1 })
    .onConflictDoUpdate({
      target: capturePairingLimits.key,
      set: {
        // Both expressions read the stored row as it was before this update.
        count: sql`CASE WHEN ${capturePairingLimits.windowStart} >= ${window} THEN ${capturePairingLimits.count} + 1 ELSE 1 END`,
        windowStart: sql`MAX(${capturePairingLimits.windowStart}, ${window})`,
      },
    })
    .returning({ count: capturePairingLimits.count, windowStart: capturePairingLimits.windowStart })
    .get();
  if (row.count <= limit) return { ok: true, windowStart: row.windowStart };
  return { ok: false, retryAfterSeconds: secondsLeft(row.windowStart, windowMs, now), windowStart: row.windowStart };
}

/**
 * Gives back one hit counted against `key` in the window `countHit`
 * gave for it (`chargedWindowStart`), in one UPDATE, never below zero.
 * Once the stored count has moved to another window, nothing changes.
 */
export async function uncountHit(db: DrizzleD1Database<any>, key: string, chargedWindowStart: number): Promise<void> {
  await db
    .update(capturePairingLimits)
    .set({ count: sql`${capturePairingLimits.count} - 1` })
    .where(
      and(
        eq(capturePairingLimits.key, key),
        eq(capturePairingLimits.windowStart, chargedWindowStart),
        gt(capturePairingLimits.count, 0),
      ),
    )
    .run();
}

function secondsLeft(window: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((window + windowMs - now) / 1000));
}

// @version v0.9.0
