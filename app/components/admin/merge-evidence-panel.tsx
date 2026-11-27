/**
 * MergeEvidencePanel — the evidence a steward gives for merging two entity records
 *
 * This component asks a steward for the evidence that two entity records
 * (persons, organizations, families) are one, before their merge can be
 * confirmed. A shared name is never that evidence. The panel asks two
 * things: which independent fact shows they are the same (the five of
 * `MERGE_FACTS`, at least one ticked), and which descriptions show it (at
 * least one for each record, chosen from that record's linked
 * descriptions). The line "a name alone is not enough" sits under the
 * facts. The panel shows the evidence; the server checks it again on every
 * merge path.
 *
 * The panel is controlled: the caller holds the `value` (the facts
 * ticked and, per entity id, the description ids chosen) and passes
 * `onChange`. `usePrunedEvidence` holds such a value for a caller and
 * keeps it to the descriptions the sides offer (`pruneEvidence`), so a
 * citation of a description that lost its link between two loads is
 * dropped, not posted again. `evidenceReady` says whether the value is complete for the
 * sides shown, which is what the caller's Merge button waits on. The
 * panel renders the hidden `evidence_fact` and `evidence_description`
 * (`<entityId>:<descriptionId>`) inputs a form posts, and
 * `evidenceFormEntries` gives the same fields for a caller that submits
 * a `FormData` it builds itself (the pair-merge dialog).
 *
 * `shape` words the facts heading by what the records are (the same
 * person, family, corporate body, or record when their types differ),
 * as the pair page words its question; `evidenceErrorKey` words the
 * refusal for a missing fact the same way.
 *
 * `loading` shows a line in place of the description lists while the
 * caller fetches them (the duplicates card's dialog, which loads them
 * only when it opens).
 *
 * Each side's heading gives the record's name, its code in the code font
 * (two records of one name are the usual case), and which side of the
 * merge it is on when the caller knows it. A description row gives its
 * code and date, wrapping, and its title on the line under them, cut
 * with an ellipsis (the full title in its `title`), so nothing runs past
 * the dialog's width.
 *
 * `note`, when given, renders the steward's optional note under the
 * evidence; the merge workbench keeps its note in its action bar and
 * passes none. A side with no descriptions says so: there is nothing to
 * cite, and the merge cannot be made.
 *
 * The workbench's link cards are selectable for moving; this panel's
 * description choices are a separate list, so choosing a description as
 * evidence never moves or keeps a link.
 *
 * @version v0.9.0
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MERGE_FACTS, type EvidenceError, type MergeFact } from "~/lib/merge-facts";

/**
 * What the two records are, for the wording of the facts heading and of
 * the no-fact refusal, as the pair page words its question: the type
 * both records share, or `generic` when they differ.
 */
export type EvidenceShape = "person" | "family" | "corporate" | "generic";

/** The shape of a pair of entity types. */
export function evidenceShape(a: string | null | undefined, b: string | null | undefined): EvidenceShape {
  return a && a === b && (a === "person" || a === "family" || a === "corporate") ? a : "generic";
}

/** The `authorities` key of an evidence refusal; the no-fact refusal is worded by shape. */
export function evidenceErrorKey(code: EvidenceError, shape: EvidenceShape = "generic"): string {
  return code === "evidence_facts" ? `merge_evidence.error.evidence_facts.${shape}` : `merge_evidence.error.${code}`;
}

export interface EvidenceSide {
  entityId: string;
  /** The record's name, heading its list. */
  name: string;
  /** The record's code, after its name: two records of one name are told apart by it. */
  code?: string;
  /** Which side of the merge the record is on, when the caller knows it. */
  role?: "survivor" | "retired" | null;
  descriptions: Array<{ id: string; code: string; date: string | null; title: string }>;
}

export interface EvidenceValue {
  facts: MergeFact[];
  /** Description ids chosen, per entity id. */
  cited: Record<string, string[]>;
}

export const EMPTY_EVIDENCE: EvidenceValue = { facts: [], cited: {} };

