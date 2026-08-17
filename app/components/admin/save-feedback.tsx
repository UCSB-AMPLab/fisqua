/**
 * Admin — Save Feedback
 *
 * This module is the single answer to "did my save land?" on the admin
 * forms. A partner put it plainly during a demo: the save button gave
 * no feedback at all. On a cataloguing tool that is a trust problem,
 * not a polish problem — an archivist who cannot tell whether a
 * description saved will either save again or assume it failed and
 * retype the whole thing.
 *
 * Three pieces, meant to be used together on any admin form:
 *
 *   - `resolveSaveFeedback` normalises whatever shape a route action
 *     happens to return into `{ kind, message }`. The admin routes grew
 *     up separately and speak four different dialects — `{ ok, message }`,
 *     `{ ok: false, error }`, `{ success: true }`, and `{ errors: {...} }`
 *     for field-level validation. Rather than rewrite every action's
 *     return contract, the resolver reads all four. It is a pure
 *     function so the mapping is unit-testable without rendering React.
 *
 *   - `SaveFeedbackBanner` renders the result. Success is transient and
 *     auto-dismisses; an error is PERSISTENT and never auto-dismisses.
 *     That asymmetry is deliberate: a failed save the user did not see
 *     is the original bug inverted, so the error stays on screen until
 *     the next submission replaces it.
 *
 *   - `SaveButton` is the pending affordance — disabled, label swapped
 *     to a busy phrase, spinner — driven by React Router's navigation
 *     or fetcher state via `isPendingSubmission`.
 *
 * Accessibility. A confirmation a screen reader never speaks reproduces
 * the original complaint for a subset of users, so both regions are
 * live regions, and both wrappers are rendered UNCONDITIONALLY even
 * when empty. Assistive technology only reliably announces content that
 * appears inside a live region already present in the accessibility
 * tree; a region mounted at the same moment as its text is frequently
 * missed. Success is `role="status"` / `aria-live="polite"` so it waits
 * for a pause in speech; a failed save is `role="alert"` /
 * `aria-live="assertive"` so it interrupts. The empty wrappers carry no
 * padding, border, or background, so they are invisible until filled.
 *
 * The visual language reuses the tokens already in play: verdigris for
 * "you are safe" and madder for failure, matching the four-state pill
 * in `viewer/save-status.tsx`. Several older admin routes drew errors
 * in `indigo-tint`, which is the same family as the page chrome and
 * read as informational rather than as a failure; those surfaces move
 * onto madder as they adopt this component.
 *
 * @version v0.6.0
 */

