/**
 * Project Members Page
 *
 * Lead-only project membership editor. Lists every member with their
 * role (lead, reviewer, cataloguer), exposes the invite-by-email form
 * for adding new members, and lets leads change roles or remove a
 * member. Cross-references the cataloguing admin team page so the
 * project lead can work without an admin round-trip.
 *
 * @version v0.3.0
 */

import { Form, useActionData, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.projects.$id.members";

type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProject } = await import("../lib/projects.server");
  const { users, projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Only leads (or admins) can access member management
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const project = await getProject(db, params.id);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  // Load project members
  const memberRows = await db
    .select({
      membershipId: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      email: users.email,
      name: users.name,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, params.id))
    .all();

  // Load all registered users (for the add-member picker)
  const allUsers = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .all();

  return {
    project,
    members: memberRows as MemberRow[],
    allUsers,
    currentUserId: user.id,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { projectMembers, users } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "addMember") {
    const userId = (formData.get("userId") as string)?.trim();
    const role = formData.get("role") as string;

    if (!userId) {
      return { ok: false, error: i18n.t("admin:error.user_not_found") };
    }

    const validRoles = ["lead", "cataloguer", "reviewer"];
    if (!validRoles.includes(role)) {
      return { ok: false, error: i18n.t("project:error.role_required") };
    }

    // Verify user exists
    const [targetUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .all();
    if (!targetUser) {
      return { ok: false, error: i18n.t("admin:error.user_not_found") };
    }

    // Check for duplicate membership
    const existing = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, params.id),
          eq(projectMembers.userId, targetUser.id)
        )
      )
      .limit(1)
      .all();
    if (existing.length > 0) {
      return { ok: false, error: i18n.t("admin:error.duplicate_email") };
    }

    await db.insert(projectMembers).values({
      id: crypto.randomUUID(),
      projectId: params.id,
      userId: targetUser.id,
      role: role as "lead" | "cataloguer" | "reviewer",
      createdAt: (Date.now() / 1000) | 0,
    });

    return { ok: true, message: i18n.t("project:error.member_added", { email: targetUser.email }) };
  }

  if (intent === "changeMemberRole") {
    const membershipId = formData.get("membershipId") as string;
    const role = formData.get("role") as string;

    if (!membershipId) {
      return { ok: false, error: "Missing membership ID" };
    }

    const validRoles = ["lead", "cataloguer", "reviewer"];
    if (!validRoles.includes(role)) {
      return { ok: false, error: i18n.t("project:error.role_required") };
    }

    await db
      .update(projectMembers)
      .set({ role: role as "lead" | "cataloguer" | "reviewer" })
      .where(eq(projectMembers.id, membershipId));

    return { ok: true };
  }

  if (intent === "removeMember") {
    const membershipId = formData.get("membershipId") as string;
    if (!membershipId) {
      return { ok: false, error: "Missing membership ID" };
    }

    await db
      .delete(projectMembers)
      .where(eq(projectMembers.id, membershipId));

    return { ok: true };
  }

  return { ok: false, error: i18n.t("project:error.unknown_action") };
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-[#D6E8DB] text-[#2F6B45]",
  cataloguer: "bg-[#E0E7F7] text-[#3B5A9A]",
  reviewer: "bg-[#CCF0EB] text-[#0D9488]",
};

