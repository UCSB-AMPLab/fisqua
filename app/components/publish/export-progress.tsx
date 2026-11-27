/**
 * Publish Run Progress Panel
 *
 * This component polls `/api/publish?exportId=…` every second while
 * the run is live and renders its progress: a bar with "Step N of M",
 * the current step's and the run's elapsed times, and the list of every
 * step the run will take. It links out to the downstream GitHub Actions
 * rebuild once the pipeline finishes successfully. Poll interval is
 * deliberately short so a 12 s run still gives the operator several
 * visible updates.
 *
 * The step list is the run's plan (`planPublishSteps`, the list the
 * workflow walks), built from the run's selected fonds and data types
 * as soon as the run is known, so every step shows from the start.
 * Whether entities, places and their link files are in the plan depends
 * on the tenant's authorities capability, which the run row does not
 * record; the run's `total_steps` was computed from the same plan at
 * creation, so the plan with the capability is used when its length is
 * `total_steps`, and the plan without it otherwise. A run whose current
 * step, record counts or step log name a METS step was recorded by the
 * code that ran METS steps, and is listed against that code's plan
 * (`planLegacyPublishSteps`), chosen the same way, METS steps included.
 *
 * Each step's state comes from the heartbeat. The workflow runs the
 * plan in order, one step at a time, so the steps before the current
 * one are completed; the current one is completed once its completion
 * time is written, and running until then; the rest are pending. When
 * the run fails, the current step failed, or, if it had completed, the
 * one after it. A link file's steps, and a legacy fonds' METS batches
 * (`mets:<fonds>:<n>`), map to one plan step (`planStepIdOf`). A
 * current step the plan does not know is placed by the run's count of
 * completed steps. A completed step shows what it wrote, from the run's
 * record counts, and how long it took, from the run's step log
 * (`step_log`, migration 0117: each plan step's start and end, a link
 * file from its first step's start to its last's end). A completed group shows its total time, from its
 * first step's start to its last step's end. A run without a step log
 * (any run before 0117) shows no durations; the running step shows the
 * time since it started.
 *
 * The steps are grouped by artefact. The workflow writes one artefact
 * for every fonds before it starts the next, so the groups keep the
 * run's order. A group of several fonds is a disclosure with its count
 * ("3 of 10"): open while it runs or after it failed, closed otherwise,
 * so a run of sixty steps reads as a dozen lines.
 *
 * `ExportProgressView` is the panel without the polling, rendered from
 * one run and a clock reading; the tests render it directly.
 *
 * The `../../lib/use-formatters` import is a relative path so the
 * module loads under the workers vitest pool (which does not alias
 * `~/`).
 *
 * @version v0.9.0
 */

import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { useFormatters } from "../../lib/use-formatters";
import {
  planPublishSteps,
  planLegacyPublishSteps,
  planStepIdOf,
  type PublishPlanStep,
} from "../../lib/export/publish-steps";

type PublishStepKind = PublishPlanStep["kind"];

const GITHUB_ACTIONS_URL =
  "https://github.com/neogranadina/zasqua/actions/workflows/deploy.yml";

// 1 second — fast enough that a 12 second, 22 step publish run shows ~12
// visible mid-run updates. D1 handles 1 req/s without sweating; the GET
// loader is a single-row select.
const POLL_INTERVAL_MS = 1000;

export interface ExportProgressData {
  id: string;
  status: string;
  /** JSON array of fonds reference codes, as stored on the run. */
  selectedFonds: string;
  /** JSON array of data types, as stored on the run. */
  selectedTypes: string;
  currentStep: string | null;
  stepsCompleted: number;
  totalSteps: number;
  recordCounts: string | null;
  /** JSON `{planStepId: {startedAt, completedAt}}`; null before migration 0117. */
  stepLog: string | null;
  errorMessage: string | null;
  completedAt: number | null;
  // Heartbeat columns — all unix ms.
  startedAt: number | null;
  currentStepStartedAt: number | null;
  currentStepCompletedAt: number | null;
  lastHeartbeatAt: number | null;
}

export type StepState = "completed" | "running" | "pending" | "failed";
export type GroupState = StepState | "partial";

