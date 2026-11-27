/**
 * PairMergeDialog — the confirmation for merging two duplicate authority records
 *
 * Merge earns its own confirm, distinct from `DismissDialog`: it destroys
 * a record, ruling is one-way, and — unlike a dismissal — the surviving
 * code must be chosen here, because it is the consequential part of the
 * decision and there is nowhere else to choose it. That is why madder,
 * reserved elsewhere for the dismiss confirm alone, also appears on this
 * dialog's confirm button.
 *
 * The direction control is the point of the dialog: each option row
 * reads `Survives` or `Retired`, and the label flips with the selection
 * so the admin reads the outcome for both records before committing
 * rather than inferring it from a bare radio. Preselection is the
 * caller's call, not this component's: pass the code carrying the
 * descriptions when the load is uneven, `null` when it is even — an
 * even load leaves the confirm disabled until the admin picks a side.
 *
 * Named `PairMergeDialog` because `merge-dialog.tsx` already exists for
 * vocabulary-term merges; this is the duplicates-vocabulary design
 * round's own dialog, not a change to that one. It does, however, serve
 * the vocabulary CARD's merge as well — same direction control, term
 * options instead of record options — which is why each option carries
 * its load line pre-composed (descriptions for records, entities for
 * terms) and the consequence body can be overridden with term copy.
 *
 * A merge of two entity records passes `evidence`, the two records'
 * linked descriptions: the dialog then shows `MergeEvidencePanel` in
 * place of the reason field, its note taking the reason's place, and
 * keeps the confirm disabled until a fact and a description for each
 * record are chosen (`evidenceReady`). `onConfirm` receives the evidence
 * as its third argument. A place merge or a vocabulary merge passes no
 * `evidence`, and the dialog is as it was. Each side's heading in the
 * panel is marked as surviving or retired as the direction control
 * chooses, matched by the side's `code` to the option's. `evidence.loading` says the
 * descriptions are still on their way; the panel says so in their place.
 *
 * @version v0.9.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MergeEvidencePanel,
  evidenceReady,
  usePrunedEvidence,
  type EvidenceShape,
  type EvidenceSide,
  type EvidenceValue,
} from "./merge-evidence-panel";

export interface PairMergeOption {
  /** Authority code for records; the term's own form for vocabulary. */
  code: string;
  /** Pre-composed load line ("16 descriptions name this form"). */
  loadLine: string;
}

export function PairMergeDialog({
  title,
  body,
  options,
  defaultSurvivorCode,
  reasonPlaceholder,
  pending = false,
  evidence,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** Consequence copy; defaults to the record-merge sentence. */
  body?: string;
  options: [PairMergeOption, PairMergeOption];
  defaultSurvivorCode: string | null;
  reasonPlaceholder: string;
  pending?: boolean;
  /** An entity merge: the two records and their linked descriptions, for the evidence panel. */
  evidence?: { sides: [EvidenceSide, EvidenceSide]; shape?: EvidenceShape; loading?: boolean };
  onCancel: () => void;
  onConfirm: (survivorCode: string, reason: string, evidence?: EvidenceValue) => void;
}) {
  const { t } = useTranslation("decisions");
  const [survivor, setSurvivor] = useState(defaultSurvivorCode);
  const [reason, setReason] = useState("");
  // Kept to the descriptions offered now, as the page reloads its data.
  const [cited, setCited] = usePrunedEvidence(evidence?.sides);
  const ready = !evidence || evidenceReady(cited, evidence.sides);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.42)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pair-merge-dialog-title"
    >
      <div
        className={`w-full rounded-lg border border-stone-200 bg-white p-6 shadow-lg ${
          evidence ? "max-h-[calc(100vh-2rem)] max-w-[40rem] overflow-y-auto" : "max-w-[30rem]"
        }`}
      >
        <p
          id="pair-merge-dialog-title"
          className="font-serif text-xl font-semibold leading-snug tracking-[-0.005em] text-indigo"
        >
          {title}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
          {body ?? t("mergeModalBody")}
        </p>

        <span className="mb-1.5 mt-5 block text-sm font-medium text-stone-700">
          {t("mergeDirectionLabel")}
        </span>
        <div className="flex flex-col gap-2">
          {options.map((option, i) => {
            const selected = survivor === option.code;
            return (
              <label
                key={`${option.code}-${i}`}
                className={`flex cursor-pointer items-center gap-[11px] rounded-lg border px-[13px] py-[11px] transition-colors ${
                  selected
                    ? "border-verdigris bg-verdigris-wash"
                    : "border-stone-300 bg-white hover:border-stone-400"
                }`}
              >
                <input
                  type="radio"
                  name="pair-merge-survivor"
                  checked={selected}
                  onChange={() => setSurvivor(option.code)}
                  className={`size-4 flex-none appearance-none rounded-full bg-white ${
                    selected
                      ? "border-[5px] border-verdigris"
                      : "border border-stone-400"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <p className="font-mono text-13 font-medium text-indigo">
                    {option.code}
                  </p>
                  <p className="mt-[3px] text-xs leading-normal text-stone-500">
                    {option.loadLine}
                  </p>
                </span>
                <span
                  className={`flex-none text-11 font-semibold uppercase tracking-[0.06em] ${
                    selected ? "text-verdigris-deep" : "text-stone-400"
                  }`}
                >
                  {selected ? t("mergeSurvives") : t("mergeRetired")}
                </span>
              </label>
            );
          })}
        </div>

        {evidence ? (
          <div className="mt-5 border-t border-stone-200 pt-4">
            <MergeEvidencePanel
              sides={evidence.sides.map((side) => ({
                ...side,
                // The side the direction control has chosen survives, the other is retired.
                role: survivor === null || !side.code ? null : side.code === survivor ? "survivor" : "retired",
              }))}
              shape={evidence.shape}
              loading={evidence.loading}
              value={cited}
              onChange={setCited}
              note={{ value: reason, onChange: setReason, placeholder: reasonPlaceholder }}
            />
          </div>
        ) : (
          <>
            <label
              htmlFor="pair-merge-dialog-reason"
              className="mt-5 block text-sm font-medium text-stone-700"
            >
              {t("rejectReasonLabel")}
            </label>
            <textarea
              id="pair-merge-dialog-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1.5 h-[76px] w-full resize-none rounded-lg border border-stone-300 px-3 py-2.5 text-sm leading-normal text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris"
              placeholder={reasonPlaceholder}
            />
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={!survivor || !ready || pending}
            onClick={() => survivor && ready && onConfirm(survivor, reason, evidence ? cited : undefined)}
            className="inline-flex h-11 items-center rounded-lg bg-madder px-4.5 text-15 font-semibold text-white hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-30"
          >
            {t("mergeConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
