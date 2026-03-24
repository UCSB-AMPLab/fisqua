import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { formatDate } from "~/lib/format";
import type { Route } from "./+types/_auth.projects.$id.members";

type MemberRow = {
  userId: string;
  email: string;
  name: string | null;
  roles: string[];
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, isNull, gt } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProject } = await import("../lib/projects.server");
  const {
    users,
    projectMembers,
    projectInvites,
  } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Only leads (or admins) can access member management
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const project = await getProject(db, params.id);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  // Load all members with their roles
  const memberRows = await db
    .select({
      memberId: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      email: users.email,
      name: users.name,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, params.id))
    .all();

  // Group by user
  const memberMap = new Map<string, MemberRow>();
  for (const row of memberRows) {
    const existing = memberMap.get(row.userId);
    if (existing) {
      existing.roles.push(row.role);
    } else {
      memberMap.set(row.userId, {
        userId: row.userId,
        email: row.email,
        name: row.name,
        roles: [row.role],
      });
    }
  }
  const members = Array.from(memberMap.values());

  // Load pending invites (not accepted, not expired)
  const now = Date.now();
  const pendingInvites = await db
    .select({
      id: projectInvites.id,
      email: projectInvites.email,
      roles: projectInvites.roles,
      expiresAt: projectInvites.expiresAt,
      createdAt: projectInvites.createdAt,
    })
    .from(projectInvites)
    .where(
      and(
        eq(projectInvites.projectId, params.id),
        isNull(projectInvites.acceptedAt),
        gt(projectInvites.expiresAt, now)
      )
    )
    .all();

  return { project, members, pendingInvites, currentUserId: user.id };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { createInvite } = await import("../lib/invites.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "invite": {
      const email = (formData.get("email") as string || "").trim().toLowerCase();
      const roleValues = formData.getAll("roles") as string[];

      // Validate email
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: i18n.t("project:error.invalid_email") };
      }

      // Validate roles
      const validRoles = ["lead", "cataloguer", "reviewer"];
      const roles = roleValues.filter((r) => validRoles.includes(r));
      if (roles.length === 0) {
        return { ok: false, error: i18n.t("project:error.select_role") };
      }

      const result = await createInvite(
        db,
        params.id,
        email,
        roles,
        user,
        new URL(request.url).origin,
        env.RESEND_API_KEY,
        env
      );

      if (result.status === "error") {
        return { ok: false, error: result.error };
      }

      const message =
        result.status === "invited"
          ? i18n.t("project:error.invite_sent", { email })
          : i18n.t("project:error.member_added", { email });

      return { ok: true, message };
    }

    case "changeRoles": {
      const targetUserId = formData.get("userId") as string;
      const roleValues = formData.getAll("roles") as string[];

      const validRoles = ["lead", "cataloguer", "reviewer"];
      const newRoles = roleValues.filter((r) => validRoles.includes(r));
      if (newRoles.length === 0) {
        return { ok: false, error: i18n.t("project:error.role_required") };
      }

      // Delete existing memberships for this user+project
      await db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, params.id),
            eq(projectMembers.userId, targetUserId)
          )
        );

      // Insert new roles
      const now = Date.now();
      for (const role of newRoles) {
        await db.insert(projectMembers).values({
          id: crypto.randomUUID(),
          projectId: params.id,
          userId: targetUserId,
          role: role as "lead" | "cataloguer" | "reviewer",
          createdAt: now,
        });
      }

      return { ok: true, message: i18n.t("project:error.roles_updated") };
    }

    case "removeMember": {
      const targetUserId = formData.get("userId") as string;

      // Check target is not a lead
      const targetMemberships = await db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, params.id),
            eq(projectMembers.userId, targetUserId)
          )
        )
        .all();

      const isLead = targetMemberships.some((m) => m.role === "lead");
      if (isLead) {
        return { ok: false, error: i18n.t("project:error.cannot_remove_lead") };
      }

      // Delete all memberships for this user+project
      await db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, params.id),
            eq(projectMembers.userId, targetUserId)
          )
        );

      return { ok: true, message: i18n.t("project:error.member_removed") };
    }

    default:
      return { ok: false, error: i18n.t("project:error.unknown_action") };
  }
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-[#F9EDD4] text-[#8B6914]",
  cataloguer: "bg-[#E0E7F7] text-[#3B5A9A]",
  reviewer: "bg-[#D6E8DB] text-[#2F6B45]",
};

