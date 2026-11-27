/**
 * The Cause of a D1 Failure, Safe to Log
 *
 * This module deals with what may be logged when a D1 statement fails. The
 * caller of a failed statement receives a `DrizzleQueryError` whose
 * message carries the query and its bound values, with the driver's error
 * as its `.cause`. Neither message may be logged: the driver's message can
 * quote SQL and values too. The module reads, from an error and its cause
 * chain, what can be logged in their place.
 *
 * `d1ErrorCode` gives the D1 error code, digits only: a numeric `code`
 * property on any link, or else the "[code: N]" a driver's message
 * ends with, where N is four or five digits and the message holds no
 * other "[code:". A bracket anywhere else, a code in a string property,
 * or a message with two brackets gives no code, because a bound value
 * quoted in the message could hold any of them. `d1ErrorKind` gives one word from a fixed list, found by
 * matching each driver message against a few patterns: `connection`
 * (a connection lost, reset or refused, a network error), `timeout`,
 * `too-many` (too many SQL variables, statements or subrequests),
 * `syntax`, `constraint`, and `unknown` when none matches. Only the
 * word is ever returned, never the text it matched.
 * `describeD1Error` puts them after the error's name, with the step
 * that failed: `Error step=marks code=7500 kind=connection`, the code
 * left out when there is none. The name is logged only when it is a
 * plain identifier (`SAFE_NAME`); any other name, and a value that is
 * not an `Error`, is logged as `Error`. `safeErrorName` gives that name
 * on its own.
 *
 * Both read the chain as `isD1Overloaded` (`./d1-overload`) does: up
 * to `MAX_CAUSE_DEPTH` links, so that a cyclic chain ends, stopping at
 * a value that is not an `Error`, and skipping the message of a
 * `DrizzleQueryError`, whose params could hold any of the words or a
 * bracketed code.
 *
 * @version v0.9.0
 */

import { DrizzleQueryError } from "drizzle-orm/errors";

const MAX_CAUSE_DEPTH = 5;

/** The categories a failure is logged under, matched in this order. */
const KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["connection", /\bconnection\b.*\b(lost|reset|closed|refused|terminated)\b|\bnetwork\b|ECONNRESET|ECONNREFUSED|socket hang up/i],
  ["timeout", /\btimed? ?out\b|ETIMEDOUT/i],
  ["too-many", /\btoo many\b/i],
  ["syntax", /\bsyntax\b/i],
  ["constraint", /\bconstraint\b/i],
];

/** A bracketed code of four or five digits ending the message. */
const CODE_AT_END = /\[code:\s*(\d{4,5})\]$/i;

/** Every "[code:" in a message, to refuse a message that holds more than one. */
const CODE_BRACKETS = /\[code:/gi;

/** A name that is a plain identifier, safe to log as it is. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

/** The errors along `err`'s cause chain, `err` first, as `isD1Overloaded` walks it. */
function chain(err: unknown): Error[] {
  const out: Error[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) break;
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/** The messages that may be matched: every link's but a `DrizzleQueryError`'s. */
function driverMessages(err: unknown): string[] {
  return chain(err)
    .filter((e) => !(e instanceof DrizzleQueryError))
    .map((e) => e.message);
}

/** The D1 error code along `err`'s cause chain, digits only, or undefined. */
export function d1ErrorCode(err: unknown): string | undefined {
  for (const e of chain(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number" && Number.isSafeInteger(code) && code >= 0) return String(code);
  }
  for (const message of driverMessages(err)) {
    const match = CODE_AT_END.exec(message);
    if (match && (message.match(CODE_BRACKETS) ?? []).length === 1) return match[1];
  }
  return undefined;
}

/** The category of `err`'s failure, one word from `KINDS`, or `unknown`. */
export function d1ErrorKind(err: unknown): string {
  for (const message of driverMessages(err)) {
    for (const [kind, pattern] of KINDS) {
      if (pattern.test(message)) return kind;
    }
  }
  return "unknown";
}

/** `err`'s name when it is a plain identifier, else `Error`. */
export function safeErrorName(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  return typeof name === "string" && SAFE_NAME.test(name) ? name : "Error";
}

/** `<name> step=<step> [code=<code>] kind=<kind>`, holding no message text. */
export function describeD1Error(err: unknown, step: string): string {
  const name = safeErrorName(err);
  const code = d1ErrorCode(err);
  return `${name} step=${step}${code ? ` code=${code}` : ""} kind=${d1ErrorKind(err)}`;
}

// @version v0.9.0
