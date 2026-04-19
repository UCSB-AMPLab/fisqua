/**
 * Flag QC Dialog
 *
 * Modal that lets a cataloguer or reviewer raise a QC flag against a
 * page. Uses the six-item QC taxonomy shared with the volume-manage
 * page so problem types stay consistent across the app, and submits
 * through a React Router fetcher so the viewer keeps state while the
 * request lands.
 *
 * @version v0.3.0
 */
import { useState, useEffect } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Flag, X } from "lucide-react";

type QcProblemType =
  | "damaged"
  | "repeated"
  | "out_of_order"
  | "missing"
  | "blank"
  | "other";

const PROBLEM_TYPES: {
  value: QcProblemType;
  labelKey: string;
  descKey: string;
}[] = [
  {
 value: "damaged",
 labelKey: "qc_flags:dialog.problem_type.damaged",
 descKey: "qc_flags:dialog.problem_type.damaged_desc",
  },
  {
 value: "repeated",
 labelKey: "qc_flags:dialog.problem_type.repeated",
 descKey: "qc_flags:dialog.problem_type.repeated_desc",
  },
  {
 value: "out_of_order",
 labelKey: "qc_flags:dialog.problem_type.out_of_order",
 descKey: "qc_flags:dialog.problem_type.out_of_order_desc",
  },
  {
 value: "missing",
 labelKey: "qc_flags:dialog.problem_type.missing",
 descKey: "qc_flags:dialog.problem_type.missing_desc",
  },
  {
 value: "blank",
 labelKey: "qc_flags:dialog.problem_type.blank",
 descKey: "qc_flags:dialog.problem_type.blank_desc",
  },
  {
 value: "other",
 labelKey: "qc_flags:dialog.problem_type.other",
 descKey: "qc_flags:dialog.problem_type.other_desc",
  },
];

export type FlagQcDialogProps = {
  open: boolean;
  onClose: () => void;
  volumeId: string;
  pageId: string;
  pagePosition: number;
  /**
 * (): when the dialog is opened from a
 * callsite that pre-selects a different page than `pageId`, the
 * caller may pass `initialPageId` so the dialog targets that page
 * instead. Optional; omitted callers get earlier.
 */
  initialPageId?: string;
  onCreated?: (flagId: string) => void;
  onError?: (message: string) => void;
};

type CreateOk = { ok: true; flagId: string };
type CreateErr = { error: string };
type CreateResponse = CreateOk | CreateErr;

function isOk(data: unknown): data is CreateOk {
  return (
 typeof data === "object" &&
 data !== null &&
 "ok" in data &&
 (data as { ok: unknown }).ok === true &&
 "flagId" in data
  );
}

function isErr(data: unknown): data is CreateErr {
  return (
 typeof data === "object" &&
 data !== null &&
 "error" in data &&
 typeof (data as { error: unknown }).error === "string"
  );
}

/**
 * Pure helper: build the submit payload for the flag POST. Returns
 * the flat object the fetcher will ship to /api/qc-flags. Cleanup
 * 2026-04-18: the `regionCommentId` / `region` arms were dropped
 * along with the "Vincular a región" affordance, so the payload is
 * back to the pre-Task-2b shape.
 */
export function buildFlagSubmitPayload(args: {
  volumeId: string;
  pageId: string;
  problemType: QcProblemType;
  description: string;
}): Record<string, unknown> {
  return {
 volumeId: args.volumeId,
 pageId: args.pageId,
 problemType: args.problemType,
 description: args.description.trim(),
  };
}

