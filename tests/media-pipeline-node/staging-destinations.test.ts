/**
 * Tests — staging writes only to staging buckets
 *
 * This suite checks that no environment other than production names a
 * production bucket in `wrangler.jsonc`. Staging has its own D1
 * database, and every R2 binding it writes through must point at a
 * bucket of its own: `EXPORT_BUCKET` holds what the
 * Zasqua site builds from, `BUCKET` holds export artefacts and import
 * uploads (which the exports page sweeps by key), and `SPEC_BUCKET`
 * holds run specs. A binding exposes no bucket name at run time, so the
 * Worker cannot refuse a production bucket by itself; this suite checks
 * the configuration instead.
 *
 * The production bucket names are every `bucket_name` in the top-level
 * `r2_buckets` and every top-level variable whose name ends in
 * `_BUCKET`. For each other environment, no R2 binding may name one of
 * them, and no variable may contain one as a whole name (so
 * `zasqua-manifests-staging` does not match `zasqua-manifests`). Every
 * staging bucket also carries the `-staging` suffix. The allowlist
 * below names the variables that may still hold a production name and
 * why; an allowlisted variable that holds no production name, or is
 * absent, fails, so every entry has a variable it applies to.
 *
 * Bindings other than R2 are held to the same rule. No other environment
 * may refer to the production Worker by `script_name` or `service`
 * (a workflow, service binding or Durable Object bound that way runs in
 * the production Worker, against production's D1 and buckets), or reuse a
 * production resource: a D1 database id or name, a KV namespace id, a
 * queue, a Hyperdrive id or a workflow name. Each staging workflow is
 * hosted by the staging Worker, which `wrangler deploy` registers only
 * when the entry has no `script_name` or names the deploying Worker.
 *
 * The file is JSON with comments, so it is read with TypeScript's
 * config-file parser, which accepts comments and trailing commas.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface R2Binding { binding: string; bucket_name: string }
type Entry = Record<string, unknown>;
interface EnvConfig {
  name?: string;
  vars?: Record<string, string>;
  r2_buckets?: R2Binding[];
  workflows?: Entry[];
  [key: string]: unknown;
}
interface WranglerConfig extends EnvConfig { env?: Record<string, EnvConfig> }

const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
if (parsed.error) throw new Error(`wrangler.jsonc did not parse: ${String(parsed.error.messageText)}`);
const config = parsed.config as WranglerConfig;

/**
 * Variables that may name a production bucket outside production, keyed
 * by environment and variable, with the reason.
 */
const ALLOWED_PRODUCTION_NAMES: Record<string, Record<string, string>> = {
  staging: {
    // Nothing reads it: each federation's record names its tiles
    // bucket. It goes when Neogranadina's record is adopted in staging.
    PIPELINE_TILES_BUCKET: "unread; the federation record names the tiles bucket",
  },
};

const productionBuckets = new Set<string>([
  ...(config.r2_buckets ?? []).map((b) => b.bucket_name),
  ...Object.entries(config.vars ?? {})
    .filter(([key]) => key.endsWith("_BUCKET"))
    .map(([, value]) => value),
]);

const otherEnvironments = Object.entries(config.env ?? {});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The production bucket names that appear in `value` as whole names. */
function productionNamesIn(value: string): string[] {
  return [...productionBuckets].filter((name) =>
    new RegExp(`(^|[^a-z0-9-])${escapeRegExp(name)}($|[^a-z0-9-])`).test(value),
  );
}

/**
 * The resources an environment binds, as `kind:value` strings: D1 ids and
 * names, KV ids, queues, Hyperdrive ids and workflow names.
 */
function resourcesOf(envConfig: EnvConfig): Set<string> {
  const out = new Set<string>();
  const entries = (key: string): Entry[] => {
    const v = envConfig[key];
    return Array.isArray(v) ? (v as Entry[]) : [];
  };
  const add = (kind: string, value: unknown) => {
    if (typeof value === "string" && value !== "") out.add(`${kind}:${value}`);
  };
  for (const d of entries("d1_databases")) { add("d1", d.database_id); add("d1-name", d.database_name); }
  for (const k of entries("kv_namespaces")) add("kv", k.id);
  for (const h of entries("hyperdrive")) add("hyperdrive", h.id);
  for (const w of entries("workflows")) add("workflow", w.name);
  const queues = envConfig.queues as { producers?: Entry[]; consumers?: Entry[] } | undefined;
  for (const q of [...(queues?.producers ?? []), ...(queues?.consumers ?? [])]) add("queue", q.queue);
  return out;
}

