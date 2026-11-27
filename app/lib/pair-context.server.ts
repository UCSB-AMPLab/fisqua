/**
 * Pair context — what a reviewer needs to rule on a duplicate pair
 *
 * This module deals with the evidence the duplicate pair page shows
 * under its comparison table, for each of the two records: the
 * descriptions that name the record, the entities and places those
 * descriptions also name, and where the record came from.
 *
 * `loadPairContext` reads all of it for both records in ONE D1 batch of
 * six statements, whatever the size of either record; the statements
 * themselves come from `pairContextStatements`:
 *
 *   1. Descriptions — up to `DESCRIPTION_LIMIT` per record, oldest
 *      first by start date, with the role (or roles) the record holds in
 *      each, the roles it holds there as a relation side apart (entities
 *      only: a link naming, or named by, another link of the same
 *      description, so the page labels them from the relation roles),
 *      the name as the description records it (entities only),
 *      and the record's total of distinct descriptions, so the page can
 *      say how many more there are.
 *   2. Entities named in the same descriptions — up to
 *      `NEIGHBOUR_LIMIT` per record, most shared descriptions first.
 *   3. Places named in the same descriptions — the same shape.
 *   4. The creation journal entry, the first per record: who created it
 *      and when, and, when the entry carries a run id, the import run
 *      (its message, date and uploaded file).
 *   5. The pipeline's creation record (`resolve`), the first per record.
 *   6. The splits each record came out of, up to `SPLIT_LIMIT` per
 *      record, and how many records were merged into it (function-carry
 *      ledger rows are not merges, `notFunctionCarry`).
 *
 * Every per-record limit is a window over that record's own rows, so
 * one record's history never crowds out the other's. The ledger reads
 * look the records up by the ledger's endpoint indexes — `source_id`
 * for statement 5, `target_id` for statement 6 — and keep the planner
 * off the federation-wide index by writing the federation test as
 * `+ao.federation_id`, so their cost follows the two records' own rows,
 * not the size of the federation's ledger.
 *
 * Scope follows the page's. Descriptions, and the links read through
 * them, are the request tenant's only — a shared authority can be named
 * by several tenants' descriptions, and each sees its own. Every
 * authority named alongside, and the parent of a split, passes the same
 * `authorityScopeSql` visibility check as the pair itself, so a record
 * this tenant cannot open is never named. Import runs are the request
 * tenant's; a run of another tenant leaves only the bare fact of an
 * import. The ledger is read on the tenant's federation.
 *
 * The row's own `created_at` and `legacy_ids` arrive with the pair's
 * record read in the route, so they cost no statement here; the route
 * hands them in and they come back as part of the origin.
 *
 * The scans in statements 1 to 3 are proportional to the links the two
 * records carry in this tenant; their output is bounded by the limits
 * above. Each statement binds at most ten parameters, and statement 6
 * is the only compound SELECT, with two terms.
 *
 * @version v0.9.0
 */

import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { notFunctionCarry } from "./authority-operations.server";
import { authorityScopeSql } from "./authority-ownership.server";

const dialect = new SQLiteAsyncDialect();

/** Descriptions listed per record before the "and N more" link. */
export const DESCRIPTION_LIMIT = 10;
/** Entities, and places, listed per record as named alongside it. */
export const NEIGHBOUR_LIMIT = 8;
/** Splits listed per record in its origin. */
export const SPLIT_LIMIT = 5;

export type PairRecordKind = "entities" | "places";

export interface PairDescription {
  id: string;
  title: string;
  referenceCode: string;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  /** The role codes the record holds in this description, outside any relation. */
  roles: string[];
  /** The role codes it holds there as a relation side; entities only. */
  relationRoles: string[];
  /** The name as this description records it; entities only. */
  nameAsRecorded: string | null;
}

export interface PairNeighbour {
  id: string;
  name: string;
  code: string | null;
  /** Descriptions this neighbour shares with the record. */
  count: number;
}

export interface PairOrigin {
  /** The record row's own `created_at` (epoch ms). */
  createdAt: number;
  /** Identifiers the record carried in the systems it came from. */
  legacyIds: { provider: string; id: string }[];
  /** The creation journal entry, when one was written. */
  journal: {
    userName: string | null;
    note: string | null;
    createdAt: number;
    /** Set when the entry was written by an import run. */
    run: {
      visible: boolean;
      message: string | null;
      createdAt: number | null;
      filename: string | null;
    } | null;
  } | null;
  /** The entity pipeline's creation record, when the backfill wrote one. */
  pipeline: {
    createdAt: number;
    decisionSource: string | null;
    decisionRule: string | null;
    reasoning: string | null;
    mentionCount: number | null;
    pipelineEntityId: string | null;
  } | null;
  /** Splits this record came out of, oldest first. */
  splitFrom: {
    createdAt: number;
    userName: string | null;
    sourceId: string;
    /** Set when the parent is a record this tenant can see. */
    sourceName: string | null;
    sourceCode: string | null;
  }[];
  /** Records merged into this one, and the latest such merge. */
  absorbed: { count: number; latestAt: number } | null;
}

