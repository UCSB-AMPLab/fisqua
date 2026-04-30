/**
 * Description Form
 *
 * The ISAD(G) form component used by the admin description editor.
 * Renders every ISAD section as a collapsible panel so cataloguers
 * can focus on whichever block they are filling in at the moment,
 * with field-level validation messages surfaced inline. Lifting state
 * to the parent route keeps autosave and conflict detection in one
 * place; this component is a pure controlled form.
 *
 * @version v0.3.0
 */

import { useTranslation } from "react-i18next";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { DESCRIPTION_LEVELS, RESOURCE_TYPES } from "~/lib/validation/enums";
import { EntityLinker } from "./entity-linker";
import { PlaceLinker } from "./place-linker";
import type { DescriptionEntityLink } from "./entity-linker";
import type { DescriptionPlaceLink } from "./place-linker";

interface DescriptionData {
  id: string;
  referenceCode: string;
  localIdentifier: string;
  title: string;
  translatedTitle: string | null;
  uniformTitle: string | null;
  descriptionLevel: string;
  resourceType: string | null;
  genre: string | null;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  dateCertainty: string | null;
  extent: string | null;
  dimensions: string | null;
  medium: string | null;
  provenance: string | null;
  scopeContent: string | null;
  ocrText: string | null;
  arrangement: string | null;
  accessConditions: string | null;
  reproductionConditions: string | null;
  language: string | null;
  locationOfOriginals: string | null;
  locationOfCopies: string | null;
  relatedMaterials: string | null;
  findingAids: string | null;
  notes: string | null;
  internalNotes: string | null;
  imprint: string | null;
  editionStatement: string | null;
  seriesStatement: string | null;
  volumeNumber: string | null;
  issueNumber: string | null;
  pages: string | null;
  sectionTitle: string | null;
  iiifManifestUrl: string | null;
  hasDigital: boolean | null;
  repositoryId: string;
  childCount: number;
}

interface Repository {
  id: string;
  name: string;
}

interface DescriptionFormProps {
  description: DescriptionData;
  isEditing: boolean;
  repositories: Repository[];
  allowedLevels: string[];
  errors?: Record<string, string[]>;
  entityLinks?: DescriptionEntityLink[];
  placeLinks?: DescriptionPlaceLink[];
}

