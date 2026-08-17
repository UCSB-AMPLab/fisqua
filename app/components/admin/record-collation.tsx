/**
 * RecordCollation — the field-by-field comparison table on the duplicate
 * pair's "Look closer" route.
 *
 * A pair wants collation, not a form: there is nothing to fill in, only
 * two existing records to read side by side, which is what an archivist
 * actually does. So this page is a single full-width table rather than
 * the proposal detail's form-plus-aside layout.
 *
 * The table highlights what bears on the decision by contrast alone —
 * no badges, no "differs" markers, no legend. A row where both records
 * agree recedes to `text-stone-500` and stops competing; a row where
 * they disagree holds `text-indigo`. `same` is inferred by strict
 * equality when both values are plain strings; pass it explicitly when
 * either side is a richer node (per the duplicates design round).
 *
 * @version v0.7.0
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface CollationField {
  /** Pre-translated row label, e.g. "Name in source". */
  label: string;
  /** Left record's value. */
  a: ReactNode;
  /** Right record's value. */
  b: ReactNode;
  /** Pass explicitly when a or b is not a plain string. */
  same?: boolean;
}

const ROW_CLASSES =
  "grid grid-cols-[11rem_1fr_1fr] gap-5 border-b border-stone-200";
const KEY_CLASSES =
  "text-11 font-semibold uppercase tracking-[0.1em] text-stone-400";

export function RecordCollation({
  fields,
  leftCode,
  rightCode,
}: {
  fields: CollationField[];
  leftCode: string;
  rightCode: string;
}) {
  const { t } = useTranslation("decisions");

  return (
    <div className="mt-5 border-t border-stone-200">
      <div className={`${ROW_CLASSES} py-[9px]`}>
        <span className={KEY_CLASSES}>{t("collationFieldLabel")}</span>
        <span className="font-mono text-13 font-medium text-indigo">
          {leftCode}
        </span>
        <span className="font-mono text-13 font-medium text-indigo">
          {rightCode}
        </span>
      </div>
      {fields.map((field, i) => {
        const same =
          field.same !== undefined
            ? field.same
            : typeof field.a === "string" &&
              typeof field.b === "string" &&
              field.a === field.b;
        const valueClass = `text-sm leading-normal [text-wrap:pretty] ${
          same ? "text-stone-500" : "text-indigo"
        }`;
        return (
          <div key={i} className={`${ROW_CLASSES} py-[11px]`}>
            <span className={KEY_CLASSES}>{field.label}</span>
            <span className={valueClass}>{field.a}</span>
            <span className={valueClass}>{field.b}</span>
          </div>
        );
      })}
    </div>
  );
}
