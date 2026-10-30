/**
 * Capture QC Viewer — The Rail
 *
 * This component is the capture QC viewer's right-hand rail. From the
 * top: the volume (its reference code, how many images and openings it
 * has, and its reviewer); the volume's progress as one bar of approved,
 * rejected and undecided openings with their counts; the current
 * opening, with its decision (for a rejection, the reason and, on an
 * opening with two images, the side to retake) and who made it, its
 * page keys, its status on the scanner and the rotation of each image,
 * marked "not saved yet" while a rotation on an undecided opening waits
 * for its decision; Clear decision, for a decision the unit has not yet
 * fetched (`sentAt` null), which returns the opening to undecided and
 * keeps its rotations as held ones; the reject form, when it is open;
 * the opening's history, from its handover to its decision, or to
 * "Decision cleared." once the reviewer cleared it; the keyboard
 * shortcuts; and, at
 * the foot, the sentence that says why a volume waits. When the
 * handover has a record `rejected`, a retake the unit owes, and nothing
 * is left to approve (`awaitingRetakes` in `status.ts`, from the counts
 * as the reviewer has left them), the foot
 * leads with the Retakes requested badge, the state the Volumes screen
 * and the unit show for the volume, so an all-approved bar never reads
 * as ready for processing. Processing is
 * started elsewhere: the rail has no button for it.
 *
 * When another reviewer changed an opening under the reviewer's own
 * unsaved work, the rail says so for each such opening; the other
 * reviewer's decision is the one shown.
 *
 * A refusal of the decisions route that leaves the page usable (413 or
 * 422, or any other refusal of the request) is said here, in an alert,
 * since it concerns the openings just decided.
 *
 * A polite live region announces the current opening and its decision
 * ("Opening n of N, Approved") as the reviewer moves or decides. The
 * rail folds to a narrow strip with its Hide panel button; the live
 * region stays.
 *
 * @version v0.8.0
 */

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Eraser, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useFormatters } from "../../../lib/use-formatters";
import type { CaptureQcReason, CaptureQcSide } from "../../../lib/validation/enums";
import {
  heldRotation,
  imageKey,
  isPair,
  rotationWord,
  type OpeningState,
  type ViewerOpening,
} from "../../../lib/capture/viewer";
import type { QueueRefusal } from "../../../lib/capture/use-decision-queue";
import { BADGE_SHAPE } from "../../workflow/status-badge";
import { CaptureStateBadge, DecisionBar } from "../capture-parts";
import { decisionKey } from "./opening-row";
import { RejectForm } from "./reject-form";

export interface CaptureQcRailProps {
  referenceCode: string;
  reviewerName: string | null;
  imageCount: number;
  openingCount: number;
  counts: { approved: number; rejected: number; undecided: number };
  /** The volume waits only for retakes the unit owes (`awaitingRetakes`). */
  awaitingRetakes?: boolean;
  opening: ViewerOpening | null;
  state: OpeningState | null;
  handover: number;
  receivedAt: number;
  canDecide: boolean;
  rejectOpen: boolean;
  /** Clears the opening's decision; without it the control is not offered. */
  onClear?: () => void;
  /** The reviewer cleared the opening's decision, and it is still undecided. */
  cleared?: boolean;
  onReject: (reason: CaptureQcReason, note: string | null, side: CaptureQcSide | null) => void;
  onCancelReject: () => void;
  refusal: QueueRefusal | null;
  /** Sequences of openings another reviewer changed under the reviewer's own work. */
  changedByOther?: number[];
  announcement: string;
  collapsed: boolean;
  onToggle: () => void;
}

/** The message for a refusal the rail shows; null for one a banner shows. */
export function refusalMessageKey(refusal: QueueRefusal | null): string | null {
  switch (refusal?.kind) {
    case "too_large":
      return "viewer.error_too_large";
    case "unknown":
      return "viewer.error_unknown";
    case "refused":
    case "revision_changed":
    case "decision_sent":
      return "viewer.error_refused";
    default:
      return null;
  }
}

