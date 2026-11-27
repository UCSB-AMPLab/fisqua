/**
 * Tests — the pairing rate counters
 *
 * This suite drives `countHit`, the fixed-window counter behind the
 * pairing limits, against the test D1 database with a clock the tests
 * set. It pins:
 *
 *   - hits 1 to `limit` in a window are ok and every later hit in the
 *     same window is refused, with `retryAfterSeconds` at least 1 and,
 *     for a hit whose `now` is in the stored window, at most the window
 *     in seconds;
 *   - `retryAfterSeconds` is the whole seconds until the window ends,
 *     rounded up;
 *   - a hit in the next window is ok again and `countHit` restarts the
 *     count at 1;
 *   - a hit whose `now` is in a window older than the stored one is
 *     counted in the stored window, which does not move back, and its
 *     `retryAfterSeconds` runs to the end of the stored window;
 *   - two keys count separately;
 *   - concurrent hits on one key are counted exactly, with no hit lost;
 *   - `countHit` gives the window its hit was counted in, and
 *     `uncountHit` gives one hit back only in that window: once the
 *     count has moved to a newer window a late give-back changes
 *     nothing, so it lets no extra hit through; nor does it go below
 *     zero or touch a key with no row.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { countHit, uncountHit } from "../../app/lib/capture/pairing-limits.server";
import { capturePairingLimits } from "../../app/db/schema";

const WINDOW_MS = 10 * 60 * 1000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % WINDOW_MS);

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDatabase();
});

describe("countHit", () => {
  it("accepts hits 1 to the limit and refuses the next", async () => {
    const db = drizzle(env.DB);
    for (let i = 1; i <= 20; i++) {
      expect(await countHit(db, "codes-ip:aa", 20, WINDOW_MS, T0 + i)).toMatchObject({ ok: true });
    }
    const refused = await countHit(db, "codes-ip:aa", 20, WINDOW_MS, T0 + 21);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(WINDOW_MS / 1000);
    }
    const again = await countHit(db, "codes-ip:aa", 20, WINDOW_MS, T0 + 22);
    expect(again.ok).toBe(false);
  });

  it("reports the whole seconds to the end of the window, rounded up", async () => {
    const db = drizzle(env.DB);
    await countHit(db, "k", 1, WINDOW_MS, T0);
    const refused = await countHit(db, "k", 1, WINDOW_MS, T0 + WINDOW_MS - 1500);
    expect(refused).toMatchObject({ ok: false, retryAfterSeconds: 2 });
    const last = await countHit(db, "k", 1, WINDOW_MS, T0 + WINDOW_MS - 1);
    expect(last).toMatchObject({ ok: false, retryAfterSeconds: 1 });
  });

  it("accepts a hit in the next window, where countHit restarts the count", async () => {
    const db = drizzle(env.DB);
    await countHit(db, "k", 2, WINDOW_MS, T0);
    await countHit(db, "k", 2, WINDOW_MS, T0 + 1);
    expect((await countHit(db, "k", 2, WINDOW_MS, T0 + 2)).ok).toBe(false);
    expect(await countHit(db, "k", 2, WINDOW_MS, T0 + WINDOW_MS)).toMatchObject({ ok: true });
    const row = await db.select().from(capturePairingLimits).get();
    expect(row).toMatchObject({ key: "k", windowStart: T0 + WINDOW_MS, count: 1 });
  });

  it("counts a hit from an older window in the stored, newer window", async () => {
    const db = drizzle(env.DB);
    const W1 = T0 + WINDOW_MS;
    expect(await countHit(db, "k", 2, WINDOW_MS, W1 + 5)).toMatchObject({ ok: true });
    expect(await countHit(db, "k", 2, WINDOW_MS, W1 + 6)).toMatchObject({ ok: true });
    const late = await countHit(db, "k", 2, WINDOW_MS, T0 + 7);
    expect(late).toMatchObject({ ok: false, retryAfterSeconds: Math.ceil((W1 + WINDOW_MS - (T0 + 7)) / 1000) });
    const row = await db.select().from(capturePairingLimits).get();
    expect(row).toMatchObject({ key: "k", windowStart: W1, count: 3 });
  });

  it("counts two keys separately", async () => {
    const db = drizzle(env.DB);
    expect(await countHit(db, "entry-user:u1", 1, WINDOW_MS, T0)).toMatchObject({ ok: true });
    expect((await countHit(db, "entry-user:u1", 1, WINDOW_MS, T0 + 1)).ok).toBe(false);
    expect(await countHit(db, "entry-user:u2", 1, WINDOW_MS, T0 + 1)).toMatchObject({ ok: true });
  });

  it("counts concurrent hits exactly", async () => {
    const db = drizzle(env.DB);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => countHit(db, "k", 5, WINDOW_MS, T0 + i)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(7);
  });
});

describe("uncountHit", () => {
  it("gives back one hit in the window it was charged to", async () => {
    const db = drizzle(env.DB);
    for (let i = 0; i < 3; i++) await countHit(db, "k", 5, WINDOW_MS, T0 + i);
    const charged = await countHit(db, "k", 5, WINDOW_MS, T0 + 3);
    expect(charged.windowStart).toBe(T0);
    await uncountHit(db, "k", charged.windowStart);
    expect(await db.select().from(capturePairingLimits).get()).toMatchObject({ key: "k", windowStart: T0, count: 3 });
  });

  it("changes nothing once the count has moved to a newer window, so a late give-back lets no extra hit through", async () => {
    const db = drizzle(env.DB);
    const charged = await countHit(db, "k", 5, WINDOW_MS, T0);
    // The next window fills before the give-back of the first hit arrives.
    for (let i = 0; i < 5; i++) expect((await countHit(db, "k", 5, WINDOW_MS, T0 + WINDOW_MS + i)).ok).toBe(true);
    await uncountHit(db, "k", charged.windowStart);
    expect(await db.select().from(capturePairingLimits).get()).toMatchObject({ windowStart: T0 + WINDOW_MS, count: 5 });
    expect((await countHit(db, "k", 5, WINDOW_MS, T0 + WINDOW_MS + 10)).ok).toBe(false);
  });

  it("changes nothing at zero, or for a key with no row", async () => {
    const db = drizzle(env.DB);
    const charged = await countHit(db, "k", 5, WINDOW_MS, T0);
    await uncountHit(db, "k", charged.windowStart);
    await uncountHit(db, "k", charged.windowStart);
    expect(await db.select().from(capturePairingLimits).get()).toMatchObject({ count: 0 });
    await uncountHit(db, "none", T0);
    expect(await db.select().from(capturePairingLimits).all()).toHaveLength(1);
  });
});

// @version v0.9.0
