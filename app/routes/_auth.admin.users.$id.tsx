/**
 * User Admin — Detail Page
 *
 * This page is the administrative surface for one user account: email,
 * display name, the role flags, session state, and the audit log of
 * administrative changes. The audit panel is read-only.
 *
 * Who may change WHICH role is decided in one place,
 * `assignableRoleFlags` in `app/lib/permissions.server.ts`, and read
 * twice: once by the loader, which hands the resulting list to the JSX
 * so a role the caller cannot assign renders as a disabled checkbox
 * with an explanatory tooltip; and once by the action, which reads
 * only those fields out of the form body. The two tenant-scoped roles
 * (`isAdmin`, `isArchiveUser`) are assignable by a tenant admin — which
 * a federation steward's effective member-tenant flags include — and
 * the rest stay super-admin-only. Before that split every role change
 * required a super admin, so a steward onboarding a partner workspace
 * could invite colleagues but could not give them any role, and the
 * people they invited arrived at an empty dashboard.
 *
 * The action treats the form body as hostile. It does not ask what the
 * form said about `isSuperAdmin`; it asks what the caller is allowed to
 * set, and refuses outright if the body carries a field outside that
 * set. A disabled checkbox is not submitted by the browser, so such a
 * field never arrives from the rendered page — its presence means the
 * request was crafted.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of the `users` table is
 * filtered by `tenant.id`, including the role-flag update and the
 * email-uniqueness check, so cross-tenant id-guessing 404s and
 * writes cannot reattribute users between tenants. The action resolves
 * the target inside the request tenant ONCE, before any intent runs,
 * and 404s if it is not there, so a cross-tenant id never gets so much
 * as a "you are not allowed" out of the surface. The project intents
 * do the same for the ids THEY take from the body: `project_members`
 * carries no tenant column, so a membership is resolved through its
 * owning project, the way `requireProjectRole` does it. Without that,
 * widening the page's gate to tenant admins would have widened who
 * could write a membership row into another tenant's project.
 *
 * When the request tenant has `crowdsourcingEnabled === false`, the
 * JSX omits the `isCollabAdmin` and `isCataloguer` checkboxes
 * entirely from the role-flag fieldset. The matching
 * `applyUpdateRoles` helper skips writing those two fields under the
 * same condition, so a dormant DB value (set on a user before
 * crowdsourcing was disabled) is left intact rather than silently
 * cleared by an unchecked-as-false read of the form body. The four
 * other role flags (`isAdmin`, `isSuperAdmin`, `isArchiveUser`,
 * `isUserManager`) always render; whether they update depends on the
 * caller's assignable set, which is the other half of the same filter.
 *
 * `applyUpdateRoles` is exported so `tests/admin/users-capability.test.ts`
 * can exercise the dormant-flag-preserved behaviour on its own, without
 * the surrounding request. The role-scope suite drives the real
 * `action` instead, so the guards are exercised in the order a request
 * meets them.
 *
 * Every form on the page — profile, role flags, project assignment,
 * per-row role change and removal — shares ONE fetcher, so there is one
 * page-level `SaveFeedbackBanner` rather than one per form: a second
 * banner fed by the same fetcher would announce every result twice.
 * The banner sits directly under the breadcrumb as the page's result
 * region. Each submit button keys its own pending state off the
 * `_action` value carried by the in-flight submission, so clicking
 * "Save profile" does not grey out "Save roles".
 *
 * @version v0.7.0
 */

