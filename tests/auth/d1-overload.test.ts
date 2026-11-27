/**
 * Tests — D1 overload detection and read retries
 *
 * This suite pins how the Worker treats a D1 statement that D1 refuses
 * as overloaded (error code 7429, message "D1 DB is overloaded").
 * `isD1Overloaded` recognises the refusal directly or anywhere in the
 * `.cause` chain that drizzle's `DrizzleQueryError` wraps it in, and
 * nothing else. `retryD1Read` retries a read once per configured wait
 * and rethrows any other error at once.
 *
 * `generateMagicLink` runs against the test D1 through a thin wrapper
 * binding that throws the overload error for statements whose SQL
 * matches a pattern, a set number of times, and counts how often each
 * matching statement ran. The wrapper sits under drizzle, so the
 * errors reach the code wrapped the way production errors are. The
 * user and workspace reads recover from a refusal; the `magic_links`
 * insert is attempted once and its refusal propagates.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { DrizzleQueryError } from "drizzle-orm/errors";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  D1_READ_RETRY_WAITS_MS,
  isD1Overloaded,
  retryD1Read,
} from "../../app/lib/d1-overload";
import { generateMagicLink } from "../../app/lib/auth.server";

vi.mock("../../app/lib/email.server", () => ({
  sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined),
}));

import { sendMagicLinkEmail } from "../../app/lib/email.server";

const OVERLOAD_MESSAGE = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";

function overload(): Error {
  return new Error(OVERLOAD_MESSAGE);
}

/**
 * A D1 binding over the test D1 whose statements matching `pattern`
 * throw the overload error on their first `failures` executions
 * (every execution when `failures` is Infinity). `calls()` counts the
 * executions of matching statements, refused ones included.
 */
