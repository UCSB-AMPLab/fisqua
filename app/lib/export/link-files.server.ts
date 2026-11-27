/**
 * Link-File Export
 *
 * This module deals with the two link files, `entity_links.json` and
 * `place_links.json`, which tie published descriptions to the entities
 * and places named in them. They are split out of `pipeline.server.ts`
 * because they are the one export that is not a single object per
 * Workflow step.
 *
 * At 60-110 MB each the files are written by `exportEntityLinks` /
 * `exportPlaceLinks` as a multipart upload that can span several
 * Workflow steps (see `json-array-upload.server.ts`). Each step walks one member tenant
 * after another, opens windows of published descriptions in
 * `reference_code` order by keyset (`reference_code > last`, never
 * OFFSET), and reads each window's links a bounded page at a time by
 * keyset on the full sort key, so no query returns more than a page of
 * links however they are distributed. A step stops after a set number
 * of links written or queries run and returns its cursor; the workflow
 * calls the function again with that state until it reports `done`.
 * Each link names an entity or place under the same predicates
 * `exportEntities` / `exportPlaces` apply, so no link points outside
 * entities.json or places.json.
 *
 * When a publish fails for good, `abandonLinkExports` takes the last
 * state each file's steps returned and removes what an unfinished
 * upload left in R2.
 *
 * Every step takes an explicit `tenant: ExportTenant` argument; each link
 * query filters by the member tenants' ids and every R2 key is prefixed
 * with `${tenant.slug}/`.
 *
 * An entity link also carries what the document records on it (the name
 * and honorific as written, the cataloguer's note, the sequence, the
 * link attributes) and, on a relation side, the other side and the
 * relation's certainty. Fisqua stores the other side as a link id; the
 * file names the other person by entity code instead, read in the same
 * query through a LEFT JOIN on the other link and its entity, and
 * writes null when that entity is one `exportEntities` would not export.
 * No link id reaches the file.
 *
 * @version v0.9.0
 */

import {
  asc,
  eq,
  and,
  gt,
  lte,
  isNull,
  isNotNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { authorityScope } from "../authority-ownership.server";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  descriptions,
  repositories,
  entities,
  places,
  descriptionEntities,
  descriptionPlaces,
} from "../../db/schema";
import type { ExportStorage } from "./r2-client.server";
import type { ExportTenant } from "./types";
import {
  JsonArrayUpload,
  DEFAULT_PART_SIZE,
  abandonJsonArrayUpload,
  type JsonArrayUploadState,
} from "./json-array-upload.server";

/** Descriptions per window: the reference-code range one link query scans. */
export const LINK_DESCRIPTION_PAGE_SIZE = 1000;
/** Link rows read per query; bounds Worker memory whatever the link distribution. */
export const LINK_PAGE_SIZE = 2000;
/** Links a link-file step writes before it hands over to the next step. */
export const LINK_ROWS_PER_STEP = 100_000;
/** D1 queries a link-file step runs before it hands over (D1 allows 1,000). */
export const LINK_QUERIES_PER_STEP = 250;

/**
 * Sort key of the last link written: reference code, entity or place
 * code, role, link id. The link query resumes strictly after it.
 */
export type LinkCursor = [string, string, string, string];

/**
 * Where a link-file export stands between Workflow steps. Plain JSON,
 * so it survives the step boundary.
 *
 * `tenantIndex` indexes the member tenant ids in sorted order. The
 * current window is the reference-code range `(windowAfterRef,
 * windowUpToRef]` of that tenant's published descriptions;
 * `windowUpToRef` null means no window is open. `windowIsLast` marks
 * the tenant's final window. `linkCursor` is the last link written
 * inside the open window.
 */
export interface LinkExportState {
  upload: JsonArrayUploadState;
  tenantIndex: number;
  windowAfterRef: string | null;
  windowUpToRef: string | null;
  windowIsLast: boolean;
  linkCursor: LinkCursor | null;
  done: boolean;
  count: number;
}

