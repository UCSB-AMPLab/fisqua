/**
 * User Admin — List
 *
 * This page is the directory of the people in the request tenant,
 * described by area of the workspace. A line under the heading names
 * the workspace and counts its people and the people from its
 * federation; a search (name or email) and an area filter narrow both
 * tables; a legend explains the two badge styles, one for a person who
 * administers an area and one for a person who works in it; each badge
 * also carries the legend's words for its kind, read by screen readers
 * and shown as a tooltip, so the kind does not rest on colour. Each row of
 * the first table links to the user detail page. The badges, the
 * counts and the second table, "From [federation]", come from
 * `loadUsersList` (`app/lib/users-area.server.ts`), which holds the
 * mapping from flags, memberships and reviewer assignments to badges.
 *
 * The second table lists members of other workspaces who hold a
 * membership in this workspace's federation, with their home workspace
 * and their access here. It is read-only and has no links: their
 * profiles belong to their own workspace, and the detail page reads
 * only this tenant's users.
 *
 * Search and filter travel in the URL (`?q=` and `?area=`), so a
 * filtered view can be linked to; `/admin/cataloguing/users` redirects
 * here with `?area=cataloguing`. The search form is a plain GET form.
 *
 * Reaching it takes `canReachUsersArea`: a super admin, a user manager
 * or a workspace admin (`canManageTenantUsers`), or a steward of the
 * workspace's federation, who grants and revokes staff on the detail
 * page. Only the first three invite people; a steward without a
 * workspace flag is not offered the invitation. Area admins do not
 * reach the page: the users area stays with the workspace admin.
 *
 * Last active is `users.last_active_at`, which the auth middleware
 * stamps at most every five minutes while someone uses the app.
 *
 * The invite modal carries an opening-role picker, shown only to a
 * caller who may assign the tenant-scoped roles. It offers "no role",
 * Workspace admin, Records admin, the admins of the areas the workspace
 * has (Authorities, Digitization, Imports and exports) and Reader; the
 * platform roles are not on offer here and the action refuses them
 * regardless of what the body says. Each option is labelled with the
 * role's name on the user detail page.
 *
 * Invite feedback runs through the shared `SaveFeedbackBanner` /
 * `SaveButton` pair. The banner sits on the page rather than inside
 * the invite modal because the modal closes on submit — a result
 * rendered inside it would be unmounted before it could be read.
 *
 * @version v0.8.0
 */

import { useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
} from "../context";
import { useFormatters } from "../lib/use-formatters";
import {
  SaveButton,
  SaveFeedbackBanner,
  isPendingSubmission,
} from "~/components/admin/save-feedback";
import type { Route } from "./+types/_auth.admin.users";
// Type-only: erased at build time, so the server module is not pulled
// into the client bundle.
import type { AreaBadge, UsersArea } from "../lib/users-area.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { canAssignTenantRoles, canManageTenantUsers, canReachUsersArea } =
    await import("../lib/permissions.server");
  const { loadUsersList, parseAreaFilter } = await import(
    "../lib/users-area.server"
  );

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);
  if (!(await canReachUsersArea(db, user, tenant))) {
    throw new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const area = parseAreaFilter(url.searchParams.get("area"));
  const list = await loadUsersList(db, tenant, { query, area });

  return {
    ...list,
    query,
    area,
    // Drives the invite modal's role picker. A caller who cannot hand
    // out the tenant-scoped roles is not offered the field at all,
    // rather than shown a control whose every value the action refuses.
    canAssignTenantRoles: canAssignTenantRoles(user),
    // The invitation stays with those who manage the workspace's users.
    canInvite: canManageTenantUsers(user),
  };
}

// ---------------------------------------------------------------------------
// Action — invite user only (role management moved to detail page)
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { canManageTenantUsers } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  if (!canManageTenantUsers(user)) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "inviteUser") {
    const { handleUsersAction } = await import(
      "./_auth.admin.users.action.server"
    );
    const i18n = await import("i18next");
    const origin = new URL(request.url).origin;
    return handleUsersAction(user, tenant, db, formData, env, i18n, origin, {
      homeTenantId: context.get(grantContext)?.homeTenantId ?? user.tenantId,
      impersonationSessionId: context.get(impersonationContext)?.sessionId ?? null,
    });
  }

  // No `error` text: the branch is not reachable from the UI, so the
  // feedback banner falls back to the localised "not saved" line
  // rather than surfacing an untranslated developer string.
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The two badge styles: the admin pair and the draft pair of the status palette. */
const BADGE_STYLES: Record<AreaBadge["kind"], string> = {
  administers: "bg-indigo-tint text-indigo",
  works: "bg-stone-100 text-stone-600",
};

const BADGE_BASE =
  "inline-flex items-center rounded-full px-2.5 py-0.5 font-sans text-[11px] font-semibold uppercase tracking-[0.02em]";

/**
 * The label of a badge: the area's name, except the Records management
 * badge of someone who only works there, whose one working role is the
 * Reader and which says so.
 */
