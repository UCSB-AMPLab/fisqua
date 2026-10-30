/**
 * User Admin — Invite Action
 *
 * This module holds the server-side handler behind the invite form on
 * /admin/users: it validates the address and the opening role, creates
 * the user row in the request tenant, and sends the magic-link
 * invitation, deleting the row again if the email cannot be sent. It
 * is split out from the route file so
 * `_auth.admin.users.action.server.test.ts` can exercise it without a
 * React Router request.
 *
 * Invitation is the only action here. Role flags are changed on the
 * user detail page, through `assignableRoleFlags`, and nowhere else.
 *
 * Takes the request tenant (`context.get(tenantContext)`) so the invite
 * path attributes the new user row to the request-boundary tenant
 * rather than a single-tenant hard-code, and reads its capabilities.
 *
 * The inviter chooses the new account's opening role: the workspace
 * admin, the records, authorities, digitization or imports admin, or
 * the Reader, or no role. The choice is bounded by
 * `INVITE_ROLE_CHOICES` and checked three times: the posted value must
 * name a known choice, an area's value is accepted only while the
 * workspace has that area (`INVITE_ROLE_AREAS`), and the flag it maps
 * to must be one the inviter may actually assign
 * (`assignableRoleFlags`). Any of the three failing is `invalid_role`
 * or `role_not_assignable`, and nothing is created. Platform roles are
 * not on offer to anyone here; promoting somebody to super admin stays
 * a deliberate second step on the user detail page. A body carrying an
 * `isCollabAdmin` field is refused with `invalid_role`, whoever sends
 * it: no form posts it, and the cataloguing roles are granted on the
 * user detail page. During an operator's impersonation session an
 * invitation carries no role: choosing one is refused with
 * `error_operator_no_grants`.
 *
 * The account is created with no role. Once the invitation email has
 * gone, `recordInvitation` records the invitation in `audit_log` as
 * `invite_user` (`details` of `{ role }`, the posted value, `none`
 * included; the inviter's home workspace as the actor tenant; the new
 * person as the target) and, in the same batch, grants the opening role
 * with its own `set_user_role` row while the flag is still off, so the
 * role never stands without a row. If that batch fails, nothing of it
 * lands: the account stays with no role, and the answer is
 * `error_invite_role_not_granted` when a role was chosen (it can be
 * granted on the user detail page) and `common:save.failed` when none
 * was. A batch that committed reports the invitation as sent, even if
 * reading the grant back afterwards fails. An invitation
 * whose email fails leaves neither the user row nor an audit row.
 *
 * @version v0.8.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Tenant, User } from "../context";

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

/** The request tenant, as far as the invitation reads it. */
export type InviteTenant = Pick<
  Tenant,
  "id" | "authoritiesEnabled" | "digitizationEnabled" | "importsEnabled"
>;

/** Who sends the invitation, as the audit row records them. */
export type InviteActor = {
  /** The inviter's home workspace: `grant.homeTenantId` under a grant. */
  homeTenantId: string;
  impersonationSessionId: string | null;
};

export type UsersActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Pure action handler for the invite form on /admin/users.
 *
 * Extracted from the route so vitest-pool-workers can exercise the
 * security gates and flows directly without needing a full React Router
 * runtime. The route `action` is a thin wrapper around this function.
 *
 * Security contract:
 *   - Caller MUST have already enforced `canManageTenantUsers(user)`
 *     before entering this function. This helper enforces the role
 *     bounds itself: `assignableRoleFlags` for the opening role.
 */
export async function handleUsersAction(
  user: User,
  tenant: InviteTenant,
  db: DrizzleD1Database<any>,
  formData: FormData,
  env: any,
  i18n: I18nLike,
  origin: string,
  actor: InviteActor,
  deps: UsersActionDeps = {}
): Promise<UsersActionResult> {
  const { eq } = await import("drizzle-orm");
  const { users, magicLinks, DEFAULT_DIGEST_FREQUENCY } =
    await import("../db/schema");
  const { recordInvitation } = await import("../lib/access-changes.server");
  const tenantId = tenant.id;
  const { generateMagicLink } = await import("../lib/auth.server");

  const intent = formData.get("_action") as string;

  switch (intent) {
    case "inviteUser": {
      const { INVITE_ROLE_AREAS, INVITE_ROLE_CHOICES, assignableRoleFlags } =
        await import("../lib/permissions.server");

      const email = ((formData.get("email") as string) || "")
        .trim()
        .toLowerCase();
      const name = ((formData.get("name") as string) || "").trim() || null;
      const roleChoice =
        ((formData.get("role") as string | null) || "none").trim() || "none";

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: i18n.t("admin:error.invalid_email") };
      }

      // The posted role must name one of the bounded choices. Anything
      // else -- including a platform role somebody hoped would be read
      // straight through -- is an invalid request, whoever sent it.
      // `isCollabAdmin` is not an invitation field: no form posts it.
      if (!Object.hasOwn(INVITE_ROLE_CHOICES, roleChoice) || formData.has("isCollabAdmin")) {
        return { ok: false, error: i18n.t("admin:error.invalid_role") };
      }
      // An area's admin only where the workspace has the area.
      const area = INVITE_ROLE_AREAS[roleChoice];
      if (area && !tenant[area]) {
        return { ok: false, error: i18n.t("admin:error.invalid_role") };
      }
      const roleFlag = INVITE_ROLE_CHOICES[roleChoice];

      // An operator's impersonation session grants no role.
      if (actor.impersonationSessionId && roleFlag !== null) {
        return { ok: false, error: i18n.t("user_admin:error_operator_no_grants") };
      }

      // ...and the inviter must be allowed to hand that role out. Same
      // split the user detail page enforces, read from the same helper.
      if (roleFlag !== null && !assignableRoleFlags(user).includes(roleFlag)) {
        return { ok: false, error: i18n.t("admin:error.role_not_assignable") };
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
        // No role yet: the opening role is granted with its audit row
        // once the email has gone.
        digestFrequency: DEFAULT_DIGEST_FREQUENCY,
        isAdmin: false,
        isArchiveUser: false,
        isRecordsAdmin: false,
        isAuthoritiesAdmin: false,
        isDigitizationAdmin: false,
        isImportsAdmin: false,
        isSuperAdmin: false,
        isUserManager: false,
        isCollabAdmin: false,
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

      // The invitation is recorded whether or not the role was still
      // to grant. A batch that fails lands nothing: the account stays,
      // with no role. With a role chosen, the inviter is told the
      // invitation went but the role was not granted (in the error
      // presentation, as the banner has no warning one); without one,
      // that the change was not saved. A batch that committed is a sent
      // invitation, whatever reading it back did afterwards.
      const recorded = await recordInvitation({
        d1: env.DB,
        tenantId,
        userId: newUserId,
        role: roleChoice,
        flag: roleFlag,
        actor: { user, ...actor },
        now: Date.now(),
        newId: () => crypto.randomUUID(),
      });
      if (!recorded.landed) {
        return {
          ok: false,
          error: i18n.t(
            roleFlag !== null ? "admin:error.error_invite_role_not_granted" : "common:save.failed",
          ),
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

// @version v0.8.0
