/**
 * Digitization — Retakes
 *
 * This page lists the openings rejected in capture QC and not yet
 * approved again, one card per volume, with a table of its rejected
 * openings: the opening, the page keys of its images, the reason (with
 * its gloss on hover) and, for an opening with two images, the image to
 * retake, the note, who asked for the retake and when, how
 * long it has been outstanding, and where the retake stands. A legend
 * above the cards names the three states of a retake's way through, in
 * order: requested, until the unit fetches the decisions that carry the
 * rejection; sent to the scanner, once it has; replaced, once a new
 * delivery has brought the opening back with new images and it waits to
 * be reviewed again; and, apart, missing, for an opening rejected
 * earlier that the new delivery does not bring (`retakes.ts`). A card's header says how many of the current
 * delivery's openings are still undecided, and when the unit last
 * received a rejection of the volume.
 *
 * The tenant must have the digitization capability (a bare 404
 * otherwise). The tenant's digitization admins and its federation's stewards see
 * every volume; a user assigned to review one of the tenant's volumes
 * sees only their own; anyone else gets a bare 403.
 *
 * "Open in viewer" opens a volume still under review in the capture QC
 * viewer.
 *
 * @version@version v0.8.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, Repeat } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { RETAKE_FLOW, type RetakeState } from "../lib/capture/retakes";
import type { RetakeVolume } from "../lib/capture/retakes.server";
import { useFormatters } from "../lib/use-formatters";
import { BADGE_SHAPE } from "../components/workflow/status-badge";
import { CaptureEmptyState, CapturePageHeader } from "../components/capture/capture-parts";
import type { Route } from "./+types/_auth.admin.capture.retakes";

export async function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { captureAccess } = await import("~/lib/capture/screens.server");
  const { loadRetakes } = await import("~/lib/capture/retakes.server");
  const db = drizzle(context.cloudflare.env.DB);
  const access = await captureAccess(db, tenant, user);
  if (!access.manager && !access.reviewer) throw new Response(null, { status: 403 });
  return { volumes: await loadRetakes(db, tenant.id, user, access.manager, Date.now()) };
}

/** The state chips' colour pairs: sent back, partial progress, waiting, and gone missing. */
const STATE_STYLES: Record<RetakeState, string> = {
  requested: "bg-madder-tint text-madder-deep",
  sent: "bg-saffron-tint text-saffron-deep",
  replaced: "bg-stone-100 text-stone-600",
  missing: "bg-madder-tint text-madder-deep",
};

export default function RetakesPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("capture");
  const { volumes } = loaderData;

  return (
    <div className="mx-auto max-w-6xl px-2 py-6">
      <CapturePageHeader title={t("retakes.title")} intro={t("retakes.intro")} />

      {volumes.length === 0 ? (
        <CaptureEmptyState icon={Repeat} title={t("retakes.empty_title")} body={t("retakes.empty_body")} />
      ) : (
        <>
          <ol aria-label={t("retakes.legend_label")} className="mt-5 flex flex-wrap items-center gap-2 font-sans">
            {RETAKE_FLOW.map((state, i) => (
              <li key={state} className="flex items-center gap-2">
                {i > 0 ? <ArrowRight className="h-4 w-4 text-stone-400" aria-hidden="true" /> : null}
                <RetakeStateBadge state={state} />
              </li>
            ))}
            <li className="ml-3">
              <RetakeStateBadge state="missing" />
            </li>
          </ol>
          {volumes.map((v) => (
            <VolumeCard key={v.volumeId} volume={v} />
          ))}
        </>
      )}
    </div>
  );
}

function RetakeStateBadge({ state }: { state: RetakeState }) {
  const { t } = useTranslation("capture");
  return <span className={`${BADGE_SHAPE} ${STATE_STYLES[state]}`}>{t(`retakes.state_${state}`)}</span>;
}

function VolumeCard({ volume }: { volume: RetakeVolume }) {
  const { t } = useTranslation("capture");
  const { formatDate, formatDateTime } = useFormatters();
  const headingId = `retakes-${volume.volumeId}`;

  return (
    <section aria-labelledby={headingId} className="mt-6 overflow-hidden rounded-lg border border-stone-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 px-5 py-4">
        <div>
          <h2 id={headingId} className="font-mono text-sm text-indigo">
            {volume.referenceCode}
          </h2>
          <p className="mt-1 font-serif text-[15px] text-stone-700">
            {volume.title ? `${volume.title} · ` : null}
            {t("retakes.to_retake", { count: volume.rows.length })}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 font-sans text-[13px] text-stone-600">
          {volume.sentAt !== null ? (
            <span>{t("retakes.sent_to_scanner", { date: formatDateTime(volume.sentAt) })}</span>
          ) : null}
          {volume.undecided > 0 ? (
            <>
              <span>{t("retakes.review_in_progress", { count: volume.undecided })}</span>
              <Link
                to={`/admin/capture/qc/${volume.volumeId}`}
                className="rounded-md border border-stone-200 bg-white px-4 py-2 text-sm font-semibold text-indigo hover:bg-stone-50"
              >
                {t("retakes.open_in_viewer")}
              </Link>
            </>
          ) : null}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-left font-sans text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-xs font-semibold text-stone-600">
              <th scope="col" className="px-4 py-3">{t("columns.opening")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.page_keys")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.reason")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.note")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.asked_by")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.asked")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.outstanding")}</th>
              <th scope="col" className="px-4 py-3">{t("columns.state")}</th>
            </tr>
          </thead>
          <tbody>
            {volume.rows.map((r) => (
              <tr key={r.captuaRecordId} className="border-b border-stone-100 align-top last:border-b-0">
                <th scope="row" className="whitespace-nowrap px-4 py-3 text-left font-semibold text-stone-700">
                  {t("retakes.opening", { sequence: r.sequence })}
                </th>
                <td className="px-4 py-3 font-mono text-xs text-indigo-soft">
                  {r.pageKeys.map((k) => (
                    <span key={k} className="block">
                      {k}
                    </span>
                  ))}
                </td>
                <td className="px-4 py-3 font-semibold text-madder-deep">
                  {r.reason ? <span title={t(`reason_gloss.${r.reason}`)}>{t(`reason.${r.reason}`)}</span> : null}
                  {r.reason && r.side ? " · " : null}
                  {r.side ? <span className="font-normal">{t(`side.${r.side}`)}</span> : null}
                </td>
                <td className="max-w-[24ch] px-4 py-3 text-stone-600">{r.note}</td>
                <td className="px-4 py-3 text-stone-700">{r.askedBy}</td>
                <td className="whitespace-nowrap px-4 py-3 text-stone-700">{formatDate(r.askedAt)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-stone-700">
                  {t("queue.waiting_days", { count: r.outstandingDays })}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <RetakeStateBadge state={r.state} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// @version@version v0.8.0