import { useState } from "react";
import { Form, Link, useFetcher, redirect } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { useFormatters } from "../lib/use-formatters";
import {
  SaveButton,
  SaveFeedbackBanner,
  isPendingSubmission,
} from "~/components/admin/save-feedback";
import type { Route } from "./+types/_auth.admin.users.$id";
import { PROJECT_ROLES, type ProjectRole } from "../lib/validation/enums";
// Type-only: erased at build time, so the server module is not pulled
// into the client bundle.
import type { RoleFlag } from "../lib/permissions.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");
  const { assignableRoleFlags, canManageTenantUsers } = await import(
    "../lib/permissions.server"
  );

  const currentUser = context.get(userContext);
  if (!canManageTenantUsers(currentUser)) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const [targetUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.id, params.id)))
    .limit(1)
    .all();

  if (!targetUser) {
    throw new Response("User not found", { status: 404 });
  }

  // Fetch project memberships
  const memberships = await db
    .select({
      id: projectMembers.id,
      projectId: projectMembers.projectId,
      projectName: projects.name,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, params.id))
    .all();

  // Available projects for assignment (tenant-scoped: only the request
  // tenant's projects can be offered for assignment)
  const availableProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.tenantId, tenant.id), isNull(projects.archivedAt)))
    .all();

  // Filter out projects the user is already in
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));
  const assignableProjects = availableProjects.filter(
    (p) => !memberProjectIds.has(p.id)
  );

  // The exact set of role flags this caller may hand out. The JSX
  // enables precisely these checkboxes and disables the rest, so the
  // form can never offer what the action would refuse.
  const editableRoles = [...assignableRoleFlags(currentUser)];

  return {
    targetUser,
    memberships,
    assignableProjects,
    isSelf: currentUser.id === params.id,
    editableRoles,
    canEditRoles: editableRoles.length > 0,
    // True only for a caller who may set every flag the form can show.
    // Drives the "some roles are not yours to give" notice rather than
    // the blanket "roles are read-only" one.
    canEditAllRoles: currentUser.isSuperAdmin,
    // Surface only the capability flag the JSX gates on. The JSX
    // hides isCollabAdmin and isCataloguer when crowdsourcing is
    // off; the other three capabilities are not consumed here.
    tenant: {
      crowdsourcingEnabled: tenant.crowdsourcingEnabled,
    },
  };
}

// ---------------------------------------------------------------------------
// Role-update helper
// ---------------------------------------------------------------------------

/**
 * Applies the role-flag update for one user. Extracted from `action`
 * so the test pool can exercise the capability-aware skip-write and
 * role-scope behaviours without paying for the full i18n / Host-header
 * / middleware wiring (the route module imports `~/locales` which is
 * not aliased in `vitest.config.ts`).
 *
 * Behaviour contract:
 *
 *   - `assignableFlags` is the ALLOWLIST of fields read out of the
 *     form. It comes from `assignableRoleFlags(currentUser)` and is
 *     the reason a hostile body cannot escalate: a flag outside the
 *     set is never read, so whatever the body claims about it is not
 *     merely rejected, it is never consulted. The stored value of such
 *     a flag is left exactly as it was.
 *   - Within that set, a flag is written from the form-data; an
 *     unchecked checkbox arrives as missing and reads as `false`,
 *     which clears the flag (existing v0.3 semantics).
 *   - When `crowdsourcingEnabled === false`, `isCollabAdmin` and
 *     `isCataloguer` are NOT included in the UPDATE — their DB
 *     values stay intact. This is the "no auto-clear of dormant
 *     flags" rule from CONTEXT.md C-05; it also defends against a
 *     tampered POST body that re-adds a hidden `isCataloguer=on`
 *     field (defence-in-depth — the parent layout's 404 already
 *     makes the persisted flag a no-op, but skipping the write
 *     avoids accidentally toggling state from the admin UI either
 *     way).
 *   - When `crowdsourcingEnabled === true`, both flags are written
 *     from the form-data if the caller may assign them.
 *
 * The UPDATE is scoped to `(tenantId, userId)` so a cross-tenant
 * id-guess on the URL cannot rewrite another tenant's user row. The
 * caller resolves the target inside the request tenant first and 404s
 * if it is absent, so this predicate is the second of two locks, not
 * the only one.
 */