export interface LinkExportOptions {
  /** State returned by the previous step; omitted on the first call. */
  state?: LinkExportState;
  descriptionPageSize?: number;
  linkPageSize?: number;
  rowsPerStep?: number;
  queriesPerStep?: number;
  partSize?: number;
}

/**
 * One `entity_links.json` row: the fields zasqua.org reads today, in
 * their order, then what the link records and its relation.
 */
export interface ExportEntityLink {
  reference_code: string;
  title: string;
  date_expression: string;
  date_start: string | null;
  repository_code: string;
  entity_code: string;
  role: string;
  role_raw: string;
  name_as_recorded: string;
  honorific: string;
  role_note: string;
  sequence: number | null;
  /** Attribute key to the value as written; `{}` when the link has none. */
  attributes: Record<string, unknown>;
  /** The entity code of the other side's person, or null. Never a link id. */
  related_to: string | null;
  relation_certainty: string | null;
}

/**
 * Thrown when a link's stored `attributes` is not a JSON object. The
 * step fails rather than export the link without them.
 */
export class LinkAttributesInvalidError extends Error {
  constructor(linkId: string) {
    super(`Link ${linkId}: the stored attributes are not a JSON object`);
    this.name = "LinkAttributesInvalidError";
  }
}

/** A link's stored `attributes` as an object, or `LinkAttributesInvalidError`. */
export function linkAttributes(stored: string, linkId: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    throw new LinkAttributesInvalidError(linkId);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LinkAttributesInvalidError(linkId);
  }
  return value as Record<string, unknown>;
}

/** One `place_links.json` row, in the field order zasqua.org reads today. */
export interface ExportPlaceLink {
  reference_code: string;
  title: string;
  date_expression: string;
  date_start: string | null;
  repository_code: string;
  place_code: string;
  place_label: string;
  role: string;
}

/**
 * Reads at most `limit` links of one tenant's window, after `cursor`,
 * in sort-key order. Returns the formatted rows and the sort key of
 * the last one.
 */
type LinkPageReader = (
  tenantId: string,
  afterRef: string | null,
  upToRef: string,
  cursor: LinkCursor | null,
  limit: number
) => Promise<{ rows: unknown[]; last: LinkCursor | null }>;

/**
 * The cursor loop both link files share.
 *
 * For each member tenant it opens a window of up to
 * `descriptionPageSize` published descriptions (by `reference_code`
 * keyset) and reads that window's links `linkPageSize` at a time, by
 * keyset on the full sort key, so no query returns more than
 * `linkPageSize` rows however many links one description carries. The
 * window keeps each link query to an index range of descriptions
 * instead of re-sorting every link of the tenant.
 *
 * A step hands over once it has written `rowsPerStep` links or run
 * `queriesPerStep` queries, whichever comes first, so many empty
 * windows cannot exhaust the per-invocation query limit. At least one
 * query runs per call, so every step makes progress.
 */
