/**
 * Admin — Bulk merge affordance (authority lists)
 *
 * The merge entry point for the entities and places lists: enabled at
 * exactly two selected records, where it opens the merge workbench
 * pre-loaded with the pair; at one or three-plus it is disabled and
 * says why, inline, rather than leaving the reader to guess.
 *
 * This used to be a whole toolbar of its own — the bar that appeared
 * above the table the moment a row was ticked, and offered merge and
 * nothing else. It is now one action inside the shared
 * `BulkActionBar`, passed as that bar's `extraActions`, because the
 * selection column stopped being the merge column: the same ticks now
 * also feed the handlist and the export. One column, one selection,
 * and a bar that offers whatever that number of ticks can actually do.
 *
 * The caller owns the selection; this component is presentational plus
 * the merge navigation. `basePath` (e.g. `/admin/entities`) forms the
 * workbench URL `${basePath}/${a}/merge?survivor=${b}`.
 *
 * @version v0.7.0
 */

import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { GitMerge, Info } from "lucide-react";

export function BulkMergeAction({
  selectedIds,
  basePath,
}: {
  selectedIds: string[];
  basePath: string;
}) {
  const { t } = useTranslation("authorities");
  const navigate = useNavigate();
  const canMerge = selectedIds.length === 2;

  return (
    <>
      {!canMerge && (
        <span className="flex items-center gap-1 text-13 text-indigo-soft">
          <Info className="h-4 w-4" strokeWidth={1.5} />
          {t("bulkHintPickTwo")}
        </span>
      )}
      <button
        type="button"
        disabled={!canMerge}
        onClick={() =>
          navigate(`${basePath}/${selectedIds[0]}/merge?survivor=${selectedIds[1]}`)
        }
        className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-13 font-semibold text-parchment ${
          canMerge ? "hover:bg-indigo-deep" : "cursor-not-allowed opacity-30"
        }`}
      >
        <GitMerge className="h-4 w-4" strokeWidth={1.5} />
        {t("bulkMerge")}
      </button>
    </>
  );
}

/* @version v0.7.0 */
