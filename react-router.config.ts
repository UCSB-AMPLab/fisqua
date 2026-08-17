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
 * @version v0.2.0
 */

import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
    v8_middleware: true,
  },
} satisfies Config;