export async function applyUpdateRoles(args: {
  db: import("drizzle-orm/d1").DrizzleD1Database<any>;
  tenantId: string;
  crowdsourcingEnabled: boolean;
  targetUserId: string;
  formData: FormData;
  assignableFlags: readonly RoleFlag[];
}): Promise<void> {
  const { eq, and } = await import("drizzle-orm");
  const { users } = await import("../db/schema");

  // Capability filter on top of the privilege filter: the two
  // crowdsourcing flags drop out of the write when the tenant has
  // crowdsourcing off, whoever is asking.
  const writableFlags = args.assignableFlags.filter(
    (flag) =>
      args.crowdsourcingEnabled ||
      (flag !== "isCollabAdmin" && flag !== "isCataloguer"),
  );

  if (writableFlags.length === 0) return;

  const updateSet: Record<string, unknown> = {};
  for (const flag of writableFlags) {
    updateSet[flag] = args.formData.get(flag) === "on";
  }

  await args.db
    .update(users)
    .set(updateSet)
    .where(and(eq(users.tenantId, args.tenantId), eq(users.id, args.targetUserId)));
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");

  const { getInstance } = await import("~/middleware/i18next");
  const {
    assignableRoleFlags,
    canManageTenantUsers,
    unassignableSubmittedRoleFlags,
  } = await import("../lib/permissions.server");
  const currentUser = context.get(userContext);
  const i18n = getInstance(context);
  if (!canManageTenantUsers(currentUser)) {
    throw new Response(i18n.t("user_admin:error_forbidden"), { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  // Target scoping, once, for every intent on this page: they all act
  // on the user named in the URL. The request tenant comes from
  // `tenantContext`, never from the acting user's row — under a
  // federation grant a steward's home tenant is not the tenant being
  // served. A target outside the request tenant 404s with the same
  // shape a missing id gets, so probing cannot distinguish "belongs to
  // someone else" from "does not exist".
  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.id, params.id)))
    .limit(1)
    .all();
  if (!targetUser) {
    throw new Response("User not found", { status: 404 });
  }

  if (intent === "updateProfile") {
    const name = (formData.get("name") as string)?.trim() || null;
    const email = (formData.get("email") as string)?.trim();

    if (!email) {
      return { ok: false, error: i18n.t("user_admin:error_email_required") };
    }

    // Check for duplicate email (excluding this user). Email is globally
    // unique on `users` (schema-level), so the duplicate check is across
    // tenants; the UPDATE is scoped to the calling tenant so a cross-tenant
    // id-guess cannot rename another tenant's user.
    const { ne } = await import("drizzle-orm");
    const [duplicate] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, params.id)))
      .limit(1)
      .all();
    if (duplicate) {
      return { ok: false, error: i18n.t("user_admin:error_email_duplicate") };
    }

    await db
      .update(users)
      .set({ name, email })
      .where(and(eq(users.tenantId, tenant.id), eq(users.id, params.id)));

    return { ok: true, message: i18n.t("user_admin:success_profile_updated") };
  }

  if (intent === "updateRoles") {
    const assignableFlags = assignableRoleFlags(currentUser);
    if (assignableFlags.length === 0) {
      return { ok: false, error: i18n.t("user_admin:error_only_superadmin_roles") };
    }
    // Unchanged self-protection: nobody edits their own roles, however
    // many they can hand out.
    if (currentUser.id === params.id) {
      return { ok: false, error: i18n.t("user_admin:error_cannot_change_own_roles") };
    }

    // The form is hostile until proven otherwise. A checkbox the page
    // rendered disabled is not submitted at all, so a super-admin-only
    // field in the body of a tenant admin's post is a crafted request,
    // not a stray unchecked box — refuse the whole submission.
    const refused = unassignableSubmittedRoleFlags(currentUser, formData);
    if (refused.length > 0) {
      return { ok: false, error: i18n.t("user_admin:error_role_not_assignable") };
    }

    await applyUpdateRoles({
      db,
      tenantId: tenant.id,
      crowdsourcingEnabled: tenant.crowdsourcingEnabled,
      targetUserId: params.id,
      formData,
      assignableFlags,
    });

    return { ok: true, message: i18n.t("user_admin:success_roles_updated") };
  }

  if (intent === "assignToProject") {
    const projectId = formData.get("projectId") as string;
    const role = formData.get("role") as ProjectRole;

    if (!projectId || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }

    // The loader only offers projects of the request tenant, but the
    // id arrives in the body and the body is not the loader. Resolve it
    // inside the tenant before writing a membership row: `project_members`
    // carries no tenant of its own, so nothing downstream can catch a
    // foreign projectId later.
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.tenantId, tenant.id), eq(projects.id, projectId)))
      .limit(1)
      .all();
    if (!project) {
      throw new Response("Project not found", { status: 404 });
    }

    const existing = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, params.id)
        )
      )
      .limit(1)
      .all();
    if (existing.length > 0) {
      return { ok: false, error: i18n.t("user_admin:error_already_member") };
    }

    await db.insert(projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: params.id,
      role,
      createdAt: Math.floor(Date.now() / 1000),
    });

    return { ok: true, message: i18n.t("user_admin:success_assigned") };
  }

  /**
   * Resolve a membership id from the form back to a row that belongs
   * to THIS user AND to a project of the request tenant.
   * `project_members` carries no tenant column, so the owning
   * `projects` row is the only thing that can answer the tenant
   * question — the same reasoning `requireProjectRole` uses. Returns
   * the id, or 404s.
   */
  async function resolveMembershipId(membershipId: string): Promise<string> {
    const [membership] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.id, membershipId),
          eq(projectMembers.userId, params.id),
          eq(projects.tenantId, tenant.id)
        )
      )
      .limit(1)
      .all();
    if (!membership) {
      throw new Response("Membership not found", { status: 404 });
    }
    return membership.id;
  }

  if (intent === "changeRole") {
    const membershipId = formData.get("membershipId") as string;
    const role = formData.get("role") as ProjectRole;

    if (!membershipId || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }

    await db
      .update(projectMembers)
      .set({ role })
      .where(eq(projectMembers.id, await resolveMembershipId(membershipId)));

    return { ok: true, message: i18n.t("user_admin:success_role_updated") };
  }

  if (intent === "removeFromProject") {
    const membershipId = formData.get("membershipId") as string;
    if (!membershipId) return { ok: false, error: i18n.t("user_admin:error_invalid_request") };

    await db
      .delete(projectMembers)
      .where(eq(projectMembers.id, await resolveMembershipId(membershipId)));

    return { ok: true, message: i18n.t("user_admin:success_removed") };
  }

  return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