function badgeLabel(badge: AreaBadge, t: (key: string) => string): string {
  if (badge.area === "records" && badge.kind === "works") return t("user_admin:badge_reader");
  return t(`user_admin:area_${badge.area}`);
}

/**
 * One area badge. Its colour pair says whether the person administers
 * the area or works in it; the same words as the legend follow the
 * label for screen readers and show as a tooltip, so the kind is never
 * carried by colour alone.
 */
function Badge({
  badge,
  label,
  kindLabel,
}: {
  badge: AreaBadge;
  label: string;
  kindLabel: string;
}) {
  return (
    <span className={`${BADGE_BASE} ${BADGE_STYLES[badge.kind]}`} title={kindLabel}>
      {label}
      <span className="sr-only">, {kindLabel}</span>
    </span>
  );
}

const TH =
  "px-4 py-2.5 text-left font-sans text-xs font-semibold text-stone-600";

export default function SystemUsersPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    workspaceName,
    federationName,
    peopleCount,
    federationPeopleCount,
    areas,
    people,
    federationPeople,
    query,
    area,
    canAssignTenantRoles,
    canInvite,
  } = loaderData;
  const { t } = useTranslation(["user_admin", "sidebar", "admin"]);
  const { formatDate } = useFormatters();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const inviteFetcher = useFetcher();

  const inviting = isPendingSubmission(
    inviteFetcher.state,
    inviteFetcher.formData ?? undefined,
    "inviteUser",
  );

  const summary = [
    t("user_admin:people_count", { count: peopleCount }),
    federationPeopleCount > 0 && federationName
      ? t("user_admin:federation_people_count", {
          number: federationPeopleCount,
          federation: federationName,
        })
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  const filtered = query.trim() !== "" || area !== null;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-8 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-serif text-3xl font-medium text-indigo">
            {t("sidebar:users")}
          </h1>
          <p className="font-sans text-sm text-stone-600">
            {workspaceName} · {summary}
          </p>
        </div>
        {canInvite && (
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("sidebar:invite_user")}
          </button>
        )}
      </div>

      {/* Save feedback — transient on success, persistent on failure. */}
      <SaveFeedbackBanner
        source={inviteFetcher.data}
        pending={inviting}
        labels={{
          success: t("common:save.saved"),
          error: t("common:save.failed"),
        }}
      />

      {showInviteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowInviteModal(false)}
        >
          <div
            role="dialog"
            aria-labelledby="invite-modal-title"
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="invite-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("sidebar:invite_user")}
            </h2>
            <p className="mt-1 font-sans text-sm text-stone-500">
              {t("sidebar:invite_description")}
            </p>
            <inviteFetcher.Form
              method="post"
              className="mt-4 space-y-4"
              onSubmit={() => setShowInviteModal(false)}
            >
              <input type="hidden" name="_action" value="inviteUser" />
              <div>
                <label
                  htmlFor="invite-name"
                  className="mb-1 block font-sans text-xs font-medium text-indigo"
                >
                  {t("sidebar:col_name")}
                </label>
                <input
                  id="invite-name"
                  type="text"
                  name="name"
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div>
                <label
                  htmlFor="invite-email"
                  className="mb-1 block font-sans text-xs font-medium text-indigo"
                >
                  {t("sidebar:col_email")} <span className="text-madder">*</span>
                </label>
                <input
                  id="invite-email"
                  type="email"
                  name="email"
                  required
                  placeholder={t("admin:placeholder.email")}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              {/* Opening role. Only the workspace roles are on offer,
                  an area's admin only where the workspace has the area,
                  and only to a caller who may assign them — the same
                  split `assignableRoleFlags` enforces server-side.
                  Without a role the invited user lands on an empty
                  dashboard. */}
              {canAssignTenantRoles && (
                <div>
                  <label
                    htmlFor="invite-role"
                    className="mb-1 block font-sans text-xs font-medium text-indigo"
                  >
                    {t("user_admin:invite_role_label")}
                  </label>
                  <select
                    id="invite-role"
                    name="role"
                    defaultValue="none"
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                  >
                    <option value="none">
                      {t("user_admin:invite_role_none")}
                    </option>
                    <option value="workspace_admin">
                      {t("user_admin:role_workspace_admin")}
                    </option>
                    <option value="records_admin">
                      {t("user_admin:role_records_admin")}
                    </option>
                    {areas.includes("authorities") && (
                      <option value="authorities_admin">
                        {t("user_admin:role_authorities_admin")}
                      </option>
                    )}
                    {areas.includes("digitization") && (
                      <option value="digitization_admin">
                        {t("user_admin:role_digitization_admin")}
                      </option>
                    )}
                    {areas.includes("imports") && (
                      <option value="imports_admin">
                        {t("user_admin:role_imports_admin")}
                      </option>
                    )}
                    <option value="archive_user">
                      {t("user_admin:role_archive_user")}
                    </option>
                  </select>
                  <p className="mt-1 font-sans text-xs text-stone-400">
                    {t("user_admin:invite_role_hint")}
                  </p>
                </div>
              )}
              <div className="flex justify-end gap-3 border-t border-stone-200 pt-4">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="rounded-md border border-stone-200 px-4 py-2 font-sans text-sm font-semibold text-stone-700 hover:bg-stone-50"
                >
                  {t("admin:action.cancel")}
                </button>
                <SaveButton
                  pending={inviting}
                  label={t("sidebar:send_invite")}
                  pendingLabel={t("common:save.saving")}
                />
              </div>
            </inviteFetcher.Form>
          </div>
        </div>
      )}

      <Form
        method="get"
        role="search"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5">
          <label
            htmlFor="users-q"
            className="font-sans text-sm font-medium text-indigo"
          >
            {t("user_admin:search_label")}
          </label>
          <input
            id="users-q"
            type="search"
            name="q"
            defaultValue={query}
            placeholder={t("user_admin:search_placeholder")}
            className="rounded-md border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
        </div>
        <div className="flex min-w-0 flex-[0_1_240px] flex-col gap-1.5">
          <label
            htmlFor="users-area"
            className="font-sans text-sm font-medium text-indigo"
          >
            {t("user_admin:area_label")}
          </label>
          <select
            id="users-area"
            name="area"
            defaultValue={area ?? ""}
            className="rounded-md border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-indigo focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{t("user_admin:area_all")}</option>
            {areas.map((a: UsersArea) => (
              <option key={a} value={a}>
                {t(`user_admin:area_${a}`)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md border border-stone-200 bg-white px-4 py-2 font-sans text-sm font-semibold text-indigo hover:bg-stone-50"
        >
          {t("common:label.search")}
        </button>
      </Form>

      <div className="flex flex-wrap items-center gap-4 font-sans text-xs text-stone-600">
        <span className="inline-flex items-center gap-1.5">
          <span className={`${BADGE_BASE} ${BADGE_STYLES.administers}`}>
            {t("user_admin:legend_area")}
          </span>
          {t("user_admin:legend_administers")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${BADGE_BASE} ${BADGE_STYLES.works}`}>
            {t("user_admin:legend_area")}
          </span>
          {t("user_admin:legend_works")}
        </span>
      </div>

      {people.length === 0 ? (
        <p className="font-sans text-sm text-stone-500">
          {filtered ? t("user_admin:no_matches") : t("sidebar:no_users")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[760px] border-collapse">
            <thead className="bg-stone-50">
              <tr className="border-b border-stone-200">
                <th scope="col" className={TH}>
                  {t("sidebar:col_name")}
                </th>
                <th scope="col" className={TH}>
                  {t("sidebar:col_email")}
                </th>
                <th scope="col" className={TH}>
                  {t("user_admin:col_access")}
                </th>
                <th scope="col" className={`${TH} whitespace-nowrap`}>
                  {t("user_admin:col_last_active")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {people.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3">
                    <Link
                      to={`/admin/users/${u.id}`}
                      className="font-sans text-sm font-semibold text-indigo hover:underline"
                    >
                      {u.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-sans text-sm text-stone-600">
                    {u.email}
                  </td>
                  <td className="px-4 py-3">
                    {u.badges.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {u.badges.map((b) => (
                          <Badge
                            key={b.area}
                            badge={b}
                            label={badgeLabel(b, t)}
                            kindLabel={t(`user_admin:legend_${b.kind}`)}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="font-sans text-sm text-stone-500">
                        {t("user_admin:no_access_yet")}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-sans text-sm text-stone-600">
                    {u.lastActiveAt ? formatDate(u.lastActiveAt) : t("user_admin:never")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {federationPeople.length > 0 && federationName && (
        <section aria-labelledby="federation-people-heading" className="space-y-3">
          <div className="space-y-1">
            <h2
              id="federation-people-heading"
              className="font-serif text-xl font-medium text-indigo"
            >
              {t("user_admin:federation_heading", { federation: federationName })}
            </h2>
            <p className="font-sans text-sm text-stone-600">
              {t("user_admin:federation_intro")}
            </p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="w-full min-w-[760px] border-collapse">
              <thead className="bg-stone-50">
                <tr className="border-b border-stone-200">
                  <th scope="col" className={TH}>
                    {t("sidebar:col_name")}
                  </th>
                  <th scope="col" className={TH}>
                    {t("user_admin:col_home_workspace")}
                  </th>
                  <th scope="col" className={TH}>
                    {t("user_admin:col_access_here")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {federationPeople.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 font-sans text-sm font-semibold text-indigo">
                      {p.name}
                    </td>
                    <td className="px-4 py-3 font-sans text-sm text-stone-600">
                      {p.homeWorkspace}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {p.badges.map((b) => (
                          <Badge
                            key={b.area}
                            badge={b}
                            label={
                              b.area === "federation"
                                ? t(`user_admin:federation_role_${p.federationRole}`)
                                : badgeLabel(b, t)
                            }
                            kindLabel={t(`user_admin:legend_${b.kind}`)}
                          />
                        ))}
                        {p.reviewedVolumeCount > 0 && (
                          <span className="font-sans text-sm text-stone-600">
                            {t("user_admin:reviews_volumes", {
                              count: p.reviewedVolumeCount,
                            })}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// @version v0.8.0
