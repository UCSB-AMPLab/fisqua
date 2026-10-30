/**
 * Worker Entry Point
 *
 * This is the first piece of code that runs when a request hits the Fisqua
 * app on Cloudflare's edge. Every request — page load, API call, form
 * submission — enters here and gets forwarded to React Router, which then
 * routes it to the right loader, action, or server module.
 *
 * The Worker has two entry points, not one. `fetch` is the request side
 * described above. `scheduled` is the clock side: Cloudflare invokes it on
 * the cron declared in `wrangler.jsonc` (every fifteen minutes) with no
 * request, no session, and no tenant, and it runs three steps in turn:
 * the media pipeline sweep, the review run sweep and the notification
 * sweep. The media pipeline sweep goes first and always runs: it closes runs
 * whose callback token has expired, finishes review-flag ingests a
 * request could not complete, and finishes or fails publications that
 * stalled, checking each against its own tenant's manifest bucket. It runs
 * in its own `try`, so a failure
 * there is logged and the steps after it still run. The review run
 * sweep follows in a `try` of its own: in production it starts the review
 * run of each registered capture delivery that has none, such as one
 * registered from a file (`startPendingReviewRuns`), within a fixed
 * number of attempts per tick. The notification sweep comes last and
 * turns pending outbox rows into one digest
 * email per due recipient, and is skipped where no mail credential is
 * set. Everything the sweeps need that would normally come off a
 * request (the app identity, the host suffix tenant subdomains hang off,
 * a mail transport, the media object reader) is assembled here from
 * `env` and handed in, so the sweeps themselves stay free of Worker
 * plumbing.
 *
 * Before any of that, the request side refuses two kinds of request with
 * a bare 403 (`app/lib/same-origin.server.ts`). The first is a
 * state-changing request that carries the session cookie but did not
 * come from the request's own origin, which covers every route,
 * including the resource routes React Router's own Origin check skips.
 * The second, kept apart because it needs no cookie, is a cross-origin
 * submission to `/login`, whose action sends a magic-link email. Token
 * callers (the pipeline runner, the Captua scanner) send no cookie and
 * pass.
 *
 * The request handler does two jobs. First, it wraps the Cloudflare context
 * (the `env` bindings declared in `wrangler.jsonc` and the runtime
 * `ExecutionContext`) into React Router's typed `RouterContextProvider` so
 * loaders and actions can read `context.get(cloudflareContext).env.DB` to
 * reach D1, or `.MANIFESTS_BUCKET` to reach R2. Second, it re-exports the
 * `PublishExportWorkflow` class so Cloudflare's Workflows runtime can find
 * and instantiate it when a publish job is kicked off from the admin UI.
 *
 * The `virtual:react-router/server-build` import is a build-time virtual
 * module produced by the React Router Vite plugin — it contains the compiled
 * server build for the app and is resolved during the bundle step, not at
 * runtime.
 *
 * @version v0.8.0
 */

