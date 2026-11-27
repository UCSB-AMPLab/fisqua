/**
 * Manifest Attribution Refresh API
 *
 * This API endpoint is the superadmin-only way to start and follow a
 * refresh of one federation's published manifests: the run rewrites the
 * `requiredStatement`, `provider` and `rights` of each manifest from the
 * rows Fisqua holds now (`ManifestRefreshWorkflow`,
 * `app/workflows/manifest-refresh.ts`). It has no page.
 *
 * `POST /api/manifest-refresh` takes the JSON body
 * `{ "federation": "<id or slug>", "mode": "dry_run" | "apply",
 * "limit": <1..1500>, "repository": "<code>",
 * "after": { "reference_code": "<code>", "id": "<description id>" } }`;
 * `mode` is `dry_run` when left out, `limit` is required in both modes
 * (`REFRESH_MAX_LIMIT`, which keeps one instance within its
 * subrequests), `repository` and `after` are optional, and no other key
 * is accepted. `limit` takes the first descriptions by reference code
 * and id, after `after` when it is given; the report's `next_after` is
 * the `after` of the next instance. `repository` must be the code of
 * one of the federation's repositories (404 `repository_not_found`).
 * An apply takes the federation's lock before it starts: while another
 * apply of the federation runs, it answers 409 `refresh_in_progress`
 * with that instance's id. A released lock is taken, and so is one whose
 * instance the Workflows binding reports as `complete`, `errored` or
 * `terminated`. A lock whose instance the binding does not know, or
 * whose status cannot be read, is not taken over: the route answers 409
 * `refresh_lock_unverified` with the holder's id. The route never
 * releases the lock, not even when the instance cannot be created: a
 * failed create may still have made the instance. A lock left by a
 * create that failed is cleared by hand, by a superadmin, by deleting
 * the lock object from `BUCKET`. Each batch of the run checks that it
 * holds the lock before it reads or writes anything. A dry run takes no
 * lock. The
 * federation must exist (404 `federation_not_found`) and have a complete
 * manifest destination: its manifest endpoint, bucket and address, a
 * secret prefix, and the two manifest write secrets the prefix names
 * (409 `manifest_destination_unset`, listing the columns and secret
 * suffixes that are missing and never a value). The route then starts
 * one workflow instance with the federation's id, the mode and the
 * requesting user's id, and answers 202 with the instance id, the
 * federation, the mode, and the key the report will be written at in
 * `BUCKET`.
 *
 * `GET /api/manifest-refresh?instance=<id>` answers the instance's
 * status, its error and its output (the report key and the counts once
 * it is complete); with `&report=1` it answers the stored report itself,
 * found by the output's key or, for a run that failed and so has no
 * output, by its instance id under `reports/manifest-refresh/`, or 404
 * while there is none. An unknown instance is a 404.
 *
 * The request side of the Worker (`workers/app.ts`) refuses a
 * state-changing request that carries the session cookie from another
 * origin before it reaches this route, as for every route; the route
 * itself requires a superadmin, as `api.publish` does. Any superadmin
 * may name any federation.
 *
 * @version v0.9.0
 */

import { z } from "zod";
import { userContext } from "../context";
import { requireSuperAdmin } from "../lib/superadmin.server";
import {
  REFRESH_MAX_LIMIT,
  claimRefreshLock,
} from "../lib/pipeline/manifest-refresh-run.server";

/** Workflow instance states in which an instance may still write. */
const RUNNING = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
/** States from which an instance never writes again; only these let a lock be taken over. */
const TERMINAL = new Set(["complete", "errored", "terminated"]);
import type { Route } from "./+types/api.manifest-refresh";

