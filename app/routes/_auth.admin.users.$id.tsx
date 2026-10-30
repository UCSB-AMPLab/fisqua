/**
 * User Admin — Detail Page
 *
 * This page is the administrative surface for one person of the
 * request tenant. A header names them, with their email, when they
 * were last active and when they joined; the Profile section edits
 * name and email; then one section per area of the workspace —
 * Platform, Federation, Records management, Authorities, Cataloguing,
 * Digitization, Imports and exports — lists that area's roles as
 * checkboxes with a description each; and an Access history section
 * lists what `audit_log` records about the person's access.
 *
 * Which sections a viewer sees is decided in `loadUserDetailAccess`
 * (`app/lib/users-area.server.ts`), which reads nothing for a section
 * the viewer may not see: Platform for super admins and user managers,
 * Federation for stewards of the tenant's federation and super admins,
 * the workspace areas for workspace admins and super admins, and
 * Cataloguing also for user managers, who assign people to projects
 * there. An area the workspace does not have (its capability off) has
 * no section. Cataloguing carries the person's project memberships,
 * with the assign, change and remove controls; Digitization lists the
 * volumes they review with each one's state, and says that reviewers
 * are assigned on the Capture QC screen.
 *
 * Every role checkbox belongs to one form, `user-roles`, through its
 * `form` attribute, wherever its section puts it; every section holding
 * one the viewer may change has its own Save roles button for that
 * form. Who may change which role is decided in `permissions.server.ts`
 * and read twice, by the loader for the page and by the action for the
 * write:
 *
 *   - the ten role flags through `assignableRoleFlags`: a workspace
 *     admin (a federation steward's effective flags included) or a
 *     super admin changes the eight workspace roles, and only a super
 *     admin changes super admin and user manager. A flag of an area the
 *     workspace does not have (`writableRoleFlags`) is neither offered
 *     nor written, so a flag left from before the capability was
 *     switched off stays as it is;
 *   - the federation role through `canGrantSteward` (a super admin at
 *     home on the federation's lead workspace) and `canGrantStaff` (a
 *     federation steward, or the same super admin). Turning a steward
 *     into staff is a steward revoke. The two checkboxes clear each
 *     other in the browser and post one `federationRole`, none, staff
 *     or steward, as `federation_memberships` holds one role per person
 *     and federation.
 *
 * A federation steward with no workspace flag reaches the page too
 * (`canReachUsersArea`), for the Federation section alone: the loader
 * shows them no profile form, and the action admits them to
 * `updateRoles` only, where they have no role flag to give, so the
 * profile, the workspace roles and the project memberships stay with
 * those `canManageTenantUsers` admits.
 *
 * A checkbox the viewer may not change is disabled, with a tooltip that
 * says who may. What a checkbox shows and the baseline the page posts
 * beside it come from the same render (`reconcileShown`): when the
 * loader revalidates with a role someone else changed, the viewer's
 * unsaved choice for that role is dropped with the old baseline.
 * Nobody changes their own roles, and nobody changes roles during an
 * operator's impersonation session.
 *
 * The page posts, beside each role it lets the viewer change, the value
 * it showed (`shown_<flag>`, `federationRoleShown`). The action writes
 * only what changed, through `applyRoleChanges`
 * (`app/lib/access-changes.server.ts`): one batch in which every change
 * lands with its `audit_log` row only if everything the page showed
 * still holds, and nothing lands otherwise (`error_roles_changed`).
 * Removing the last workspace admin of the workspace is refused the
 * same way (`error_last_workspace_admin`). The project membership
 * intents record their changes in `audit_log` too
 * (`setProjectMembership`); a role change or a removal posts the role
 * the page showed (`shown_role`) and lands only while the membership
 * still holds it.
 *
 * The action treats the form body as hostile. It does not ask what the
 * form said about `isSuperAdmin`; it asks what the caller is allowed to
 * set, and refuses outright if the body carries a field outside that
 * set, or a federation change the caller may not make. A disabled
 * checkbox is not submitted by the browser, and the page posts no shown
 * value for it, so such a field never arrives from the rendered page —
 * its presence means the request was crafted.
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
 * owning project, the way `requireProjectRole` does it.
 *
 * `applyUpdateRoles`, in `_auth.admin.users.$id.roles.server.ts`,
 * reads the role part of the form and hands the changes to
 * `applyRoleChanges`. It lives in a server module so the client bundle
 * never reaches the server code it imports, and so the tests can drive
 * the write on its own, without the surrounding request.
 *
 * Every form on the page — profile, role flags, project assignment,
 * per-row role change and removal — shares ONE fetcher, so there is one
 * page-level `SaveFeedbackBanner` rather than one per form: a second
 * banner fed by the same fetcher would announce every result twice.
 * Each submit button keys its own pending state off the `_action` value
 * carried by the in-flight submission, so clicking "Save profile" does
 * not grey out "Save roles".
 *
 * @version v0.8.0
 */

