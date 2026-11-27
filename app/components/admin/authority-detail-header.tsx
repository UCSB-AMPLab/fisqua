/**
 * Admin — Authority Detail Header
 *
 * This component renders the breadcrumb and the title and action row that
 * the two authority detail editors (`entities.$id`, `places.$id`) share.
 * Both show the same breadcrumb (root link, chevron, current record) and
 * the same title row (serif h1 plus the merge/split/edit/delete action
 * buttons, hidden while the record is being edited or once it has been
 * merged).
 *
 * `descriptions.$id` deliberately does NOT use these: its breadcrumb
 * renders a collapsing ancestor chain and its action row has a
 * different button set (add-child / edit / delete, no merge/split and
 * no merged state). That route keeps its own header markup.
 *
 * Callers resolve their namespace's strings (`AdminBreadcrumb`) or pass
 * a `t` for the button labels (`AuthorityDetailHeader`); only the shared
 * breadcrumb aria-label resolves internally, from `common`.
 *
 * `extraActions` opens the row to a control this component has no
 * business knowing about — the handlist picker, which carries its own
 * dialog and its own namespace. It renders FIRST, before merge, because
 * it is the one action in the row that changes nothing about the
 * record. It obeys the row's own visibility rule: while the record is
 * being edited, or once it has been merged away, the row is absent and
 * so is everything in it.
 *
 * Delete is disabled, with its reason as the button's title, while the
 * record has linked descriptions (the count) or the caller gives a
 * `deleteBlockedReason` (an entity others were merged into). The linked
 * descriptions take precedence.
 *
 * @version v0.9.0
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Trash2, Merge, Split } from "lucide-react";

export function AdminBreadcrumb({
  rootTo,
  rootLabel,
  current,
}: {
  rootTo: string;
  rootLabel: string;
  current: string;
}) {
  const { t } = useTranslation("common");
  return (
    <nav aria-label={t("aria.breadcrumb")} className="mb-4 text-sm">
      <ol className="flex items-center gap-1">
        <li>
          <Link to={rootTo} className="text-stone-500 hover:text-stone-700">
            {rootLabel}
          </Link>
        </li>
        <li>
          <ChevronRight className="h-4 w-4 text-stone-400" />
        </li>
        <li className="text-stone-700">{current}</li>
      </ol>
    </nav>
  );
}

export function AuthorityDetailHeader({
  title,
  isEditing,
  isMerged,
  hasDescriptions,
  descLinkCount,
  mergeTo,
  splitTo,
  onEdit,
  onDelete,
  deleteBlockedReason,
  extraActions,
  t,
}: {
  title: string;
  isEditing: boolean;
  isMerged: boolean;
  hasDescriptions: boolean;
  descLinkCount: number;
  mergeTo: string;
  splitTo: string;
  onEdit: () => void;
  onDelete: () => void;
  /** Why Delete is disabled when the record has no linked descriptions; absent, it is enabled. */
  deleteBlockedReason?: string;
  /** Rendered first in the action row; see the header. */
  extraActions?: ReactNode;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const deleteBlocked = hasDescriptions || deleteBlockedReason !== undefined;
  return (
    <div className="flex items-center justify-between">
      <h1 className="font-serif text-2xl font-semibold text-stone-700">
        {title}
      </h1>

      {!isEditing && !isMerged && (
        <div className="flex gap-2">
          {extraActions}
          <Link
            to={mergeTo}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Merge className="h-4 w-4" />
            {t("mergeButton")}
          </Link>
          <Link
            to={splitTo}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Split className="h-4 w-4" />
            {t("splitButton")}
          </Link>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Pencil className="h-4 w-4" />
            {t("editButton")}
          </button>
          <button
            type="button"
            onClick={() => !deleteBlocked && onDelete()}
            disabled={deleteBlocked}
            aria-disabled={deleteBlocked ? "true" : undefined}
            title={
              hasDescriptions
                ? t("deleteBlocked", { count: descLinkCount })
                : deleteBlockedReason
            }
            className={
              deleteBlocked
                ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
            }
          >
            <Trash2 className="h-4 w-4" />
            {t("deleteButton")}
          </button>
        </div>
      )}
    </div>
  );
}
