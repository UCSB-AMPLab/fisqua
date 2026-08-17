/**
 * BranchPicker — the hierarchy, filtered in place
 *
 * The What axis names a scope, and in an archive a scope is a position
 * in the hierarchy. So the picker is the hierarchy itself rather than a
 * typeahead over it: a typeahead answers "which collection" but not
 * "where am I", and a bare tree would not survive a workspace with
 * hundreds of collections. The filter narrows the same tree instead of
 * replacing it with a list — a hit keeps its ancestors, dimmed, so it
 * never loses its position.
 *
 * WHAT IT SHOWS IS CONTAINERS, NOT EVERY RECORD. The tree carries the
 * nodes that have something beneath them plus the roots; an item-level
 * description is inside one of them and comes with it. Choosing a node
 * takes everything beneath it, which is why the foot states the
 * consequence in RECORDS rather than in nodes — "2,140 records across 8
 * sub-series beneath it" is the sentence a cataloguer can act on, and
 * "1 node selected" is not.
 *
 * Presentational and controlled: the caller owns the chosen id and the
 * open state, exactly as the handlist dialogs do, so the same picker
 * can be driven by a loader-backed page or by a test.
 *
 * @version v0.7.0
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useExportLabels } from "./export-labels";

/** One choosable position in the hierarchy. */
export interface BranchNode {
  id: string;
  parentId: string | null;
  title: string;
  referenceCode: string;
  /** The node and everything beneath it — what would leave. */
  records: number;
  /** Containers beneath it: the card's "8 sub-series". */
  seriesBeneath: number;
}

/** Accents folded and case dropped: "Misión" matches "mision". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** The matched run of a title, so the hit can be marked in saffron. */
function markMatch(text: string, term: string) {
  if (term === "") return text;
  const at = fold(text).indexOf(fold(term));
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-saffron-tint text-inherit">
        {text.slice(at, at + term.length)}
      </mark>
      {text.slice(at + term.length)}
    </>
  );
}

