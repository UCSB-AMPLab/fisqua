/**
 * The export dialog — one dialog, four states, never blocking
 *
 * The confirm bar already carries the summary, so this dialog is not a
 * second chance to read it: it is where a run that takes minutes
 * becomes something you can watch, leave, and come back to. The three
 * axes are restated as a small ledger rather than a sentence, because
 * that is the shape the history row and the ledger entry both take,
 * and the counts sit apart from the axes because they are the
 * consequence, not the choice.
 *
 * FOUR STATES, TWO COMPONENTS. Confirm happens before a run row
 * exists, so it is driven by the page's chosen axes; working, ready
 * and failed are three readings of one row, so they are driven by the
 * row and switch between themselves as it moves. Nothing in the second
 * component knows how the run was started, which is why "Try again"
 * from history can reach the same three states.
 *
 * THE FORMAT DECIDES THE VERB. A PDF run offers "Open finding aid"
 * where every other format offers "Download" — the artifact is a
 * rendered page rather than a file, which is also why history says
 * "Open again" rather than "Download" for those rows.
 *
 * NARROW: the buttons stack with the confirm on top and Cancel nearest
 * the thumb, and the confirm is first in the source so it reads first
 * to a screen reader. That is `flex-col` plus `md:flex-row-reverse`
 * rather than the `column-reverse` the narrow card names — with a
 * confirm-first source, column-reverse would put the committing action
 * nearest the thumb, which is the opposite of the rule the card is
 * stating.
 *
 * @version v0.7.0
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import { useFormatters } from "~/lib/use-formatters";
import type { ExportRunView } from "~/lib/export/run.server";
import type { ExportForm, ExportFormat, ExportRecordClass } from "~/lib/export/matrix";
import {
  ARTIFACT_KEYS,
  FORMAT_KEYS,
  FORMAT_ROW_KEYS,
  FORM_KEYS,
  failureKey,
  useExportLabels,
} from "./export-labels";
import { etaMinutes, useRunPoll } from "./use-run-poll";

/** Mono stamps stay ISO in both languages — they are machine facts. */
function clock(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 16);
}

function DialogShell({
  provenance,
  title,
  titleId,
  children,
  footer,
  onDismiss,
}: {
  provenance: string;
  title: string;
  titleId: string;
  children: ReactNode;
  footer: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.42)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDismiss();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-[32rem] overflow-y-auto rounded-lg border border-stone-200 bg-white p-6 shadow-lg">
        <p className="font-mono text-11 font-medium uppercase tracking-[0.04em] text-stone-400">
          {provenance}
        </p>
        <p
          id={titleId}
          className="mt-1 font-serif text-xl font-semibold leading-snug tracking-[-0.005em] text-indigo"
        >
          {title}
        </p>
        {children}
        <div className="mt-5 flex flex-col gap-2.5 md:flex-row-reverse md:justify-start">
          {footer}
        </div>
      </div>
    </div>
  );
}

/** One row of the ledger: a 78px label and what it names. */
function LedgerRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | null;
}) {
  return (
    <div className="flex gap-3 border-b border-stone-100 py-2 last:border-b-0">
      <span className="w-[78px] flex-none pt-px font-sans text-11 font-semibold uppercase tracking-[0.08em] text-stone-400">
        {label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-13 leading-snug text-stone-700">{value}</span>
        {note && (
          <span className="mt-0.5 block text-11 leading-normal text-stone-500">
            {note}
          </span>
        )}
      </span>
    </div>
  );
}

function ConfirmButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-11 items-center justify-center rounded-lg bg-verdigris px-4.5 text-15 font-semibold text-white hover:bg-verdigris-deep disabled:cursor-not-allowed disabled:opacity-30"
    >
      {label}
    </button>
  );
}

function QuietButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// State 1 — confirm
// ---------------------------------------------------------------------------

export interface ExportConfirmProps {
  recordClass: ExportRecordClass;
  counts: { records: number; entities: number; places: number; links: number };
  includeAuthorities: boolean;
  /** The scope in its own words, as the Scope row states it. */
  scopeSummary: string;
  /** When the scope was fixed — a carried scope's search stamp. */
  scopeNote: string | null;
  form: ExportForm;
  format: ExportFormat;
  ownStandardLabel: string;
  /**
   * Which sub-line the FORM row carries: the workspace's own standard,
   * the canonical round-trip, or a crosswalk (with its loss line).
   * Canonical is lossless but is NOT the workspace's own standard, so
   * it gets its own words rather than borrowing the own-standard line.
   */
  formNoteKind: "own" | "canonical" | "crosswalk";
  /** The compact loss restatement, already composed. Never the first mention. */
  lossLine: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ExportConfirmDialog(props: ExportConfirmProps) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();
  const {
    recordClass,
    counts,
    includeAuthorities,
    scopeSummary,
    scopeNote,
    form,
    format,
    ownStandardLabel,
    formNoteKind,
    lossLine,
  } = props;