import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
  type Tenant,
  type User,
} from "../context";
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
import type {
  AccessHistoryEntry,
  RoleView,
  UsersArea,
} from "../lib/users-area.server";
import type {
  AccessActor,
  FederationRoleChoice,
} from "../lib/access-changes.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");
  const {
    assignableRoleFlags,
    canGrantStaff,
    canGrantSteward,
    canManageTenantUsers,
    canReachUsersArea,
  } = await import("../lib/permissions.server");
  const { loadUserDetailAccess } = await import("../lib/users-area.server");
  const { writableRoleFlags } = await import("./_auth.admin.users.$id.roles.server");

  const currentUser = context.get(userContext);
  const tenant = context.get(tenantContext);
  const operatorSession = context.get(impersonationContext) !== null;

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // A federation steward with no workspace flag reaches the page for
  // its Federation section only (`canReachUsersArea`).
  if (!(await canReachUsersArea(db, currentUser, tenant))) {
    throw new Response("Forbidden", { status: 403 });
  }
  const manager = canManageTenantUsers(currentUser);

  const [targetUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.id, params.id)))
    .limit(1)
    .all();

  if (!targetUser) {
    throw new Response("User not found", { status: 404 });
  }

  const access = await loadUserDetailAccess(
    db,
    tenant,
    currentUser,
    targetUser,
    Date.now(),
  );

  // Project memberships in the request tenant's projects only, read
  // only when the Cataloguing section is shown. `project_members` has
  // no tenant column, so the scope comes through `projects`: a
  // steward's memberships in their home tenant's projects are not this
  // tenant's to show, and the actions below would refuse to change
  // them anyway.
  let memberships: Array<{
    id: string;
    projectId: string;
    projectName: string;
    role: ProjectRole;
    createdAt: number;
  }> = [];
  let assignableProjects: Array<{ id: string; name: string }> = [];
  if (access.sections.includes("cataloguing")) {
    memberships = await db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        projectName: projects.name,
        role: projectMembers.role,
        createdAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(
        and(
          eq(projectMembers.userId, params.id),
          eq(projects.tenantId, tenant.id),
        ),
      )
      .all();

    // The request tenant's live projects the person is not yet in.
    const memberProjectIds = new Set(memberships.map((m) => m.projectId));
    assignableProjects = (
      await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.tenantId, tenant.id), isNull(projects.archivedAt)))
        .all()
    ).filter((p) => !memberProjectIds.has(p.id));
  }

  // The exact set of role flags this caller may hand out in this
  // workspace. The JSX enables precisely these checkboxes and disables
  // the rest, so the form can never offer what the action would refuse.
  const editableRoles = writableRoleFlags(assignableRoleFlags(currentUser), tenant);

  // The federation roles this caller may change, read only when the
  // Federation section is shown.
  const federationEditable = access.sections.includes("federation")
    ? {
        steward: await canGrantSteward(db, currentUser, tenant),
        staff: await canGrantStaff(db, currentUser, tenant),
      }
    : { steward: false, staff: false };

  return {
    // Profile fields only: each section's flags travel in `roles`, and
    // only for the sections this viewer sees.
    targetUser: {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      lastActiveAt: targetUser.lastActiveAt,
      createdAt: targetUser.createdAt,
    },
    ...access,
    memberships,
    assignableProjects,
    isSelf: currentUser.id === params.id,
    operatorSession,
    // The profile form, and the notice about who changes roles, belong
    // to those who manage the workspace's users.
    canManageUser: manager,
    editableRoles,
    federationEditable,
    canEditRoles: editableRoles.length > 0,
    // True only for a caller who may set every flag the form can show.
    // Drives the "some roles are not yours to give" notice rather than
    // the blanket "roles are read-only" one.
    canEditAllRoles: currentUser.isSuperAdmin,
  };
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
    canReachUsersArea,
    unassignableSubmittedRoleFlags,
  } = await import("../lib/permissions.server");
  const { applyUpdateRoles } = await import("./_auth.admin.users.$id.roles.server");
  const currentUser = context.get(userContext);
  const i18n = getInstance(context);
  const tenant = context.get(tenantContext);
  const impersonation = context.get(impersonationContext);
  const grant = context.get(grantContext);
  const actor: AccessActor = {
    user: currentUser,
    homeTenantId: grant?.homeTenantId ?? currentUser.tenantId,
    impersonationSessionId: impersonation?.sessionId ?? null,
  };
  const newId = () => crypto.randomUUID();

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  // Whoever manages the workspace's users reaches every intent. A
  // federation steward with no workspace flag reaches `updateRoles`
  // alone, where `assignableRoleFlags` gives them no flag, so all they
  // can change is the federation role.
  if (
    !canManageTenantUsers(currentUser) &&
    !(intent === "updateRoles" && (await canReachUsersArea(db, currentUser, tenant)))
  ) {
    throw new Response(i18n.t("user_admin:error_forbidden"), { status: 403 });
  }

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
    // Operators in an impersonation session grant and revoke nothing.
    if (impersonation) {
      return { ok: false, error: i18n.t("user_admin:error_operator_no_grants") };
    }
    // Nobody edits their own roles, however many they can hand out.
    if (currentUser.id === params.id) {
      return { ok: false, error: i18n.t("user_admin:error_cannot_change_own_roles") };
    }
    const assignableFlags = assignableRoleFlags(currentUser);
    if (assignableFlags.length === 0 && !formData.has("federationRole")) {
      return { ok: false, error: i18n.t("user_admin:non_superadmin_notice") };
    }

    // The form is hostile until proven otherwise. A checkbox the page
    // rendered disabled is not submitted at all, so a super-admin-only
    // field in the body of a workspace admin's post is a crafted
    // request, not a stray unchecked box — refuse the whole submission.
    const refused = unassignableSubmittedRoleFlags(currentUser, formData);
    if (refused.length > 0) {
      return { ok: false, error: i18n.t("user_admin:error_role_not_assignable") };
    }

    const result = await applyUpdateRoles({
      db,
      d1: env.DB,
      tenant,
      targetUserId: params.id,
      formData,
      assignableFlags,
      currentUser,
      actor,
      now: Date.now(),
      newId,
    });
    if (!result.ok) {
      return { ok: false, error: i18n.t(`user_admin:error_${result.error}`) };
    }
    return { ok: true, message: i18n.t("user_admin:success_roles_updated") };
  }

  const { setProjectMembership } = await import("../lib/access-changes.server");

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

    const added = await setProjectMembership({
      d1: env.DB,
      tenantId: tenant.id,
      targetUserId: params.id,
      change: { step: "added", projectId, role },
      actor,
      now: Date.now(),
      newId,
    });
    if (!added) {
      return { ok: false, error: i18n.t("user_admin:error_already_member") };
    }

    return { ok: true, message: i18n.t("user_admin:success_assigned") };
  }

  /**
   * Resolve a membership id from the form back to a row that belongs
   * to THIS user AND to a project of the request tenant.
   * `project_members` carries no tenant column, so the owning
   * `projects` row is the only thing that can answer the tenant
   * question — the same reasoning `requireProjectRole` uses. Returns
   * the membership, or 404s.
   */
  async function resolveMembership(
    membershipId: string,
  ): Promise<{ id: string; projectId: string; role: ProjectRole }> {
    const [membership] = await db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        role: projectMembers.role,
      })
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
    return membership;
  }

  if (intent === "changeRole") {
    const membershipId = formData.get("membershipId") as string;
    const role = formData.get("role") as ProjectRole;
    // The role the page showed: the change lands only while the
    // membership still holds it.
    const shownRole = formData.get("shown_role") as ProjectRole;

    if (!membershipId || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }

    const membership = await resolveMembership(membershipId);
    if (!(PROJECT_ROLES as readonly string[]).includes(shownRole)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }
    if (shownRole !== role) {
      const changed = await setProjectMembership({
        d1: env.DB,
        tenantId: tenant.id,
        targetUserId: params.id,
        change: {
          step: "changed",
          membershipId: membership.id,
          projectId: membership.projectId,
          shown: shownRole,
          role,
        },
        actor,
        now: Date.now(),
        newId,
      });
      if (!changed) {
        return { ok: false, error: i18n.t("user_admin:error_roles_changed") };
      }
    }

    return { ok: true, message: i18n.t("user_admin:success_role_updated") };
  }

  if (intent === "removeFromProject") {
    const membershipId = formData.get("membershipId") as string;
    // The role the page showed for the membership: the removal lands
    // only while the membership still holds it, so the audit row
    // records the role that was removed.
    const shownRole = formData.get("shown_role") as ProjectRole;
    if (!membershipId) return { ok: false, error: i18n.t("user_admin:error_invalid_request") };

    const membership = await resolveMembership(membershipId);
    if (!(PROJECT_ROLES as readonly string[]).includes(shownRole)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }
    const removed = await setProjectMembership({
      d1: env.DB,
      tenantId: tenant.id,
      targetUserId: params.id,
      change: {
        step: "removed",
        membershipId: membership.id,
        projectId: membership.projectId,
        role: shownRole,
      },
      actor,
      now: Date.now(),
      newId,
    });
    if (!removed) {
      return { ok: false, error: i18n.t("user_admin:error_roles_changed") };
    }

    return { ok: true, message: i18n.t("user_admin:success_removed") };
  }

  return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The id of the one form every role checkbox belongs to. */
