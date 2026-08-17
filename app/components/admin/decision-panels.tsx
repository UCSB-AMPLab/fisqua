/**
 * Decision surface furniture: the ask panel and the section label row.
 *
 * The ask panel is the card's second channel — the object carries size
 * (24px Spectral), the ask carries material (a tinted slot). Its
 * judgement state is the same slot outlined in saffron on white: a
 * blank awaiting an answer, deliberately not a warning — no filled
 * amber, no alert iconography. Saffron is the system's
 * "partial / needs input" hue; madder is danger and appears only in
 * the dismiss confirmation.
 *
 * The judgement state now also serves the duplicate pair card's open
 * question, whose eyebrow reads "The question" rather than "Suggested
 * action" — the scan asks there, it never recommends. `eyebrow` lets a
 * caller override the default copy for that reading; when omitted the
 * panel keeps the original "Suggested action" eyebrow, so every
 * existing call site is unaffected.
 *
 * @version v0.7.0
 */

import { useTranslation } from "react-i18next";

export function AskPanel({
  value,
  judgement,
  eyebrow,
  className = "mt-4",
}: {
  value: string;
  judgement: boolean;
  eyebrow?: string;
  className?: string;
}) {
  const { t } = useTranslation("decisions");
  return (
    <div
      className={`${className} rounded-md border px-3.5 py-2.5 ${
        judgement
          ? "border-saffron bg-white"
          : "border-verdigris-tint bg-verdigris-wash"
      }`}
    >
      <span
        className={`block text-11 font-semibold uppercase tracking-[0.1em] ${
          judgement ? "text-saffron-deep" : "text-verdigris-deep"
        }`}
      >
        {eyebrow ?? t("suggestedActionEyebrow")}
      </span>
      <p
        className={`mt-1 text-[1.0625rem] leading-snug ${
          judgement ? "font-medium text-saffron-deep" : "font-semibold text-indigo"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/** An uppercase eyebrow followed by a hairline: "Comments ————". */
export function SectionLabelRow({ label }: { label: string }) {
  return (
    <div className="mt-5 flex items-center gap-2.5">
      <span className="text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
        {label}
      </span>
      <span className="h-px flex-1 bg-stone-200" />
    </div>
  );
}