  const primaryCount =
    recordClass === "records"
      ? counts.records
      : recordClass === "entities"
        ? counts.entities
        : counts.places;
  const titleKey =
    recordClass === "records"
      ? "confirmTitleRecords"
      : recordClass === "entities"
        ? "confirmTitleEntities"
        : "confirmTitlePlaces";

  const formNote =
    formNoteKind === "own"
      ? t("rowFormOwn")
      : formNoteKind === "canonical"
        ? t("formCanonicalSub")
        : lossLine
          ? `${t("rowFormCrosswalk", { own: ownStandardLabel })} · ${lossLine}`
          : t("rowFormCrosswalk", { own: ownStandardLabel });

  const footerNote =
    recordClass === "records"
      ? includeAuthorities
        ? t("confirmFooterAuthoritiesOn")
        : t("confirmFooterAuthoritiesOff")
      : t("confirmFooterAuthorityScope");

  return (
    <DialogShell
      provenance={t("dialogProvenance", { scope: scopeSummary })}
      title={t(titleKey, {
        count: primaryCount,
        formatted: labels.number(primaryCount),
      })}
      titleId="export-confirm-title"
      onDismiss={props.onCancel}
      footer={
        <>
          <ConfirmButton
            label={t("exportAction")}
            disabled={props.pending}
            onClick={props.onConfirm}
          />
          <QuietButton label={t("cancel")} onClick={props.onCancel} />
        </>
      }
    >
      <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
        {t("confirmBody")}
      </p>

      <div className="mt-4 border-t border-stone-100">
        <LedgerRow label={t("rowScope")} value={scopeSummary} note={scopeNote} />
        <LedgerRow label={t("rowForm")} value={t(FORM_KEYS[form])} note={formNote} />
        <LedgerRow
          label={t("rowFormat")}
          value={t(FORMAT_KEYS[format])}
          note={t(FORMAT_ROW_KEYS[format])}
        />
      </div>

      <p className="mt-3 font-mono text-13 nums leading-relaxed text-indigo">
        {labels.counts(recordClass, counts, { includeAuthorities })}
      </p>
      <p className="mt-2 text-11 leading-normal text-stone-500">{footerNote}</p>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// States 2–4 — the run itself
// ---------------------------------------------------------------------------

export function ExportRunDialog({
  run: initial,
  scopeSummary,
  onClose,
  onCancelRun,
}: {
  run: ExportRunView;
  scopeSummary: string;
  onClose: () => void;
  onCancelRun: (runId: string) => void;
}) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();
  const { formatBytes, formatDuration } = useFormatters();
  const run = useRunPoll(initial);

  const recordClass: ExportRecordClass = run.recordClass ?? "records";
  const total = run.progressTotal ?? 0;
  const items = labels.primary(recordClass, total);
  const artifact = run.format ? t(ARTIFACT_KEYS[run.format]) : "";
  const eta = etaMinutes(run, Date.now());

  const provenance = t("dialogProvenance", { scope: scopeSummary });

  if (run.status === "running") {
    const stageLine =
      run.stage === "authorities"
        ? t("stageAuthorities")
        : run.stage === "serializing"
          ? t("stageSerializing", { artifact })
          : `${t("stageDescriptions")} ${
              run.includeAuthorities
                ? t("stageThenAuthorities", { artifact })
                : t("stageThen", { artifact })
            }`;

    return (
      <DialogShell
        provenance={provenance}
        title={t("workingTitle")}
        titleId="export-run-title"
        onDismiss={onClose}
        footer={
          <>
            <QuietButton label={t("close")} onClick={onClose} />
            <button
              type="button"
              onClick={() => onCancelRun(run.id)}
              className="inline-flex h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-madder-deep hover:border-madder-soft hover:bg-madder-wash"
            >
              {t("cancelRun")}
            </button>
          </>
        }
      >
        <p className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-saffron-tint px-2.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-saffron-deep">
            {t("statusInProgress")}
          </span>
          <span className="font-mono text-13 nums text-stone-600">
            {t("workingProgress", {
              done: labels.number(run.progressDone ?? 0),
              items,
            })}
            {eta !== null && ` · ${t("workingEta", { count: eta })}`}
          </span>
        </p>
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-stone-100"
          role="progressbar"
          aria-valuenow={run.progressDone ?? 0}
          aria-valuemin={0}
          aria-valuemax={total}
        >
          <div
            className="h-full rounded-full bg-saffron"
            style={{
              width: `${total > 0 ? Math.min(100, Math.round(((run.progressDone ?? 0) / total) * 100)) : 4}%`,
            }}
          />
        </div>
        <p className="mt-3 text-sm leading-relaxed text-stone-700">{stageLine}</p>
        <p className="mt-2 text-13 leading-normal text-stone-500">
          {t("workingLeave")}
        </p>
        <p className="mt-3 font-mono text-11 nums text-stone-400">
          {t("workingStarted", { time: clock(run.startedAt) })}
        </p>
      </DialogShell>
    );
  }

  if (run.status === "completed") {
    const isPdf = run.format === "pdf";
    return (
      <DialogShell
        provenance={provenance}
        title={t("readyTitle")}
        titleId="export-run-title"
        onDismiss={onClose}
        footer={
          <>
            {run.r2Key !== null ? (
              <a
                href={
                  isPdf
                    ? `/admin/exports/aid/${run.id}`
                    : `/admin/exports/download/${run.id}`
                }
                target={isPdf ? "_blank" : undefined}
                rel={isPdf ? "noreferrer" : undefined}
                className="inline-flex h-11 items-center justify-center rounded-lg bg-verdigris px-4.5 text-15 font-semibold text-white hover:bg-verdigris-deep"
              >
                {isPdf ? t("openFindingAid") : t("download")}
              </a>
            ) : null}
            <QuietButton label={t("close")} onClick={onClose} />
          </>
        }
      >
        <p className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-verdigris-tint px-2.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-verdigris-deep">
            {t("statusCompleted")}
          </span>
          <span className="font-mono text-11 nums text-stone-500">
            {t("readyFinished", {
              time: run.finishedAt ? clock(run.finishedAt) : "—",
              duration: formatDuration(run.startedAt, run.finishedAt),
            })}
          </span>
        </p>
        {run.fileName && (
          <p className="mt-3 break-all font-mono text-sm text-indigo">
            {run.fileName}
          </p>
        )}
        <p className="mt-1 font-mono text-11 nums text-stone-500">
          {t("readyMeta", {
            format: run.format ? t(FORMAT_KEYS[run.format]) : "—",
            size: formatBytes(run.fileSize ?? 0),
            counts: labels.counts(recordClass, { ...run.counts, links: 0 }, {
              includeAuthorities: run.includeAuthorities,
              links: false,
            }),
          })}
        </p>
        <p className="mt-3 text-13 leading-normal text-stone-500">
          {run.r2Key === null ? t("rowFileGone") : t("readyRetention")}
        </p>
      </DialogShell>
    );
  }

  // Cancelled and failed share the shell; only a failed run has a
  // reason to give.
  const failed = run.status === "failed";
  const detail = (run.failure?.detail ?? {}) as {
    referenceCode?: string;
    titles?: string[];
  };
  const duplicate = run.failure?.code === "duplicate-reference-code";

  return (
    <DialogShell
      provenance={provenance}
      title={t("failedTitle")}
      titleId="export-run-title"
      onDismiss={onClose}
      footer={
        <>
          {duplicate && detail.referenceCode ? (
            <a
              href={`/search?q=${encodeURIComponent(detail.referenceCode)}`}
              className="inline-flex h-11 items-center justify-center rounded-lg bg-indigo px-4.5 text-15 font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("openRecords")}
            </a>
          ) : null}
          <QuietButton label={t("close")} onClick={onClose} />
        </>
      }
    >
      <p className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] ${
            failed
              ? "bg-madder-tint text-madder-deep"
              : "bg-stone-100 text-stone-600"
          }`}
        >
          {failed ? t("statusFailed") : t("statusCancelled")}
        </span>
        <span className="font-mono text-11 nums text-stone-500">
          {(run.progressDone ?? 0) > 0
            ? t("failedStopped", { done: labels.number(run.progressDone ?? 0), items })
            : t("failedStoppedEarly")}
        </span>
      </p>

      {failed && (
        <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-stone-700">
          <CircleAlert
            className="mt-0.5 h-4 w-4 flex-none text-madder"
            strokeWidth={1.75}
          />
          <span>
            {t(failureKey(run.failure?.code), { code: detail.referenceCode ?? "" })}
          </span>
        </p>
      )}
      {duplicate && detail.titles && detail.titles.length > 0 && (
        <p className="mt-2 pl-6 font-serif text-13 leading-normal text-stone-600">
          {detail.titles.join(" · ")}
        </p>
      )}
      <p className="mt-3 text-11 leading-normal text-stone-500">
        {t("failedRecorded")}
      </p>
      <p className="mt-2 font-mono text-11 nums text-stone-400">
        {t("failedWindow", {
          from: clock(run.startedAt),
          to: run.finishedAt ? clock(run.finishedAt) : "—",
        })}
      </p>
    </DialogShell>
  );
}

/* @version v0.7.0 */