const ROLES_FORM_ID = "user-roles";

/**
 * A role control's state: `shown`, the value the loader gave, which the
 * form posts as the baseline the action checks; and `value`, what the
 * control shows. Both come from the same render.
 */
export interface ShownState<T> {
  shown: T;
  value: T;
}

/**
 * The state to render with `shown` from the loader. While the loader
 * gives the same value, the viewer's unsaved choice stands. When it
 * gives another (the page revalidated after someone changed the role),
 * the choice is dropped and the control shows the new value, so a save
 * never posts a fresh baseline beside a stale choice.
 */
export function reconcileShown<T>(state: ShownState<T>, shown: T): ShownState<T> {
  return Object.is(state.shown, shown) ? state : { shown, value: shown };
}

/** `reconcileShown` as component state: the value shown, the baseline, and a setter. */
function useShownValue<T>(shown: T): [T, T, (value: T) => void] {
  const [state, setState] = useState<ShownState<T>>({ shown, value: shown });
  const current = reconcileShown(state, shown);
  // Adjusting state while rendering: React renders again at once with
  // the reconciled state, before anything reaches the screen.
  if (current !== state) setState(current);
  return [current.value, current.shown, (value) => setState({ shown: current.shown, value })];
}

/**
 * One role toggle. `disabled` carries a `tooltip` with it: a checkbox
 * a caller cannot use should say why, and a disabled input is not
 * submitted at all, which is also the property the action relies on
 * to read a super-admin-only field in the body as tampering.
 *
 * With a `name`, the checkbox joins the roles form and, when enabled,
 * posts beside itself the value the page showed (`shown_<name>`); what
 * it shows and that baseline come from `useShownValue`, so they move
 * together when the loader revalidates. With `onChange` the parent
 * holds its state, and it joins no form: the federation pair posts one
 * value of its own.
 */
