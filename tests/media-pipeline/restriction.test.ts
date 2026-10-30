/**
 * Tests — media pipeline restriction rule
 *
 * This suite covers the media pipeline's restriction rule. Restricted
 * material is never sent to the runner or published. Whether a volume
 * is restricted is an explicit true/false flag on its pipeline volume
 * row, set by whoever registers the volume for its archive; the
 * description's access conditions are free text and are not read for
 * this. The rule fails closed: a volume row that cannot be read counts
 * as restricted.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { isRestricted } from "../../app/lib/pipeline/restriction";

describe("restriction rule", () => {
  it("lets a volume through when its flag is false", () => {
    expect(isRestricted({ restricted: false })).toBe(false);
  });

  it("holds a volume back when its flag is true", () => {
    expect(isRestricted({ restricted: true })).toBe(true);
  });

  it("holds a volume back when its row cannot be read", () => {
    expect(isRestricted(null)).toBe(true);
    expect(isRestricted(undefined)).toBe(true);
  });
});

// @version v0.8.0
