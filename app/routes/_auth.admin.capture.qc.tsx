/**
 * Digitization — Capture QC Queue
 *
 * This page lists the volumes waiting for capture review: handed over
 * and registered, with review images being prepared, or in capture QC.
 * Each row shows the volume's reviewer, how many of its current
 * delivery's openings are approved, rejected and undecided, and how
 * long it has waited, counted from when its current delivery was
 * received (the delivery's `received_at`, taken as the manifest is
 * registered), since that is when the openings became reviewable. A
 * volume whose earlier handover a retake replaced is marked as such;
 * when the retake's unchanged openings kept their approvals, the row
 * counts the openings it brought back that are still to review, in
 * place of the openings decided.
 *
 * The tenant must have the digitization capability (a bare 404
 * otherwise). The tenant's digitization admins and its federation's stewards see
 * every waiting volume and can assign or reassign its reviewer; a user
 * assigned as reviewer on one of the tenant's volumes sees only their
 * own volumes and no assignment control; anyone else gets a bare 403.
 * Assignment posts `{ reviewerId }` as JSON to the existing reviewer
 * route (`/admin/capture/volumes/:volumeId/reviewer`), which checks the
 * same roles and who may be assigned. The candidates are those it
 * accepts: the tenant's own users, as archive staff, and the other
 * members of its federation, under the federation's name.
 *
 * Open leads to the volume in the capture QC viewer
 * (`/admin/capture/qc/:volumeId`).
 *
 * @version@version v0.8.0
 */

import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronDown, ClipboardCheck } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { waitingDays } from "../lib/capture/screens";
import type { CaptureVolumeRow, ReviewerCandidates } from "../lib/capture/screens.server";
import { BADGE_SHAPE } from "../components/workflow/status-badge";
import { CaptureEmptyState, CapturePageHeader, DecisionBar } from "../components/capture/capture-parts";
import type { Route } from "./+types/_auth.admin.capture.qc";

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess, federationNameOf, loadCaptureQueue, loadReviewerCandidates } = await import(
    "~/lib/capture/screens.server"
  );
  const db = drizzle(context.cloudflare.env.DB);
  const access = await captureAccess(db, tenant, user);
  if (!access.manager && !access.reviewer) throw new Response(null, { status: 403 });
  const now = Date.now();
  const volumes = await loadCaptureQueue(db, tenant.id, user, access.manager, now);
  const candidates = access.manager ? await loadReviewerCandidates(db, tenant) : null;
  const federationName = candidates ? candidates.federationName : await federationNameOf(db, tenant);
  return { volumes, candidates, federationName: federationName ?? "", canAssign: access.manager, now };
}

