/**
 * ShareHandlistDialog — sharing, and what sharing does not do
 *
 * The list of people is the easy half. The substance of this dialog is
 * the paragraph under it, because what sharing does NOT convey is what
 * everybody assumes wrongly: it grants no module access, it changes
 * nothing about which export formats a person is offered — that
 * follows their own role — and it withholds no member either, so the
 * count is one number for everyone.
 *
 * ELIGIBILITY IS SHOWN, NOT HIDDEN. The candidate list is every person
 * in the workspace, with the ones who could never open this handlist
 * DIMMED and carrying their reason rather than quietly missing. A
 * handlist of entities or places is admin-only because its module is,
 * and a list that silently omits a colleague teaches nothing about
 * why. The server refuses the same share with the same reason, so the
 * dimming is a promise the server keeps rather than a politeness.
 *
 * ONE CONTROL PER PERSON. A role select carrying no-access / view only
 * / can edit covers sharing, re-roling and unsharing in the same
 * place, which is one fewer button than three separate affordances and
 * reads as the single question it is.
 *
 * OWNERSHIP TRANSFER is deliberately absent from this surface (ruled
 * 2026-08-16): the server keeps `transferOwnership` — owner_id is
 * RESTRICT, so a departure still needs a settlement path — but no
 * dialog offers it yet. When someone actually leaves, the handover
 * gets a surface; until then a control nobody needs would only add
 * weight to a dialog about sharing.
 *
 * @version v0.7.0
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import type {
  HandlistLockReason,
  HandlistRecordType,
  HandlistShareCandidate,
  HandlistShareRole,
} from "~/lib/handlists.server";
import { HELD_KEYS } from "./handlist-labels";
import { DialogCancelButton, HandlistDialogShell } from "./handlist-dialog-shell";

/** Machine reason → the sentence the reader gets, in their language. */
const REASON_KEYS: Record<HandlistLockReason, string> = {
  "authorities-admin-only": "reasonAuthoritiesAdminOnly",
};

/** Two letters from whatever the person is known by. */
function initials(name: string | null, email: string): string {
  const source = (name ?? email).trim();
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]);
  return (letters.join("") || source.slice(0, 2)).toUpperCase();
}

export function ShareHandlistDialog({
  name,
  recordType,
  total,
  candidates,
  workspaceVisible,
  pending,
  error,
  onClose,
  onSetRole,
  onUnshare,
  onToggleWorkspaceVisible,
}: {
  name: string;
  recordType: HandlistRecordType | null;
  total: number;
  candidates: HandlistShareCandidate[];
  workspaceVisible: boolean;
  pending: boolean;
  error?: string;
  onClose: () => void;
  /** Share, or change an existing share's role. */
  onSetRole: (userId: string, role: HandlistShareRole) => void;
  onUnshare: (userId: string) => void;
  onToggleWorkspaceVisible: (next: boolean) => void;
}) {
  const { t } = useTranslation("handlists");
  const [filter, setFilter] = useState("");

  const held = recordType
    ? t(HELD_KEYS[recordType], { count: total })
    : t("metaHeldEmpty");

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? candidates.filter(
        (c) =>
          c.email.toLowerCase().includes(needle) ||
          (c.name ?? "").toLowerCase().includes(needle),
      )
    : candidates;

  return (
    <HandlistDialogShell
      provenance={`${t("provenance")} · ${name} · ${held}`}
      title={t("shareTitle", { name })}
      titleId="handlist-share-title"
      onDismiss={onClose}
      footer={<DialogCancelButton label={t("shareDone")} onClick={onClose} />}
    >
      <p className="mt-2 text-sm leading-relaxed text-indigo-soft [text-wrap:pretty]">
        {t("shareBody")}
      </p>

      <label
        htmlFor="handlist-share-filter"
        className="mt-5 block text-sm font-medium text-stone-700"
      >
        {t("shareAddLabel")}
      </label>
      <input
        id="handlist-share-filter"
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("shareAddLabel")}
        className="mt-1.5 h-11 w-full rounded-lg border border-stone-300 px-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-verdigris focus:outline-none focus:ring-1 focus:ring-verdigris"
      />

      <div className="mt-4">
        {shown.length === 0 ? (
          <p className="text-13 text-stone-500">{t("shareNobody")}</p>
        ) : (
          shown.map((person) => (
            <div
              key={person.userId}
              className={`flex items-center gap-2.5 border-b border-stone-100 py-2 last:border-b-0 ${
                person.eligible ? "" : "opacity-40"
              }`}
            >
              <span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-indigo-tint text-[0.625rem] font-bold text-indigo">
                {initials(person.name, person.email)}
              </span>
              <span className="min-w-0 flex-1">
                <b className="block truncate text-sm font-semibold text-indigo">
                  {person.name ?? person.email}
                </b>
                <small className="block truncate text-xs text-stone-500">
                  {person.email}
                </small>
                {!person.eligible && person.ineligibleReason && (
                  <small className="mt-0.5 block text-11 leading-normal text-stone-500">
                    {t(REASON_KEYS[person.ineligibleReason])}
                  </small>
                )}
              </span>
              {person.isOwner ? (
                <span className="rounded-full bg-verdigris-tint px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[0.06em] text-verdigris-deep">
                  {t("shareOwner")}
                </span>
              ) : (
                <select
                  aria-label={t("shareAddLabel")}
                  disabled={pending || !person.eligible}
                  value={person.role ?? ""}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next === "") onUnshare(person.userId);
                    else onSetRole(person.userId, next as HandlistShareRole);
                  }}
                  className="h-8 rounded-lg border border-stone-300 bg-white px-2 text-13 text-stone-700 disabled:cursor-not-allowed"
                >
                  <option value="">
                    {person.eligible ? "—" : t("shareIneligible")}
                  </option>
                  <option value="viewer">{t("shareRoleViewer")}</option>
                  <option value="editor">{t("shareRoleEditor")}</option>
                </select>
              )}
            </div>
          ))
        )}
      </div>

      {/* The workspace-visible arm: reachable and readable, no more. */}
      <label className="mt-4 flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={workspaceVisible}
          disabled={pending}
          onChange={(e) => onToggleWorkspaceVisible(e.target.checked)}
          className="mt-0.5 h-4 w-4 flex-none rounded border-stone-300 text-indigo focus:ring-verdigris"
        />
        <span>
          <span className="block text-sm font-medium text-stone-700">
            {t("workspaceVisibleLabel")}
          </span>
          <span className="block text-13 leading-normal text-stone-500">
            {t("workspaceVisibleHint")}
          </span>
        </span>
      </label>

      <div className="mt-4 rounded-md border border-verdigris-soft bg-verdigris-wash px-3 py-2.5">
        <p className="text-sm leading-normal text-verdigris-deep [text-wrap:pretty]">
          <b className="font-semibold">{t("shareKeepLead")}</b>{" "}
          {t("shareKeepBody", { count: total })}
        </p>
      </div>

      <span className="mt-3 flex items-start gap-2">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-none text-stone-400" strokeWidth={1.75} />
        <span className="text-13 leading-normal text-stone-500">
          {t("shareAside")}
        </span>
      </span>

      {error && (
        <p className="mt-3 text-13 leading-normal text-madder-deep">{error}</p>
      )}
    </HandlistDialogShell>
  );
}