async function exportLinkFile(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  key: string,
  tenantIds: string[],
  readLinks: LinkPageReader,
  options: LinkExportOptions
): Promise<LinkExportState> {
  const pageSize = options.descriptionPageSize ?? LINK_DESCRIPTION_PAGE_SIZE;
  const linkPageSize = options.linkPageSize ?? LINK_PAGE_SIZE;
  const rowsPerStep = options.rowsPerStep ?? LINK_ROWS_PER_STEP;
  const queriesPerStep = options.queriesPerStep ?? LINK_QUERIES_PER_STEP;
  const partSize = options.partSize ?? DEFAULT_PART_SIZE;
  const prior = options.state;
  if (prior?.done) return prior;

  const upload = prior
    ? await JsonArrayUpload.resume(storage, prior.upload, partSize)
    : JsonArrayUpload.start(storage, key, partSize);
  let tenantIndex = prior?.tenantIndex ?? 0;
  let windowAfterRef = prior?.windowAfterRef ?? null;
  let windowUpToRef = prior?.windowUpToRef ?? null;
  let windowIsLast = prior?.windowIsLast ?? false;
  let linkCursor = prior?.linkCursor ?? null;
  let writtenThisStep = 0;
  let queriesThisStep = 0;

  while (tenantIndex < tenantIds.length) {
    if (
      queriesThisStep > 0 &&
      (writtenThisStep >= rowsPerStep || queriesThisStep >= queriesPerStep)
    ) {
      return {
        upload: await upload.pause(),
        tenantIndex,
        windowAfterRef,
        windowUpToRef,
        windowIsLast,
        linkCursor,
        done: false,
        count: upload.rowCount,
      };
    }

    const tenantId = tenantIds[tenantIndex];

    if (windowUpToRef === null) {
      // Open the next window of descriptions.
      const page = await db
        .select({ referenceCode: descriptions.referenceCode })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenantId),
            eq(descriptions.isPublished, true),
            windowAfterRef === null
              ? undefined
              : gt(descriptions.referenceCode, windowAfterRef)
          )
        )
        .orderBy(asc(descriptions.referenceCode))
        .limit(pageSize)
        .all();
      queriesThisStep++;
      if (page.length === 0) {
        tenantIndex++;
        windowAfterRef = null;
        continue;
      }
      windowUpToRef = page[page.length - 1].referenceCode;
      windowIsLast = page.length < pageSize;
      linkCursor = null;
      continue;
    }

    const { rows, last } = await readLinks(
      tenantId,
      windowAfterRef,
      windowUpToRef,
      linkCursor,
      linkPageSize
    );
    queriesThisStep++;
    await upload.writeRows(rows);
    writtenThisStep += rows.length;

    if (rows.length === linkPageSize) {
      linkCursor = last;
      continue;
    }
    // Window exhausted: move past it.
    windowAfterRef = windowUpToRef;
    windowUpToRef = null;
    linkCursor = null;
    if (windowIsLast) {
      tenantIndex++;
      windowAfterRef = null;
      windowIsLast = false;
    }
  }

  const { rowCount } = await upload.finish();
  return {
    upload: { ...upload.snapshot(), rowCount },
    tenantIndex,
    windowAfterRef: null,
    windowUpToRef: null,
    windowIsLast: false,
    linkCursor: null,
    done: true,
    count: rowCount,
  };
}

/**
 * The predicates a link query shares: the tenant, published, the
 * window's reference-code range `(afterRef, upToRef]`, and strictly
 * after the cursor on the sort key `(reference_code, code, role, id)`.
 */
function linkPagePredicate(
  tenantId: string,
  afterRef: string | null,
  upToRef: string,
  sortKey: [SQLWrapper, SQLWrapper, SQLWrapper, SQLWrapper],
  cursor: LinkCursor | null
) {
  const [ref, code, role, linkId] = sortKey;
  return and(
    eq(descriptions.tenantId, tenantId),
    eq(descriptions.isPublished, true),
    afterRef === null ? undefined : gt(descriptions.referenceCode, afterRef),
    lte(descriptions.referenceCode, upToRef),
    cursor === null
      ? undefined
      : sql`(${ref}, ${code}, ${role}, ${linkId}) > (${cursor[0]}, ${cursor[1]}, ${cursor[2]}, ${cursor[3]})`
  );
}

/**
 * Export entity_links.json: one row per description-entity link whose
 * description is published in a member tenant and whose entity
 * `exportEntities` exports (federation scope, not merged). The entity
 * must also carry an `entity_code`, which the engine joins on.
 *
 * `role` is Fisqua's stored role verbatim (zasqua.org already carries
 * `fiador`, `apoderado`, `albacea`, ...), `role_raw` the source wording
 * or "" when none was recorded, `date_expression` "" when the
 * description has none: the shapes the retired backend wrote.
 * `name_as_recorded`, `honorific` and `role_note` follow the rule of
 * `role_raw`; `sequence` and `relation_certainty` are as stored;
 * `attributes` is the stored object parsed, and a value that is not an
 * object fails the step with the link's id.
 *
 * `related_to` is the entity code of the person on the link the stored
 * `related_to` names, read by a LEFT JOIN on that link's primary key and
 * then its entity's, with the entity predicates this query applies to
 * its own entity (and the same description) in the join condition: null
 * when the link is not a relation side, or when the other person is
 * merged, has no code or is outside the authority scope.
 *
 * Call once with no `state`, then again with each returned state until
 * `done` is true. Rows are ordered by member tenant id, then
 * reference_code, entity_code, role and link id.
 */
