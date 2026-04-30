/**
 * Resolve QC Flag Dialog
 *
 * Modal that leads use to close out an open QC flag. Collects the
 * resolution action, an optional resolver note (required when the
 * action is "other"), and submits with the encType that keeps the
 * React Router loader on the other side readable. The role guard
 * on the parent mirrors the server guard so a cataloguer never
 * sees an unauthorised button.
 *
 * @version v0.3.0
 */
import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { CheckCircle2, X } from "lucide-react";

export type QcStatus = "resolved" | "wontfix";

export type QcResolutionAction =
  | "retake_requested"
  | "reordered"
  | "marked_duplicate"
  | "ignored"
  | "other";

const STATUSES: { value: QcStatus; labelKey: string }[] = [
  { value: "resolved", labelKey: "qc_flags:card.status.resolved" },
  { value: "wontfix", labelKey: "qc_flags:card.status.wontfix" },
];

const ACTIONS: { value: QcResolutionAction; labelKey: string }[] = [
  {
 value: "retake_requested",
 labelKey: "qc_flags:card.resolution_action.retake_requested",
  },
  {
 value: "reordered",
 labelKey: "qc_flags:card.resolution_action.reordered",
  },
  {
 value: "marked_duplicate",
 labelKey: "qc_flags:card.resolution_action.marked_duplicate",
  },
  {
 value: "ignored",
 labelKey: "qc_flags:card.resolution_action.ignored",
  },
  {
 value: "other",
 labelKey: "qc_flags:card.resolution_action.other",
  },
];

export type ResolveQcFlagDialogProps = {
  open: boolean;
  onClose: () => void;
  flagId: string;
  userRole: "lead" | "cataloguer" | "reviewer";
  onResolved?: () => void;
  onError?: (message: string) => void;
};

type ResolveOk = { ok: true };
type ResolveErr = { error: string };
type ResolveResponse = ResolveOk | ResolveErr;

function isOk(data: unknown): data is ResolveOk {
  return (
 typeof data === "object" &&
 data !== null &&
 "ok" in data &&
 (data as { ok: unknown }).ok === true
  );
}

function isErr(data: unknown): data is ResolveErr {
  return (
 typeof data === "object" &&
 data !== null &&
 "error" in data &&
 typeof (data as { error: unknown }).error === "string"
  );
}

/**
 * Pure validity predicate — exported for unit tests.
 *
 * A resolve submission is valid when:
 * 1. `resolutionAction` has been chosen (status has a default so it's
 * always populated).
 * 2. Either the action is not `"other"`, or `resolverNote` is non-empty
 * after trim. The "other → note required" rule comes from and
 * is also enforced server-side in `resolveQcFlag`.
 *
 * Status is typed into the enum so an unknown string cannot reach here
 * without a type-cast; the helper intentionally does not re-validate its
 * enum membership.
 */
export function isValidResolve(
  status: QcStatus | null,
  resolutionAction: QcResolutionAction | null,
  resolverNote: string
): boolean {
  if (status === null) return false;
  if (resolutionAction === null) return false;
  if (resolutionAction === "other" && resolverNote.trim().length === 0) {
 return false;
  }
  return true;
}

