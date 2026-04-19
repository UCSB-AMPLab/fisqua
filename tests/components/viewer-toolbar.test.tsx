/**
 * Tests — viewer toolbarx
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

