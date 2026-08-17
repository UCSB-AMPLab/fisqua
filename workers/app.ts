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
 * request, no session, and no tenant, and it runs the notification sweep —
 * the pass that turns pending outbox rows into one digest email per due
 * recipient. Everything the sweep needs that would normally come off a
 * request (the app identity, the host suffix tenant subdomains hang off,
 * a mail transport) is assembled here from `env` and handed in, so the
 * sweep itself stays free of Worker plumbing.
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
 * @version v0.7.0
 */

import { createRequestHandler, RouterContextProvider } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { Resend } from "resend";
import { getAppConfig } from "../app/lib/config.server";
import { runNotificationSweep } from "../app/lib/notification-sweep.server";

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

export default {
  async fetch(request, env, ctx) {
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
