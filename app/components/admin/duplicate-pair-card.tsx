/**
 * DuplicatePairCard — the list unit for a scan-found duplicate pair.
 *
 * Two authority records answer to one name. Fisqua's scan finds the
 * pair but does not recommend on identity — it asks — so the ask slot
 * always carries the outlined-saffron judgement material via
 * `AskPanel`'s `judgement` state, never the filled recommendation
 * panel `VocabularyTermCard` uses.
 *
 * Each pane separates two registers with a hairline: provenance prose
 * above is evidence of identity, the thing an admin actually reasons
 * about; the description load below is the consequence of merging —
 * it says nothing about whether the two records are the same person.
 * Conflating the two is the defect the hairline fixes. A non-zero load
 * is the single most decision-relevant fact on an uneven card, so it
 * is promoted to heavy type; a zero count stays quiet — same slot,
 * same geometry, different mass. The design promotes only the count
 * phrase within the sentence, but `pairLoad` / `pairLoadNone` are each
 * a single translated string, and a translated sentence's phrase
 * boundary is not a stable place to split a `<b>` around. The ruled
 * adaptation from the duplicates design round is therefore whole-line
 * promotion: the entire load line takes the heavy treatment when the
 * count is non-zero, and stays quiet as a unit when it is zero.
 *
 * Direction (which record would survive a merge) is mechanical, never
 * a judgement — the alternative orphans whatever descriptions name the
 * losing form — so `directionNote` always renders in the quietest tone
 * on the card, even when it names a survivor. The open question above
 * it stays saffron regardless of what the direction line says.
 *
 * @version v0.7.0
 */

import { ChevronRight, Merge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "~/lib/use-formatters";
import { AskPanel, SectionLabelRow } from "./decision-panels";

export interface PairPaneRecord {
  /** Authority code, e.g. "ne-9v4vda". Set in mono. */
  code: string;
  /** Pre-translated record type, e.g. t("typePerson"). Rendered uppercase. */
  typeLabel: string;
  /** Where the record came from, in prose. */
  provenance: string;
  /** How many catalogue descriptions name this form. */
  descriptionCount: number;
}

function PairLoadLine({ count }: { count: number }) {
  const { t } = useTranslation("decisions");
  const { formatNumber } = useFormatters();
  return (
    <p
      className={`mt-2.5 border-t border-stone-200 pt-[9px] leading-[1.4] ${
        count > 0
          ? "text-sm font-semibold text-indigo"
          : "text-xs text-stone-500"
      }`}
    >
      {count > 0
        ? t("pairLoad", { count, formattedCount: formatNumber(count) })
        : t("pairLoadNone")}
    </p>
  );
}

function PairPane({ record }: { record: PairPaneRecord }) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2.5">
        <p className="font-mono text-11 font-medium tracking-[0.04em] text-stone-500">
          {record.code}
        </p>
        <p className="text-11 font-semibold uppercase tracking-[0.06em] text-stone-400">
          {record.typeLabel}
        </p>
      </div>
      <p className="mt-2 text-13 leading-[1.5] text-stone-700 [text-wrap:pretty]">
        {record.provenance}
      </p>
      <PairLoadLine count={record.descriptionCount} />
    </div>
  );
}

export function DuplicatePairCard({
  object,
  contextLine,
  left,
  right,
  question,
  directionNote,
  children,
  pending,
  onLookCloser,
  onKeepBoth,
  onMerge,
}: {
  /** The shared name both records answer to. */
  object: string;
  contextLine: string;
  left: PairPaneRecord;
  right: PairPaneRecord;
  /** The unresolved question. Always rendered in the saffron judgement material. */
  question: string;
  /** States the mechanical consequence of merging — which code
   *  survives and why. A statement of consequence, never a
   *  recommendation; the question above it stays open. */
  directionNote?: React.ReactNode;
  /** The comment thread — pass a `DecisionThread`. */
  children?: React.ReactNode;
  /** Disables the three actions while a ruling is in flight. */
  pending?: boolean;
  /** Opens the pair collation page. */
  onLookCloser: () => void;
  /** Must confirm through `DismissDialog` with `tone="neutral"`. */
  onKeepBoth: () => void;
  /** Must confirm through the pair merge dialog. Never merges without the direction step. */
  onMerge: () => void;
}) {
  const { t } = useTranslation("decisions");
  return (
    <div className="rounded-lg border border-stone-200 px-6 pb-4 pt-5 transition-shadow duration-150 hover:shadow-sm">
      <h3 className="font-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-indigo">
        {object}
      </h3>
      <p className="mt-[3px] text-13 text-stone-500">{contextLine}</p>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <PairPane record={left} />
        <PairPane record={right} />
      </div>
      {directionNote ? (
        <p className="mt-2.5 text-xs leading-[1.5] text-stone-500 [text-wrap:pretty]">
          {directionNote}
        </p>
      ) : null}

      <AskPanel value={question} judgement eyebrow={t("askQuestionEyebrow")} />

      {children ? (
        <>
          <SectionLabelRow label={t("commentsHeading")} />
          {children}
        </>
      ) : null}

      <div className="mt-4 flex items-center gap-2 border-t border-stone-200 pt-3">
        <button
          type="button"
          onClick={onLookCloser}
          disabled={pending}
          className="mr-auto inline-flex h-[42px] items-center gap-1.5 rounded-lg px-1.5 text-15 font-semibold text-indigo hover:underline disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("lookCloser")}
          <ChevronRight size={16} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onKeepBoth}
          disabled={pending}
          className="inline-flex h-[42px] items-center rounded-lg border border-stone-300 bg-white px-4 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("keepBoth")}
        </button>
        <button
          type="button"
          onClick={onMerge}
          disabled={pending}
          className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-verdigris pl-3.5 pr-4 text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Merge size={16} strokeWidth={1.75} />
          {t("mergeIntoOne")}
        </button>
      </div>
    </div>
  );
}