export interface PairRecordContext {
  descriptions: PairDescription[];
  /** Distinct descriptions in this tenant that name the record. */
  descriptionTotal: number;
  entities: PairNeighbour[];
  places: PairNeighbour[];
  origin: PairOrigin;
}

/** The record's own row facts the route already read. */
export interface PairRecordSeed {
  id: string;
  createdAt: number;
  legacyIds: string | null;
}

/** Parse the `legacy_ids` JSON column; anything malformed reads as none. */
export function parseLegacyIds(
  json: string | null,
): { provider: string; id: string }[] {
  try {
    const parsed = JSON.parse(json || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is { provider: string; id: string | number } =>
          e != null &&
          typeof e === "object" &&
          typeof e.provider === "string" &&
          (typeof e.id === "string" || typeof e.id === "number"),
      )
      .map((e) => ({ provider: e.provider, id: String(e.id) }));
  } catch {
    return [];
  }
}

function parseDetail(json: unknown): Record<string, unknown> {
  if (typeof json !== "string") return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** The link table, its record column, and the record table, per kind. */
const SHAPE = {
  entities: {
    link: "description_entities",
    col: "entity_id",
    table: "entities",
    code: "entity_code",
    sort: "sort_name",
    recordType: "entity",
  },
  places: {
    link: "description_places",
    col: "place_id",
    table: "places",
    code: "place_code",
    sort: "display_name",
    recordType: "place",
  },
} as const;

/**
 * The authorities of `other` kind named in the same descriptions as
 * each of the two records, most shared descriptions first. When the
 * two kinds are the same, the record itself is left out of its own
 * list.
 */
function neighbourStatement(
  self: PairRecordKind,
  other: PairRecordKind,
  ids: [string, string],
  tenantId: string,
  federationId: string,
): SQL {
  const s = SHAPE[self];
  const o = SHAPE[other];
  const raw = (x: string) => sql.raw(x);
  const notSelf: SQL =
    self === other ? sql`AND x.${raw(o.col)} <> s.${raw(s.col)}` : sql``;
  return sql`
    SELECT record_id, id, name, code, n FROM (
      SELECT s.${raw(s.col)} AS record_id,
             r.id AS id,
             r.display_name AS name,
             r.${raw(o.code)} AS code,
             COUNT(DISTINCT s.description_id) AS n,
             ROW_NUMBER() OVER (
               PARTITION BY s.${raw(s.col)}
               ORDER BY COUNT(DISTINCT s.description_id) DESC, r.${raw(o.sort)}, r.id
             ) AS rn
        FROM ${raw(s.link)} s
        JOIN descriptions d
          ON d.id = s.description_id AND d.tenant_id = ${tenantId}
        JOIN ${raw(o.link)} x
          ON x.description_id = s.description_id ${notSelf}
        JOIN ${raw(o.table)} r
          ON r.id = x.${raw(o.col)}
         AND ${authorityScopeSql("r", federationId, tenantId)}
       WHERE s.${raw(s.col)} IN (${ids[0]}, ${ids[1]})
       GROUP BY s.${raw(s.col)}, r.id
    )
    WHERE rn <= ${NEIGHBOUR_LIMIT}
    ORDER BY record_id, rn
  `;
}

/**
 * The six statements `loadPairContext` sends, in order. Exported so the
 * query plans can be checked; nothing else runs them.
 */
export function pairContextStatements(opts: {
  kind: PairRecordKind;
  tenantId: string;
  federationId: string;
  ids: [string, string];
}): SQL[] {
  const { kind, tenantId, federationId, ids } = opts;
  const s = SHAPE[kind];
  const raw = (x: string) => sql.raw(x);
  // Only entity links record the name as written in the description.
  const asRecorded =
    kind === "entities" ? sql`MAX(l.name_as_recorded)` : sql`NULL`;
  // Only an entity link can be a relation side: it names a link of its
  // own description, or a link of its description names it.
  const side =
    kind === "entities"
      ? sql`(EXISTS (SELECT 1 FROM description_entities n WHERE n.id = l.related_to AND n.description_id = l.description_id)
          OR EXISTS (SELECT 1 FROM description_entities n WHERE n.related_to = l.id AND n.description_id = l.description_id))`
      : sql`0`;

  return [
      sql`
        SELECT record_id, id, title, reference_code, date_expression,
               date_start, date_end, roles, relation_roles, name_as_recorded, total
          FROM (
            SELECT l.${raw(s.col)} AS record_id,
                   d.id AS id,
                   d.title AS title,
                   d.reference_code AS reference_code,
                   d.date_expression AS date_expression,
                   d.date_start AS date_start,
                   d.date_end AS date_end,
                   group_concat(DISTINCT CASE WHEN ${side} THEN NULL ELSE l.role END) AS roles,
                   group_concat(DISTINCT CASE WHEN ${side} THEN l.role END) AS relation_roles,
                   ${asRecorded} AS name_as_recorded,
                   ROW_NUMBER() OVER (
                     PARTITION BY l.${raw(s.col)}
                     ORDER BY d.date_start IS NULL, d.date_start, d.reference_code
                   ) AS rn,
                   COUNT(*) OVER (PARTITION BY l.${raw(s.col)}) AS total
              FROM ${raw(s.link)} l
              JOIN descriptions d ON d.id = l.description_id
             WHERE l.${raw(s.col)} IN (${ids[0]}, ${ids[1]})
               AND d.tenant_id = ${tenantId}
             GROUP BY l.${raw(s.col)}, d.id
          )
         WHERE rn <= ${DESCRIPTION_LIMIT}
         ORDER BY record_id, rn
      `,
      neighbourStatement(kind, "entities", ids, tenantId, federationId),
      neighbourStatement(kind, "places", ids, tenantId, federationId),
      sql`
        SELECT record_id, user_name, note, created_at, run_id, run_visible,
               run_message, run_created_at, filename
          FROM (
            SELECT c.record_id AS record_id,
                   u.name AS user_name,
                   c.note AS note,
                   c.created_at AS created_at,
                   c.run_id AS run_id,
                   r.id AS run_visible,
                   r.message AS run_message,
                   r.created_at AS run_created_at,
                   iu.filename AS filename,
                   ROW_NUMBER() OVER (
                     PARTITION BY c.record_id ORDER BY c.created_at, c.id
                   ) AS rn
              FROM changelog c
              LEFT JOIN users u ON u.id = c.user_id
              LEFT JOIN stewardship_runs r
                ON r.id = c.run_id AND r.tenant_id = ${tenantId}
              LEFT JOIN import_uploads iu
                ON iu.run_id = r.id AND iu.tenant_id = ${tenantId}
             WHERE c.record_id IN (${ids[0]}, ${ids[1]})
               AND c.record_type = ${s.recordType}
               AND c.kind = 'create'
          )
         WHERE rn = 1
      `,
      sql`
        SELECT source_id, detail, created_at FROM (
          SELECT ao.source_id AS source_id,
                 ao.detail AS detail,
                 ao.created_at AS created_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY ao.source_id ORDER BY ao.created_at, ao.id
                 ) AS rn
            FROM authority_operations ao
           WHERE ao.source_id IN (${ids[0]}, ${ids[1]})
             AND +ao.federation_id = ${federationId}
             AND ao.record_type = ${s.recordType}
             AND ao.operation = 'resolve'
        )
        WHERE rn = 1
      `,
      sql`
        SELECT * FROM (
          SELECT 'split' AS operation,
                 ao.source_id AS source_id,
                 ao.target_id AS target_id,
                 ao.created_at AS created_at,
                 u.name AS user_name,
                 p.display_name AS source_name,
                 p.${raw(s.code)} AS source_code,
                 NULL AS n,
                 ROW_NUMBER() OVER (
                   PARTITION BY ao.target_id ORDER BY ao.created_at, ao.id
                 ) AS rn
            FROM authority_operations ao
            LEFT JOIN users u ON u.id = ao.user_id
            LEFT JOIN ${raw(s.table)} p
              ON p.id = ao.source_id
             AND ${authorityScopeSql("p", federationId, tenantId)}
           WHERE ao.target_id IN (${ids[0]}, ${ids[1]})
             AND +ao.federation_id = ${federationId}
             AND ao.record_type = ${s.recordType}
             AND ao.operation = 'split'
        )
        WHERE rn <= ${SPLIT_LIMIT}
        UNION ALL
        SELECT 'merge', NULL, ao.target_id, MAX(ao.created_at),
               NULL, NULL, NULL, COUNT(*), NULL
          FROM authority_operations ao
         WHERE ao.target_id IN (${ids[0]}, ${ids[1]})
           AND +ao.federation_id = ${federationId}
           AND ao.record_type = ${s.recordType}
           AND ao.operation = 'merge'
           AND ${notFunctionCarry(sql.raw("ao.detail"))}
         GROUP BY ao.target_id
      `,
  ];
}

/**
 * Read the context for both records of a pair in one batch.
 *
 * `seeds` carries each record's id with the row facts the route has
 * already read (`created_at`, `legacy_ids`). The result is keyed by
 * record id and holds an entry for every seed, empty where nothing is
 * recorded.
 */
export async function loadPairContext(
  db: DrizzleD1Database<any>,
  opts: {
    kind: PairRecordKind;
    tenantId: string;
    federationId: string;
    seeds: [PairRecordSeed, PairRecordSeed];
  },
): Promise<Record<string, PairRecordContext>> {
  const { kind, tenantId, federationId, seeds } = opts;
  const ids: [string, string] = [seeds[0].id, seeds[1].id];
  const statements = pairContextStatements({
    kind,
    tenantId,
    federationId,
    ids,
  });

  // Built here and sent as one D1 batch: Drizzle's own batch cannot
  // carry raw SQL statements.
  const d1 = (db as unknown as { $client: D1Database }).$client;
  const prepared = statements.map((statement) => {
    const query = dialect.sqlToQuery(statement);
    return d1.prepare(query.sql).bind(...query.params);
  });
  const [
    descRows,
    entityRows,
    placeRows,
    journalRows,
    resolveRows,
    targetRows,
  ] = (
    await d1.batch<Record<string, unknown>>(prepared)
  ).map((result) => result.results ?? []);

  const out: Record<string, PairRecordContext> = {};
  for (const seed of seeds) {
    out[seed.id] = {
      descriptions: [],
      descriptionTotal: 0,
      entities: [],
      places: [],
      origin: {
        createdAt: seed.createdAt,
        legacyIds: parseLegacyIds(seed.legacyIds),
        journal: null,
        pipeline: null,
        splitFrom: [],
        absorbed: null,
      },
    };
  }

  for (const r of descRows) {
    const ctx = out[r.record_id as string];
    if (!ctx) continue;
    ctx.descriptionTotal = Number(r.total);
    ctx.descriptions.push({
      id: r.id as string,
      title: r.title as string,
      referenceCode: r.reference_code as string,
      dateExpression: str(r.date_expression),
      dateStart: str(r.date_start),
      dateEnd: str(r.date_end),
      roles: String(r.roles ?? "")
        .split(",")
        .filter(Boolean)
        .sort(),
      relationRoles: String(r.relation_roles ?? "")
        .split(",")
        .filter(Boolean)
        .sort(),
      nameAsRecorded: str(r.name_as_recorded),
    });
  }

  const neighbours = (
    rows: Record<string, unknown>[],
    key: "entities" | "places",
  ) => {
    for (const r of rows) {
      const ctx = out[r.record_id as string];
      if (!ctx) continue;
      ctx[key].push({
        id: r.id as string,
        name: r.name as string,
        code: str(r.code),
        count: Number(r.n),
      });
    }
  };
  neighbours(entityRows, "entities");
  neighbours(placeRows, "places");

  // Statement 4 returns only each record's first creation entry, which
  // is the record's creation.
  for (const r of journalRows) {
    const ctx = out[r.record_id as string];
    if (!ctx) continue;
    ctx.origin.journal = {
      userName: str(r.user_name),
      note: str(r.note),
      createdAt: Number(r.created_at),
      run: r.run_id
        ? {
            visible: r.run_visible != null,
            message: str(r.run_message),
            createdAt: r.run_created_at == null ? null : Number(r.run_created_at),
            filename: str(r.filename),
          }
        : null,
    };
  }

  for (const r of resolveRows) {
    const ctx = out[r.source_id as string];
    if (!ctx) continue;
    const d = parseDetail(r.detail);
    ctx.origin.pipeline = {
      createdAt: Number(r.created_at),
      decisionSource: str(d.decisionSource),
      decisionRule: str(d.decisionRule),
      reasoning: str(d.reasoning),
      mentionCount: typeof d.mentionCount === "number" ? d.mentionCount : null,
      pipelineEntityId: str(d.pipelineEntityId),
    };
  }

  for (const r of targetRows) {
    const ctx = out[r.target_id as string];
    if (!ctx) continue;
    if (r.operation === "split") {
      ctx.origin.splitFrom.push({
        createdAt: Number(r.created_at),
        userName: str(r.user_name),
        sourceId: r.source_id as string,
        sourceName: str(r.source_name),
        sourceCode: str(r.source_code),
      });
    } else if (r.operation === "merge") {
      ctx.origin.absorbed = {
        count: Number(r.n),
        latestAt: Number(r.created_at),
      };
    }
  }
  // A compound SELECT promises no order across its terms.
  for (const ctx of Object.values(out)) {
    ctx.origin.splitFrom.sort((x, y) => x.createdAt - y.createdAt);
  }

  return out;
}

/* @version v0.9.0 */
