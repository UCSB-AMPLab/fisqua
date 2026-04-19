/**
 * Repositories Admin — Create
 *
 * The create form for a new repository. Captures the minimum viable
 * record -- institutional code, display name, short name, city,
 * country, website -- and posts it to the server action. Richer fields
 * like rights statement, hero image, and subtitle live on the edit
 * page; the create form stays focused on "what you need to start
 * cataloguing for this institution".
 *
 * @version v0.3.0
 */

import { Form, useActionData, redirect, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.admin.repositories.new";

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { repositories } = await import("~/db/schema");
  const { createRepositorySchema } = await import(
    "~/lib/validation/repository"
  );

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();

  // Normalise empty strings to undefined for optional fields
  const code = (formData.get("code") as string)?.trim() || undefined;
  const name = (formData.get("name") as string)?.trim() || undefined;
  const shortName = (formData.get("shortName") as string)?.trim() || undefined;
  const countryCode =
    (formData.get("countryCode") as string)?.trim() || undefined;
  const country = (formData.get("country") as string)?.trim() || undefined;
  const city = (formData.get("city") as string)?.trim() || undefined;
  const address = (formData.get("address") as string)?.trim() || undefined;
  const website = (formData.get("website") as string)?.trim() || undefined;
  const notes = (formData.get("notes") as string)?.trim() || undefined;
  const rightsText =
    (formData.get("rightsText") as string)?.trim() || undefined;
  const enabled = formData.get("enabled") === "on";

  const parsed = createRepositorySchema.safeParse({
    code,
    name,
    shortName,
    countryCode,
    country,
    city,
    address,
    website,
    notes,
    enabled,
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
    await db.insert(repositories).values({
      id,
      ...parsed.data,
      shortName: parsed.data.shortName ?? null,
      country: parsed.data.country ?? null,
      city: parsed.data.city ?? null,
      address: parsed.data.address ?? null,
      website: parsed.data.website ?? null,
      notes: parsed.data.notes ?? null,
      rightsText: rightsText ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) {
      return { ok: false as const, error: "duplicate_code" };
    }
    return { ok: false as const, error: "generic" };
  }

  return redirect(`/admin/repositories/${id}`);
}

export default function NewRepositoryPage() {
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("repositories");

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
              to="/admin/repositories"
              className="text-[#78716C] hover:text-[#44403C]"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-[#A8A29E]" />
          </li>
          <li className="text-[#44403C]">{t("create_title")}</li>
        </ol>
      </nav>

      {/* Title */}
      <h1 className="font-serif text-2xl font-semibold text-[#44403C]">
        {t("create_title")}
      </h1>

      {/* Error banner */}
      {globalError && (
        <div className="mt-4 rounded-lg border border-[#8B2942] bg-[#F5E6EA] px-4 py-3 text-sm text-[#44403C]">
          {globalError === "duplicate_code"
            ? t("error_duplicate_code")
            : t("error_generic")}
        </div>
      )}

      {/* Form card */}
      <div className="mt-6 rounded-lg border border-[#E7E5E4] bg-white p-6">
        <Form method="post">
          <input type="hidden" name="_action" value="create" />

          {/* Identity area */}
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.05em] text-[#78716C]">
            {t("section_identity")}
          </h2>

          <div className="space-y-4">
            <FieldInput
              name="code"
              label={t("field.code")}
              required
              error={errors?.code?.[0]}
            />
            <FieldInput
              name="name"
              label={t("field.name")}
              required
              error={errors?.name?.[0]}
            />
            <FieldInput
              name="shortName"
              label={t("field.shortName")}
              error={errors?.shortName?.[0]}
            />
          </div>

          {/* Contact area */}
          <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-[0.05em] text-[#78716C]">
            {t("section_contact")}
          </h2>

          <div className="space-y-4">
            <FieldInput
              name="countryCode"
              label={t("field.countryCode")}
              required
              defaultValue="COL"
              error={errors?.countryCode?.[0]}
            />
            <FieldInput
              name="country"
              label={t("field.country")}
              error={errors?.country?.[0]}
            />
            <FieldInput
              name="city"
              label={t("field.city")}
              error={errors?.city?.[0]}
            />
            <FieldTextarea
              name="address"
              label={t("field.address")}
              error={errors?.address?.[0]}
            />
            <FieldInput
              name="website"
              label={t("field.website")}
              error={errors?.website?.[0]}
            />
          </div>

          {/* Administrative */}
          <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-[0.05em] text-[#78716C]">
            {t("section_admin")}
          </h2>

          <div className="space-y-4">
            <FieldTextarea
              name="notes"
              label={t("field.notes")}
              error={errors?.notes?.[0]}
            />
            <FieldTextarea
              name="rightsText"
              label={t("field.rightsText")}
              error={errors?.rightsText?.[0]}
            />
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="enabled"
                name="enabled"
                defaultChecked
                className="h-4 w-4 rounded border-[#E7E5E4] text-[#8B2942] focus:ring-[#8B2942]"
              />
              <label htmlFor="enabled" className="text-sm text-[#44403C]">
                {t("badge_enabled")}
              </label>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-6 flex gap-3">
            <button
              type="submit"
              className="rounded-lg bg-[#6B1F33] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8B2942]"
            >
              {t("create_submit")}
            </button>
            <Link
              to="/admin/repositories"
              className="rounded-lg border border-[#E7E5E4] px-4 py-2 text-sm font-semibold text-[#44403C] hover:bg-[#FAFAF9]"
            >
              {t("back")}
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
