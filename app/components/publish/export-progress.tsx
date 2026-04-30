/**
 * Publish Run Progress Panel
 *
 * Polls `/admin/publish/runs/:exportId` every second while the run is
 * live, renders the heartbeat state — current step, steps completed,
 * record counts — and links out to the downstream GitHub Actions
 * rebuild once the pipeline finishes successfully. Poll interval is
 * deliberately short so a 12 s run still gives the operator several
 * visible updates.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatIsoDateTime } from "~/lib/format-date";

const GITHUB_ACTIONS_URL =
  "https://github.com/neogranadina/zasqua-frontend/actions/workflows/deploy.yml";

// 1 second — fast enough that a 12 second, 22 step publish run shows ~12
// visible mid-run updates. D1 handles 1 req/s without sweating; the GET
// loader is a single-row select.
const POLL_INTERVAL_MS = 1000;

interface ExportProgressData {
  id: string;
  status: string;
  currentStep: string | null;
  stepsCompleted: number;
  totalSteps: number;
  recordCounts: string | null;
  errorMessage: string | null;
  completedAt: number | null;
  // Heartbeat columns — all unix ms.
  startedAt: number | null;
  currentStepStartedAt: number | null;
  currentStepCompletedAt: number | null;
  lastHeartbeatAt: number | null;
}

function formatElapsed(totalSeconds: number): { minutes: number; seconds: number } {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return { minutes: Math.floor(safe / 60), seconds: safe % 60 };
}

interface ExportProgressProps {
  exportId: string;
}

export function ExportProgress({ exportId }: ExportProgressProps) {
  const { t } = useTranslation("publish");
  const [data, setData] = useState<ExportProgressData | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 1-second ticker so elapsed times advance smoothly between 4s polls.
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
        <h2 className="font-sans text-lg font-semibold text-stone-800">
          {t("progress.title")}
        </h2>
        <p className="mt-2 font-sans text-sm text-stone-400">
          {t("progress.processing")}...
        </p>
      </section>
    );
  }

  const percent =
    data.totalSteps > 0
      ? Math.round((data.stepsCompleted / data.totalSteps) * 100)
      : 0;

  const isComplete = data.status === "complete";
  const isError = data.status === "error";
  const isRunning = !isComplete && !isError;

  // Parse record counts
  let recordCounts: Record<string, number> = {};
  if (data.recordCounts) {
    try {
      recordCounts = JSON.parse(data.recordCounts);
    } catch {
      // Ignore parse errors
    }
  }

  const totalRecords = Object.values(recordCounts).reduce(
    (sum, n) => sum + n,
    0
  );

  return (
    <section className="rounded-lg border border-stone-200 p-4 space-y-3">
      <h2 className="font-sans text-lg font-semibold text-stone-800">
        {t("progress.title")}
      </h2>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between font-sans text-xs text-stone-500">
          <span>
            {t("progress.step")} {data.stepsCompleted} {t("progress.of")}{" "}
            {data.totalSteps}
          </span>
          <span>{percent}%</span>
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

      {/* Current step (or a 'starting' fallback before the first heartbeat) */}
      {isRunning && !data.currentStep && (
        <p className="font-sans text-sm italic text-stone-500">
          {t("progress.starting")}
        </p>
      )}
      {isRunning && data.currentStep && (
        <div className="space-y-1">
          <p className="font-sans text-sm text-stone-600">
            {t("progress.processing")}: {data.currentStep}
          </p>
          {data.currentStep.startsWith("children:") && (
            <p className="font-sans text-xs italic text-stone-500">
              {t("progress.reassurance.children")}
            </p>
          )}
          {data.currentStep === "descriptions:index" && (
            <p className="font-sans text-xs italic text-stone-500">
              {t("progress.reassurance.index")}
            </p>
          )}
          <div className="flex flex-wrap gap-4 font-sans text-xs text-stone-500">
            {data.currentStepStartedAt && (
              <span>
                {t("progress.stepElapsed", {
                  ...formatElapsed(
                    (Date.now() - data.currentStepStartedAt) / 1000
                  ),
                })}
              </span>
            )}
            {data.startedAt && (
              <span>
                {t("progress.totalElapsed", {
                  ...formatElapsed((Date.now() - data.startedAt) / 1000),
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

      {/* Record counts */}
      {totalRecords > 0 && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(recordCounts).map(([key, count]) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-0.5 font-sans text-xs text-stone-600"
            >
              {key}: {count.toLocaleString()} {t("progress.records")}
            </span>
          ))}
        </div>
      )}

      {/* Complete */}
      {isComplete && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3">
            <svg
              className="h-5 w-5 text-verdigris-deep"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
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
          <svg
            className="mt-0.5 h-5 w-5 text-madder-deep"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
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
