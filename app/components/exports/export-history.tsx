/**
 * ExportHistory — what left, in what shape, and when
 *
 * These records are yours, and getting them out never requires us.
 * Every run is recorded here, which is the promise the whole surface
 * exists to make, so the empty state states it rather than saving it
 * for a populated table.
 *
 * A ROW STAYS IDENTIFIABLE WHATEVER HAPPENED TO IT. The scope line is
 * printed for a failed run exactly as for a completed one — a run you
 * cannot recognise is a run you cannot act on — and the reason sits
 * under it, specific enough to fix. Madder enters here and nowhere
 * else in the history.
 *
 * THE ROW'S ACTION IS ITS STATUS. Completed offers Download, or "Open
 * again" when the artifact is a rendered finding aid rather than a
 * file. In progress offers Cancel, and says you may leave. Failed
 * offers Try again, which starts a new run from the same three axes
 * rather than resuming the stopped one. A run whose file has aged past
 * the retention window keeps everything but the download, because the
 * promise is that the workspace can always say what left — not that it
 * can always fetch it again.
 *
 * @version v0.7.0
 */
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Download, ExternalLink } from "lucide-react";
import type { ExportRunView } from "~/lib/export/run.server";
import type { ExportRecordClass } from "~/lib/export/matrix";
import {
  FORMAT_KEYS,
  FORM_KEYS,
  failureKey,
  useExportLabels,
  useScopeText,
} from "./export-labels";
import { etaMinutes, useRunPoll } from "./use-run-poll";

