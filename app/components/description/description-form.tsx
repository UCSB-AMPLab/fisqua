import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { DescriptionSection } from "./description-section";
import type { DescriptionEntry, SectionCompletion } from "../../lib/description-types";

type DescriptionFormProps = {
  entry: DescriptionEntry;
  onFieldChange: (fieldName: string, value: string) => void;
  sectionCompletion: SectionCompletion;
  isReadOnly?: boolean;
  isPaused?: boolean;
  onSubmitForReview?: () => void;
  validationErrors?: Record<string, string>;
};

const SECTION_IDS = [
  "identificacion",
  "descripcion_fisica",
  "contenido",
  "notas",
  "personas_lugares",
] as const;

type SectionId = (typeof SECTION_IDS)[number];

function FieldLabel({
  label,
  optional,
  required,
}: {
  label: string;
  optional?: boolean;
  required?: boolean;
}) {
  return (
    <label className="mb-1 block font-sans text-[0.875rem] font-medium text-indigo">
      {label}
      {optional && (
        <span className="ml-1.5 text-[0.75rem] font-normal text-stone-400">
          Opcional
        </span>
      )}
    </label>
  );
}

function FieldError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p className="mt-1 font-sans text-[0.75rem] text-indigo">{error}</p>
  );
}

export function DescriptionForm({
  entry,
  onFieldChange,
  sectionCompletion,
  isReadOnly = false,
  isPaused = false,
  onSubmitForReview,
  validationErrors = {},
}: DescriptionFormProps) {
  const { t } = useTranslation("description");
  const [expandedSections, setExpandedSections] = useState<Set<SectionId>>(
    () => new Set(["identificacion"])
  );

  const toggleSection = useCallback((sectionId: SectionId) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  const handleChange = useCallback(
    (fieldName: string) =>
      (
        e: React.ChangeEvent<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >
      ) => {
        if (!isReadOnly) {
          onFieldChange(fieldName, e.target.value);
        }
      },
    [onFieldChange, isReadOnly]
  );

  const inputClass =
    "w-full rounded border border-stone-200 bg-white px-3 py-2 font-serif text-[1rem] text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-100 disabled:cursor-not-allowed";

  const textareaClass =
    "w-full rounded border border-stone-200 bg-white px-3 py-2 font-sans text-[0.9375rem] leading-[1.6] text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-100 disabled:cursor-not-allowed";

  const selectClass =
    "w-full rounded border border-stone-200 bg-white px-3 py-2 font-sans text-[0.875rem] text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-100 disabled:cursor-not-allowed";

  // Show submit button only when status is in_progress or sent_back
  const showSubmit =
    !isReadOnly &&
    (entry.descriptionStatus === "in_progress" ||
      entry.descriptionStatus === "sent_back");

  return (
    <div className="space-y-3">
      {/* Pause warning banner */}
      {isPaused && (
        <div className="rounded-lg border border-saffron bg-saffron-tint p-3 font-sans text-[0.875rem] text-saffron-deep">
          {t("editor.descripcion_pausada")}
        </div>
      )}

      {/* 1. Identificacion */}
      <DescriptionSection
        title={t("sections.identificacion")}
        isExpanded={expandedSections.has("identificacion")}
        isComplete={sectionCompletion.identificacion}
        onToggle={() => toggleSection("identificacion")}
      >
        <div className="space-y-4" id="section-identificacion">
          {/* Titulo */}
          <div>
            <FieldLabel label={t("fields.titulo")} />
            <input
              type="text"
              className={`${inputClass} font-serif font-semibold`}
              value={entry.title ?? ""}
              onChange={handleChange("title")}
              disabled={isReadOnly}
            />
            <FieldError error={validationErrors.title} />
          </div>

          {/* Titulo traducido */}
          <div>
            <FieldLabel label={t("fields.titulo_traducido")} optional />
            <input
              type="text"
              className={inputClass}
              value={entry.translatedTitle ?? ""}
              onChange={handleChange("translatedTitle")}
              disabled={isReadOnly}
              placeholder={t("fields.titulo_traducido_hint")}
            />
          </div>

          {/* Tipo de recurso */}
          <div>
            <FieldLabel label={t("fields.tipo_recurso")} />
            <select
              className={selectClass}
              value={entry.resourceType ?? ""}
              onChange={handleChange("resourceType")}
              disabled={isReadOnly}
            >
              <option value="">--</option>
              <option value="texto">{t("resource_types.texto")}</option>
              <option value="imagen">{t("resource_types.imagen")}</option>
              <option value="cartografico">
                {t("resource_types.cartografico")}
              </option>
              <option value="mixto">{t("resource_types.mixto")}</option>
            </select>
            <FieldError error={validationErrors.resourceType} />
          </div>

          {/* Fecha */}
          <div>
            <FieldLabel label={t("fields.fecha")} />
            <input
              type="text"
              className={inputClass}
              value={entry.dateExpression ?? ""}
              onChange={handleChange("dateExpression")}
              disabled={isReadOnly}
              placeholder={t("fields.fecha_placeholder")}
            />
            <FieldError error={validationErrors.dateExpression} />
          </div>

          {/* Fecha inicial / Fecha final */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel label={t("fields.fecha_inicial")} optional />
              <input
                type="date"
                className={inputClass}
                value={entry.dateStart ?? ""}
                onChange={handleChange("dateStart")}
                disabled={isReadOnly}
              />
            </div>
            <div>
              <FieldLabel label={t("fields.fecha_final")} optional />
              <input
                type="date"
                className={inputClass}
                value={entry.dateEnd ?? ""}
                onChange={handleChange("dateEnd")}
                disabled={isReadOnly}
              />
            </div>
          </div>
        </div>
      </DescriptionSection>

      {/* 2. Descripcion fisica */}
      <DescriptionSection
        title={t("sections.descripcion_fisica")}
        isExpanded={expandedSections.has("descripcion_fisica")}
        isComplete={sectionCompletion.fisica}
        onToggle={() => toggleSection("descripcion_fisica")}
      >
        <div className="space-y-4" id="section-descripcion_fisica">
          <div>
            <FieldLabel label={t("fields.extension")} />
            <input
              type="text"
              className={inputClass}
              value={entry.extent ?? ""}
              onChange={handleChange("extent")}
              disabled={isReadOnly}
              placeholder={t("fields.extension_placeholder")}
            />
            <FieldError error={validationErrors.extent} />
          </div>
        </div>
      </DescriptionSection>

      {/* 3. Contenido */}
      <DescriptionSection
        title={t("sections.contenido")}
        isExpanded={expandedSections.has("contenido")}
        isComplete={sectionCompletion.contenido}
        onToggle={() => toggleSection("contenido")}
      >
        <div className="space-y-4" id="section-contenido">
          {/* Alcance y contenido */}
          <div>
            <FieldLabel label={t("fields.alcance_contenido")} />
            <textarea
              className={`${textareaClass} min-h-[100px]`}
              value={entry.scopeContent ?? ""}
              onChange={handleChange("scopeContent")}
              disabled={isReadOnly}
            />
            <FieldError error={validationErrors.scopeContent} />
          </div>

          {/* Idioma */}
          <div>
            <FieldLabel label={t("fields.idioma")} />
            <input
              type="text"
              className={inputClass}
              value={entry.language ?? ""}
              onChange={handleChange("language")}
              disabled={isReadOnly}
              placeholder={t("fields.idioma_placeholder")}
            />
            <FieldError error={validationErrors.language} />
          </div>

          {/* Signatura original */}
          <div>
            <FieldLabel label={t("fields.signatura_original")} optional />
            <textarea
              className={`${textareaClass} min-h-[60px]`}
              value={(entry as any).originalReference ?? ""}
              onChange={handleChange("originalReference")}
              disabled={isReadOnly}
            />
          </div>
        </div>
      </DescriptionSection>

      {/* 4. Notas */}
      <DescriptionSection
        title={t("sections.notas")}
        isExpanded={expandedSections.has("notas")}
        isComplete={sectionCompletion.notas}
        onToggle={() => toggleSection("notas")}
      >
        <div className="space-y-4" id="section-notas">
          {/* Notas generales */}
          <div>
            <FieldLabel label={t("fields.notas_generales")} optional />
            <textarea
              className={`${textareaClass} min-h-[80px]`}
              value={entry.descriptionNotes ?? ""}
              onChange={handleChange("descriptionNotes")}
              disabled={isReadOnly}
            />
          </div>

          {/* Notas del archivero */}
          <div>
            <FieldLabel label={t("fields.notas_archivero")} optional />
            <textarea
              className={`${textareaClass} min-h-[80px]`}
              value={entry.internalNotes ?? ""}
              onChange={handleChange("internalNotes")}
              disabled={isReadOnly}
            />
          </div>
        </div>
      </DescriptionSection>

      {/* 5. Personas y lugares (locked) */}
      <DescriptionSection
        title={t("sections.personas_lugares")}
        isExpanded={false}
        isComplete={false}
        isDisabled
        onToggle={() => {}}
      >
        <p className="font-sans text-[0.875rem] text-stone-500">
          {t("locked.personas_lugares")}
        </p>
      </DescriptionSection>

      {/* Submit for review button */}
      {showSubmit && (
        <div className="border-t border-stone-200 pt-4">
          <button
            type="button"
            onClick={onSubmitForReview}
            className="h-11 w-full rounded-md bg-indigo font-sans text-[0.9375rem] font-semibold text-parchment hover:bg-indigo-deep active:bg-indigo-deep"
          >
            {t("actions.enviar_para_revision")}
          </button>
        </div>
      )}
    </div>
  );
}
