/**
 * Tests — the spec bucket binding and the bucket its URLs are signed for
 *
 * This suite checks the spec bucket binding against the bucket its URLs
 * are signed for. Fisqua writes a run's spec, and the copies a
 * publication keeps, through the `SPEC_BUCKET` R2 binding, while the
 * runner fetches the spec from a presigned URL whose path names
 * `PIPELINE_SPEC_BUCKET`. A binding exposes no bucket name at run time,
 * so the Worker cannot check that the two agree; this suite checks it in
 * `wrangler.jsonc` instead. In every environment the binding's
 * `bucket_name` must equal that environment's `PIPELINE_SPEC_BUCKET`, or
 * a run would be dispatched with a URL for an object that was written
 * somewhere else. Production keeps the spec in `fisqua-bucket`, as it
 * did before the binding existed, and staging in
 * `fisqua-pipeline-specs-staging`.
 *
 * The file is JSON with comments, so it is read with TypeScript's
 * config-file parser, which accepts comments and trailing commas.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface R2Binding { binding: string; bucket_name: string }
interface EnvConfig { vars?: Record<string, string>; r2_buckets?: R2Binding[] }
interface WranglerConfig extends EnvConfig { env?: Record<string, EnvConfig> }

const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
if (parsed.error) throw new Error(`wrangler.jsonc did not parse: ${String(parsed.error.messageText)}`);
const config = parsed.config as WranglerConfig;

const environments: Array<[string, EnvConfig]> = [
  ["production", config],
  ...Object.entries(config.env ?? {}),
];

function specBinding(envConfig: EnvConfig): string | undefined {
  return envConfig.r2_buckets?.find((b) => b.binding === "SPEC_BUCKET")?.bucket_name;
}

describe("SPEC_BUCKET in wrangler.jsonc", () => {
  it.each(environments)("%s binds it to the bucket its spec URLs are signed for", (_name, envConfig) => {
    const bound = specBinding(envConfig);
    expect(bound).toBeDefined();
    expect(bound).toBe(envConfig.vars?.PIPELINE_SPEC_BUCKET);
  });

  it("keeps production on fisqua-bucket and staging on its own bucket", () => {
    expect(specBinding(config)).toBe("fisqua-bucket");
    expect(specBinding(config.env!.staging)).toBe("fisqua-pipeline-specs-staging");
  });
});