function RoleCheckbox({
  label,
  description,
  name,
  checked,
  disabled,
  tooltip,
  onChange,
}: {
  label: string;
  description: string;
  name?: string;
  checked: boolean;
  disabled?: boolean;
  tooltip?: string;
  onChange?: (checked: boolean) => void;
}) {
  const [value, shown, setValue] = useShownValue(checked);
  return (
    <label
      title={disabled ? tooltip : undefined}
      className={`flex items-start gap-3 rounded-lg border border-stone-200 px-4 py-3 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-stone-50"}`}
    >
      <input
        type="checkbox"
        name={name}
        form={name ? ROLES_FORM_ID : undefined}
        {...(onChange
          ? { checked, onChange: (e) => onChange(e.target.checked) }
          : { checked: value, onChange: (e) => setValue(e.target.checked) })}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
      />
      {name && !disabled && (
        <input
          type="hidden"
          name={`shown_${name}`}
          form={ROLES_FORM_ID}
          value={shown ? "1" : "0"}
        />
      )}
      <span className="flex flex-col gap-0.5">
        <span className="font-sans text-sm font-semibold text-indigo">
          {label}
        </span>
        <span className="font-sans text-xs text-stone-500">{description}</span>
      </span>
      {disabled && tooltip && <span className="sr-only">{tooltip}</span>}
    </label>
  );
}

