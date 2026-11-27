/**
 * Scripts — what each export set reads, and the files it writes
 *
 * This module deals with what each export set reads, and the files it
 * writes. A set is a list of phases, read in order, and a build that turns
 * the rows the phases kept into CSV files. Each phase sends one kind of
 * statement, through `PacedReader` (`./reader.ts`), and is one of:
 *
 *   one     a single statement (the tenant, the federation, a fonds root);
 *   pages   keyset pages, `id > <last id> ORDER BY id LIMIT <size>`;
 *   chunks  a list of ids taken from earlier phases, 100 at a time in
 *           `IN (…)`, each chunk read whole or in keyset pages of 500.
 *
 * No statement joins, nests, counts or groups (`./select-guard.ts`):
 * joins and counts are made here, from the page files.
 *
 * The fonds is the description with that `reference_code` in the
 * tenant (`desc_ref_code_idx`); it must be a root, its
 * `root_description_id` either its own id (as the import writes it) or
 * NULL. Its descriptions are paged on `descriptions_tenant_root_id_idx`
 * (`tenant_id`, `root_description_id`, `id`), 200 a page, and the root is
 * added from its own row when the pages do not hold it.
 *
 *   descriptions  the fonds' descriptions in `reference_code` order, with
 *                 `changelog_rows`: the changelog rows of record type
 *                 `description` on each, read by `record_id IN (…)`
 *                 (`changelog_record_idx`) and counted here;
 *   entity-links  each link of a fonds description (`de_desc_idx`) to a
 *                 live entity (`merged_into IS NULL`), with the entity's
 *                 fields, in `reference_code` then link id order;
 *   place-links   the same for places (`dp_desc_idx`); `parent_place_name`
 *                 is the `display_name` of the place `parent_id` names,
 *                 read by id whatever its own state;
 *   pool          every live entity and place of the tenant's federation,
 *                 from `entities` and `places` paged whole by primary key,
 *                 500 a page, with no WHERE term but the keyset (a filter
 *                 there makes D1 read past the LIMIT to fill a page), the
 *                 federation and `merged_into` filtered here; `links_total` (all
 *                 the links to it, from `description_entities` and
 *                 `description_places` paged the same way) and `links_<x>` for each `--fonds`, `<x>` the last
 *                 hyphen-separated part of its code (`co-ahrb-aht` gives
 *                 `links_aht`), counting the links from that fonds'
 *                 descriptions; `link-counts-by-fonds.csv`, one row per
 *                 `--fonds`, counting links to the live authorities of the
 *                 pool; and `<federation slug>-primary-functions.csv`, the
 *                 live entities per non-empty `primary_function`, most
 *                 first, ties in descending order of the function.
 *
 * The columns are those of the 9 and 14 November 2026 files in
 * `ahrb-aht/sources/fisqua/`, and so are the line endings: CRLF for the
 * descriptions and the pool, LF for the link files. A NULL is an empty
 * field, a number is written as JavaScript writes it, and a field is
 * quoted only when it holds a comma, a quote or a line break.
 *
 * @version v0.9.0
 */

import { escapeSql } from "../sql";
import { fileShortName } from "./checkpoint";
import { ExportStop, type Row } from "./reader";

export type ExportSet = "descriptions" | "entity-links" | "place-links" | "pool";
export const SETS: readonly ExportSet[] = ["descriptions", "entity-links", "place-links", "pool"];

export const DESCRIPTIONS_PAGE = 200;
export const ID_CHUNK = 100;
export const LINK_PAGE = 500;
export const POOL_PAGE = 500;

export type Load = (phase: string) => Row[];

export type Step =
  | { kind: "one"; sql: string; missing: string }
  | { kind: "pages"; sql: (after: string) => string; size: number }
  | { kind: "chunks"; ids: string[]; sql: (ids: string[], after: string) => string; size: number | null };