// Project-role chips follow the design system colour map: lead and cataloguer
// share verdigris (brand / approved / lead); reviewer is madder (the only
// system colour reserved for review and send-back actions). The previous
// assignment had lead, cataloguer, and reviewer scrambled across saffron,
// indigo, and verdigris and read inconsistently against the boundary markers
// in the IIIF viewer, where cataloguer = verdigris and reviewer = madder.
const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-verdigris-tint text-verdigris-deep",
  cataloguer: "bg-verdigris-tint text-verdigris-deep",
  reviewer: "bg-madder-tint text-madder-deep",
};

/**
 * One role toggle. `disabled` carries a `tooltip` with it: a checkbox
 * a caller cannot use should say why, and a disabled input is not
 * submitted at all, which is also the property the action relies on
 * to read a super-admin-only field in the body as tampering.
 */
function RoleCheckbox({
  label,
  description,
  name,
  checked,
  disabled,
  tooltip,
}: {
  label: string;
  description: string;
  name: string;
  checked: boolean;
  disabled?: boolean;
  tooltip?: string;
}) {
  return (
    <label
      title={disabled ? tooltip : undefined}
      className={`font-medium flex items-start gap-3 rounded-lg border border-stone-200 px-4 py-3 ${ disabled ? "opacity-60" : "hover:bg-stone-50 cursor-pointer" }`}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
      />
      <div>
        <div className="font-sans text-sm font-semibold text-stone-700">
          {label}
        </div>
        <div className="font-sans text-xs text-stone-500">{description}</div>
      </div>
    </label>
  );
}

