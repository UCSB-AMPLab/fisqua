/**
 * Publish Pipeline Steps
 *
 * This module deals with the individual steps the publish workflow
 * runs, one exported function per Cloudflare Workflow step. The
 * contract each function respects is narrow: read a well-defined
 * slice of D1, format it with the per-entity helpers next to this
 * file, upload a bounded set of R2 objects, and return the record
 * counts the workflow needs to record in its heartbeat row.
 *
 * Memory stays bounded to at most one fonds at a time and R2 PUTs are
 * capped at a few hundred per step, so a single Worker invocation
 * never runs out of its 128 MB / 30 s / 1000-subrequest budget. The
 * orchestration that wires these into a durable workflow — retries,
 * heartbeats, final tombstone writes — lives in
 * `app/workflows/publish-export.ts`.
 *
 * Every step takes an explicit `tenant: ExportTenant` argument so
 * every D1 read filters by `tenant.id` and every R2 key is prefixed
 * with `${tenant.slug}/`. An earlier iteration of these functions had
 * zero `tenant` references and wrote flat keys
 * (`descriptions-<ref>.json`, `entities.json`, etc.) — a Tenant A
 * superadmin could have triggered an export that read Tenant B rows
 * and overwrote Tenant B's R2 objects. The current shape closes that
 * exposure.
 *
 * A description's `ocr_text` comes from its OCR page rows, joined in
 * page order with a blank line between pages (`joinPageTexts`), so
 * zasqua.org's search keeps reading a description's whole transcript.
 * Text migrated from the old `descriptions.ocr_text` column is one
 * page-1 row and is exported exactly as the column held it; a published
 * volume's description has the run's pages instead. The fonds step
 * reads each batch's pages in one statement that names the tenant on
 * both tables; root descriptions, whose `ocr_text` the repositories
 * file strips, are formatted with none.
 *
 * The per-fonds descriptions file can pass what one Worker can build as
 * a string (pe-bn-cdip's is about 85M characters), so
 * `exportFondsDescriptions` reads the fonds in batches and writes the
 * file as a multipart upload through `json-array-upload.server.ts`,
 * within a single step. Each of its reads is bounded by the fonds
 * through `descriptions_tenant_root_id_idx` (migration 0116). Once the
 * file is complete the step sets the export mark (`last_exported_at`)
 * of the descriptions it wrote and clears that of the unpublished ones
 * it read and left out, by id (`fondsExportMarks`); the publish badge
 * reads the marks.
 *
 * The per-fonds EAD3 and Dublin Core files are written the same way:
 * `writeFondsXml` reads a light outline of the fonds (id, level,
 * repository, reference code), then the full rows a batch at a time
 * through the same index, serialises each record with the builders'
 * pieces and sends the document as a multipart upload (`TextUpload`).
 * The publish path's EAD3 `<c>` blocks are flat siblings under `<dsc>`,
 * each depending only on its own row and the fonds' repository, so the
 * document needs no tree walk; the bytes are those `buildEad3` and
 * `buildDcBulk` give for the fonds' rows in `id` order. Each file has
 * the descriptions file's change detection, which compares each row's
 * `updated_at` as well as the outline, and leaves the previous file in
 * place when the fonds changes while it is written. entities.json reads
 * its entities' ids and `updated_at` again before it is completed.
 *
 * entities.json is written through a `JsonArrayUpload` too, its
 * entities read a batch at a time by keyset on `id`; places.json
 * (6,544 places, about 3.5 MB) is still built as one string.
 *
 * A description's `mets_url` comes from its own tenant's
 * `mets_base_url` (`formatDescription`), and every description has one
 * when its tenant has a base: the fonds step reads the base once for
 * the fonds' tenant, the repositories step once per member tenant.
 * A root's `children_level` comes from the same children in both steps:
 * the fonds step from its outline, the repositories step from one read
 * of the roots' children.
 *
 * The export carries the three institution files the downstream site's
 * data contract (1.1) names beside the record files. The repositories
 * step writes `repositories.json`, one full record per repository, which
 * keeps today's flat fields and `image_reproduction_text` beside the new
 * ones. `exportInstitutionFiles` writes `publisher.json`, the publishing
 * federation's record and credits, and `vocabulary.json`, its controlled
 * lists and authority sources; the workflow runs it on every publish,
 * whatever types it includes, since neither file belongs to one type.
 * Each file is what the builders in `institution-records.server.ts` give
 * for rows that `institution-files.server.ts` reads. The federation is
 * the publish tenant's, so a federation publish writes its files once,
 * under the publish slug.
 *
 * Each entity's `functions` come from its `entity_functions` rows,
 * read for each entities batch by the batch's entity ids, and its
 * `dbe_id` from the entity row.
 *
 * The link files (`entity_links.json`, `place_links.json`) are written by
 * `link-files.server.ts`, which keeps its own multipart-upload steps out of
 * this module.
 *
 * The heartbeat helpers at the end of the module, `recordStepStart` and
 * `recordStepEnd`, also keep the run's step log (`export_runs.step_log`),
 * each step's start and end, inside the UPDATE they already make.
 * `recordStepEnd` writes the run's record counts as it is given them:
 * a number per step id, and the list of skipped per-fonds steps under
 * `skipped` when there are any.
 *
 * `perFondsMainKey` names the object each per-fonds step writes whose
 * presence the workflow checks before it skips the step
 * (`fingerprint.server.ts`); the descriptions, EAD3 and Dublin Core
 * steps write to that key.
 *
 * The Django round import is retired, and its entity-functions step
 * (`scripts/commands/entity-functions.ts`), one of the writers of
 * `entity_functions` that `exportEntities` names, was removed with it.
 *
 * @version v0.9.0
 */

