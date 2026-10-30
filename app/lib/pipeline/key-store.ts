/**
 * Media Pipeline — Runner Key Store Names
 *
 * This module deals with naming the GitHub Environment that holds a
 * tenant's runner keys in the runner repository. A spec names it in
 * `destination.credentials_ref`, and the provisioning command creates it
 * and adds it to the runner's `PIPELINE_ENVIRONMENTS`.
 *
 * Staging and production both dispatch to the same runner repository,
 * and a tenant seeded by a migration has the same id in both, so the name
 * carries the environment: production keeps `fisqua-pipeline-{tenantId}`
 * and staging uses `fisqua-pipeline-staging-{tenantId}`. Each deployed
 * Worker says which it is in the plain variable `PIPELINE_ENVIRONMENT`;
 * `pipelineEnvironmentOf` reads it and returns null for anything other
 * than the two names, so a Worker without it cannot dispatch under the
 * other environment's keys.
 *
 * @version v0.8.0
 */

export const PIPELINE_ENVIRONMENT_NAMES = ["production", "staging"] as const;

export type PipelineEnvironment = (typeof PIPELINE_ENVIRONMENT_NAMES)[number];

/** The deployment's environment, or null when the value is not one of the two. */
export function pipelineEnvironmentOf(value: string | undefined | null): PipelineEnvironment | null {
  return (PIPELINE_ENVIRONMENT_NAMES as readonly string[]).includes(value ?? "")
    ? (value as PipelineEnvironment)
    : null;
}

/** The runner Environment holding a tenant's keys in one environment. */
export function runnerKeyStoreName(tenantId: string, environment: PipelineEnvironment): string {
  return environment === "staging" ? `fisqua-pipeline-staging-${tenantId}` : `fisqua-pipeline-${tenantId}`;
}

// @version v0.8.0
