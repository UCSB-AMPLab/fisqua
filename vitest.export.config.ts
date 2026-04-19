/**
 * Vitest Configuration — Node Pool for Export Formatter Tests
 *
 * The publish pipeline serialises archival descriptions into JSON payloads
 * that the static frontend consumes. Those export formatters are pure
 * TypeScript — no D1, no R2, no Worker runtime — and testing them under
 * the Workers pool would add cold-start latency for no benefit. This
 * config runs the export-suite under the standard Node pool for speed.
 *
 * Keep this config narrow — only `tests/export/**` should be included.
 * Anything that touches Worker bindings belongs with `vitest.config.ts`.
 *
 * @version v0.3.0
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/export/**/*.test.ts"],
  },
});
