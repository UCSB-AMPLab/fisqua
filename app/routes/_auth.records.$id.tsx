/**
 * Record (Reader) — one published record, read-only
 *
 * This page shows one published description to a Reader: its archival
 * fields as the admin description page shows them (the same
 * standard-driven `DescriptionForm`, never in edit mode), its place in
 * the hierarchy, and the entities and places linked to it as plain
 * text. Readers have no authorities pages, so nothing here links to
 * one; every link on the page stays under `/records/`.
 *
 * Published records only, for everyone who opens the page. An id that
 * names no published record of the request tenant is a 404, whoever
 * asks, a workspace admin included. The ancestor trail above the title
 * stops at the first unpublished ancestor; the contents list below the
 * fields holds published children only, and its count counts only
 * them. The loader's reads all live in `reader.server`
 * (`loadPublishedRecord`), which also strips the columns that never
 * leave the admin surface before the record reaches the page; the
 * same columns are hidden in the form.
 *
 * Open to Readers, workspace admins and super admins
 * (`requireRecordsReader`).
 *
 * @version v0.8.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DescriptionForm } from "~/components/descriptions/description-form";
import { PublishedRecordList } from "~/components/reader/published-record-list";
import type { Route } from "./+types/_auth.records.$id";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const {
    loadPublishedRecord,
    readerHiddenColumns,
    requireRecordsReader,
    READER_PAGE_SIZE,
  } = await import("~/lib/reader.server");

  const user = context.get(userContext);
  requireRecordsReader(user);
  const tenant = context.get(tenantContext);
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }
  const db = drizzle(context.cloudflare.env.DB);

  const page = Math.max(
    1,
    Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10) || 1,
  );
  const loaded = await loadPublishedRecord(db, tenant, params.id, page);
  if (!loaded) {
    throw new Response("Not found", { status: 404 });
  }

  return {
    ...loaded,
    page,
    pageSize: READER_PAGE_SIZE,
    hiddenColumns: readerHiddenColumns(),
    descriptiveStandard: tenant.descriptiveStandard,
    authoritiesEnabled: tenant.authoritiesEnabled,
  };
}

export default function RecordPage({ loaderData }: Route.ComponentProps) {
  const {
    record,
    ancestors,
    children,
    repositories,
    entityLinks,
    placeLinks,
    page,
    pageSize,
    hiddenColumns,
    descriptiveStandard,
    authoritiesEnabled,
  } = loaderData;
  const { t } = useTranslation("reader");
  const { t: td } = useTranslation("descriptions_admin");

  return (
    <div className="mx-auto max-w-4xl">
      <nav aria-label={t("common:aria.breadcrumb")} className="mb-4 font-sans text-sm">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link to="/records" className="text-stone-500 hover:text-stone-700">
              {t("records_title")}
            </Link>
          </li>
          {ancestors.map((ancestor) => (
            <li key={ancestor.id} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-stone-400" />
              <Link
                to={`/records/${ancestor.id}`}
                className="text-stone-500 hover:text-stone-700"
              >
                {ancestor.title}
              </Link>
            </li>
          ))}
          <li className="flex items-center gap-1">
            <ChevronRight className="h-4 w-4 text-stone-400" />
            <span className="text-stone-700">{record.title}</span>
          </li>
        </ol>
      </nav>

      <h1 className="font-serif text-2xl font-semibold text-indigo">
        {record.title}
      </h1>
      <div className="mt-2 flex items-center gap-3">
        <span className="rounded bg-stone-100 px-2 py-0.5 font-sans text-xs font-medium text-stone-500">
          {td(`level_${record.descriptionLevel}`)}
        </span>
        <span className="font-mono text-xs text-stone-500">
          {record.referenceCode}
        </span>
      </div>

      <div className="mt-6">
        <DescriptionForm
          description={record}
          isEditing={false}
          repositories={repositories}
          allowedLevels={[]}
          entityLinks={entityLinks}
          placeLinks={placeLinks}
          standard={descriptiveStandard}
          authoritiesEnabled={authoritiesEnabled}
          hiddenColumns={hiddenColumns}
        />
      </div>

      {children.total > 0 && (
        <section className="mt-8">
          <h2 className="font-serif text-lg font-semibold text-indigo">
            {t("contents_heading")}
          </h2>
          <p className="mt-1 font-sans text-sm text-stone-500">
            {t("contents_count", { count: children.total })}
          </p>
          <div className="mt-4">
            <PublishedRecordList
              rows={children.rows}
              total={children.total}
              page={page}
              pageSize={pageSize}
            />
          </div>
        </section>
      )}
    </div>
  );
}

// @version v0.8.0