export interface StepRow {
  step: PublishPlanStep;
  state: StepState;
  /** What the step wrote, from the run's record counts. */
  count: number | null;
  /** How long a completed step took, in ms, from the step log. */
  durationMs: number | null;
}

export interface StepGroup {
  kind: PublishStepKind;
  state: GroupState;
  rows: StepRow[];
  /** A completed group's time from its first start to its last end, in ms. */
  durationMs: number | null;
}

interface StepLogEntry {
  startedAt?: number;
  completedAt?: number;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** True when the run's current step, record counts or step log name a METS step. */
function namesMetsStep(data: ExportProgressData): boolean {
  const isMets = (name: string) => name.startsWith("mets:");
  const keys = (text: string | null) => Object.keys(parseJson<Record<string, unknown> | null>(text, {}) ?? {});
  return (!!data.currentStep && isMets(data.currentStep)) || keys(data.recordCounts).some(isMets) || keys(data.stepLog).some(isMets);
}

/**
 * The run's plan: with the authorities capability when that plan has
 * the run's `total_steps`, without it otherwise. A run that names a
 * METS step was recorded by the code that ran METS steps, and only that
 * code wrote such names, so its plan is that code's
 * (`planLegacyPublishSteps`), chosen the same way. A run of that code
 * that ended before its METS steps names none and is listed against the
 * current plan; that is display only, for past runs.
 */
function planForRun(data: ExportProgressData): PublishPlanStep[] {
  const selectedFonds = parseJson<string[]>(data.selectedFonds, []);
  const selectedTypes = parseJson<string[]>(data.selectedTypes, []);
  const build = namesMetsStep(data) ? planLegacyPublishSteps : planPublishSteps;
  const withAuthorities = build({ selectedFonds, selectedTypes, authoritiesEnabled: true });
  if (withAuthorities.length === data.totalSteps) return withAuthorities;
  return build({ selectedFonds, selectedTypes, authoritiesEnabled: false });
}

/** Every step of the run's plan with its state, grouped by artefact. */
export function deriveStepGroups(data: ExportProgressData): StepGroup[] {
  const plan = planForRun(data);
  const counts = parseJson<Record<string, number>>(data.recordCounts, {});
  const log = parseJson<Record<string, StepLogEntry>>(data.stepLog, {});
  const logged = (id: string) => {
    const entry = log[id];
    return entry && typeof entry.startedAt === "number" && typeof entry.completedAt === "number"
      ? { startedAt: entry.startedAt, completedAt: entry.completedAt }
      : null;
  };
  const isComplete = data.status === "complete";
  const isError = data.status === "error";

  // Index of the current step in the plan, and whether it has completed.
  let current = data.currentStep ? plan.findIndex((s) => s.id === planStepIdOf(data.currentStep!)) : -1;
  let currentDone = data.currentStepCompletedAt != null;
  if (data.currentStep && current === -1) {
    // A step name the plan does not know: fall back on the count.
    current = Math.min(data.stepsCompleted, plan.length) - 1;
    currentDone = true;
  }

  const states: StepState[] = plan.map((_, i) => {
    if (isComplete) return "completed";
    if (i < current) return "completed";
    if (i === current) {
      if (currentDone) return "completed";
      return isError ? "failed" : "running";
    }
    if (isError && current >= 0 && currentDone && i === current + 1) return "failed";
    return "pending";
  });

  const groups: StepGroup[] = [];
  plan.forEach((step, i) => {
    const row: StepRow = {
      step,
      state: states[i],
      count: typeof counts[step.id] === "number" ? counts[step.id] : null,
      durationMs: null,
    };
    const entry = states[i] === "completed" ? logged(step.id) : null;
    if (entry) row.durationMs = Math.max(0, entry.completedAt - entry.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.kind === step.kind) last.rows.push(row);
    else groups.push({ kind: step.kind, state: "pending", rows: [row], durationMs: null });
  });

  for (const group of groups) {
    const rowStates = group.rows.map((r) => r.state);
    const done = rowStates.filter((s) => s === "completed").length;
    if (rowStates.includes("failed")) group.state = "failed";
    else if (rowStates.includes("running")) group.state = "running";
    else if (done === rowStates.length) group.state = "completed";
    else if (done === 0) group.state = "pending";
    // Some fonds done and none running: between two steps of a live
    // run, or a run that ended part-way through the group.
    else group.state = isComplete || isError ? "partial" : "running";

    if (group.state === "completed") {
      const entries = group.rows.map((r) => logged(r.step.id));
      if (entries.every((e) => e !== null)) {
        const start = Math.min(...entries.map((e) => e!.startedAt));
        const end = Math.max(...entries.map((e) => e!.completedAt));
        group.durationMs = Math.max(0, end - start);
      }
    }
  }
  return groups;
}

function formatElapsed(totalSeconds: number): { minutes: number; seconds: number } {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return { minutes: Math.floor(safe / 60), seconds: safe % 60 };
}

/** The localised name of an artefact. Static keys, one per kind. */
function kindLabel(kind: PublishStepKind, t: TFunction): string {
  switch (kind) {
    case "descriptions": return t("progress.stepLabels.descriptions");
    case "index": return t("progress.stepLabels.index");
    case "children": return t("progress.stepLabels.children");
    case "mets": return t("progress.stepLabels.mets");
    case "ead": return t("progress.stepLabels.ead");
    case "dc": return t("progress.stepLabels.dc");
    case "repositories": return t("progress.stepLabels.repositories");
    case "entities": return t("progress.stepLabels.entities");
    case "places": return t("progress.stepLabels.places");
    case "entity_links": return t("progress.stepLabels.entity_links");
    case "place_links": return t("progress.stepLabels.place_links");
  }
}

/** Children and legacy METS steps write files; every other step writes records. */
function countLabel(kind: PublishStepKind, count: number, t: TFunction, formatNumber: (n: number) => string): string {
  const formattedCount = formatNumber(count);
  return kind === "children" || kind === "mets"
    ? t("progress.files_count", { count, formattedCount })
    : t("progress.records_count", { count, formattedCount });
}

const STATE_ICON: Record<GroupState, { icon: LucideIcon; className: string }> = {
  completed: { icon: CircleCheck, className: "text-verdigris" },
  running: { icon: LoaderCircle, className: "animate-spin text-indigo motion-reduce:animate-none" },
  pending: { icon: Circle, className: "text-stone-300" },
  failed: { icon: CircleX, className: "text-madder" },
  partial: { icon: CircleCheck, className: "text-saffron" },
};

function StateIcon({ state, t }: { state: GroupState; t: TFunction }) {
  const { icon: Icon, className } = STATE_ICON[state];
  return (
    <>
      <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${className}`} strokeWidth={2} />
      <span className="sr-only">{t(`progress.state.${state}`)}</span>
    </>
  );
}

interface RowContext {
  t: TFunction;
  formatNumber: (n: number) => string;
  stepElapsed: { minutes: number; seconds: number } | null;
}

/** What a step row shows on its right: what it wrote, its time, or its failure. */
function rowDetail(row: StepRow, ctx: RowContext): ReactNode {
  const { t, formatNumber, stepElapsed } = ctx;
  if (row.state === "failed") {
    return <span className="font-sans text-11 text-madder-deep">{t("progress.state.failed")}</span>;
  }
  if (row.state === "running") {
    const parts: string[] = [];
    if (stepElapsed) parts.push(t("progress.duration", stepElapsed));
    return parts.length > 0 ? <span className="font-mono text-11 text-indigo">{parts.join(" · ")}</span> : null;
  }
  if (row.state === "completed") {
    const parts: string[] = [];
    if (row.count !== null) parts.push(countLabel(row.step.kind, row.count, t, formatNumber));
    if (row.durationMs !== null) parts.push(t("progress.duration", formatElapsed(row.durationMs / 1000)));
    return parts.length > 0 ? <span className="font-mono text-11 text-stone-500">{parts.join(" · ")}</span> : null;
  }
  return null;
}

function StepLine({ row, label, ctx }: { row: StepRow; label: ReactNode; ctx: RowContext }) {
  return (
    <div
      data-step={row.step.id}
      data-state={row.state}
      className="flex items-center gap-2 px-3 py-1.5"
    >
      <StateIcon state={row.state} t={ctx.t} />
      {label}
      <span className="ml-auto pl-3 text-right">{rowDetail(row, ctx)}</span>
    </div>
  );
}

function StepGroupItem({ group, ctx }: { group: StepGroup; ctx: RowContext }) {
  const { t, formatNumber } = ctx;
  const name = kindLabel(group.kind, t);
  const labelClass = `font-sans text-13 ${group.state === "pending" ? "text-stone-500" : "text-stone-800"}`;

  // A single, non-fonds step (the index, repositories, entities, …).
  if (!group.rows[0].step.fonds) {
    return (
      <li data-group={group.kind} data-group-state={group.state}>
        <StepLine row={group.rows[0]} label={<span className={labelClass}>{name}</span>} ctx={ctx} />
      </li>
    );
  }

  const done = group.rows.filter((r) => r.state === "completed").length;
  const known = group.rows.filter((r) => r.count !== null);
  const total = known.reduce((sum, r) => sum + (r.count ?? 0), 0);
  const expanded = group.state === "running" || group.state === "failed";

  return (
    <li>
      <details data-group={group.kind} data-group-state={group.state} open={expanded} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
          <StateIcon state={group.state} t={t} />
          <span className={labelClass}>{name}</span>
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-stone-400 transition-transform group-open:rotate-90" />
          <span className="ml-auto flex items-center gap-3 pl-3 font-mono text-11 text-stone-500">
            {group.state === "completed" && known.length > 0 && (
              <span>{countLabel(group.kind, total, t, formatNumber)}</span>
            )}
            {group.durationMs !== null && (
              <span>{t("progress.duration", formatElapsed(group.durationMs / 1000))}</span>
            )}
            <span>{t("progress.groupCount", { done, total: group.rows.length })}</span>
          </span>
        </summary>
        <ol className="pb-1 pl-6">
          {group.rows.map((row) => (
            <li key={row.step.id}>
              <StepLine
                row={row}
                label={<span className="font-mono text-11 text-stone-700">{row.step.fonds}</span>}
                ctx={ctx}
              />
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

interface ExportProgressViewProps {
  data: ExportProgressData;
  /** The clock reading the elapsed times are measured to, unix ms. */
  now: number;
}

export function ExportProgressView({ data, now }: ExportProgressViewProps) {
  const { t } = useTranslation("publish");
  const { formatNumber, formatIsoDateTime } = useFormatters();

  const percent =
    data.totalSteps > 0
      ? Math.round((data.stepsCompleted / data.totalSteps) * 100)
      : 0;

  const isComplete = data.status === "complete";
  const isError = data.status === "error";
  const isRunning = !isComplete && !isError;

  const groups = deriveStepGroups(data);
  const stepRunning = groups.some((g) => g.state === "running");
  const ctx: RowContext = {
    t,
    formatNumber,
    stepElapsed:
      isRunning && data.currentStepStartedAt && data.currentStepCompletedAt == null
        ? formatElapsed((now - data.currentStepStartedAt) / 1000)
        : null,
  };

  return (
    <section className="rounded-lg border border-stone-200 p-4 space-y-3">
      <h2 className="font-serif text-lg font-semibold text-stone-800">
        {t("progress.title")}
      </h2>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between font-sans text-xs text-stone-500">
          <span>
            {t("progress.step")} {data.stepsCompleted} {t("progress.of")}{" "}
            {data.totalSteps}
          </span>
          <span className="font-mono text-11">{percent}%</span>
        </div>
        <div className="mt-1 h-1.5 w-full rounded-full bg-stone-100">
          <div
            className={`h-2 rounded-full transition-all ${
              isComplete
                ? "bg-verdigris"
                : isError
                  ? "bg-madder"
                  : "bg-indigo"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {/* Elapsed times (or a 'starting' line before the first heartbeat) */}
      {isRunning && !data.currentStep && (
        <p className="font-sans text-sm italic text-stone-500">
          {t("progress.starting")}
        </p>
      )}
      {isRunning && data.currentStep && (
        <div className="space-y-1">
          {stepRunning && data.currentStep.startsWith("children:") && (
            <p className="font-sans text-xs italic text-stone-500">
              {t("progress.reassurance.children")}
            </p>
          )}
          {stepRunning && data.currentStep === "descriptions:index" && (
            <p className="font-sans text-xs italic text-stone-500">
              {t("progress.reassurance.index")}
            </p>
          )}
          <div className="flex flex-wrap gap-4 font-sans text-xs text-stone-500">
            {ctx.stepElapsed && (
              <span>{t("progress.stepElapsed", ctx.stepElapsed)}</span>
            )}
            {data.startedAt && (
              <span>
                {t("progress.totalElapsed", {
                  ...formatElapsed((now - data.startedAt) / 1000),
                })}
              </span>
            )}
            {data.lastHeartbeatAt && (
              <span>
                {t("progress.lastUpdate", {
                  timestamp: formatIsoDateTime(data.lastHeartbeatAt),
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Every step of the run, grouped by artefact */}
      {groups.length > 0 && (
        <ol
          aria-label={t("progress.stepsTitle")}
          className="divide-y divide-stone-100 rounded-md border border-stone-200"
        >
          {groups.map((group) => (
            <StepGroupItem key={group.kind} group={group} ctx={ctx} />
          ))}
        </ol>
      )}

      {/* Complete */}
      {isComplete && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3">
            <CircleCheck aria-hidden="true" className="h-5 w-5 text-verdigris-deep" strokeWidth={2} />
            <span className="font-sans text-sm font-medium text-verdigris-deep">
              {t("progress.complete")}
            </span>
          </div>

          {/* Rebuild reminder */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
            <h3 className="font-sans text-sm font-medium text-blue-800">
              {t("rebuild.title")}
            </h3>
            <p className="mt-1 font-sans text-sm text-blue-700">
              {t("rebuild.message")}
            </p>
            <a
              href={GITHUB_ACTIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block font-sans text-sm font-medium text-blue-700 underline hover:text-blue-900"
            >
              {t("rebuild.link")} &rarr;
            </a>
          </div>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex items-start gap-2 rounded-md border border-madder bg-madder-tint px-4 py-3">
          <CircleX aria-hidden="true" className="mt-0.5 h-5 w-5 text-madder-deep" strokeWidth={2} />
          <div>
            <span className="font-sans text-sm font-medium text-madder-deep">
              {t("progress.error")}
            </span>
            {data.errorMessage && (
              <p className="mt-1 font-sans text-sm text-madder-deep">
                {data.errorMessage}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface ExportProgressProps {
  exportId: string;
}

export function ExportProgress({ exportId }: ExportProgressProps) {
  const { t } = useTranslation("publish");
  const [data, setData] = useState<ExportProgressData | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 1-second ticker so elapsed times advance smoothly between polls.
  // Only runs while the export is in a non-terminal state.
  const [, forceTick] = useState(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/publish?exportId=${exportId}`);
        if (res.ok && !cancelled) {
          const json = (await res.json()) as ExportProgressData;
          setData(json);

          // Stop polling on terminal states
          if (json.status === "complete" || json.status === "error") {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
          }
        }
      } catch {
        // Ignore fetch errors, will retry on next interval
      }
    }

    // Initial fetch
    poll();

    // Start polling
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [exportId]);

  // Drive a 1 Hz re-render so the elapsed-time labels advance between polls.
  // Runs only while the export is in a non-terminal state.
  useEffect(() => {
    const running =
      data !== null && data.status !== "complete" && data.status !== "error";
    if (!running) {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
      return;
    }
    tickerRef.current = setInterval(() => {
      forceTick((n) => (n + 1) % 1_000_000);
    }, 1000);
    return () => {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
    };
  }, [data]);

  if (!data) {
    return (
      <section className="rounded-lg border border-stone-200 p-4">
        <h2 className="font-serif text-lg font-semibold text-stone-800">
          {t("progress.title")}
        </h2>
        <p className="mt-2 font-sans text-sm text-stone-400">
          {t("progress.processing")}...
        </p>
      </section>
    );
  }

  return <ExportProgressView data={data} now={Date.now()} />;
}

/* @version v0.9.0 */
