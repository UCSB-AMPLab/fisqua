/**
 * Digitization — Scanner Screen Parts
 *
 * This module holds the parts of the Scanner screen
 * (`_auth.admin.capture.scanner.tsx`) that open only after a click, so
 * that its render suite can show them without a browser: the
 * confirmation step that Replace token, Revoke and Erase stored keys open
 * in place of their buttons (`Confirm`), the confirmation of a pairing
 * code after Look up (`PairConfirm`), and the message for each error the
 * Scanner action can answer (`scannerErrorMessage`), with the rule for
 * which section shows it (`shownError`) and for where focus goes when a
 * confirmation closes (`focusAfterClose`). The button classes
 * and the label-and-value `Field` the screen uses everywhere are here
 * too, so that the screen and its parts share one copy.
 *
 * `Confirm` for Revoke asks why the token is revoked, with two radio
 * options and neither chosen at first: the unit was reset or replaced,
 * or it was lost, stolen or compromised, which also erases the stored
 * keys. Its confirm button stays disabled until a reason is chosen, and
 * the reason is passed to `onConfirm`. Replace asks nothing; Erase
 * stored keys says what erasing does and that it is not reversible. Only
 * the Revoke and Erase confirmations use madder, the danger dye, for
 * their border and their confirm button; no resting button on the screen
 * does.
 *
 * `PairConfirm` lists the code as the server formatted it, the unit name
 * and device id the unit sent with its code, and the workspace the code
 * would be approved for. The unit is not yet authenticated when it sends
 * its name and id, so they are rendered as plain text, through React's
 * escaping, and never put into a translated sentence. The unit name is
 * free text and is set in the page's sans type; the code and the device
 * id are set in mono. The workspace the unit reports being linked to
 * (`currentTenant`) is checked by the server against the slug pattern
 * and is shown as plain text in its sentence. When the workspace already
 * has a linked unit, the confirmation says that the linked unit loses
 * Fisqua but keeps the bucket keys until they are revoked in B2, and
 * points to Erase stored keys.
 *
 * `actionNotice` chooses the sentence shown after a success. After a
 * revoke for a lost, stolen or compromised unit it says whether stored
 * keys were erased and whether Fisqua's operators were told; when no
 * operator was told it asks the administrator to contact one directly,
 * since the unit's keys work in B2 until an operator revokes them there.
 * After Erase stored keys it says the same of the operators.
 *
 * `scannerErrorMessage` takes the area the action was posted from
 * (`token`, `pair` or `erase`) because the same error reads differently
 * in each: `changed` is a changed scanner for a token action, and a
 * changed scanner or changed stored keys for a pairing or an erasure. A
 * pairing refused for too many wrong codes (`pair_limited`) says when
 * codes are accepted again, from `retryAfterSeconds`, rounded up to whole
 * minutes, or "less than a minute" below 60 seconds.
 *
 * @version v0.9.0
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PairingView, ScannerActionError, ScannerActionResult } from "../../lib/capture/scanner.server";

export const PRIMARY =
  "inline-flex h-11 items-center gap-2 rounded-md bg-indigo px-4 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-30";
export const SECONDARY =
  "inline-flex h-11 items-center gap-2 rounded-md border border-stone-200 bg-white px-4 font-sans text-sm font-semibold text-indigo hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-30";
export const DESTRUCTIVE =
  "inline-flex h-11 items-center gap-2 rounded-md bg-madder px-4 font-sans text-sm font-semibold text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-30";

/** Why a token is revoked, as the action takes it in `reason`. */
export type RevokeReason = "replaced" | "compromised";

/** Where an action was posted from, which decides how its error reads. */
export type ActionArea = "token" | "pair" | "erase";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-sans text-xs font-medium text-stone-500">{label}</dt>
      <dd className="mt-1 font-sans text-[15px] text-indigo">
        {children}
        {hint ? <p className="mt-1 font-sans text-xs text-stone-500">{hint}</p> : null}
      </dd>
    </div>
  );
}

