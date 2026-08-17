/**
 * Exports — open the finding aid
 *
 * This route deals with handing back the finding aid a completed run
 * already produced. It NEVER renders one: the artifact stored in R2 is
 * the run's snapshot, and the whole promise of the colophon — "the
 * catalogue continues to change; later descriptions will not appear
 * here" — depends on a second opening returning the same bytes as the
 * first. Re-rendering on demand would quietly turn a dated document
 * into a live view of a moving catalogue.
 *
 * ANY MEMBER MAY OPEN IT (ruling 2 as re-ruled, 2026-08-15). The finding
 * aid is the rendered, descriptive-fields-only artifact every member can
 * take; only the machine-readable formats are admin-only, and those go
 * out through the download route rather than this one. So the gate here
 * is the `_auth` shell's own authentication and nothing more — and the
 * format check below is what keeps this route from becoming a hole in
 * that tier, since a CSV served inline as HTML would be exactly the
 * bulk-data path the tier exists to close.
 *
 * FOUR WAYS TO GET NOTHING, AND THEY LOOK THE SAME. Another workspace's
 * run, a run that never existed, a run whose format is not the finding
 * aid, and a run whose artifact the thirty-day sweep has taken all
 * answer 404 with no body. `getExportRun` filters on the request tenant
 * in the same statement it filters on the id, so cross-tenant probing
 * cannot distinguish a wrong id from someone else's.
 *
 * The response is served with a strict Content-Security-Policy. The
 * document carries no script of its own — the renderer emits none, and
 * every value it interpolates is escaped — so `script-src 'none'` costs
 * the artifact nothing and turns "we escape carefully" into something
 * the browser enforces.
 *
 * @version v0.7.0
 */

import { tenantContext, userContext } from "../context";
import type { Route } from "./+types/_auth.admin.exports.aid.$runId";

/**
 * The Content-Security-Policy the stored artifact is served under. The
 * font stylesheet and its font files are the document's only external
 * requests; everything else is denied outright.
 */
const ARTIFACT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'none'",
  "script-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join("; ");

export async function loader({ context, params }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { getExportRun } = await import("~/lib/export/run.server");

  // Reading the user is the membership check: `_auth`'s middleware has
  // already refused anyone who is not signed in to this workspace, and
  // no further role is required for the finding aid.
  context.get(userContext);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const run = await getExportRun(db, tenant, params.runId);
  if (!run) throw new Response(null, { status: 404 });
  if (run.format !== "pdf") throw new Response(null, { status: 404 });
  if (run.status !== "completed" || !run.r2Key) {
    throw new Response(null, { status: 404 });
  }

  const object = await env.BUCKET.get(run.r2Key);
  if (!object) throw new Response(null, { status: 404 });

  const fileName = run.fileName ?? `finding-aid-${run.id}.html`;

  return new Response(object.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Inline: the point of this route is a new tab the reader can
      // print from, not a file on a desktop.
      "content-disposition": `inline; filename="${fileName.replace(/["\\]/g, "")}"`,
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
      // A snapshot never changes, but it can be swept, so the browser
      // is told to keep it only for the length of a reading session.
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}