export async function exportEntityLinks(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[],
  options: LinkExportOptions = {}
): Promise<LinkExportState> {
  const tenantIds = [...(memberTenantIds ?? [tenant.id])].sort();
  // The other side of a relation and its person, under their own names.
  const relatedLink = alias(descriptionEntities, "related_link");
  const relatedEntity = alias(entities, "related_entity");
  const sortKey: [SQLWrapper, SQLWrapper, SQLWrapper, SQLWrapper] = [
    descriptions.referenceCode,
    entities.entityCode,
    descriptionEntities.role,
    descriptionEntities.id,
  ];
  const readLinks: LinkPageReader = async (tenantId, afterRef, upToRef, cursor, limit) => {
    const rows = await db
      .select({
        referenceCode: descriptions.referenceCode,
        title: descriptions.title,
        dateExpression: descriptions.dateExpression,
        dateStart: descriptions.dateStart,
        repositoryCode: repositories.code,
        entityCode: entities.entityCode,
        role: descriptionEntities.role,
        roleRaw: descriptionEntities.roleRaw,
        nameAsRecorded: descriptionEntities.nameAsRecorded,
        honorific: descriptionEntities.honorific,
        roleNote: descriptionEntities.roleNote,
        sequence: descriptionEntities.sequence,
        attributes: descriptionEntities.attributes,
        relatedTo: relatedEntity.entityCode,
        relationCertainty: descriptionEntities.relationCertainty,
        linkId: descriptionEntities.id,
      })
      .from(descriptionEntities)
      .innerJoin(descriptions, eq(descriptionEntities.descriptionId, descriptions.id))
      .innerJoin(entities, eq(descriptionEntities.entityId, entities.id))
      .leftJoin(repositories, eq(repositories.id, descriptions.repositoryId))
      // The other side of a relation, by primary key, and its person.
      .leftJoin(
        relatedLink,
        and(
          eq(relatedLink.id, descriptionEntities.relatedTo),
          eq(relatedLink.descriptionId, descriptionEntities.descriptionId)
        )
      )
      .leftJoin(
        relatedEntity,
        and(
          eq(relatedEntity.id, relatedLink.entityId),
          // Same entity predicates as exportEntities.
          // The alias has the table's columns under its own name;
          // `authorityScope` reads only those columns.
          authorityScope(relatedEntity as unknown as typeof entities, tenant.federationId, tenantIds),
          isNull(relatedEntity.mergedInto),
          isNotNull(relatedEntity.entityCode)
        )
      )
      .where(
        and(
          linkPagePredicate(tenantId, afterRef, upToRef, sortKey, cursor),
          // Same entity predicates as exportEntities.
          authorityScope(entities, tenant.federationId, tenantIds),
          isNull(entities.mergedInto),
          isNotNull(entities.entityCode)
        )
      )
      .orderBy(
        asc(descriptions.referenceCode),
        asc(entities.entityCode),
        asc(descriptionEntities.role),
        asc(descriptionEntities.id)
      )
      .limit(limit)
      .all();
    const tail = rows[rows.length - 1];
    return {
      rows: rows.map(
        (r): ExportEntityLink => ({
          reference_code: r.referenceCode,
          title: r.title,
          date_expression: r.dateExpression ?? "",
          date_start: r.dateStart ?? null,
          repository_code: r.repositoryCode ?? "",
          entity_code: r.entityCode as string,
          role: r.role,
          role_raw: r.roleRaw ?? "",
          name_as_recorded: r.nameAsRecorded ?? "",
          honorific: r.honorific ?? "",
          role_note: r.roleNote ?? "",
          sequence: r.sequence ?? null,
          attributes: linkAttributes(r.attributes, r.linkId),
          related_to: r.relatedTo ?? null,
          relation_certainty: r.relationCertainty ?? null,
        })
      ),
      last: tail
        ? [tail.referenceCode, tail.entityCode as string, tail.role, tail.linkId]
        : null,
    };
  };
  return exportLinkFile(
    db,
    storage,
    `${tenant.slug}/entity_links.json`,
    tenantIds,
    readLinks,
    options
  );
}

