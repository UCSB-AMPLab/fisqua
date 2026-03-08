import { useState } from "react";
import { Form, useActionData } from "react-router";
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
        return { _action: "add-volumes" as const, results: [] as AddResult[], error: "Please enter at least one manifest URL." };
      }

      const results: AddResult[] = [];

      for (const url of urls) {
        // Validate URL format and host
        const validation = validateManifestUrl(url);
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
        return { _action: "delete-volume" as const, error: "Volume ID is required." };
      }

      try {
        await deleteVolume(db, volumeId);
        return { _action: "delete-volume" as const, deleted: true };
      } catch (err) {
        if (err instanceof Response) {
          const text = await err.text();
          return { _action: "delete-volume" as const, error: text };
        }
        return { _action: "delete-volume" as const, error: "Failed to delete volume." };
      }
    }

    default:
      return { error: "Unknown action." };
  }
}

export default function ProjectVolumes({ loaderData }: Route.ComponentProps) {
  const { volumes, projectId } = loaderData;
  const actionData = useActionData<typeof action>();
  const [showAddForm, setShowAddForm] = useState(false);

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
        <h2 className="text-lg font-medium text-stone-900">Volumes</h2>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          {showAddForm ? "Cancel" : "Add Volumes"}
        </button>
      </div>

      {/* Delete error */}
      {deleteError && (
        <p className="mt-3 text-sm text-red-600">{deleteError}</p>
      )}

      {/* Add form panel */}
      {showAddForm && (
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
          <Form method="post">
            <input type="hidden" name="_action" value="add-volumes" />
            <label
              htmlFor="manifestUrls"
              className="block text-sm font-medium text-stone-700"
            >
              IIIF manifest URLs
            </label>
            <textarea
              id="manifestUrls"
              name="manifestUrls"
              rows={4}
              placeholder="Paste IIIF manifest URLs, one per line"
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-stone-500 focus:ring-1 focus:ring-stone-500 focus:outline-none"
            />
            {addError && (
              <p className="mt-2 text-sm text-red-600">{addError}</p>
            )}
            <button
              type="submit"
              className="mt-3 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800"
            >
              Add Volumes
            </button>
          </Form>

          {/* Results */}
          {addResults && addResults.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-sm font-medium text-stone-700">Results</h3>
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
                    <span>
                      Added <strong>{result.volumeName}</strong> ({result.pageCount}{" "}
                      {result.pageCount === 1 ? "page" : "pages"})
                    </span>
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
        <div className="mt-6 rounded-lg border border-stone-200 bg-stone-50 p-8 text-center">
          <p className="text-sm text-stone-600">
            No volumes yet. Click "Add Volumes" to import volumes from IIIF
            manifests.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {volumes.map((volume) => (
            <VolumeCard key={volume.id} volume={volume} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}
