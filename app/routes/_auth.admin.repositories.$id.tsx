/**
 * Repositories Admin — Edit
 *
 * This page is the edit form for a single repository. Every
 * ISAD-adjacent field is editable here, including the display metadata
 * that the public
 * frontend surfaces -- display title, Spanish and English subtitle, hero
 * image -- plus the
 * institution's rights statement and the manifest settings: the rights
 * URI and the English and Spanish attribution a pipeline manifest
 * carries for this repository's volumes.
 *
 * The form also holds the repository's simplified ISDIAH record, grouped
 * by ISDIAH area: other names and the type of institution (identity);
 * region, postal code, telephone and email beside the address (contact);
 * holdings and history (description); opening times, access conditions
 * and accessibility (access); reproduction services (services); and the
 * language of the description (control). The catalogue licence URI and
 * the home-page order sit with the image licence in the administrative
 * area, and the credit statement, a Spanish and English pair of plain
 * text that the attribution line uses as written, sits with the
 * attribution fields. Each prose field is a Spanish and English pair of
 * Markdown textareas. Other names are written one per line and stored as
 * a JSON array of the non-blank lines; the home order must be an integer.
 *
 * Autosaves to `drafts` via useFetcher
 * on a debounce so a curator's work survives a page reload, and
 * commits a final row to the `changelog` table on explicit save so
 * editors can audit who changed what and when. A draft conflict banner
 * appears if another user has an open draft on the same record.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `repositories`,
 * `descriptions`, and `users` is filtered by `tenant.id`.
 *
 * A save that changes a field the repository's descriptions publish
 * (`REPOSITORY_FIELDS_DESCRIPTIONS_PUBLISH`) moves every one of those
 * descriptions' versions in the same batch, so the publish sees their
 * files change; an edit form open on one of them then fails its version
 * check.
 *
 * The edit form's country/code fields are the shared identity fields
 * (`repository-country-fields`): country is an ISO select that fills the
 * alpha-3 code, the repository code gets a derived suggestion behind a
 * "use suggestion" affordance (an existing code is never silently
 * rewritten), and a stored free-text country matching no ISO entry is
 * kept verbatim behind a fallback option.
 *
 * The update writes only the fields the request carries, and of those
 * only the ones that change the stored row; the changelog records the
 * same set. The enabled checkbox travels with a hidden input of the
 * same name, so an unchecked box disables the repository and a request
 * without the name leaves the flag as stored. After an edit conflict,
 * the shared conflict dialog resubmits the edit form's fields with
 * `_force=true`; a forced update that carries none of the editable
 * fields is refused, and a save deletes the autosaved draft only when
 * it carried fields.
 *
 * A save's UPDATE runs only while the record holds the version the
 * save read, so a save that another lands between the version check and
 * the write changes nothing, logs nothing and gets the conflict
 * response. A successful save returns the new version, and the form
 * submits the version its field values were loaded from
 * (`useFormVersion`), which a loader revalidation does not move.
 *
 * @version v0.9.0
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Form,
  useLoaderData,
  useActionData,
  useFetcher,
  redirect,
  Link,
} from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import { ConflictDialog } from "~/components/admin/conflict-dialog";
import { useFormVersion, useRecordEditMode } from "~/lib/use-form-version";
import {
  useRepositoryIdentity,
  RepoNameInput,
  RepoCodeInput,
  RepoCountrySelect,
  RepoCountryCodeInput,
} from "~/components/admin/repository-country-fields";
import { DescriptionTree } from "~/components/descriptions/description-tree";
import type { Route } from "./+types/_auth.admin.repositories.$id";
import { pageMeta, heading } from "../lib/page-title";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function meta(args: Route.MetaArgs) {
  const data = args.data;
  return pageMeta(
    args,
    data?.repository?.name,
    heading("repositories:title"),
  );
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, asc, sql } = await import("drizzle-orm");
  const { repositories, descriptions } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAreaWork(user, "records");
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const repository = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)))
    .get();

  if (!repository) {
    throw new Response("Not found", { status: 404 });
  }

  // Count linked descriptions
  const [{ count: descriptionCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.repositoryId, id)
      )
    )
    .all();

  // Top-level descriptions for the tree (SSR initial data)
  const topLevelDescriptions = descriptionCount > 0
    ? await db
        .select({
          id: descriptions.id,
          title: descriptions.title,
          referenceCode: descriptions.referenceCode,
          descriptionLevel: descriptions.descriptionLevel,
          childCount: descriptions.childCount,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.repositoryId, id),
            eq(descriptions.depth, 0)
          )
        )
        .orderBy(asc(descriptions.position))
        .all()
    : [];

  // Check for another user's draft on this record
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, tenant.id, id, "repository", user.id);
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .where(
        and(eq(users.tenantId, tenant.id), eq(users.id, conflictRaw.userId))
      )
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  // The tenant's repository count gates delete: the LAST repository is
  // never deletable (records and imports file under it), for every tenant.
  const [{ count: repositoryCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.tenantId, tenant.id))
    .all();

  return { repository, descriptionCount, topLevelDescriptions, conflictDraft, repositoryCount };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * The repository columns its descriptions publish: `repository_code`
 * and `country` in the descriptions files, and the name, city and the
 * attribution line (composed from the place, credit statements, image
 * licence and the stored overrides) in the EAD and Dublin Core files.
 */
