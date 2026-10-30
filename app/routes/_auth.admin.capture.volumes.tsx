/**
 * Digitization — Volumes
 *
 * This page lists every volume the tenant's Captua scanner handed over,
 * one row per reference code, with the handover the capture link would
 * report for it: its openings, when it was handed over, where it stands
 * and the next step. It is for the people who manage capture work, the
 * tenant's digitization admins and its federation's stewards; the tenant must have
 * the digitization capability (a bare 404 otherwise) and anyone else
 * gets a bare 403. The rows come from `loadCaptureVolumes`, scoped to
 * the request's tenant.
 *
 * The state filter is the `state` search parameter, so a filtered view
 * survives a reload and can be shared. The filter lists the states the
 * module's design draws, and the others (refused, superseded, failed)
 * only while a volume is in one of them. A refused handover is
 * explained by a translated sentence for its rule; a failed run shows
 * the pipeline's error text, labelled as technical output. Under the
 * footnote, a gloss says what an opening is.
 *
 * A volume whose delivery has no review run yet (one registered from a
 * file) shows Prepare review images, and one whose review run failed
 * shows Retry; each posts to the volume's review-run route and, when the
 * run cannot be started, says so under the button. A next step links
 * only to what exists. Assigning a reviewer goes to
 * the Capture QC queue, which assigns through the reviewer route.
 * Continuing a review opens the volume in the capture QC viewer. A
 * published volume
 * opens at its description. An approved volume shows no step: starting
 * processing needs the run's purpose and review fraction, which this
 * screen has no way to choose. The volume's runs have no page to link
 * to, so the screen has no Runs column.
 *
 * @version@version v0.8.0
 */

import { Link, useFetcher, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { useFormatters } from "../lib/use-formatters";
import { DRAWN_SCREEN_STATES, SCREEN_STATES, refusalKey, shortError, type ScreenState } from "../lib/capture/screens";
import type { CaptureVolumeRow } from "../lib/capture/screens.server";
import { CaptureEmptyState, CapturePageHeader, CaptureStateBadge } from "../components/capture/capture-parts";
import type { Route } from "./+types/_auth.admin.capture.volumes";

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess, loadCaptureVolumes } = await import("~/lib/capture/screens.server");
  const db = drizzle(context.cloudflare.env.DB);
  const access = await captureAccess(db, tenant, user);
  if (!access.manager) throw new Response(null, { status: 403 });
  return { volumes: await loadCaptureVolumes(db, tenant.id, Date.now()) };
}

function isScreenState(value: string | null): value is ScreenState {
  return value !== null && (SCREEN_STATES as readonly string[]).includes(value);
}

