/**
 * Description actions — add to a handlist or the queue while browsing
 *
 * This module deals with the actions a person can take on a description
 * from the Descriptions screen, without opening its page: add it to a
 * handlist, add it to the digitization queue, and add the descriptions
 * below it to the queue. It reuses the two controls that do this
 * everywhere else, `HandlistPicker` (which posts to `/handlists/add`)
 * and `AddToQueueButton` (which posts to `/admin/capture/queue/add`),
 * so the rules and the messages are the ones the description page,
 * search and handlists already use.
 *
 * `DescriptionActionsProvider` wraps a view (the file tree or the
 * column view) and holds the one menu the view may have open.
 * `DescriptionActionsTrigger` is the small "more" button on each row; it
 * renders nothing outside a provider and nothing for a repository row.
 * Opening it shows the menu in a panel fixed to the viewport beside the
 * button (`placeMenu`: below it when there is room, above it when there
 * is more room there, and never past the viewport's sides), rendered by
 * the provider outside the rows, so a virtualised
 * column's transformed rows neither paint over it nor trap the handlist
 * dialog, and a click in it never reaches the row's own click handler.
 * The panel takes focus on its first item; the arrow keys move between
 * items (`nextMenuIndex`), Tab moves through them, and Escape closes it
 * and puts focus back on the button. While the handlist dialog opened
 * from it is showing, the menu stands aside: its arrow keys do nothing,
 * its queue items are inert, and focus moves into the dialog; when the
 * dialog closes, focus returns to the menu's handlist item. A click outside, or scrolling the page behind
 * it, closes it too.
 *
 * `DescriptionActionButtons` shows the same actions as a column of
 * buttons, for the file tree's preview pane.
 *
 * The queue actions show only under `canQueue`, which the screen's
 * loader computes once per page: the workspace has the digitization
 * capability and the person manages capture work. "Add the N
 * descriptions below this" needs a count, and counting walks the
 * hierarchy, so it is asked for (`belowCountHref`, a GET to the add
 * route) only when a menu opens or the preview pane shows a description,
 * and only for a description with children. The item appears when the
 * count comes back from 1 to 50; the route answers null otherwise.
 *
 * @version v0.9.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import { HandlistPicker } from "~/components/handlists/handlist-picker";
import { AddToQueueButton } from "~/components/capture/add-to-queue";

/** What the actions need to know about a description. */
export interface ActionTarget {
  id: string;
  title: string;
  childCount: number;
  kind?: "repository" | "description";
}

/** Where to ask how many "add everything below this" would add, or null when not to ask. */
export function belowCountHref(target: ActionTarget, canQueue: boolean): string | null {
  if (!canQueue || target.kind === "repository" || target.childCount <= 0) return null;
  return `/admin/capture/queue/add?below=${encodeURIComponent(target.id)}`;
}