const REPOSITORY_FIELDS_DESCRIPTIONS_PUBLISH = [
  "code",
  "country",
  "countryCode",
  "name",
  "city",
  "region",
  "manifestRights",
  "creditStatementEs",
  "creditStatementEn",
  "attributionEs",
  "attributionEn",
] as const;

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireArea, requireAreaWork } = await import("~/lib/user-access.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { repositories, descriptions } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAreaWork(user, "records");
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, tenant.id, id, "repository", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      // A field is read only when the request carries it: a field the
      // request does not carry keeps its stored value, and a carried,
      // blank field clears its column. code, name and countryCode are
      // required on the form, so a blank one leaves the stored value.
      const { submittedFields, fieldsToWrite, updateSchemaFrom } = await import(
        "~/lib/validation/update-schema"
      );
      const { has, trimmed } = submittedFields(formData);
      const { readManifestFields, REPOSITORY_MANIFEST_FIELDS } = await import(
        "~/lib/validation/manifest-fields"
      );

      const REQUIRED_TEXT = ["code", "name", "countryCode"] as const;
      const OPTIONAL_TEXT = [
        "shortName",
        "country",
        "city",
        "address",
        "website",
        "notes",
        "rightsText",
        "displayTitle",
        "subtitle",
        "heroImageUrl",
        "subtitleEn",
        "institutionType",
        "region",
        "postalCode",
        "telephone",
        "email",
        "holdingsEs",
        "holdingsEn",
        "historyEs",
        "historyEn",
        "openingTimesEs",
        "openingTimesEn",
        "accessConditionsEs",
        "accessConditionsEn",
        "accessibilityEs",
        "accessibilityEn",
        "reproductionServicesEs",
        "reproductionServicesEn",
        "descriptionLanguage",
        "catalogueLicenceUri",
        "creditStatementEs",
        "creditStatementEn",
      ] as const;

      // Whether the request carries any field the edit form submits. An
      // overwrite after a conflict resubmits the form's fields; a forced
      // update without any would write nothing and report success while
      // the user's edits stay unsaved, so it is refused.
      const carriesFields = [
        ...REQUIRED_TEXT,
        ...OPTIONAL_TEXT,
        ...REPOSITORY_MANIFEST_FIELDS,
        "otherNames",
        "homeOrder",
        "enabled",
      ].some((name) => has(name));
      if (formData.get("_force") === "true" && !carriesFields) {
        return { ok: false as const, error: "generic" };
      }

      const input: Record<string, unknown> = { id };
      for (const name of REQUIRED_TEXT) {
        if (has(name)) input[name] = trimmed(name) || undefined;
      }
      for (const name of OPTIONAL_TEXT) {
        if (has(name)) input[name] = trimmed(name) || null;
      }
      // The enabled checkbox travels after a hidden input of the same
      // name, so a request that carries the name came from the form and
      // "on" among its values means checked. Without the name the flag
      // stays as stored.
      if (has("enabled")) input.enabled = formData.getAll("enabled").includes("on");
      // Other names travel one per line; the blank lines are dropped, and
      // no names at all clears the column. The list is validated as one
      // and stored as a JSON array.
      if (has("otherNames")) {
        const names = (formData.get("otherNames") as string)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== "");
        input.otherNames = names.length > 0 ? names : null;
      }
      // The home order is an integer; any other text reaches the schema
      // as a non-integer and is refused under the field's name.
      if (has("homeOrder")) {
        const text = trimmed("homeOrder");
        input.homeOrder = text === "" ? null : /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN;
      }

      // Validate heroImageUrl — only http/https protocols
      const heroImageUrl = input.heroImageUrl as string | null | undefined;
      if (heroImageUrl) {
        try {
          const parsed = new URL(heroImageUrl);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return {
              ok: false as const,
              errors: { heroImageUrl: ["URL must use http or https protocol"] },
            };
          }
        } catch {
          return {
            ok: false as const,
            errors: { heroImageUrl: ["Invalid URL"] },
          };
        }
      }

      // Manifest settings, those the request carries: the rights URI
      // must be http or https; an empty field clears its column.
      const manifestFields = readManifestFields(
        formData,
        REPOSITORY_MANIFEST_FIELDS.filter((name) => has(name)),
      );
      if (!manifestFields.ok) {
        return {
          ok: false as const,
          errors: manifestFields.errors,
        };
      }

      // The schema without its defaults (countryCode "COL", enabled
      // true), so an absent field is not handed back as a default. A
      // cleared field is validated as absent and carried back as null.
      const { repositorySchema } = await import("~/lib/validation/repository");
      const schemaInput = Object.fromEntries(
        Object.entries(input).filter(
          ([key, value]) =>
            value !== null &&
            key !== "displayTitle" &&
            key !== "subtitle" &&
            key !== "heroImageUrl",
        ),
      );
      const parsed = updateSchemaFrom(repositorySchema).safeParse(schemaInput);

      if (!parsed.success) {
        return {
          ok: false as const,
          errors: parsed.error.flatten().fieldErrors,
        };
      }

      // Fetch original for changelog diff
      const original = await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)))
        .get();
      if (!original) throw new Response("Not found", { status: 404 });
      const stored = original as unknown as Record<string, unknown>;

      // Optimistic lock check
      const formUpdatedAt = formData.get("_updatedAt") as string;
      const forceOverwrite = formData.get("_force") === "true";
      if (
        !forceOverwrite &&
        formUpdatedAt &&
        String(original.updatedAt) !== formUpdatedAt
      ) {
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedAt: original.updatedAt,
        };
      }

      const { id: _id, ...parsedUpdates } = parsed.data;
      const updates: Record<string, unknown> = {
        ...Object.fromEntries(
          Object.entries(input).filter(([key, value]) => key !== "id" && value !== undefined),
        ),
        ...parsedUpdates,
        ...manifestFields.values,
      };
      if (Array.isArray(updates.otherNames)) {
        updates.otherNames = JSON.stringify(updates.otherNames);
      }

      // Of those, only the ones that change the stored row are written
      // and logged.
      const changed: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(fieldsToWrite(updates, stored))) {
        if (JSON.stringify(stored[name]) === JSON.stringify(value)) continue;
        changed[name] = value;
      }

      // The write runs only while the repository holds the version read
      // above (the one the form's version was checked against, or that a
      // forced overwrite applies to): a save that another lands before
      // changes nothing, and its changes count says so.
      // A change to a field the repository's descriptions publish (their
      // repository code and country, and the name, place, credit and
      // attribution their EAD and Dublin Core files carry) moves every
      // one of those descriptions' versions, in the same batch, and only
      // while the repository's own write lands.
      const { nextVersion, nextVersionSql } = await import("~/lib/record-version.server");
      const savedVersion = nextVersion(original.updatedAt);
      const publishedFieldChanged = REPOSITORY_FIELDS_DESCRIPTIONS_PUBLISH.some((f) => f in changed);
      try {
        const [result] = await db.batch([
          db
            .update(repositories)
            .set({
              ...(changed as Partial<typeof repositories.$inferInsert>),
              updatedAt: savedVersion,
            })
            .where(
              and(
                eq(repositories.tenantId, tenant.id),
                eq(repositories.id, id),
                eq(repositories.updatedAt, original.updatedAt)
              )
            ),
          ...(publishedFieldChanged
            ? [
                db
                  .update(descriptions)
                  .set({ updatedAt: nextVersionSql(descriptions.updatedAt, savedVersion) })
                  .where(
                    and(
                      eq(descriptions.tenantId, tenant.id),
                      eq(descriptions.repositoryId, id),
                      sql`EXISTS (SELECT 1 FROM repositories r WHERE r.id = ${id} AND r.tenant_id = ${tenant.id} AND r.updated_at = ${savedVersion})`
                    )
                  ),
              ]
            : []),
        ]);
        if ((result.meta?.changes ?? 0) === 0) {
          const current = await db
            .select({ updatedAt: repositories.updatedAt })
            .from(repositories)
            .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)))
            .get();
          return {
            ok: false as const,
            error: "conflict" as const,
            modifiedAt: current?.updatedAt ?? original.updatedAt,
          };
        }
      } catch (e) {
        if (String(e).includes("UNIQUE constraint failed")) {
          return { ok: false as const, error: "duplicate_code" };
        }
        return { ok: false as const, error: "generic" };
      }

      // Changelog entry for the fields that changed.
      const { computeDiff, createChangelogEntry } = await import(
        "~/lib/changelog.server"
      );
      const diff = computeDiff(stored, changed);
      if (diff) {
        const commitNote =
          (formData.get("commitNote") as string)?.trim() || undefined;
        await createChangelogEntry(
          db,
          id,
          "repository",
          user.id,
          diff,
          commitNote
        );
      }

      // The saved fields supersede the autosaved draft. A request that
      // carried none of them saved nothing, and the draft is kept.
      if (carriesFields) {
        const { deleteDraft } = await import("~/lib/drafts.server");
        await deleteDraft(db, tenant.id, id, "repository");
      }

      // The new version, which the form submits with its next save.
      return { ok: true as const, message: "updated", updatedAt: savedVersion };
    }

    case "delete": {
      // Deleting a repository is administration, which a staff grant does not have.
      requireArea(user, "records");
      // Safety: check description count before deleting
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.repositoryId, id)
          )
        )
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      // The tenant's LAST repository is never deletable — for every
      // tenant, capability or not: a workspace with zero repositories
      // cannot create descriptions or commit imports.
      const [{ count: repositoryCount }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .where(eq(repositories.tenantId, tenant.id))
        .all();
      if (repositoryCount <= 1) {
        return { ok: false as const, error: "last_repository" };
      }

      await db
        .delete(repositories)
        .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)));
      return redirect("/admin/repositories");
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RepositoryDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const { repository, descriptionCount, topLevelDescriptions, conflictDraft, repositoryCount } =
    loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("repositories");

  // Edit mode belongs to the record it was opened on: following a link
  // to another repository leaves it, so the form's inputs and its version
  // always come from the same load.
  const [isEditing, setIsEditing] = useRecordEditMode(repository.id);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const hasDescriptions = descriptionCount > 0;

  // Show conflict dialog when server returns optimistic lock error
  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error === "conflict") {
      setShowConflictDialog(true);
    }
  }, [actionData]);

  // The version the form's field values were loaded from, which it
  // submits; a loader revalidation does not move it.
  const formVersion = useFormVersion(`${repository.id}:${isEditing}`, repository.updatedAt, actionData);

  // Autosave via useFetcher
  const draftFetcher = useFetcher();
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const triggerAutosave = useCallback(() => {
    if (!formRef.current || !isEditing) return;
    const fd = new FormData(formRef.current);
    const snapshot: Record<string, string> = {};
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith("_")) {
        snapshot[key] = value as string;
      }
    }
    draftFetcher.submit(
      { _action: "autosave", snapshot: JSON.stringify(snapshot) },
      { method: "post" }
    );
  }, [isEditing, draftFetcher]);

  const handleFormChange = useCallback(() => {
    if (!isEditing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(triggerAutosave, 2000);
  }, [isEditing, triggerAutosave]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isEditing]);

  const draftStatus =
    draftFetcher.state === "submitting"
      ? "saving"
      : draftFetcher.data && "autosaved" in draftFetcher.data
        ? "saved"
        : null;

  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;
  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const successMessage =
    actionData && "message" in actionData && actionData.ok
      ? actionData.message
      : undefined;

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label={t("common:aria.breadcrumb")} className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/repositories"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{repository.name}</li>
        </ol>
      </nav>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">
          {repository.name}
        </h1>

        {!isEditing ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Pencil className="h-4 w-4" />
              {t("edit")}
            </button>
            {repositoryCount === 1 ? (
              <p className="max-w-xs self-center text-right text-xs text-stone-500">
                {t("last_repository_note")}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => !hasDescriptions && setShowDeleteModal(true)}
                disabled={hasDescriptions}
                aria-disabled={hasDescriptions ? "true" : undefined}
                title={
                  hasDescriptions
                    ? t("delete_blocked", { count: descriptionCount })
                    : undefined
                }
                className={
                  hasDescriptions
                    ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                    : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
                }
              >
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </button>
            )}
          </div>
        ) : null}
      </div>

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
            namespace="repositories"
          />
        </div>
      )}

      {/* Autosave status */}
      {isEditing && draftStatus && (
        <p className="mt-2 text-xs text-stone-400">
          {draftStatus === "saving"
            ? t("autosave_saving")
            : t("autosave_saved")}
        </p>
      )}

      {/* Success banner */}
      {successMessage === "updated" && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
          {t("success_updated")}
        </div>
      )}

      {/* Error banner */}
      {globalError && globalError !== "conflict" && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "duplicate_code"
            ? t("error_duplicate_code")
            : globalError === "has_descriptions"
              ? t("delete_blocked", { count: descriptionCount })
              : globalError === "last_repository"
                ? t("last_repository_note")
                : t("error_generic")}
        </div>
      )}

      {/* Linked descriptions tree */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("linked_descriptions")}
        </h2>
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <DescriptionTree
            repositoryId={repository.id}
            descriptionCount={descriptionCount}
            initialDescriptions={topLevelDescriptions}
          />
        </div>
        {hasDescriptions && (
          <p className="mt-2 text-xs text-stone-400">
            {t("delete_blocked_inline", { count: descriptionCount })}
          </p>
        )}
      </div>

      {/* Detail card */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        {isEditing ? (
          <EditMode
            repository={repository}
            errors={errors}
            t={t}
            onDiscard={() => setIsEditing(false)}
            formRef={formRef}
            onFormChange={handleFormChange}
            formVersion={formVersion}
          />
        ) : (
          <ViewMode repository={repository} t={t} />
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowDeleteModal(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="delete-modal-title"
            aria-describedby="delete-modal-body"
            className="max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("delete_modal_title")}
            </h2>
            <p
              id="delete-modal-body"
              className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto"
            >
              {t("delete_modal_body", { name: repository.name })}
            </p>
            <div className="mt-3">
              <label
                htmlFor="delete-confirm-input"
                className="block text-xs font-medium text-indigo mb-1"
              >
                {t("delete_modal_confirm_label", { code: repository.code })}
              </label>
              <input
                id="delete-confirm-input"
                type="text"
                autoComplete="off"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none focus:ring-1 focus:ring-madder"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmation("");
                }}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("delete_modal_dismiss")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  disabled={deleteConfirmation !== repository.code}
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("delete")}
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}
      {/* Optimistic lock conflict dialog */}
      {showConflictDialog &&
        actionData &&
        "error" in actionData &&
        actionData.error === "conflict" && (
          <ConflictDialog
            modifiedByName=""
            modifiedAt={
              "modifiedAt" in actionData
                ? (actionData.modifiedAt as number)
                : null
            }
            formRef={formRef}
            onCancel={() => setShowConflictDialog(false)}
            t={t}
          />
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

function ViewMode({
  repository,
  t,
}: {
  repository: Awaited<ReturnType<typeof loader>>["repository"];
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-6">
      {/* Identity area */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("section_identity")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay label={t("field.code")} value={repository.code} />
          <FieldDisplay label={t("field.name")} value={repository.name} />
          <FieldDisplay
            label={t("field.shortName")}
            value={repository.shortName}
          />
          <FieldDisplay
            label={t("field.otherNames")}
            value={otherNamesText(repository.otherNames).split("\n").join("; ")}
          />
          <FieldDisplay
            label={t("field.institutionType")}
            value={repository.institutionType}
          />
        </div>
      </section>

      {/* Contact area */}
      <section>
        <h2 className="mt-6 mb-4 text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("section_contact")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay
            label={t("field.countryCode")}
            value={repository.countryCode}
          />
          <FieldDisplay
            label={t("field.country")}
            value={repository.country}
          />
          <FieldDisplay label={t("field.city")} value={repository.city} />
          <FieldDisplay label={t("field.region")} value={repository.region} />
          <FieldDisplay
            label={t("field.address")}
            value={repository.address}
          />
          <FieldDisplay
            label={t("field.postalCode")}
            value={repository.postalCode}
          />
          <FieldDisplay
            label={t("field.telephone")}
            value={repository.telephone}
          />
          <FieldDisplay label={t("field.email")} value={repository.email} />
          {repository.website ? (
            <div>
              <p className="text-xs text-stone-500">{t("field.website")}</p>
              <a
                href={repository.website}
                target="_blank"
                rel="noopener"
                className="text-sm text-indigo-deep hover:underline"
              >
                {repository.website}
              </a>
            </div>
          ) : (
            <FieldDisplay
              label={t("field.website")}
              value={null}
            />
          )}
        </div>
      </section>

      {/* Description, access and services areas */}
      {(
        [
          ["section_description", PROSE_PAIRS.slice(0, 2)],
          ["section_access", PROSE_PAIRS.slice(2, 5)],
          ["section_services", PROSE_PAIRS.slice(5)],
        ] as const
      ).map(([section, pairs]) => (
        <section key={section}>
          <h2 className="mt-6 mb-4 text-sm font-semibold uppercase tracking-wider text-stone-500">
            {t(section)}
          </h2>
          <div className="space-y-3">
            {pairs.flatMap((pair) => [
              <FieldDisplay
                key={`${pair}Es`}
                label={t(`field.${pair}Es`)}
                value={repository[`${pair}Es`]}
              />,
              <FieldDisplay
                key={`${pair}En`}
                label={t(`field.${pair}En`)}
                value={repository[`${pair}En`]}
              />,
            ])}
          </div>
        </section>
      ))}

      {/* Control area */}
      <section>
        <h2 className="mt-6 mb-4 text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("section_control")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay
            label={t("field.descriptionLanguage")}
            value={repository.descriptionLanguage}
          />
        </div>
      </section>

      {/* Administrative */}
      <section>
        <h2 className="mt-6 mb-4 text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("section_admin")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay label={t("field.notes")} value={repository.notes} />
          <FieldDisplay label={t("field.rightsText")} value={repository.rightsText} />
          <FieldDisplay label={t("display_title_label")} value={repository.displayTitle} />
          <FieldDisplay label={t("subtitle_label")} value={repository.subtitle} />
          <FieldDisplay label={t("subtitle_en_label")} value={repository.subtitleEn} />
          <FieldDisplay label={t("hero_image_url_label")} value={repository.heroImageUrl} />
          <FieldDisplay label={t("field.manifestRights")} value={repository.manifestRights} />
          <FieldDisplay
            label={t("field.catalogueLicenceUri")}
            value={repository.catalogueLicenceUri}
          />
          <FieldDisplay
            label={t("field.homeOrder")}
            value={repository.homeOrder == null ? null : String(repository.homeOrder)}
          />
          <FieldDisplay label={t("field.attributionEn")} value={repository.attributionEn} />
          <FieldDisplay label={t("field.attributionEs")} value={repository.attributionEs} />
          <FieldDisplay
            label={t("field.creditStatementEs")}
            value={repository.creditStatementEs}
          />
          <FieldDisplay
            label={t("field.creditStatementEn")}
            value={repository.creditStatementEn}
          />
          <div>
            <p className="text-xs text-stone-500">{t("field.enabled")}</p>
            {repository.enabled ? (
              <span className="mt-1 inline-block rounded-full bg-verdigris-tint px-2 py-0.5 text-xs font-medium text-verdigris">
                {t("badge_enabled")}
              </span>
            ) : (
              <span className="mt-1 inline-block rounded-full bg-indigo-tint px-2 py-0.5 text-xs font-medium text-indigo">
                {t("badge_disabled")}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function FieldDisplay({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-sm text-stone-700">{value || "\u2014"}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditMode({
  repository,
  errors,
  t,
  onDiscard,
  formRef,
  onFormChange,
  formVersion,
}: {
  repository: Awaited<ReturnType<typeof loader>>["repository"];
  errors?: Record<string, string[]> | undefined;
  t: (key: string) => string;
  onDiscard: () => void;
  formRef?: React.Ref<HTMLFormElement>;
  onFormChange?: () => void;
  /** The version the form's field values were loaded from, submitted as `_updatedAt`. */
  formVersion: number;
}) {
  // Interpolated strings and the active locale need the real i18n handle;
  // the narrow `t` prop stays for the plain labels.
  const { t: ti, i18n } = useTranslation("repositories");
  const identity = useRepositoryIdentity({
    name: repository.name,
    code: repository.code,
    country: repository.country ?? "",
    countryCode: repository.countryCode ?? "",
    locale: i18n.language ?? "en",
  });
  return (
    <Form method="post" ref={formRef} onChange={onFormChange}>
      <input type="hidden" name="_action" value="update" />
      <input
        type="hidden"
        name="_updatedAt"
        value={String(formVersion)}
      />

      {/* Contact area */}
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_contact")}
      </h2>
      <div className="space-y-4">
        <RepoCountrySelect
          identity={identity}
          label={t("field.country")}
          chooseLabel={t("country_choose")}
          error={errors?.country?.[0]}
        />
        <RepoCountryCodeInput
          identity={identity}
          label={t("field.countryCode")}
          required
          error={errors?.countryCode?.[0]}
          help={t("country_code_help")}
        />
        <EditField
          name="city"
          label={t("field.city")}
          defaultValue={repository.city ?? ""}
          error={errors?.city?.[0]}
        />
        <EditField
          name="region"
          label={t("field.region")}
          defaultValue={repository.region ?? ""}
          error={errors?.region?.[0]}
          helperText={t("region_help")}
        />
        <EditTextarea
          name="address"
          label={t("field.address")}
          defaultValue={repository.address ?? ""}
          error={errors?.address?.[0]}
        />
        <EditField
          name="postalCode"
          label={t("field.postalCode")}
          defaultValue={repository.postalCode ?? ""}
          error={errors?.postalCode?.[0]}
        />
        <EditField
          name="website"
          label={t("field.website")}
          defaultValue={repository.website ?? ""}
          error={errors?.website?.[0]}
          helperText={t("website_help")}
        />
        <EditField
          name="telephone"
          label={t("field.telephone")}
          defaultValue={repository.telephone ?? ""}
          error={errors?.telephone?.[0]}
          type="tel"
        />
        <EditField
          name="email"
          label={t("field.email")}
          defaultValue={repository.email ?? ""}
          error={errors?.email?.[0]}
          type="email"
        />
      </div>

      {/* Identity area */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_identity")}
      </h2>
      <div className="space-y-4">
        <RepoNameInput
          identity={identity}
          label={t("field.name")}
          required
          error={errors?.name?.[0]}
        />
        <RepoCodeInput
          identity={identity}
          label={t("field.code")}
          required
          error={errors?.code?.[0]}
          help={t("code_help")}
          suggestionLabel={
            identity.suggestion
              ? ti("code_suggested", { code: identity.suggestion })
              : null
          }
          useSuggestionLabel={t("code_use_suggestion")}
        />
        <EditField
          name="shortName"
          label={t("field.shortName")}
          defaultValue={repository.shortName ?? ""}
          error={errors?.shortName?.[0]}
          helperText={t("short_name_help")}
        />
        <EditTextarea
          name="otherNames"
          label={t("field.otherNames")}
          defaultValue={otherNamesText(repository.otherNames)}
          error={errors?.otherNames?.[0]}
          helperText={t("other_names_help")}
        />
        <EditField
          name="institutionType"
          label={t("field.institutionType")}
          defaultValue={repository.institutionType ?? ""}
          error={errors?.institutionType?.[0]}
        />
      </div>

      {/* Description area */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_description")}
      </h2>
      <div className="space-y-4">
        {PROSE_PAIRS.slice(0, 2).map((pair) => (
          <ProsePair key={pair} pair={pair} repository={repository} errors={errors} t={t} />
        ))}
      </div>

      {/* Access area */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_access")}
      </h2>
      <div className="space-y-4">
        {PROSE_PAIRS.slice(2, 5).map((pair) => (
          <ProsePair key={pair} pair={pair} repository={repository} errors={errors} t={t} />
        ))}
      </div>

      {/* Services area */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_services")}
      </h2>
      <div className="space-y-4">
        {PROSE_PAIRS.slice(5).map((pair) => (
          <ProsePair key={pair} pair={pair} repository={repository} errors={errors} t={t} />
        ))}
      </div>

      {/* Control area */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_control")}
      </h2>
      <div className="space-y-4">
        <EditField
          name="descriptionLanguage"
          label={t("field.descriptionLanguage")}
          defaultValue={repository.descriptionLanguage ?? ""}
          error={errors?.descriptionLanguage?.[0]}
          helperText={t("description_language_help")}
        />
      </div>

      {/* Administrative */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("section_admin")}
      </h2>
      <div className="space-y-4">
        <EditTextarea
          name="notes"
          label={t("field.notes")}
          defaultValue={repository.notes ?? ""}
          error={errors?.notes?.[0]}
          helperText={t("notes_help")}
        />
        <EditTextarea
          name="rightsText"
          label={t("field.rightsText")}
          defaultValue={repository.rightsText ?? ""}
          error={errors?.rightsText?.[0]}
          helperText={t("rights_text_help")}
        />
        <EditField
          name="displayTitle"
          label={t("display_title_label")}
          defaultValue={repository.displayTitle ?? ""}
          error={errors?.displayTitle?.[0]}
          helperText={t("display_title_helper")}
        />
        <EditField
          name="subtitle"
          label={t("subtitle_label")}
          defaultValue={repository.subtitle ?? ""}
          error={errors?.subtitle?.[0]}
          helperText={t("subtitle_helper")}
        />
        <EditField
          name="subtitleEn"
          label={t("subtitle_en_label")}
          defaultValue={repository.subtitleEn ?? ""}
          error={errors?.subtitleEn?.[0]}
          helperText={t("subtitle_helper")}
        />
        <EditField
          name="heroImageUrl"
          label={t("hero_image_url_label")}
          defaultValue={repository.heroImageUrl ?? ""}
          error={errors?.heroImageUrl?.[0]}
          helperText={t("hero_image_url_helper")}
          type="url"
        />
        <EditField
          name="manifestRights"
          label={t("field.manifestRights")}
          defaultValue={repository.manifestRights ?? ""}
          error={errors?.manifestRights?.[0]}
          type="url"
        />
        <EditField
          name="catalogueLicenceUri"
          label={t("field.catalogueLicenceUri")}
          defaultValue={repository.catalogueLicenceUri ?? ""}
          error={errors?.catalogueLicenceUri?.[0]}
          helperText={t("catalogue_licence_help")}
          type="url"
        />
        <EditField
          name="homeOrder"
          label={t("field.homeOrder")}
          defaultValue={repository.homeOrder == null ? "" : String(repository.homeOrder)}
          error={errors?.homeOrder?.[0]}
          helperText={t("home_order_help")}
          type="number"
        />
        <EditTextarea
          name="attributionEn"
          label={t("field.attributionEn")}
          defaultValue={repository.attributionEn ?? ""}
          error={errors?.attributionEn?.[0]}
        />
        <EditTextarea
          name="attributionEs"
          label={t("field.attributionEs")}
          defaultValue={repository.attributionEs ?? ""}
          error={errors?.attributionEs?.[0]}
        />
        <ProsePair
          pair="creditStatement"
          repository={repository}
          errors={errors}
          t={t}
          helperKey="credit_statement_help"
        />
        <div className="flex items-center gap-2">
          {/* An unchecked checkbox is not submitted; this hidden input
              tells the update action the request carries the field. */}
          <input type="hidden" name="enabled" value="" />
          <input
            type="checkbox"
            id="enabled"
            name="enabled"
            defaultChecked={repository.enabled ?? true}
            className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
          />
          <label htmlFor="enabled" className="text-sm font-medium text-indigo">
            {t("badge_enabled")}
          </label>
        </div>
        <p className="text-xs text-stone-400">{t("enabled_help")}</p>
      </div>

      {/* Actions */}
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
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("save")}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("discard")}
          </button>
        </div>
      </div>
    </Form>
  );
}

/** The prose pairs of the ISDIAH record, in area order: description (2), access (3), services (1). */
const PROSE_PAIRS = [
  "holdings",
  "history",
  "openingTimes",
  "accessConditions",
  "accessibility",
  "reproductionServices",
] as const;

/** Language pairs of plain text, not Markdown, in the administrative area. */
type PlainPair = "creditStatement";

type ProseColumn = `${(typeof PROSE_PAIRS)[number] | PlainPair}${"Es" | "En"}`;

/** The stored other names (a JSON array, or null) as one name per line. */
function otherNamesText(stored: string | null): string {
  if (!stored) return "";
  try {
    const names: unknown = JSON.parse(stored);
    return Array.isArray(names) ? names.filter((n) => typeof n === "string").join("\n") : "";
  } catch {
    return "";
  }
}

/**
 * A field's Spanish and English textareas, stacked, each with the
 * Markdown hint, or with `helperKey`'s text for a plain-text pair.
 */
function ProsePair({
  pair,
  repository,
  errors,
  t,
  helperKey = "markdown_help",
}: {
  pair: (typeof PROSE_PAIRS)[number] | PlainPair;
  repository: Record<ProseColumn, string | null>;
  errors?: Record<string, string[]> | undefined;
  t: (key: string) => string;
  helperKey?: string;
}) {
  return (
    <>
      {(["Es", "En"] as const).map((lang) => {
        const name: ProseColumn = `${pair}${lang}`;
        return (
          <EditTextarea
            key={name}
            name={name}
            label={t(`field.${name}`)}
            defaultValue={repository[name] ?? ""}
            error={errors?.[name]?.[0]}
            helperText={t(helperKey)}
          />
        );
      })}
    </>
  );
}

function EditField({
  name,
  label,
  defaultValue,
  required,
  error,
  helperText,
  type = "text",
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  error?: string;
  helperText?: string;
  type?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  const helperId = helperText ? `${name}-helper` : undefined;
  const describedBy = [errorId, helperId].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        {required && <span className="text-madder"> *</span>}
      </label>
      {helperText && (
        <p id={helperId} className="mb-1 text-xs text-stone-400">
          {helperText}
        </p>
      )}
      <input
        type={type}
        id={name}
        name={name}
        defaultValue={defaultValue}
        aria-required={required ? "true" : undefined}
        aria-describedby={describedBy}
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

function EditTextarea({
  name,
  label,
  defaultValue,
  error,
  helperText,
}: {
  name: string;
  label: string;
  defaultValue: string;
  error?: string;
  helperText?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  const helperId = helperText ? `${name}-helper` : undefined;
  const describedBy = [errorId, helperId].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
      </label>
      {helperText && (
        <p id={helperId} className="mb-1 text-xs text-stone-400">
          {helperText}
        </p>
      )}
      <textarea
        id={name}
        name={name}
        rows={3}
        defaultValue={defaultValue}
        aria-describedby={describedBy}
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

// @version v0.9.0