export function ResolveQcFlagDialog({
  open,
  onClose,
  flagId,
  userRole,
  onResolved,
  onError,
}: ResolveQcFlagDialogProps) {
  // Client-side role guard. Server still enforces via requireProjectRole.
  if (userRole !== "lead") return null;

  const { t } = useTranslation(["qc_flags"]);
  const fetcher = useFetcher<ResolveResponse>();

  const [status, setStatus] = useState<QcStatus>("resolved");
  const [resolutionAction, setResolutionAction] =
 useState<QcResolutionAction | null>(null);
  const [resolverNote, setResolverNote] = useState("");

  const noteRequired = resolutionAction === "other";
  const isValid = isValidResolve(status, resolutionAction, resolverNote);
  const submitting = fetcher.state !== "idle";

  // Fire onResolved / onError exactly once when a fetcher response resolves.
  useEffect(() => {
 if (fetcher.state !== "idle" || !fetcher.data) return;
 if (isOk(fetcher.data)) {
 onResolved?.();
 setStatus("resolved");
 setResolutionAction(null);
 setResolverNote("");
 onClose();
 } else if (isErr(fetcher.data)) {
 onError?.(fetcher.data.error);
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  function handleSubmit() {
 if (!isValid || submitting) return;
 const payload: Record<string, unknown> = {
 flagId,
 status,
 resolutionAction,
 };
 if (resolverNote.trim().length > 0) {
 payload.resolverNote = resolverNote.trim();
 }
 // JSON encType accepts arbitrary serialisable payloads; cast so the
 // SubmitTarget union doesn't reject the optional resolverNote field.
 fetcher.submit(payload as Parameters<typeof fetcher.submit>[0], {
 method: "PATCH",
 action: "/api/qc-flags",
 encType: "application/json",
 });
  }

  function handleClose() {
 if (submitting) return;
 setStatus("resolved");
 setResolutionAction(null);
 setResolverNote("");
 onClose();
  }

  if (!open) return null;

  return (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
 <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-xl bg-white shadow-lg">
 {/* Header */}
 <div className="flex items-start gap-3 p-6 pb-4">
 <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
 <CheckCircle2 className="h-5 w-5 text-emerald-600" />
 </div>
 <div className="flex-1">
 <h2 className="font-display text-2xl font-semibold text-stone-800">
 {t("qc_flags:card.resolve_button")}
 </h2>
 </div>
 <button
 onClick={handleClose}
 disabled={submitting}
 aria-label={t("qc_flags:dialog.cancel")}
 className="text-stone-400 hover:text-stone-600 disabled:opacity-50"
 >
 <X className="h-5 w-5" />
 </button>
 </div>

 <div className="space-y-5 p-6 pt-4">
 {/* Status radio group */}
 <div>
 <h3 className="mb-2 text-sm font-medium text-stone-700">
 {t("qc_flags:card.status.open")}
 </h3>
 <div className="space-y-2">
 {STATUSES.map((s) => (
 <label
 key={s.value}
 className="font-medium flex cursor-pointer items-center gap-3 rounded-lg border border-stone-200 p-3 hover:bg-stone-50"
 >
 <input
 type="radio"
 name="qc-flag-status"
 value={s.value}
 checked={status === s.value}
 onChange={() => setStatus(s.value)}
 className="accent-verdigris"
 />
 <span className="text-sm font-medium text-stone-700">
 {t(s.labelKey)}
 </span>
 </label>
 ))}
 </div>
 </div>

 {/* Resolution action radio group */}
 <div>
 <h3 className="mb-2 text-sm font-medium text-stone-700">
 {t("qc_flags:dialog.problem_type_label")}
 </h3>
 <div className="space-y-2">
 {ACTIONS.map((a) => (
 <label
 key={a.value}
 className="font-medium flex cursor-pointer items-center gap-3 rounded-lg border border-stone-200 p-3 hover:bg-stone-50"
 >
 <input
 type="radio"
 name="qc-flag-resolution-action"
 value={a.value}
 checked={resolutionAction === a.value}
 onChange={() => setResolutionAction(a.value)}
 className="accent-verdigris"
 />
 <span className="text-sm font-medium text-stone-700">
 {t(a.labelKey)}
 </span>
 </label>
 ))}
 </div>
 </div>

 {/* Resolver note textarea (always visible; required when action = other) */}
 <div>
 <label
 htmlFor="qc-flag-resolver-note"
 className="mb-1 block text-sm font-medium text-indigo"
 >
 {t("qc_flags:dialog.description_label")}
 {noteRequired && (
 <span className="ml-1 text-madder-deep" aria-hidden="true">
 *
 </span>
 )}
 </label>
 <textarea
 id="qc-flag-resolver-note"
 value={resolverNote}
 onChange={(e) => setResolverNote(e.target.value)}
 placeholder={t("qc_flags:dialog.description_placeholder")}
 required={noteRequired}
 aria-required={noteRequired}
 className="min-h-[80px] w-full rounded-lg border border-stone-200 p-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
 />
 </div>

 {/* Actions */}
 <div className="flex gap-3">
 <button
 onClick={handleClose}
 disabled={submitting}
 className="flex-1 rounded-md border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
 >
 {t("qc_flags:dialog.cancel")}
 </button>
 <button
 onClick={handleSubmit}
 disabled={!isValid || submitting}
 className="flex-1 rounded-md bg-verdigris px-4 py-2 text-sm font-medium text-parchment hover:bg-verdigris-deep disabled:opacity-50"
 >
 {t("qc_flags:card.resolve_button")}
 </button>
 </div>
 </div>
 </div>
 </div>
  );
}

