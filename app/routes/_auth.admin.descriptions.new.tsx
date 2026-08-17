/**
 * Descriptions Admin — Create
 *
 * This page is the create form for a new archival description. It
 * captures the standard-neutral identity fields — repository, parent,
 * description level, reference code, local identifier, title — and
 * lets the cataloguer fill in the rest on the edit page, where the
 * full standard-aware renderer takes over. Level constraints (a file
 * cannot sit above a series, etc.) are enforced on the server action
 * before inserting; per-standard mandatoriness is enforced by
 * `descriptionValidatorFor` from the standard-aware validator factory
 * keyed by `tenant.descriptiveStandard`.
 *
 * ## The level decides the form
 *
 * A fixed identity set is not enough, because mandatoriness is a
 * function of the LEVEL, not of the page. ISAD(G) asks a fonds for
 * dates, extent, creator and scope; DACS adds language and access
 * conditions; RAD adds an administrative history — and every standard
 * asks a section or a volume for nothing beyond the identity four. A
 * form that renders only the identity fields can therefore create a
 * section and nothing else: the validator refuses every other level
 * for fields the form never offered, with no way for the cataloguer to
 * supply them. That was the shape of the bug an adopter hit against
 * their own migrated data, and the reason the level select drives the
 * field list here.
 *
 * The loader hands over `requiredByLevel` (level -> the columns that
 * level makes mandatory, minus the identity ones already on the form)
 * plus the render hints for those columns, both derived from the
 * tenant's own `StandardConfig`. Nothing about which fields exist is
 * hard-coded on this page: adding a column to a level's required list
 * in `app/lib/standards/` grows this form with it, which is the same
 * single-source-of-truth contract the asterisks on the edit page keep.
 *
 * The action re-derives the same column list server-side rather than
 * trusting the posted field names — the browser says what a field
 * CONTAINS, never which columns a write may touch.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. The loader filters repositories, descriptions,
 * and parent lookups by `tenant.id`; the action attributes the new
 * description row to `tenant.id` rather than a single-tenant
 * hard-code.
 *
 * @version v0.7.0
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { Form, useActionData, useLoaderData, redirect, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { tStd } from "~/lib/i18n/standard-aware";
import { FieldGuidance } from "~/components/descriptions/field-guidance";
import type { Route } from "./+types/_auth.admin.descriptions.new";

/**
 * The columns this form already renders as fixed identity inputs. A
 * level-required column on this list needs no extra field; everything
 * else the level demands is rendered from the standard config. Shared
 * by the loader (what to send) and the action (what to accept), so the
 * two cannot disagree about which half a column belongs to.
 */
export const IDENTITY_COLUMNS: ReadonlyArray<string> = [
  "title",
  "descriptionLevel",
  "referenceCode",
  "localIdentifier",
  "repositoryId",
];

/** What the component needs to render one config-driven field. */
export interface LevelField {
  column: string;
  /** `textarea` gets a textarea; every other primitive gets a text input. */
  primitive: string;
  rows?: number;
  /** `FieldConfig.guidance` — the element number, when the standard has one. */
  guidance?: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { descriptions, repositories } = await import("~/db/schema");
  const { getAllowedChildLevels } = await import(
    "~/lib/description-levels"
  );
  const { getStandardConfig } = await import("~/lib/standards/registry");
  type DescriptionLevel =
    import("~/lib/standards/types").DescriptionLevel;

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  // Schema-invariant guard — see action handler.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }
  const descriptiveStandard = tenant.descriptiveStandard;

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Fetch enabled repositories for dropdown
  const repoList = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(
      and(eq(repositories.tenantId, tenant.id), eq(repositories.enabled, true))
    )
    .all();

  // Check for parentId query param
  const url = new URL(request.url);
  const parentId = url.searchParams.get("parentId");

  let parent: {
    id: string;
    title: string;
    referenceCode: string;
    descriptionLevel: string;
    repositoryId: string;
    depth: number;
    rootDescriptionId: string | null;
    pathCache: string | null;
  } | null = null;
  let suggestedRefCode = "";
  let allowedLevels: string[];