export default function CaptureVolumesPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("capture");
  const { formatDate } = useFormatters();
  const { volumes } = loaderData;
  const [params, setParams] = useSearchParams();
  const raw = params.get("state");
  const selected = isScreenState(raw) ? raw : null;

  const present = new Set(volumes.map((v) => v.state));
  const filters = SCREEN_STATES.filter((s) => DRAWN_SCREEN_STATES.includes(s) || present.has(s) || s === selected);
  const shown = selected ? volumes.filter((v) => v.state === selected) : volumes;

  const choose = (state: ScreenState | null) => {
    const next = new URLSearchParams(params);
    if (state) next.set("state", state);
    else next.delete("state");
    setParams(next, { replace: true, preventScrollReset: true });
  };

  return (
    <div className="mx-auto max-w-6xl px-2 py-6">
      <CapturePageHeader title={t("volumes.title")} intro={t("volumes.intro")} />

      {volumes.length === 0 ? (
        <CaptureEmptyState icon={BookOpen} title={t("volumes.empty_title")} body={t("volumes.empty_body")} />
      ) : (
        <>
          <div role="group" aria-label={t("volumes.filter_label")} className="mt-6 flex flex-wrap gap-2">
            <FilterButton pressed={selected === null} onClick={() => choose(null)} label={t("volumes.filter_all")} />
            {filters.map((s) => (
              <FilterButton key={s} pressed={selected === s} onClick={() => choose(s)} label={t(`state.${s}`)} />
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="mt-6 font-sans text-sm text-stone-500">{t("volumes.empty_filter")}</p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
              <table className="w-full min-w-[960px] text-left font-sans text-sm">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                    <th scope="col" className="px-4 py-3">{t("columns.reference_code")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.title")}</th>
                    <th scope="col" className="px-4 py-3 text-right">{t("columns.openings")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.handed_over")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.state")}</th>
                    <th scope="col" className="px-4 py-3">{t("columns.next_step")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((v) => (
                    <tr key={v.referenceCode} className="border-b border-stone-100 last:border-b-0">
                      <td className="px-4 py-3 font-mono text-[13px] text-indigo">{v.referenceCode}</td>
                      <td className="px-4 py-3 font-serif text-[15px] text-stone-700">{v.title}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-stone-700">{v.openings}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-stone-700">{formatDate(v.handedOverAt)}</td>
                      <td className="px-4 py-3">
                        <CaptureStateBadge state={v.state} rejected={v.rejected} />
                        <ProblemLine problem={v.problem} />
                      </td>
                      <td className="px-4 py-3">
                        <NextStepCell row={v} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 font-sans text-xs text-stone-500">{t("volumes.footnote")}</p>
          <p className="mt-1 font-sans text-xs text-stone-500">{t("volumes.opening_gloss")}</p>
        </>
      )}
    </div>
  );
}

/**
 * Why a volume stopped. A refusal reads as a translated sentence for its
 * rule. A pipeline error is the runner's own text, in English, so it is
 * labelled as technical output and set in monospace, cut to
 * `PIPELINE_ERROR_CHARS` with the whole text in its title.
 */
function ProblemLine({ problem }: { problem: CaptureVolumeRow["problem"] }) {
  const { t } = useTranslation("capture");
  if (!problem) return null;
  if (problem.kind === "refusal") {
    return <p className="mt-1 max-w-[32ch] text-xs text-madder-deep">{t(refusalKey(problem.rule))}</p>;
  }
  return (
    <p className="mt-1 max-w-[32ch] text-xs text-madder-deep">
      <span className="font-semibold">{`${t("state.pipeline_error")}:`}</span>{" "}
      <code title={problem.message} className="break-words font-mono text-[11px]">
        {shortError(problem.message)}
      </code>
    </p>
  );
}

function FilterButton({ pressed, onClick, label }: { pressed: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`h-9 rounded-md border px-3 font-sans text-[13px] font-semibold ${
        pressed ? "border-indigo bg-indigo-tint text-indigo" : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );
}

function NextStepCell({ row }: { row: CaptureVolumeRow }) {
  const { t } = useTranslation("capture");
  switch (row.nextStep) {
    case "assign_reviewer":
      return (
        <Link to="/admin/capture/qc" className="font-semibold text-indigo hover:underline">
          {t("next.assign_reviewer")}
        </Link>
      );
    case "continue_review":
      return row.volumeId ? (
        <Link to={`/admin/capture/qc/${row.volumeId}`} className="font-semibold text-indigo hover:underline">
          {t("next.continue_review")}
        </Link>
      ) : null;
    case "open_volume":
      return row.descriptionId ? (
        <Link to={`/admin/descriptions/${row.descriptionId}`} className="font-semibold text-indigo hover:underline">
          {t("next.open_volume")}
        </Link>
      ) : null;
    case "prepare_review":
    case "retry_review":
      return row.volumeId ? <ReviewRunButton volumeId={row.volumeId} step={row.nextStep} /> : null;
    case "review_opens":
    case "retakes_came_back":
    case "waiting_for_scanner":
    case "running":
      return <span className="text-stone-500">{t(`next.${row.nextStep}`)}</span>;
    default:
      return null;
  }
}

/**
 * Prepare or Retry: posts to the volume's review-run route. While the
 * request is out the button is disabled; an answer other than a started
 * run shows the start-failed sentence under it. A started run shows on
 * the next load as Preparing review images.
 */
function ReviewRunButton({ volumeId, step }: { volumeId: string; step: "prepare_review" | "retry_review" }) {
  const { t } = useTranslation("capture");
  const fetcher = useFetcher<{ runId?: string; error?: string }>();
  const busy = fetcher.state !== "idle";
  const failed = fetcher.state === "idle" && fetcher.data !== undefined && !fetcher.data.runId;
  const noteId = `review-run-${volumeId}`;
  return (
    <>
      <button
        type="button"
        disabled={busy}
        aria-describedby={failed ? noteId : undefined}
        onClick={() => fetcher.submit(null, { method: "post", action: `/admin/capture/volumes/${volumeId}/review-run` })}
        className="font-semibold text-indigo hover:underline disabled:cursor-wait disabled:opacity-50"
      >
        {t(`next.${step}`)}
      </button>
      {failed ? (
        <p id={noteId} role="status" className="mt-0.5 max-w-[32ch] text-xs text-madder-deep">
          {t("review_run.start_failed")}
        </p>
      ) : null}
    </>
  );
}

// @version@version v0.8.0
