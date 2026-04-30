/**
 * Tests — region pin overlayx
 *
 * @version v0.3.0
 */
import { describe, it, expect } from "vitest";
import {
  isPointPin,
  computePinInlineStyle,
  computePinClassName,
  canMovePin,
  computeMoveDelta,
  applyMoveDelta,
  type RegionPin,
} from "../../app/components/comments/region-pin-overlay";

function makePin(overrides: Partial<RegionPin>): RegionPin {
  return {
    commentId: "c1",
    x: 0.5,
    y: 0.5,
    w: 0,
    h: 0,
    ...overrides,
  };
}

describe("isPointPin", () => {
  it("returns true when w === 0 AND h === 0", () => {
    expect(isPointPin({ w: 0, h: 0 })).toBe(true);
  });

  it("returns false when w > 0", () => {
    expect(isPointPin({ w: 0.2, h: 0 })).toBe(false);
  });

  it("returns false when h > 0", () => {
    expect(isPointPin({ w: 0, h: 0.2 })).toBe(false);
  });

  it("returns false for a full box", () => {
    expect(isPointPin({ w: 0.4, h: 0.2 })).toBe(false);
  });
});

describe("computePinInlineStyle (point pin)", () => {
  it("anchors bottom-centre on (x, y) via translate(-50%, -100%) --", () => {
    const style = computePinInlineStyle(makePin({ x: 0.5, y: 0.5 }));
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("50%");
    expect(style.top).toBe("50%");
    expect(style.transform).toBe("translate(-50%, -100%)");
    // Point pins have no width / height on the wrapper -- the MapPin
    // icon provides intrinsic sizing.
    expect(style.width).toBeUndefined();
    expect(style.height).toBeUndefined();
  });

  it("produces deterministic percentage strings for clean-fraction coords", () => {
    // Clean fractions (halves, quarters, eighths) serialise exactly in
    // JavaScript's string conversion. Point pins don't need sub-
    // percent precision; the IIIF viewer only drops pins at mouse
    // coords that get normalised via `(e.clientX - rect.left) /
    // rect.width` anyway.
    const style = computePinInlineStyle(makePin({ x: 0.25, y: 0.75 }));
    expect(style.left).toBe("25%");
    expect(style.top).toBe("75%");
  });
});

describe("computePinInlineStyle (box pin)", () => {
  it("renders left/top/width/height as percentages with no transform --", () => {
    const style = computePinInlineStyle(
      makePin({ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }),
    );
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("20%");
    expect(style.top).toBe("30%");
    expect(style.width).toBe("40%");
    expect(style.height).toBe("20%");
    expect(style.transform).toBeUndefined();
  });
});

