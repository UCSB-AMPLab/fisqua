/**
 * RenameHandlistDialog — the one moment with no consequence
 *
 * Renaming changes nothing but the name, so this dialog carries no
 * explanation at all — only the field, and a footnote restating the
 * count so the person can see that the members are not what is being
 * touched.
 *
 * The one thing that can go wrong is a name the owner is already
 * using. Names must differ because export history names the handlist a
 * run was taken from, and two runs have to be tellable apart; the
 * server refuses with a 409 and the caller hands the sentence back
 * here, where it renders under the field and holds the confirm shut.
 *
 * @version v0.7.0
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import type { HandlistRecordType } from "~/lib/handlists.server";
import { HELD_KEYS } from "./handlist-labels";
import {
  DialogCancelButton,
  DialogConfirmButton,
  HandlistDialogShell,
} from "./handlist-dialog-shell";

export function RenameHandlistDialog({
  name: currentName,
  recordType,
  total,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  name: string;
  recordType: HandlistRecordType | null;
  total: number;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const { t } = useTranslation("handlists");
  const [name, setName] = useState(currentName);
  const trimmed = name.trim();

  const held = recordType
    ? t(HELD_KEYS[recordType], { count: total })
    : t("metaHeldEmpty");

  return (
    <HandlistDialogShell
      provenance={`${t("provenance")} · ${currentName} · ${held}`}
      title={t("renameTitle")}
      titleId="handlist-rename-title"
      onDismiss={onCancel}
      footer={
        <>
          <span className="mr-auto text-13 text-stone-400">
            {held} · {t("renameUnaffected")}
          </span>
          <DialogCancelButton label={t("cancel")} onClick={onCancel} />
          <DialogConfirmButton
            label={t("renameConfirm")}
            disabled={pending || trimmed.length === 0}
            onClick={() => onConfirm(trimmed)}
          />
        </>
      }
    >
      <label
        htmlFor="handlist-rename-name"
        className="mt-5 block text-sm font-medium text-stone-700"
      >
        {t("nameLabel")}
      </label>
      <input
        id="handlist-rename-name"
        type="text"
        autoFocus
        value={name}
        maxLength={80}
        placeholder={t("namePlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed.length > 0 && !pending) {
            onConfirm(trimmed);
          }
        }}
        className={`mt-1.5 h-11 w-full rounded-lg border px-3 text-sm text-stone-700 placeholder:text-stone-400 focus:outline-none focus:ring-1 ${
          error
            ? "border-madder ring-madder focus:border-madder focus:ring-madder"
            : "border-stone-300 focus:border-verdigris focus:ring-verdigris"
        }`}
      />
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-13 leading-normal text-madder-deep">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          {error}
        </p>
      )}
    </HandlistDialogShell>
  );
}