export default function UserDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    targetUser: u,
    memberships,
    assignableProjects,
    isSelf,
    editableRoles,
    canEditRoles,
    canEditAllRoles,
    tenant,
  } = loaderData;
  const { t } = useTranslation("user_admin");
  const { formatDate } = useFormatters();
  const fetcher = useFetcher();
  const [showAssignForm, setShowAssignForm] = useState(false);

  const formData = fetcher.formData ?? undefined;
  const savingProfile = isPendingSubmission(
    fetcher.state,
    formData,
    "updateProfile",
  );
  const savingRoles = isPendingSubmission(fetcher.state, formData, "updateRoles");
  const assigning = isPendingSubmission(
    fetcher.state,
    formData,
    "assignToProject",
  );
  // Any in-flight submission clears the previous result, so a stale
  // error never sits under a retry that is already running.
  const submitting = fetcher.state !== "idle";

  // A role toggle is live only when the caller may assign that
  // particular flag and is not looking at their own account. The
  // tooltip explains which of the two rules is holding it shut.
  const roleFieldState = (name: RoleFlag) => {
    if (isSelf) {
      return { disabled: true, tooltip: t("self_role_badge_tooltip") };
    }
    if (!editableRoles.includes(name)) {
      return { disabled: true, tooltip: t("platform_role_tooltip") };
    }
    return { disabled: false, tooltip: undefined };
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-8 space-y-8">
      {/* Breadcrumb */}
      <nav className="font-sans text-sm text-stone-500">
        <Link to="/admin/users" className="hover:text-stone-700">
          {t("breadcrumb_system_users")}
        </Link>
        <span className="mx-2">&rsaquo;</span>
        <span className="text-stone-700">{u.name || u.email}</span>
      </nav>

      {/* Save feedback — transient on success, persistent on failure.
          One region for the whole page: every form shares one fetcher. */}
      <SaveFeedbackBanner
        source={fetcher.data}
        pending={submitting}
        labels={{
          success: t("common:save.saved"),
          error: t("common:save.failed"),
        }}
      />

      {/* Profile */}
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="_action" value="updateProfile" />
        <div className="flex gap-4">
          <div className="flex-1">
            <label
              htmlFor="user-name"
              className="mb-1 block font-sans text-xs font-medium text-indigo"
            >
              {t("name_label")}
            </label>
            <input
              id="user-name"
              type="text"
              name="name"
              defaultValue={u.name || ""}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
          <div className="flex-1">
            <label
              htmlFor="user-email"
              className="mb-1 block font-sans text-xs font-medium text-indigo"
            >
              {t("email_label")}
            </label>
            <input
              id="user-email"
              type="email"
              name="email"
              required
              defaultValue={u.email}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="font-sans text-xs text-stone-400">
            {t("last_login_label")}: {u.lastActiveAt ? formatDate(u.lastActiveAt) : t("never")}
            {" · "}
            {t("created_label")}: {formatDate(u.createdAt)}
          </p>
          <SaveButton
            pending={savingProfile}
            label={t("save_profile")}
            pendingLabel={t("common:save.saving")}
          />
        </div>
      </fetcher.Form>

      {/* Role edit warnings */}
      {isSelf && (
        <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3 font-sans text-sm text-stone-700">
          {t("self_warning")}
        </div>
      )}
      {!canEditRoles && !isSelf && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-500">
          {t("non_superadmin_notice")}
        </div>
      )}
      {canEditRoles && !canEditAllRoles && !isSelf && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-500">
          {t("tenant_admin_roles_notice")}
        </div>
      )}

      {/* Roles */}
      <fetcher.Form method="post">
        <input type="hidden" name="_action" value="updateRoles" />

        <div className="space-y-6">
          {/* System */}
          <div>
            <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
              {t("section_system")}
            </h2>
            <div className="space-y-2">
              <RoleCheckbox
                label={t("role_super_admin")}
                description={t("super_admin_description")}
                name="isSuperAdmin"
                checked={!!u.isSuperAdmin}
                {...roleFieldState("isSuperAdmin")}
              />
              <RoleCheckbox
                label={t("role_user_manager")}
                description={t("user_manager_description")}
                name="isUserManager"
                checked={!!u.isUserManager}
                {...roleFieldState("isUserManager")}
              />
            </div>
          </div>

          {/* Cataloguing — hidden entirely when crowdsourcing
              capability is off. Dormant DB values for
              `isCollabAdmin` / `isCataloguer` are not auto-cleared
              and the matching action helper skips writing them; the
              surface they gate (cataloguing routes) 404s at the
              parent layout's capability check. */}
          {tenant.crowdsourcingEnabled && (
            <div>
              <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
                {t("section_cataloguing")}
              </h2>
              <div className="space-y-2">
                <RoleCheckbox
                  label={t("role_cataloguing_admin")}
                  description={t("cataloguing_admin_description")}
                  name="isCollabAdmin"
                  checked={!!u.isCollabAdmin}
                  {...roleFieldState("isCollabAdmin")}
                />
                <RoleCheckbox
                  label={t("role_cataloguer")}
                  description={t("cataloguer_description")}
                  name="isCataloguer"
                  checked={!!u.isCataloguer}
                  {...roleFieldState("isCataloguer")}
                />
              </div>
            </div>
          )}

          {/* Records management */}
          <div>
            <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
              {t("section_records_management")}
            </h2>
            <div className="space-y-2">
              <RoleCheckbox
                label={t("role_records_admin")}
                description={t("records_admin_description")}
                name="isAdmin"
                checked={!!u.isAdmin}
                {...roleFieldState("isAdmin")}
              />
              <RoleCheckbox
                label={t("role_archive_user")}
                description={t("archive_user_description")}
                name="isArchiveUser"
                checked={!!u.isArchiveUser}
                {...roleFieldState("isArchiveUser")}
              />
            </div>
          </div>

          {canEditRoles && !isSelf && (
            <SaveButton
              pending={savingRoles}
              label={t("save_roles")}
              pendingLabel={t("common:save.saving")}
            />
          )}
        </div>
      </fetcher.Form>

      {/* Project memberships */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
            {t("section_project_memberships")}
          </h2>
          {assignableProjects.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAssignForm(!showAssignForm)}
              className="font-sans text-xs font-semibold text-indigo hover:text-indigo-deep"
            >
              {showAssignForm ? t("cancel") : t("assign_to_project")}
            </button>
          )}
        </div>

        {showAssignForm && (
          <fetcher.Form
            method="post"
            className="mb-4 flex items-end gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3"
            onSubmit={() => setTimeout(() => setShowAssignForm(false), 100)}
          >
            <input type="hidden" name="_action" value="assignToProject" />
            <div className="flex-1">
              <label className="mb-1 block font-sans text-xs font-medium text-indigo">
                {t("project_label")}
              </label>
              <select
                name="projectId"
                required
                className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              >
                <option value="">{t("select_project")}</option>
                {assignableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block font-sans text-xs font-medium text-indigo">
                {t("role_label")}
              </label>
              <select
                name="role"
                required
                className="rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              >
                <option value="">{t("select_role")}</option>
                <option value="lead">{t("role_lead")}</option>
                <option value="cataloguer">{t("role_cataloguer")}</option>
                <option value="reviewer">{t("role_reviewer")}</option>
              </select>
            </div>
            <SaveButton
              pending={assigning}
              label={t("assign")}
              pendingLabel={t("common:save.saving")}
            />
          </fetcher.Form>
        )}

        {memberships.length === 0 ? (
          <p className="rounded-lg border border-stone-200 px-4 py-6 text-center font-sans text-sm text-stone-400">
            {t("no_memberships")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("project_label")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("role_label")}
                  </th>
                  <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-stone-500">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {memberships.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3 font-sans text-sm font-semibold text-stone-700">
                      {m.projectName}
                    </td>
                    <td className="px-4 py-3">
                      <fetcher.Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="_action"
                          value="changeRole"
                        />
                        <input
                          type="hidden"
                          name="membershipId"
                          value={m.id}
                        />
                        <select
                          name="role"
                          defaultValue={m.role}
                          onChange={(e) => e.target.form?.requestSubmit()}
                          className="rounded-lg border border-stone-200 px-2 py-1 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
                        >
                          <option value="lead">{t("role_lead")}</option>
                          <option value="cataloguer">{t("role_cataloguer")}</option>
                          <option value="reviewer">{t("role_reviewer")}</option>
                        </select>
                      </fetcher.Form>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <fetcher.Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="_action"
                          value="removeFromProject"
                        />
                        <input
                          type="hidden"
                          name="membershipId"
                          value={m.id}
                        />
                        <button
                          type="submit"
                          className="font-sans text-xs text-stone-400 hover:text-indigo"
                          onClick={(e) => {
                            if (
                              !confirm(
                                t("remove_confirm", { project: m.projectName })
                              )
                            ) {
                              e.preventDefault();
                            }
                          }}
                        >
                          {t("remove")}
                        </button>
                      </fetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
