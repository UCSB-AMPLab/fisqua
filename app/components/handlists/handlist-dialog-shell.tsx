/**
 * HandlistDialogShell — the house dialog chrome, for the four small moments
 *
 * Creating, renaming, sharing and deleting a handlist are four
 * dialogs that differ only in what they say, so they share one shell
 * rather than four copies of the same markup. The chrome is the house
 * one, inherited from the decisions modals and unchanged: an
 * `rgba(20,32,58,0.42)` scrim, a 27rem box with a real border and
 * uniform padding, a mono uppercase provenance line naming the subject
 * above a serif title, and 44px buttons in the footer.
 *
 * THE PROVENANCE LINE is the reason this shell exists as its own
 * component. "Delete this handlist?" asks about an abstraction;
 * "Handlist · Mission inventories · 42 records" above "Delete
 * “Mission inventories”?" asks about something the person recognizes.
 * Every dialog in the set states the count it acts on, so the line is
 * required rather than optional.
 *
 * Presentational only: the caller owns the submission and the footer,
 * exactly as `DismissDialog` does, so a dialog can be driven by a
 * fetcher on one page and a form on another without the shell knowing.
 *
 * @version v0.7.0
 */
import type { ReactNode } from "react";

export interface HandlistDialogShellProps {
  /** Mono uppercase line naming the subject and its count. */
  provenance: string;
  title: string;
  /** Stable id so the box can be labelled by its own title. */
  titleId: string;
  children: ReactNode;
  /** The 44px button row. Right-aligned; a `.sp` note may lead it. */
  footer: ReactNode;
  /** Escape and the scrim both mean cancel. */
  onDismiss: () => void;
}

export function HandlistDialogShell({
  provenance,
  title,
  titleId,
  children,
  footer,
  onDismiss,
}: HandlistDialogShellProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.42)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") onDismiss();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-[27rem] overflow-y-auto rounded-lg border border-stone-200 bg-white p-6 shadow-lg">
        <p className="font-mono text-11 font-medium uppercase tracking-[0.04em] text-stone-400">
          {provenance}
        </p>
        <p
          id={titleId}
          className="mt-1 font-serif text-xl font-semibold leading-snug tracking-[-0.005em] text-indigo"
        >
          {title}
        </p>
        {children}
        <div className="mt-5 flex items-center justify-end gap-2.5">
          {footer}
        </div>
      </div>
    </div>
  );
}

/** The cancel button, identical in all four dialogs. */
export function DialogCancelButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-11 items-center rounded-lg border border-stone-300 bg-white px-4.5 text-15 font-semibold text-indigo hover:border-stone-400 hover:bg-stone-50"
    >
      {label}
    </button>
  );
}

/**
 * The confirm button. `tone` is `"indigo"` everywhere but delete —
 * madder appears in this set exactly once, on the only moment a person
 * can be frightened.
 */
export function DialogConfirmButton({
  label,
  tone = "indigo",
  disabled,
  onClick,
}: {
  label: string;
  tone?: "indigo" | "destructive";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-11 items-center rounded-lg px-4.5 text-15 font-semibold text-parchment disabled:cursor-not-allowed disabled:opacity-30 ${
        tone === "destructive"
          ? "bg-madder text-white hover:bg-madder-deep"
          : "bg-indigo hover:bg-indigo-deep"
      }`}
    >
      {label}
    </button>
  );
}