const bodySchema = z
  .object({
    federation: z.string().min(1),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    limit: z.number().int().min(1).max(REFRESH_MAX_LIMIT),
    repository: z.string().min(1).optional(),
    after: z.object({ reference_code: z.string().min(1), id: z.string().min(1) }).strict().optional(),
  })
  .strict();

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const user = context.get(userContext);
  requireSuperAdmin(user);

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", detail: "malformed_json" }, { status: 400 });
  }
  const body = bodySchema.safeParse(parsed);
  if (!body.success) {
    return Response.json(
      {
        error: "invalid_request",
        detail: [...new Set(body.error.issues.map((i) => i.path.join(".") || "(body)"))].join(", "),
      },
      { status: 400 },
    );
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { federationHasRepository, findFederation, manifestWriteMissing, refreshReportKey } = await import(
    "../lib/pipeline/manifest-refresh-run.server"
  );
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const federation = await findFederation(db, body.data.federation);
  if (federation === null) {
    return Response.json({ error: "federation_not_found" }, { status: 404 });
  }
  const missing = manifestWriteMissing(federation, env);
  if (missing.length > 0) {
    return Response.json({ error: "manifest_destination_unset", missing }, { status: 409 });
  }
  const { limit, repository, after } = body.data;
  if (repository !== undefined && !(await federationHasRepository(db, federation.id, repository))) {
    return Response.json({ error: "repository_not_found" }, { status: 404 });
  }

  const instanceId = crypto.randomUUID();
  const apply = body.data.mode === "apply";
  if (apply) {
    const lock = await claimRefreshLock(env.BUCKET, federation.slug, instanceId, async (id) => {
      try {
        const { status } = await (await env.MANIFEST_REFRESH.get(id)).status();
        if (TERMINAL.has(status)) return "terminal";
        return RUNNING.has(status) ? "running" : "unverified";
      } catch {
        // An instance the binding cannot answer for may still be running.
        return "unverified";
      }
    });
    if (!lock.claimed) {
      const error = lock.reason === "unverified" ? "refresh_lock_unverified" : "refresh_in_progress";
      return Response.json({ error, instance_id: lock.holder }, { status: 409 });
    }
  }
  // A create that fails leaves the lock held: whether an instance was made
  // cannot be told from a failed answer, so only the workflow releases it.
  await env.MANIFEST_REFRESH.create({
    id: instanceId,
    params: {
      federationId: federation.id,
      federationSlug: federation.slug,
      mode: body.data.mode,
      requestedBy: user.id,
      limit,
      ...(repository !== undefined ? { repository } : {}),
      ...(after !== undefined ? { after } : {}),
    },
  });
  return Response.json(
    {
      instance_id: instanceId,
      federation: { id: federation.id, slug: federation.slug },
      mode: body.data.mode,
      report_key: refreshReportKey(federation.slug, instanceId),
    },
    { status: 202 },
  );
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  requireSuperAdmin(user);
  const url = new URL(request.url);
  const instanceId = url.searchParams.get("instance");
  if (!instanceId) {
    return Response.json({ error: "invalid_request", detail: "instance" }, { status: 400 });
  }
  const env = context.cloudflare.env;
  let status: Awaited<ReturnType<WorkflowInstance["status"]>>;
  try {
    status = await (await env.MANIFEST_REFRESH.get(instanceId)).status();
  } catch {
    return Response.json({ error: "instance_not_found" }, { status: 404 });
  }
  const output = (status.output ?? null) as { report_key?: unknown } | null;

  if (url.searchParams.get("report") === "1") {
    let key = output !== null && typeof output.report_key === "string" ? output.report_key : null;
    if (key === null) {
      // A run that failed has no output; its report sits under its federation's slug.
      const { REFRESH_REPORT_PREFIX } = await import("../lib/pipeline/manifest-refresh-run.server");
      const listed = await env.BUCKET.list({ prefix: REFRESH_REPORT_PREFIX });
      key = listed.objects.map((o) => o.key).find((k) => k.endsWith(`/${instanceId}.json`)) ?? null;
    }
    const stored = key === null ? null : await env.BUCKET.get(key);
    if (stored === null) return Response.json({ error: "report_not_found" }, { status: 404 });
    return new Response(stored.body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  return Response.json({
    instance_id: instanceId,
    status: status.status,
    error: status.error ?? null,
    output,
  });
}

// @version v0.9.0
