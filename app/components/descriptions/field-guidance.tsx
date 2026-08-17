/**
 * Field guidance — the standard's own words, beside the field
 *
 * A cataloguer looking at "Extent" should be able to find out what the
 * standard means by it without leaving the form. This renders that: a
 * small info affordance next to a field label which, on hover or
 * focus, shows the descriptive standard's own statement of the
 * element's purpose, quoted, with the element number cited beneath it.
 *
 * ## Quoted, not paraphrased — and never re-attributed
 *
 * The text is verbatim from the standard, which is why it is always
 * rendered inside quotation marks and always over a citation. It reads
 * like specification prose ("To name the unit of description") because
 * it IS specification prose; the quotation marks are what make that
 * register legible as a quotation rather than as our own clumsy help
 * text.
 *
 * The text is looked up at `guidance.<standard>.<column>` with NO
 * cross-standard fallback, and nothing renders when the lookup misses.
 * A DACS tenant must never be shown ISAD(G)'s wording under a DACS
 * citation: silence is correct, a false attribution is not. The
 * citation itself comes from `FieldConfig.guidance`, so the words and
 * the reference to them are sourced from the same declaration.
 *
 * ## Quotation marks follow the language, not the browser
 *
 * English takes curly doubles, Spanish takes angle quotes. The `<q>`
 * element would delegate that to the browser's idea of the document
 * language, which yields curly doubles for Spanish in every engine we
 * care about — wrong for the house Spanish style. So the marks are
 * chosen here, from the active language, and are not baked into the
 * locale strings (which stay clean for reuse in exports and elsewhere).
 *
 * Hover and keyboard focus both reveal it, via `group-hover` and
 * `group-focus-within`; the trigger is a real button so it is
 * reachable by tab, and `aria-describedby` ties it to the text for
 * screen readers.
 *
 * @version v0.7.0
 */

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { getStandardConfig } from "~/lib/standards/registry";
import type { Standard } from "~/lib/standards/types";

/** Language-appropriate quotation marks (see the module header). */
function quote(text: string, language: string): string {
  return language.startsWith("es") ? `«${text}»` : `“${text}”`;
}

export function FieldGuidance({
  column,
  standard,
  element,
}: {
  column: string;
  standard: Standard;
  /** The element number from `FieldConfig.guidance`, e.g. "3.1.1". */
  element: string;
}) {
  const { t, i18n } = useTranslation("descriptions_admin");
  const id = useId();

  // Keyed `<column>.<standard>`, the house override convention the
  // section and field labels already use ("context.dacs", "title.rad").
  // i18next resolves a literal dotted key before it drills, so the
  // whole string is one key rather than two levels of nesting.
  //
  // No fallback and no default: a missing entry means this standard has
  // nothing sourced for this column, and the field simply carries no
  // guidance.
  const text = t(`guidance.${column}.${standard}`, { defaultValue: "" });
  if (!text) return null;

  // A worked example, where the standard publishes one short enough to
  // be useful at a glance. Optional: some elements' examples run to a
  // paragraph (scope and content) and belong nowhere near a tooltip.
  // Each language takes its examples from its own edition, so the
  // Spanish shows Spanish-institution examples rather than a
  // translation of an English one.
  const example = t(`guidance_example.${column}.${standard}`, {
    defaultValue: "",
  });

  // The standard's name comes from its own config, never a literal
  // here: no file on the description surface may name a standard
  // (tests/standards/no-hardcoded-standards.test.ts), and the config is
  // where that literal legitimately lives.
  const config = getStandardConfig(standard);

  // Quotation marks are a claim, so they follow the config's own
  // declaration of whether the text is the standard's words or ours.
  // A summary renders unquoted, and its citation says the text is
  // BASED ON the element rather than taken from it.
  const verbatim = config.guidanceVerbatim;
  const cite = t(verbatim ? "guidance_source" : "guidance_source_summary", {
    standard: config.displayName,
    element,
  });

  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <button
        type="button"
        aria-describedby={id}
        aria-label={cite}
        className="inline-flex text-stone-400 hover:text-indigo focus:text-indigo focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo rounded-sm"
      >
        <Info className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute left-0 top-full z-20 mt-1 w-64 rounded-md bg-indigo px-3 py-2 text-xs font-normal leading-snug text-parchment opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {verbatim ? quote(text, i18n.language) : text}
        {example && (
          <span className="mt-1.5 block text-parchment/85">
            {t("guidance_example_label")}{" "}
            <span className="font-mono">{example}</span>
          </span>
        )}
        <span className="mt-1 block text-[0.65rem] uppercase tracking-wide text-parchment/70">
          {cite}
        </span>
      </span>
    </span>
  );
}

/* @version v0.7.0 */
