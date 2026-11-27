/**
 * Tests — the log lines written when D1 refuses a statement as overloaded
 *
 * This suite pins the log lines written when D1 refuses a statement as
 * overloaded. Every time a read meets a D1 overload refusal, `retryD1Read`
 * writes one JSON line with the event `d1_overload`: `retry` for an
 * attempt that failed and will be tried again, `recovered` for the attempt
 * that succeeded after a refusal, `gave_up` for the last attempt failing.
 * A write that D1 refuses (`runD1Write`) gets one `gave_up` line with one
 * attempt allowed. When the root `serviceBusyMiddleware` replaces a 500
 * whose error was an overload (recorded by `noteD1Overload`, which the
 * app's `handleError` calls) with the busy page, it writes one
 * `service_busy_503` line naming the reads that failed. The suite pins the
 * fields of each line, that the normal path and other errors write
 * nothing, that no cookie, query string, token or email reaches a line,
 * and that the sign-in reads and the magic-link insert write the same
 * lines.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  isD1Overloaded,
  noteD1Overload,
  retryD1Read,
  runD1Write,
} from "../../app/lib/d1-overload";
import { serviceBusyMiddleware } from "../../app/middleware/service-busy";
import { generateMagicLink } from "../../app/lib/auth.server";

vi.mock("../../app/lib/email.server", () => ({
  sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined),
}));

const OVERLOAD_MESSAGE =
  "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]";
const RAY = "8f0a1b2c3d4e5f60-BOG";
const noSleep = async () => {};

function overload(): Error {
  return new Error(OVERLOAD_MESSAGE);
}

function request(url = "https://neogranadina.fisqua.test/login", init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: { "cf-ray": RAY, ...(init.headers as Record<string, string> | undefined) },
  });
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** Every console line written as a JSON object, in order, from warn and error. */
function lines(): Array<Record<string, any>> {
  const calls: Array<{ order: number; args: unknown[] }> = [];
  for (const spy of [warn, error]) {
    spy.mock.calls.forEach((args: unknown[], i: number) => {
      calls.push({ order: spy.mock.invocationCallOrder[i], args });
    });
  }
  return calls
    .sort((a, b) => a.order - b.order)
    .map(({ args }) => {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe("string");
      return JSON.parse(args[0] as string);
    });
}

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("d1_overload lines from retryD1Read", () => {
  it("writes a retry line and a recovered line when a read recovers", async () => {
    const read = vi.fn().mockRejectedValueOnce(overload()).mockResolvedValue("row");
    const site = { read: "tenant_by_slug", request: request(), tenant: "neogranadina" };
    await expect(retryD1Read(read, [10, 20], noSleep, site)).resolves.toBe("row");
    const [retry, recovered, ...rest] = lines();
    expect(rest).toEqual([]);
    expect(retry).toEqual({
      event: "d1_overload",
      outcome: "retry",
      read: "tenant_by_slug",
      attempt: 1,
      attempts: 3,
      elapsed_ms: expect.any(Number),
      method: "GET",
      host: "neogranadina.fisqua.test",
      path: "/login",
      tenant: "neogranadina",
      ray: RAY,
      error: OVERLOAD_MESSAGE,
    });
    expect(recovered).toMatchObject({ event: "d1_overload", outcome: "recovered", read: "tenant_by_slug", attempt: 2, attempts: 3 });
    expect(recovered.error).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("writes two retry lines and a gave_up line when the read stays refused", async () => {
    const read = vi.fn().mockRejectedValue(new DrizzleQueryError("select 1", [], overload()));
    const context = new RouterContextProvider();
    const site = { read: "user_by_session", request: request(), context };
    await expect(retryD1Read(read, [10, 20], noSleep, site)).rejects.toSatisfy(isD1Overloaded);
    expect(lines().map((l) => [l.outcome, l.attempt, l.attempts])).toEqual([
      ["retry", 1, 3],
      ["retry", 2, 3],
      ["gave_up", 3, 3],
    ]);
    const gaveUp = lines()[2];
    expect(gaveUp.read).toBe("user_by_session");
    expect(gaveUp.error).toBe(OVERLOAD_MESSAGE);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when a read succeeds first time", async () => {
    await retryD1Read(async () => "row", [10, 20], noSleep, { read: "grant", request: request() });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("writes nothing for an error that is not an overload", async () => {
    const read = vi.fn().mockRejectedValue(new Error("no such table: users"));
    await expect(retryD1Read(read, [10, 20], noSleep, { read: "grant", request: request() })).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("writes the line without request fields when the read has no request", async () => {
    const read = vi.fn().mockRejectedValueOnce(overload()).mockResolvedValue("row");
    await retryD1Read(read, [10], noSleep);
    const [retry] = lines();
    expect(retry).toMatchObject({ event: "d1_overload", outcome: "retry", read: "unnamed", attempt: 1, attempts: 2 });
    expect(retry.method).toBeUndefined();
  });

  it("cuts the error text to 300 characters", async () => {
    const long = new Error(`D1 DB is overloaded. ${"x".repeat(500)}`);
    const read = vi.fn().mockRejectedValueOnce(long).mockResolvedValue("row");
    await retryD1Read(read, [10], noSleep, { read: "grant", request: request() });
    expect(lines()[0].error).toHaveLength(300);
  });

  it("keeps cookies, the query string, tokens, emails and query params out of every line", async () => {
    const req = request("https://neogranadina.fisqua.test/auth/verify?token=secret-token-123&email=scholar%40example.com", {
      headers: { Cookie: "__session=signed-session-value" },
    });
    const wrapped = new DrizzleQueryError(
      'select * from "users" where "users"."email" = ?',
      ["scholar@example.com"],
      overload(),
    );
    const read = vi.fn().mockRejectedValue(wrapped);
    await expect(retryD1Read(read, [10, 20], noSleep, { read: "user_by_email", request: req })).rejects.toBe(wrapped);
    const written = [...warn.mock.calls, ...error.mock.calls].map((args) => String(args[0])).join("\n");
    expect(written).toContain('"path":"/auth/verify"');
    for (const leak of ["secret-token-123", "scholar", "example.com", "__session", "signed-session-value", "token=", "?", 'from \\"users\\"']) {
      expect(written).not.toContain(leak);
    }
  });

  it("never throws from logging, and never changes the outcome", async () => {
    warn.mockImplementation(() => {
      throw new Error("console is gone");
    });
    error.mockImplementation(() => {
      throw new Error("console is gone");
    });
    const read = vi.fn().mockRejectedValueOnce(overload()).mockResolvedValue("row");
    await expect(retryD1Read(read, [10], noSleep, { read: "grant", request: request() })).resolves.toBe("row");
    const last = overload();
    await expect(retryD1Read(vi.fn().mockRejectedValue(last), [], noSleep, { read: "grant" })).rejects.toBe(last);
  });
});

describe("d1_overload lines from runD1Write", () => {
  it("writes one gave_up line with one attempt allowed, and runs the write once", async () => {
    const write = vi.fn().mockRejectedValue(overload());
    await expect(runD1Write(write, { read: "last_active", request: request() })).rejects.toSatisfy(isD1Overloaded);
    expect(write).toHaveBeenCalledTimes(1);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "d1_overload", outcome: "gave_up", read: "last_active", attempt: 1, attempts: 1 }),
    ]);
  });

  it("writes nothing when the write succeeds or fails otherwise", async () => {
    await runD1Write(async () => undefined, { read: "last_active" });
    await expect(runD1Write(async () => { throw new Error("constraint failed"); }, { read: "last_active" })).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("service_busy_503 line", () => {
  function contextWith(): any {
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env };
    return context;
  }

  it("names the reads that failed and the status it replaced", async () => {
    const context = contextWith();
    const req = request("https://neogranadina.fisqua.test/dashboard?lang=en", { headers: { Cookie: "__session=v" } });
    const refusal = await retryD1Read(vi.fn().mockRejectedValue(overload()), [], noSleep, {
      read: "tenant_by_slug",
      request: req,
      context,
    }).catch((err: unknown) => err);
    // The router's error handling hands the refusal to the app's handleError.
    noteD1Overload(context, refusal);
    warn.mockClear();
    error.mockClear();
    const response = (await serviceBusyMiddleware(
      { request: req, context, params: {} } as any,
      async () => new Response("error page", { status: 500 }),
    )) as Response;
    expect(response.status).toBe(503);
    expect(lines()).toEqual([
      {
        event: "service_busy_503",
        method: "GET",
        host: "neogranadina.fisqua.test",
        path: "/dashboard",
        tenant: "neogranadina",
        ray: RAY,
        reads: ["tenant_by_slug"],
        replaced_status: 500,
        from: "response",
      },
    ]);
  });

  it("names no read when only the middleware recorded the overload", async () => {
    const context = contextWith();
    noteD1Overload(context, overload());
    await serviceBusyMiddleware(
      { request: request(), context, params: {} } as any,
      async () => new Response("error page", { status: 500 }),
    );
    expect(lines()[0]).toMatchObject({ event: "service_busy_503", reads: [] });
  });

  it("leaves a 503 the route answered itself alone, and writes nothing", async () => {
    const context = contextWith();
    noteD1Overload(context, overload());
    const own = new Response(JSON.stringify({ error: "busy" }), { status: 503 });
    const response = await serviceBusyMiddleware(
      { request: request(), context, params: {} } as any,
      async () => own,
    );
    expect(response).toBe(own);
    expect(error).not.toHaveBeenCalled();
  });

  it("writes nothing when the response is not replaced", async () => {
    await serviceBusyMiddleware(
      { request: request(), context: contextWith(), params: {} } as any,
      async () => new Response("error page", { status: 500 }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("the sign-in reads write the same lines", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  /** A D1 binding whose statements matching `pattern` are refused on their first `failures` runs. */
  function refusingD1(pattern: RegExp, failures: number) {
    let calls = 0;
    const wrapStatement = (stmt: any, sql: string): any =>
      new Proxy(stmt, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          if (prop === "bind") return (...args: unknown[]) => wrapStatement(value.apply(target, args), sql);
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
    return new Proxy(env.DB as any, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "prepare") return (sql: string) => wrapStatement(value.call(target, sql), sql);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
  }

  function send(db: D1Database) {
    return generateMagicLink(
      drizzle(db, { schema }),
      "scholar@example.com",
      "https://neogranadina.fisqua.test",
      "test-resend-key",
      {},
      null,
      null,
      { sleep: noSleep, request: request("https://neogranadina.fisqua.test/login?lang=es", { method: "POST" }) },
    );
  }

  it("logs the user read that recovered", async () => {
    await createTestUser({ email: "scholar@example.com" });
    await expect(send(refusingD1(/from "users"/i, 1))).resolves.toEqual({ success: true });
    expect(lines().map((l) => [l.read, l.outcome, l.method, l.path])).toEqual([
      ["user_by_email", "retry", "POST", "/login"],
      ["user_by_email", "recovered", "POST", "/login"],
    ]);
  });

  it("logs the workspace language read that recovered", async () => {
    await createTestUser({ email: "scholar@example.com" });
    await expect(send(refusingD1(/from "tenants"/i, 1))).resolves.toEqual({ success: true });
    expect(lines().map((l) => [l.read, l.outcome])).toEqual([
      ["workspace_locale", "retry"],
      ["workspace_locale", "recovered"],
    ]);
  });

  it("logs the refused magic-link insert once", async () => {
    await createTestUser({ email: "scholar@example.com" });
    await expect(send(refusingD1(/insert into "magic_links"/i, Infinity))).rejects.toSatisfy(isD1Overloaded);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "d1_overload", outcome: "gave_up", read: "magic_link_insert", attempt: 1, attempts: 1, tenant: "neogranadina" }),
    ]);
  });
});

// @version v0.9.0
