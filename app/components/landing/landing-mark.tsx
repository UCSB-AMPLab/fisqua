/**
 * Landing brand mark + parchment plate
 *
 * This module deals with two presentational helpers. `ParchmentPlate` is
 * used only by the apex landing (`app/routes/_index.tsx`); `FisquaMark`
 * is the app's brand mark everywhere it appears: the landing header, the
 * signed-in and operator headers, the editor bar, the login page and the
 * wrong-workspace page.
 *
 *   - `FisquaMark` renders the pomegranate-tree mark as a CSS mask so it
 *     can be tinted to any colour token. The drawings ship as
 *     single-colour ink on transparency, so masking them lets us recolour
 *     the tree to `--verdigris-deep` (default) or any other brand colour
 *     without shipping multiple SVG copies. Two drawings are available:
 *     `small` (`/brand/fisqua-mark-ink-small.svg`), the heavier
 *     small-size tree for the header and other small placements, and
 *     `light` (`/brand/fisqua-mark-ink-light.svg`), the lighter linework
 *     for large display. `size` sets a square box; `width` and `height`
 *     override it for a non-square box. The mask is always `contain` and
 *     centred, so the whole tree shows at its own proportions. The mark is
 *     decorative and hidden from assistive technology unless `label` is
 *     given, in which case it is announced as an image with that name.
 *     Without `size`, `width` or `height`, `className` sets the box (for
 *     example `h-7 w-7`).
 *   - `ParchmentPlate` is the right-hand 4:5 aspect parchment card
 *     that anchors the desktop hero. It has square corners and no inner
 *     padding; the light tree, in `--verdigris-deep`, sits in a box 88%
 *     of the plate's width and its full height, starting 6% from the
 *     left edge, so the complete tree is centred both ways. The plate is
 *     bordered with
 *     `--parchment-deep` and hidden on narrow viewports, where the
 *     mobile composition omits it so the picker dominates.
 *
 * @version v0.9.0
 */

import type { CSSProperties } from "react";

const MARK_SOURCES = {
  small: "/brand/fisqua-mark-ink-small.svg",
  light: "/brand/fisqua-mark-ink-light.svg",
} as const;

type FisquaMarkProps = {
  /** CSS length, e.g. "32px", "78%". Sets both width and height. */
  size?: string;
  /** CSS length; overrides `size` for the width. */
  width?: string;
  /** CSS length; overrides `size` for the height. */
  height?: string;
  /** Which drawing to use; defaults to the small-size tree. */
  variant?: keyof typeof MARK_SOURCES;
  /** CSS color token, defaults to verdigris-deep. */
  color?: string;
  className?: string;
  style?: CSSProperties;
  /** Accessible name; when absent the mark is hidden from screen readers. */
  label?: string;
};

export function FisquaMark({
  size,
  width,
  height,
  variant = "small",
  color = "var(--verdigris-deep)",
  className,
  style,
  label,
}: FisquaMarkProps) {
  const mask = `url('${MARK_SOURCES[variant]}')`;
  const a11y = label
    ? { role: "img" as const, "aria-label": label }
    : { "aria-hidden": true as const };
  return (
    <span
      {...a11y}
      className={className}
      style={{
        display: "inline-block",
        width: width ?? size,
        height: height ?? size,
        backgroundColor: color,
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        ...style,
      }}
    />
  );
}

export function ParchmentPlate() {
  return (
    <aside
      aria-hidden="true"
      className="relative hidden md:block bg-parchment border border-parchment-deep overflow-hidden"
      style={{ aspectRatio: "4 / 5" }}
    >
      <FisquaMark
        variant="light"
        width="88%"
        height="100%"
        color="var(--verdigris-deep)"
        style={{ position: "absolute", left: "6%", top: 0 }}
      />
    </aside>
  );
}

// @version v0.9.0