/** Whether the value holds a fact and a description for every side. */
export function evidenceReady(value: EvidenceValue, sides: readonly EvidenceSide[]): boolean {
  return value.facts.length > 0 && sides.every((s) => (value.cited[s.entityId] ?? []).length > 0);
}

/**
 * The value with only the citations the sides offer now. After the page
 * reloads its data (a refusal, a revalidation), a description that lost
 * its link is no longer offered; a citation of it kept in the value would
 * have no checkbox to clear it and would fail every later submit.
 */
export function pruneEvidence(value: EvidenceValue, sides: readonly EvidenceSide[]): EvidenceValue {
  const cited: Record<string, string[]> = {};
  let changed = Object.keys(value.cited).some((id) => !sides.some((s) => s.entityId === id));
  for (const side of sides) {
    const offered = new Set(side.descriptions.map((d) => d.id));
    const held = value.cited[side.entityId] ?? [];
    const kept = held.filter((id) => offered.has(id));
    if (kept.length !== held.length) changed = true;
    if (held.length > 0) cited[side.entityId] = kept;
  }
  return changed ? { ...value, cited } : value;
}

/** The form fields the server reads (`evidenceFromForm`). */
export function evidenceFormEntries(value: EvidenceValue): Array<[string, string]> {
  return [
    ...MERGE_FACTS.filter((f) => value.facts.includes(f)).map((f): [string, string] => ["evidence_fact", f]),
    ...Object.entries(value.cited).flatMap(([entityId, ids]) =>
      ids.map((id): [string, string] => ["evidence_description", `${entityId}:${id}`]),
    ),
  ];
}

/**
 * The evidence state of a caller, kept to the descriptions `sides`
 * offers. The value returned is pruned on every render, so the Merge
 * button and the posted fields never count a citation the sides no
 * longer offer; the state itself is pruned when the sides change.
 */
export function usePrunedEvidence(sides: readonly EvidenceSide[] | null | undefined): [EvidenceValue, (next: EvidenceValue) => void] {
  const [value, setValue] = useState<EvidenceValue>(EMPTY_EVIDENCE);
  useEffect(() => {
    if (sides) setValue((prev) => pruneEvidence(prev, sides));
  }, [sides]);
  return [sides ? pruneEvidence(value, sides) : value, setValue];
}

/** The hidden inputs for `value`, for a `<Form>` that posts the evidence. */
export function EvidenceHiddenInputs({ value }: { value: EvidenceValue }) {
  return (
    <>
      {evidenceFormEntries(value).map(([name, v]) => (
        <input key={`${name}-${v}`} type="hidden" name={name} value={v} />
      ))}
    </>
  );
}

