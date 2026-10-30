/**
 * Digitization — Capture QC Viewer
 *
 * This page is the capture QC viewer for one volume, at
 * `/admin/capture/qc/:volumeId`: the openings of the volume's current
 * Captua handover, laid out for review, where a reviewer approves each
 * one or rejects it for retake and corrects the rotation of its images.
 * The queue's Open, the Volumes screen's Continue review and the
 * Retakes screen's Open in viewer lead here.
 *
 * The tenant must have the digitization capability (a bare 404
 * otherwise). The loader reads the volume through
 * `loadCaptureQcVolume`, which answers a bare 404 for a volume that is
 * not the tenant's or has no current delivery, and a bare 403 unless
 * the user is one of the tenant's digitization admins, a steward of its federation,
 * or the volume's assigned reviewer. The page has no action: the viewer
 * posts its decisions to the decisions route as JSON
 * (`useDecisionQueue`).
 *
 * The page's search parameters (`opening`, `view`, `show`) change as
 * the reviewer works, and none of them changes what the loader reads,
 * so a change of search parameters alone does not reload it
 * (`shouldRevalidate`); the viewer's own revalidation, when another
 * write has moved the decision set on, does. The auth layout gives the viewer the full
 * height of the window and the sidebar's narrow rail, as it does the
 * segmentation viewer.
 *
 * @version@version v0.8.0
 */

import type { ShouldRevalidateFunctionArgs } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { CaptureQcViewer } from "../components/capture/viewer/capture-qc-viewer";
import type { Route } from "./+types/_auth.admin.capture.qc.$volumeId";

export async function loader({ context, params }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "digitization");
  const user = context.get(userContext);
  const { drizzle } = await import("drizzle-orm/d1");
  const { loadCaptureQcVolume } = await import("~/lib/capture/viewer.server");
  return loadCaptureQcVolume(drizzle(context.cloudflare.env.DB), tenant, user, params.volumeId, Date.now());
}

export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // Only the search parameters changed; a revalidation of the same
  // address (after another write moved the decision set on) still runs.
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
}

export default function CaptureQcViewerPage({ loaderData }: Route.ComponentProps) {
  return <CaptureQcViewer key={loaderData.delivery.manifestId} data={loaderData} />;
}

// @version@version v0.8.0
