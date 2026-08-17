/**
 * Pager — numbered paging for a list of results
 *
 * This component deals with the strip under a result list: the sentence
 * that says where you are in the set ("Showing 1–25 of 113"), and the
 * Previous · numbers · Next controls that move you through it.
 *
 * PLAIN LINKS, NO CLIENT PAGING. Every control is a `<Link>` to a URL
 * the caller builds through `makeHref`, so a page is addressable,
 * bookmarkable and back-navigable, and the list itself is re-read by
 * the loader rather than assembled in the browser. The component holds
 * no state of its own — the current page is a prop, because the URL is
 * where a page number lives.
 *
 * THE WINDOW. Up to seven pages are all shown, because seven numbers
 * fit and a person can see the whole extent at a glance. Past that the
 * strip shows a window of five around the current page with an ellipsis
 * standing for what was dropped: a longer strip stops being readable,
 * and the pages a person actually wants next are the neighbouring ones.
 * The ellipsis is not a control — it says "there is more this way",
 * and Previous/Next is how you get there.
 *
 * THE HINT is an optional half-sentence appended to the range line. It
 * exists for the selection layer, which needs to promise that ticks
 * survive paging at exactly the moment a person is about to page; a
 * caller with nothing to add leaves it out and the line is just the
 * range.
 *
 * @version v0.7.0
 */
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

/** Pages shown in full before the strip starts eliding. */
const FULL_STRIP_LIMIT = 7;
/** Numbers shown around the current page once it does. */
const WINDOW = 5;

export interface PagerProps {
  /** 1-based, as it travels in the URL. */
  page: number;
  pageSize: number;
  /** Rows in the whole set, under whatever narrowed it. */
  total: number;
  /** The URL for a given page — the caller owns every other param. */
  makeHref: (page: number) => string;
  /** Optional half-sentence appended to the range line. */
  hint?: string;
}

/** A number to link to, or the gap where numbers were dropped. */
type Slot = number | "gap";

/**
 * The numbers the strip shows. Short sets show every page; longer ones
 * show a window of five, clamped to the ends so the strip never
 * shrinks as it reaches them, with a gap marking each side that was
 * cut.
 */
function slots(page: number, pages: number): Slot[] {
  if (pages <= FULL_STRIP_LIMIT) {
    return Array.from({ length: pages }, (_, i) => i + 1);
  }
  const span = WINDOW - 1;
  let start = Math.max(1, page - Math.floor(span / 2));
  const end = Math.min(pages, start + span);
  start = Math.max(1, end - span);

  const out: Slot[] = [];
  if (start > 1) out.push("gap");
  for (let n = start; n <= end; n += 1) out.push(n);
  if (end < pages) out.push("gap");
  return out;
}

const CELL =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-lg border px-2 text-13";
const CELL_LINK = `${CELL} border-stone-200 text-stone-700 hover:bg-stone-50`;
const CELL_CURRENT = `${CELL} border-indigo bg-indigo font-semibold text-parchment`;
const CELL_SPENT = `${CELL} border-stone-100 text-stone-300`;

export function Pager({ page, pageSize, total, makeHref, hint }: PagerProps) {
  const { t } = useTranslation("search");
  if (total <= 0) return null;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  // A page number out of range is a stale link, not an error: the
  // strip renders around the nearest real page rather than reporting
  // a position that does not exist.
  const current = Math.min(Math.max(1, Math.floor(page)), pages);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  return (
    <div className="mt-5 flex items-center justify-between gap-3">
      <p className="text-13 tabular-nums text-stone-500">
        {t("showingRange", { from, to, count: total })}
        {hint ? ` · ${hint}` : null}
      </p>
      {pages > 1 && (
        <nav className="flex gap-1.5">
          {current > 1 ? (
            <Link to={makeHref(current - 1)} className={CELL_LINK} rel="prev">
              {t("previous")}
            </Link>
          ) : (
            <span className={CELL_SPENT} aria-hidden="true">
              {t("previous")}
            </span>
          )}

          {slots(current, pages).map((slot, i) =>
            slot === "gap" ? (
              <span
                key={`gap-${i}`}
                aria-hidden="true"
                className="inline-flex h-7 min-w-7 items-center justify-center px-1 text-13 text-stone-400"
              >
                …
              </span>
            ) : slot === current ? (
              <span key={slot} aria-current="page" className={CELL_CURRENT}>
                {slot}
              </span>
            ) : (
              <Link key={slot} to={makeHref(slot)} className={CELL_LINK}>
                {slot}
              </Link>
            ),
          )}

          {current < pages ? (
            <Link to={makeHref(current + 1)} className={CELL_LINK} rel="next">
              {t("next")}
            </Link>
          ) : (
            <span className={CELL_SPENT} aria-hidden="true">
              {t("next")}
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