export function DescriptionForm({
  description,
  isEditing,
  repositories,
  allowedLevels,
  errors,
  entityLinks = [],
  placeLinks = [],
}: DescriptionFormProps) {
  const { t } = useTranslation("descriptions_admin");

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-6">
      {/* 1. Identity (ISAD 3.1) */}
      <CollapsibleSection title={t("section_identity")}>
        <div className="space-y-4">
          <ReadOnlyOrInput
            name="referenceCode"
            label={t("field_referenceCode")}
            value={description.referenceCode}
            isEditing={false}
            required
          />
          <ReadOnlyOrInput
            name="localIdentifier"
            label={t("field_localIdentifier")}
            value={description.localIdentifier}
            isEditing={isEditing}
            required
            error={errors?.localIdentifier?.[0]}
          />
          <ReadOnlyOrInput
            name="title"
            label={t("field_title")}
            value={description.title}
            isEditing={isEditing}
            required
            error={errors?.title?.[0]}
          />
          <ReadOnlyOrInput
            name="translatedTitle"
            label={t("field_translatedTitle")}
            value={description.translatedTitle}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="uniformTitle"
            label={t("field_uniformTitle")}
            value={description.uniformTitle}
            isEditing={isEditing}
          />

          {/* Description Level */}
          {isEditing ? (
            <div>
              <label
                htmlFor="descriptionLevel"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {t("field_descriptionLevel")}
                <span className="text-madder"> *</span>
              </label>
              <select
                id="descriptionLevel"
                name="descriptionLevel"
                defaultValue={description.descriptionLevel}
                aria-required="true"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              >
                {allowedLevels.map((level) => (
                  <option key={level} value={level}>
                    {t(`level_${level}`)}
                  </option>
                ))}
              </select>
              {errors?.descriptionLevel?.[0] && (
                <p className="mt-1 text-xs text-madder">
                  {t("error_invalid_level")}
                </p>
              )}
            </div>
          ) : (
            <ReadOnlyField
              label={t("field_descriptionLevel")}
              value={t(`level_${description.descriptionLevel}`)}
            />
          )}

          {/* Resource Type */}
          {isEditing ? (
            <div>
              <label
                htmlFor="resourceType"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {t("field_resourceType")}
              </label>
              <select
                id="resourceType"
                name="resourceType"
                defaultValue={description.resourceType ?? ""}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              >
                <option value="">{""}</option>
                {RESOURCE_TYPES.map((rt) => (
                  <option key={rt} value={rt}>
                    {rt}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <ReadOnlyField
              label={t("field_resourceType")}
              value={description.resourceType}
            />
          )}

          <ReadOnlyOrInput
            name="genre"
            label={t("field_genre")}
            value={description.genre === "[]" ? null : description.genre}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="dateExpression"
            label={t("field_dateExpression")}
            value={description.dateExpression}
            isEditing={isEditing}
          />
          <div className="grid grid-cols-2 gap-4">
            <ReadOnlyOrInput
              name="dateStart"
              label={t("field_dateStart")}
              value={description.dateStart}
              isEditing={isEditing}
            />
            <ReadOnlyOrInput
              name="dateEnd"
              label={t("field_dateEnd")}
              value={description.dateEnd}
              isEditing={isEditing}
            />
          </div>
          <ReadOnlyOrInput
            name="dateCertainty"
            label={t("field_dateCertainty")}
            value={description.dateCertainty}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="extent"
            label={t("field_extent")}
            value={description.extent}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="dimensions"
            label={t("field_dimensions")}
            value={description.dimensions}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="medium"
            label={t("field_medium")}
            value={description.medium}
            isEditing={isEditing}
          />

          {/* Repository */}
          {isEditing ? (
            <div>
              <label
                htmlFor="repositoryId"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {t("field_repositoryId")}
                <span className="text-madder"> *</span>
              </label>
              <select
                id="repositoryId"
                name="repositoryId"
                defaultValue={description.repositoryId}
                aria-required="true"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              >
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <ReadOnlyField
              label={t("field_repositoryId")}
              value={
                repositories.find((r) => r.id === description.repositoryId)
                  ?.name ?? description.repositoryId
              }
            />
          )}
        </div>
      </CollapsibleSection>

      {/* 2. Context (ISAD 3.2) */}
      <CollapsibleSection title={t("section_context")}>
        <div className="space-y-4">
          <ReadOnlyOrTextarea
            name="provenance"
            label={t("field_provenance")}
            value={description.provenance}
            isEditing={isEditing}
            rows={4}
          />
        </div>
      </CollapsibleSection>

      {/* 3. Content (ISAD 3.3) */}
      <CollapsibleSection title={t("section_content")}>
        <div className="space-y-4">
          <ReadOnlyOrTextarea
            name="scopeContent"
            label={t("field_scopeContent")}
            value={description.scopeContent}
            isEditing={isEditing}
            rows={6}
          />
          <ReadOnlyOrTextarea
            name="arrangement"
            label={t("field_arrangement")}
            value={description.arrangement}
            isEditing={isEditing}
            rows={4}
          />
          <ReadOnlyOrTextarea
            name="ocrText"
            label={t("field_ocrText")}
            value={description.ocrText}
            isEditing={isEditing}
            rows={4}
            className="font-mono"
          />
        </div>
      </CollapsibleSection>

      {/* 4. Access (ISAD 3.4) */}
      <CollapsibleSection title={t("section_access")}>
        <div className="space-y-4">
          <ReadOnlyOrTextarea
            name="accessConditions"
            label={t("field_accessConditions")}
            value={description.accessConditions}
            isEditing={isEditing}
            rows={3}
          />
          <ReadOnlyOrTextarea
            name="reproductionConditions"
            label={t("field_reproductionConditions")}
            value={description.reproductionConditions}
            isEditing={isEditing}
            rows={3}
          />
          <ReadOnlyOrInput
            name="language"
            label={t("field_language")}
            value={description.language}
            isEditing={isEditing}
          />
        </div>
      </CollapsibleSection>

      {/* 5. Allied Materials (ISAD 3.5) */}
      <CollapsibleSection title={t("section_allied")}>
        <div className="space-y-4">
          <ReadOnlyOrInput
            name="locationOfOriginals"
            label={t("field_locationOfOriginals")}
            value={description.locationOfOriginals}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="locationOfCopies"
            label={t("field_locationOfCopies")}
            value={description.locationOfCopies}
            isEditing={isEditing}
          />
          <ReadOnlyOrTextarea
            name="relatedMaterials"
            label={t("field_relatedMaterials")}
            value={description.relatedMaterials}
            isEditing={isEditing}
            rows={3}
          />
          <ReadOnlyOrInput
            name="findingAids"
            label={t("field_findingAids")}
            value={description.findingAids}
            isEditing={isEditing}
          />
        </div>
      </CollapsibleSection>

      {/* 6. Notes (ISAD 3.6) */}
      <CollapsibleSection title={t("section_notes")}>
        <div className="space-y-4">
          <ReadOnlyOrTextarea
            name="notes"
            label={t("field_notes")}
            value={description.notes}
            isEditing={isEditing}
            rows={4}
          />
          <ReadOnlyOrTextarea
            name="internalNotes"
            label={t("field_internalNotes")}
            value={description.internalNotes}
            isEditing={isEditing}
            rows={4}
            className="bg-stone-50"
          />
        </div>
      </CollapsibleSection>

      {/* 7. Bibliographic */}
      <CollapsibleSection title={t("section_bibliographic")}>
        <div className="space-y-4">
          <ReadOnlyOrInput
            name="imprint"
            label={t("field_imprint")}
            value={description.imprint}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="editionStatement"
            label={t("field_editionStatement")}
            value={description.editionStatement}
            isEditing={isEditing}
          />
          <ReadOnlyOrInput
            name="seriesStatement"
            label={t("field_seriesStatement")}
            value={description.seriesStatement}
            isEditing={isEditing}
          />
          <div className="grid grid-cols-3 gap-4">
            <ReadOnlyOrInput
              name="volumeNumber"
              label={t("field_volumeNumber")}
              value={description.volumeNumber}
              isEditing={isEditing}
            />
            <ReadOnlyOrInput
              name="issueNumber"
              label={t("field_issueNumber")}
              value={description.issueNumber}
              isEditing={isEditing}
            />
            <ReadOnlyOrInput
              name="pages"
              label={t("field_pages")}
              value={description.pages}
              isEditing={isEditing}
            />
          </div>
          <ReadOnlyOrInput
            name="sectionTitle"
            label={t("field_sectionTitle")}
            value={description.sectionTitle}
            isEditing={isEditing}
          />
        </div>
      </CollapsibleSection>

      {/* 8. Digital */}
      <CollapsibleSection title={t("section_digital")}>
        <div className="space-y-4">
          <ReadOnlyOrInput
            name="iiifManifestUrl"
            label={t("field_iiifManifestUrl")}
            value={description.iiifManifestUrl}
            isEditing={isEditing}
          />
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="hasDigital"
                name="hasDigital"
                defaultChecked={description.hasDigital ?? false}
                className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
              />
              <label htmlFor="hasDigital" className="text-sm font-medium text-indigo">
                {t("field_hasDigital")}
              </label>
            </div>
          ) : (
            <ReadOnlyField
              label={t("field_hasDigital")}
              value={description.hasDigital ? "Yes" : "No"}
            />
          )}
        </div>
      </CollapsibleSection>

      {/* 9. Entities */}
      <CollapsibleSection title={t("section_entities")}>
        <EntityLinker
          descriptionId={description.id}
          links={entityLinks}
          isEditing={isEditing}
        />
      </CollapsibleSection>

      {/* 10. Places */}
      <CollapsibleSection title={t("section_places")}>
        <PlaceLinker
          descriptionId={description.id}
          links={placeLinks}
          isEditing={isEditing}
        />
      </CollapsibleSection>

      {/* Save actions (edit mode only) */}
      {isEditing && (
        <div className="mt-6 space-y-3 border-t border-stone-200 pt-4">
          <input
            type="text"
            name="commitNote"
            placeholder={t("commit_note_placeholder")}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <div className="flex gap-3">
            <button
              type="submit"
              name="_action"
              value="update"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("save_changes")}
            </button>
            <button
              type="button"
              className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              data-action="discard"
            >
              {t("discard_changes")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs text-stone-500">{label}</span>
      <p className="text-sm text-stone-700">{value || "\u2014"}</p>
    </div>
  );
}

function ReadOnlyOrInput({
  name,
  label,
  value,
  isEditing,
  required,
  error,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  isEditing: boolean;
  required?: boolean;
  error?: string;
}) {
  if (!isEditing) {
    return <ReadOnlyField label={label} value={value} />;
  }

  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        {required && <span className="text-madder"> *</span>}
      </label>
      <input
        type="text"
        id={name}
        name={name}
        defaultValue={value ?? ""}
        aria-required={required ? "true" : undefined}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}

function ReadOnlyOrTextarea({
  name,
  label,
  value,
  isEditing,
  rows = 3,
  className = "",
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  isEditing: boolean;
  rows?: number;
  className?: string;
}) {
  if (!isEditing) {
    return <ReadOnlyField label={label} value={value} />;
  }

  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        defaultValue={value ?? ""}
        className={`w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo ${className}`}
      />
    </div>
  );
}
