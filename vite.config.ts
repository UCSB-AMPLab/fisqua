/**
 * Vite build configuration
 *
 * Vite is the build tool: in development it serves the app and reloads
 * changed files instantly, and for production it bundles everything into
 * the assets the Worker ships. This file lists the four plugins that turn
 * a plain Vite setup into this particular application's setup.
 *
 * `cloudflare` runs the server code in a local emulation of the
 * Cloudflare Workers runtime, so what we develop against behaves like
 * production — including the D1 database bindings. Naming its environment
 * `ssr` is what ties it to the server-rendered half of the app.
 * `tailwindcss` compiles the utility classes used throughout the
 * interface. `reactRouter` wires in the routing framework's own build
 * step. `tsconfigPaths` teaches Vite to resolve the `~/` import prefix
 * from `tsconfig.json`, so modules are imported by a stable path rather
 * than by counting `../` hops.
 *
 * Plugin order matters here — the Cloudflare plugin establishes the
 * runtime environment the React Router build then targets.
 *
 * @version v0.2.0
 */

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