import {
  asc,
  eq,
  and,
  or,
  exists,
  gt,
  lte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { authorityScope } from "../authority-ownership.server";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import {
  descriptions,
  repositories,
  entities,
  entityFunctions,
  places,
  descriptionEntities,
  descriptionPlaces,
  exportRuns,
  vocabularyTerms,
  ocrPages,
  tenants,
} from "../../db/schema";
import type { ExportStorage } from "./r2-client.server";
import {
  JsonArrayUpload,
  TextUpload,
  DEFAULT_PART_SIZE,
  abandonJsonArrayUpload,
} from "./json-array-upload.server";
import type {
  EadInput,
  EadRepository,
  ExportDescription,
  ExportTenant,
} from "./types";
import { formatDescription, type ExportChild } from "./descriptions.server";
import { joinPageTexts, readRepositories } from "./rows.server";
import {
  buildPublisherJson,
  buildRepositoryRecord,
  buildVocabularyJson,
} from "./institution-records.server";
import {
  readFederationInstitution,
  readFederationPublisher,
  readRepositoryFunders,
} from "./institution-files.server";
import { formatEntity } from "./entities.server";
import { formatPlace } from "./places.server";
import {
  FORMER_REFERENCE_PROVIDER,
  formerCodesFor,
  legacyIdsOf,
  mergedFormerCodes,
} from "./former-codes.server";

import { generateChildrenMap } from "./children.server";
import { buildEad3Open, buildEad3Component, buildEad3Close } from "./ead/builder";
import { getEadProfile } from "./ead/profiles/registry";
import { buildDcBulkOpen, buildDcBulkRecord, DC_BULK_CLOSE } from "./dc/builder";
import { sanitiseRefForKey } from "./xml/escape";
import { planStepIdOf } from "./publish-steps";

/**
 * The object each per-fonds step writes whose presence means its files
 * are in place: the descriptions file, the fonds-level children file,
 * the EAD3 file and the Dublin Core file.
 */
export function perFondsMainKey(
  kind: "descriptions" | "children" | "ead" | "dc",
  slug: string,
  fondsCode: string
): string {
  switch (kind) {
    case "descriptions": return `${slug}/descriptions-${fondsCode}.json`;
    case "children": return `${slug}/children/${fondsCode}.json`;
    case "ead": return `${slug}/ead/${sanitiseRefForKey(fondsCode)}.xml`;
    case "dc": return `${slug}/dc/${sanitiseRefForKey(fondsCode)}.xml`;
  }
}

const CHILDREN_PUT_BATCH = 50;
/** Reference codes per query when checking former codes against live ones; with the tenant, 91 of D1's 100 bound parameters. */
const REFERENCE_CODE_CHUNK = 90;

/** Descriptions read per batch of the fonds descriptions step. */
export const DESCRIPTION_BATCH_SIZE = 250;
/**
 * OCR characters read per batch of the fonds descriptions step. A
 * batch closes at this many characters or at `DESCRIPTION_BATCH_SIZE`
 * descriptions, whichever comes first; a description whose own text
 * passes the budget is read as a batch of one.
 */
export const DESCRIPTION_BATCH_OCR_CHARS = 4_000_000;

export interface FondsDescriptionsOptions {
  batchSize?: number;
  batchOcrChars?: number;
  partSize?: number;
  /** Test seam: the clock read just before the step reads the fonds. */
  clock?: () => number;
  /**
   * Test seam: awaited before batch `index` is read, and before the
   * outline is read again ahead of completing the file.
   */
  hooks?: {
    beforeBatch?: (index: number) => Promise<void>;
    beforeFinish?: () => Promise<void>;
  };
}

/**
 * Thrown when a fonds' descriptions, as the file depends on them,
 * changed while the file was being written. The upload is aborted and
 * the previous file is left in place.
 */
export class FondsChangedDuringPublishError extends Error {
  constructor(fondsCode: string, detail: string, artefact = "descriptions file") {
    super(
      `Fonds ${fondsCode} changed during the publish (${detail}); its ${artefact} was not replaced`
    );
    this.name = "FondsChangedDuringPublishError";
  }
}

/**
 * The outline fields the file depends on across the fonds, and the
 * row's `updated_at`, its version: any edit to a row changes it, so a
 * row edited after the outline was read, whether before or after its
 * own batch, shows as a difference and no file mixes the fonds' state
 * before an edit with its state after another.
 */
function outlineDiffers(
  a: { id: string; parentId: string | null; referenceCode: string; descriptionLevel: string; legacyIds: string; updatedAt: number },
  b: { id: string; parentId: string | null; referenceCode: string; descriptionLevel: string; legacyIds: string; updatedAt: number }
): boolean {
  return (
    a.id !== b.id ||
    a.parentId !== b.parentId ||
    a.referenceCode !== b.referenceCode ||
    a.descriptionLevel !== b.descriptionLevel ||
    a.legacyIds !== b.legacyIds ||
    a.updatedAt !== b.updatedAt
  );
}

/**
 * The OCR version of an outline entry: its pages' count, total length
 * and latest `created_at`. Pages have no `updated_at`; a publication
 * replaces a description's pages with new rows, so a new `created_at`
 * marks new text even when its length is the same.
 */
function ocrDiffers(
  a: { ocrChars: number; ocrPageCount: number; ocrCreatedAt: number | null },
  b: { ocrChars: number; ocrPageCount: number; ocrCreatedAt: number | null }
): boolean {
  return (
    Number(a.ocrChars) !== Number(b.ocrChars) ||
    Number(a.ocrPageCount) !== Number(b.ocrPageCount) ||
    a.ocrCreatedAt !== b.ocrCreatedAt
  );
}

/*
 * The three queries of the fonds descriptions step, exported so a test
 * can check their query plans. Each is bounded by the fonds: it seeks
 * `descriptions_tenant_root_id_idx` on `tenant_id = ? AND
 * root_description_id = ?` and walks the fonds' own ids in order, a
 * batch's id range within them, so no read touches another fonds' or
 * another tenant's rows. Pages are then reached one description at a
 * time through `ocr_pages_desc_seq_idx`.
 *
 * D1 keeps no planner statistics (`sqlite_stat1`). Given an equality on
 * `ocr_pages.tenant_id` the planner picks `ocr_pages_tenant_idx`, which
 * visits every page of the tenant once per description. A unary `+`
 * (`+"ocr_pages"."tenant_id" = ?`) keeps the condition but stops the
 * planner using an index for it.
 */

/**
 * The fonds outline: for each published description its id, parent,
 * reference code and former codes, and the length of its OCR text,
 * in `id` order. With the tenant term on `ocr_pages` indexable, the
 * planner probed `ocr_pages_tenant_idx` for each description, which
 * on a tenant of 51,150 descriptions and 14,272 pages came to about
 * 211M row visits.
 */
export function fondsOutlineQuery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rootId: string
) {
  return db
    .select({
      id: descriptions.id,
      parentId: descriptions.parentId,
      referenceCode: descriptions.referenceCode,
      descriptionLevel: descriptions.descriptionLevel,
      legacyIds: descriptions.legacyIds,
      updatedAt: descriptions.updatedAt,
      ocrChars: sql<number>`coalesce(sum(length(${ocrPages.text})), 0)`,
      ocrPageCount: sql<number>`count(${ocrPages.id})`,
      ocrCreatedAt: sql<number | null>`max(${ocrPages.createdAt})`,
    })
    .from(descriptions)
    .leftJoin(
      ocrPages,
      and(
        eq(ocrPages.descriptionId, descriptions.id),
        // Unary +: not ocr_pages_tenant_idx (see above).
        sql`+${ocrPages.tenantId} = ${tenantId}`
      )
    )
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.rootDescriptionId, rootId),
        eq(descriptions.isPublished, true)
      )
    )
    .groupBy(descriptions.id)
    .orderBy(asc(descriptions.id));
}

/**
 * The codes among `referenceCodes` that a description of `tenantId`
 * holds now, read through `desc_ref_code_idx` with equality on the
 * tenant and on each code. Without the tenant term the planner scans
 * the whole index, every description of every tenant, once per call.
 */
export function liveReferenceCodesQuery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  referenceCodes: string[]
) {
  return db
    .select({ referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        inArray(descriptions.referenceCode, referenceCodes)
      )
    );
}

/**
 * The fonds' published description rows whose ids fall in
 * `(afterId, lastId]` (no lower bound when `afterId` is null), in `id`
 * order.
 */
export function fondsBatchRowsQuery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rootId: string,
  afterId: string | null,
  lastId: string
) {
  return db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.rootDescriptionId, rootId),
        eq(descriptions.isPublished, true),
        afterId === null ? undefined : gt(descriptions.id, afterId),
        lte(descriptions.id, lastId)
      )
    )
    .orderBy(asc(descriptions.id));
}

/**
 * The tenant's OCR pages of the fonds' published descriptions whose ids
 * fall in `(afterId, lastId]`, in description and page order. The read
 * starts from the descriptions of the batch and reaches each one's
 * pages by its id; SQLite sorts each description's pages by `page_seq`
 * on its own (a sort of one description's pages at a time, not of the
 * batch). The tenant is named on both tables.
 */
export function fondsBatchPagesQuery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rootId: string,
  afterId: string | null,
  lastId: string
) {
  return db
    .select({ id: ocrPages.descriptionId, text: ocrPages.text })
    .from(descriptions)
    .innerJoin(
      ocrPages,
      and(
        eq(ocrPages.descriptionId, descriptions.id),
        // Unary +: not ocr_pages_tenant_idx (see above).
        sql`+${ocrPages.tenantId} = ${tenantId}`
      )
    )
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.rootDescriptionId, rootId),
        eq(descriptions.isPublished, true),
        afterId === null ? undefined : gt(descriptions.id, afterId),
        lte(descriptions.id, lastId)
      )
    )
    .orderBy(asc(descriptions.id), asc(ocrPages.pageSeq));
}

/**
 * The codes among `formerCodes` that a description of any of
 * `memberTenantIds` holds now. Each member tenant is asked in turn, a
 * chunk of codes at a time, so every statement seeks
 * `desc_ref_code_idx` on (tenant_id, reference_code) and binds at most
 * `REFERENCE_CODE_CHUNK` + 1 parameters; a code found live in one
 * member is not asked of the next. The descriptions step leaves these
 * codes out of the file, and its fingerprint (`fingerprint.server.ts`)
 * hashes the same set, read by this function.
 */
export async function liveFormerCodes(
  db: DrizzleD1Database<any>,
  formerCodes: readonly string[],
  memberTenantIds: readonly string[]
): Promise<Set<string>> {
  const candidates = [...new Set(formerCodes)];
  const live = new Set<string>();
  for (const memberId of new Set(memberTenantIds)) {
    const open = candidates.filter((code) => !live.has(code));
    for (let i = 0; i < open.length; i += REFERENCE_CODE_CHUNK) {
      const rows = await liveReferenceCodesQuery(
        db,
        memberId,
        open.slice(i, i + REFERENCE_CODE_CHUNK)
      ).all();
      for (const r of rows) live.add(r.referenceCode);
    }
  }
  return live;
}

/** Description ids per export-mark statement: one JSON text parameter of about 78 KB. */
export const EXPORT_MARK_ID_CHUNK = 2000;

/**
 * The fonds' unpublished descriptions that still carry an export mark,
 * read through `descriptions_tenant_root_id_idx`: the ones the
 * descriptions file leaves out whose marks the step clears.
 */
export function fondsMarkedUnpublishedQuery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rootId: string
) {
  return db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.rootDescriptionId, rootId),
        sql`coalesce(${descriptions.isPublished}, 0) = 0`,
        isNotNull(descriptions.lastExportedAt)
      )
    );
}

