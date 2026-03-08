import { Form, useActionData } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNull, gt } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { getProject } from "../lib/projects.server";
import { createInvite } from "../lib/invites.server";
import {
  users,
  projectMembers,
  projectInvites,
} from "../db/schema";
import type { Route } from "./+types/_auth.projects.$id.members";

type MemberRow = {
  userId: string;
  email: string;
  name: string | null;
  roles: string[];
};

export async function loader({ params, context }: Route.LoaderArgs) {
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
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "invite": {
      const email = (formData.get("email") as string || "").trim().toLowerCase();
      const roleValues = formData.getAll("roles") as string[];

      // Validate email
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: "Please enter a valid email address." };
      }

      // Validate roles
      const validRoles = ["lead", "member", "reviewer"];
      const roles = roleValues.filter((r) => validRoles.includes(r));
      if (roles.length === 0) {
        return { ok: false, error: "Select at least one role." };
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
          ? `Invitation sent to ${email}.`
          : `${email} has been added to the project.`;

      return { ok: true, message };
    }

    case "changeRoles": {
      const targetUserId = formData.get("userId") as string;
      const roleValues = formData.getAll("roles") as string[];

      const validRoles = ["lead", "member", "reviewer"];
      const newRoles = roleValues.filter((r) => validRoles.includes(r));
      if (newRoles.length === 0) {
        return { ok: false, error: "At least one role is required." };
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
          role,
          createdAt: now,
        });
      }

      return { ok: true, message: "Roles updated." };
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
        return { ok: false, error: "Cannot remove a project lead." };
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

      return { ok: true, message: "Member removed." };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const roleBadgeColors: Record<string, string> = {
  lead: "bg-amber-100 text-amber-800",
  member: "bg-blue-100 text-blue-800",
  reviewer: "bg-green-100 text-green-800",
};

export default function ProjectMembers({ loaderData }: Route.ComponentProps) {
  const { project, members, pendingInvites, currentUserId } = loaderData;
  const actionData = useActionData<typeof action>();

  return (
    <div className="space-y-10">
      {/* Invite form */}
      <section>
        <h2 className="text-lg font-medium text-stone-900">Invite member</h2>

        {actionData?.ok && actionData?.message && (
          <p className="mt-2 text-sm text-green-600">{actionData.message}</p>
        )}
        {actionData && !actionData.ok && actionData?.error && (
          <p className="mt-2 text-sm text-red-600">{actionData.error}</p>
        )}

        <Form method="post" className="mt-4 max-w-xl space-y-4">
          <input type="hidden" name="_action" value="invite" />

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-stone-700"
            >
              Email address
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder="colleague@example.com"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-stone-500 focus:ring-1 focus:ring-stone-500 focus:outline-none"
            />
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-stone-700">
              Roles
            </legend>
            <div className="mt-2 flex gap-4">
              {["lead", "member", "reviewer"].map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="roles"
                    value={role}
                    defaultChecked={role === "member"}
                    className="rounded border-stone-300 text-stone-900 focus:ring-stone-500"
                  />
                  {role.charAt(0).toUpperCase() + role.slice(1)}
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            Invite
          </button>
        </Form>
      </section>

      {/* Members list */}
      <section>
        <h2 className="text-lg font-medium text-stone-900">Members</h2>

        {members.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">No members yet.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    Member
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    Roles
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-stone-500 uppercase">
                    Actions
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
                        <div className="text-sm font-medium text-stone-900">
                          {member.name || member.email}
                        </div>
                        {member.name && (
                          <div className="text-xs text-stone-500">
                            {member.email}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          {member.roles.map((role) => (
                            <span
                              key={role}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${roleBadgeColors[role] || "bg-stone-100 text-stone-600"}`}
                            >
                              {role}
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
                              className="text-xs text-red-500 hover:text-red-700"
                              onClick={(e) => {
                                if (
                                  !confirm(
                                    `Remove ${member.name || member.email} from the project?`
                                  )
                                ) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              Remove
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
          <h2 className="text-lg font-medium text-stone-900">
            Pending invitations
          </h2>
          <div className="mt-4 space-y-2">
            {pendingInvites.map((invite) => {
              const roles: string[] = JSON.parse(invite.roles);
              return (
                <div
                  key={invite.id}
                  className="flex items-center gap-3 rounded border border-stone-200 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 text-sm text-stone-700">
                    {invite.email}
                  </span>
                  <div className="flex gap-1">
                    {roles.map((role) => (
                      <span
                        key={role}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${roleBadgeColors[role] || "bg-stone-100 text-stone-600"}`}
                      >
                        {role}
                      </span>
                    ))}
                  </div>
                  <span className="text-xs text-stone-400">
                    Expires {formatDate(invite.expiresAt)}
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