import { useEffect, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { BusySpinner } from "../imports/busy-submit";

/** How long a success confirmation stays on screen before self-dismissing. */
export const SUCCESS_DISMISS_MS = 6000;

export type SaveFeedbackKind = "success" | "error";

export interface SaveFeedbackResult {
  kind: SaveFeedbackKind;
  message: string;
}

export interface SaveFeedbackLabels {
  /** Shown when the action reports success but carries no message of its own. */
  success: string;
  /** Shown when the action reports failure but carries no message of its own. */
  error: string;
}

/**
 * Normalise a route action's return value into a feedback result.
 *
 * Reads the four return dialects in use across the admin routes:
 *
 *   `{ ok: true, message }`   → success with the action's own message
 *   `{ ok: true }`            → success with the caller's fallback label
 *   `{ success: true }`       → success with the caller's fallback label
 *   `{ ok: false, error }`    → error with the action's own message
 *   `{ error }`               → error with the action's own message
 *   `{ errors: { field: … } }` → error with the caller's fallback label
 *
 * Field-level validation results (`errors`) get a summary line as well
 * as their per-field messages: the fields may be scrolled off screen,
 * and the banner is what tells the user the save did not land at all.
 *
 * Anything else — including `undefined` before the first submission —
 * resolves to `null`, meaning "render nothing".
 */
export function resolveSaveFeedback(
  source: unknown,
  labels: SaveFeedbackLabels,
): SaveFeedbackResult | null {
  if (!source || typeof source !== "object") return null;
  const data = source as Record<string, unknown>;

  const ownError = typeof data.error === "string" && data.error.length > 0
    ? data.error
    : null;

  if (data.ok === false || ownError !== null) {
    return { kind: "error", message: ownError ?? labels.error };
  }

  if (
    data.errors &&
    typeof data.errors === "object" &&
    Object.keys(data.errors as Record<string, unknown>).length > 0
  ) {
    return { kind: "error", message: labels.error };
  }

  if (data.ok === true || data.success === true) {
    const ownMessage =
      typeof data.message === "string" && data.message.length > 0
        ? data.message
        : null;
    return { kind: "success", message: ownMessage ?? labels.success };
  }

  return null;
}

/**
 * Whether a feedback result is allowed to dismiss itself on a timer.
 *
 * Only a success may. An unseen failure is the original complaint
 * inverted — the archivist believes the save landed when it did not —
 * so an error stays on screen until the next submission replaces it.
 * Exported so the asymmetry is pinned by a unit test rather than
 * living only inside an effect.
 */
export function shouldAutoDismiss(kind: SaveFeedbackKind): boolean {
  return kind === "success";
}

/**
 * Whether the in-flight submission is THIS form's.
 *
 * Several admin forms post to the same route, so a button is only busy
 * while the pending submission carries its own discriminator. The
 * admin routes are split between two field names for that
 * discriminator — the older pages use `_action`, the imports journey
 * uses `intent` — so the field is a parameter rather than a constant.
 * Omitting `actionValue` means "busy on any submission to this route",
 * which is correct for a page with a single form.
 *
 * Any non-idle state counts: `submitting` covers the action itself and
 * `loading` covers the revalidation or redirect that follows, so the
 * button stays busy until the next render lands.
 */
export function isPendingSubmission(
  state: string,
  formData: FormData | undefined,
  actionValue?: string,
  field: string = "_action",
): boolean {
  if (state === "idle") return false;
  if (!actionValue) return true;
  return formData?.get(field) === actionValue;
}

interface SaveFeedbackBannerProps {
  /**
   * The raw action or fetcher payload (`actionData`, `fetcher.data`).
   * Passed raw rather than pre-resolved because its object identity is
   * stable across re-renders and changes exactly once per submission —
   * which is the cadence the auto-dismiss timer needs.
   */
  source: unknown;
  labels: SaveFeedbackLabels;
  /**
   * True while a new submission is in flight. Suppresses the previous
   * result so a stale error does not sit under a retry in progress.
   */
  pending?: boolean;
  /** Override the success dismissal delay; errors ignore it entirely. */
  dismissAfterMs?: number;
  /** Extra classes on the rendered banner (not on the live-region wrappers). */
  className?: string;
}

export function SaveFeedbackBanner({
  source,
  labels,
  pending = false,
  dismissAfterMs = SUCCESS_DISMISS_MS,
  className = "",
}: SaveFeedbackBannerProps) {
  const feedback = resolveSaveFeedback(source, labels);
  const isSuccess = feedback?.kind === "success";
  const dismissible = feedback ? shouldAutoDismiss(feedback.kind) : false;
  const [dismissed, setDismissed] = useState(false);

  // Re-arm on every new payload. `source` identity changes once per
  // submission, so a second save after a dismissal shows its
  // confirmation again.
  useEffect(() => {
    setDismissed(false);
    if (!dismissible) return;
    const timer = setTimeout(() => setDismissed(true), dismissAfterMs);
    return () => clearTimeout(timer);
  }, [source, dismissible, dismissAfterMs]);

  const showSuccess = !pending && isSuccess && !dismissed;
  const showError = !pending && feedback?.kind === "error";
  const banner = `flex items-center gap-2 rounded-md border px-4 py-3 font-sans text-sm ${className}`;

  return (
    <>
      <div role="status" aria-live="polite">
        {showSuccess && feedback ? (
          <div
            className={`${banner} border-verdigris bg-verdigris-tint text-stone-700`}
          >
            <Check
              className="h-4 w-4 shrink-0 text-verdigris-deep"
              aria-hidden="true"
            />
            <span>{feedback.message}</span>
          </div>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive">
        {showError && feedback ? (
          <div
            className={`${banner} border-madder bg-madder-tint text-madder-deep`}
          >
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{feedback.message}</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

interface SaveButtonProps {
  /** From `isPendingSubmission`. */
  pending: boolean;
  /** Idle label, e.g. `t("common:button.save")`. */
  label: string;
  /** Busy label, e.g. `t("common:save.saving")`. */
  pendingLabel: string;
  className?: string;
  /** Optional submit-button name/value pair for forms that discriminate on it. */
  name?: string;
  value?: string;
}

/**
 * The primary submit button with its pending state wired in. Disabling
 * while pending is UI courtesy, not a concurrency guard — the server
 * actions remain the real double-submit defence.
 */
export function SaveButton({
  pending,
  label,
  pendingLabel,
  className = "",
  name,
  value,
}: SaveButtonProps) {
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-disabled={pending || undefined}
      className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {pending ? <BusySpinner /> : null}
      {pending ? pendingLabel : label}
    </button>
  );
}
