/**
 * Tests — iiif viewer pin modex
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  routePageClick,
  computeBoxRegion,
} from "../../app/components/viewer/iiif-viewer";

describe("routePageClick", () => {
  it("returns boundary intent when pinMode is 'off'", () => {
    const routed = routePageClick("off", { xNorm: 0.3, yNorm: 0.4 });
    expect(routed.kind).toBe("boundary");
  });

  it("returns region intent with w=0 h=0 when pinMode is 'point' --", () => {
    const routed = routePageClick("point", { xNorm: 0.3, yNorm: 0.4 });
    expect(routed.kind).toBe("region");
    if (routed.kind === "region") {
      expect(routed.region).toEqual({ x: 0.3, y: 0.4, w: 0, h: 0 });
    }
  });

  it("returns boundary intent when pinMode is 'box' -- box mode is handled by pointerdown/move/up, raw click is ignored", () => {
    // Box mode explicitly does NOT fire onRegionPlace on a raw click;
    // the full gesture is required. routePageClick returning "boundary"
    // for box mode reflects this -- the caller then checks pinMode
    // directly before forwarding to onPlaceBoundary.
    const routed = routePageClick("box", { xNorm: 0.3, yNorm: 0.4 });
    expect(routed.kind).toBe("boundary");
  });

  it("preserves extreme-edge coordinates for point pins", () => {
    const routed = routePageClick("point", { xNorm: 0, yNorm: 0 });
    expect(routed.kind).toBe("region");
    if (routed.kind === "region") {
      expect(routed.region).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    }
  });

  it("preserves corner coordinates (1, 1) for point pins", () => {
    const routed = routePageClick("point", { xNorm: 1, yNorm: 1 });
    expect(routed.kind).toBe("region");
    if (routed.kind === "region") {
      expect(routed.region).toEqual({ x: 1, y: 1, w: 0, h: 0 });
    }
  });
});

describe("computeBoxRegion", () => {
  it("returns a region with correct top-left and positive size for a forward drag", () => {
    const region = computeBoxRegion(
      { x: 0.2, y: 0.2 },
      { x: 0.6, y: 0.5 },
    );
    expect(region).not.toBeNull();
    if (region) {
      expect(region.x).toBeCloseTo(0.2);
      expect(region.y).toBeCloseTo(0.2);
      expect(region.w).toBeCloseTo(0.4);
      expect(region.h).toBeCloseTo(0.3);
    }
  });

  it("normalises reverse drags: end-above-start still produces positive w/h with correct top-left", () => {
    const region = computeBoxRegion(
      { x: 0.6, y: 0.5 },
      { x: 0.2, y: 0.2 },
    );
    // Top-left of the resulting box is (0.2, 0.2); w and h are absolute.
    expect(region).not.toBeNull();
    if (region) {
      expect(region.x).toBeCloseTo(0.2);
      expect(region.y).toBeCloseTo(0.2);
      expect(region.w).toBeCloseTo(0.4);
      expect(region.h).toBeCloseTo(0.3);
    }
  });

  it("returns null for a zero-size box (pointerup at pointerdown location)", () => {
    expect(
      computeBoxRegion({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }),
    ).toBeNull();
  });

  it("returns null when width is below MIN_BOX_EDGE (0.01)", () => {
    expect(
      computeBoxRegion({ x: 0.3, y: 0.3 }, { x: 0.305, y: 0.5 }),
    ).toBeNull();
  });

  it("returns null when height is below MIN_BOX_EDGE (0.01)", () => {
    expect(
      computeBoxRegion({ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.305 }),
    ).toBeNull();
  });

  it("accepts a box at or above MIN_BOX_EDGE width and height", () => {
    // Use 0.02 (safely above 0.01) to avoid floating-point boundary
    // fuzz. The `< MIN_BOX_EDGE` guard is the inclusive-floor check.
    const region = computeBoxRegion(
      { x: 0.3, y: 0.3 },
      { x: 0.32, y: 0.32 },
    );
    expect(region).not.toBeNull();
    if (region) {
      expect(region.x).toBeCloseTo(0.3);
      expect(region.y).toBeCloseTo(0.3);
      expect(region.w).toBeCloseTo(0.02);
      expect(region.h).toBeCloseTo(0.02);
    }
  });

  it("accepts a wide box that exercises both dimensions", () => {
    const region = computeBoxRegion(
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    );
    expect(region).not.toBeNull();
    if (region) {
      expect(region.x).toBeCloseTo(0.1);
      expect(region.y).toBeCloseTo(0.1);
      expect(region.w).toBeCloseTo(0.8);
      expect(region.h).toBeCloseTo(0.8);
    }
  });
});

