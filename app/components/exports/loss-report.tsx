/**
 * CrosswalkLossBlock — what a form that is not your own costs
 *
 * Two of the export choices are perfectly legal and quietly lossy.
 * Crosswalking to a standard that is not this workspace's own drops
 * fields that have nowhere to go; this block says which fields, on how
 * many records, in the same breath as the choice that causes it —
 * under the FORM axis, at the moment of choosing, never discovered in
 * the file afterwards.
 *
 * SAFFRON, NOT MADDER. Madder is the dye of refusal: the tile that
 * cannot be chosen, the run that stopped. A crosswalk SUCCEEDS. What
 * it needs is a cataloguer who knows what arrived and what did not,
 * which is a different tone and a different colour — and colouring it
 * like an error would teach people to click past the colour that means
 * a run will fail.
 *
 * THREE KINDS OF LOSS, NAMED SEPARATELY, because they are different
 * harms: dropped is absence, merged is ambiguity, flattened is the
 * loss of structure. Merged is the most dangerous of the three,
 * because the file looks complete.
 *
 * EVERY NUMBER IS REAL. "Some data may be lost" is an apology, not a
 * warning; "arrangement (47 records), custodial history (213)" is
 * something a cataloguer can act on. The counts come from the loss
 * computation over the chosen scope, not from a static table of what
 * the standards can hold.
 *
 * The lossless way out is always offered, and needs no explanation:
 * the workspace's own standard is lossless by definition, so the
 * escape is one button.
 *
 * @version v0.7.0
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { CrosswalkLoss } from "~/lib/export/loss.server";
import { fieldKey, useExportLabels } from "./export-labels";

/**
 * The compact restatement the confirm dialog carries on its Form row.
 * It is never the first mention — the block below has already been
 * read once under the axis — so it counts rather than explains.
 */
export function useLossSummary(): (loss: CrosswalkLoss) => string {
  const { t } = useTranslation("exports");
  return useCallback(
    (loss: CrosswalkLoss) => {
      const parts: string[] = [];
      if (loss.dropped.length > 0) {
        parts.push(t("lossCompactDropped", { count: loss.dropped.length }));
      }
      if (loss.merged.length > 0) {
        parts.push(t("lossCompactMerged", { count: loss.merged.length }));
      }
      if (loss.flattened !== null) parts.push(t("lossCompactFlattened"));
      return parts.join(", ");
    },
    [t],
  );
}

export function CrosswalkLossBlock({
  loss,
  formLabel,
  ownLabel,
  onUseOwn,
}: {
  loss: CrosswalkLoss;
  /** The chosen form, already in the reader's language. */
  formLabel: string;
  /** The workspace's own standard, likewise. */
  ownLabel: string;
  onUseOwn: () => void;
}) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();

  /** "arrangement (47 records), custodial history (213), or …" */
  const droppedFields = (): string => {
    const named = loss.dropped.map((entry, index) => {
      const field = t(fieldKey(entry.field), { defaultValue: entry.field });
      return index === 0
        ? t("lossFieldFirst", {
            count: entry.count,
            field,
            formatted: labels.number(entry.count),
          })
        : t("lossField", { field, formatted: labels.number(entry.count) });
    });
    if (named.length <= 1) return named.join("");
    const head = named.slice(0, -1).join(", ");
    return t("joinOr", { head, tail: named[named.length - 1] });
  };

  const mergedFields = (fields: string[]): string => {
    const named = fields.map((f) => t(fieldKey(f), { defaultValue: f }));
    if (named.length === 2) return t("lossMergedPair", { a: named[0], b: named[1] });
    return named.join(", ");
  };

  return (
    <div className="mt-3 rounded-md border border-saffron-tint bg-saffron-tint/40 px-3.5 py-3">
      <b className="block font-sans text-13 font-semibold leading-snug text-saffron-deep">
        {t("lossTitle", { form: formLabel, own: ownLabel })}
      </b>

      {loss.dropped.length > 0 && (
        <p className="mt-2.5 text-13 leading-normal text-stone-700">
          <b className="mr-1.5 font-semibold uppercase tracking-[0.06em] text-11 text-saffron-deep">
            {t("lossDroppedLabel")}
          </b>
          {t("lossDroppedBody", {
            form: formLabel,
            own: ownLabel,
            fields: droppedFields(),
          })}
        </p>
      )}

      {loss.merged.length > 0 && (
        <p className="mt-2.5 text-13 leading-normal text-stone-700">
          <b className="mr-1.5 font-semibold uppercase tracking-[0.06em] text-11 text-saffron-deep">
            {t("lossMergedLabel")}
          </b>
          {loss.merged.map((entry, index) =>
            index === 0
              ? t("lossMergedFirst", {
                  count: entry.count,
                  fields: mergedFields(entry.fields),
                  into: entry.into,
                  formatted: labels.number(entry.count),
                })
              : ` ${t("lossMergedMore", {
                  fields: mergedFields(entry.fields),
                  into: entry.into,
                })}`,
          )}
        </p>
      )}

      {loss.flattened !== null && (
        <p className="mt-2.5 text-13 leading-normal text-stone-700">
          <b className="mr-1.5 font-semibold uppercase tracking-[0.06em] text-11 text-saffron-deep">
            {t("lossFlattenedLabel")}
          </b>
          {t("lossFlattenedBody", {
            form: formLabel,
            records: labels.count("records", loss.flattened.belowTop),
            series: labels.count("series", loss.flattened.series),
            collections: labels.count("collections", loss.flattened.collections),
            plain: labels.number(loss.flattened.belowTop),
          })}
        </p>
      )}

      <p className="mt-3 text-13 leading-normal text-stone-600">
        {t("lossFooter")}
      </p>
      <button
        type="button"
        onClick={onUseOwn}
        className="mt-2 inline-flex h-9 items-center rounded-md border border-saffron-deep/40 bg-white px-3 font-sans text-13 font-semibold text-saffron-deep hover:bg-saffron-tint"
      >
        {t("lossEscape", { standard: ownLabel })}
      </button>
    </div>
  );
}

/* @version v0.7.0 */
