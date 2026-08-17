/**
 * CreateHandlistDialog — naming a handlist into existence
 *
 * The one required act. A handlist is named at creation because an
 * "Untitled" handlist is one nobody reopens, so the confirm stays
 * disabled until there is a name, and the only thing that can go wrong
 * — a name this person is already using — comes back from the server
 * and renders under the field.
 *
 * Opened from the index, this dialog creates an EMPTY handlist, which
 * is why it states rather than shows the type: nothing has fixed it
 * yet, and the aside says what will. The other route into creation —
 * from a search selection, where the type and the count are already
 * known — belongs to the add-to-handlist picker, not here.
 *
 * Presentational: the caller owns the submission and passes `pending`
 * and `error` back down, the same contract `DismissDialog` uses.
 *
 * @version v0.7.0
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Info } from "lucide-react";
import {
  DialogCancelButton,
  DialogConfirmButton,
  HandlistDialogShell,
} from "./handlist-dialog-shell";

export function CreateHandlistDialog({
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  /** A sentence already resolved in the reader's language. */
  error?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const { t } = useTranslation("handlists");
  const [name, setName] = useState("");
  const trimmed = name.trim();

  return (
    <HandlistDialogShell
      provenance={t("provenance")}
      title={t("createTitle")}
      titleId="handlist-create-title"
      onDismiss={onCancel}
      footer={
        <>
          <DialogCancelButton label={t("cancel")} onClick={onCancel} />
          <DialogConfirmButton
            label={t("createConfirm")}
            disabled={pending || trimmed.length === 0}
            onClick={() => onConfirm(trimmed)}
          />
        </>
      }
    >
      <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
        {t("createBody")}
      </p>

      <label
        htmlFor="handlist-create-name"
        className="mt-5 block text-sm font-medium text-stone-700"
      >
        {t("nameLabel")}
      </label>
      <input
        id="handlist-create-name"
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
      {error ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-13 leading-normal text-madder-deep">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          {error}
        </p>
      ) : (
        <p className="mt-1.5 font-mono text-11 nums text-stone-400">
          {trimmed.length}/80
        </p>
      )}

      <span className="mt-3 flex items-start gap-2">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-stone-400" strokeWidth={1.75} />
        <span className="text-13 leading-normal text-stone-500">
          {t("createAside")}
        </span>
      </span>
    </HandlistDialogShell>
  );
}
