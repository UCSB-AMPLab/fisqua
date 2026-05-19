/**
 * Standard Config Registry
 *
 * This module deals with the closed registry of `StandardConfig`
 * instances and the `getStandardConfig(standard)` resolver. The
 * universal renderer and the validator factory both call
 * `getStandardConfig` with
 * `tenant.descriptiveStandard` and consume the returned
 * `StandardConfig` — neither knows about individual standards.
 *
 * Throw-on-unknown contract: `tenants.descriptive_standard` is NOT
 * NULL for `kind = 'tenant'` (schema CHECK in
 * drizzle/0034_tenants_table.sql); null only happens for
 * `kind = 'platform'`, which doesn't reach description-CRUD routes
 * (operator routes don't render descriptions). If
 * `getStandardConfig` ever receives a null or unknown standard from
 * a tenant route, the tenant row is malformed (CHECK was bypassed)
 * — this is a schema-invariant violation, not a fallback case. We
 * throw rather than silently defaulting to ISAD(G), which would
 * mask schema corruption and silently produce ISAD-shaped data for
 * what should be a DACS or RAD tenant.
 *
 * Adding a fourth standard later = adding a config module under
 * `app/lib/standards/` that exports a `StandardConfig`, plus an
 * entry in the `STANDARDS` map below.
 *
 * @version v0.4.0
 */

import { ISADG_CONFIG } from "./isadg";
import { DACS_CONFIG } from "./dacs";
import { RAD_CONFIG } from "./rad";
import type { Standard, StandardConfig } from "./types";

/**
 * Closed registry of standard configs. Adding a fourth standard
 * later = adding a config file plus an entry here.
 */
const STANDARDS: Readonly<Record<Standard, StandardConfig>> = {
  isadg: ISADG_CONFIG,
  dacs: DACS_CONFIG,
  rad: RAD_CONFIG,
};

/**
 * Resolve the config for a standard. Throws on unknown —
 * null/unknown is a schema-invariant violation
 * (`tenants.descriptive_standard` CHECK enforces NOT NULL when
 * `kind = 'tenant'`); the caller should never pass a value the
 * schema cannot have produced.
 */
export function getStandardConfig(standard: Standard): StandardConfig {
  const config = STANDARDS[standard];
  if (!config) {
    throw new Error(`Unknown descriptive standard: ${standard}`);
  }
  return config;
}

/* @version v0.4.0 */
