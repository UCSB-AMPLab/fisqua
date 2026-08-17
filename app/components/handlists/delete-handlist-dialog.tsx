/**
 * DeleteHandlistDialog — the only frightening one
 *
 * A person deleting a handlist is afraid of losing records that are
 * never at risk, so the reassurance is given as much room as the
 * warning: a verdigris block states plainly that no record is
 * affected and that every member stays exactly where it is, and a
 * madder block names what actually goes — the name, the order, and
 * the handlist as an export scope. This is the only dialog in the set
 * that uses madder at all, and it uses it on the confirm button and
 * the loss block, nowhere else.
 *
 * The title and the provenance line both name the count, because
 * "Delete this handlist?" asks about an abstraction and "Delete
 * “Mission inventories” — 42 records" asks about something the person
 * recognizes. When the handlist is shared, the people who will lose
 * sight of it are named too: that is a consequence for someone else,
 * and it belongs before the button rather than after it.
 *
 * @version v0.7.0
 */
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import type { HandlistRecordType } from "~/lib/handlists.server";
import { HELD_KEYS } from "./handlist-labels";
import {
  DialogCancelButton,
  DialogConfirmButton,
  HandlistDialogShell,
} from "./handlist-dialog-shell";

export function DeleteHandlistDialog({
  name,
  recordType,
  total,
  shareCount,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  recordType: HandlistRecordType | null;
  /** Members held, tombstones included — what the copy counts. */
  total: number;
  shareCount: number;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("handlists");

  const held = recordType
    ? t(HELD_KEYS[recordType], { count: total })
    : t("metaHeldEmpty");

  return (
    <HandlistDialogShell
      provenance={`${t("provenance")} · ${name} · ${held}`}
      title={t("deleteTitle", { name })}
      titleId="handlist-delete-title"
      onDismiss={onCancel}
      footer={
        <>
          <DialogCancelButton label={t("cancel")} onClick={onCancel} />
          <DialogConfirmButton
            label={t("deleteConfirm")}
            tone="destructive"
            disabled={pending}
            onClick={onConfirm}
          />
        </>
      }
    >
      <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
        {t("deleteBody")}
      </p>

      <div className="mt-4 rounded-md border border-verdigris-soft bg-verdigris-wash px-3 py-2.5">
        <p className="text-sm leading-normal text-verdigris-deep [text-wrap:pretty]">
          <b className="font-semibold">{t("deleteKeepLead")}</b>{" "}
          {t("deleteKeepBody", { count: total })}
        </p>
      </div>

      <div className="mt-3 rounded-md border border-madder-tint bg-madder-wash px-3 py-2.5">
        <p className="text-sm leading-normal text-stone-600 [text-wrap:pretty]">
          <b className="font-semibold text-madder-deep">{t("deleteLossLead")}</b>{" "}
          {t("deleteLoss", { count: total })}
        </p>
      </div>

      {shareCount > 0 && (
        <span className="mt-3 flex items-start gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-stone-400" strokeWidth={1.75} />
          <span className="text-13 leading-normal text-stone-500">
            {t("deleteSharedNote", { count: shareCount })}
          </span>
        </span>
      )}

      {error && (
        <p className="mt-3 text-13 leading-normal text-madder-deep">{error}</p>
      )}
    </HandlistDialogShell>
  );
}