/** The confirmation step of Replace token, Revoke and Erase stored keys. */
export function Confirm({
  kind,
  busy,
  onCancel,
  onConfirm,
}: {
  kind: "replace" | "revoke" | "erase";
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason?: RevokeReason) => void;
}) {
  const { t } = useTranslation("capture");
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [reason, setReason] = useState<RevokeReason | null>(null);
  useEffect(() => heading.current?.focus(), []);
  const danger = kind !== "replace";
  const ready = kind !== "revoke" || reason !== null;
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={`mt-4 rounded-md border bg-white p-4 ${danger ? "border-madder" : "border-stone-200"}`}
    >
      <h3 id={titleId} ref={heading} tabIndex={-1} className="font-sans text-[15px] font-semibold text-indigo focus:outline-none">
        {t(`scanner.confirm_${kind}_title`)}
      </h3>
      <p className="mt-1 font-sans text-sm text-stone-600">{t(`scanner.confirm_${kind}_body`)}</p>
      {kind === "revoke" ? <RevokeReasons reason={reason} onChange={setReason} /> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={SECONDARY} onClick={onCancel} disabled={busy}>
          {t("scanner.cancel")}
        </button>
        <button
          type="button"
          className={danger ? DESTRUCTIVE : PRIMARY}
          onClick={() => onConfirm(reason ?? undefined)}
          disabled={busy || !ready}
        >
          {t(`scanner.confirm_${kind}`)}
        </button>
      </div>
    </div>
  );
}