export function FlagQcDialog({
  open,
  onClose,
  volumeId,
  pageId,
  pagePosition,
  initialPageId,
  onCreated,
  onError,
}: FlagQcDialogProps) {
  const { t } = useTranslation(["qc_flags"]);
  const fetcher = useFetcher<CreateResponse>();

  const [problemType, setProblemType] = useState<QcProblemType | null>(null);
  const [description, setDescription] = useState("");

  // The active page id: prefer `initialPageId` (when the caller pre-
  // selects a different page than `pageId`) but fall back to the
  // authoritative `pageId` prop.
  const activePageId = initialPageId ?? pageId;

  const isValid = problemType !== null && description.trim().length > 0;
  const submitting = fetcher.state !== "idle";

  // Fire onCreated / onError exactly once when a fetcher response resolves.
  useEffect(() => {
 if (fetcher.state !== "idle" || !fetcher.data) return;
 if (isOk(fetcher.data)) {
 onCreated?.(fetcher.data.flagId);
 setProblemType(null);
 setDescription("");
 onClose();
 } else if (isErr(fetcher.data)) {
 onError?.(fetcher.data.error);
 }
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  function handleSubmit() {
 if (!isValid || submitting) return;
 const payload = buildFlagSubmitPayload({
 volumeId,
 pageId: activePageId,
 problemType: problemType!,
 description,
 });
 fetcher.submit(payload as Record<string, string>, {
 method: "POST",
 action: "/api/qc-flags",
 encType: "application/json",
 });
  }

  function handleClose() {
 if (submitting) return;
 setProblemType(null);
 setDescription("");
 onClose();
  }

  if (!open) return null;

  return (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
 <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-xl bg-white shadow-xl">
 {/* Header */}
 <div className="flex items-start gap-3 p-6 pb-4">
 <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100">
 <Flag className="h-5 w-5 text-rose-600" />
 </div>
 <div className="flex-1">
 <h2 className="font-['Cormorant_Garamond'] text-2xl font-semibold text-stone-800">
 {t("qc_flags:dialog.title")}
 </h2>
 <p className="text-sm text-stone-500">
 {t("qc_flags:dialog.subtitle")}
 </p>
 <p className="mt-1 text-xs font-medium text-stone-600">
 {t("qc_flags:dialog.page_label", { position: pagePosition })}
 </p>
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
 {/* Problem type radio group */}
 <div>
 <h3 className="mb-2 text-sm font-medium text-stone-700">
 {t("qc_flags:dialog.problem_type_label")}
 </h3>
 <div className="space-y-2">
 {PROBLEM_TYPES.map((pt) => (
 <label
 key={pt.value}
 className="flex cursor-pointer items-start gap-3 rounded-lg border border-stone-200 p-3 hover:bg-stone-50"
 >
 <input
 type="radio"
 name="problemType"
 value={pt.value}
 checked={problemType === pt.value}
 onChange={() => setProblemType(pt.value)}
 className="mt-0.5 accent-[#B91C1C]"
 />
 <div>
 <span className="text-sm font-medium text-stone-700">
 {t(pt.labelKey)}
 </span>
 <p className="text-xs text-zinc-500">{t(pt.descKey)}</p>
 </div>
 </label>
 ))}
 </div>
 </div>

 {/* Description textarea */}
 <div>
 <label
 htmlFor="qc-flag-description"
 className="mb-1 block text-sm font-medium text-stone-700"
 >
 {t("qc_flags:dialog.description_label")}
 </label>
 <textarea
 id="qc-flag-description"
 value={description}
 onChange={(e) => setDescription(e.target.value)}
 placeholder={t("qc_flags:dialog.description_placeholder")}
 className="min-h-[100px] w-full rounded-lg border border-stone-200 p-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
 required
 />
 </div>

 {/* Actions */}
 <div className="flex gap-3">
 <button
 onClick={handleClose}
 disabled={submitting}
 className="flex-1 rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
 >
 {t("qc_flags:dialog.cancel")}
 </button>
 <button
 onClick={handleSubmit}
 disabled={!isValid || submitting}
 className="flex-1 rounded-lg bg-[#B91C1C] px-4 py-2 text-sm font-medium text-white hover:bg-[#991B1B] disabled:opacity-50"
 >
 {t("qc_flags:dialog.submit")}
 </button>
 </div>
 </div>
 </div>
 </div>
  );
}

