/**
 * D1 Overload Handling
 *
 * This module deals with the statements D1 refuses because the
 * database is overloaded: D1 answers them with error code 7429 and a
 * message containing "D1 DB is overloaded", and drizzle hands the
 * refusal on wrapped in a `DrizzleQueryError` whose `.cause` is the
 * driver's error.
 *
 * `isD1Overloaded` says whether an error is such a refusal. It reads
 * the error's message and the messages along its `.cause` chain, up
 * to `MAX_CAUSE_DEPTH` links so that a cyclic chain ends, and answers
 * true only when one of them mentions an overload or the 7429 code.
 * The message of a `DrizzleQueryError` is skipped: drizzle writes the
 * query and its params into it, and a param such as an email address
 * could contain either word. Anything else, a non-Error value
 * included, is not an overload.
 *
 * `retryD1Read` runs a read and, while D1 refuses it as overloaded,
 * waits and runs it again, once per entry in `waitsMs`. Each wait is
 * drawn at random between half of its entry and the whole of it (equal
 * jitter), so requests refused together do not come back together.
 * With the default entries, `D1_READ_RETRY_WAITS_MS` of 150 and 450 ms,
 * the waits are 75 to 150 ms and 225 to 450 ms, 300 to 600 ms in all,
 * so a request a person is waiting on still answers promptly. Any other
 * error is rethrown at once; when the waits run out the last refusal is
 * rethrown. A read passed to it is one statement, so a retry never
 * repeats a statement that already succeeded. Only reads go through
 * it: a refused write may still have been applied, so writes get a
 * single attempt.
 *
 * `noteD1Overload` records in `d1OverloadedContext` that the error
 * failing the request is an overload refusal. The app's `handleError`
 * (`app/entry.server.tsx`) calls it with every error the router's error
 * handling receives, so a refusal that a caller caught and absorbed is
 * never recorded there; the root `serviceBusyMiddleware` answers 503
 * instead of the router's 500 only when it is. Any other error records
 * nothing.
 *
 * Every overload refusal is logged, because Workers Logs is the only
 * record that survives an overload (D1 cannot take a write then). Each
 * is one JSON line with the event `d1_overload`, written with
 * `console.warn` for `retry` and `recovered` and `console.error` for
 * `gave_up`: the outcome, the read's stable name, the attempt and the
 * attempts allowed, the milliseconds since the read's first attempt,
 * the request's method, host and path, the workspace slug, the
 * `cf-ray` id, and the refusal's own message cut to 300 characters
 * (never drizzle's wrapper message, which carries the query params).
 * `runD1Write` gives a write one attempt and logs its refusal the same
 * way. A read that gives up is also recorded, by name, in
 * `d1FailedReadsContext`. A read that succeeds first time writes
 * nothing, and a failure to log is dropped.
 *
 * The module has no server-only dependency and no `.server` suffix,
 * because `app/lib/tenant.ts`, which route components also import for
 * its capability checks and constants, retries its tenant read with it.
 *
 * @version v0.9.0
 */

import { DrizzleQueryError } from "drizzle-orm/errors";
import type { RouterContextProvider } from "react-router";
import { d1FailedReadsContext, d1OverloadedContext } from "../context";
import { tenantSlugFromHost } from "./tenant";

/** The longest wait, in milliseconds, before each retry of a refused read; each wait is drawn from its upper half. */
export const D1_READ_RETRY_WAITS_MS: readonly number[] = [150, 450];

const MAX_CAUSE_DEPTH = 5;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The two forms in which D1 states an overload refusal: the sentence "D1
 * DB is overloaded" and the code in brackets, "[code: 7429]". A bare
 * "overloaded" or "7429" elsewhere in a message is not taken as one, so
 * an unrelated error that happens to contain either is not answered as
 * a busy service.
 */
const D1_OVERLOAD_PATTERN = /D1 DB is overloaded|\[code:\s*7429\]/i;