/** The count, once the add route has answered; null before and when it does not apply. */
function useBelowCount(target: ActionTarget, canQueue: boolean): number | null {
  const fetcher = useFetcher<{ below: number | null }>();
  const href = belowCountHref(target, canQueue);
  useEffect(() => {
    if (href) fetcher.load(href);
    // The fetcher's identity changes with its state; asking again on
    // that would loop. The href alone says what to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);
  return href && fetcher.state === "idle" ? (fetcher.data?.below ?? null) : null;
}

const MENU_ITEM =
  "flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-13 text-stone-700 hover:bg-stone-50 focus:bg-stone-50 focus:outline-none disabled:cursor-wait disabled:opacity-50";
const MENU_ITEM_BOX =
  "flex w-full flex-col items-stretch [&>[role=status]]:mt-0 [&>[role=status]]:px-3 [&>[role=status]]:pb-2";
const PANE_BUTTON =
  "inline-flex w-full items-center justify-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-50 disabled:cursor-wait disabled:opacity-50";
const PANE_BUTTON_BOX = "flex w-full flex-col items-stretch";

/** The actions themselves, as menu items or as pane buttons. */
function ActionItems({
  target,
  canQueue,
  variant,
  suspended = false,
}: {
  target: ActionTarget;
  canQueue: boolean;
  variant: "menu" | "pane";
  /** The handlist dialog is open over the menu: the queue items take no focus or clicks. */
  suspended?: boolean;
}) {
  const { t: th } = useTranslation("handlists");
  const { t: tq } = useTranslation("capture");
  const below = useBelowCount(target, canQueue);
  const button = variant === "menu" ? MENU_ITEM : PANE_BUTTON;
  const box = variant === "menu" ? MENU_ITEM_BOX : PANE_BUTTON_BOX;

  return (
    <>
      <HandlistPicker
        recordType="records"
        memberIds={[target.id]}
        triggerLabel={th("pickerAddTitle")}
        triggerClassName={button}
      />
      <div className="contents" inert={suspended}>
        {canQueue ? (
          <AddToQueueButton
            target={{ descriptionIds: [target.id] }}
            label={tq("dqueue.add")}
            className={button}
            wrapperClassName={box}
          />
        ) : null}
        {canQueue && below !== null ? (
          <AddToQueueButton
            target={{ below: target.id }}
            label={tq("dqueue.add_below", { count: below })}
            className={button}
            wrapperClassName={box}
          />
        ) : null}
      </div>
    </>
  );
}

type MenuKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Which item a navigation key moves focus to, from `current` (-1 when
 * focus is on none of them), wrapping at both ends. Null for any other
 * key, for an empty menu, and while the handlist dialog is open over the
 * menu, whose keys are the dialog's.
 */
export function nextMenuIndex(key: string, count: number, current: number, dialogOpen: boolean): number | null {
  if (dialogOpen || count === 0) return null;
  switch (key as MenuKey) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The menu: one per view, opened from a row's button
// ---------------------------------------------------------------------------

interface OpenMenu {
  target: ActionTarget;
  /** The button that opened it; null only for a menu rendered open from the start. */
  anchor: HTMLElement | null;
}

interface ActionsContextValue {
  canQueue: boolean;
  openId: string | null;
  panelId: string;
  toggle: (target: ActionTarget, anchor: HTMLElement) => void;
}

const ActionsContext = createContext<ActionsContextValue | null>(null);

const PANEL_WIDTH = 288;

/** Where a fixed menu goes: `top` when it opens below its button, `bottom` when above. */
export interface MenuPlacement {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Place a menu of the given size beside a button, in viewport
 * coordinates. Its right edge lines up with the button's, moved in so
 * it keeps `margin` from both sides of the viewport (from the left when
 * the viewport is narrower than the menu). It opens below the button
 * when it fits there, or when there is at least as much room below as
 * above; otherwise above, anchored by its bottom edge so a menu that
 * grows grows upwards. `maxHeight` is the room on the chosen side, so a
 * menu taller than both scrolls instead of leaving the viewport.
 */
export function placeMenu(
  anchor: { top: number; bottom: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 4,
  margin = 8,
): MenuPlacement {
  const left = Math.max(margin, Math.min(anchor.right - panel.width, viewport.width - panel.width - margin));
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  if (panel.height <= below || below >= above) {
    return { left, top: anchor.bottom + gap, maxHeight: Math.max(0, below) };
  }
  return { left, bottom: viewport.height - anchor.top + gap, maxHeight: Math.max(0, above) };
}

export function DescriptionActionsProvider({
  canQueue,
  initialOpen = null,
  children,
}: {
  canQueue: boolean;
  /** A menu shown open on the first render, for a render without clicks. */
  initialOpen?: ActionTarget | null;
  children?: ReactNode;
}) {
  const [menu, setMenu] = useState<OpenMenu | null>(initialOpen ? { target: initialOpen, anchor: null } : null);
  const panelId = useId();

  const toggle = useCallback((target: ActionTarget, anchor: HTMLElement) => {
    setMenu((current) => (current?.target.id === target.id ? null : { target, anchor }));
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return (
    <ActionsContext.Provider value={{ canQueue, openId: menu?.target.id ?? null, panelId, toggle }}>
      {children}
      {menu ? (
        <MenuPanel key={menu.target.id} id={panelId} menu={menu} canQueue={canQueue} onClose={close} />
      ) : null}
    </ActionsContext.Provider>
  );
}

function MenuPanel({
  id,
  menu,
  canQueue,
  onClose,
}: {
  id: string;
  menu: OpenMenu;
  canQueue: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("descriptions_admin");
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPlacement | null>(null);
  const focused = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // The handlist dialog renders inside the panel. Watch for it: focus
  // goes into it when it appears, and back to the item that opened it
  // when it goes, unless the whole menu went with it.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof MutationObserver === "undefined") return;
    let open = false;
    const check = () => {
      const dialog = panel.querySelector<HTMLElement>("[role=dialog]");
      if (dialog && !open) {
        open = true;
        setDialogOpen(true);
        dialog.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
      } else if (!dialog && open) {
        open = false;
        setDialogOpen(false);
        panel.querySelector<HTMLElement>("button:not([disabled])")?.focus();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Beside the button that opened it, inside the viewport, and placed
  // again when its content changes size (the below item arriving, a
  // queue result appearing).
  useEffect(() => {
    const anchor = menu.anchor;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition(
        placeMenu(
          rect,
          { width: PANEL_WIDTH, height: panel.scrollHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(place);
    for (const child of Array.from(panel.children)) observer.observe(child);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [menu.anchor]);

  // Focus goes to the first item once, when the panel is first placed.
  useEffect(() => {
    if (!position || focused.current) return;
    focused.current = true;
    panelRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }, [position]);

  useEffect(() => {
    const inside = (node: EventTarget | null) =>
      node instanceof Node && (panelRef.current?.contains(node) || menu.anchor?.contains(node));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      menu.anchor?.focus();
      onClose();
    };
    const onPointer = (event: MouseEvent) => {
      if (!inside(event.target)) onClose();
    };
    // A fixed panel would drift from its row as the page scrolls; a
    // scroll inside the panel (the handlist list) is its own.
    const onScroll = (event: Event) => {
      if (!inside(event.target)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [menu.anchor, onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The dialog's own markup is the second test: the flag trails the
    // render that put the dialog in.
    const open = dialogOpen || Boolean(panelRef.current?.querySelector("[role=dialog]"));
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []).filter(
      (el) => !el.closest("[role=dialog]") && !el.closest("[inert]"),
    );
    const next = nextMenuIndex(event.key, items.length, items.indexOf(document.activeElement as HTMLElement), open);
    if (next === null) return;
    event.preventDefault();
    items[next].focus();
  };

  return (
    <div
      ref={panelRef}
      id={id}
      role="group"
      aria-label={t("row_actions", { title: menu.target.title })}
      onKeyDown={onKeyDown}
      style={
        position
          ? { top: position.top, bottom: position.bottom, left: position.left, maxHeight: position.maxHeight, width: PANEL_WIDTH }
          : { width: PANEL_WIDTH }
      }
      className={`${position || !menu.anchor ? "" : "invisible "}fixed z-40 overflow-y-auto rounded-md border border-stone-200 bg-white py-1 shadow-md`}
    >
      <ActionItems target={menu.target} canQueue={canQueue} variant="menu" suspended={dialogOpen} />
    </div>
  );
}

/** The small "more" button on a row; nothing outside a provider or for a repository. */
export function DescriptionActionsTrigger({
  target,
  tone = "light",
}: {
  target: ActionTarget;
  /** `dark` on a selected row's indigo ground. */
  tone?: "light" | "dark";
}) {
  const { t } = useTranslation("descriptions_admin");
  const context = useContext(ActionsContext);
  if (!context || target.kind === "repository") return null;
  const open = context.openId === target.id;
  return (
    <button
      type="button"
      aria-label={t("row_actions", { title: target.title })}
      aria-expanded={open}
      aria-controls={open ? context.panelId : undefined}
      onClick={(event) => {
        // The row's own click selects or navigates; this one only opens the menu.
        event.stopPropagation();
        context.toggle(target, event.currentTarget);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={`flex h-7 w-7 flex-none items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo ${
        tone === "dark"
          ? "text-white/70 hover:bg-white/15 hover:text-white"
          : "text-stone-400 hover:bg-stone-100 hover:text-stone-700"
      }`}
    >
      <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
    </button>
  );
}

/** The same actions as a column of buttons, for the preview pane. */
export function DescriptionActionButtons({ target, canQueue }: { target: ActionTarget; canQueue: boolean }) {
  if (target.kind === "repository") return null;
  // Keyed by the description so a new selection starts a fresh count.
  return <ActionItems key={target.id} target={target} canQueue={canQueue} variant="pane" />;
}

// @version v0.9.0