/** Mono stamps stay ISO in both languages. */
function isoDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function ExportHistory({
  runs,
  onCancel,
  onRetry,
}: {
  runs: ExportRunView[];
  onCancel: (runId: string) => void;
  onRetry: (run: ExportRunView) => void;
}) {
  const { t } = useTranslation("exports");

  return (
    <section className="mt-12">
      <h2 className="font-serif text-xl font-semibold leading-tight text-indigo">
        {t("historyTitle")}
      </h2>
      <p className="mt-1.5 max-w-[60ch] font-serif text-15 leading-relaxed text-indigo-soft">
        {t("historyIntro")}
      </p>

      {runs.length === 0 ? (
        <div className="mt-5 border-t border-stone-200 px-5 py-12 text-center">
          <b className="block font-serif text-lg font-semibold text-indigo">
            {t("historyEmptyHeading")}
          </b>
          <small className="mx-auto mt-1.5 block max-w-[44ch] text-sm leading-relaxed text-stone-500">
            {t("historyEmptyBody")}
          </small>
        </div>
      ) : (
        <div className="mt-5 border-t border-stone-200">
          {runs.map((run) => (
            <Fragment key={run.id}>
              <ExportHistoryRow run={run} onCancel={onCancel} onRetry={onRetry} />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

function ExportHistoryRow({
  run: initial,
  onCancel,
  onRetry,
}: {
  run: ExportRunView;
  onCancel: (runId: string) => void;
  onRetry: (run: ExportRunView) => void;
}) {
  const { t } = useTranslation("exports");
  const labels = useExportLabels();
  const scope = useScopeText();
  const run = useRunPoll(initial);

  const recordClass: ExportRecordClass = run.recordClass ?? "records";
  const descriptor = run.descriptor;
  const title = t("rowTitle", {
    scope:
      descriptor?.kind === "carried" && descriptor.unticked > 0
        ? `${scope.summary(descriptor)} · ${t("rowCarriedUnticked", {
            count: descriptor.unticked,
          })}`
        : scope.summary(descriptor),
    form: run.form ? t(FORM_KEYS[run.form]) : "—",
    format: run.format ? t(FORMAT_KEYS[run.format]) : "—",
  });

  // A run row stores its three counts, never its link count, so the
  // links clause is left off rather than printed as a zero.
  const countsLine = labels.counts(recordClass, { ...run.counts, links: 0 }, {
    includeAuthorities: run.includeAuthorities,
    links: false,
  });
  const meta =
    descriptor?.kind === "carried"
      ? `${t("rowCarriedFound", {
          exported: labels.number(descriptor.willExport),
          found: labels.number(descriptor.found),
        })} · ${countsLine}`
      : descriptor?.kind === "handlist"
        ? `${t("rowHandlist")} · ${countsLine}`
        : countsLine;

  const running = run.status === "running";
  const eta = running ? etaMinutes(run, Date.now()) : null;
  const stageLabel =
    run.stage === "descriptions"
      ? t("stageDescriptions").replace(/\.$/, "")
      : run.stage === "authorities"
        ? t("stageAuthorities").replace(/\.$/, "")
        : null;

  return (
    <div className="grid grid-cols-[96px_1fr_auto_auto] items-center gap-4 border-b border-stone-100 px-0.5 py-3 max-md:grid-cols-1 max-md:items-start max-md:gap-1.5">
      <time className="font-mono text-xs nums text-stone-400">
        {isoDay(run.createdAt)}
      </time>

      <div className="min-w-0">
        <p className="text-15 font-semibold leading-snug text-indigo">{title}</p>
        {running ? (
          <>
            <p className="mt-0.5 font-mono text-xs nums leading-relaxed text-stone-500">
              {stageLabel !== null && (run.progressDone ?? 0) > 0
                ? t("rowProgress", {
                    stage: stageLabel,
                    done: labels.number(run.progressDone ?? 0),
                    items: labels.primary(recordClass, run.progressTotal ?? 0),
                  })
                : t("rowPreparing", { counts: countsLine })}
            </p>
            <p className="mt-1 text-11 leading-normal text-stone-500">
              {eta === null
                ? t("rowLeave")
                : t("rowLeaveWithEta", { eta: t("workingEta", { count: eta }) })}
            </p>
          </>
        ) : (
          <p className="mt-0.5 font-mono text-xs nums leading-relaxed text-stone-500">
            {meta}
          </p>
        )}
        {run.status === "failed" && (
          <p className="mt-1 max-w-[68ch] text-13 leading-normal text-madder-deep">
            {t(failureKey(run.failure?.code), {
              code:
                (run.failure?.detail as { referenceCode?: string } | undefined)
                  ?.referenceCode ?? "",
            })}
            {run.failure?.code === "duplicate-reference-code" && (
              <> {t("failureDuplicateReferenceCodeFix")}</>
            )}
          </p>
        )}
        {run.status === "completed" && run.r2Key === null && (
          <p className="mt-1 text-11 leading-normal text-stone-500">
            {t("rowFileGone")}
          </p>
        )}
      </div>

      <StatusPill status={run.status} />

      <div className="whitespace-nowrap text-right">
        {running ? (
          <button
            type="button"
            onClick={() => onCancel(run.id)}
            className="text-13 font-semibold text-stone-500 hover:text-madder-deep"
          >
            {t("cancel")}
          </button>
        ) : run.status === "completed" && run.r2Key !== null ? (
          run.format === "pdf" ? (
            <a
              href={`/admin/exports/aid/${run.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-13 font-semibold text-verdigris-deep hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t("openAgain")}
            </a>
          ) : (
            <a
              href={`/admin/exports/download/${run.id}`}
              className="inline-flex items-center gap-1.5 text-13 font-semibold text-verdigris-deep hover:underline"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t("download")}
            </a>
          )
        ) : run.status === "failed" || run.status === "cancelled" ? (
          <button
            type="button"
            onClick={() => onRetry(run)}
            className="text-13 font-semibold text-verdigris-deep hover:underline"
          >
            {t("tryAgain")}
          </button>
        ) : (
          <span className="text-13 text-stone-400">{t("rowReadyShortly")}</span>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ExportRunView["status"] }) {
  const { t } = useTranslation("exports");
  const tone =
    status === "completed"
      ? "bg-verdigris-tint text-verdigris-deep"
      : status === "running"
        ? "bg-saffron-tint text-saffron-deep"
        : status === "failed"
          ? "bg-madder-tint text-madder-deep"
          : "bg-stone-100 text-stone-600";
  const label =
    status === "completed"
      ? t("statusCompleted")
      : status === "running"
        ? t("statusInProgress")
        : status === "failed"
          ? t("statusFailed")
          : t("statusCancelled");
  return (
    <span
      className={`justify-self-start rounded-full px-2.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] ${tone}`}
    >
      {label}
    </span>
  );
}

/* @version v0.7.0 */
