import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { getProject } from "../lib/projects.server";
import { getInstance } from "~/middleware/i18next";
import { projects } from "../db/schema";
import type { Route } from "./+types/_auth.projects.$id.settings";

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Only leads (or admins) can access settings
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const project = await getProject(db, params.id);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  return { project };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();

  const name = ((formData.get("name") as string) || "").trim();
  const description = ((formData.get("description") as string) || "").trim();
  const conventions = ((formData.get("conventions") as string) || "").trim();
  const settings = ((formData.get("settings") as string) || "").trim();

  // Validate
  const errors: Record<string, string> = {};

  if (!name || name.length === 0) {
    errors.name = i18n.t("project:error.name_required");
  } else if (name.length > 200) {
    errors.name = i18n.t("project:error.name_too_long");
  }

  // Validate settings JSON if provided
  if (settings) {
    try {
      JSON.parse(settings);
    } catch {
      errors.settings = i18n.t("project:error.invalid_json");
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  await db
    .update(projects)
    .set({
      name,
      description: description || null,
      conventions: conventions || null,
      settings: settings || null,
      updatedAt: Date.now(),
    })
    .where(eq(projects.id, params.id));

  return { ok: true, message: i18n.t("project:settings.saved") };
}

export default function ProjectSettings({ loaderData }: Route.ComponentProps) {
  const { project } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation(["project", "common"]);

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-lg font-medium text-stone-900">{t("project:settings.heading")}</h2>

        {actionData?.ok && actionData?.message && (
          <p className="mt-2 text-sm text-green-600">{actionData.message}</p>
        )}

        <Form method="post" className="mt-4 max-w-xl space-y-4">
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-stone-700"
            >
              {t("project:settings.project_name")}
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={200}
              defaultValue={project.name}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-burgundy-light focus:ring-1 focus:ring-burgundy-light focus:outline-none"
            />
            {actionData?.errors?.name && (
              <p className="mt-1 text-sm text-red-600">
                {actionData.errors.name}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="description"
              className="block text-sm font-medium text-stone-700"
            >
              {t("project:settings.description")}
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={project.description || ""}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-burgundy-light focus:ring-1 focus:ring-burgundy-light focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="conventions"
              className="block text-sm font-medium text-stone-700"
            >
              {t("project:settings.conventions")}
            </label>
            <p className="text-xs text-stone-500">
              {t("project:settings.conventions_help")}
            </p>
            <textarea
              id="conventions"
              name="conventions"
              rows={6}
              defaultValue={project.conventions || ""}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-mono shadow-sm focus:border-burgundy-light focus:ring-1 focus:ring-burgundy-light focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="settings"
              className="block text-sm font-medium text-stone-700"
            >
              {t("project:settings.settings_json")}
            </label>
            <p className="text-xs text-stone-500">
              {t("project:settings.settings_json_help")}
            </p>
            <textarea
              id="settings"
              name="settings"
              rows={4}
              defaultValue={project.settings || ""}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-mono shadow-sm focus:border-burgundy-light focus:ring-1 focus:ring-burgundy-light focus:outline-none"
            />
            {actionData?.errors?.settings && (
              <p className="mt-1 text-sm text-red-600">
                {actionData.errors.settings}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="rounded-md bg-burgundy-deep px-4 py-2 text-sm font-medium text-white hover:bg-burgundy"
          >
            {t("project:settings.save")}
          </button>
        </Form>
      </section>
    </div>
  );
}
