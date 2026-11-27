/**
 * Tests — the cause of a D1 failure that a log line may carry
 *
 * This suite pins that `d1ErrorCode`, `d1ErrorKind` and `describeD1Error`
 * read an error and its `.cause` chain and give a code, a category and a
 * line fragment that hold no SQL and no bound values: a code only from a
 * numeric `code` property or a single bracketed code of four or five
 * digits ending a driver's message, and a name only when it is a plain
 * identifier. The errors here are built the way drizzle hands a driver's
 * error on: a `DrizzleQueryError`, whose message carries the query and its
 * params, with the driver's error as its cause.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { d1ErrorCode, d1ErrorKind, describeD1Error } from "../../app/lib/d1-error-cause";

const wrapped = (message: string) =>
  new DrizzleQueryError("SELECT * FROM users WHERE email = ?", ["secret@example.org"], new Error(message));

describe("d1ErrorCode", () => {
  it("reads the bracketed code from the driver's message under drizzle's wrapper", () => {
    expect(d1ErrorCode(wrapped("D1_ERROR: Network connection lost. [code: 7500]"))).toBe("7500");
  });

  it("reads a numeric code property along the chain", () => {
    const inner = Object.assign(new Error("failed"), { code: 7500 });
    expect(d1ErrorCode(new Error("outer", { cause: inner }))).toBe("7500");
  });

  it("gives nothing for an error with no code", () => {
    expect(d1ErrorCode(wrapped("no such column: nope"))).toBeUndefined();
    expect(d1ErrorCode("not an error")).toBeUndefined();
  });

  it("never reads a code from drizzle's own message, which carries the params", () => {
    const err = new DrizzleQueryError("SELECT ?", ["[code: 1234]"], new Error("plain"));
    expect(d1ErrorCode(err)).toBeUndefined();
  });

  it("ignores a code property that is not a number, digits in a string included", () => {
    expect(d1ErrorCode(Object.assign(new Error("failed"), { code: "secret@example.org" }))).toBeUndefined();
    expect(d1ErrorCode(Object.assign(new Error("failed"), { code: "7500" }))).toBeUndefined();
  });

  it("reads a bracketed code only at the very end of the message", () => {
    expect(d1ErrorCode(wrapped("D1_ERROR: [code: 7500] WHERE email = 'secret@example.org'"))).toBeUndefined();
    expect(d1ErrorCode(wrapped("D1_ERROR: failed [code: 7500] "))).toBeUndefined();
  });

  it("reads a bracketed code only of four or five digits", () => {
    expect(d1ErrorCode(wrapped("D1_ERROR: failed [code: 750]"))).toBeUndefined();
    expect(d1ErrorCode(wrapped("D1_ERROR: failed [code: 750012]"))).toBeUndefined();
    expect(d1ErrorCode(wrapped("D1_ERROR: failed [code: 75001]"))).toBe("75001");
  });

  it("reads no bracketed code from a message that holds more than one", () => {
    expect(d1ErrorCode(wrapped("WHERE note = '[code: 1234]' [code: 7500]"))).toBeUndefined();
  });
});

describe("d1ErrorKind", () => {
  it.each([
    ["D1_ERROR: Network connection lost.", "connection"],
    ["connection reset by peer", "connection"],
    ["D1_ERROR: Query timed out", "timeout"],
    ["statement timeout", "timeout"],
    ["too many SQL variables", "too-many"],
    ["Too many subrequests.", "too-many"],
    ['near "SELEC": syntax error', "syntax"],
    ["UNIQUE constraint failed: entities.entity_code", "constraint"],
    ["boom", "unknown"],
  ])("classes %j as %s", (message, kind) => {
    expect(d1ErrorKind(wrapped(message))).toBe(kind);
  });

  it("never classes by drizzle's own message, which carries the params", () => {
    const err = new DrizzleQueryError("SELECT ?", ["network timeout syntax"], new Error("boom"));
    expect(d1ErrorKind(err)).toBe("unknown");
  });

  it("classes a value that is not an error as unknown", () => {
    expect(d1ErrorKind(undefined)).toBe("unknown");
  });

  it("ends on a cyclic cause chain", () => {
    const a = new Error("boom") as Error & { cause?: unknown };
    a.cause = a;
    expect(d1ErrorKind(a)).toBe("unknown");
  });
});

describe("describeD1Error", () => {
  it("gives the name, the step, the code and the kind, and nothing of the query", () => {
    const line = describeD1Error(
      wrapped("D1_ERROR: Network connection lost. SELECT email FROM users WHERE email = 'secret@example.org' [code: 7500]"),
      "marks",
    );
    expect(line).toBe("Error step=marks code=7500 kind=connection");
    expect(line).not.toMatch(/SELECT|secret@example\.org/);
  });

  it("leaves out the code when there is none", () => {
    expect(describeD1Error(new TypeError("boom"), "other")).toBe("TypeError step=other kind=unknown");
  });

  it("names a value that is not an error 'Error'", () => {
    expect(describeD1Error("boom", "unit")).toBe("Error step=unit kind=unknown");
  });

  it("logs a name that is not a plain identifier as 'Error'", () => {
    const odd = Object.assign(new Error("boom"), { name: "WHERE email = 'secret@example.org'" });
    expect(describeD1Error(odd, "unit")).toBe("Error step=unit kind=unknown");
    const long = Object.assign(new Error("boom"), { name: "A".repeat(42) });
    expect(describeD1Error(long, "unit")).toBe("Error step=unit kind=unknown");
    const fits = Object.assign(new Error("boom"), { name: "A".repeat(41) });
    expect(describeD1Error(fits, "unit")).toBe(`${"A".repeat(41)} step=unit kind=unknown`);
  });
});

// @version v0.9.0