export function CaptureQcRail(props: CaptureQcRailProps) {
  const { t } = useTranslation("capture");
  const { formatDate } = useFormatters();
  const { opening, state, collapsed } = props;
  const errorKey = refusalMessageKey(props.refusal);

  const live = (
    <p role="status" aria-live="polite" className="sr-only">
      {props.announcement}
    </p>
  );

  if (collapsed) {
    return (
      <aside aria-label={t("queue.title")} className="flex w-11 shrink-0 flex-col items-center border-l border-stone-200 bg-white py-2">
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={false}
          aria-label={t("viewer.rail.show")}
          className="flex h-9 w-9 items-center justify-center rounded-md text-stone-500 hover:bg-stone-50 hover:text-indigo"
        >
          <PanelRightOpen className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
        </button>
        {live}
      </aside>
    );
  }

  const decision = state?.decision ?? null;
  const n = opening?.sequence ?? 0;
  const decisionTone =
    decision?.decision === "approved"
      ? "text-verdigris-deep"
      : decision?.decision === "rejected"
        ? "text-madder-deep"
        : "text-stone-600";
  const lineTone =
    decision?.decision === "approved" ? "bg-verdigris" : decision?.decision === "rejected" ? "bg-madder" : "bg-stone-400";

  return (
    <aside
      aria-label={t("queue.title")}
      className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-stone-200 bg-white font-sans"
    >
      <div className="flex items-start justify-between gap-2 border-b border-stone-200 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-indigo">{t("queue.title")}</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            <span className="font-mono">{props.referenceCode}</span>
            {" · "}
            {t("viewer.rail.images", { count: props.imageCount })}
            {" · "}
            {t("viewer.rail.openings", { count: props.openingCount })}
            {props.reviewerName ? (
              <>
                {" · "}
                {props.reviewerName}
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={true}
          aria-label={t("viewer.rail.hide")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-stone-50 hover:text-indigo"
        >
          <PanelRightClose className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section>
          <Eyebrow>{t("viewer.rail.volume")}</Eyebrow>
          <div className="mt-2">
            <DecisionBar
              approved={props.counts.approved}
              rejected={props.counts.rejected}
              total={props.counts.approved + props.counts.rejected + props.counts.undecided}
            />
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
            <Legend line="h-0.5 bg-verdigris" label={t("queue.legend_approved")} count={props.counts.approved} />
            <Legend line="h-0.5 bg-madder" label={t("queue.legend_rejected")} count={props.counts.rejected} />
            <Legend line="h-px bg-stone-400" label={t("queue.legend_undecided")} count={props.counts.undecided} />
          </ul>
        </section>

        {(props.changedByOther ?? []).map((n) => (
          <p key={n} role="status" className="rounded-md bg-saffron-tint px-3 py-2 text-xs text-saffron-deep">
            {t("viewer.changed_by_other", { n })}
          </p>
        ))}

        {opening && state ? (
          <section className="border-t border-stone-200 pt-4">
            <Eyebrow>{t("viewer.position", { n, total: props.openingCount })}</Eyebrow>
            <p className="mt-2 flex items-center gap-2">
              <span className={`inline-block h-0.5 w-6 rounded-full ${lineTone}`} aria-hidden="true" />
              <span className={`text-[13px] font-semibold ${decisionTone}`}>{t(decisionKey(decision))}</span>
            </p>
            {decision ? (
              <p className="mt-1 text-xs text-stone-600">
                {decision.decision === "rejected" && decision.reason ? (
                  <b className="font-semibold text-madder-deep">{t(`reason.${decision.reason}`)}</b>
                ) : null}
                {decision.decision === "rejected" && decision.side ? (
                  <>
                    {decision.reason ? " · " : null}
                    <b className="font-semibold text-madder-deep">{t(`side.${decision.side}`)}</b>
                  </>
                ) : null}
                {decision.decision === "rejected" && (decision.reason || decision.side) && decision.decidedBy ? " · " : null}
                {decision.decidedBy && decision.decidedAt !== null
                  ? t("viewer.rail.by", { name: decision.decidedBy, date: formatDate(decision.decidedAt) })
                  : null}
              </p>
            ) : null}
            {decision?.note ? <p className="mt-1 font-serif text-sm text-stone-700">{decision.note}</p> : null}
            {props.canDecide && decision !== null && (decision.sentAt ?? null) === null && props.onClear ? (
              <button
                type="button"
                onClick={props.onClear}
                className="mt-2 inline-flex h-7 items-center gap-1.5 rounded border border-stone-200 bg-white px-2 text-xs font-semibold text-indigo hover:bg-stone-50"
              >
                <Eraser size={14} aria-hidden="true" />
                {t("viewer.clear_decision")}
              </button>
            ) : null}

            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-stone-500">{t("columns.page_keys")}</dt>
              <dd className="font-mono text-[11px] text-indigo-soft">
                {opening.images.map((i) => (
                  <span key={imageKey(i)} className="block break-all">
                    {i.pageKey}
                  </span>
                ))}
              </dd>
              <dt className="text-stone-500">{t("viewer.rail.on_scanner")}</dt>
              <dd className="text-stone-700">
                {opening.scannerStatus === "approved" ? t("viewer.rail.scanner_approved") : t("viewer.rail.scanner_in_review")}
              </dd>
              <dt className="text-stone-500">{t("viewer.rail.rotation")}</dt>
              <dd className="text-stone-700">
                {opening.images
                  .map((i) =>
                    t("viewer.rotation.item", {
                      side: t(`viewer.rotation.${i.role}`),
                      turn: t(`viewer.rotation.${rotationWord(state.turns[imageKey(i)] ?? 0)}`),
                    }),
                  )
                  .join(" · ")}
                {heldRotation(state) ? (
                  <span className="mt-0.5 block text-saffron-deep">{t("viewer.rail.rotation_held")}</span>
                ) : null}
              </dd>
            </dl>

            {props.rejectOpen && props.canDecide ? (
              <div className="mt-4 border-t border-stone-200 pt-4">
                <RejectForm
                  key={opening.captuaRecordId}
                  n={n}
                  pair={isPair(opening)}
                  initialSide={decision?.decision === "rejected" ? decision.side : null}
                  initialReason={decision?.decision === "rejected" ? decision.reason : null}
                  initialNote={decision?.decision === "rejected" ? decision.note : null}
                  onSubmit={props.onReject}
                  onCancel={props.onCancelReject}
                />
              </div>
            ) : null}

            {errorKey ? (
              <p role="alert" className="mt-3 rounded-md bg-madder-tint px-3 py-2 text-xs text-madder-deep">
                {t(errorKey)}
              </p>
            ) : null}

            <div className="mt-4">
              <Eyebrow>{t("viewer.history.label")}</Eyebrow>
              <ol className="mt-2 space-y-2 text-xs">
                <li>
                  <HistoryHead name="Fisqua" tag={t("viewer.history.system")} date={formatDate(props.receivedAt)} />
                  <p className="font-serif text-sm text-stone-700">{t("viewer.history.received", { n: props.handover })}</p>
                </li>
                {decision ? (
                  <li>
                    <HistoryHead
                      name={decision.decidedBy}
                      tag={t("viewer.history.reviewer")}
                      date={decision.decidedAt !== null ? formatDate(decision.decidedAt) : null}
                    />
                    <p className="font-serif text-sm text-stone-700">
                      {decision.decision === "approved"
                        ? t("viewer.history.approved")
                        : decision.side
                          ? t("viewer.history.rejected_side", {
                              reason: decision.reason ? t(`reason.${decision.reason}`) : "",
                              side: t(`side.${decision.side}`),
                            })
                          : t("viewer.history.rejected", { reason: decision.reason ? t(`reason.${decision.reason}`) : "" })}
                      {decision.note ? ` ${decision.note}` : null}
                    </p>
                  </li>
                ) : props.cleared ? (
                  <li>
                    <HistoryHead name={null} tag={t("viewer.history.reviewer")} date={null} />
                    <p className="font-serif text-sm text-stone-700">{t("viewer.history.cleared")}</p>
                  </li>
                ) : null}
              </ol>
            </div>
          </section>
        ) : null}

        <section className="border-t border-stone-200 pt-4">
          <h3 className="sr-only">{t("viewer.keys.label")}</h3>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-11 text-stone-600">
            <KeyHint keys={["A"]} label={t("viewer.keys.approve")} />
            <KeyHint keys={["R"]} label={t("viewer.keys.reject")} />
            <KeyHint keys={["[", "]"]} label={t("viewer.keys.rotate")} />
            <KeyHint keys={["J", "K"]} label={t("viewer.keys.next_previous")} />
            <KeyHint keys={["G"]} label={t("viewer.keys.sheet")} />
            <KeyHint keys={["Ctrl", "Z"]} label={t("viewer.keys.undo")} />
          </ul>
        </section>
      </div>

      <p className="border-t border-stone-200 px-4 py-3 text-xs text-stone-500">
        {props.awaitingRetakes ? (
          <>
            <CaptureStateBadge state="retakes_requested" />{" "}
          </>
        ) : null}
        {t("viewer.rail.hold")}
      </p>
      {live}
    </aside>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <h3 className="text-11 font-semibold uppercase tracking-[0.1em] text-stone-500">{children}</h3>;
}

function Legend({ line, label, count }: { line: string; label: string; count: number }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={`inline-block w-3 rounded-full ${line}`} aria-hidden="true" />
      {label} <span className="tabular-nums">{count}</span>
    </li>
  );
}

function HistoryHead({ name, tag, date }: { name: string | null; tag: string; date: string | null }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5">
      {name ? <span className="font-semibold text-indigo">{name}</span> : null}
      <span className={`${BADGE_SHAPE} bg-indigo-tint text-indigo`}>{tag}</span>
      {date ? <span className="font-mono text-[11px] text-stone-400">{date}</span> : null}
    </p>
  );
}

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="rounded border border-stone-200 px-1 font-mono text-[10px] text-stone-600">
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </li>
  );
}

// @version v0.8.0