function RevokeReasons({ reason, onChange }: { reason: RevokeReason | null; onChange: (r: RevokeReason) => void }) {
  const { t } = useTranslation("capture");
  const name = useId();
  const options: RevokeReason[] = ["replaced", "compromised"];
  return (
    <fieldset className="mt-4">
      <legend className="font-sans text-sm font-medium text-indigo">{t("scanner.revoke_reason_legend")}</legend>
      <div className="mt-2 flex flex-col gap-3">
        {options.map((option) => {
          const id = `${name}-${option}`;
          return (
            <div key={option} className="flex items-start gap-2">
              <input
                id={id}
                type="radio"
                name={name}
                value={option}
                checked={reason === option}
                onChange={() => onChange(option)}
                aria-describedby={`${id}-note`}
                className="mt-1 h-4 w-4 accent-indigo"
              />
              <div>
                <label htmlFor={id} className="font-sans text-sm text-indigo">
                  {t(`scanner.revoke_reason_${option}`)}
                </label>
                <p id={`${id}-note`} className="font-sans text-xs text-stone-500">
                  {t(`scanner.revoke_reason_${option}_note`)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The confirmation of a pairing code after Look up (module header). */
export function PairConfirm({
  pairing,
  workspace,
  busy,
  onCancel,
  onApprove,
}: {
  pairing: PairingView;
  /** The name of the workspace the code would be approved for. */
  workspace: string;
  busy: boolean;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const { t } = useTranslation("capture");
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div role="group" aria-labelledby={titleId} className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-4">
      <h3 id={titleId} ref={heading} tabIndex={-1} className="font-sans text-[15px] font-semibold text-indigo focus:outline-none">
        {t("scanner.pair_confirm_title")}
      </h3>
      <p className="mt-1 font-sans text-sm text-stone-600">{t("scanner.pair_confirm_body")}</p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label={t("scanner.pair_code")}>
          <span className="font-mono">{pairing.code}</span>
        </Field>
        <Field label={t("scanner.unit_name")}>{pairing.unitName}</Field>
        <Field label={t("scanner.device_id")}>
          <span className="font-mono">{pairing.deviceId}</span>
        </Field>
        <Field label={t("scanner.workspace")}>{workspace}</Field>
      </dl>
      {pairing.currentTenant ? (
        <p className="mt-4 font-sans text-sm text-stone-600">
          {t("scanner.pair_current_tenant", { slug: pairing.currentTenant })}
        </p>
      ) : null}
      {pairing.replacesLinkedUnit ? (
        <p className="mt-4 font-sans text-sm text-indigo">{t("scanner.pair_replaces")}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={SECONDARY} onClick={onCancel} disabled={busy}>
          {t("scanner.cancel")}
        </button>
        <button type="button" className={PRIMARY} onClick={onApprove} disabled={busy}>
          {t("scanner.pair_approve")}
        </button>
      </div>
    </div>
  );
}

/** A sentence shown after an action succeeded, in the section it was taken from. */
export interface ActionNotice {
  area: ActionArea;
  key:
    | "pair_approved"
    | "revoked_erased_notified"
    | "revoked_erased_unnotified"
    | "revoked_none_stored_notified"
    | "revoked_none_stored_unnotified"
    | "erased_notified"
    | "erased_unnotified";
}

/**
 * The sentence to show after a successful action, or null (module
 * header): an approval; a revoke for a lost, stolen or compromised unit
 * (`revokeReason`), by whether stored keys were erased and whether any
 * operator was told; Erase stored keys, by whether any operator was told.
 */
export function actionNotice(answer: ScannerActionResult, revokeReason: RevokeReason | null): ActionNotice | null {
  if (!answer.ok) return null;
  if (answer.step === "pair_approve") return { area: "pair", key: "pair_approved" };
  if (answer.step === "erase_keys") {
    return { area: "erase", key: answer.operatorsNotified ? "erased_notified" : "erased_unnotified" };
  }
  if (answer.step === "revoke" && revokeReason === "compromised") {
    const told = answer.operatorsNotified ? "notified" : "unnotified";
    return { area: "token", key: answer.keysErased ? `revoked_erased_${told}` : `revoked_none_stored_${told}` };
  }
  return null;
}

/**
 * Where focus goes when a confirmation has closed: `wait` while a request
 * or the revalidation after it is in flight, since a button disabled then
 * cannot take focus and may be gone once it ends; `none` when a new token
 * is shown, which takes focus itself; `opener` when the control that
 * opened the confirmation is on the page and enabled; `section` otherwise.
 */
export function focusAfterClose(state: {
  busy: boolean;
  newToken: boolean;
  opener: { disabled: boolean } | null;
}): "wait" | "none" | "opener" | "section" {
  if (state.busy) return "wait";
  if (state.newToken) return "none";
  return state.opener && !state.opener.disabled ? "opener" : "section";
}

/**
 * The error to show in `area`, or null: only the answer to the request
 * sent from that section (`sentFrom`), never while a request is in
 * flight, and none once the page has dismissed it (`sentFrom` null).
 */
export function shownError(
  t: TFunction,
  area: ActionArea,
  state: { busy: boolean; sentFrom: ActionArea | null; answer: ScannerActionResult | undefined },
): string | null {
  const { busy, sentFrom, answer } = state;
  if (busy || sentFrom !== area || !answer || answer.ok) return null;
  return scannerErrorMessage(t, area, answer);
}

/** The message for an error the Scanner action answered (module header). */
export function scannerErrorMessage(
  t: TFunction,
  area: ActionArea,
  answer: { ok: false; error: ScannerActionError; retryAfterSeconds?: number },
): string {
  switch (answer.error) {
    case "pair_unknown":
      return t("scanner.error_pair_unknown");
    case "pair_not_waiting":
      return t("scanner.error_pair_not_waiting");
    case "pair_no_keys":
      return t("scanner.pair_no_keys");
    case "pair_keys_unreadable":
      return t("scanner.error_pair_keys_unreadable");
    case "pair_limited": {
      const seconds = answer.retryAfterSeconds ?? 0;
      if (seconds < 60) return t("scanner.error_pair_limited_soon");
      return t("scanner.error_pair_limited", { count: Math.ceil(seconds / 60) });
    }
    case "no_stored_keys":
      return t("scanner.error_no_stored_keys");
    case "several_scanners":
      return t("scanner.error_several_scanners");
    case "invalid_name":
      return t("scanner.appliance_id_invalid");
    case "changed":
    case "live_token":
    case "no_live_token":
    case "no_scanner":
      return area === "token" ? t("scanner.error_changed") : t("scanner.error_changed_keys");
    case "invalid_request":
    case "unconfirmed":
    case "name_mismatch":
      return area === "pair"
        ? t("scanner.error_pair_failed")
        : area === "erase"
          ? t("scanner.error_erase_failed")
          : t("scanner.error_failed");
  }
}

// @version v0.9.0
