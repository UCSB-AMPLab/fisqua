/**
 * Capture — the names of a scanner's B2 keys
 *
 * This module holds the one rule for naming the two B2 keys a capture
 * appliance (Captua) holds: the upload key
 * `fisqua-{slug}[-staging]-appliance-{id}` and the read key, the same
 * name with `-read` after it. `-staging` follows the tenant's slug on
 * staging and is absent on production. The operator's minting command
 * (`scripts/lib/appliance-key.ts`) names the keys it issues with it, and
 * the Worker names the keys an operator must revoke after an erasure
 * with it, so both sides give the same names.
 *
 * The module is pure and imports nothing, so the Worker and the
 * operator's commands can both import it. It does not check the slug or
 * the appliance id: the minting command checks them before it names a
 * key, and the Worker names keys only from a stored row's appliance id,
 * which the operator's storing command checked.
 *
 * `pairingEnvironment` reads the Worker's `CAPTURE_PAIRING_ENVIRONMENT`
 * setting as an environment: `staging` is staging, and any other value,
 * or none, is production.
 *
 * @version v0.9.0
 */

/** The environment a key is named for. */
export type ApplianceKeyEnvironment = "production" | "staging";

/** The environment the setting names: `staging` for "staging", otherwise `production`. */
export function pairingEnvironment(setting: string | undefined): ApplianceKeyEnvironment {
  return setting === "staging" ? "staging" : "production";
}

/** The suffix that marks the read key's name. */
export const APPLIANCE_READ_SUFFIX = "-read";

/** The names of an appliance's upload key (`write`) and read key (`read`). */
export function applianceKeyNames(
  slug: string,
  applianceId: string,
  environment: ApplianceKeyEnvironment,
): { write: string; read: string } {
  const base = environment === "staging" ? `${slug}-staging` : slug;
  const write = `fisqua-${base}-appliance-${applianceId}`;
  return { write, read: `${write}${APPLIANCE_READ_SUFFIX}` };
}

// @version v0.9.0