/**
 * Export place_links.json: one row per description-place link whose
 * description is published in a member tenant and whose place
 * `exportPlaces` exports (federation scope, not merged), with a
 * `place_code`. `place_label` is the place's `label`, the same value
 * places.json exports as `label`; `role` is the stored role verbatim.
 *
 * Driven like `exportEntityLinks`. Rows are ordered by member tenant
 * id, then reference_code, place_code, role and link id.
 */
export async function exportPlaceLinks(
  db: DrizzleD1Database<any>,
  storage: ExportStorage,
  tenant: ExportTenant,
  memberTenantIds?: string[],
  options: LinkExportOptions = {}
): Promise<LinkExportState> {
  const tenantIds = [...(memberTenantIds ?? [tenant.id])].sort();
  const sortKey: [SQLWrapper, SQLWrapper, SQLWrapper, SQLWrapper] = [
    descriptions.referenceCode,
    places.placeCode,
    descriptionPlaces.role,
    descriptionPlaces.id,
  ];
  const readLinks: LinkPageReader = async (tenantId, afterRef, upToRef, cursor, limit) => {
    const rows = await db
      .select({
        referenceCode: descriptions.referenceCode,
        title: descriptions.title,
        dateExpression: descriptions.dateExpression,
        dateStart: descriptions.dateStart,
        repositoryCode: repositories.code,
        placeCode: places.placeCode,
        placeLabel: places.label,
        role: descriptionPlaces.role,
        linkId: descriptionPlaces.id,
      })
      .from(descriptionPlaces)
      .innerJoin(descriptions, eq(descriptionPlaces.descriptionId, descriptions.id))
      .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
      .leftJoin(repositories, eq(repositories.id, descriptions.repositoryId))
      .where(
        and(
          linkPagePredicate(tenantId, afterRef, upToRef, sortKey, cursor),
          // Same place predicates as exportPlaces.
          authorityScope(places, tenant.federationId, tenantIds),
          isNull(places.mergedInto),
          isNotNull(places.placeCode)
        )
      )
      .orderBy(
        asc(descriptions.referenceCode),
        asc(places.placeCode),
        asc(descriptionPlaces.role),
        asc(descriptionPlaces.id)
      )
      .limit(limit)
      .all();
    const tail = rows[rows.length - 1];
    return {
      rows: rows.map(
        (r): ExportPlaceLink => ({
          reference_code: r.referenceCode,
          title: r.title,
          date_expression: r.dateExpression ?? "",
          date_start: r.dateStart ?? null,
          repository_code: r.repositoryCode ?? "",
          place_code: r.placeCode as string,
          place_label: r.placeLabel,
          role: r.role,
        })
      ),
      last: tail
        ? [tail.referenceCode, tail.placeCode as string, tail.role, tail.linkId]
        : null,
    };
  };
  return exportLinkFile(
    db,
    storage,
    `${tenant.slug}/place_links.json`,
    tenantIds,
    readLinks,
    options
  );
}

/**
 * Clean up after a publish that failed for good: for each link file
 * whose last returned state is not done, delete its staging objects
 * and abort its multipart upload. Files never started (no state) and
 * files already complete are left alone. Best-effort; never throws.
 */
export async function abandonLinkExports(
  storage: ExportStorage,
  states: Iterable<LinkExportState | undefined>
): Promise<void> {
  for (const state of states) {
    if (!state || state.done) continue;
    await abandonJsonArrayUpload(storage, state.upload);
  }
}

// @version v0.9.0
