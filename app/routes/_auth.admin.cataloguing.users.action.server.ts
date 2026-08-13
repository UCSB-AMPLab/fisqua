/**
 * Cataloguing Admin Users Actions
 *
 * This module deals with the shared server-side handlers behind the cataloguing-users admin page:
 * role-flag toggles, email-address changes, and the audit-log writes
 * that sit behind every mutation. Split out from the route file so
 * the unit tests in `_auth.admin.cataloguing.users.test.tsx` can
 * exercise the logic without a React Router request.
 *
 * Takes an explicit `tenantId` argument so the invite path
 * attributes the new user row to the request-boundary tenant from
 * `context.get(tenantContext).id` rather than a single-tenant
 * hard-code; user reads/updates are also filtered by tenant so
 * cross-tenant id-guessing 404s.
 *
 * The invite path lets the inviter choose the new account's opening
 * role instead of hard-coding every flag to false. That hard-code was
 * a real dead end on a records-management tenant, where every working
 * surface requires Records admin: an invited colleague signed in to a
 * dashboard with nothing on it and no in-product way out. The choice is
 * bounded by `INVITE_ROLE_CHOICES` — the tenant-scoped roles only — and
 * checked twice: the posted value must name a known choice, and the
 * flag it maps to must be one the inviter may actually assign
 * (`assignableRoleFlags`). Platform roles are not on offer to anyone
 * here; promoting somebody to super admin stays a deliberate second
 * step on the user detail page.
 *
 * @version v0.7.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { User } from "../context";

/**
 * Local 403-throwing superadmin guard. The shared `requireSuperAdmin` in
 * `app/lib/superadmin.server.ts` throws a redirect; here we need an explicit
 * 403 response for cross-tier flag flips. Named so that
 * `grep requireSuperAdmin` still finds this file.
 */
function requireSuperAdminOr403(user: Pick<User, "isSuperAdmin">): void {
  if (!user.isSuperAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }
}

type I18nLike = { t: (key: string, opts?: Record<string, unknown>) => string };

export type UsersActionDeps = {
  /** Optional hook so tests can stub email sending. */
  sendInvite?: (args: {
    db: DrizzleD1Database<any>;
    email: string;
    origin: string;
    env: any;
  }) => Promise<{ success?: boolean; error?: string }>;
};

export type UsersActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Pure action handler for the cataloguing users admin page.
 *
 * Extracted from the route so vitest-pool-workers can exercise the
 * security gates and flows directly without needing a full React Router
 * runtime. The route `action` is a thin wrapper around this function.
 *
 * Security contract:
 *   - Caller MUST have already enforced `requireCollabAdmin(user)` before
 *     entering this function. This helper enforces cross-tier (super-admin)
 *     checks for flag flips and for the optional `isCollabAdmin` invite flag.
 */
