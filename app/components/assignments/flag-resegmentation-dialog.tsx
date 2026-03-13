/**
 * Re-segmentation flagging dialog.
 *
 * Lets a cataloguer report segmentation problems during description work.
 * Creating a flag pauses description on the entire volume until resolved.
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";

type ProblemType =
  | "incorrect_boundaries"
  | "merged_documents"
  | "split_document"
  | "missing_pages"
  | "other";

type NeighbourEntry = {
  id: string;
  position: number;
  title: string | null;
};

type FlagResegmentationDialogProps = {
  entryId: string;
  entryTitle: string;
  entryRefCode: string | null;
  volumeId: string;
  volumeTitle: string;
  volumeRefCode: string | null;
  neighbours: NeighbourEntry[];
  open: boolean;
  onClose: () => void;
};

const PROBLEM_TYPES: {
  value: ProblemType;
  labelKey: string;
  descKey: string | null;
}[] = [
  {
    value: "incorrect_boundaries",
    labelKey: "resegmentation.limites_incorrectos",
    descKey: "resegmentation.limites_incorrectos_desc",
  },
  {
    value: "merged_documents",
    labelKey: "resegmentation.documentos_fusionados",
    descKey: "resegmentation.documentos_fusionados_desc",
  },
  {
    value: "split_document",
    labelKey: "resegmentation.documento_dividido",
    descKey: "resegmentation.documento_dividido_desc",
  },
  {
    value: "missing_pages",
    labelKey: "resegmentation.paginas_faltantes",
    descKey: null,
  },
  {
    value: "other",
    labelKey: "resegmentation.otro",
    descKey: null,
  },
];

export function FlagResegmentationDialog({
  entryId,
  entryTitle,
  entryRefCode,
  volumeId,
  volumeTitle,
  volumeRefCode,
  neighbours,
  open,
  onClose,
}: FlagResegmentationDialogProps) {
  const { t } = useTranslation("description");
  const fetcher = useFetcher();

  const [problemType, setProblemType] = useState<ProblemType | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(
    new Set()
  );
  const [description, setDescription] = useState("");

  const isValid =
    problemType !== null &&
    description.trim().length > 0 &&
    selectedEntries.size > 0;

  function handleSubmit() {
    if (!isValid) return;

    fetcher.submit(
      {
        volumeId,
        entryId,
        problemType: problemType!,
        affectedEntryIds: JSON.stringify(Array.from(selectedEntries)),
        description: description.trim(),
      },
      { method: "post", action: "/api/resegmentation" }
    );

    // Reset and close
    setProblemType(null);
    setSelectedEntries(new Set());
    setDescription("");
    onClose();
  }

  function toggleEntry(id: string) {
    const next = new Set(selectedEntries);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedEntries(next);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start gap-3 p-6 pb-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1">
            <h2 className="font-['Cormorant_Garamond'] text-2xl font-semibold text-stone-800">
              {t("resegmentation.reportar_problema")}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Warning banner */}
        <div className="mx-6 rounded-lg bg-[#FEF3C7] p-3 text-sm text-[#78350F]">
          {t("resegmentation.warning")}
        </div>

        <div className="space-y-5 p-6 pt-4">
          {/* Context card */}
          <div className="rounded-lg border border-[#E7E5E4] bg-[#FAFAF9] p-4">
            <p className="text-sm font-medium text-stone-700">{entryTitle}</p>
            {entryRefCode && (
              <p className="font-mono text-xs text-stone-400">
                {entryRefCode}
              </p>
            )}
            <p className="mt-1 text-xs text-stone-500">
              {volumeTitle}
              {volumeRefCode && (
                <span className="ml-1 font-mono">{volumeRefCode}</span>
              )}
            </p>
          </div>

          {/* Problem type radio buttons */}
          <div>
            <h3 className="mb-2 text-sm font-medium text-stone-700">
              {t("resegmentation.tipo_problema")}
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
                    className="mt-0.5 accent-[#D97706]"
                  />
                  <div>
                    <span className="text-sm font-medium text-stone-700">
                      {t(pt.labelKey)}
                    </span>
                    {pt.descKey && (
                      <p className="text-xs text-stone-500">
                        {t(pt.descKey)}
                      </p>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Affected entries */}
          {neighbours.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-stone-700">
                {t("resegmentation.entradas_afectadas")}
              </h3>
              <div className="space-y-1">
                {neighbours.map((n) => (
                  <label
                    key={n.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-stone-50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedEntries.has(n.id)}
                      onChange={() => toggleEntry(n.id)}
                      className="rounded border-stone-300"
                    />
                    <span className="text-sm text-stone-700">
                      #{n.position} {n.title ?? `Item ${n.position}`}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Description textarea */}
          <div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("resegmentation.descripcion_placeholder")}
              className="min-h-[100px] w-full rounded-lg border border-stone-200 p-3 text-sm text-stone-700 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
              required
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            >
              {t("resegmentation.cancelar")}
            </button>
            <button
              onClick={handleSubmit}
              disabled={!isValid}
              className="flex-1 rounded-lg bg-[#D97706] px-4 py-2 text-sm font-medium text-white hover:bg-[#B45309] disabled:opacity-50"
            >
              {t("resegmentation.enviar_reporte")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