export default function CaptureQcQueuePage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("capture");
  const { volumes, candidates, federationName, canAssign, now } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-2 py-6">
      <CapturePageHeader title={t("queue.title")} intro={t("queue.intro", { federation: federationName })} />

      {volumes.length === 0 ? (
        <CaptureEmptyState icon={ClipboardCheck} title={t("queue.empty_title")} body={t("volumes.empty_body")} />
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="w-full min-w-[960px] text-left font-sans text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
                  <th scope="col" className="px-4 py-3">{t("columns.reference_code")}</th>
                  <th scope="col" className="px-4 py-3">{t("columns.title")}</th>
                  <th scope="col" className="px-4 py-3">{t("columns.reviewer")}</th>
                  <th scope="col" className="w-[260px] px-4 py-3">{t("columns.progress")}</th>
                  <th scope="col" className="px-4 py-3">{t("columns.waiting")}</th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">{t("columns.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {volumes.map((v) => (
                  <QueueRow key={v.referenceCode} row={v} candidates={candidates} canAssign={canAssign} now={now} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 font-sans text-xs text-stone-600">
            <Legend swatch="bg-verdigris" label={t("queue.legend_approved")} />
            <Legend swatch="bg-madder" label={t("queue.legend_rejected")} />
            <Legend swatch="bg-stone-200" label={t("queue.legend_undecided")} />
          </div>
        </>
      )}
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${swatch}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function QueueRow({
  row,
  candidates,
  canAssign,
  now,
}: {
  row: CaptureVolumeRow;
  candidates: ReviewerCandidates | null;
  canAssign: boolean;
  now: number;
}) {
  const { t } = useTranslation("capture");
  return (
    <tr className="border-b border-stone-100 last:border-b-0">
      <td className="px-4 py-3 font-mono text-[13px] text-indigo">{row.referenceCode}</td>
      <td className="px-4 py-3 font-serif text-[15px] text-stone-700">{row.title}</td>
      <td className="px-4 py-3">
        {row.reviewer ? (
          <span className="text-stone-700">{row.reviewer.name}</span>
        ) : (
          <span className="italic text-stone-500">{t("queue.not_assigned")}</span>
        )}
      </td>
      <td className="px-4 py-3">
        {row.hasEarlierDelivery ? (
          <span className={`${BADGE_SHAPE} mb-1.5 bg-saffron-tint text-saffron-deep`}>{t("queue.retakes_received")}</span>
        ) : null}
        <DecisionBar approved={row.approved} rejected={row.rejected} total={row.openings} />
        <p className="mt-1 text-xs text-stone-600">
          {row.reviewAgain !== null
            ? t("queue.review_again", { count: row.reviewAgain })
            : t("queue.decided", { decided: row.decided, total: row.openings })}
        </p>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-stone-700">
        {t("queue.waiting_days", { count: waitingDays(row.handedOverAt, now) })}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-3">
          {canAssign && candidates && row.volumeId ? (
            <AssignControl volumeId={row.volumeId} current={row.reviewer?.id ?? null} candidates={candidates} />
          ) : null}
          {row.volumeId ? (
            <Link
              to={`/admin/capture/qc/${row.volumeId}`}
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("queue.open")}
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function AssignControl({
  volumeId,
  current,
  candidates,
}: {
  volumeId: string;
  current: string | null;
  candidates: ReviewerCandidates;
}) {
  const { t } = useTranslation("capture");
  const { t: tc } = useTranslation("common");
  const fetcher = useFetcher<{ reviewerId?: string | null; error?: string }>();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(current ?? "");
  const busy = fetcher.state !== "idle";
  const failed = fetcher.state === "idle" && fetcher.data !== undefined && fetcher.data.error !== undefined;
  const selectId = `reviewer-${volumeId}`;

  const failure = failed ? <p className="text-xs text-madder-deep">{t("queue.assign_failed")}</p> : null;

  if (!open) {
    const opener = current ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[13px] font-semibold text-stone-600 hover:text-indigo hover:underline"
      >
        {t("queue.reassign")}
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-indigo hover:bg-stone-50"
      >
        {t("queue.assign")}
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
    );
    return (
      <div className="flex flex-col items-end gap-1">
        {opener}
        {failure}
      </div>
    );
  }

  const submit = () => {
    if (!choice) return;
    fetcher.submit(
      { reviewerId: choice },
      { method: "post", action: `/admin/capture/volumes/${volumeId}/reviewer`, encType: "application/json" },
    );
    setOpen(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="sr-only">
          {t("queue.reviewer_label")}
        </label>
        <select
          id={selectId}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="w-[220px] rounded-md border border-stone-200 bg-white px-3 py-2 text-sm focus:border-indigo focus:ring-1 focus:ring-indigo"
        >
          <option value="">{t("queue.choose_reviewer")}</option>
          {candidates.staff.length > 0 ? (
            <optgroup label={t("queue.group_staff")}>
              {candidates.staff.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {candidates.federation.length > 0 && candidates.federationName ? (
            <optgroup label={candidates.federationName}>
              {candidates.federation.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button
          type="button"
          onClick={submit}
          disabled={!choice || busy}
          className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("queue.assign")}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[13px] font-semibold text-stone-600 hover:text-indigo hover:underline"
        >
          {tc("button.cancel")}
        </button>
      </div>
      {failure}
    </div>
  );
}

// @version@version v0.8.0
