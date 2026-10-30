/**
 * React Router framework configuration
 *
 * React Router is the framework that decides which screen a URL maps to
 * and fetches the data that screen needs. This file sets the handful of
 * options that apply to the whole application.
 *
 * `ssr: true` turns on server-side rendering: pages are assembled on
 * Cloudflare's edge and arrive as finished HTML rather than as an empty
 * shell the browser has to fill in. That matters for a cataloguing tool
 * whose users are often on slow connections in reading rooms, and it is
 * what lets a description page be readable and linkable without
 * JavaScript.
 *
 * The two `future` flags opt in ahead of time to behaviour that becomes
 * standard in React Router v8 — the newer Vite environment API, and
 * middleware running as a request pipeline. Adopting them early keeps the
 * eventual upgrade small.
 *
 * `allowedActionOrigins` is the list of other origins React Router would
 * accept a form submission from. It is empty on purpose: every action
 * is posted from a page of the host it runs on. React Router compares
 * the `Origin` against the `X-Forwarded-Host` header when one is sent,
 * and has no setting to stop that, so the Worker's own check in
 * `workers/app.ts` is the one that holds.
 *
 * @version v0.8.0
 */

import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  allowedActionOrigins: [],
  future: {
    v8_viteEnvironmentApi: true,
    v8_middleware: true,
  },
} satisfies Config;

// @version v0.8.0
