import { useState } from "react";
import { Form, useActionData } from "react-router";
import { useTranslation, Trans } from "react-i18next";
import { drizzle } from "drizzle-orm/d1";
import { userContext } from "../context";
import { requireProjectRole } from "../lib/permissions.server";
import { getProjectVolumes, createVolume, deleteVolume } from "../lib/volumes.server";
import { validateManifestUrl, parseManifest } from "../lib/iiif.server";
import { VolumeCard } from "../components/volumes/volume-card";
import type { Route } from "./+types/_auth.projects.$id.volumes";

type AddResult = {
  url: string;
  success: boolean;
  error?: string;
  volumeName?: string;
  pageCount?: number;
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Only leads (and admins) can access volume management
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const volumes = await getProjectVolumes(db, params.id);
  return { volumes, projectId: params.id };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Only leads (and admins) can mutate volumes
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "add-volumes": {
      const rawUrls = (formData.get("manifestUrls") as string) || "";
      const urls = rawUrls
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      if (urls.length === 0) {
        return { _action: "add-volumes" as const, results: [] as AddResult[], error: "Ingresa al menos una URL de manifiesto." };
      }

      const results: AddResult[] = [];

      for (const url of urls) {
        // Validate URL format and host
        const validation = validateManifestUrl(url, env);
        if (!validation.valid) {
          results.push({ url, success: false, error: validation.error });
          continue;
        }

        // Parse manifest
        try {
          const manifest = await parseManifest(url);
          await createVolume(db, params.id, manifest);
          results.push({
            url,
            success: true,
            volumeName: manifest.name,
            pageCount: manifest.pageCount,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to process manifest";
          results.push({ url, success: false, error: message });
        }
      }

      return { _action: "add-volumes" as const, results };
    }

    case "delete-volume": {
      const volumeId = formData.get("volumeId") as string;
      if (!volumeId) {
        return { _action: "delete-volume" as const, error: "Se requiere el ID de la unidad compuesta." };
      }

      try {
        await deleteVolume(db, volumeId);
        return { _action: "delete-volume" as const, deleted: true };
      } catch (err) {
        if (err instanceof Response) {
          const text = await err.text();
          return { _action: "delete-volume" as const, error: text };
        }
        return { _action: "delete-volume" as const, error: "No se pudo eliminar la unidad compuesta." };
      }
    }

    default:
      return { error: "Accion desconocida." };
  }
}

export default function ProjectVolumes({ loaderData }: Route.ComponentProps) {
  const { volumes, projectId } = loaderData;
  const actionData = useActionData<typeof action>();
  const [showAddForm, setShowAddForm] = useState(false);
  const { t } = useTranslation(["project", "common"]);

  const addResults =
    actionData && "_action" in actionData && actionData._action === "add-volumes" && "results" in actionData
      ? (actionData.results as AddResult[])
      : null;

  const addError =
    actionData && "_action" in actionData && actionData._action === "add-volumes" && "error" in actionData
      ? (actionData.error as string)
      : null;

  const deleteError =
    actionData && "_action" in actionData && actionData._action === "delete-volume" && "error" in actionData
      ? (actionData.error as string)
      : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-[1.5rem] font-semibold text-[#44403C]">{t("project:heading.volumes")}</h2>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="rounded-lg bg-[#8B2942] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#7a2439]"
        >
          {showAddForm ? t("common:button.cancel") : t("project:volumes.add_volumes")}
        </button>
      </div>

      {/* Delete error */}
      {deleteError && (
        <p className="mt-3 text-sm text-red-600">{deleteError}</p>
      )}

      {/* Add form panel */}
      {showAddForm && (
        <div className="mt-4 rounded-lg border border-[#E7E5E4] bg-[#FAFAF9] p-4">
          <Form method="post">
            <input type="hidden" name="_action" value="add-volumes" />
            <label
              htmlFor="manifestUrls"
              className="block font-sans text-sm font-medium text-[#78716C]"
            >
              {t("project:volumes.manifest_urls")}
            </label>
            <textarea
              id="manifestUrls"
              name="manifestUrls"
              rows={4}
              placeholder={t("project:volumes.manifest_placeholder")}
              className="mt-1 block w-full rounded-lg border border-[#E7E5E4] px-3 py-2 font-sans text-sm shadow-sm focus:border-[#8B2942] focus:ring-1 focus:ring-[#8B2942] focus:outline-none"
            />
            {addError && (
              <p className="mt-2 font-sans text-sm text-red-600">{addError}</p>
            )}
            <button
              type="submit"
              className="mt-3 rounded-lg bg-[#8B2942] px-4 py-2 font-sans text-sm font-semibold text-white hover:bg-[#7a2439]"
            >
              {t("project:volumes.add_volumes")}
            </button>
          </Form>

          {/* Results */}
          {addResults && addResults.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-sm font-medium text-stone-700">{t("project:heading.results")}</h3>
              {addResults.map((result, i) => (
                <div
                  key={i}
                  className={`rounded-md px-3 py-2 text-sm ${
                    result.success
                      ? "bg-green-50 text-green-800"
                      : "bg-red-50 text-red-800"
                  }`}
                >
                  {result.success ? (
                    <Trans
                      i18nKey="project:volumes.added"
                      values={{ name: result.volumeName, count: result.pageCount }}
                      components={{ strong: <strong /> }}
                    />
                  ) : (
                    <span>
                      <span className="break-all font-mono text-xs">
                        {result.url}
                      </span>
                      {" -- "}
                      {result.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Volume grid */}
      {volumes.length === 0 ? (
        <div className="mt-6 rounded-lg border border-[#E7E5E4] bg-[#FAFAF9] p-8 text-center">
          <p className="font-sans text-sm text-[#A8A29E]">
            {t("project:empty.no_volumes_add")}
          </p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {volumes.map((volume) => (
            <VolumeCard key={volume.id} volume={volume} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