export default function ProjectMembers({ loaderData }: Route.ComponentProps) {
  const { project, members, pendingInvites, currentUserId } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation(["project", "workflow", "common"]);

  return (
    <div className="space-y-10">
      {/* Invite form */}
      <section>
        <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
          {t("project:action.invite_member")}
        </h2>

        {actionData?.ok && actionData?.message && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#2F6B45] bg-[#D6E8DB] px-4 py-3 text-sm text-[#44403C]">
            {actionData.message}
          </div>
        )}
        {actionData && !actionData.ok && actionData?.error && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 text-sm text-[#44403C]">
            {actionData.error}
          </div>
        )}

        <Form method="post" className="mt-4 flex max-w-xl flex-wrap items-end gap-4">
          <input type="hidden" name="_action" value="invite" />

          <div className="flex-1">
            <label
              htmlFor="email"
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
            >
              {t("project:settings.email")}
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder={t("project:invite.placeholder")}
              className="mt-1 block w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
          </div>

          <fieldset>
            <legend className="font-sans text-[0.875rem] font-medium text-[#78716C]">
              {t("project:settings.role")}
            </legend>
            <div className="mt-1 flex gap-4">
              {(["cataloguer", "reviewer", "lead"] as const).map((role) => (
                <label key={role} className="flex items-center gap-2 font-sans text-sm text-[#44403C]">
                  <input
                    type="radio"
                    name="roles"
                    value={role}
                    defaultChecked={role === "cataloguer"}
                    className="border-[#E7E5E4] text-[#8B2942] focus:ring-[#8B2942]"
                  />
                  {t(`workflow:role.${role}`)}
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            className="flex items-center gap-2 rounded-lg bg-[#8B2942] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#7a2439]"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
            </svg>
            {t("project:action.invite")}
          </button>
        </Form>
      </section>

      {/* Members list */}
      <section>
        <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
          {t("project:heading.members")}
        </h2>

        {members.length === 0 ? (
          <p className="mt-2 font-sans text-sm text-[#A8A29E]">{t("project:empty.no_members")}</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-[#E7E5E4]">
            <table className="min-w-full divide-y divide-[#E7E5E4]">
              <thead className="bg-[#FAFAF9]">
                <tr>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("project:table.member")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("project:table.roles")}
                  </th>
                  <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-[#78716C]">
                    {t("project:table.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {members.map((member) => {
                  const isLead = member.roles.includes("lead");
                  const isSelf = member.userId === currentUserId;

                  return (
                    <tr key={member.userId}>
                      <td className="px-4 py-3">
                        <div className="font-sans text-sm font-medium text-[#44403C]">
                          {member.name || member.email}
                        </div>
                        {member.name && (
                          <div className="font-sans text-xs text-[#A8A29E]">
                            {member.email}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1.5">
                          {member.roles.map((role) => (
                            <span
                              key={role}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_BADGE_COLORS[role] || "bg-stone-100 text-stone-600"}`}
                            >
                              {t(`workflow:role.${role}`)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!isLead && !isSelf && (
                          <Form method="post" className="inline">
                            <input
                              type="hidden"
                              name="_action"
                              value="removeMember"
                            />
                            <input
                              type="hidden"
                              name="userId"
                              value={member.userId}
                            />
                            <button
                              type="submit"
                              className="font-sans text-xs font-medium text-[#8B2942] hover:underline"
                              onClick={(e) => {
                                if (
                                  !confirm(
                                    t("project:action.remove_confirm", {
                                      name: member.name || member.email,
                                    })
                                  )
                                ) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              {t("project:action.remove")}
                            </button>
                          </Form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
        <section>
          <h2 className="font-sans text-[1.5rem] font-semibold text-[#44403C]">
            {t("project:heading.pending_invitations")}
          </h2>
          <div className="mt-4 space-y-2">
            {pendingInvites.map((invite) => {
              const roles: string[] = JSON.parse(invite.roles);
              return (
                <div
                  key={invite.id}
                  className="flex items-center gap-3 rounded-lg border border-[#E7E5E4] bg-white px-4 py-3"
                >
                  <span className="min-w-0 flex-1 font-sans text-sm text-[#44403C]">
                    {invite.email}
                  </span>
                  <div className="flex gap-1.5">
                    {roles.map((role) => (
                      <span
                        key={role}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_BADGE_COLORS[role] || "bg-stone-100 text-stone-600"}`}
                      >
                        {t(`workflow:role.${role}`)}
                      </span>
                    ))}
                  </div>
                  <span className="font-sans text-xs text-[#A8A29E]">
                    {t("project:volumes.expires", { date: formatDate(invite.expiresAt) })}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
