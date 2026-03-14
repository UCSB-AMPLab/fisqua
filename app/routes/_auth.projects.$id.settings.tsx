import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.projects.$id.settings";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProject } = await import("../lib/projects.server");

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
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProject } = await import("../lib/projects.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { projects } = await import("../db/schema");

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
        <h2 className="font-heading text-[1.5rem] font-semibold text-[#44403C]">
          {t("project:settings.heading")}
        </h2>

        {actionData?.ok && actionData?.message && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[#2F6B45] bg-[#D6E8DB] px-4 py-3 text-sm text-[#44403C]">
            <svg className="h-5 w-5 shrink-0 text-[#2F6B45]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            {actionData.message}
          </div>
        )}

        <Form method="post" className="mt-6 max-w-xl space-y-5">
          <div>
            <label
              htmlFor="name"
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
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
              className="mt-1 block w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-serif text-[1rem] text-[#44403C] shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
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
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
            >
              {t("project:settings.description")}
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={project.description || ""}
              className="mt-1 block w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm text-[#44403C] shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="conventions"
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
            >
              {t("project:settings.conventions")}
            </label>
            <p className="font-sans text-xs text-[#A8A29E]">
              {t("project:settings.conventions_help")}
            </p>
            <textarea
              id="conventions"
              name="conventions"
              rows={6}
              defaultValue={project.conventions || ""}
              className="mt-1 block w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-mono text-sm text-[#44403C] shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="settings"
              className="block font-sans text-[0.875rem] font-medium text-[#78716C]"
            >
              {t("project:settings.settings_json")}
            </label>
            <p className="font-sans text-xs text-[#A8A29E]">
              {t("project:settings.settings_json_help")}
            </p>
            <textarea
              id="settings"
              name="settings"
              rows={4}
              defaultValue={project.settings || ""}
              className="mt-1 block w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-mono text-sm text-[#44403C] shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
            {actionData?.errors?.settings && (
              <p className="mt-1 text-sm text-red-600">
                {actionData.errors.settings}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="rounded-lg bg-[#8B2942] px-5 py-2.5 font-sans text-sm font-semibold text-white hover:bg-[#7a2439]"
          >
            {t("project:settings.save")}
          </button>
        </Form>
      </section>
    </div>
  );
}
