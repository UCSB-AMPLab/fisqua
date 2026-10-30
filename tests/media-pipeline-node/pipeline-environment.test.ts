/**
 * Tests — each deployment's pipeline environment in wrangler.jsonc
 *
 * This suite checks each deployment's pipeline environment in
 * `wrangler.jsonc`. Staging and production dispatch to the same runner
 * repository, and a tenant seeded by a migration has the same id in
 * both, so a spec names the runner's key store for the deployment it
 * came from: `fisqua-pipeline-{tenantId}` in production and
 * `fisqua-pipeline-staging-{tenantId}` on staging. The Worker learns
 * which it is from the plain variable `PIPELINE_ENVIRONMENT`. Variables
 * are not inherited by a wrangler environment, so this suite checks that
 * the top level says `production` and the staging block says `staging`,
 * and that the names come out as the runner expects. It also pins each
 * deployment's runner: staging and production both on the v1.2.0 image
 * by digest, with script version v1.2.0.
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
import { pipelineEnvironmentOf, runnerKeyStoreName } from "../../app/lib/pipeline/key-store";

interface EnvConfig { vars?: Record<string, string> }
interface WranglerConfig extends EnvConfig { env?: Record<string, EnvConfig> }

const path = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
if (parsed.error) throw new Error(`wrangler.jsonc did not parse: ${String(parsed.error.messageText)}`);
const config = parsed.config as WranglerConfig;

describe("PIPELINE_ENVIRONMENT in wrangler.jsonc", () => {
  it("is production at the top level and staging in the staging block", () => {
    expect(config.vars?.PIPELINE_ENVIRONMENT).toBe("production");
    expect(config.env?.staging?.vars?.PIPELINE_ENVIRONMENT).toBe("staging");
  });

  it("is set in every wrangler environment, as vars are not inherited", () => {
    for (const [name, envConfig] of Object.entries(config.env ?? {})) {
      expect(pipelineEnvironmentOf(envConfig.vars?.PIPELINE_ENVIRONMENT), name).not.toBeNull();
    }
  });
});

describe("the runner pin in wrangler.jsonc", () => {
  const image = (digest: string) => `ghcr.io/ucsb-amplab/fisqua-media-pipeline@sha256:${digest}`;

  it("pins staging to runner v1.2.0 by digest", () => {
    expect(config.env?.staging?.vars?.PIPELINE_RUNNER_IMAGE).toBe(
      image("8a4b25275f348c3808a9b4771b022410307804b1a285d36755596bf7d0766a26"),
    );
    expect(config.env?.staging?.vars?.PIPELINE_SCRIPT_VERSION).toBe("v1.2.0");
  });

  it("pins production to runner v1.2.0 by digest", () => {
    expect(config.vars?.PIPELINE_RUNNER_IMAGE).toBe(
      image("8a4b25275f348c3808a9b4771b022410307804b1a285d36755596bf7d0766a26"),
    );
    expect(config.vars?.PIPELINE_SCRIPT_VERSION).toBe("v1.2.0");
  });
});

describe("runnerKeyStoreName", () => {
  it("keeps production's name and adds staging- on staging", () => {
    expect(runnerKeyStoreName("c50bfa92", "production")).toBe("fisqua-pipeline-c50bfa92");
    expect(runnerKeyStoreName("c50bfa92", "staging")).toBe("fisqua-pipeline-staging-c50bfa92");
  });

  it("reads only the two environment names", () => {
    expect(pipelineEnvironmentOf("production")).toBe("production");
    expect(pipelineEnvironmentOf("staging")).toBe("staging");
    for (const value of [undefined, null, "", "Production", "local", " staging"]) {
      expect(pipelineEnvironmentOf(value)).toBeNull();
    }
  });
});

// @version v0.8.0