export interface Phase {
  name: string;
  step: (load: Load) => Step;
  /** The part of each row kept in the page file, or null to drop it; the whole row by default. */
  keep?: (row: Row) => Row | null;
  /** As `keep`, with the rows of the phases before it. */
  keepWith?: (row: Row, load: Load) => Row | null;
}

export interface OutputFile {
  name: string;
  header: string[];
  rows: unknown[][];
  eol: "\r\n" | "\n";
}

export interface SetSpec {
  phases: Phase[];
  /** The files the set writes, named before anything is read. */
  fileNames: string[];
  build: (load: Load) => OutputFile[];
}

const q = escapeSql;
const list = (ids: string[]) => ids.map((id) => q(id)).join(", ");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** The last hyphen-separated part of a fonds' code: `co-ahrb-aht` gives `aht`. */
export const shortOf = (fonds: string) => fonds.slice(fonds.lastIndexOf("-") + 1);

/** The CSV file a single-fonds set writes: `<short>-<set>.csv` (`fileShortName` when the short form is not file-safe). */
const csvNameOf = (fonds: string, set: string) => {
  const suffix = `-${set}.csv`;
  return `${fileShortName(shortOf(fonds), suffix)}${suffix}`;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const DESCRIPTION_COLUMNS = [
  "id", "reference_code", "parent_id", "description_level", "title", "scope_content", "date_expression", "date_start",
  "date_end", "extent", "is_published", "has_digital", "iiif_manifest_url", "legacy_ids", "created_at", "updated_at",
];
export const DESCRIPTIONS_HEADER = [...DESCRIPTION_COLUMNS, "changelog_rows"];

const LINK_ENTITY_COLUMNS = [
  "id", "entity_code", "display_name", "sort_name", "surname", "given_name", "entity_type", "honorific", "primary_function",
  "name_variants", "dates_of_existence", "date_start", "date_end", "wikidata_id", "viaf_id", "dbe_id", "legacy_ids",
];
export const ENTITY_LINKS_HEADER = [
  "description_reference_code", "authority_id", "authority_code", "display_name", "sort_name", "surname", "given_name",
  "entity_type", "authority_honorific", "primary_function", "name_variants", "dates_of_existence", "date_start", "date_end",
  "wikidata_id", "viaf_id", "dbe_id", "legacy_ids", "role", "role_note", "role_raw", "sequence", "link_honorific",
  "link_function", "name_as_recorded", "link_id",
];

const LINK_PLACE_COLUMNS = [
  "id", "place_code", "display_name", "label", "place_type", "name_variants", "parent_id", "latitude", "longitude",
  "coordinate_precision", "tgn_id", "hgis_id", "whg_id", "fclass", "legacy_ids",
];
export const PLACE_LINKS_HEADER = [
  "description_reference_code", "authority_id", "authority_code", "display_name", "label", "place_type", "name_variants",
  "parent_id", "parent_place_name", "latitude", "longitude", "coordinate_precision", "tgn_id", "hgis_id", "whg_id", "fclass",
  "legacy_ids", "role", "role_note", "role_raw", "link_id",
];

const POOL_ENTITY_COLUMNS = [
  "id", "entity_code", "display_name", "sort_name", "surname", "given_name", "entity_type", "honorific", "primary_function",
  "name_variants", "dates_of_existence", "date_start", "date_end", "federation_id", "tenant_id",
];
const POOL_PLACE_COLUMNS = [
  "id", "place_code", "label", "display_name", "place_type", "name_variants", "latitude", "longitude", "federation_id",
];
export const LINK_COUNTS_HEADER = ["fonds_prefix", "entity_links", "distinct_entities", "place_links", "distinct_places"];
export const PRIMARY_FUNCTIONS_HEADER = ["primary_function", "entities"];

// ---------------------------------------------------------------------------
// Shared phases
// ---------------------------------------------------------------------------

const tenantPhase = (slug: string): Phase => ({
  name: "tenant",
  step: () => ({
    kind: "one",
    sql: `SELECT id, slug, federation_id FROM tenants WHERE slug = ${q(slug)}`,
    missing: `No tenant has the slug ${slug}`,
  }),
});
const tenantOf = (load: Load) => load("tenant")[0] as { id: string; slug: string; federation_id: string };

const rootPhase = (fonds: string, columns: string[]): Phase => ({
  name: `root:${fonds}`,
  step: (load) => ({
    kind: "one",
    sql: `SELECT ${[...columns, "root_description_id"].join(", ")} FROM descriptions WHERE tenant_id = ${q(tenantOf(load).id)} AND reference_code = ${q(fonds)}`,
    missing: `No description of the tenant has the reference code ${fonds}`,
  }),
});

/** The fonds root's row, refused when it is not a root. */
function rootOf(load: Load, fonds: string): Row {
  const root = load(`root:${fonds}`)[0];
  const rootId = root.root_description_id;
  if (rootId !== null && rootId !== undefined && rootId !== root.id) {
    throw new ExportStop(`${fonds} is not a fonds: its root_description_id is ${String(rootId)}, not its own id`);
  }
  return root;
}

const descriptionsPhase = (fonds: string, columns: string[]): Phase => ({
  name: `descriptions:${fonds}`,
  step: (load) => {
    const tenant = tenantOf(load).id;
    const root = rootOf(load, fonds);
    return {
      kind: "pages",
      size: DESCRIPTIONS_PAGE,
      sql: (after) =>
        `SELECT ${columns.join(", ")} FROM descriptions WHERE tenant_id = ${q(tenant)} AND root_description_id = ${q(root.id)} ` +
        `AND id > ${q(after)} ORDER BY id LIMIT ${DESCRIPTIONS_PAGE}`,
    };
  },
});

/** The fonds' descriptions, the root included, in id order. */
function fondsDescriptions(load: Load, fonds: string): Row[] {
  const byId = new Map<string, Row>();
  for (const r of load(`descriptions:${fonds}`)) byId.set(String(r.id), r);
  const root = rootOf(load, fonds);
  if (!byId.has(String(root.id))) {
    const { root_description_id: _omit, ...rest } = root;
    byId.set(String(root.id), rest);
  }
  return [...byId.values()].sort((a, b) => cmp(String(a.id), String(b.id)));
}
const fondsIds = (load: Load, fonds: string) => fondsDescriptions(load, fonds).map((r) => String(r.id));

const distinctSorted = (values: unknown[]) => [...new Set(values.filter((v) => v !== null && v !== undefined).map(String))].sort(cmp);

// ---------------------------------------------------------------------------
// The sets
// ---------------------------------------------------------------------------

function descriptionsSet(tenant: string, fonds: string): SetSpec {
  const name = csvNameOf(fonds, "descriptions");
  return {
    fileNames: [name],
    phases: [
      tenantPhase(tenant),
      rootPhase(fonds, DESCRIPTION_COLUMNS),
      descriptionsPhase(fonds, DESCRIPTION_COLUMNS),
      {
        name: "changelog",
        keep: (r) => ({ record_id: r.record_id }),
        step: (load) => ({
          kind: "chunks",
          ids: fondsIds(load, fonds),
          size: LINK_PAGE,
          sql: (ids, after) =>
            `SELECT id, record_id FROM changelog WHERE record_id IN (${list(ids)}) AND record_type = 'description' ` +
            `AND id > ${q(after)} ORDER BY id LIMIT ${LINK_PAGE}`,
        }),
      },
    ],
    build: (load) => {
      const counts = new Map<string, number>();
      for (const r of load("changelog")) counts.set(String(r.record_id), (counts.get(String(r.record_id)) ?? 0) + 1);
      const rows = fondsDescriptions(load, fonds).sort((a, b) => cmp(str(a.reference_code), str(b.reference_code)) || cmp(str(a.id), str(b.id)));
      return [{
        name,
        header: DESCRIPTIONS_HEADER,
        eol: "\r\n",
        rows: rows.map((r) => [...DESCRIPTION_COLUMNS.map((c) => r[c]), counts.get(String(r.id)) ?? 0]),
      }];
    },
  };
}

function entityLinksSet(tenant: string, fonds: string): SetSpec {
  const name = csvNameOf(fonds, "entity-links");
  return {
    fileNames: [name],
    phases: [
      tenantPhase(tenant),
      rootPhase(fonds, ["id", "reference_code"]),
      descriptionsPhase(fonds, ["id", "reference_code"]),
      {
        name: "links",
        step: (load) => ({
          kind: "chunks",
          ids: fondsIds(load, fonds),
          size: LINK_PAGE,
          sql: (ids, after) =>
            // The link's function is its `office` attribute (migration 0125).
            "SELECT id, description_id, entity_id, role, role_note, role_raw, sequence, honorific, " +
            "json_extract(attributes, '$.office') AS function, name_as_recorded " +
            `FROM description_entities WHERE description_id IN (${list(ids)}) AND id > ${q(after)} ORDER BY id LIMIT ${LINK_PAGE}`,
        }),
      },
      {
        name: "entities",
        step: (load) => ({
          kind: "chunks",
          ids: distinctSorted(load("links").map((r) => r.entity_id)),
          size: null,
          sql: (ids) => `SELECT ${LINK_ENTITY_COLUMNS.join(", ")} FROM entities WHERE id IN (${list(ids)}) AND merged_into IS NULL`,
        }),
      },
    ],
    build: (load) => {
      const codes = new Map(fondsDescriptions(load, fonds).map((r) => [String(r.id), str(r.reference_code)]));
      const entities = new Map(load("entities").map((r) => [String(r.id), r]));
      const rows: Array<{ code: string; id: string; cells: unknown[] }> = [];
      for (const l of load("links")) {
        const e = entities.get(String(l.entity_id));
        if (!e) continue;
        const code = codes.get(String(l.description_id)) ?? "";
        rows.push({
          code,
          id: String(l.id),
          cells: [
            code, e.id, e.entity_code, e.display_name, e.sort_name, e.surname, e.given_name, e.entity_type, e.honorific,
            e.primary_function, e.name_variants, e.dates_of_existence, e.date_start, e.date_end, e.wikidata_id, e.viaf_id,
            e.dbe_id, e.legacy_ids, l.role, l.role_note, l.role_raw, l.sequence, l.honorific, l.function, l.name_as_recorded, l.id,
          ],
        });
      }
      rows.sort((a, b) => cmp(a.code, b.code) || cmp(a.id, b.id));
      return [{ name, header: ENTITY_LINKS_HEADER, eol: "\n", rows: rows.map((r) => r.cells) }];
    },
  };
}

function placeLinksSet(tenant: string, fonds: string): SetSpec {
  const name = csvNameOf(fonds, "place-links");
  return {
    fileNames: [name],
    phases: [
      tenantPhase(tenant),
      rootPhase(fonds, ["id", "reference_code"]),
      descriptionsPhase(fonds, ["id", "reference_code"]),
      {
        name: "links",
        step: (load) => ({
          kind: "chunks",
          ids: fondsIds(load, fonds),
          size: LINK_PAGE,
          sql: (ids, after) =>
            "SELECT id, description_id, place_id, role, role_note, role_raw " +
            `FROM description_places WHERE description_id IN (${list(ids)}) AND id > ${q(after)} ORDER BY id LIMIT ${LINK_PAGE}`,
        }),
      },
      {
        name: "places",
        step: (load) => ({
          kind: "chunks",
          ids: distinctSorted(load("links").map((r) => r.place_id)),
          size: null,
          sql: (ids) => `SELECT ${LINK_PLACE_COLUMNS.join(", ")} FROM places WHERE id IN (${list(ids)}) AND merged_into IS NULL`,
        }),
      },
      {
        name: "parents",
        step: (load) => {
          const places = load("places");
          const have = new Set(places.map((r) => String(r.id)));
          return {
            kind: "chunks",
            ids: distinctSorted(places.map((r) => r.parent_id)).filter((id) => id !== "" && !have.has(id)),
            size: null,
            sql: (ids) => `SELECT id, display_name FROM places WHERE id IN (${list(ids)})`,
          };
        },
      },
    ],
    build: (load) => {
      const codes = new Map(fondsDescriptions(load, fonds).map((r) => [String(r.id), str(r.reference_code)]));
      const places = new Map(load("places").map((r) => [String(r.id), r]));
      const names = new Map<string, unknown>();
      for (const r of [...load("places"), ...load("parents")]) names.set(String(r.id), r.display_name);
      const rows: Array<{ code: string; id: string; cells: unknown[] }> = [];
      for (const l of load("links")) {
        const p = places.get(String(l.place_id));
        if (!p) continue;
        const code = codes.get(String(l.description_id)) ?? "";
        const parent = p.parent_id === null || p.parent_id === undefined || p.parent_id === "" ? null : names.get(String(p.parent_id));
        rows.push({
          code,
          id: String(l.id),
          cells: [
            code, p.id, p.place_code, p.display_name, p.label, p.place_type, p.name_variants, p.parent_id, parent, p.latitude,
            p.longitude, p.coordinate_precision, p.tgn_id, p.hgis_id, p.whg_id, p.fclass, p.legacy_ids, l.role, l.role_note,
            l.role_raw, l.id,
          ],
        });
      }
      rows.sort((a, b) => cmp(a.code, b.code) || cmp(a.id, b.id));
      return [{ name, header: PLACE_LINKS_HEADER, eol: "\n", rows: rows.map((r) => r.cells) }];
    },
  };
}

function poolSet(tenant: string, fondsList: string[]): SetSpec {
  const federationOf = (load: Load) => (load("federation")[0] ?? {}) as { id?: string; slug?: string | null };
  const functionsName = (load: Load) => `${federationOf(load).slug || "federation"}-primary-functions.csv`;
  const linkColumns = fondsList.map((f) => `links_${shortOf(f)}`);
  // A whole table is paged on its primary key alone: a WHERE term beside
  // the keyset would make D1 read past the LIMIT to fill a page.
  const pages = (name: string, table: string, columns: string[], keep: (r: Row, load: Load) => Row | null): Phase => ({
    name,
    step: () => ({
      kind: "pages",
      size: POOL_PAGE,
      sql: (after) => `SELECT ${columns.join(", ")} FROM ${table} WHERE id > ${q(after)} ORDER BY id LIMIT ${POOL_PAGE}`,
    }),
    keepWith: keep,
  });
  // The federation and the merge are filtered here, and merged_into is not kept.
  const liveInFederation = (columns: string[]) => (r: Row, load: Load): Row | null => {
    if (r.federation_id !== tenantOf(load).federation_id || (r.merged_into !== null && r.merged_into !== undefined)) return null;
    return Object.fromEntries(columns.map((c) => [c, r[c]]));
  };
  return {
    fileNames: ["federation-entities.csv", "federation-places.csv", "link-counts-by-fonds.csv", "<federation slug>-primary-functions.csv"],
    phases: [
      tenantPhase(tenant),
      {
        name: "federation",
        step: (load) => ({
          kind: "one",
          sql: `SELECT id, slug FROM federations WHERE id = ${q(tenantOf(load).federation_id)}`,
          missing: `The tenant ${tenant} names a federation that is not in federations`,
        }),
      },
      ...fondsList.flatMap((f) => [rootPhase(f, ["id"]), descriptionsPhase(f, ["id"])]),
      pages("entities", "entities", [...POOL_ENTITY_COLUMNS, "merged_into"], liveInFederation(POOL_ENTITY_COLUMNS)),
      pages("places", "places", [...POOL_PLACE_COLUMNS, "merged_into"], liveInFederation(POOL_PLACE_COLUMNS)),
      pages("entity-links", "description_entities", ["id", "description_id", "entity_id"], (r) => ({ d: r.description_id, a: r.entity_id })),
      pages("place-links", "description_places", ["id", "description_id", "place_id"], (r) => ({ d: r.description_id, a: r.place_id })),
    ],
    build: (load) => {
      const sets = fondsList.map((f) => new Set(fondsIds(load, f)));
      const byId = (rows: Row[]) => new Map([...rows].sort((a, b) => cmp(String(a.id), String(b.id))).map((r) => [String(r.id), r]));
      const entities = byId(load("entities"));
      const places = byId(load("places"));
      const tally = (links: Row[], live: Map<string, Row>) => {
        const total = new Map<string, number>();
        const perFonds = fondsList.map(() => new Map<string, number>());
        const fondsLinks = fondsList.map(() => 0);
        for (const l of links) {
          const a = String(l.a);
          if (!live.has(a)) continue;
          total.set(a, (total.get(a) ?? 0) + 1);
          sets.forEach((s, i) => {
            if (!s.has(String(l.d))) return;
            perFonds[i].set(a, (perFonds[i].get(a) ?? 0) + 1);
            fondsLinks[i]++;
          });
        }
        return { total, perFonds, fondsLinks };
      };
      const e = tally(load("entity-links"), entities);
      const p = tally(load("place-links"), places);
      const counted = (t: ReturnType<typeof tally>, id: string) => [t.total.get(id) ?? 0, ...t.perFonds.map((m) => m.get(id) ?? 0)];

      const functions = new Map<string, number>();
      for (const r of entities.values()) {
        const f = r.primary_function;
        if (f === null || f === undefined || f === "") continue;
        functions.set(String(f), (functions.get(String(f)) ?? 0) + 1);
      }
      const order = fondsList.map((f, i) => ({ f, i })).sort((a, b) => cmp(a.f, b.f));
      return [
        {
          name: "federation-entities.csv",
          header: [...POOL_ENTITY_COLUMNS, "links_total", ...linkColumns],
          eol: "\r\n",
          rows: [...entities.values()].map((r) => [...POOL_ENTITY_COLUMNS.map((c) => r[c]), ...counted(e, String(r.id))]),
        },
        {
          name: "federation-places.csv",
          header: [...POOL_PLACE_COLUMNS, "links_total", ...linkColumns],
          eol: "\r\n",
          rows: [...places.values()].map((r) => [...POOL_PLACE_COLUMNS.map((c) => r[c]), ...counted(p, String(r.id))]),
        },
        {
          name: "link-counts-by-fonds.csv",
          header: LINK_COUNTS_HEADER,
          eol: "\r\n",
          rows: order.map(({ f, i }) => [f, e.fondsLinks[i], e.perFonds[i].size, p.fondsLinks[i], p.perFonds[i].size]),
        },
        {
          name: functionsName(load),
          header: PRIMARY_FUNCTIONS_HEADER,
          eol: "\r\n",
          rows: [...functions.entries()].sort((a, b) => b[1] - a[1] || cmp(b[0], a[0])),
        },
      ];
    },
  };
}

/** The phases and the build of a set. */
export function setSpec(set: ExportSet, tenant: string, fonds: string[]): SetSpec {
  if (set === "descriptions") return descriptionsSet(tenant, fonds[0]);
  if (set === "entity-links") return entityLinksSet(tenant, fonds[0]);
  if (set === "place-links") return placeLinksSet(tenant, fonds[0]);
  return poolSet(tenant, fonds);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function cell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (typeof value === "boolean") s = value ? "1" : "0";
  else if (typeof value === "object") s = JSON.stringify(value);
  else s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvText(file: OutputFile): string {
  return [file.header, ...file.rows].map((r) => r.map(cell).join(",") + file.eol).join("");
}

// @version v0.9.0
