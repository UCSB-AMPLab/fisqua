/**
 * Records (Reader) — the published records list
 *
 * This page is where a Reader lands: the entry points into the
 * workspace's published records, one page at a time, each linking to
 * its record page under `/records/`. An entry point is a published
 * record whose parent is not a published record (it has no parent, or
 * its parent is unpublished), so every published record can be reached
 * from here by following contents downwards, and nothing unpublished
 * is named on the way.
 *
 * The page is open to Readers, workspace admins and super admins
 * (`requireRecordsReader`), and shows every one of them the same
 * published records: the published filter belongs to the page, not to
 * the person. The read lives in `reader.server`
 * (`listPublishedEntryRecords`).
 *
 * @version v0.8.0
 */

import { useTranslation } from "react-i18next";
import { Library } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { PublishedRecordList } from "../components/reader/published-record-list";
import type { Route } from "./+types/_auth.records._index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { listPublishedEntryRecords, requireRecordsReader, READER_PAGE_SIZE } =
    await import("../lib/reader.server");

  const user = context.get(userContext);
  requireRecordsReader(user);
  const tenant = context.get(tenantContext);
  const db = drizzle(context.cloudflare.env.DB);

  const page = Math.max(
    1,
    Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10) || 1,
  );
  const { rows, total } = await listPublishedEntryRecords(db, tenant.id, page);
  return { rows, total, page, pageSize: READER_PAGE_SIZE };
}

export default function RecordsPage({ loaderData }: Route.ComponentProps) {
  const { rows, total, page, pageSize } = loaderData;
  const { t } = useTranslation("reader");

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-serif text-2xl font-semibold text-indigo">
        {t("records_title")}
      </h1>
      <p className="mt-1 font-serif text-15 text-stone-500">
        {t("records_intro")}
      </p>

      {total === 0 ? (
        <div className="mt-12 flex justify-center">
          <div className="max-w-md text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
              <Library className="h-7 w-7 text-indigo" strokeWidth={1.5} />
            </div>
            <h2 className="mt-4 font-serif text-lg text-indigo">
              {t("records_empty_title")}
            </h2>
            <p className="mx-auto mt-2 max-w-measure font-serif text-15 text-stone-500">
              {t("records_empty_body")}
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <PublishedRecordList
            rows={rows}
            total={total}
            page={page}
            pageSize={pageSize}
          />
        </div>
      )}
    </div>
  );
}

// @version v0.8.0