/** True when `err`, or an error in its cause chain, is a D1 overload refusal. */
export function isD1Overloaded(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (!(current instanceof DrizzleQueryError)) {
      const message = current.message;
      if (D1_OVERLOAD_PATTERN.test(message)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Where a D1 statement runs, for the overload log lines: a short stable
 * name for the statement (`tenant_by_slug`, `user_by_session`, ...), the
 * request it runs for, the request context, in which a read that gives
 * up is recorded for `serviceBusyMiddleware`, and the workspace slug when
 * the caller knows it better than the host does.
 */
export type D1Site = {
  read: string;
  request?: Request;
  context?: Pick<RouterContextProvider, "get" | "set">;
  tenant?: string | null;
};

const MAX_ERROR_TEXT = 300;

/** The message of the overload refusal itself, never drizzle's message with the query and params. */
function overloadMessage(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) return undefined;
    if (!(current instanceof DrizzleQueryError)) {
      const message = current.message;
      if (D1_OVERLOAD_PATTERN.test(message)) {
        return message.slice(0, MAX_ERROR_TEXT);
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The request fields every overload line carries: method, host, path
 * (no query string), the workspace slug the host names, and Cloudflare's
 * `cf-ray` id, which joins the lines of one request. Nothing else is
 * read from the request: no cookie, no other header, no body.
 */
export function requestLogFields(
  request: Request | undefined,
  tenant?: string | null,
): Record<string, string | null> {
  if (!request) return tenant ? { tenant } : {};
  const url = new URL(request.url);
  return {
    method: request.method,
    host: url.hostname,
    path: url.pathname,
    tenant: tenant ?? tenantSlugFromHost(url.hostname),
    ray: request.headers.get("cf-ray"),
  };
}

/** Writes one JSON log line; a failure to log is dropped. */
export function writeLogLine(level: "warn" | "error", line: Record<string, unknown>): void {
  try {
    console[level](JSON.stringify(line));
  } catch {
    // Logging never changes what the request does.
  }
}

function logOverload(
  site: D1Site | undefined,
  outcome: "retry" | "recovered" | "gave_up",
  attempt: number,
  attempts: number,
  startedAt: number,
  err?: unknown,
): void {
  try {
    const line: Record<string, unknown> = {
      event: "d1_overload",
      outcome,
      read: site?.read ?? "unnamed",
      attempt,
      attempts,
      elapsed_ms: Date.now() - startedAt,
      ...requestLogFields(site?.request, site?.tenant),
    };
    if (err !== undefined) line.error = overloadMessage(err);
    writeLogLine(outcome === "gave_up" ? "error" : "warn", line);
    if (outcome === "gave_up") recordFailedRead(site?.context, site?.read ?? "unnamed");
  } catch {
    // Logging never changes what the request does.
  }
}

function hasContext(
  context: Pick<RouterContextProvider, "get" | "set"> | Pick<RouterContextProvider, "set"> | undefined,
): context is Pick<RouterContextProvider, "get" | "set"> {
  const c = context as Partial<RouterContextProvider> | undefined;
  return typeof c?.set === "function" && typeof c?.get === "function";
}

function recordFailedRead(context: D1Site["context"], read: string): void {
  if (!hasContext(context)) return;
  const reads = context.get(d1FailedReadsContext);
  if (!reads.includes(read)) context.set(d1FailedReadsContext, [...reads, read]);
}

/** A wait drawn between half of `ms` and `ms` (equal jitter), in whole milliseconds. */
function jittered(ms: number, random: () => number): number {
  return Math.floor(ms / 2 + (ms / 2) * random());
}

/**
 * Runs `read`, retrying it after each wait in `waitsMs` while D1
 * refuses it as overloaded. `sleep` receives each wait. Each refusal
 * writes a `d1_overload` line (`retry`, or `gave_up` on the last
 * attempt), and a success after a refusal writes a `recovered` line;
 * a read that succeeds first time writes nothing. `site` names the read
 * and its request in those lines. Each wait is `jittered` with
 * `random`, which tests fix.
 */
export async function retryD1Read<T>(
  read: () => Promise<T>,
  waitsMs: readonly number[] = D1_READ_RETRY_WAITS_MS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  site?: D1Site,
  random: () => number = Math.random,
): Promise<T> {
  const attempts = waitsMs.length + 1;
  const startedAt = Date.now();
  let refused = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await read();
      if (refused) logOverload(site, "recovered", attempt + 1, attempts, startedAt);
      return result;
    } catch (err) {
      if (!isD1Overloaded(err)) throw err;
      refused = true;
      if (attempt >= waitsMs.length) {
        logOverload(site, "gave_up", attempt + 1, attempts, startedAt, err);
        throw err;
      }
      logOverload(site, "retry", attempt + 1, attempts, startedAt, err);
      await sleep(jittered(waitsMs[attempt], random));
    }
  }
}

/**
 * Runs `write` once. A refused write may still have been applied, so it
 * is never run again; an overload refusal writes one `gave_up` line with
 * one attempt allowed and is rethrown.
 */
export async function runD1Write<T>(write: () => Promise<T>, site: D1Site): Promise<T> {
  const startedAt = Date.now();
  try {
    return await write();
  } catch (err) {
    if (isD1Overloaded(err)) logOverload(site, "gave_up", 1, 1, startedAt, err);
    throw err;
  }
}

/**
 * Records in the request context that `err`, an error that is failing
 * the request, is a D1 overload refusal, when it is one. Called from
 * the app's `handleError`. A context without `get` and `set` records
 * nothing.
 */
export function noteD1Overload(
  context: Pick<RouterContextProvider, "get" | "set"> | undefined,
  err: unknown,
): void {
  if (!isD1Overloaded(err) || !hasContext(context)) return;
  context.set(d1OverloadedContext, true);
}

/** Whether the error that failed this request was a D1 overload refusal. */
export function failedOnD1Overload(context: Pick<RouterContextProvider, "get">): boolean {
  return context.get(d1OverloadedContext);
}

/** The reads D1 refused after their retries in this request. */
export function d1FailedReads(context: Pick<RouterContextProvider, "get">): readonly string[] {
  return context.get(d1FailedReadsContext);
}

// @version v0.9.0
