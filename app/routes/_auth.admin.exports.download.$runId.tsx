/**
 * Exports — the artifact, handed over
 *
 * This loader streams one completed export out of R2 with a
 * content-disposition, and it is the only way an artifact leaves the
 * platform. It is deliberately thin: everything it could get wrong is
 * a question of who may have this file, so all of its length is spent
 * on that.
 *
 * THREE GATES, AND THEY ALL ANSWER 404. The run must belong to this
 * workspace (`getExportRun` is tenant-scoped, so another tenant's run
 * id is indistinguishable from one that never existed). The format
 * must be one this person's role may take — the tier is re-applied
 * here rather than trusted from the page, because a URL can be typed
 * and a machine-readable artifact is exactly what the tier is about.
 * And the object must still exist: a run swept past its thirty days
 * keeps its row and loses its `r2_key`, and a row with no key has
 * nothing to stream.
 *
 * Answering 404 to all three is the point. A 403 on the tier would
 * tell a reader that the CSV exists and is being withheld, which is
 * precisely the evidence the absence rule keeps off the page.
 *
 * A PDF RUN IS NOT A DOWNLOAD. The finding aid is stored rendered
 * HTML, opened in a tab rather than saved, so this route redirects
 * such a run to the aid route rather than pushing an attachment
 * header at a document meant to be read.
 *
 * @version v0.7.0
 */
import { redirect } from "react-router";
import { tenantContext, userContext } from "../context";
import type { Route } from "./+types/_auth.admin.exports.download.$runId";

export async function loader({ context, params }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { getExportRun } = await import("~/lib/export/run.server");
  const { formatRequiresAdmin } = await import("~/lib/export/matrix");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const run = await getExportRun(db, tenant, params.runId);
  if (!run || run.status !== "completed" || run.format === null) {
    throw new Response(null, { status: 404 });
  }

  // The rendered finding aid is read, not saved.
  if (run.format === "pdf") {
    return redirect(`/admin/exports/aid/${run.id}`);
  }

  if (formatRequiresAdmin(run.format) && !user.isAdmin) {
    throw new Response(null, { status: 404 });
  }

  if (run.r2Key === null) throw new Response(null, { status: 404 });

  const object = await env.BUCKET.get(run.r2Key);
  if (!object) throw new Response(null, { status: 404 });

  const contentType =
    run.format === "csv"
      ? "text/csv; charset=utf-8"
      : run.format === "json"
        ? "application/json; charset=utf-8"
        : "application/xml; charset=utf-8";
  // The stored name is built from the scope's own words and is already
  // slugified, so it carries no quote to break the header.
  const fileName = run.fileName ?? `export-${run.id}`;

  return new Response(object.body as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "private, no-store",
    },
  });
}
