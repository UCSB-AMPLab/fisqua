/**
 * Admin — Optimistic-Lock Conflict Dialog
 *
 * This component is the modal shown when an update action returns `error:
 * "conflict"`: another user saved the record first, moving its `updatedAt`
 * on under the editor. It offers cancel, or an overwrite that resubmits
 * the editor's form as it stands, with `_action=update` and `_force=true`
 * added, so the forced save writes the fields the user edited. The caller
 * passes the editor form's ref; without a mounted form the overwrite does
 * nothing, and the update actions refuse a forced update that carries none
 * of the editable fields.
 *
 * Shared by all three admin detail editors (`entities.$id`,
 * `places.$id`, `descriptions.$id`). Divergence parameterised via
 * `modifiedByName`: the entities/places copies pass an empty name (they
 * do not resolve the conflicting user), while descriptions passes the
 * resolved `modifiedBy` name. The caller keeps its own visibility guard
 * (`showConflictDialog && actionData?.error === "conflict"`) and passes
 * the conflict fields down.
 *
 * @version v0.9.0
 */

import type { RefObject } from "react";
import { useSubmit } from "react-router";
import { useFormatters } from "~/lib/use-formatters";

/**
 * The overwrite request: the editor form's fields, every value kept
 * (a checkbox's hidden input and its "on" both travel), with the
 * update intent and the force flag set.
 */
export function buildOverwriteData(form: FormData): FormData {
  const data = new FormData();
  for (const [key, value] of form.entries()) {
    if (key === "_action" || key === "_force") continue;
    data.append(key, value);
  }
  data.set("_action", "update");
  data.set("_force", "true");
  return data;
}

export function ConflictDialog({
  modifiedByName,
  modifiedAt,
  formRef,
  onCancel,
  t,
}: {
  modifiedByName: string;
  modifiedAt: number | null;
  formRef: RefObject<HTMLFormElement | null>;
  onCancel: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { formatDateTime } = useFormatters();
  const submit = useSubmit();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("overwrite_confirm", {
            name: modifiedByName,
            time: modifiedAt != null ? formatDateTime(modifiedAt) : "",
          })}
        </h2>
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("overwrite_cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              const form = formRef.current;
              if (!form) return;
              submit(buildOverwriteData(new FormData(form)), { method: "post" });
            }}
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("overwrite_button")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* @version v0.9.0 */