/** Every `script_name` or `service` an environment's bindings name, with where. */
function workerReferencesOf(envConfig: EnvConfig): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  const visit = (value: unknown, where: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${where}[${i}]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if ((k === "script_name" || k === "service") && typeof v === "string") refs.push([`${where}.${k}`, v]);
        else visit(v, `${where}.${k}`);
      }
    }
  };
  for (const [key, value] of Object.entries(envConfig)) {
    if (key !== "vars" && key !== "env") visit(value, key);
  }
  return refs;
}

const productionWorker = config.name!;
const productionResources = resourcesOf(config);

describe("staging destinations in wrangler.jsonc", () => {
  it("finds the production buckets", () => {
    expect([...productionBuckets]).toEqual(
      expect.arrayContaining(["fisqua-bucket", "zasqua-export", "zasqua-manifests"]),
    );
  });

  it("has a staging environment to check", () => {
    expect(config.env?.staging).toBeDefined();
  });

  it.each(otherEnvironments)("%s binds no production bucket", (_name, envConfig) => {
    const shared = (envConfig.r2_buckets ?? [])
      .filter((b) => productionBuckets.has(b.bucket_name))
      .map((b) => `${b.binding} -> ${b.bucket_name}`);
    expect(shared).toEqual([]);
  });

  it.each(otherEnvironments)("%s names no production bucket in its variables", (name, envConfig) => {
    const allowed = ALLOWED_PRODUCTION_NAMES[name] ?? {};
    const offending = Object.entries(envConfig.vars ?? {})
      .filter(([key, value]) => !(key in allowed) && productionNamesIn(String(value)).length > 0)
      .map(([key, value]) => `${key} = ${value}`);
    expect(offending).toEqual([]);
  });

  it.each(Object.entries(ALLOWED_PRODUCTION_NAMES))(
    "%s allowlist names only variables that still hold a production name",
    (name, allowed) => {
      const vars = config.env?.[name]?.vars ?? {};
      const stale = Object.keys(allowed).filter(
        (key) => !(key in vars) || productionNamesIn(String(vars[key])).length === 0,
      );
      expect(stale).toEqual([]);
    },
  );

  it("gives every staging binding a bucket with the -staging suffix", () => {
    const unsuffixed = (config.env!.staging.r2_buckets ?? [])
      .filter((b) => !b.bucket_name.endsWith("-staging"))
      .map((b) => `${b.binding} -> ${b.bucket_name}`);
    expect(unsuffixed).toEqual([]);
  });

  it.each(otherEnvironments)("%s refers to no production Worker by script_name or service", (_name, envConfig) => {
    const refs = workerReferencesOf(envConfig)
      .filter(([, worker]) => worker === productionWorker)
      .map(([where, worker]) => `${where} = ${worker}`);
    expect(refs).toEqual([]);
  });

  it.each(otherEnvironments)("%s binds no production D1, KV, queue, Hyperdrive or workflow", (_name, envConfig) => {
    const shared = [...resourcesOf(envConfig)].filter((r) => productionResources.has(r));
    expect(shared).toEqual([]);
  });

  it("hosts every staging workflow in the staging Worker", () => {
    const staging = config.env!.staging;
    const stagingWorker = staging.name ?? `${productionWorker}-staging`;
    const hostedElsewhere = (staging.workflows ?? [])
      .filter((w) => w.script_name !== undefined && w.script_name !== stagingWorker)
      .map((w) => `${String(w.name)} -> ${String(w.script_name)}`);
    expect(staging.workflows?.length).toBeGreaterThan(0);
    expect(hostedElsewhere).toEqual([]);
  });

  it("pins the account at the top level, and no environment sets another", () => {
    expect(config.account_id).toBe("492ecadf9e992aecb0553ec14ebf90c7");
    for (const [name, env] of Object.entries(config.env ?? {})) {
      expect(env.account_id ?? config.account_id, name).toBe(config.account_id);
    }
  });

  it("binds staging's uploads and exports to their staging buckets", () => {
    const bound = Object.fromEntries(
      (config.env!.staging.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name]),
    );
    expect(bound.BUCKET).toBe("fisqua-bucket-staging");
    expect(bound.EXPORT_BUCKET).toBe("zasqua-export-staging");
  });
});
