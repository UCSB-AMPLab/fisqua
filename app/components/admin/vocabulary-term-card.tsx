/**
 * VocabularyTermCard — a near-duplicate subject term awaiting review.
 *
 * Unlike `DuplicatePairCard`, Fisqua *does* recommend here — an
 * incoming term near-matches one already approved, so the ask slot is
 * the filled verdigris recommendation panel (`AskPanel` with
 * `judgement={false}`), not the outlined saffron question. That is the
 * visible difference between a shape that asks and a shape that
 * recommends, and it is the same panel component in two states.
 *
 * Both term forms are set at the same size in the same two-pane grid
 * `DuplicatePairCard` uses, because the whole decision is whether two
 * strings differ only in form — the eye has to be able to collate
 * them, which a single title next to a smaller second string cannot
 * do. When `entityCounts` is supplied, each pane also carries the pair
 * card's load slot (whole-line promotion on a non-zero count, quiet
 * zero) — here the load is how many catalogue entities already use
 * each form, the consequence of a term merge rather than an identity
 * merge.
 *
 * There is no "look closer" door: the whole case fits on the card, so
 * a route to a fuller comparison would have nothing more to show.
 *
 * @version v0.7.0
 */

import { Merge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "~/lib/use-formatters";
import { AskPanel, SectionLabelRow } from "./decision-panels";

function VocabLoadLine({ count }: { count: number }) {
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
        ? t("vocabLoad", { count, formattedCount: formatNumber(count) })
        : t("vocabLoadNone")}
    </p>
  );
}

function VocabPane({
  label,
  term,
  provenance,
  count,
}: {
  label: string;
  term: string;
  provenance: string;
  count?: number;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 px-3.5 py-3">
      <p className="text-11 font-semibold uppercase tracking-[0.06em] text-stone-400">
        {label}
      </p>
      <p className="mt-[5px] font-serif text-[1.0625rem] leading-snug text-indigo">
        {term}
      </p>
      <p className="mt-2 text-13 leading-[1.5] text-stone-700 [text-wrap:pretty]">
        {provenance}
      </p>
      {count !== undefined ? <VocabLoadLine count={count} /> : null}
    </div>
  );
}

export function VocabularyTermCard({
  term,
  contextLine,
  termProvenance,
  existingTerm,
  existingProvenance,
  suggestedAction,
  directionNote,
  entityCounts,
  children,
  pending,
  onKeep,
  onMerge,
}: {
  /** The incoming term awaiting review, e.g. "cattle brands". */
  term: string;
  contextLine: string;
  termProvenance: string;
  /** The near-match already in the vocabulary, e.g. "cattle branding". */
  existingTerm: string;
  existingProvenance: string;
  /** Fisqua's recommendation, e.g. 'Merge into "cattle branding"'. */
  suggestedAction: string;
  /** Which form survives and why. */
  directionNote?: React.ReactNode;
  /** How many entities already use each form. Adds the load slot to both panes when given. */
  entityCounts?: { incoming: number; existing: number };
  /** The comment thread — pass a `DecisionThread`. */
  children?: React.ReactNode;
  /** Disables the two actions while a ruling is in flight. */
  pending?: boolean;
  /** Must confirm through `DismissDialog` with `tone="neutral"`. */
  onKeep: () => void;
  /** Must confirm through the pair merge dialog. */
  onMerge: () => void;
}) {
  const { t } = useTranslation("decisions");
  return (
    <div className="rounded-lg border border-stone-200 px-6 pb-4 pt-5 transition-shadow duration-150 hover:shadow-sm">
      <h3 className="font-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-indigo">
        {term}
      </h3>
      <p className="mt-[3px] text-13 text-stone-500">{contextLine}</p>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <VocabPane
          label={t("vocabIncomingLabel")}
          term={term}
          provenance={termProvenance}
          count={entityCounts?.incoming}
        />
        <VocabPane
          label={t("vocabExistingLabel")}
          term={existingTerm}
          provenance={existingProvenance}
          count={entityCounts?.existing}
        />
      </div>
      {directionNote ? (
        <p className="mt-2.5 text-xs leading-[1.5] text-stone-500 [text-wrap:pretty]">
          {directionNote}
        </p>
      ) : null}

      <AskPanel value={suggestedAction} judgement={false} />

      {children ? (
        <>
          <SectionLabelRow label={t("commentsHeading")} />
          {children}
        </>
      ) : null}

      <div className="mt-4 flex items-center gap-2 border-t border-stone-200 pt-3">
        <button
          type="button"
          onClick={onKeep}
          disabled={pending}
          className="ml-auto inline-flex h-[42px] items-center rounded-lg border border-stone-300 bg-white px-4 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("keepOwnTerm")}
        </button>
        <button
          type="button"
          onClick={onMerge}
          disabled={pending}
          className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-verdigris pl-3.5 pr-4 text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Merge size={16} strokeWidth={1.75} />
          {t("mergeIntoExisting")}
        </button>
      </div>
    </div>
  );
}