export async function handleUsersAction(
  user: User,
  tenantId: string,
  db: DrizzleD1Database<any>,
  formData: FormData,
  env: any,
  i18n: I18nLike,
  origin: string,
  deps: UsersActionDeps = {}
): Promise<UsersActionResult> {
  const { and, eq } = await import("drizzle-orm");
  const { users, magicLinks } = await import("../db/schema");
  const { generateMagicLink } = await import("../lib/auth.server");

  const intent = formData.get("_action") as string;

  switch (intent) {
    case "toggleAdmin": {
      requireSuperAdminOr403(user);

      const targetUserId = formData.get("userId") as string;
      if (targetUserId === user.id) {
        return { ok: false, error: i18n.t("admin:error.self_admin") };
      }

      const targetUser = await db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)))
        .get();

      if (!targetUser) {
        return { ok: false, error: i18n.t("admin:error.user_not_found") };
      }

      await db
        .update(users)
        .set({ isAdmin: !targetUser.isAdmin, updatedAt: Date.now() })
        .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)));

      const messageKey = targetUser.isAdmin
        ? "admin:error.admin_toggled_off"
        : "admin:error.admin_toggled_on";
      return {
        ok: true,
        message: i18n.t(messageKey, { email: targetUser.email }),
      };
    }

    case "toggleCollabAdmin": {
      requireSuperAdminOr403(user);

      const targetUserId = formData.get("userId") as string;
      if (targetUserId === user.id) {
        return { ok: false, error: i18n.t("admin:error.self_admin") };
      }

      const targetUser = await db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)))
        .get();

      if (!targetUser) {
        return { ok: false, error: i18n.t("admin:error.user_not_found") };
      }

      await db
        .update(users)
        .set({
          isCollabAdmin: !targetUser.isCollabAdmin,
          updatedAt: Date.now(),
        })
        .where(and(eq(users.tenantId, tenantId), eq(users.id, targetUserId)));

      return {
        ok: true,
        message: i18n.t("admin:error.admin_toggled_on", {
          email: targetUser.email,
        }),
      };
    }

    case "inviteUser": {
      const { INVITE_ROLE_CHOICES, assignableRoleFlags } = await import(
        "../lib/permissions.server"
      );

      const email = ((formData.get("email") as string) || "")
        .trim()
        .toLowerCase();
      const name = ((formData.get("name") as string) || "").trim() || null;
      const grantCollabAdmin =
        (formData.get("isCollabAdmin") as string | null) === "on";
      const roleChoice =
        ((formData.get("role") as string | null) || "none").trim() || "none";

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: i18n.t("admin:error.invalid_email") };
      }

      // The posted role must name one of the bounded choices. Anything
      // else -- including a platform role somebody hoped would be read
      // straight through -- is an invalid request, whoever sent it.
      if (!(roleChoice in INVITE_ROLE_CHOICES)) {
        return { ok: false, error: i18n.t("admin:error.invalid_role") };
      }
      const roleFlag = INVITE_ROLE_CHOICES[roleChoice];

      // ...and the inviter must be allowed to hand that role out. Same
      // split the user detail page enforces, read from the same helper.
      if (roleFlag !== null && !assignableRoleFlags(user).includes(roleFlag)) {
        return { ok: false, error: i18n.t("admin:error.role_not_assignable") };
      }

      // Only a superadmin can grant isCollabAdmin at invite time.
      if (grantCollabAdmin) {
        requireSuperAdminOr403(user);
      }

      // Email is globally unique on `users` (schema-level), so a duplicate
      // check across all tenants is correct here. The tenant scoping
      // applies to the INSERT and to subsequent reads.
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .get();

      if (existing) {
        return { ok: false, error: i18n.t("admin:error.duplicate_email") };
      }

      const now = Date.now();
      const newUserId = crypto.randomUUID();
      await db.insert(users).values({
        tenantId,
        id: newUserId,
        email,
        name,
        // Exactly the chosen role, and nothing implied alongside it.
        isAdmin: roleFlag === "isAdmin",
        isArchiveUser: roleFlag === "isArchiveUser",
        // Platform roles are never granted at invite time.
        isSuperAdmin: false,
        isUserManager: false,
        isCollabAdmin: grantCollabAdmin,
        createdAt: now,
        updatedAt: now,
      });

      // Send magic-link invite. Allow tests to inject a stub.
      const sender =
        deps.sendInvite ??
        (async ({ db: _db, email: _email, origin: _origin, env: _env }) => {
          return generateMagicLink(
            _db,
            _email,
            _origin,
            _env.RESEND_API_KEY,
            _env
          );
        });

      let result: { success?: boolean; error?: string };
      try {
        result = await sender({ db, email, origin, env });
      } catch (err) {
        result = { error: (err as Error).message || "send failed" };
      }

      if (!result.success) {
        // Rollback user + any magic-link rows that may have been written.
        await db.delete(magicLinks).where(eq(magicLinks.userId, newUserId));
        await db.delete(users).where(eq(users.id, newUserId));
        return {
          ok: false,
          error: i18n.t("admin:error.invite_email_failed"),
        };
      }

      return {
        ok: true,
        message: i18n.t("admin:error.user_invited", { email }),
      };
    }

    default:
      return { ok: false, error: i18n.t("admin:error.unknown_action") };
  }
}
