/**
 * Places Admin — Create
 *
 * The create form for a new place authority record. Captures the
 * essential identity fields -- label, display name, place type,
 * country -- plus optional coordinates and a parent-place pointer for
 * hierarchical places (town within province within gobernación). The
 * server action mints an `nl-xxxxxx` place code and inserts the row.
 * Historical administrative divisions and external authority links
 * are editable on the edit page.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Form, useActionData, redirect, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { userContext } from "../context";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { NameVariantInput } from "~/components/forms/name-variant-input";
import { LodLinkField } from "~/components/forms/lod-link-field";
import { CoordinateInput } from "~/components/forms/coordinate-input";
import { PLACE_TYPES } from "~/lib/validation/enums";
import type { Route } from "./+types/_auth.admin.places.new";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const user = context.get(userContext);
  requireAdmin(user);
  return {};
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { places } = await import("~/db/schema");
  const { createPlaceSchema } = await import("~/lib/validation/place");
  const { generateUniqueCode } = await import("~/lib/codes.server");

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();

  // Parse form values
  const label = (formData.get("label") as string)?.trim() || undefined;
  const displayName =
    (formData.get("displayName") as string)?.trim() || undefined;
  const placeType =
    (formData.get("placeType") as string)?.trim() || undefined;
  const nameVariantsRaw = formData.get("nameVariants") as string;
  const parentId =
    (formData.get("parentId") as string)?.trim() || undefined;
  const historicalGobernacion =
    (formData.get("historicalGobernacion") as string)?.trim() || undefined;
  const historicalPartido =
    (formData.get("historicalPartido") as string)?.trim() || undefined;
  const historicalRegion =
    (formData.get("historicalRegion") as string)?.trim() || undefined;
  const countryCode =
    (formData.get("countryCode") as string)?.trim() || undefined;
  const adminLevel1 =
    (formData.get("adminLevel1") as string)?.trim() || undefined;
  const adminLevel2 =
    (formData.get("adminLevel2") as string)?.trim() || undefined;
  const coordinatePrecision =
    (formData.get("coordinatePrecision") as string)?.trim() || undefined;

  // Parse coordinates
  const latStr = (formData.get("latitude") as string)?.trim();
  const lngStr = (formData.get("longitude") as string)?.trim();
  const latitude = latStr ? parseFloat(latStr) : null;
  const longitude = lngStr ? parseFloat(lngStr) : null;

  // LOD identifiers
  const tgnId =
    (formData.get("tgnId") as string)?.trim() || undefined;
  const hgisId =
    (formData.get("hgisId") as string)?.trim() || undefined;
  const whgId =
    (formData.get("whgId") as string)?.trim() || undefined;
  const wikidataId =
    (formData.get("wikidataId") as string)?.trim() || undefined;

  // Auto-generate place code
  const placeCode = await generateUniqueCode(
    db,
    "nl",
    places,
    places.placeCode
  );

  const parsed = createPlaceSchema.safeParse({
    placeCode,
    label,
    displayName,
    placeType: placeType || null,
    nameVariants: nameVariantsRaw || "[]",
    parentId: parentId || null,
    latitude: latitude != null && !isNaN(latitude) ? latitude : null,
    longitude: longitude != null && !isNaN(longitude) ? longitude : null,
    coordinatePrecision,
    historicalGobernacion,
    historicalPartido,
    historicalRegion,
    countryCode,
    adminLevel1,
    adminLevel2,
    tgnId: tgnId || null,
    hgisId: hgisId || null,
    whgId: whgId || null,
    wikidataId: wikidataId || null,
  });

  if (!parsed.success) {
    return {
      ok: false as const,
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    await db.insert(places).values({
      id,
      ...parsed.data,
      nameVariants: parsed.data.nameVariants ?? "[]",
      parentId: parsed.data.parentId ?? null,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      tgnId: parsed.data.tgnId ?? null,
      hgisId: parsed.data.hgisId ?? null,
      whgId: parsed.data.whgId ?? null,
      wikidataId: parsed.data.wikidataId ?? null,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) {
      return { ok: false as const, error: "duplicate_code" };
    }
    return { ok: false as const, error: "generic" };
  }

  return redirect(`/admin/places/${id}`);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewPlacePage() {
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("places");

  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;

  // Controlled state for complex fields
  const [nameVariants, setNameVariants] = useState<string[]>([]);
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [precision, setPrecision] = useState("approximate");
  const [tgnId, setTgnId] = useState("");
  const [hgisId, setHgisId] = useState("");
  const [whgId, setWhgId] = useState("");
  const [wikidataId, setWikidataId] = useState("");

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/places"
              className="text-[#78716C] hover:text-[#44403C]"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-[#A8A29E]" />
          </li>
          <li className="text-[#44403C]">{t("breadcrumbNew")}</li>
        </ol>
      </nav>

      {/* Title */}
      <h1 className="font-serif text-2xl font-semibold text-[#44403C]">
        {t("createTitle")}
      </h1>

      {/* Error banner */}
      {globalError && (
        <div className="mt-4 rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 text-sm text-[#44403C]">
          {globalError === "duplicate_code"
            ? t("errorDuplicateCode")
            : t("errorGeneric")}
        </div>
      )}

      {/* Form card */}
      <div className="mt-6 rounded-lg border border-[#E7E5E4] bg-white p-6">
        <Form method="post">
          {/* Hidden fields for complex inputs */}
          <input
            type="hidden"
            name="nameVariants"
            value={JSON.stringify(nameVariants)}
          />
          <input
            type="hidden"
            name="latitude"
            value={latitude != null ? String(latitude) : ""}
          />
          <input
            type="hidden"
            name="longitude"
            value={longitude != null ? String(longitude) : ""}
          />
          <input
            type="hidden"
            name="coordinatePrecision"
            value={precision}
          />
          <input type="hidden" name="tgnId" value={tgnId} />
          <input type="hidden" name="hgisId" value={hgisId} />
          <input type="hidden" name="whgId" value={whgId} />
          <input type="hidden" name="wikidataId" value={wikidataId} />

          {/* Identity */}
          <CollapsibleSection title={t("sectionIdentity")}>
            <div className="space-y-4">
              <FieldInput
                name="label"
                label={t("field.label")}
                required
                error={errors?.label?.[0]}
              />
              <FieldInput
                name="displayName"
                label={t("field.displayName")}
                required
                error={errors?.displayName?.[0]}
              />
              <div>
                <label className="mb-1 block text-xs text-[#78716C]">
                  {t("field.placeCode")}
                </label>
                <input
                  type="text"
                  disabled
                  placeholder={t("autoGenerated")}
                  className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#A8A29E] disabled:cursor-not-allowed disabled:bg-[#FAFAF9]"
                />
                <p className="mt-1 text-xs text-[#78716C]">
                  {t("autoGenerated")}
                </p>
              </div>
              <div>
                <label
                  htmlFor="placeType"
                  className="mb-1 block text-xs text-[#78716C]"
                >
                  {t("field.placeType")}
                  <span className="text-[#DC2626]"> *</span>
                </label>
                <select
                  id="placeType"
                  name="placeType"
                  aria-required="true"
                  className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
                >
                  <option value="">--</option>
                  {PLACE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(type)}
                    </option>
                  ))}
                </select>
                {errors?.placeType?.[0] && (
                  <p className="mt-1 text-xs text-[#DC2626]">
                    {errors.placeType[0]}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs text-[#78716C]">
                  {t("field.nameVariants")}
                </label>
                <NameVariantInput
                  value={nameVariants}
                  onChange={setNameVariants}
                  addLabel={t("addVariant")}
                />
              </div>
              <FieldInput
                name="parentId"
                label={t("field.parentId")}
                error={errors?.parentId?.[0]}
              />
            </div>
          </CollapsibleSection>

          {/* Historical Context */}
          <CollapsibleSection title={t("sectionHistorical")}>
            <div className="space-y-4">
              <FieldInput
                name="historicalGobernacion"
                label={t("field.historicalGobernacion")}
                error={errors?.historicalGobernacion?.[0]}
              />
              <FieldInput
                name="historicalPartido"
                label={t("field.historicalPartido")}
                error={errors?.historicalPartido?.[0]}
              />
              <FieldInput
                name="historicalRegion"
                label={t("field.historicalRegion")}
                error={errors?.historicalRegion?.[0]}
              />
            </div>
          </CollapsibleSection>

          {/* Modern Geography & LOD */}
          <CollapsibleSection title={t("sectionGeography")}>
            <div className="space-y-4">
              <FieldInput
                name="countryCode"
                label={t("field.countryCode")}
                error={errors?.countryCode?.[0]}
              />
              <FieldInput
                name="adminLevel1"
                label={t("field.adminLevel1")}
                error={errors?.adminLevel1?.[0]}
              />
              <FieldInput
                name="adminLevel2"
                label={t("field.adminLevel2")}
                error={errors?.adminLevel2?.[0]}
              />
              <CoordinateInput
                latitude={latitude}
                longitude={longitude}
                precision={precision}
                onLatChange={setLatitude}
                onLngChange={setLongitude}
                onPrecisionChange={setPrecision}
              />
              <LodLinkField
                label={t("field.tgnId")}
                value={tgnId}
                onChange={setTgnId}
                service="tgn"
              />
              <LodLinkField
                label={t("field.hgisId")}
                value={hgisId}
                onChange={setHgisId}
                service="hgis"
              />
              <LodLinkField
                label={t("field.whgId")}
                value={whgId}
                onChange={setWhgId}
                service="whg"
              />
              <LodLinkField
                label={t("field.wikidataId")}
                value={wikidataId}
                onChange={setWikidataId}
                service="wikidata"
              />
            </div>
          </CollapsibleSection>

          {/* Actions */}
          <div className="mt-6 flex gap-3">
            <button
              type="submit"
              className="rounded-lg bg-[#6B1F33] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8B2942]"
            >
              {t("createSubmit")}
            </button>
            <Link
              to="/admin/places"
              className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
            >
              {t("backButton")}
            </Link>
          </div>
        </Form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form field components
// ---------------------------------------------------------------------------

function FieldInput({
  name,
  label,
  required,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  required?: boolean;
  defaultValue?: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-[#78716C]">
        {label}
        {required && <span className="text-[#DC2626]"> *</span>}
      </label>
      <input
        type="text"
        id={name}
        name={name}
        defaultValue={defaultValue}
        aria-required={required ? "true" : undefined}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-[#DC2626]">
          {error}
        </p>
      )}
    </div>
  );
}