export function BranchPicker({
  nodes,
  chosenId,
  onChoose,
  onCancel,
}: {
  nodes: BranchNode[];
  chosenId: string | null;
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();
  const [term, setTerm] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(chosenId);

  const byParent = useMemo(() => {
    const map = new Map<string | null, BranchNode[]>();
    for (const node of nodes) {
      const list = map.get(node.parentId) ?? [];
      list.push(node);
      map.set(node.parentId, list);
    }
    // A node whose parent is not itself a container (an item's parent
    // filtered out of the tree) would otherwise be unreachable; the
    // roots list picks those up by treating an absent parent as a root.
    const present = new Set(nodes.map((n) => n.id));
    const roots = map.get(null) ?? [];
    for (const node of nodes) {
      if (node.parentId !== null && !present.has(node.parentId)) {
        roots.push(node);
      }
    }
    map.set(null, roots);
    return map;
  }, [nodes]);

  /**
   * Which nodes survive the filter: the matches themselves, plus every
   * ancestor of a match, which stays as dimmed context.
   */
  const { visible, matched } = useMemo(() => {
    if (term.trim() === "") {
      return { visible: null as Set<string> | null, matched: new Set<string>() };
    }
    const needle = fold(term.trim());
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hits = new Set<string>();
    for (const node of nodes) {
      if (
        fold(node.title).includes(needle) ||
        fold(node.referenceCode).includes(needle)
      ) {
        hits.add(node.id);
      }
    }
    const shown = new Set(hits);
    for (const id of hits) {
      let cursor = byId.get(id)?.parentId ?? null;
      while (cursor !== null && !shown.has(cursor)) {
        shown.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
      }
    }
    return { visible: shown, matched: hits };
  }, [nodes, term]);

  const chosen = useMemo(
    () => nodes.find((n) => n.id === selected) ?? null,
    [nodes, selected],
  );

  const matchCollections = useMemo(() => {
    if (visible === null) return 0;
    const roots = new Set<string>();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const id of matched) {
      let cursor = id;
      let parent = byId.get(cursor)?.parentId ?? null;
      while (parent !== null && byId.has(parent)) {
        cursor = parent;
        parent = byId.get(cursor)?.parentId ?? null;
      }
      roots.add(cursor);
    }
    return roots.size;
  }, [matched, nodes, visible]);

  const renderLevel = (parentId: string | null, depth: number) => {
    const children = byParent.get(parentId) ?? [];
    const shown =
      visible === null ? children : children.filter((c) => visible.has(c.id));
    const hidden = children.length - shown.length;

    return (
      <>
        {shown.map((node) => {
          const kids = byParent.get(node.id) ?? [];
          const hasKids =
            visible === null
              ? kids.length > 0
              : kids.some((k) => visible.has(k.id));
          const open = !collapsed.has(node.id);
          const isMatch = visible !== null && matched.has(node.id);
          const isContext = visible !== null && !isMatch;
          const isSelected = node.id === selected;

          return (
            <div key={node.id}>
              <div
                className={`flex items-center gap-2 rounded-sm py-1.5 pr-2 ${
                  isSelected ? "bg-indigo-wash" : "hover:bg-stone-50"
                }`}
                style={{ paddingLeft: `${depth * 18 + 4}px` }}
              >
                {hasKids ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={node.title}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(node.id)) next.delete(node.id);
                        else next.add(node.id);
                        return next;
                      })
                    }
                    className="flex-none text-stone-400 hover:text-stone-600"
                  >
                    {open ? (
                      <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </button>
                ) : (
                  <span className="h-3.5 w-3.5 flex-none" />
                )}
                <button
                  type="button"
                  onClick={() => setSelected(node.id)}
                  className={`flex min-w-0 flex-1 items-center gap-2 text-left ${
                    isContext ? "opacity-45" : ""
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-13 ${
                      isSelected
                        ? "font-semibold text-indigo"
                        : "text-stone-700"
                    }`}
                  >
                    {markMatch(node.title, term.trim())}
                  </span>
                  <span className="flex-none font-mono text-11 nums text-stone-400">
                    {labels.number(node.records)}
                  </span>
                </button>
              </div>
              {hasKids && open && renderLevel(node.id, depth + 1)}
            </div>
          );
        })}
        {hidden > 0 && (
          <p
            className="py-1 font-sans text-11 text-stone-400"
            style={{ paddingLeft: `${depth * 18 + 26}px` }}
          >
            {t("branchHidden", { count: hidden })}
          </p>
        )}
      </>
    );
  };

  const roots = byParent.get(null) ?? [];
  const nothingMatches = visible !== null && matched.size === 0;

  return (
    <div
      className="mt-2 rounded-md border border-stone-200 bg-white"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2">
        <input
          type="text"
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t("branchFilterPlaceholder")}
          className="h-8 min-w-0 flex-1 rounded border border-stone-200 px-2 text-13 text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none"
        />
        <button
          type="button"
          onClick={onCancel}
          className="flex-none rounded border border-stone-200 px-1.5 py-0.5 font-mono text-11 uppercase text-stone-400 hover:text-stone-600"
        >
          {t("branchEscHint")}
        </button>
      </div>

      <div className="max-h-[280px] overflow-y-auto px-2 py-2">
        {roots.length === 0 ? (
          <div className="px-2 py-6 text-center">
            <b className="block font-serif text-15 font-semibold text-indigo">
              {t("branchEmptyHeading")}
            </b>
            <small className="mt-1 block text-13 leading-normal text-stone-500">
              {t("branchEmptyBody")}
            </small>
          </div>
        ) : nothingMatches ? (
          <div className="px-2 py-6 text-center">
            <b className="block font-serif text-15 font-semibold text-indigo">
              {t("branchNoMatchHeading", { term: term.trim() })}
            </b>
            <small className="mt-1 block text-13 leading-normal text-stone-500">
              {t("branchNoMatchBody")}
            </small>
          </div>
        ) : (
          renderLevel(null, 0)
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-stone-200 px-3 py-2">
        <p className="min-w-0 flex-1 text-13 leading-snug text-stone-500">
          {nothingMatches
            ? t("branchNoMatchCount")
            : chosen
              ? chosen.seriesBeneath > 0
                ? t("branchChosen", {
                    name: chosen.title,
                    records: labels.count("records", chosen.records),
                    series: labels.count("series", chosen.seriesBeneath),
                  })
                : t("branchChosenFlat", {
                    name: chosen.title,
                    records: labels.count("records", chosen.records),
                  })
              : visible !== null
                ? t("branchMatches", {
                    count: matched.size,
                    collections: labels.count("collections", matchCollections),
                  })
                : t("branchNothingChosen")}
        </p>
        <button
          type="button"
          disabled={chosen === null}
          onClick={() => chosen && onChoose(chosen.id)}
          className="inline-flex h-9 flex-none items-center rounded-md bg-indigo px-3.5 font-sans text-13 font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("branchUse")}
        </button>
      </div>
    </div>
  );
}

/* @version v0.7.0 */