import { createRequestHandler, RouterContextProvider } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { Resend } from "resend";
import { getAppConfig } from "../app/lib/config.server";
import { runNotificationSweep } from "../app/lib/notification-sweep.server";
import { runPipelineSweep } from "../app/lib/pipeline/sweep.server";
import { getMediaObjectReader } from "../app/lib/pipeline/store.server";
import { canonicalStoreForTenant } from "../app/lib/pipeline/publish.server";
import { reviewRunDepsFor, startPendingReviewRuns } from "../app/lib/capture/review-run.server";
import {
  isCrossOriginLoginPost,
  isCrossOriginSessionWrite,
} from "../app/lib/same-origin.server";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
  interface RouterContextProvider {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

// Re-export the workflow classes so the wrangler `workflows` bindings
// (PUBLISH_EXPORT / IMPORT_COMMIT) can resolve them by class_name.
export { PublishExportWorkflow } from "../app/workflows/publish-export";
export { ImportCommitWorkflow } from "../app/workflows/import-commit";
export { ImportRevertWorkflow } from "../app/workflows/import-revert";

// The public documentation site is a separate Jekyll build hosted on GitHub
// Pages. It is surfaced under fisqua.org/docs (English) and /guia (Spanish) by
// proxying a small set of path prefixes straight to that origin, so readers
// never leave the main domain. These paths are public and bypass the app
// entirely — they never reach React Router, auth, or the tenant layer.
// `/docs-assets` holds the guide's images and logo (kept off `/assets` so it
// doesn't collide with the app's own bundle); `/pagefind` holds the search index.
const DOCS_ORIGIN = "https://ucsb-amplab.github.io/fisqua-docs";
const DOCS_PREFIXES = ["/docs", "/guia", "/docs-assets", "/pagefind"];

function isDocsRequest(pathname: string): boolean {
  return DOCS_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

async function serveDocs(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const upstream = await fetch(DOCS_ORIGIN + url.pathname + url.search, {
    method: request.method,
    redirect: "follow",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// A refusal says nothing about why, and no cache may keep it.
function forbidden(): Response {
  return new Response(null, {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    // A state-changing request that carries the session cookie must come
    // from this request's own origin, whatever the route.
    if (isCrossOriginSessionWrite(request)) return forbidden();
    // The login form sends email for someone not yet signed in, so it has
    // no cookie for the rule above to see; it gets the same Origin
    // requirement by path, and no other cookieless route does.
    if (isCrossOriginLoginPost(request)) return forbidden();
    const { pathname } = new URL(request.url);
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      isDocsRequest(pathname)
    ) {
      return serveDocs(request);
    }
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env, ctx };
    return requestHandler(request, context);
  },

  async scheduled(controller, env, ctx) {
    // The pipeline sweep runs first and whatever the mail settings; a
    // failure is logged and does not stop the notification sweep. The
    // reader is built only when the sweep first reads through it.
    try {
      const counts = await runPipelineSweep({
        db: drizzle(env.DB),
        reader: { getText: (bucket, key) => getMediaObjectReader(env).getText(bucket, key) },
        now: Date.now(),
        workingBucket: env.PIPELINE_WORKING_BUCKET ?? "",
        canonicalFor: (tenantId) => canonicalStoreForTenant(env, tenantId),
      });
      console.log(
        `pipeline sweep: expired=${counts.expired} flags=${counts.flagsCompleted}/${counts.flagsAttempted} ` +
          `publications=${counts.publicationsResolved} resolved, ${counts.publicationsUnresolved} unresolved`,
      );
    } catch (err) {
      console.error(`pipeline sweep failed: ${err instanceof Error ? err.name : "error"}`);
    }

    // Review runs for deliveries that have none, in production only.
    try {
      const review = await startPendingReviewRuns(reviewRunDepsFor(env));
      console.log(`review run sweep: started=${review.started} declined=${review.declined}`);
    } catch (err) {
      console.error(`review run sweep failed: ${err instanceof Error ? err.name : "error"}`);
    }

    // No key, no mail. Local and preview deploys run without a Resend
    // credential; the sweep would then mark nothing and log a failure per
    // recipient on every tick, so it does not start at all.
    if (!env.RESEND_API_KEY) {
      console.warn("notification sweep skipped: RESEND_API_KEY unset");
      return;
    }
    const db = drizzle(env.DB);
    const appConfig = getAppConfig(env);
    const hostSuffix = env.PUBLIC_HOST_SUFFIX ?? ".fisqua.org";
    const resend = new Resend(env.RESEND_API_KEY);

    const counts = await runNotificationSweep(db, {
      now: Date.now(),
      hostSuffix,
      appConfig,
      sendEmail: async (to, subject, html) => {
        // Resend's SDK resolves with { data, error } instead of throwing
        // on API failures. The sweep's send-then-mark contract needs a
        // throw here, or a rejected send would be marked as delivered.
        const { error } = await resend.emails.send({
          from: `${appConfig.appName} <${appConfig.senderEmail}>`,
          to,
          subject,
          html,
        });
        if (error) {
          throw new Error(`resend ${error.name}: ${error.message}`);
        }
      },
    });
    console.log(
      `notification sweep: due=${counts.due} sent=${counts.sent} failed=${counts.failed}`,
    );
  },
} satisfies ExportedHandler<Env>;

// @version v0.8.0
