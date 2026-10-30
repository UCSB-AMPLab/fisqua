/**
 * Media Pipeline — Access Gate
 *
 * This module deals with who may reach the media pipeline surfaces
 * (starting a run, the run ledger, recipe settings, publishing). Access
 * has two parts, checked in a fixed order by
 * `requireMediaPipelineAccess`:
 *
 *   1. The tenant's `media_pipeline` capability, through
 *      `requireCapability`. When it is off the caller gets a bare 404,
 *      the same answer a missing route gives, so a tenant without the
 *      capability cannot learn whether a given user would have passed
 *      the second check.
 *
 *   2. A user-scoped check that the user is a steward of the tenant's
 *      federation. When it fails the caller gets a bare 403.
 *
 * The capability is tenant-scoped and operator-granted; the steward
 * check is user-scoped and lives in one predicate,
 * `isMediaPipelineLead`, which every pipeline surface reaches through
 * `requireMediaPipelineAccess`.
 *
 * The predicate admits exactly what `isFederationSteward` admits. The
 * lead federation's admins run the pipeline for its member tenants
 * (Neogranadina for AHR and Komuni, AMPL for SBMAL), so the gate admits:
 *
 *   (A) a home administrator of the federation's lead tenant, acting on
 *       that lead tenant; and
 *   (B) a user holding a `steward` membership in the tenant's
 *       federation, acting on any tenant of it. The `steward` row is
 *       the appointment, as it is for the shared authorities; the
 *       steward need not also be a home admin of the lead tenant.
 *
 * Both branches require the federation to be active. A member tenant's
 * own administrators are refused, since processing is done from the
 * lead, and so is a federation `staff` grant. Branch A alone would
 * leave no one able to start, publish or configure a run for a member
 * tenant.
 *
 * Neither check writes to the audit log: a refused read is not an
 * operator action, as with the other capability gates. Writes made
 * through a grant are recorded at the middleware envelope.
 *
 * @version v0.8.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Tenant, User } from "../../context";
import { isFederationSteward } from "../federation.server";
import { requireCapability } from "../tenant";

/**
 * True when `user` may run the media pipeline for `tenant`: the same
 * answer `isFederationSteward` gives.
 */
async function isMediaPipelineLead(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
): Promise<boolean> {
  return isFederationSteward(db, user, tenant);
}

/**
 * Throws a bare 404 when the tenant lacks the `media_pipeline`
 * capability, then a bare 403 when the user is not a steward of the
 * tenant's federation. Resolves with nothing when both pass. Drop into
 * a pipeline route's loader or action after the tenant and user are
 * read from context.
 */
export async function requireMediaPipelineAccess(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  user: User,
): Promise<void> {
  requireCapability(tenant, "media_pipeline");
  if (!(await isMediaPipelineLead(db, tenant, user))) {
    throw new Response(null, { status: 403 });
  }
}

// @version v0.8.0
