import { Form, useActionData } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc } from "drizzle-orm";
import { userContext } from "../context";
import { users } from "../db/schema";
import type { Route } from "./+types/_auth.admin.users";

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const allUsers = await db
    .select()
    .from(users)
    .orderBy(desc(users.createdAt))
    .all();

  return { users: allUsers };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "toggleAdmin": {
      const targetUserId = formData.get("userId") as string;

      // Prevent self-demotion
      if (targetUserId === user.id) {
        return { ok: false, error: "You cannot change your own admin status." };
      }

      const targetUser = await db
        .select()
        .from(users)
        .where(eq(users.id, targetUserId))
        .get();

      if (!targetUser) {
        return { ok: false, error: "User not found." };
      }

      await db
        .update(users)
        .set({ isAdmin: !targetUser.isAdmin, updatedAt: Date.now() })
        .where(eq(users.id, targetUserId));

      return {
        ok: true,
        message: `${targetUser.email} is ${targetUser.isAdmin ? "no longer" : "now"} an admin.`,
      };
    }

    case "createUser": {
      const email = (formData.get("email") as string || "").trim().toLowerCase();

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, error: "Please enter a valid email address." };
      }

      // Check for duplicate
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .get();

      if (existing) {
        return { ok: false, error: "A user with this email already exists." };
      }

      const now = Date.now();
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email,
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      });

      return { ok: true, message: `User ${email} created.` };
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

export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { users: allUsers } = loaderData;
  const actionData = useActionData<typeof action>();

  return (
    <div className="space-y-8">
      {/* Create user form */}
      <section>
        <h2 className="text-lg font-medium text-stone-900">Create user</h2>

        {actionData?.ok && actionData?.message && (
          <p className="mt-2 text-sm text-green-600">{actionData.message}</p>
        )}
        {actionData && !actionData.ok && actionData?.error && (
          <p className="mt-2 text-sm text-red-600">{actionData.error}</p>
        )}

        <Form method="post" className="mt-4 flex items-end gap-3">
          <input type="hidden" name="_action" value="createUser" />
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-stone-700"
            >
              Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder="user@example.com"
              className="mt-1 block w-64 rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-burgundy-light focus:ring-1 focus:ring-burgundy-light focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="rounded-md bg-burgundy-deep px-4 py-2 text-sm font-medium text-white hover:bg-burgundy"
          >
            Create user
          </button>
        </Form>
      </section>

      {/* Users table */}
      <section>
        <h2 className="text-lg font-medium text-stone-900">All users</h2>

        {allUsers.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">No users yet.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    Email
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    Name
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    Admin
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-stone-500 uppercase">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {allUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 text-sm text-stone-900">
                      {u.email}
                    </td>
                    <td className="px-4 py-3 text-sm text-stone-500">
                      {u.name || "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      <Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="_action"
                          value="toggleAdmin"
                        />
                        <input type="hidden" name="userId" value={u.id} />
                        <button
                          type="submit"
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            u.isAdmin
                              ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                              : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                          }`}
                        >
                          {u.isAdmin ? "Admin" : "User"}
                        </button>
                      </Form>
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-400">
                      {formatDate(u.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