export default function ProjectMembers({ loaderData }: Route.ComponentProps) {
  const { members, allUsers, currentUserId } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation(["project", "workflow", "common", "admin", "team"]);

  const existingMemberIds = members.map((m) => m.userId);
  const availableUsers = allUsers.filter((u) => !existingMemberIds.includes(u.id));

  return (
    <div className="space-y-8">
      {/* Feedback messages */}
      {actionData?.ok && actionData?.message && (
        <div className="rounded-lg border border-[#2F6B45] bg-[#D6E8DB] px-4 py-3 text-sm text-[#44403C]">
          {actionData.message}
        </div>
      )}
      {actionData && !actionData.ok && actionData?.error && (
        <div className="rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 text-sm text-[#44403C]">
          {actionData.error}
        </div>
      )}

      {/* Members table */}
      <section>
        <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
          {t("project:heading.members")} ({members.length})
        </h2>

        {members.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E5E4]">
            <table className="min-w-full divide-y divide-[#E7E5E4]">
              <thead className="bg-[#FAFAF9]">
                <tr>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("admin:table.name")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("admin:table.email")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("admin:table.role")}
                  </th>
                  <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("admin:table.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {members.map((member) => (
                  <MemberRow
                    key={member.membershipId}
                    member={member}
                    isSelf={member.userId === currentUserId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add member form — always visible, disabled when no users available */}
        <AddMemberForm availableUsers={availableUsers} />
      </section>
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
}: {
  member: MemberRow;
  isSelf: boolean;
}) {
  const { t } = useTranslation(["workflow", "team"]);
  const fetcher = useFetcher();

  return (
    <tr>
      <td className="px-4 py-3 font-sans text-sm text-[#44403C]">
        {member.name || "\u2014"}
      </td>
      <td className="px-4 py-3 font-sans text-sm text-[#78716C]">
        {member.email}
      </td>
      <td className="px-4 py-3">
        <fetcher.Form method="post" className="inline">
          <input type="hidden" name="_action" value="changeMemberRole" />
          <input type="hidden" name="membershipId" value={member.membershipId} />
          <select
            name="role"
            defaultValue={member.role}
            onChange={(e) => {
              const form = e.target.closest("form");
              if (form) fetcher.submit(form);
            }}
            className="rounded border border-[#E7E5E4] px-1.5 py-0.5 font-sans text-xs focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
          >
            <option value="lead">{t("workflow:role.lead")}</option>
            <option value="cataloguer">{t("workflow:role.cataloguer")}</option>
            <option value="reviewer">{t("workflow:role.reviewer")}</option>
          </select>
        </fetcher.Form>
      </td>
      <td className="px-4 py-3 text-right">
        {!isSelf && (
          <fetcher.Form method="post" className="inline">
            <input type="hidden" name="_action" value="removeMember" />
            <input type="hidden" name="membershipId" value={member.membershipId} />
            <button
              type="submit"
              className="font-sans text-xs font-medium text-[#8B2942] hover:underline"
              onClick={(e) => {
                if (
                  !confirm(
                    t("team:confirm_remove", {
                      name: member.name || member.email,
                    })
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              {t("team:remove_from_project")}
            </button>
          </fetcher.Form>
        )}
      </td>
    </tr>
  );
}

function AddMemberForm({
  availableUsers,
}: {
  availableUsers: Array<{ id: string; name: string | null; email: string }>;
}) {
  const { t } = useTranslation(["admin", "common", "team", "workflow"]);
  const fetcher = useFetcher();
  const noUsers = availableUsers.length === 0;

  return (
    <fetcher.Form method="post" className="mt-4 flex items-end gap-3">
      <input type="hidden" name="_action" value="addMember" />
      <div>
        <label className="block font-sans text-xs font-medium text-[#78716C]">
          {t("admin:table.user")}
        </label>
        <select
          name="userId"
          required
          disabled={noUsers}
          className="mt-0.5 block w-56 rounded-lg border border-[#E7E5E4] px-2 py-1.5 font-sans text-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none disabled:bg-[#FAFAF9] disabled:text-[#A8A29E]"
        >
          <option value="">
            {noUsers
              ? t("admin:placeholder.no_users_available")
              : t("admin:placeholder.select_user")}
          </option>
          {availableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ? `${u.name} (${u.email})` : u.email}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block font-sans text-xs font-medium text-[#78716C]">
          {t("admin:table.role")}
        </label>
        <select
          name="role"
          required
          disabled={noUsers}
          className="mt-0.5 rounded-lg border border-[#E7E5E4] px-2 py-1.5 font-sans text-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none disabled:bg-[#FAFAF9] disabled:text-[#A8A29E]"
        >
          <option value="cataloguer">{t("workflow:role.cataloguer")}</option>
          <option value="reviewer">{t("workflow:role.reviewer")}</option>
          <option value="lead">{t("workflow:role.lead")}</option>
        </select>
      </div>
      <button
        type="submit"
        disabled={noUsers}
        className="rounded-lg bg-[#8B2942] px-3 py-1.5 font-sans text-sm font-semibold text-white hover:bg-[#7a2439] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("admin:action.add_user")}
      </button>
    </fetcher.Form>
  );
}
