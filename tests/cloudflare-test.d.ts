/**
 * cloudflare:test ambient declaration
 *
 * Augments the `ProvidedEnv` interface that
 * `@cloudflare/vitest-pool-workers` exposes from `cloudflare:test` so
 * that `env.DB`, `env.BUCKET`, and the rest of our worker bindings are
 * typed inside test files. Without this, every `env.DB` access in a
 * test produces a `Property 'DB' does not exist on type 'ProvidedEnv'`
 * error even though the binding works at runtime via the miniflare
 * config in `vitest.config.ts`.
 *
 * @version v0.3.1
 */

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

export {};
