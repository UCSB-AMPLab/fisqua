/**
 * Marked text
 *
 * This component renders a search snippet or title whose matched words
 * are wrapped in the highlight markers the search statements emit
 * (HIGHLIGHT_OPEN and HIGHLIGHT_CLOSE in `global-search.server.ts`).
 * The markers reach the page through a loader payload, since the client
 * cannot import a server module. The workspace search page and the
 * transcript view both render their snippets through it, so a matched
 * word looks the same in both.
 *
 * @version v0.8.0
 */


/**
 * Split a marked string into plain and matched runs. The markers are
 * control characters chosen because they cannot occur in stored text,
 * so the split is unambiguous and the result goes into the tree as
 * React children — never as raw HTML. A browse-mode title carries no
 * markers at all and comes through as one plain run.
 */
export function markedRuns(
  text: string,
  open: string,
  close: string,
): { text: string; hit: boolean }[] {
  const runs: { text: string; hit: boolean }[] = [];
  let rest = text;
  while (rest.length > 0) {
    const start = rest.indexOf(open);
    if (start === -1) {
      // A stray close marker with no opener would otherwise land in the
      // DOM as an invisible control character — strip, never render.
      runs.push({ text: rest.replaceAll(close, ""), hit: false });
      break;
    }
    if (start > 0) runs.push({ text: rest.slice(0, start), hit: false });
    const afterOpen = rest.slice(start + open.length);
    const end = afterOpen.indexOf(close);
    if (end === -1) {
      // An unclosed marker can only mean a truncated snippet; take the
      // remainder as matched rather than dropping it.
      runs.push({ text: afterOpen, hit: true });
      break;
    }
    runs.push({ text: afterOpen.slice(0, end), hit: true });
    rest = afterOpen.slice(end + close.length);
  }
  return runs;
}

export function Marked({
  text,
  markers,
}: {
  text: string;
  markers: { open: string; close: string };
}) {
  return (
    <>
      {markedRuns(text, markers.open, markers.close).map((run, i) =>
        run.hit ? (
          <mark
            key={i}
            className="rounded-[2px] bg-saffron-tint px-px text-inherit"
          >
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}
