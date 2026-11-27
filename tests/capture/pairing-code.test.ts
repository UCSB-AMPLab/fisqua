/**
 * Tests — pairing codes
 *
 * This suite pins the code a Captua unit shows while it waits to be
 * paired: how a typed entry is normalized (case, spaces, hyphens, and
 * `I`, `L`, `O` read as digits), that any other whitespace or any
 * character outside printable ASCII makes the entry unreadable, how a
 * code is displayed, and the shape of new codes and collect secrets.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import {
  PAIRING_CODE_ALPHABET,
  CODE_TTL_MS,
  COLLECT_TTL_MS,
  POLL_SECONDS,
  formatPairingCode,
  newCollectSecret,
  newPairingCode,
  normalizePairingCode,
} from "../../app/lib/capture/pairing-code";

describe("pairing code constants", () => {
  it("uses Crockford base 32 and the contract's lifetimes", () => {
    expect(PAIRING_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(CODE_TTL_MS).toBe(120_000);
    expect(COLLECT_TTL_MS).toBe(120_000);
    expect(POLL_SECONDS).toBe(5);
  });
});

describe("normalizePairingCode", () => {
  it("strips spaces and hyphens and upper-cases", () => {
    expect(normalizePairingCode(" 7kq-m2x ")).toBe("7KQM2X");
  });

  it("reads I and L as 1 and O as 0", () => {
    expect(normalizePairingCode("IlO123")).toBe("110123");
  });

  it("returns null for the wrong length or a character outside the alphabet", () => {
    expect(normalizePairingCode("7KQM2")).toBeNull();
    expect(normalizePairingCode("7KQM2XU")).toBeNull();
    expect(normalizePairingCode("7KQM2U")).toBeNull();
  });

  it("returns null for whitespace other than a space", () => {
    expect(normalizePairingCode("7KQ\tM2X")).toBeNull();
    expect(normalizePairingCode("7KQ\u00A0M2X")).toBeNull();
  });

  it("returns null for a character outside printable ASCII, before upper-casing", () => {
    // "ß" upper-cases to "SS" and "ı" (dotless i) to "I".
    expect(normalizePairingCode("7KQMß")).toBeNull();
    expect(normalizePairingCode("7KQM2ı")).toBeNull();
  });
});

describe("formatPairingCode", () => {
  it("writes the code as two groups of three", () => {
    expect(formatPairingCode("7KQM2X")).toBe("7KQ-M2X");
  });
});

describe("new codes and secrets", () => {
  it("draws six alphabet characters every time", () => {
    for (let i = 0; i < 1000; i++) {
      expect(newPairingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    }
  });

  it("writes a collect secret as 64 lowercase hex characters", () => {
    expect(newCollectSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

// @version v0.9.0