describe("computePinClassName", () => {
  it("uses indigo text colour on a final point pin --", () => {
    const cls = computePinClassName(makePin({}));
    expect(cls).toContain("text-indigo");
    expect(cls).not.toContain("text-saffron");
  });

  it("uses saffron text colour on a draft point pin --", () => {
    const cls = computePinClassName(makePin({ draft: true }));
    expect(cls).toContain("text-saffron");
    const tokens = cls.split(/\s+/);
    expect(tokens).not.toContain("text-indigo");
  });

  it("uses 2px indigo border on a final box pin --", () => {
    const cls = computePinClassName(
      makePin({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
    );
    expect(cls).toContain("border-2");
    expect(cls).toContain("border-indigo");
    expect(cls).toContain("bg-indigo/15");
  });

  it("uses dashed saffron border and saffron/10 fill on a draft box pin --", () => {
    const cls = computePinClassName(
      makePin({ x: 0.1, y: 0.1, w: 0.3, h: 0.3, draft: true }),
    );
    expect(cls).toContain("border-dashed");
    expect(cls).toContain("border-saffron");
    expect(cls).toContain("bg-saffron/10");
  });

  it("adds a 2px indigo ring when highlighted -- chip-click flash", () => {
    const cls = computePinClassName(
      makePin({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
      { highlighted: true },
    );
    expect(cls).toContain("ring-2");
    expect(cls).toContain("ring-indigo/50");
  });

  it("omits the highlight ring when highlighted = false (default)", () => {
    const cls = computePinClassName(
      makePin({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
    );
    // Hover ring is baseline; highlight ring (non-hover, non-focus) is gated.
    expect(cls).not.toContain("ring-indigo/50 ring-2");
    // Still has hover ring in the base string; that's by design.
    expect(cls).toContain("hover:ring-2");
  });

  it("box pin className includes a hover ring at 50% indigo --", () => {
    const cls = computePinClassName(
      makePin({ x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
    );
    expect(cls).toContain("hover:ring-2");
    expect(cls).toContain("hover:ring-indigo/50");
  });
});

describe("canMovePin -- task 15 per-pin author gate", () => {
  it("returns true when moveMode is on and pin.authorId === currentUserId", () => {
    expect(
      canMovePin({
        moveMode: true,
        pin: { authorId: "u1" },
        currentUserId: "u1",
      }),
    ).toBe(true);
  });

  it("returns false when moveMode is off (even for the author)", () => {
    expect(
      canMovePin({
        moveMode: false,
        pin: { authorId: "u1" },
        currentUserId: "u1",
      }),
    ).toBe(false);
  });

  it("returns false when authorId mismatches currentUserId", () => {
    expect(
      canMovePin({
        moveMode: true,
        pin: { authorId: "u2" },
        currentUserId: "u1",
      }),
    ).toBe(false);
  });

  it("returns false for draft pins (composer commits them, not drag)", () => {
    expect(
      canMovePin({
        moveMode: true,
        pin: { authorId: "u1", draft: true },
        currentUserId: "u1",
      }),
    ).toBe(false);
  });

  it("returns false when authorId is absent", () => {
    expect(
      canMovePin({
        moveMode: true,
        pin: {},
        currentUserId: "u1",
      }),
    ).toBe(false);
  });

  it("returns false when currentUserId is null", () => {
    expect(
      canMovePin({
        moveMode: true,
        pin: { authorId: "u1" },
        currentUserId: null,
      }),
    ).toBe(false);
  });
});

describe("computeMoveDelta", () => {
  it("returns normalised deltas against the overlay rect", () => {
    const delta = computeMoveDelta(
      { clientX: 100, clientY: 200 },
      { clientX: 150, clientY: 180 },
      { width: 500, height: 400 },
    );
    expect(delta.dx).toBeCloseTo(0.1);
    expect(delta.dy).toBeCloseTo(-0.05);
  });

  it("returns zero deltas when the overlay rect has zero dimensions", () => {
    const delta = computeMoveDelta(
      { clientX: 0, clientY: 0 },
      { clientX: 50, clientY: 50 },
      { width: 0, height: 0 },
    );
    expect(delta.dx).toBe(0);
    expect(delta.dy).toBe(0);
  });
});

describe("applyMoveDelta -- translate-only, no resize", () => {
  it("translates a point pin and clamps x/y to [0, 1]", () => {
    const result = applyMoveDelta(
      { x: 0.1, y: 0.2, w: 0, h: 0 },
      { dx: 0.3, dy: 0.5 },
    );
    expect(result).toEqual({ x: 0.4, y: 0.7, w: 0, h: 0 });
  });

  it("clamps a point pin at the image boundary (x = 1)", () => {
    const result = applyMoveDelta(
      { x: 0.8, y: 0.2, w: 0, h: 0 },
      { dx: 0.5, dy: 0 },
    );
    expect(result.x).toBe(1);
  });

  it("clamps a point pin at the image boundary (x = 0) on negative drags", () => {
    const result = applyMoveDelta(
      { x: 0.2, y: 0.2, w: 0, h: 0 },
      { dx: -0.5, dy: 0 },
    );
    expect(result.x).toBe(0);
  });

  it("translates a box pin while preserving w and h", () => {
    const result = applyMoveDelta(
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      { dx: 0.2, dy: 0.1 },
    );
    expect(result.x).toBeCloseTo(0.3);
    expect(result.y).toBeCloseTo(0.3);
    expect(result.w).toBe(0.3);
    expect(result.h).toBe(0.4);
  });

  it("clamps a box pin so x + w never exceeds 1", () => {
    const result = applyMoveDelta(
      { x: 0.6, y: 0.2, w: 0.3, h: 0.3 },
      { dx: 0.5, dy: 0 },
    );
    // maxX = 1 - 0.3 = 0.7 ; 0.6 + 0.5 = 1.1 clamps to 0.7
    expect(result.x).toBe(0.7);
    expect(result.w).toBe(0.3);
  });

  it("clamps a box pin so y + h never exceeds 1", () => {
    const result = applyMoveDelta(
      { x: 0.2, y: 0.6, w: 0.3, h: 0.3 },
      { dx: 0, dy: 0.5 },
    );
    expect(result.y).toBe(0.7);
    expect(result.h).toBe(0.3);
  });

  it("never mutates w or h (translate-only, no resize)", () => {
    const start = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const result = applyMoveDelta(start, { dx: 0.3, dy: -0.05 });
    expect(result.w).toBe(0.5);
    expect(result.h).toBe(0.5);
  });
});

