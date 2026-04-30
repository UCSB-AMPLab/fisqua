/**
 * Descriptions Admin — Create
 *
 * The create form for a new archival description. Captures the
 * minimum ISAD(G) fields needed to seed a row -- repository, parent,
 * description level, reference code, local identifier, title -- plus
 * a handful of the most commonly-entered context fields. Enforces
 * level constraints (a file cannot sit above a series, etc.) on the
 * server action before inserting. Richer editing happens on the edit
 * page.
 *
 * @version v0.3.0
 */

import { Form, useActionData, useLoaderData, redirect, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.admin.descriptions.new";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql } = await import("drizzle-orm");
  const { descriptions, repositories } = await import("~/db/schema");
  const { getAllowedChildLevels } = await import(
    "~/lib/description-levels"
  );

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Fetch enabled repositories for dropdown
  const repoList = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(eq(repositories.enabled, true))
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
      .where(eq(descriptions.id, parentId))
      .get();

    if (parentRow) {
      parent = parentRow;

      // Auto-suggest reference code: find max refCode among siblings
      const maxRef = await db
        .select({
          maxRef: sql<string>`MAX(${descriptions.referenceCode})`,
        })
        .from(descriptions)
        .where(eq(descriptions.parentId, parentId))
        .get();

      if (maxRef?.maxRef) {
        // Parse last segment as number and increment
        const parts = maxRef.maxRef.split("-");
        const lastSegment = parts[parts.length - 1];
        const num = parseInt(lastSegment, 10);
        if (!isNaN(num)) {
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

  return { repositories: repoList, parent, suggestedRefCode, allowedLevels };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql } = await import("drizzle-orm");
  const { descriptions } = await import("~/db/schema");
  const { isValidChildLevel } = await import("~/lib/description-levels");
  const { z } = await import("zod/v4");
  const { DESCRIPTION_LEVELS } = await import("~/lib/validation/enums");

  const user = context.get(userContext);
  requireAdmin(user);

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

  // Validate with Zod (minimal create schema)
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

  // Validate parentId exists if provided (T-21-08)
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
      .where(eq(descriptions.id, parsed.data.parentId))
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

  // Check referenceCode uniqueness (T-21-06)
  const existing = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(eq(descriptions.referenceCode, parsed.data.referenceCode))
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
        .where(eq(descriptions.parentId, parentRow.id))
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptions)
        .where(sql`${descriptions.parentId} IS NULL`)
        .get();

  const position = siblingCount?.count ?? 0;
  const now = Date.now();

  try {
    await db.insert(descriptions).values({
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
        .where(eq(descriptions.id, parentRow.id));
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
  const { repositories, parent, suggestedRefCode, allowedLevels } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("descriptions_admin");

  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
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
              label={t("field_title")}
              required
              error={errors?.title?.[0]}
            />

            {/* Description Level */}
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
                aria-required="true"
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
                label={t("field_referenceCode")}
                required
                defaultValue={suggestedRefCode}
                error={
                  errors?.referenceCode?.[0] === "duplicate_ref"
                    ? t("error_duplicate_ref")
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
              label={t("field_localIdentifier")}
              required
              error={errors?.localIdentifier?.[0]}
            />

            {/* Repository */}
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
  label: string;
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
