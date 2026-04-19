/**
 * Entities Admin — Create
 *
 * The create form for a new entity authority record. Captures the
 * identity fields (display name, sort name, given name, surname,
 * honorific), the entity type (person, corporate body, family), and
 * the primary function, then posts to the server action which mints
 * an `ne-xxxxxx` entity code and inserts the row. Richer biographical
 * fields -- history, functions over time, linked descriptions -- live
 * on the edit page so the create form stays focused on "what you need
 * to start linking descriptions to this entity".
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
import { TypeaheadInput } from "~/components/admin/typeahead-input";
import type { Route } from "./+types/_auth.admin.entities.new";

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
  const { eq, and, sql } = await import("drizzle-orm");
  const { entities, vocabularyTerms } = await import("~/db/schema");
  const { createEntitySchema } = await import("~/lib/validation/entity");
  const { generateUniqueCode } = await import("~/lib/codes.server");

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = (formData.get("_action") as string) ?? "create";

  // Handle search-functions intent for TypeaheadInput
  if (intent === "search-functions") {
    const q = (formData.get("q") as string)?.trim();
    if (!q || q.length < 2) return { searchResults: [] };
    const { like, isNull } = await import("drizzle-orm");
    const results = await db
      .select({
        id: vocabularyTerms.id,
        canonical: vocabularyTerms.canonical,
        category: vocabularyTerms.category,
      })
      .from(vocabularyTerms)
      .where(
        and(
          like(vocabularyTerms.canonical, `%${q}%`),
          isNull(vocabularyTerms.mergedInto),
          eq(vocabularyTerms.status, "approved")
        )
      )
      .limit(8)
      .all();
    return { searchResults: results };
  }

  // Parse name variants from hidden field
  let nameVariants: string[] = [];
  try {
    nameVariants = JSON.parse(
      (formData.get("nameVariants") as string) || "[]"
    );
  } catch {
    nameVariants = [];
  }

  // Auto-generate entity code
  const entityCode = await generateUniqueCode(
    db,
    "ne",
    entities,
    entities.entityCode
  );

  // Normalise form data
  const displayName =
    (formData.get("displayName") as string)?.trim() || undefined;
  const sortName =
    (formData.get("sortName") as string)?.trim() || undefined;
  const surname =
    (formData.get("surname") as string)?.trim() || undefined;
  const givenName =
    (formData.get("givenName") as string)?.trim() || undefined;
  const honorific =
    (formData.get("honorific") as string)?.trim() || undefined;
  const entityType =
    (formData.get("entityType") as string)?.trim() || undefined;
  const datesOfExistence =
    (formData.get("datesOfExistence") as string)?.trim() || undefined;
  const dateStart =
    (formData.get("dateStart") as string)?.trim() || undefined;
  const dateEnd =
    (formData.get("dateEnd") as string)?.trim() || undefined;
  const history =
    (formData.get("history") as string)?.trim() || undefined;
  const primaryFunction =
    (formData.get("primaryFunction") as string)?.trim() || undefined;
  const legalStatus =
    (formData.get("legalStatus") as string)?.trim() || undefined;
  const functions =
    (formData.get("functions") as string)?.trim() || undefined;
  const sources =
    (formData.get("sources") as string)?.trim() || undefined;
  const wikidataId =
    (formData.get("wikidataId") as string)?.trim() || undefined;
  const viafId =
    (formData.get("viafId") as string)?.trim() || undefined;

  const parsed = createEntitySchema.safeParse({
    entityCode,
    displayName,
    sortName,
    surname,
    givenName,
    honorific,
    entityType,
    primaryFunction,
    nameVariants: JSON.stringify(nameVariants),
    datesOfExistence,
    dateStart: dateStart || null,
    dateEnd: dateEnd || null,
    history,
    legalStatus,
    functions,
    sources,
    wikidataId: wikidataId || null,
    viafId: viafId || null,
  });

  if (!parsed.success) {
    return {
      ok: false as const,
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  // Resolve primaryFunctionId from typeahead
  let resolvedFunctionId: string | null = null;
  const primaryFunctionIdRaw = (formData.get("primaryFunctionId") as string)?.trim();
  const primaryFunctionText = parsed.data.primaryFunction ?? null;

  if (primaryFunctionIdRaw) {
    resolvedFunctionId = primaryFunctionIdRaw;
  } else if (primaryFunctionText) {
    const { isNull } = await import("drizzle-orm");
    const existingTerm = await db
      .select({ id: vocabularyTerms.id })
      .from(vocabularyTerms)
      .where(
        and(
          sql`LOWER(${vocabularyTerms.canonical}) = LOWER(${primaryFunctionText})`,
          isNull(vocabularyTerms.mergedInto)
        )
      )
      .get();

    if (existingTerm) {
      resolvedFunctionId = existingTerm.id;
    } else {
      const newTermId = crypto.randomUUID();
      await db.insert(vocabularyTerms).values({
        id: newTermId,
        canonical: primaryFunctionText,
        category: null,
        status: "proposed",
        entityCount: 0,
        proposedBy: user.id,
        createdAt: now,
        updatedAt: now,
      });
      resolvedFunctionId = newTermId;
    }
  }

  try {
    await db.insert(entities).values({
      id,
      ...parsed.data,
      surname: parsed.data.surname ?? null,
      givenName: parsed.data.givenName ?? null,
      honorific: parsed.data.honorific ?? null,
      primaryFunction: parsed.data.primaryFunction ?? null,
      primaryFunctionId: resolvedFunctionId,
      datesOfExistence: parsed.data.datesOfExistence ?? null,
      dateStart: parsed.data.dateStart ?? null,
      dateEnd: parsed.data.dateEnd ?? null,
      history: parsed.data.history ?? null,
      legalStatus: parsed.data.legalStatus ?? null,
      functions: parsed.data.functions ?? null,
      sources: parsed.data.sources ?? null,
      wikidataId: parsed.data.wikidataId ?? null,
      viafId: parsed.data.viafId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    // Update entity count on the vocabulary term
    if (resolvedFunctionId) {
      const [{ count: entityCountForTerm }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(eq(entities.primaryFunctionId, resolvedFunctionId))
        .all();
      await db
        .update(vocabularyTerms)
        .set({ entityCount: entityCountForTerm, updatedAt: now })
        .where(eq(vocabularyTerms.id, resolvedFunctionId));
    }
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) {
      return { ok: false as const, error: "duplicate_code" };
    }
    return { ok: false as const, error: "generic" };
  }

  return redirect(`/admin/entities/${id}`);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewEntityPage() {
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("entities");

  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;

  // Name variants state
  const [nameVariants, setNameVariants] = useState<string[]>([]);

  // LOD link state
  const [wikidataId, setWikidataId] = useState("");
  const [viafId, setViafId] = useState("");

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/entities"
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
          <input type="hidden" name="_action" value="create" />
          <input
            type="hidden"
            name="nameVariants"
            value={JSON.stringify(nameVariants)}
          />
          <input type="hidden" name="wikidataId" value={wikidataId} />
          <input type="hidden" name="viafId" value={viafId} />

          {/* Identity area */}
          <CollapsibleSection title={t("sectionIdentity")}>
            <div className="space-y-4">
              <FieldInput
                name="displayName"
                label={t("field.displayName")}
                required
                error={errors?.displayName?.[0]}
              />
              <FieldInput
                name="sortName"
                label={t("field.sortName")}
                required
                error={errors?.sortName?.[0]}
              />
              <div className="grid grid-cols-3 gap-4">
                <FieldInput
                  name="surname"
                  label={t("field.surname")}
                  error={errors?.surname?.[0]}
                />
                <FieldInput
                  name="givenName"
                  label={t("field.givenName")}
                  error={errors?.givenName?.[0]}
                />
                <FieldInput
                  name="honorific"
                  label={t("field.honorific")}
                  error={errors?.honorific?.[0]}
                />
              </div>
              <div>
                <label
                  htmlFor="entityType"
                  className="mb-1 block text-xs text-[#78716C]"
                >
                  {t("field.entityType")}
                  <span className="text-[#DC2626]"> *</span>
                </label>
                <select
                  id="entityType"
                  name="entityType"
                  aria-required="true"
                  className="w-full rounded-lg border border-[#E7E5E4] px-3 py-2 text-sm text-[#44403C] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#8B2942]"
                >
                  <option value="person">{t("person")}</option>
                  <option value="family">{t("family")}</option>
                  <option value="corporate">{t("corporate")}</option>
                </select>
                {errors?.entityType?.[0] && (
                  <p className="mt-1 text-xs text-[#DC2626]">
                    {errors.entityType[0]}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs text-[#78716C]">
                  {t("field.entityCode")}
                </label>
                <p className="text-sm italic text-[#78716C]">
                  {t("autoGenerated")}
                </p>
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
            </div>
          </CollapsibleSection>

          {/* Description area */}
          <CollapsibleSection title={t("sectionDescription")}>
            <div className="space-y-4">
              <FieldInput
                name="datesOfExistence"
                label={t("field.datesOfExistence")}
                error={errors?.datesOfExistence?.[0]}
              />
              <div className="grid grid-cols-2 gap-4">
                <FieldInput
                  name="dateStart"
                  label={t("field.dateStart")}
                  error={errors?.dateStart?.[0]}
                />
                <FieldInput
                  name="dateEnd"
                  label={t("field.dateEnd")}
                  error={errors?.dateEnd?.[0]}
                />
              </div>
              <FieldTextarea
                name="history"
                label={t("field.history")}
                error={errors?.history?.[0]}
              />
              <div>
                <label className="mb-1 block text-xs text-[#78716C]">
                  {t("field.primaryFunction")}
                </label>
                <TypeaheadInput
                  name="primaryFunction"
                  defaultValue=""
                  searchEndpoint="/admin/entities/new"
                  placeholder={t("primary_function_placeholder")}
                />
                {errors?.primaryFunction?.[0] && (
                  <p className="mt-1 text-xs text-[#DC2626]">
                    {errors.primaryFunction[0]}
                  </p>
                )}
              </div>
              <FieldInput
                name="legalStatus"
                label={t("field.legalStatus")}
                error={errors?.legalStatus?.[0]}
              />
              <FieldTextarea
                name="functions"
                label={t("field.functions")}
                error={errors?.functions?.[0]}
              />
            </div>
          </CollapsibleSection>

          {/* Control area */}
          <CollapsibleSection title={t("sectionControl")}>
            <div className="space-y-4">
              <FieldTextarea
                name="sources"
                label={t("field.sources")}
                error={errors?.sources?.[0]}
              />
              <LodLinkField
                label={t("field.wikidataId")}
                value={wikidataId}
                onChange={setWikidataId}
                service="wikidata"
                error={errors?.wikidataId?.[0]}
              />
              <LodLinkField
                label={t("field.viafId")}
                value={viafId}
                onChange={setViafId}
                service="viaf"
                error={errors?.viafId?.[0]}
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
              to="/admin/entities"
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

function FieldTextarea({
  name,
  label,
  error,
}: {
  name: string;
  label: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-[#78716C]">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={3}
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
