/**
 * Tests — viewer toolbar helpers
 *
 * This suite pins the three pure helpers behind the viewer toolbar:
 * `computeNextPinMode` (the cycle the "Regiones" button drives —
 * off → point, point → off, box → off, since the box sub-tool only
 * activates from the dropdown), `isMoveMode` (the toolbar's
 * inline-style discriminator for the move sub-tool), and
 * `shouldEnableCreateButtons` (the access-gated affordance for the
 * pin-creation buttons — only `edit` access enables them).
 *
 * The off-on cycle is deliberately asymmetric: re-clicking the
 * "Regiones" button always returns to `off` regardless of which
 * sub-tool is active, because the toolbar treats the parent button
 * as a master toggle for region mode. No React rendering — the
 * helpers cover the entire decision surface, exercised here as
 * pure-function truth tables.
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  computeNextPinMode,
  isMoveMode,
  shouldEnableCreateButtons,
} from "../../app/components/viewer/viewer-toolbar";

describe("computeNextPinMode", () => {
  it("off -> point", () => {
    expect(computeNextPinMode("off")).toBe("point");
  });

  it("point -> off (Regiones re-click deactivates)", () => {
    expect(computeNextPinMode("point")).toBe("off");
  });

  it("box -> off (Regiones re-click deactivates regardless of active sub-tool)", () => {
    expect(computeNextPinMode("box")).toBe("off");
  });
});

describe("shouldEnableCreateButtons", () => {
  it("returns true for 'edit' access -- lead or assigned cataloguer", () => {
    expect(shouldEnableCreateButtons("edit")).toBe(true);
  });

  it("returns true for 'review' access -- reviewer with edit rights", () => {
    expect(shouldEnableCreateButtons("review")).toBe(true);
  });

  it("returns false for 'readonly' access -- O-03 disables Regiones", () => {
    expect(shouldEnableCreateButtons("readonly")).toBe(false);
  });
});

describe("isMoveMode", () => {
  it("returns true for 'move'", () => {
    expect(isMoveMode("move")).toBe(true);
  });

  it("returns false for 'off', 'point', 'box'", () => {
    expect(isMoveMode("off")).toBe(false);
    expect(isMoveMode("point")).toBe(false);
    expect(isMoveMode("box")).toBe(false);
  });
});