  if (parentId) {
    const parentRow = await db
      .select({
        id: descriptions.id,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        descriptionLevel: descriptions.descriptionLevel,
        repositoryId: descriptions.repositoryId,
        depth: descriptions.depth,
        rootDescriptionId: descriptions.rootDescriptionId,
        pathCache: descriptions.pathCache,
      })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, parentId))
      )
      .get();

    if (parentRow) {
      parent = parentRow;

      // Auto-suggest reference code: find max refCode among siblings
      const maxRef = await db
        .select({
          maxRef: sql<string>`MAX(${descriptions.referenceCode})`,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.parentId, parentId)
          )
        )
        .get();

      if (maxRef?.maxRef) {
        // Parse last segment as number and increment. WR-04: gate
        // on a strict /^\d+$/ test before parseInt — `parseInt`
        // accepts strings like "007abc" (returns 7) and "0xff"
        // (returns 0 in base-10), so a sibling reference code
        // ending in a non-numeric suffix would silently roll the
        // suggestion forward as if the suffix were a counter.
        // Falling back to the `-001` branch is the safe choice:
        // the cataloguer sees a clean starting point rather than a
        // confusing rollover.
        const parts = maxRef.maxRef.split("-");
        const lastSegment = parts[parts.length - 1];
        if (/^\d+$/.test(lastSegment)) {
          const num = parseInt(lastSegment, 10);
          const next = String(num + 1).padStart(3, "0");
          parts[parts.length - 1] = next;
          suggestedRefCode = parts.join("-");
        } else {
          suggestedRefCode = `${parentRow.referenceCode}-001`;
        }
      } else {
        suggestedRefCode = `${parentRow.referenceCode}-001`;
      }

      allowedLevels = getAllowedChildLevels(parentRow.descriptionLevel);
    } else {
      allowedLevels = getAllowedChildLevels(null);
    }
  } else {
    allowedLevels = getAllowedChildLevels(null);
  }

  // What each selectable level makes mandatory beyond the identity
  // fields already on the form. Computed for every level the select
  // offers, so switching level is instant — the form never has to ask
  // the server what it now needs.
  const config = getStandardConfig(descriptiveStandard);
  const requiredByLevel: Record<string, string[]> = {};
  for (const level of allowedLevels) {
    requiredByLevel[level] = config
      .requiredFieldsForLevel(level as DescriptionLevel)
      .filter((column) => !IDENTITY_COLUMNS.includes(column));
  }

  // The union of those columns, ordered by the standard's own section
  // and field order rather than by level, so a cataloguer meets the
  // fields in the same sequence the edit page will show them in.
  //
  // ONE INPUT PER COLUMN. A config may declare the same column in two
  // sections deliberately — DACS puts `accessConditions` in both the
  // conditions area and the rights area, under different labels — and
  // the edit page renders both, since it is editing a row it already
  // has. A create form cannot: two inputs sharing a name post two
  // values, and the cataloguer has no way to tell which one counts. So
  // the field is claimed by the declaration that made the column
  // required, falling back to the first seen.
  const wanted = new Set(Object.values(requiredByLevel).flat());
  const claimed = new Map<string, LevelField & { authoritative: boolean }>();
  for (const section of config.sections) {
    for (const field of section.fields) {
      if (!wanted.has(field.column)) continue;
      const authoritative = field.requiredAt.length > 0;
      const existing = claimed.get(field.column);
      // A claim only changes hands when the incumbent was the
      // borrowed declaration and the challenger is the required one.
      // `Map.set` on an existing key keeps the original position, so
      // the section ordering survives the swap.
      if (existing && (existing.authoritative || !authoritative)) continue;
      claimed.set(field.column, {
        column: field.column,
        primitive: field.primitive,
        authoritative,
        ...(field.hints?.rows ? { rows: field.hints.rows } : {}),
        ...(field.guidance ? { guidance: field.guidance } : {}),
      });
    }
  }
  const levelFields: LevelField[] = [...claimed.values()].map(
    ({ authoritative: _authoritative, ...field }) => field,
  );

  // The identity fields are rendered by hand rather than from the
  // config, so their element citations have to travel separately for
  // the guidance affordance to reach them too.
  const identityGuidance: Record<string, string> = {};
  for (const section of config.sections) {
    for (const field of section.fields) {
      if (!IDENTITY_COLUMNS.includes(field.column)) continue;
      if (field.guidance) identityGuidance[field.column] = field.guidance;
    }
  }

  return {
    repositories: repoList,
    parent,
    suggestedRefCode,
    allowedLevels,
    descriptiveStandard,
    requiredByLevel,
    levelFields,
    identityGuidance,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { descriptions } = await import("~/db/schema");
  const { isValidChildLevel } = await import("~/lib/description-levels");
  const { z } = await import("zod/v4");
  const { DESCRIPTION_LEVELS } = await import("~/lib/validation/enums");
  const { descriptionValidatorFor } = await import(
    "~/lib/standards/validator-factory"
  );
  const { getStandardConfig } = await import("~/lib/standards/registry");
  type DescriptionLevel =
    import("~/lib/standards/types").DescriptionLevel;

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  // `tenants.descriptive_standard` is NOT NULL when
  // `kind = 'tenant'` per the schema CHECK in
  // drizzle/0034_tenants_table.sql. Operators never reach description
  // CRUD routes; the Drizzle inferred type is nullable so we narrow
  // with an explicit invariant throw.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();

  const title = (formData.get("title") as string)?.trim() || undefined;
  const descriptionLevel =
    (formData.get("descriptionLevel") as string)?.trim() || undefined;
  const referenceCode =
    (formData.get("referenceCode") as string)?.trim() || undefined;
  const localIdentifier =
    (formData.get("localIdentifier") as string)?.trim() || undefined;
  const repositoryId =
    (formData.get("repositoryId") as string)?.trim() || undefined;
  const parentId =
    (formData.get("parentId") as string)?.trim() || undefined;

  // Pre-validate the structural shape of the 6 create-form inputs
  // (UUID format, max-length, level enum). The standard-aware
  // validator factory below enforces per-standard required-field
  // mandatoriness on top; the two layers cover (a) hand-coded form
  // shape and (b) standard-driven completeness.
  const createSchema = z.object({
    title: z.string().min(1, "required"),
    descriptionLevel: z.enum(DESCRIPTION_LEVELS),
    referenceCode: z.string().min(1, "required").max(100),
    localIdentifier: z.string().min(1, "required").max(100),
    repositoryId: z.string().uuid("required"),
    parentId: z.string().uuid().optional(),
  });

  const parsed = createSchema.safeParse({
    title,
    descriptionLevel,
    referenceCode,
    localIdentifier,
    repositoryId,
    parentId: parentId || undefined,
  });

  if (!parsed.success) {
    return {
      ok: false as const,
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  // The columns the CHOSEN level makes mandatory, re-derived from the
  // tenant's standard rather than read off the posted field names: the
  // form is a claim about what a value is, never about which columns a
  // write may touch. Anything the browser posts under another name is
  // simply not read.
  const levelColumns = getStandardConfig(tenant.descriptiveStandard)
    .requiredFieldsForLevel(parsed.data.descriptionLevel as DescriptionLevel)
    .filter((column) => !IDENTITY_COLUMNS.includes(column));

  const levelValues: Record<string, string> = {};
  for (const column of levelColumns) {
    const value = (formData.get(column) as string)?.trim();
    // Left blank stays absent, not empty-string: the validator reads
    // "" as missing anyway, and an absent key keeps the column NULL
    // instead of landing an empty cell.
    if (value) levelValues[column] = value;
  }

  // Standard-aware validation: build the payload as a column-keyed
  // object and run it through the per-standard validator picked from
  // `tenant.descriptiveStandard`. This is the same factory the edit
  // action consumes; bulk import will be the third call site.
  const formObject: Record<string, unknown> = {
    title: parsed.data.title,
    descriptionLevel: parsed.data.descriptionLevel,
    referenceCode: parsed.data.referenceCode,
    localIdentifier: parsed.data.localIdentifier,
    repositoryId: parsed.data.repositoryId,
    ...levelValues,
  };
  const stdValidator = descriptionValidatorFor(
    tenant.descriptiveStandard,
    parsed.data.descriptionLevel as DescriptionLevel,
  );
  const stdParsed = stdValidator.safeParse(formObject);
  if (!stdParsed.success) {
    return {
      ok: false as const,
      errors: z.flattenError(stdParsed.error).fieldErrors as Record<
        string,
        string[] | undefined
      >,
    };
  }

  // Validate parentId exists if provided.
  let parentRow: {
    id: string;
    descriptionLevel: string;
    depth: number;
    rootDescriptionId: string | null;
    pathCache: string | null;
    childCount: number;
  } | null = null;

  if (parsed.data.parentId) {
    parentRow = await db
      .select({
        id: descriptions.id,
        descriptionLevel: descriptions.descriptionLevel,
        depth: descriptions.depth,
        rootDescriptionId: descriptions.rootDescriptionId,
        pathCache: descriptions.pathCache,
        childCount: descriptions.childCount,
      })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          eq(descriptions.id, parsed.data.parentId)
        )
      )
      .get() ?? null;

    if (!parentRow) {
      return {
        ok: false as const,
        errors: { parentId: ["Parent description not found"] },
      };
    }

    // Validate level constraint
    if (
      !isValidChildLevel(
        parentRow.descriptionLevel,
        parsed.data.descriptionLevel
      )
    ) {
      return {
        ok: false as const,
        errors: { descriptionLevel: ["invalid_level"] },
      };
    }
  }

  // Check referenceCode uniqueness. Reference codes are
  // tenant-scoped: two tenants may legitimately use the same code, so
  // the uniqueness check is scoped to the calling tenant.
  const existing = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.referenceCode, parsed.data.referenceCode)
      )
    )
    .get();

  if (existing) {
    return {
      ok: false as const,
      errors: { referenceCode: ["duplicate_ref"] },
    };
  }

  // Compute hierarchy fields
  const id = crypto.randomUUID();
  const depth = parentRow ? parentRow.depth + 1 : 0;
  const rootDescriptionId = parentRow
    ? parentRow.rootDescriptionId || parentRow.id
    : id;
  const pathCache = parentRow
    ? `${parentRow.pathCache || parentRow.id}/${id}`
    : id;

  // Count existing siblings for position
  const siblingCount = parentRow
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.parentId, parentRow.id)
          )
        )
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            sql`${descriptions.parentId} IS NULL`
          )
        )
        .get();

  const position = siblingCount?.count ?? 0;
  const now = Date.now();

  try {
    await db.insert(descriptions).values({
      tenantId: tenant.id,
      id,
      repositoryId: parsed.data.repositoryId,
      parentId: parsed.data.parentId ?? null,
      position,
      rootDescriptionId,
      depth,
      childCount: 0,
      pathCache,
      descriptionLevel: parsed.data.descriptionLevel,
      referenceCode: parsed.data.referenceCode,
      localIdentifier: parsed.data.localIdentifier,
      title: parsed.data.title,
      // Config-derived column names, already narrowed to this level's
      // required set above; the cast is the price of a data-driven
      // column list, and `FieldConfig.column` is contracted to name a
      // real `descriptions` column.
      ...(levelValues as Partial<typeof descriptions.$inferInsert>),
      isPublished: false, // new descriptions default to unpublished
      createdBy: user.id,
      updatedBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    // Increment parent's childCount if parent exists
    if (parentRow) {
      await db
        .update(descriptions)
        .set({ childCount: parentRow.childCount + 1 })
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, parentRow.id)
          )
        );
    }
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) {
      return {
        ok: false as const,
        errors: { referenceCode: ["duplicate_ref"] },
      };
    }
    return { ok: false as const, error: "generic" };
  }

  return redirect(`/admin/descriptions/${id}`);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewDescriptionPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    repositories,
    parent,
    suggestedRefCode,
    allowedLevels,
    descriptiveStandard,
    requiredByLevel,
    levelFields,
    identityGuidance,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("descriptions_admin");

  /**
   * A field's label with the standard's own words attached, when the
   * standard has something to say about that column. Fields with no
   * sourced guidance render a bare label — see `FieldGuidance`.
   */
  const labelFor = (column: string, element: string | undefined) => (
    <>
      {tStd(t, `fields.${column}`, descriptiveStandard)}
      {element && (
        <FieldGuidance
          column={column}
          standard={descriptiveStandard}
          element={element}
        />
      )}
    </>
  );

  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;

  // The level select drives the rest of the form. It starts empty (the
  // cataloguer must choose), so no extra fields show until there is a
  // level whose requirements they answer.
  const [level, setLevel] = useState("");
  const shown = level ? (requiredByLevel[level] ?? []) : [];
  const fieldsForLevel = levelFields.filter((f) => shown.includes(f.column));

  /**
   * Translate one field's error. The create form's own shape check
   * emits `required`; the standard-aware validator emits the
   * `field_required` token. Both mean the same thing to a cataloguer.
   */
  const fieldError = (column: string) => {
    // The two validators return differently-keyed error bags — the
    // create schema's is narrow, the standard-aware one is open — so
    // the lookup is by column name against the union.
    const bag = errors as Record<string, string[] | undefined> | undefined;
    const code = bag?.[column]?.[0];
    if (!code) return undefined;
    if (code === "required" || code === "field_required") {
      return t("common:field_required");
    }
    return code;
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label={t("common:aria.breadcrumb")} className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/descriptions"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("page_title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{t("breadcrumb_new")}</li>
        </ol>
      </nav>

      {/* Title */}
      <h1 className="font-serif text-2xl font-semibold text-stone-700">
        {t("new_description")}
      </h1>

      {/* Error banner */}
      {globalError && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {t("error_generic")}
        </div>
      )}

      {/* Form card */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <Form method="post">
          {parent && (
            <input type="hidden" name="parentId" value={parent.id} />
          )}

          {/* Parent helper text */}
          {parent && (
            <p className="mb-4 text-xs text-stone-500">
              {t("parent_helper", { parentTitle: parent.title })}
            </p>
          )}

          <div className="space-y-4">
            {/* Title */}
            <FieldInput
              name="title"
              label={labelFor("title", identityGuidance.title)}
              required
              error={
                errors?.title?.[0] === "required"
                  ? t("common:field_required")
                  : errors?.title?.[0]
              }
            />

            {/* Description Level */}
            <div>
              <label
                htmlFor="descriptionLevel"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {labelFor("descriptionLevel", identityGuidance.descriptionLevel)}
                <span className="text-madder"> *</span>
              </label>
              <select
                id="descriptionLevel"
                name="descriptionLevel"
                aria-required="true"
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              >
                <option value="">{""}</option>
                {(allowedLevels as string[]).map((level) => (
                  <option key={level} value={level}>
                    {t(`level_${level}`)}
                  </option>
                ))}
              </select>
              {errors?.descriptionLevel?.[0] && (
                <p className="mt-1 text-xs text-madder">
                  {errors?.descriptionLevel?.[0] === "invalid_level"
                    ? t("error_invalid_level")
                    : t("error_required")}
                </p>
              )}
            </div>

            {/* Reference Code */}
            <div>
              <FieldInput
                name="referenceCode"
                label={labelFor("referenceCode", identityGuidance.referenceCode)}
                required
                defaultValue={suggestedRefCode}
                error={
                  errors?.referenceCode?.[0] === "duplicate_ref"
                    ? t("error_duplicate_ref")
                    : errors?.referenceCode?.[0] === "required"
                      ? t("common:field_required")
                      : errors?.referenceCode?.[0]
                }
              />
              <p className="mt-1 text-xs text-stone-500">
                {t("ref_code_helper")}
              </p>
            </div>

            {/* Local Identifier */}
            <FieldInput
              name="localIdentifier"
              label={labelFor("localIdentifier", identityGuidance.localIdentifier)}
              required
              error={
                errors?.localIdentifier?.[0] === "required"
                  ? t("common:field_required")
                  : errors?.localIdentifier?.[0]
              }
            />

            {/* Repository */}
            <div>
              <label
                htmlFor="repositoryId"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {labelFor("repositoryId", identityGuidance.repositoryId)}
                <span className="text-madder"> *</span>
              </label>
              <select
                id="repositoryId"
                name="repositoryId"
                aria-required="true"
                defaultValue={parent?.repositoryId ?? ""}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              >
                <option value="">{""}</option>
                {repositories.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
              {errors?.repositoryId?.[0] && (
                <p className="mt-1 text-xs text-madder">
                  {t("error_required")}
                </p>
              )}
            </div>

            {/* What the chosen level requires on top of the identity
                fields. Empty for levels that ask for nothing more, so
                the form stays as short as the level allows. */}
            {fieldsForLevel.length > 0 && (
              <div className="space-y-4 border-t border-stone-200 pt-4">
                <p className="text-xs text-stone-500">
                  {t("level_required_helper", {
                    level: t(`level_${level}`),
                  })}
                </p>
                {fieldsForLevel.map((field) =>
                  field.primitive === "textarea" ? (
                    <FieldTextarea
                      key={field.column}
                      name={field.column}
                      label={labelFor(field.column, field.guidance)}
                      rows={field.rows}
                      error={fieldError(field.column)}
                    />
                  ) : (
                    <FieldInput
                      key={field.column}
                      name={field.column}
                      label={labelFor(field.column, field.guidance)}
                      required
                      error={fieldError(field.column)}
                    />
                  ),
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-6 flex gap-3">
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("create_description")}
            </button>
            <Link
              to="/admin/descriptions"
              className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("back_to_descriptions")}
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
  label: ReactNode;
  required?: boolean;
  defaultValue?: string;
  error?: string;
}) {
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
        defaultValue={defaultValue}
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

/**
 * The prose counterpart to `FieldInput`, for the level-required
 * columns the standard configs mark `textarea` (scope and content, an
 * administrative history). Always required — it is only rendered for
 * columns the chosen level mandates — so the asterisk is unconditional.
 */
function FieldTextarea({
  name,
  label,
  rows,
  error,
}: {
  name: string;
  label: ReactNode;
  rows?: number;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        <span className="text-madder"> *</span>
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows ?? 4}
        aria-required="true"
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