export function MergeEvidencePanel({
  sides,
  value,
  onChange,
  note,
  shape = "generic",
  loading = false,
}: {
  sides: readonly EvidenceSide[];
  /** What the records are, for the facts heading's wording. */
  shape?: EvidenceShape;
  /** The descriptions are still loading: a line says so in place of each list. */
  loading?: boolean;
  value: EvidenceValue;
  onChange: (next: EvidenceValue) => void;
  note?: { value: string; onChange: (next: string) => void; placeholder?: string };
}) {
  const { t } = useTranslation("authorities");
  const { t: td } = useTranslation("decisions");

  const toggleFact = (fact: MergeFact) => {
    const facts = value.facts.includes(fact) ? value.facts.filter((f) => f !== fact) : [...value.facts, fact];
    onChange({ ...value, facts: MERGE_FACTS.filter((f) => facts.includes(f)) });
  };
  const toggleDescription = (entityId: string, id: string) => {
    const held = value.cited[entityId] ?? [];
    const next = held.includes(id) ? held.filter((d) => d !== id) : [...held, id];
    onChange({ ...value, cited: { ...value.cited, [entityId]: next } });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="merge-evidence-panel">
      <fieldset className="min-w-0">
        <legend className="flex w-full items-baseline justify-between gap-3 text-sm font-medium text-stone-700">
          <span>{t(`merge_evidence.facts_heading.${shape}`)}</span>
          <span className="text-xs font-normal text-stone-500">{t("merge_evidence.facts_hint")}</span>
        </legend>
        <div className="mt-1.5 flex flex-col gap-1">
          {MERGE_FACTS.map((fact) => (
            <label key={fact} className="flex cursor-pointer items-baseline gap-2.5 rounded-md px-1.5 py-1 hover:bg-stone-50">
              <input
                type="checkbox"
                name="evidence-fact-choice"
                value={fact}
                checked={value.facts.includes(fact)}
                onChange={() => toggleFact(fact)}
                className="size-4 flex-none translate-y-[2px] accent-verdigris"
              />
              <span className="w-20 flex-none text-sm font-semibold text-indigo">{t(`merge_evidence.fact.${fact}`)}</span>
              <span className="text-13 text-stone-500">{t(`merge_evidence.fact_help.${fact}`)}</span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 border-t border-stone-200 pt-1.5 text-xs font-semibold text-madder-deep">
          {t("merge_evidence.name_alone")}
        </p>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className="flex w-full items-baseline justify-between gap-3 text-sm font-medium text-stone-700">
          <span>{t("merge_evidence.descriptions_heading")}</span>
          <span className="text-xs font-normal text-stone-500">{t("merge_evidence.descriptions_hint")}</span>
        </legend>
        <div className="mt-1.5 flex flex-col gap-3">
          {sides.map((side) => (
            <div key={side.entityId} className="min-w-0">
              <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-serif text-15 text-indigo">
                <span className="min-w-0 break-words">{side.name}</span>
                {side.code ? (
                  <span className="font-mono text-11 font-medium tracking-[0.04em] text-stone-500">· {side.code}</span>
                ) : null}
                {side.role ? (
                  <span
                    className={`font-sans text-11 font-semibold uppercase tracking-[0.06em] ${
                      side.role === "survivor" ? "text-verdigris-deep" : "text-stone-400"
                    }`}
                  >
                    {side.role === "survivor" ? td("mergeSurvives") : td("mergeRetired")}
                  </span>
                ) : null}
              </p>
              {loading ? (
                <p className="mt-1 text-xs leading-normal text-stone-500" role="status">{t("merge_evidence.loading")}</p>
              ) : side.descriptions.length === 0 ? (
                <p className="mt-1 text-xs leading-normal text-stone-500">{t("merge_evidence.no_descriptions")}</p>
              ) : (
                <div className="mt-1 flex flex-col gap-0.5">
                  {side.descriptions.map((d) => (
                    <label
                      key={d.id}
                      className="flex min-w-0 cursor-pointer items-baseline gap-2.5 rounded-md px-1.5 py-1 hover:bg-stone-50"
                    >
                      <input
                        type="checkbox"
                        name="evidence-description-choice"
                        value={`${side.entityId}:${d.id}`}
                        checked={(value.cited[side.entityId] ?? []).includes(d.id)}
                        onChange={() => toggleDescription(side.entityId, d.id)}
                        className="size-4 flex-none translate-y-[2px] accent-verdigris"
                      />
                      {/* Code and date on one line, wrapping; the title under them, cut with an ellipsis. */}
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                          <span className="min-w-0 break-all font-mono text-11 text-indigo-soft">{d.code}</span>
                          <span className="text-11 nums text-stone-500">{d.date ?? "—"}</span>
                        </span>
                        <span className="block truncate text-13 text-stone-700" title={d.title}>
                          {d.title}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </fieldset>

      {note && (
        <div>
          <label htmlFor="merge-evidence-note" className="block text-sm font-medium text-stone-700">
            {t("merge_evidence.note_label")}
          </label>
          <textarea
            id="merge-evidence-note"
            value={note.value}
            onChange={(e) => note.onChange(e.target.value)}
            placeholder={note.placeholder}
            className="mt-1.5 h-[64px] w-full resize-none rounded-lg border border-stone-300 px-3 py-2.5 text-sm leading-normal text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris"
          />
        </div>
      )}

      <EvidenceHiddenInputs value={value} />
    </div>
  );
}

/* @version v0.9.0 */