function refusingD1(pattern: RegExp, failures: number) {
  let calls = 0;
  const wrapStatement = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "bind") {
          return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
        }
        if (["raw", "all", "first", "run"].includes(prop as string) && pattern.test(sql)) {
          return async (...args: unknown[]) => {
            calls += 1;
            if (calls <= failures) throw overload();
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  const binding = new Proxy(env.DB as any, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (sql: string) => wrapStatement(value.call(target, sql), sql);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { binding: binding as D1Database, calls: () => calls };
}

const noWait = { sleep: async () => {} };

describe("isD1Overloaded", () => {
  it("recognises the overload message", () => {
    expect(isD1Overloaded(overload())).toBe(true);
  });

  it("recognises the overload inside a drizzle query error", () => {
    const wrapped = new DrizzleQueryError("select 1", [], overload());
    expect(wrapped.message).not.toMatch(/overloaded/i);
    expect(isD1Overloaded(wrapped)).toBe(true);
  });

  it("recognises the 7429 error code in the form D1 writes it", () => {
    expect(isD1Overloaded(new Error("D1_ERROR: Too many requests [code: 7429]"))).toBe(true);
  });

  it("does not treat an unrelated error that mentions 7429 or overloading as an overload", () => {
    expect(isD1Overloaded(new Error("Missing export file for record 7429"))).toBe(false);
    expect(isD1Overloaded(new Error("D1_ERROR: 7429"))).toBe(false);
    expect(isD1Overloaded(new Error("The queue is overloaded with uploads"))).toBe(false);
    expect(isD1Overloaded(new Error("record ne-7429ab was not found"))).toBe(false);
  });

  it("does not treat another D1 error as an overload", () => {
    const err = new Error("D1_ERROR: no such table: users");
    expect(isD1Overloaded(err)).toBe(false);
    expect(isD1Overloaded(new DrizzleQueryError("select 1", [], err))).toBe(false);
  });

  it("ignores the query and params drizzle copies into its own message", () => {
    const err = new Error("D1_ERROR: no such table: users");
    const wrapped = new DrizzleQueryError(
      "select * from users where email = ?",
      ["overloaded.7429@example.org"],
      err,
    );
    expect(wrapped.message).toMatch(/overloaded/);
    expect(isD1Overloaded(wrapped)).toBe(false);
  });

  it("does not treat non-Error values as an overload", () => {
    expect(isD1Overloaded(undefined)).toBe(false);
    expect(isD1Overloaded(null)).toBe(false);
    expect(isD1Overloaded("D1 DB is overloaded")).toBe(false);
    expect(isD1Overloaded({ message: 42 })).toBe(false);
  });

  it("stops on a cyclic cause chain", () => {
    const a = new Error("first") as Error & { cause?: unknown };
    const b = new Error("second") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isD1Overloaded(a)).toBe(false);
  });
});

describe("retryD1Read", () => {
  it("uses two waits under a second in total", () => {
    expect(D1_READ_RETRY_WAITS_MS).toEqual([150, 450]);
  });

  it("waits between half and all of each default wait, chosen at random", async () => {
    const waits = async (random: () => number) => {
      const sleep = vi.fn(async (_ms: number) => {});
      const read = vi.fn().mockRejectedValue(overload());
      await expect(retryD1Read(read, undefined, sleep, undefined, random)).rejects.toSatisfy(isD1Overloaded);
      return sleep.mock.calls.map(([ms]) => ms);
    };
    expect(await waits(() => 0)).toEqual([75, 225]);
    const highest = await waits(() => 0.999999);
    expect(highest[0]).toBeLessThan(150);
    expect(highest[1]).toBeLessThan(450);
    expect(highest[0]).toBeGreaterThanOrEqual(149);
    const drawn = await waits(Math.random);
    expect(drawn[0]).toBeGreaterThanOrEqual(75);
    expect(drawn[0]).toBeLessThan(150);
    expect(drawn[1]).toBeGreaterThanOrEqual(225);
    expect(drawn[1]).toBeLessThan(450);
  });

  it("succeeds after one overload", async () => {
    const sleep = vi.fn(async () => {});
    const read = vi.fn().mockRejectedValueOnce(overload()).mockResolvedValue("row");
    await expect(retryD1Read(read, [10, 20], sleep, undefined, () => 1)).resolves.toBe("row");
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[10]]);
  });

  it("succeeds after two overloads", async () => {
    const sleep = vi.fn(async () => {});
    const read = vi
      .fn()
      .mockRejectedValueOnce(overload())
      .mockRejectedValueOnce(new DrizzleQueryError("select 1", [], overload()))
      .mockResolvedValue("row");
    await expect(retryD1Read(read, [10, 20], sleep, undefined, () => 1)).resolves.toBe("row");
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it("rethrows the overload once the waits run out", async () => {
    const sleep = vi.fn(async () => {});
    const last = overload();
    const read = vi
      .fn()
      .mockRejectedValueOnce(overload())
      .mockRejectedValueOnce(overload())
      .mockRejectedValueOnce(last);
    await expect(retryD1Read(read, [10, 20], sleep, undefined, () => 1)).rejects.toBe(last);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rethrows any other error at once, without waiting", async () => {
    const sleep = vi.fn(async () => {});
    const err = new Error("no such table: users");
    const read = vi.fn().mockRejectedValue(err);
    await expect(retryD1Read(read, [10, 20], sleep, undefined, () => 1)).rejects.toBe(err);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("generateMagicLink under D1 overload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  it("sends the link when the first user read is refused", async () => {
    await createTestUser({ email: "scholar@example.com" });
    const d1 = refusingD1(/from "users"/i, 1);
    const result = await generateMagicLink(
      drizzle(d1.binding, { schema }),
      "scholar@example.com",
      "http://localhost:5173",
      "test-resend-key",
      {},
      null,
      null,
      noWait,
    );
    expect(result).toEqual({ success: true });
    expect(d1.calls()).toBe(2);
    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
  });

  it("sends the link when the workspace language read is refused", async () => {
    await createTestUser({ email: "scholar@example.com" });
    const d1 = refusingD1(/from "tenants"/i, 1);
    const result = await generateMagicLink(
      drizzle(d1.binding, { schema }),
      "scholar@example.com",
      "http://localhost:5173",
      "test-resend-key",
      {},
      null,
      null,
      noWait,
    );
    expect(result).toEqual({ success: true });
    expect(d1.calls()).toBe(2);
    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
  });

  it("attempts a refused insert once and lets the refusal through", async () => {
    await createTestUser({ email: "scholar@example.com" });
    const d1 = refusingD1(/insert into "magic_links"/i, Infinity);
    const attempt = generateMagicLink(
      drizzle(d1.binding, { schema }),
      "scholar@example.com",
      "http://localhost:5173",
      "test-resend-key",
      {},
      null,
      null,
      noWait,
    );
    await expect(attempt).rejects.toSatisfy(isD1Overloaded);
    expect(d1.calls()).toBe(1);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });
});

// @version v0.9.0
