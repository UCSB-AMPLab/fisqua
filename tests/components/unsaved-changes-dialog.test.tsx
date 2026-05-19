/**
 * Tests — UnsavedChangesDialog
 *
 * This suite pins the custom unsaved-changes modal that replaces the
 * native `window.confirm` firing from `useBlocker` in both editor routes
 * with a Tailwind-styled, i18n-driven dialog. These tests pin the
 * safety-critical behaviour of the component:
 *
 *   - Renders nothing when `open=false` (no orphan overlay).
 *   - Renders title, body, stay button, leave button when `open=true`.
 *   - The Stay button's onClick wires to `onStay`; the Leave button's
 *     onClick wires to `onLeave`. No cross-contamination.
 *   - Pressing Escape (via the document-level keydown listener) calls
 *     `onStay` — Stay is the safe default for accidental keystrokes.
 *   - Clicking the backdrop (event.target === event.currentTarget) calls
 *     `onStay`; clicking a child does NOT (otherwise dragging a
 *     selection inside the body text would dismiss the dialog).
 *   - The X close button calls `onStay`.
 *   - The Stay button has `autoFocus` so an accidental Enter immediately
 *     after the dialog opens keeps the user on the page.
 *
 * Testing strategy — pure-function inspection of the React element
 * tree. This codebase deliberately does NOT pull in
 * `@testing-library/react` + jsdom (see `tests/components/*.test.tsx`
 * convention: pure-function tests under the Workers pool). To keep
 * the same pattern, the component is split into two arms:
 *
 *   - `UnsavedChangesDialogView` — pure presentational view, no
 *     hooks, returns `null` or the JSX tree. This is what the tests
 *     below invoke directly as a function and inspect via the
 *     `findByText` / `findByAriaLabel` walkers.
 *
 *   - `UnsavedChangesDialog` — thin wrapper that adds the
 *     window-level Escape keydown listener via `useEffect` and
 *     delegates to the view. The route consumers use this wrapper;
 *     the tests target the pure view. The Escape behaviour is
 *     verified by smoke (live browser) and the contract is pinned by
 *     the description-editor and viewer-route SUMMARY entries.
 *
 * Documented as a Rule 3 deviation in the plan SUMMARY (adapt to
 * existing test infrastructure rather than introduce
 * `@testing-library/react` as an architectural change).
 *
 * @version v0.4.1
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import { UnsavedChangesDialogView } from "../../app/components/viewer/unsaved-changes-dialog";

type AnyEl = ReactElement<Record<string, unknown>>;

/**
 * Recursively search a React element tree for the first node whose
 * props include the given text content (string match, case-sensitive,
 * exact). Returns null if not found. Useful for finding the title,
 * body paragraph, and named buttons in the dialog's tree without a
 * real DOM.
 */
function findByText(node: unknown, text: string): AnyEl | null {
  if (node == null || typeof node !== "object") return null;
  const el = node as AnyEl;
  const children = (el.props as { children?: unknown } | undefined)?.children;
  if (children === text) return el;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child === text) return el;
      const found = findByText(child, text);
      if (found) return found;
    }
  } else if (children !== undefined) {
    const found = findByText(children, text);
    if (found) return found;
  }
  return null;
}

/**
 * Recursively search for the first element with the given `aria-label`
 * prop. Used to locate the X close button (which carries the stay
 * label as its accessibility name).
 */
function findByAriaLabel(node: unknown, label: string): AnyEl | null {
  if (node == null || typeof node !== "object") return null;
  const el = node as AnyEl;
  const props = el.props as { [k: string]: unknown; children?: unknown };
  if (props && props["aria-label"] === label) return el;
  const children = props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findByAriaLabel(child, label);
      if (found) return found;
    }
  } else if (children !== undefined) {
    const found = findByAriaLabel(children, label);
    if (found) return found;
  }
  return null;
}

const baseProps = {
  titleLabel: "Unsaved changes",
  bodyLabel: "You have unsaved changes. Leave anyway?",
  stayLabel: "Stay on page",
  leaveLabel: "Leave anyway",
};

describe("UnsavedChangesDialogView", () => {
  it("renders nothing when open=false", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: false,
      onStay,
      onLeave,
    });
    expect(result).toBeNull();
  });

  it("renders the title, body, stay button, and leave button when open=true", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    expect(result).not.toBeNull();
    expect(findByText(result, "Unsaved changes")).not.toBeNull();
    expect(
      findByText(result, "You have unsaved changes. Leave anyway?"),
    ).not.toBeNull();
    expect(findByText(result, "Stay on page")).not.toBeNull();
    expect(findByText(result, "Leave anyway")).not.toBeNull();
  });

  it("the Stay button's onClick calls onStay exactly once and does NOT call onLeave", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    const stayBtn = findByText(result, "Stay on page");
    expect(stayBtn).not.toBeNull();
    const onClick = stayBtn!.props.onClick as () => void;
    expect(typeof onClick).toBe("function");
    onClick();
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("the Leave button's onClick calls onLeave exactly once and does NOT call onStay", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    const leaveBtn = findByText(result, "Leave anyway");
    expect(leaveBtn).not.toBeNull();
    const onClick = leaveBtn!.props.onClick as () => void;
    expect(typeof onClick).toBe("function");
    onClick();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onStay).not.toHaveBeenCalled();
  });

  it("the X close button (aria-label=stayLabel) calls onStay", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    const closeBtn = findByAriaLabel(result, "Stay on page");
    expect(closeBtn).not.toBeNull();
    const onClick = closeBtn!.props.onClick as () => void;
    expect(typeof onClick).toBe("function");
    onClick();
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("the Stay button has autoFocus so the safe default catches an accidental Enter", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    const stayBtn = findByText(result, "Stay on page");
    expect(stayBtn).not.toBeNull();
    expect(stayBtn!.props.autoFocus).toBe(true);
  });

  it("the backdrop click handler calls onStay when target === currentTarget (not a child click)", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    // The outermost element is the backdrop; its onClick must dispatch
    // to onStay only when the click originates on the backdrop itself,
    // not when a click bubbles up from a child element.
    expect(result).not.toBeNull();
    const backdropOnClick = (result as AnyEl).props.onClick as (
      e: { target: unknown; currentTarget: unknown },
    ) => void;
    expect(typeof backdropOnClick).toBe("function");

    // Click on the backdrop itself — should fire onStay.
    const backdropEl = {};
    backdropOnClick({ target: backdropEl, currentTarget: backdropEl });
    expect(onStay).toHaveBeenCalledTimes(1);

    // Click bubbled up from a child — must NOT fire onStay again.
    backdropOnClick({ target: { childMarker: true }, currentTarget: backdropEl });
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("renders role=dialog and aria-modal=true on the inner card for assistive tech", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    const result = UnsavedChangesDialogView({
      ...baseProps,
      open: true,
      onStay,
      onLeave,
    });
    // Walk one level into the backdrop to reach the card.
    expect(result).not.toBeNull();
    const children = (result as AnyEl).props.children;
    // The card is the (single) child of the backdrop.
    const card = (Array.isArray(children) ? children[0] : children) as AnyEl;
    expect(card).toBeDefined();
    expect((card.props as { role?: string }).role).toBe("dialog");
    expect((card.props as { "aria-modal"?: boolean })["aria-modal"]).toBe(true);
    const labelledBy = (card.props as { "aria-labelledby"?: string })[
      "aria-labelledby"
    ];
    expect(typeof labelledBy).toBe("string");
    expect(labelledBy!.length).toBeGreaterThan(0);
  });
});

/* @version v0.4.1 */