const TH = "px-4 py-2.5 text-left font-sans text-xs font-semibold text-stone-600";

export default function UserDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    targetUser: u,
    sections,
    roles,
    federation,
    reviewedVolumes,
    history,
    memberships,
    assignableProjects,
    isSelf,
    operatorSession,
    canManageUser,
    editableRoles,
    federationEditable,
    canEditRoles,
    canEditAllRoles,
  } = loaderData;
  const { t } = useTranslation(["user_admin", "capture"]);
  const { formatDate } = useFormatters();
  const fetcher = useFetcher();
  const [showAssignForm, setShowAssignForm] = useState(false);
  // The federation role the checkboxes show: one of none, staff and
  // steward, as `federation_memberships` holds one role per person.
  const [federationRole, shownFederationRole, setFederationRole] =
    useShownValue<FederationRoleChoice>(federation?.role ?? "none");

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

  // A role toggle is live only when the caller may assign that flag,
  // is not looking at their own account and is not in an operator
  // session. The tooltip explains which rule holds it shut.
  const lockedFor = (): string | null =>
    isSelf
      ? t("self_role_badge_tooltip")
      : operatorSession
        ? t("error_operator_no_grants")
        : null;
  const roleFieldState = (role: RoleView) => {
    const locked = lockedFor();
    if (locked) return { disabled: true, tooltip: locked };
    if (role.field === null || !editableRoles.includes(role.field)) {
      // Platform roles are a super admin's to grant; every other role,
      // a workspace admin's.
      const platform = role.field === "isSuperAdmin" || role.field === "isUserManager";
      return {
        disabled: true,
        tooltip: t(platform ? "platform_role_tooltip" : "workspace_role_tooltip"),
      };
    }
    return { disabled: false, tooltip: undefined };
  };
  // The federation pair. Steward needs `canGrantSteward`; staff needs
  // `canGrantStaff`, and, while the person is a steward, also
  // `canGrantSteward`, since checking staff then revokes the steward.
  const federationFieldState = (key: RoleView["key"]) => {
    const locked = lockedFor();
    if (locked) return { disabled: true, tooltip: locked };
    if (key === "steward" || federationRole === "steward") {
      if (!federationEditable.steward) {
        return { disabled: true, tooltip: t("steward_grant_tooltip") };
      }
    }
    if (key === "staff" && !federationEditable.staff) {
      return { disabled: true, tooltip: t("staff_grant_tooltip") };
    }
    return { disabled: false, tooltip: undefined };
  };
  const fieldState = (area: UsersArea, role: RoleView) =>
    area === "federation" ? federationFieldState(role.key) : roleFieldState(role);
  const sectionEditable = (area: UsersArea, list: RoleView[]) =>
    list.some((r) => !fieldState(area, r).disabled);
  const federationLive = sectionEditable("federation", roles.federation ?? []);

  const sectionScope = (area: UsersArea) =>
    area === "platform"
      ? t("scope_platform")
      : area === "federation"
        ? federation?.name ?? ""
        : t("scope_workspace");

  const name = u.name || u.email;

  // One access-history entry as a sentence. Every role named in an
  // entry has its label under `role_<key>`.
  const historyLine = (entry: AccessHistoryEntry) =>
    t(`history_${entry.kind}`, {
      role: "role" in entry ? t(`role_${entry.role}`) : undefined,
      actor: "actor" in entry ? entry.actor : undefined,
      project: "project" in entry ? entry.project : undefined,
    });

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-8 py-8">
      <div className="space-y-1.5">
        <Link
          to="/admin/users"
          className="font-sans text-sm text-stone-600 hover:underline"
        >
          {t("sidebar:users")}
        </Link>
        <h1 className="font-serif text-3xl font-medium text-indigo">{name}</h1>
        <p className="font-sans text-sm text-stone-600">
          {u.email}
          {" · "}
          {u.lastActiveAt
            ? t("last_active_on", { date: formatDate(u.lastActiveAt) })
            : t("never_active")}
          {" · "}
          {t("joined_on", { date: formatDate(u.createdAt) })}
        </p>
      </div>

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

      {/* Profile, for those who manage the workspace's users */}
      {canManageUser && (
        <section
          aria-labelledby="section-profile"
          className="space-y-4 rounded-lg border border-stone-200 p-6"
        >
          <h2
            id="section-profile"
            className="font-serif text-xl font-medium text-indigo"
          >
            {t("section_profile")}
          </h2>
          <fetcher.Form method="post" className="space-y-4">
            <input type="hidden" name="_action" value="updateProfile" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="user-name"
                  className="font-sans text-sm font-medium text-indigo"
                >
                  {t("name_label")}
                </label>
                <input
                  id="user-name"
                  type="text"
                  name="name"
                  defaultValue={u.name || ""}
                  className="rounded-md border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="user-email"
                  className="font-sans text-sm font-medium text-indigo"
                >
                  {t("email_label")}
                </label>
                <input
                  id="user-email"
                  type="email"
                  name="email"
                  required
                  defaultValue={u.email}
                  className="rounded-md border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
            </div>
            <SaveButton
              pending={savingProfile}
              label={t("save_profile")}
              pendingLabel={t("common:save.saving")}
            />
          </fetcher.Form>
        </section>
      )}

      {/* Role edit warnings */}
      {isSelf && (
        <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3 font-sans text-sm text-stone-700">
          {t("self_warning")}
        </div>
      )}
      {operatorSession && !isSelf && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-600">
          {t("error_operator_no_grants")}
        </div>
      )}
      {!canEditRoles && canManageUser && !isSelf && !operatorSession && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-600">
          {t("non_superadmin_notice")}
        </div>
      )}
      {canEditRoles && !canEditAllRoles && !isSelf && !operatorSession && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-600">
          {t("tenant_admin_roles_notice")}
        </div>
      )}

      {/* The one form every role checkbox belongs to, wherever its
          section puts it. The federation pair posts one value here, with
          the value the page showed, when the caller may change it. */}
      <fetcher.Form method="post" id={ROLES_FORM_ID} className="hidden">
        <input type="hidden" name="_action" value="updateRoles" />
        {federationLive && (
          <>
            <input type="hidden" name="federationRole" value={federationRole} />
            <input
              type="hidden"
              name="federationRoleShown"
              value={shownFederationRole}
            />
          </>
        )}
      </fetcher.Form>

      {sections.map((area) => {
        const list = roles[area] ?? [];
        return (
          <section
            key={area}
            aria-labelledby={`section-${area}`}
            className="space-y-4 rounded-lg border border-stone-200 p-6"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2
                id={`section-${area}`}
                className="font-serif text-xl font-medium text-indigo"
              >
                {t(`area_${area}`)}
              </h2>
              <span className="font-sans text-xs text-stone-600">
                {sectionScope(area)}
              </span>
            </div>

            <div className="space-y-2">
              {list.map((role) =>
                area === "federation" ? (
                  <RoleCheckbox
                    key={role.key}
                    label={t(`role_${role.key}`)}
                    description={t(`${role.key}_description`)}
                    checked={federationRole === role.key}
                    onChange={(on) =>
                      setFederationRole(
                        on ? (role.key as FederationRoleChoice) : "none",
                      )
                    }
                    {...federationFieldState(role.key)}
                  />
                ) : (
                  <RoleCheckbox
                    key={role.key}
                    label={t(`role_${role.key}`)}
                    description={t(`${role.key}_description`)}
                    name={role.field ?? undefined}
                    checked={role.checked}
                    {...roleFieldState(role)}
                  />
                ),
              )}
            </div>

            {sectionEditable(area, list) && (
              <SaveButton
                form={ROLES_FORM_ID}
                pending={savingRoles}
                label={t("save_roles")}
                pendingLabel={t("common:save.saving")}
              />
            )}

            {area === "cataloguing" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-sans text-sm font-semibold text-indigo">
                    {t("projects_heading")}
                  </h3>
                  {assignableProjects.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAssignForm(!showAssignForm)}
                      className="font-sans text-sm font-semibold text-indigo hover:underline"
                    >
                      {showAssignForm ? t("cancel") : t("assign_to_project")}
                    </button>
                  )}
                </div>
                {showAssignForm && (
                  <fetcher.Form
                    method="post"
                    className="flex flex-wrap items-end gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3"
                    onSubmit={() => setTimeout(() => setShowAssignForm(false), 100)}
                  >
                    <input type="hidden" name="_action" value="assignToProject" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <label
                        htmlFor="assign-project"
                        className="font-sans text-sm font-medium text-indigo"
                      >
                        {t("project_label")}
                      </label>
                      <select
                        id="assign-project"
                        name="projectId"
                        required
                        className="rounded-md border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                      >
                        <option value="">{t("select_project")}</option>
                        {assignableProjects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label
                        htmlFor="assign-role"
                        className="font-sans text-sm font-medium text-indigo"
                      >
                        {t("role_label")}
                      </label>
                      <select
                        id="assign-role"
                        name="role"
                        required
                        className="rounded-md border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
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
                  <p className="font-sans text-sm text-stone-500">
                    {t("no_memberships")}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-stone-200">
                    <table className="w-full min-w-[480px] border-collapse">
                      <thead className="bg-stone-50">
                        <tr className="border-b border-stone-200">
                          <th scope="col" className={TH}>
                            {t("project_label")}
                          </th>
                          <th scope="col" className={TH}>
                            {t("col_project_role")}
                          </th>
                          <th scope="col" className={`${TH} text-right`}>
                            <span className="sr-only">{t("col_actions")}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100">
                        {memberships.map((m) => (
                          <tr key={m.id}>
                            <td className="px-4 py-2.5 font-sans text-sm font-semibold text-indigo">
                              {m.projectName}
                            </td>
                            <td className="px-4 py-2.5">
                              <fetcher.Form method="post" className="inline">
                                <input type="hidden" name="_action" value="changeRole" />
                                <input type="hidden" name="membershipId" value={m.id} />
                                <input type="hidden" name="shown_role" value={m.role} />
                                {/* Keyed on the role, so a revalidation that
                                    brings another role shows it beside the
                                    baseline it posts. */}
                                <select
                                  key={m.role}
                                  name="role"
                                  aria-label={t("project_role_for", { project: m.projectName })}
                                  defaultValue={m.role}
                                  onChange={(e) => e.target.form?.requestSubmit()}
                                  className="rounded-md border border-stone-200 bg-white px-2 py-1 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                                >
                                  <option value="lead">{t("role_lead")}</option>
                                  <option value="cataloguer">{t("role_cataloguer")}</option>
                                  <option value="reviewer">{t("role_reviewer")}</option>
                                </select>
                              </fetcher.Form>
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <fetcher.Form method="post" className="inline">
                                <input type="hidden" name="_action" value="removeFromProject" />
                                <input type="hidden" name="membershipId" value={m.id} />
                                <input type="hidden" name="shown_role" value={m.role} />
                                <button
                                  type="submit"
                                  className="font-sans text-sm text-indigo hover:underline"
                                  onClick={(e) => {
                                    if (!confirm(t("remove_confirm", { project: m.projectName }))) {
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
            )}

            {area === "digitization" && reviewedVolumes && (
              <div className="space-y-3">
                {reviewedVolumes.length === 0 ? (
                  <p className="font-sans text-sm text-stone-500">
                    {t("no_reviewed_volumes")}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-stone-200">
                    <table className="w-full min-w-[480px] border-collapse">
                      <thead className="bg-stone-50">
                        <tr className="border-b border-stone-200">
                          <th scope="col" className={TH}>
                            {t("col_volume_reviewed")}
                          </th>
                          <th scope="col" className={TH}>
                            {t("col_status")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100">
                        {reviewedVolumes.map((v) => (
                          <tr key={v.volumeId}>
                            <td className="px-4 py-2.5 font-mono text-[13px] text-indigo">
                              {v.referenceCode}
                            </td>
                            <td className="px-4 py-2.5 font-sans text-sm text-stone-600">
                              {v.state ? t(`capture:state.${v.state}`) : "\u2014"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="font-sans text-sm text-stone-600">
                  {t("reviewers_assigned_note")}
                </p>
              </div>
            )}
          </section>
        );
      })}

      {/* Access history */}
      <section
        aria-labelledby="section-history"
        className="space-y-3 rounded-lg border border-stone-200 p-6"
      >
        <h2
          id="section-history"
          className="font-serif text-xl font-medium text-indigo"
        >
          {t("section_access_history")}
        </h2>
        {history.length === 0 ? (
          <p className="font-sans text-sm text-stone-500">{t("history_empty")}</p>
        ) : (
          <ul className="space-y-2">
            {history.map((entry, i) => (
              <li
                key={`${entry.kind}-${i}`}
                className="flex flex-wrap justify-between gap-2 font-sans text-sm text-stone-700"
              >
                <span>{historyLine(entry)}</span>
                <span className="text-stone-600">{formatDate(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// @version v0.8.0