/**
 * The statements that bring export marks (`last_exported_at`) in line
 * with a file written from a read at `readAt`. They name the rows by
 * id, never by fonds: `markIds` are the descriptions the file holds,
 * `clearIds` the unpublished ones the step read in the fonds. A row
 * that joined the fonds after the step read it, which a move does
 * without changing its `updated_at`, is in neither list and keeps its
 * mark. A mark statement sets the mark of each of its ids that is still
 * published, edited before `readAt`, and not marked since its last
 * edit; a clear statement clears the mark of each of its ids that is
 * still unpublished, marked, and edited before `readAt`. A row edited
 * at or after `readAt` keeps its mark either way, so the badge goes on
 * showing it as waiting for a publish.
 *
 * Each statement takes up to `chunk` ids as one JSON text parameter
 * (`json_each`), with three more parameters, and reaches its rows by
 * primary key: the tenant and `updated_at` terms carry a unary `+`, so
 * the planner uses no tenant index for them.
 */
export function fondsExportMarks(
  db: DrizzleD1Database<any>,
  tenantId: string,
  markIds: string[],
  clearIds: string[],
  readAt: number,
  chunk = EXPORT_MARK_ID_CHUNK
) {
  const byIds = (ids: string[]) =>
    and(
      sql`${descriptions.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
      sql`+${descriptions.tenantId} = ${tenantId}`,
      sql`+${descriptions.updatedAt} < ${readAt}`
    );
  const chunks = (ids: string[]) => {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += chunk) out.push(ids.slice(i, i + chunk));
    return out;
  };
  return [
    ...chunks(markIds).map((ids) =>
      db
        .update(descriptions)
        .set({ lastExportedAt: readAt })
        .where(
          and(
            byIds(ids),
            eq(descriptions.isPublished, true),
            or(isNull(descriptions.lastExportedAt), sql`${descriptions.lastExportedAt} < ${descriptions.updatedAt}`)
          )
        )
    ),
    ...chunks(clearIds).map((ids) =>
      db
        .update(descriptions)
        .set({ lastExportedAt: null })
        .where(
          and(
            byIds(ids),
            sql`coalesce(${descriptions.isPublished}, 0) = 0`,
            isNotNull(descriptions.lastExportedAt)
          )
        )
    ),
  ];
}

/**
 * Export descriptions for a single fonds to
 * `<slug>/descriptions-<fonds>.json` and return its record count and
 * its size in UTF-8 bytes.
 *
 * The file is never held whole. The step first reads the fonds'
 * outline: for each published description its id, parent, reference
 * code and former codes, and the length of its OCR text, in `id`
 * order. That is all `formatDescription` needs from across the fonds
 * (parent reference codes, child reference codes, live former codes).
 * Then it reads full rows and their OCR pages one batch at a time, an
 * `id` range of the outline per batch, formats them and hands them to
 * a `JsonArrayUpload`, which sends the file to R2 in fixed-size parts.
 * Every query binds a fixed handful of parameters, whatever the batch
 * size, except the former-code check, chunked at `REFERENCE_CODE_CHUNK`.
 *
 * Records are written in `id` order.
 *
 * Once the file is complete, the step brings the export marks in line
 * with it (`fondsExportMarks`, one D1 batch), with the time it took just
 * before it read the fonds: it marks the ids the file holds and clears
 * the unpublished ids it read with the outline
 * (`fondsMarkedUnpublishedQuery`), never rows it did not read. The marks
 * are written after the file's last check, and no check reads them, so
 * they cannot make the step refuse its own file. A write that fails, or
 * a change that makes the step refuse the file, leaves every mark as it
 * was. A retry reads at a later time and finds the rows it marked
 * already marked, so it moves only the marks of rows edited between the
 * two reads. pe-bn-cdip's 14,776 published descriptions take eight mark
 * statements, plus one clear statement per 2,000 marked unpublished
 * ones.
 *
 * A file is never completed from data that changed while it was being
 * written, since a child would carry its parent's old reference code,
 * or `children_level` and the former codes would come from rows that
 * no longer hold. Each batch's full rows are checked against their
 * outline entries (reference code, parent, former codes, and still
 * published, which the batch query's filter makes a matter of the row
 * being returned at all), and a row the outline does not hold counts
 * as a change. Just before the file is completed the outline is read
 * again and compared entry by entry, including each row's `updated_at`
 * and its pages' count, length and latest `created_at`, so a content
 * edit or a new OCR text counts as a change wherever it falls in the
 * step. On any difference the upload is
 * aborted, the previous file stays as it was, and
 * `FondsChangedDuringPublishError` is thrown, so the Workflow retries
 * the step. Any other error inside the writing also aborts the upload.
 *
 * The whole file is written in one Workflow step. pe-bn-cdip, the
 * largest fonds (14,776 descriptions, 61.4M characters of OCR), takes
 * at most about 76 batches: about 160 D1 queries plus one per 90
 * former codes, and about 13 R2 calls. Memory stays at the outline,
 * one batch and one part.
 */
export async function exportFondsDescriptions(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant,
  memberTenantIds?: string[],
  options: FondsDescriptionsOptions = {}
): Promise<{ recordCount: number; byteSize: number }> {
  const batchSize = options.batchSize ?? DESCRIPTION_BATCH_SIZE;
  const batchOcrChars = options.batchOcrChars ?? DESCRIPTION_BATCH_OCR_CHARS;
  const key = perFondsMainKey("descriptions", tenant.slug, fondsCode);
  // Taken before any read, so an edit made while the step runs is newer.
  const readAt = (options.clock ?? Date.now)();

  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fondsCode),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) {
    await storage.putObject(key, "[]");
    return { recordCount: 0, byteSize: 2 };
  }

  const readOutline = () => fondsOutlineQuery(db, tenant.id, root.id).all();
  const outline = await readOutline();
  // The unpublished descriptions the file leaves out, read with the
  // outline; their marks are cleared once the file is in place.
  const clearIds = (await fondsMarkedUnpublishedQuery(db, tenant.id, root.id).all()).map((r) => r.id);
  // The descriptions the file holds, as each batch is written.
  const writtenIds: string[] = [];

  // Build per-fonds parent/child lookups so formatDescription can resolve
  // parent_reference_code and children_level without leaking out of the fonds.
  const refById = new Map(outline.map((r) => [r.id, r.referenceCode]));
  const childrenByParent = new Map<string, ExportChild[]>();
  for (const row of outline) {
    if (row.parentId) {
      const child = { referenceCode: row.referenceCode, descriptionLevel: row.descriptionLevel };
      const list = childrenByParent.get(row.parentId);
      if (list) list.push(child);
      else childrenByParent.set(row.parentId, [child]);
    }
  }

  const metsBaseUrl = (
    await db
      .select({ metsBaseUrl: tenants.metsBaseUrl })
      .from(tenants)
      .where(eq(tenants.id, tenant.id))
      .get()
  )?.metsBaseUrl ?? null;

  // Former reference codes, less any a description holds now in any
  // tenant whose files are published together: a live page cannot
  // redirect (former-codes.server.ts). `liveFormerCodes` reads them.
  const formerByRow = new Map(
    outline.map((r) => [r.id, legacyIdsOf(r.legacyIds, FORMER_REFERENCE_PROVIDER)])
  );
  const live = await liveFormerCodes(
    db,
    [...formerByRow.values()].flat(),
    memberTenantIds ?? [tenant.id]
  );

  // Repository cache scoped to this fonds (almost always one repo per fonds).
  const repoCache = new Map<string, { code: string; country: string | null }>();
  const upload = JsonArrayUpload.start(storage, key, options.partSize ?? DEFAULT_PART_SIZE);

  let written: { rowCount: number; byteSize: number };
  try {
    let next = 0;
    for (let batch = 0; next < outline.length; batch++) {
      // A batch closes at batchSize descriptions or batchOcrChars
      // characters of OCR, and always holds at least one description.
      let end = next + 1;
      let chars = outline[next].ocrChars;
      while (
        end < outline.length &&
        end - next < batchSize &&
        chars + outline[end].ocrChars <= batchOcrChars
      ) {
        chars += outline[end].ocrChars;
        end++;
      }
      const batchOutline = outline.slice(next, end);
      // Consecutive batches cover adjacent id ranges, so a row that
      // joins the fonds between two outline ids lands in a batch.
      const afterId = next === 0 ? null : outline[next - 1].id;
      const lastId = batchOutline[batchOutline.length - 1].id;
      next = end;

      await options.hooks?.beforeBatch?.(batch);

      const rows = await fondsBatchRowsQuery(db, tenant.id, root.id, afterId, lastId).all();
      // OCR text comes from the page rows, not the description row.
      const pages = await fondsBatchPagesQuery(db, tenant.id, root.id, afterId, lastId).all();
      const ocrById = joinPageTexts(pages);

      // The batch must hold exactly its outline entries, unchanged. The
      // query's filter returns only published rows of this fonds, so an
      // entry unpublished or moved out of the fonds is a missing row.
      if (rows.length !== batchOutline.length) {
        const known = new Set(batchOutline.map((r) => r.id));
        const extra = rows.find((r) => !known.has(r.id));
        throw new FondsChangedDuringPublishError(
          fondsCode,
          extra
            ? `${extra.referenceCode} was published after the publish began`
            : `${batchOutline.find((o) => !rows.some((r) => r.id === o.id))?.referenceCode} is no longer published in it`
        );
      }
      rows.forEach((row, i) => {
        const entry = batchOutline[i];
        if (!row.isPublished || outlineDiffers(row, entry)) {
          throw new FondsChangedDuringPublishError(
            fondsCode,
            row.id === entry.id
              ? `${entry.referenceCode} was edited after the publish began`
              : `${row.referenceCode} was published after the publish began`
          );
        }
      });

      const formatted: ExportDescription[] = [];
      for (const row of rows) {
        let repo = repoCache.get(row.repositoryId);
        if (!repo) {
          const repoRow = await db
            .select({
              code: repositories.code,
              country: repositories.country,
            })
            .from(repositories)
            .where(
              and(
                eq(repositories.id, row.repositoryId),
                eq(repositories.tenantId, tenant.id)
              )
            )
            .get();
          repo = repoRow ?? { code: "", country: null };
          repoCache.set(row.repositoryId, repo);
        }

        const parentRefCode = row.parentId
          ? refById.get(row.parentId) ?? null
          : null;
        const children = childrenByParent.get(row.id) ?? [];

        formatted.push(
          formatDescription(
            { ...row, ocrText: ocrById.get(row.id) ?? null },
            repo,
            parentRefCode,
            children,
            metsBaseUrl,
            (formerByRow.get(row.id) ?? []).filter((code) => !live.has(code))
          )
        );
      }
      await upload.writeRows(formatted);
      for (const row of rows) writtenIds.push(row.id);
    }

    // A row already written can have changed since its batch: read the
    // outline again and compare it entry by entry before completing.
    await options.hooks?.beforeFinish?.();
    const settled = await readOutline();
    if (settled.length !== outline.length) {
      throw new FondsChangedDuringPublishError(
        fondsCode,
        `${outline.length} published descriptions became ${settled.length}`
      );
    }
    const moved = settled.findIndex(
      (row, i) => outlineDiffers(row, outline[i]) || ocrDiffers(row, outline[i])
    );
    if (moved >= 0) {
      throw new FondsChangedDuringPublishError(
        fondsCode,
        `${outline[moved].referenceCode} was edited after the publish began`
      );
    }

    written = await upload.finish();
  } catch (err) {
    // Nothing of this attempt is completed: abort what it sent, so the
    // previous file stays in place, including when completing the
    // upload is what failed. Best-effort; never throws.
    await abandonJsonArrayUpload(storage, upload.snapshot());
    throw err;
  }

  // The file is in place: mark what it holds and clear what it leaves out.
  const marks = fondsExportMarks(db, tenant.id, writtenIds, clearIds, readAt);
  if (marks.length > 0) await db.batch(marks as unknown as Parameters<typeof db.batch>[0]);
  return { recordCount: written.rowCount, byteSize: written.byteSize };
}

/**
 * Export the children/{ref}.json files for a single fonds.
 *
 * Crucially, R2 PUTs are batched at CHILDREN_PUT_BATCH (50) concurrently.
 * Even the largest fonds has well under 1000 parents per step, so the
 * subrequest budget is comfortably respected. Higher concurrency would
 * give marginal speed at the cost of backpressure safety.
 *
 * Memory bound: one fonds at a time.
 * Subrequest bound: 1 root query + 1 fonds rows query + N child PUTs.
 */
export async function exportFondsChildren(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant
): Promise<{ parentCount: number; putCount: number }> {
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fondsCode),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) return { parentCount: 0, putCount: 0 };

  const fondsRows = await db
    .select({
      id: descriptions.id,
      parentId: descriptions.parentId,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      descriptionLevel: descriptions.descriptionLevel,
      dateExpression: descriptions.dateExpression,
      childCount: descriptions.childCount,
      hasDigital: descriptions.hasDigital,
      position: descriptions.position,
    })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  const childrenMap = generateChildrenMap(fondsRows);
  const entries = Array.from(childrenMap.entries());
  let putCount = 0;

  for (let i = 0; i < entries.length; i += CHILDREN_PUT_BATCH) {
    const slice = entries.slice(i, i + CHILDREN_PUT_BATCH);
    await Promise.all(
      slice.map(([refCode, children]) =>
        storage.putObject(
          `${tenant.slug}/children/${refCode}.json`,
          JSON.stringify(children)
        )
      )
    );
    putCount += slice.length;
  }

  return { parentCount: entries.length, putCount };
}

/** Descriptions read per batch of the fonds EAD3 and Dublin Core steps. */
export const XML_BATCH_SIZE = 250;

/** Map a full description row to the shape the EAD3 and DC builders read. */
function toEadInput(r: typeof descriptions.$inferSelect): EadInput {
  return {
    id: r.id,
    referenceCode: r.referenceCode,
    title: r.title,
    descriptionLevel: r.descriptionLevel,
    dateExpression: r.dateExpression ?? null,
    extent: r.extent ?? null,
    creatorDisplay: r.creatorDisplay ?? null,
    scopeContent: r.scopeContent ?? null,
    accessConditions: r.accessConditions ?? null,
    language: r.language ?? null,
    placeDisplay: r.placeDisplay ?? null,
    imprint: r.imprint ?? null,
    parentReferenceCode: null, // not used by either builder at the row level
    repositoryId: r.repositoryId,
    isPublished: !!r.isPublished,
    legacyIds: parseLegacyIds(r.legacyIds),
    adminBiogHistory: r.adminBiogHistory ?? null,
    preferredCitation: r.preferredCitation ?? null,
    acquisitionInfo: r.acquisitionInfo ?? null,
    systemOfArrangement: r.systemOfArrangement ?? null,
    physicalCharacteristics: r.physicalCharacteristics ?? null,
  };
}

/**
 * The outline of the fonds EAD3 and Dublin Core steps: each published
 * description's id, level, repository, reference code and `updated_at`,
 * in `id` order, read through `descriptions_tenant_root_id_idx`. That
 * is all either document depends on from across the fonds (which rows
 * it holds, which of them is the fonds-level row whose `<archdesc>`
 * opens the EAD3 document, which repositories the records name), and
 * each row's version, so an edit made while the file is written is
 * caught whether it falls before or after the row's own batch.
 */
export function fondsXmlOutlineQuery(
  db: DrizzleD1Database<any>,
  tenantId: string,
  rootId: string
) {
  return db
    .select({
      id: descriptions.id,
      descriptionLevel: descriptions.descriptionLevel,
      repositoryId: descriptions.repositoryId,
      referenceCode: descriptions.referenceCode,
      updatedAt: descriptions.updatedAt,
    })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenantId),
        eq(descriptions.rootDescriptionId, rootId),
        eq(descriptions.isPublished, true)
      )
    )
    .orderBy(asc(descriptions.id));
}

type XmlOutlineEntry = {
  id: string;
  descriptionLevel: string;
  repositoryId: string;
  referenceCode: string;
  updatedAt: number;
};

/**
 * The outline fields, and the row's `updated_at`, its version, so a
 * content edit made at any point of the step shows as a difference.
 */
function xmlOutlineDiffers(a: XmlOutlineEntry, b: XmlOutlineEntry): boolean {
  return (
    a.id !== b.id ||
    a.descriptionLevel !== b.descriptionLevel ||
    a.repositoryId !== b.repositoryId ||
    a.referenceCode !== b.referenceCode ||
    a.updatedAt !== b.updatedAt
  );
}

export interface FondsXmlOptions {
  batchSize?: number;
  partSize?: number;
  /** Test seam: the time written into the document (EAD3 creation date, DC datestamp). */
  now?: Date;
  /**
   * Test seam: awaited before batch `index` is read, and before the
   * outline is read again ahead of completing the file.
   */
  hooks?: {
    beforeBatch?: (index: number) => Promise<void>;
    beforeFinish?: () => Promise<void>;
  };
}

/**
 * The pieces of one per-fonds XML document, as the EAD3 and Dublin
 * Core steps hand them to `writeFondsXml`.
 */
interface FondsXmlDocument {
  /** The text before the first record, given the fonds row (EAD3 only) and the repositories. */
  open(fondsRow: EadInput | null, repos: Map<string, EadRepository>, hasRecords: boolean): string;
  /** Whether a row of the outline is written as a record, given the fonds' root id. */
  isRecord(entry: XmlOutlineEntry, rootId: string): boolean;
  record(row: EadInput, fondsRow: EadInput | null, repos: Map<string, EadRepository>): string;
  close(hasRecords: boolean): string;
}

/**
 * Write one fonds' XML document to `key` without holding it whole.
 *
 * The outline is read first. The repositories it names are read once,
 * through `readRepositories`, with the federation's hosting statement
 * their attribution line needs (a fonds names one or two). For EAD3 the
 * fonds-level row is read in full by primary key, since its `<archdesc>`
 * comes before every `<c>`. Then the fonds' published rows are read a
 * batch at a time, an id range of the outline per batch through
 * `fondsBatchRowsQuery`, each record serialised and appended to a
 * `TextUpload`, which sends the file to R2 in fixed-size parts. Records
 * are written in `id` order (the old single query had no ORDER BY, so
 * its order was undefined).
 *
 * The same change detection as the descriptions file applies: each
 * batch must hold exactly its outline entries unchanged, and the
 * outline is read again just before the file is completed. On any
 * difference the upload is aborted, the previous file stays in place,
 * and `FondsChangedDuringPublishError` is thrown.
 *
 * co-ahr-gob, the fonds with the most descriptions (45,341), takes 182
 * batches: about 190 D1 queries and, at 8 MiB a part, a handful of R2
 * calls. Memory stays at the outline, one batch and one part.
 */
async function writeFondsXml(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant,
  key: string,
  doc: FondsXmlDocument,
  needsFondsRow: boolean,
  artefact: string,
  options: FondsXmlOptions
): Promise<{ recordCount: number; byteSize: number }> {
  const batchSize = options.batchSize ?? XML_BATCH_SIZE;
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fondsCode),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) {
    await storage.putObjectXml(key, "");
    return { recordCount: 0, byteSize: 0 };
  }

  const readOutline = () => fondsXmlOutlineQuery(db, tenant.id, root.id).all();
  const outline = await readOutline();

  let fondsRow: EadInput | null = null;
  if (needsFondsRow) {
    // buildEad3 writes nothing for a fonds with no published rows.
    if (outline.length === 0) {
      await storage.putObjectXml(key, "");
      return { recordCount: 0, byteSize: 0 };
    }
    // The root is the <archdesc> whatever its level: six roots in
    // production are collections rather than fonds.
    const fondsEntry = outline.find((r) => r.id === root.id);
    if (!fondsEntry) throw new Error("buildEad3: no root row in input");
    const row = await db
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.id, fondsEntry.id), eq(descriptions.tenantId, tenant.id)))
      .get();
    if (!row || !row.isPublished || row.rootDescriptionId !== root.id || xmlOutlineDiffers(row, fondsEntry)) {
      throw new FondsChangedDuringPublishError(
        fondsCode,
        `${fondsEntry.referenceCode} was edited after the publish began`,
        artefact
      );
    }
    fondsRow = toEadInput(row);
  }

  // Every repository the fonds' rows name, with its attribution line.
  const repos: Map<string, EadRepository> = await readRepositories(
    db,
    tenant,
    outline.map((r) => r.repositoryId)
  );

  const hasRecords = outline.some((r) => doc.isRecord(r, root.id));
  const upload = TextUpload.start(
    storage,
    key,
    "application/xml; charset=utf-8",
    options.partSize ?? DEFAULT_PART_SIZE
  );

  try {
    await upload.write(doc.open(fondsRow, repos, hasRecords));

    for (let next = 0, batch = 0; next < outline.length; batch++) {
      const end = Math.min(next + batchSize, outline.length);
      const batchOutline = outline.slice(next, end);
      const afterId = next === 0 ? null : outline[next - 1].id;
      const lastId = batchOutline[batchOutline.length - 1].id;
      next = end;

      await options.hooks?.beforeBatch?.(batch);
      const rows = await fondsBatchRowsQuery(db, tenant.id, root.id, afterId, lastId).all();

      if (rows.length !== batchOutline.length) {
        const known = new Set(batchOutline.map((r) => r.id));
        const extra = rows.find((r) => !known.has(r.id));
        throw new FondsChangedDuringPublishError(
          fondsCode,
          extra
            ? `${extra.referenceCode} was published after the publish began`
            : `${batchOutline.find((o) => !rows.some((r) => r.id === o.id))?.referenceCode} is no longer published in it`,
          artefact
        );
      }
      let text = "";
      rows.forEach((row, i) => {
        const entry = batchOutline[i];
        if (!row.isPublished || xmlOutlineDiffers(row, entry)) {
          throw new FondsChangedDuringPublishError(
            fondsCode,
            row.id === entry.id
              ? `${entry.referenceCode} was edited after the publish began`
              : `${row.referenceCode} was published after the publish began`,
            artefact
          );
        }
        if (doc.isRecord(entry, root.id)) text += doc.record(toEadInput(row), fondsRow, repos);
      });
      await upload.write(text);
    }

    await upload.write(doc.close(hasRecords));

    // A row already written can have changed since its batch: read the
    // outline again and compare it entry by entry before completing.
    await options.hooks?.beforeFinish?.();
    const settled = await readOutline();
    if (settled.length !== outline.length) {
      throw new FondsChangedDuringPublishError(
        fondsCode,
        `${outline.length} published descriptions became ${settled.length}`,
        artefact
      );
    }
    const moved = settled.findIndex((row, i) => xmlOutlineDiffers(row, outline[i]));
    if (moved >= 0) {
      throw new FondsChangedDuringPublishError(
        fondsCode,
        `${outline[moved].referenceCode} was edited after the publish began`,
        artefact
      );
    }
    const { byteSize } = await upload.finish();
    // Every published row of the fonds, as the builders counted them.
    return { recordCount: outline.length, byteSize };
  } catch (err) {
    // Nothing of this attempt is completed: abort what it sent, so the
    // previous file stays in place, including when completing the
    // upload is what failed. Best-effort; never throws.
    await abandonJsonArrayUpload(storage, upload.snapshot());
    throw err;
  }
}

/**
 * Per-element shape for `descriptions.legacy_ids`. The column is TEXT
 * with no CHECK constraint and the legacy-import tooling has
 * historically been the only writer, but a defensive shape validation
 * here costs ~5 lines and prevents
 * `<unitid localtype="undefined">undefined</unitid>` from ever
 * reaching the EAD3 emitter. Any element that fails the schema is
 * silently dropped from the result; if the result is empty,
 * `parseLegacyIds` returns null to match the builder's "absent -> no
 * legacy unitids" semantics.
 */
const LegacyIdEntrySchema = z.object({
  provider: z.string().min(1),
  id: z.union([z.string(), z.number()]),
});

const LegacyIdsArraySchema = z.array(z.unknown());

/**
 * Parse the JSON-encoded `legacy_ids` column into the structured array
 * shape `EadInput.legacyIds` declares. Returns `null` (not `[]`) on parse
 * failure or empty array to match the EAD3 builder's "absent → no legacy
 * unitids" semantics — the builder branches on the array being non-null
 * before iterating.
 *
 * Each element is Zod-validated before it reaches the EAD3 builder.
 * Malformed entries (missing provider,
 * non-scalar id, null entries, non-objects) are dropped rather than
 * type-cast through unchecked, which previously surfaced as the
 * literal string "undefined" inside `localtype` attributes and unitid
 * bodies.
 */
function parseLegacyIds(
  raw: unknown
): Array<{ provider: string; id: string | number }> | null {
  if (raw == null || raw === "") return null;

  let candidate: unknown;
  if (Array.isArray(raw)) {
    candidate = raw;
  } else if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const arr = LegacyIdsArraySchema.safeParse(candidate);
  if (!arr.success || arr.data.length === 0) return null;

  const out: Array<{ provider: string; id: string | number }> = [];
  for (const entry of arr.data) {
    const parsed = LegacyIdEntrySchema.safeParse(entry);
    if (parsed.success) {
      out.push({ provider: parsed.data.provider, id: parsed.data.id });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * Export one fonds as an EAD3 finding-aid document under the tenant's
 * R2 prefix. Composes the EAD3 builder's pieces (`buildEad3Open`,
 * `buildEad3Component`, `buildEad3Close`), the per-standard profile
 * registry, and the tenant-scoping prerequisites already in this
 * module, through `writeFondsXml`, so the file is the bytes `buildEad3`
 * gives for the fonds' rows in `id` order, written a batch at a time.
 *
 * Profile selected from `tenant.descriptiveStandard`. R2 key:
 * `${tenant.slug}/ead/${sanitiseRefForKey(fondsCode)}.xml`. An empty
 * file for a fonds with no root or no published rows, as before.
 * `byteSize` is the file's size in UTF-8 bytes.
 */
export async function exportFondsEad(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant,
  options: FondsXmlOptions = {}
): Promise<{ recordCount: number; byteSize: number }> {
  const key = perFondsMainKey("ead", tenant.slug, fondsCode);
  const profile = getEadProfile(tenant.descriptiveStandard);
  const createDate = (options.now ?? new Date()).toISOString();
  return writeFondsXml(db, storage, fondsCode, tenant, key, {
    open: (fondsRow, repos, hasRecords) =>
      buildEad3Open(fondsRow!, repos.get(fondsRow!.repositoryId), profile, createDate, hasRecords),
    isRecord: (entry, rootId) => entry.id !== rootId,
    record: (row, fondsRow, repos) => buildEad3Component(row, repos.get(fondsRow!.repositoryId)),
    close: (hasRecords) => buildEad3Close(hasRecords),
  }, true, "EAD3 file", options);
}

/**
 * Export one fonds as a Dublin Core bulk file under the tenant's R2
 * prefix. Composes the DC builder's pieces (`buildDcBulkOpen`,
 * `buildDcBulkRecord`, `DC_BULK_CLOSE`) through `writeFondsXml`, so the
 * file is the bytes `buildDcBulk` gives for the fonds' published rows in
 * `id` order, written a batch at a time.
 *
 * Wrapper: OAI-PMH 2.0 `<ListRecords>`. R2 key:
 * `${tenant.slug}/dc/${sanitiseRefForKey(fondsCode)}.xml`. `byteSize`
 * is the file's size in UTF-8 bytes.
 */
export async function exportFondsDc(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  fondsCode: string,
  tenant: ExportTenant,
  options: FondsXmlOptions = {}
): Promise<{ recordCount: number; byteSize: number }> {
  const key = perFondsMainKey("dc", tenant.slug, fondsCode);
  // YYYY-MM-DD per OAI-PMH `<datestamp>` convention.
  const todayIso = (options.now ?? new Date()).toISOString().slice(0, 10);
  return writeFondsXml(db, storage, fondsCode, tenant, key, {
    open: () => buildDcBulkOpen(),
    isRecord: () => true,
    record: (row, _fondsRow, repos) => buildDcBulkRecord(row, repos, todayIso),
    close: () => DC_BULK_CLOSE,
  }, false, "Dublin Core file", options);
}

/**
 * Export repositories.json. Builds repository_count via a lightweight
 * GROUP BY query — does NOT depend on allFormattedDescriptions being in
 * memory. Only the (small) set of root descriptions is fetched in full,
 * with their published children's levels, so each root's
 * `children_level` is the one its descriptions file gives it. Each
 * repository's record is what `buildRepositoryRecord` gives for its row
 * and funders, with the publishing federation's manifest base address
 * and hosting statement.
 */
export async function exportRepositories(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[]
): Promise<{ count: number }> {
  // Federation publish (spec §9 step 8): read every member tenant's
  // repositories and description counts, but write the single
  // repositories.json under the publish (lead) slug. Omitted →
  // single-tenant own-publish, byte-identical to pre-step-8 behaviour.
  const tenantIds = memberTenantIds ?? [tenant.id];
  const allRepos = await db
    .select()
    .from(repositories)
    .where(
      and(
        inArray(repositories.tenantId, tenantIds),
        eq(repositories.enabled, true)
      )
    )
    .all();

  // Lightweight count: id + repositoryId + isPublished only.
  const countRows = await db
    .select({
      repositoryId: descriptions.repositoryId,
      n: sql<number>`COUNT(*)`,
    })
    .from(descriptions)
    .where(
      and(
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true)
      )
    )
    .groupBy(descriptions.repositoryId)
    .all();

  const repoIdToCount = new Map(countRows.map((r) => [r.repositoryId, Number(r.n)]));
  const repoIdToCode = new Map(allRepos.map((r) => [r.id, r.code]));
  const descriptionCountByRepoCode = new Map<string, number>();
  for (const [repoId, n] of repoIdToCount) {
    const code = repoIdToCode.get(repoId);
    if (code) descriptionCountByRepoCode.set(code, n);
  }

  // Root descriptions: small set (one per fonds), safe to format in full.
  const rootRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true),
        isNull(descriptions.parentId)
      )
    )
    .all();

  const metsBaseByTenant = new Map(
    (
      await db
        .select({ id: tenants.id, metsBaseUrl: tenants.metsBaseUrl })
        .from(tenants)
        .where(inArray(tenants.id, tenantIds))
        .all()
    ).map((t) => [t.id, t.metsBaseUrl])
  );

  // Each root's children, for its children_level: the children its
  // descriptions file reads, the published descriptions of the root's
  // tenant and fonds whose parent is the root. Read by
  // `desc_parent_pos_idx`, the roots in chunks within D1's 100 bound
  // parameters.
  const childrenByRoot = new Map<string, ExportChild[]>(rootRows.map((r) => [r.id, []]));
  const rootTenant = new Map(rootRows.map((r) => [r.id, r.tenantId]));
  const rootChunk = Math.max(1, 90 - tenantIds.length);
  for (let i = 0; i < rootRows.length; i += rootChunk) {
    const children = await db
      .select({
        parentId: descriptions.parentId,
        tenantId: descriptions.tenantId,
        referenceCode: descriptions.referenceCode,
        descriptionLevel: descriptions.descriptionLevel,
      })
      .from(descriptions)
      .where(
        and(
          inArray(descriptions.parentId, rootRows.slice(i, i + rootChunk).map((r) => r.id)),
          inArray(descriptions.tenantId, tenantIds),
          eq(descriptions.isPublished, true),
          sql`${descriptions.rootDescriptionId} = ${descriptions.parentId}`
        )
      )
      .all();
    for (const c of children) {
      if (c.parentId && rootTenant.get(c.parentId) === c.tenantId) {
        childrenByRoot.get(c.parentId)?.push({ referenceCode: c.referenceCode, descriptionLevel: c.descriptionLevel });
      }
    }
  }

  const formattedRoots: ExportDescription[] = [];
  for (const row of rootRows) {
    const repo = allRepos.find((r) => r.id === row.repositoryId);
    formattedRoots.push(
      formatDescription(
        { ...row, ocrText: null },
        { code: repo?.code ?? "", country: repo?.country ?? null },
        null,
        childrenByRoot.get(row.id) ?? [],
        metsBaseByTenant.get(row.tenantId) ?? null
      )
    );
  }

  const federation = await readFederationPublisher(db, tenant.federationId);
  const fundersByRepo = await readRepositoryFunders(db, allRepos.map((r) => r.id));

  const records = allRepos.map((repo) =>
    buildRepositoryRecord(
      repo,
      fundersByRepo.get(repo.id) ?? [],
      {
        descriptionCount: descriptionCountByRepoCode.get(repo.code) ?? 0,
        rootDescriptions: formattedRoots
          .filter((d) => d.repository_code === repo.code)
          .map(({ ocr_text: _, ...rest }) => rest),
      },
      federation.manifestBaseUrl,
      federation.hosting
    )
  );
  await storage.putObject(
    `${tenant.slug}/repositories.json`,
    JSON.stringify(records)
  );

  return { count: records.length };
}

/**
 * Export publisher.json and vocabulary.json for the publishing
 * federation, under the publish slug: what `buildPublisherJson` and
 * `buildVocabularyJson` give for its row, credits, vocabulary values and
 * authority sources. Four D1 reads and two R2 puts, whatever the size of
 * the catalogue.
 */
export async function exportInstitutionFiles(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant
): Promise<{ keys: string[] }> {
  const institution = await readFederationInstitution(db, tenant.federationId);
  const files = [
    [
      `${tenant.slug}/publisher.json`,
      buildPublisherJson(institution.publisher, institution.credits, institution.manifestBaseUrl),
    ],
    [
      `${tenant.slug}/vocabulary.json`,
      buildVocabularyJson(institution.values, institution.sources),
    ],
  ] as const;
  for (const [key, body] of files) await storage.putObject(key, JSON.stringify(body));
  return { keys: files.map(([key]) => key) };
}

/** Entities read and written per batch of entities.json. */
export const ENTITY_BATCH_SIZE = 1000;
/** Vocabulary term ids per query; 90 of D1's 100 bound parameters. */
const TERM_ID_CHUNK = 90;

/**
 * Which entities entities.json holds, after `afterId` (from the start
 * when null): the federation's entities, not merged into another,
 * linked to at least one published description of a member tenant. The
 * link is an EXISTS on `description_entities`, so each entity is read
 * once however many descriptions name it.
 */
function entityExportWhere(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant,
  tenantIds: string[],
  afterId: string | null
) {
  return and(
    // Authorities are federation-scoped (migrations 0045-0048); the export
    // reads the federation's member tenants' published descriptions joined
    // to the federation's entities. I4 guarantees each description's
    // tenant's federation equals the entity's federation. This is
    // `authorityScope` with a unary `+` on the federation term: with
    // it indexable and no planner statistics, the planner walks
    // `entity_code_idx` over the whole federation and sorts it for
    // every batch, where the primary key in `id` order stops at the
    // batch's LIMIT.
    sql`+${entities.federationId} = ${tenant.federationId}`,
    or(isNull(entities.tenantId), inArray(entities.tenantId, tenantIds)),
    isNull(entities.mergedInto),
    afterId === null ? undefined : gt(entities.id, afterId),
    exists(
      db
        .select({ one: sql`1` })
        .from(descriptionEntities)
        .innerJoin(descriptions, eq(descriptionEntities.descriptionId, descriptions.id))
        .where(
          and(
            eq(descriptionEntities.entityId, entities.id),
            inArray(descriptions.tenantId, tenantIds),
            eq(descriptions.isPublished, true)
          )
        )
    )
  );
}

/** The next `limit` entities of entities.json after `afterId`, in `id` order. */
export function entityBatchQuery(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant,
  tenantIds: string[],
  afterId: string | null,
  limit: number
) {
  return db
    .select(ENTITY_EXPORT_COLUMNS)
    .from(entities)
    .where(entityExportWhere(db, tenant, tenantIds, afterId))
    .orderBy(asc(entities.id))
    .limit(limit);
}

/**
 * The same entities as `entityBatchQuery`, with only each one's id and
 * `updated_at`, its version: the outline the finished file is checked
 * against.
 */
export function entityVersionQuery(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant,
  tenantIds: string[],
  afterId: string | null,
  limit: number
) {
  return db
    .select({ id: entities.id, updatedAt: entities.updatedAt })
    .from(entities)
    .where(entityExportWhere(db, tenant, tenantIds, afterId))
    .orderBy(asc(entities.id))
    .limit(limit);
}

/** Entity versions read per query when the finished file is checked. */
const ENTITY_VERSION_BATCH_SIZE = 5000;

/**
 * Thrown when the federation's exported entities changed while
 * entities.json was being written. The upload is aborted, the previous
 * file is left in place, and the Workflow runs the step again.
 */
export class EntitiesChangedDuringPublishError extends Error {
  constructor(detail: string) {
    super(`Entities changed during the publish (${detail}); entities.json was not replaced`);
    this.name = "EntitiesChangedDuringPublishError";
  }
}

/** The entity columns entities.json is formatted from. */
const ENTITY_EXPORT_COLUMNS = {
  id: entities.id,
  updatedAt: entities.updatedAt,
  entityCode: entities.entityCode,
  displayName: entities.displayName,
  sortName: entities.sortName,
  givenName: entities.givenName,
  surname: entities.surname,
  entityType: entities.entityType,
  honorific: entities.honorific,
  primaryFunction: entities.primaryFunction,
  primaryFunctionId: entities.primaryFunctionId,
  nameVariants: entities.nameVariants,
  datesOfExistence: entities.datesOfExistence,
  dateStart: entities.dateStart,
  dateEnd: entities.dateEnd,
  history: entities.history,
  // legal_status dropped in 0036 (0% populated); formatter emits null.
  sources: entities.sources,
  wikidataId: entities.wikidataId,
  viafId: entities.viafId,
  dbeId: entities.dbeId,
  gender: entities.gender,
  knownOnlyFromRelation: entities.knownOnlyFromRelation,
  qualifiedName: entities.qualifiedName,
  legacyIds: entities.legacyIds,
  mergedInto: entities.mergedInto,
};

/**
 * The `entity_functions` rows of the entities `entityIds` (a batch), in
 * entity order and, within an entity, in the order the rows were
 * entered (rowid), which names each grouped function
 * (`groupFunctions`). The ids go as one JSON parameter, read with
 * `json_each`, so a batch of 1,000 entities is one statement within
 * D1's 100 bound parameters, and each id is looked up in
 * `ef_entity_idx`: no row of another entity is read.
 */
export function entityFunctionsBatchQuery(db: DrizzleD1Database<any>, entityIds: string[]) {
  return db
    .select({ entityId: entityFunctions.entityId, function: entityFunctions.function })
    .from(entityFunctions)
    .where(sql`${entityFunctions.entityId} IN (SELECT value FROM json_each(${JSON.stringify(entityIds)}))`)
    .orderBy(asc(entityFunctions.entityId), sql`${entityFunctions}.rowid`);
}

/**
 * Export entities.json. Includes only entities linked to published
 * descriptions and not merged into another entity.
 *
 * The file is never held whole: 78,136 entities make about 42 MB of
 * JSON, which as one string and with the rows beside it passes the
 * 128 MB a Worker has once any of the text needs UTF-16 (V8 keeps a
 * string one byte per character only while every character is Latin-1).
 * Entities are read `ENTITY_BATCH_SIZE` at a time by keyset on `id`
 * (`entityBatchQuery`), formatted and written to a `JsonArrayUpload`,
 * within this one step: about 80 queries and a handful of multipart
 * parts. Records are written in `id` order. Each batch's functions are
 * read in one more query, by the batch's entity ids
 * (`entityFunctionsBatchQuery`), about 80 more.
 *
 * Vocabulary term canonical names are resolved per batch, in chunks of
 * `TERM_ID_CHUNK` ids, in a separate query to avoid the selectDistinct
 * + leftJoin chain incompatibility in D1's Drizzle adapter; the
 * retired codes and current codes of merged entities are read once.
 *
 * Each entity is written as its batch read it, so before the file is
 * completed the step reads the exported set's ids and `updated_at`
 * again (`entityVersionQuery`, 5,000 a query, about 16 more queries)
 * and the merged records, and compares them with what it wrote. On any
 * difference the upload is aborted, the previous file stays in place
 * and `EntitiesChangedDuringPublishError` is thrown, so the Workflow
 * runs the step again: no file holds one entity as it was before an
 * edit and another as it was after a later one. The check covers an
 * entity's functions too: every path that writes `entity_functions`
 * sets the owning entity's `updated_at` in the same batch or file
 * (`entity-functions.server.ts`).
 */
export async function exportEntities(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[],
  options: {
    batchSize?: number;
    partSize?: number;
    /** Test seam: awaited before batch `index` is read. */
    hooks?: { beforeBatch?: (index: number) => Promise<void> };
  } = {}
): Promise<{ count: number }> {
  // Federation publish (spec §9 step 8): the authority set is already
  // federation-scoped (migrations 0045-0048), but which entities EXPORT
  // is driven by which are linked to PUBLISHED DESCRIPTIONS. After the
  // step-6 partition those descriptions span multiple member tenants, so
  // a lead-only join would drop entities linked solely to AHR
  // descriptions. Read across every member tenant; single value →
  // pre-step-8 behaviour.
  const tenantIds = memberTenantIds ?? [tenant.id];
  const batchSize = options.batchSize ?? ENTITY_BATCH_SIZE;
  const key = `${tenant.slug}/entities.json`;

  const readMerged = async () =>
    (
      await db
        .select({
          id: entities.id,
          mergedInto: entities.mergedInto,
          code: entities.entityCode,
          legacyIds: entities.legacyIds,
        })
        .from(entities)
        .where(
          and(
            authorityScope(entities, tenant.federationId, tenantIds),
            isNotNull(entities.mergedInto)
          )
        )
        .orderBy(asc(entities.id))
        .all()
    ).map((r) => ({ ...r, mergedInto: r.mergedInto! }));

  await options.hooks?.beforeBatch?.(0);
  let batch = await entityBatchQuery(db, tenant, tenantIds, null, batchSize).all();
  if (batch.length === 0) {
    await storage.putObject(key, "[]");
    return { count: 0 };
  }

  // Retired site codes and current codes of records merged into an
  // exported one (see former-codes.server.ts). Merged records are few,
  // so one read.
  const merged = await readMerged();
  const inherited = mergedFormerCodes(merged);
  // The id and version of every entity written, in order.
  const written: Array<{ id: string; updatedAt: number }> = [];
  // The current codes of the entities read so far, and the codes written
  // as former codes: none may be both once the file is complete.
  const live = new Set<string>();
  const formerWritten = new Set<string>();

  const upload = JsonArrayUpload.start(storage, key, options.partSize ?? DEFAULT_PART_SIZE);
  try {
    for (let index = 1; ; index++) {
      const termIds = [...new Set(batch.map((r) => r.primaryFunctionId).filter(Boolean))] as string[];
      const termMap = new Map<string, string>();
      for (let i = 0; i < termIds.length; i += TERM_ID_CHUNK) {
        const terms = await db
          .select({ id: vocabularyTerms.id, canonical: vocabularyTerms.canonical })
          .from(vocabularyTerms)
          .where(inArray(vocabularyTerms.id, termIds.slice(i, i + TERM_ID_CHUNK)))
          .all();
        for (const t of terms) termMap.set(t.id, t.canonical);
      }
      // The batch's function rows, read by its entity ids.
      const functionsById = new Map<string, Array<{ function: string }>>(batch.map((r) => [r.id, []]));
      const functionRows = await entityFunctionsBatchQuery(db, batch.map((r) => r.id)).all();
      for (const f of functionRows) functionsById.get(f.entityId)?.push({ function: f.function });
      for (const row of batch) {
        written.push({ id: row.id, updatedAt: row.updatedAt });
        if (row.entityCode) live.add(row.entityCode);
      }
      await upload.writeRows(
        batch.map((row) => {
          const former = formerCodesFor(row.entityCode, row.legacyIds, inherited.get(row.id), live);
          for (const code of former) formerWritten.add(code);
          return formatEntity(
            {
              ...row,
              primaryFunctionCanonical: row.primaryFunctionId
                ? termMap.get(row.primaryFunctionId) ?? null
                : null,
              entityFunctions: functionsById.get(row.id),
            },
            former
          );
        })
      );
      if (batch.length < batchSize) break;
      await options.hooks?.beforeBatch?.(index);
      batch = await entityBatchQuery(db, tenant, tenantIds, batch[batch.length - 1].id, batchSize).all();
      if (batch.length === 0) break;
    }

    // Entities are written as each batch read them. Read the ids and
    // versions of the exported set again, and the merged records, and
    // refuse the file on any difference: an entity edited, merged,
    // newly linked or no longer linked while the file was written.
    let at = 0;
    for (let after: string | null = null; ; ) {
      const versions = await entityVersionQuery(db, tenant, tenantIds, after, ENTITY_VERSION_BATCH_SIZE).all();
      for (const v of versions) {
        const w = written[at++];
        if (!w || w.id !== v.id || w.updatedAt !== v.updatedAt) {
          throw new EntitiesChangedDuringPublishError(`entity ${v.id} was edited or linked after the publish began`);
        }
      }
      if (versions.length < ENTITY_VERSION_BATCH_SIZE) break;
      after = versions[versions.length - 1].id;
    }
    if (at !== written.length) {
      throw new EntitiesChangedDuringPublishError(`${written.length} exported entities became ${at}`);
    }
    if (JSON.stringify(await readMerged()) !== JSON.stringify(merged)) {
      throw new EntitiesChangedDuringPublishError("a merge changed the former codes an entity carries");
    }
    for (const code of formerWritten) {
      if (live.has(code)) {
        throw new EntitiesChangedDuringPublishError(`former code ${code} is the current code of an exported entity`);
      }
    }

    const { rowCount } = await upload.finish();
    return { count: rowCount };
  } catch (err) {
    // Nothing of this attempt is completed: abort what it sent, so the
    // previous file stays in place, including when completing the
    // upload is what failed. Best-effort; never throws.
    await abandonJsonArrayUpload(storage, upload.snapshot());
    throw err;
  }
}

/**
 * Export places.json. Includes only places linked to published descriptions
 * and not merged into another place.
 *
 * Same JOIN-based implementation as exportEntities — see the comment there
 * for the SQLITE_TOOBIG rationale.
 */
export async function exportPlaces(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[],
  options: {
    /** Test seam: awaited after the places are read, before the merged records. */
    hooks?: { beforeMergedRead?: () => Promise<void> };
  } = {}
): Promise<{ count: number }> {
  // Federation publish (spec §9 step 8): same rationale as exportEntities
  // — read across every member tenant's published descriptions so places
  // linked solely to AHR descriptions are not dropped. Single value →
  // pre-step-8 behaviour.
  const tenantIds = memberTenantIds ?? [tenant.id];
  const placeRows = await db
    .selectDistinct({
      id: places.id,
      placeCode: places.placeCode,
      label: places.label,
      displayName: places.displayName,
      placeType: places.placeType,
      // fclass: 5-value GeoNames feature class (added in 0036).
      fclass: places.fclass,
      nameVariants: places.nameVariants,
      latitude: places.latitude,
      longitude: places.longitude,
      coordinatePrecision: places.coordinatePrecision,
      // historical_*, country_code, admin_level_*, wikidata_id all
      // dropped in 0036 (0% populated); the formatter emits literal
      // null for these fields to keep the export shape stable.
      tgnId: places.tgnId,
      hgisId: places.hgisId,
      whgId: places.whgId,
      updatedAt: places.updatedAt,
      legacyIds: places.legacyIds,
      mergedInto: places.mergedInto,
    })
    .from(places)
    .innerJoin(
      descriptionPlaces,
      eq(descriptionPlaces.placeId, places.id)
    )
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id)
    )
    .where(
      and(
        // Federation-scoped authorities (migrations 0045-0048), joined to the
        // member tenants' published descriptions (I4 keeps the federations
        // aligned).
        authorityScope(places, tenant.federationId, tenantIds),
        inArray(descriptions.tenantId, tenantIds),
        eq(descriptions.isPublished, true),
        isNull(places.mergedInto)
      )
    )
    .all();

  if (placeRows.length === 0) {
    await storage.putObject(`${tenant.slug}/places.json`, "[]");
    return { count: 0 };
  }

  await options.hooks?.beforeMergedRead?.();
  // A place the file exports passes nothing on as merged, and no code
  // the file exports as current is written as a former code, whatever
  // was merged after the places were read.
  const exportedIds = new Set(placeRows.map((r) => r.id));
  const live = new Set(placeRows.map((r) => r.placeCode).filter((c): c is string => !!c));
  const inherited = mergedFormerCodes(
    (
      await db
        .select({
          id: places.id,
          mergedInto: places.mergedInto,
          code: places.placeCode,
          legacyIds: places.legacyIds,
        })
        .from(places)
        .where(
          and(
            authorityScope(places, tenant.federationId, tenantIds),
            isNotNull(places.mergedInto)
          )
        )
        .orderBy(asc(places.id))
        .all()
    )
      .filter((r) => !exportedIds.has(r.id))
      .map((r) => ({ ...r, mergedInto: r.mergedInto! }))
  );
  const formatted = placeRows.map((row) =>
    formatPlace(row, formerCodesFor(row.placeCode, row.legacyIds, inherited.get(row.id), live))
  );
  await storage.putObject(
    `${tenant.slug}/places.json`,
    JSON.stringify(formatted)
  );
  return { count: formatted.length };
}
/**
 * Heartbeat helpers — write the new export_runs columns from migration 0019
 * so the operator can watch a long publish run advance through its steps.
 *
 * Each also keeps the run's step log (`step_log`, migration 0117): a JSON
 * object of `{startedAt, completedAt}` per plan step id, so the progress
 * panel can show how long each step took. The log is written in the same
 * UPDATE as the heartbeat, merged with SQLite's `json_patch`, so it adds
 * no statement or subrequest to a step, and a step written again (a
 * retry, or a replay) changes its own entry and leaves the others as
 * they are. The entry is the plan step's (`planStepIdOf`): a link
 * file's steps share one, which only the first step starts (clearing
 * any end left by an earlier attempt) and only the finishing step ends.
 *
 * `steps_completed` counts the plan steps whose entry has an end, in the
 * same UPDATEs. An end adds one only when the entry has none yet, and a
 * start that clears an end takes one away, so a step that fails after
 * writing its end and is retried counts once, as does an end written
 * twice. Each condition reads the entry as it was before the UPDATE,
 * through `json_each`, so a step id is never spliced into a JSON path.
 */

/** A `json_patch` merge of one plan step's entry into the run's step log. */
function stepLogPatch(patch: Record<string, unknown>) {
  return sql`json_patch(coalesce(${exportRuns.stepLog}, '{}'), ${JSON.stringify(patch)})`;
}

/** 1 when the plan step's entry in the run's step log has an end, else 0. */
function stepEnded(planStepId: string) {
  return sql`coalesce((SELECT json_extract(value, '$.completedAt') IS NOT NULL FROM json_each(coalesce(${exportRuns.stepLog}, '{}')) WHERE key = ${planStepId}), 0)`;
}

/** True for a later step of a link file's plan step (`entity_links:2`). */
function isLaterBatch(stepName: string): boolean {
  const batch = /:(\d+)$/.exec(stepName);
  return batch !== null && planStepIdOf(stepName) !== stepName && Number(batch[1]) > 0;
}

export async function recordStepStart(
  db: DrizzleD1Database<any>,
  exportId: string,
  stepName: string
): Promise<void> {
  const now = Date.now();
  await db
    .update(exportRuns)
    .set({
      currentStep: stepName,
      currentStepStartedAt: now,
      currentStepCompletedAt: null,
      lastHeartbeatAt: now,
      // A null in a merge patch removes the key: a step started again
      // loses the end its earlier attempt wrote.
      ...(isLaterBatch(stepName)
        ? {}
        : {
            stepLog: stepLogPatch({ [planStepIdOf(stepName)]: { startedAt: now, completedAt: null } }),
            stepsCompleted: sql`${exportRuns.stepsCompleted} - ${stepEnded(planStepIdOf(stepName))}`,
          }),
    })
    .where(eq(exportRuns.id, exportId));
}

export async function recordStepEnd(
  db: DrizzleD1Database<any>,
  exportId: string,
  stepName: string,
  counts: Record<string, number | string[]>
): Promise<void> {
  const now = Date.now();
  const planStepId = planStepIdOf(stepName);
  await db
    .update(exportRuns)
    .set({
      currentStep: stepName,
      currentStepCompletedAt: now,
      lastHeartbeatAt: now,
      // Counted once: an end already in the log adds nothing.
      stepsCompleted: sql`${exportRuns.stepsCompleted} + 1 - ${stepEnded(planStepId)}`,
      recordCounts: JSON.stringify(counts),
      stepLog: stepLogPatch({ [planStepId]: { completedAt: now } }),
    })
    .where(eq(exportRuns.id, exportId));
}

// @version v0.9.0
