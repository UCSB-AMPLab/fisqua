/**
 * Platform Admin — At Home in Every Live Workspace
 *
 * This module deals with the person whose `users.is_platform_admin` is
 * set (migration 0114). Such a person is at home in every workspace of
 * kind `tenant` that is not disabled: the auth middleware admits them
 * there as a home member with every role flag on, so they reach every
 * surface that workspace's own super admin reaches and nothing beyond
 * it. No federation grant is involved, so there is no grant banner, no
 * `grantContext` and no `edit_on_behalf` row, and they are never sent
 * to the wrong-workspace page. The platform tenant and disabled
 * workspaces stay closed to them, and the flag does not make anyone an
 * operator: the operator surface keeps its own gate.
 *
 * `admitsAsPlatformAdmin` is the admission test, written in the
 * positive: the flag read from the user row this request is exactly
 * `true`, the tenant's kind is exactly `tenant`, its `disabledAt` is
 * exactly null, and the row is not stored on the platform tenant.
 * Anything else is a refusal. Operators are refused: an operator's row
 * lives on the platform tenant, and reaches a workspace only through an
 * impersonation envelope. The caller passes the stored row as
 * `requireUser` or the sign-in routes read it (its `tenantId` is the
 * stored one), never the effective user and never anything from the
 * session cookie.
 *
 * `platformAdminEffectiveUser` is the user the middleware hands to
 * every loader and action under that admission: every role flag the
 * `User` type has set to true, identity unchanged, and `tenantId` set
 * to the request tenant, as for a home member, so every gate that
 * compares `user.tenantId` with the request tenant, and every write
 * that takes its tenant from it, acts in the request tenant. The stored
 * `users.tenant_id` is not changed and neither limits nor ranks
 * anything for a platform admin. The role-flag set is typed from the
 * `User` type itself, so a flag added there fails to compile here
 * until it is set too.
 *
 * `readIsPlatformAdmin` reads the flag for one person, and
 * `liveWorkspaces` lists every workspace a platform admin is at home
 * in, for the workspace switcher.
 *
 * Nothing in the app writes the flag; `scripts/commands/set-platform-admin.ts`
 * sets and clears it.
 *
 * @version v0.9.0
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Tenant, User } from "../context";
import { tenants, users } from "../db/schema";
import { PLATFORM_TENANT_ID } from "./tenant";

/** The role flags of `User`: its boolean fields, less the grant-only marker. */
type RoleFlagKey = Exclude<
  { [K in keyof User]-?: NonNullable<User[K]> extends boolean ? K : never }[keyof User],
  "worksInEveryArea"
>;

/** Every role flag the app has, on. */
const EVERY_ROLE_FLAG: { [K in RoleFlagKey]: true } = {
  isAdmin: true,
  isSuperAdmin: true,
  isCollabAdmin: true,
  isArchiveUser: true,
  isUserManager: true,
  isCataloguer: true,
  isRecordsAdmin: true,
  isAuthoritiesAdmin: true,
  isImportsAdmin: true,
  isDigitizationAdmin: true,
};

/**
 * Whether the person is admitted to `tenant` as a platform admin: the
 * flag read from their row is exactly `true`, the tenant's kind is
 * exactly `tenant`, and it is not disabled.
 */
export function admitsAsPlatformAdmin(
  user: { isPlatformAdmin?: unknown; tenantId: string },
  tenant: Pick<Tenant, "kind" | "disabledAt">,
): boolean {
  return (
    user.isPlatformAdmin === true &&
    typeof user.tenantId === "string" &&
    user.tenantId !== PLATFORM_TENANT_ID &&
    tenant.kind === "tenant" &&
    tenant.disabledAt === null
  );
}

/**
 * The user a platform admin acts as in `tenant`: every role flag on,
 * identity unchanged, acting in the request tenant. Returns a copy.
 */
export function platformAdminEffectiveUser<U extends User>(
  user: U,
  tenant: Pick<Tenant, "id">,
): U {
  return { ...user, ...EVERY_ROLE_FLAG, tenantId: tenant.id };
}

/** Whether the person's row has the platform-admin flag, read now. */
export async function readIsPlatformAdmin(
  db: DrizzleD1Database<any>,
  userId: string,
): Promise<boolean> {
  const row = await db
    .select({ isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.isPlatformAdmin === true;
}

/** Every workspace a platform admin is at home in: kind `tenant`, not disabled. */
export async function liveWorkspaces(
  db: DrizzleD1Database<any>,
): Promise<Array<{ id: string; slug: string; name: string }>> {
  return db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(and(eq(tenants.kind, "tenant"), isNull(tenants.disabledAt)))
    .orderBy(asc(tenants.name))
    .all();
}

// @version v0.9.0
