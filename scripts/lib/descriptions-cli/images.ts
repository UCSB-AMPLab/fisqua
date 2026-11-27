/**
 * Scripts — images, former codes and deletes in the command line's descriptions
 *
 * This module deals with three operations of the descriptions change
 * file (`./change-file.ts`): `set-images`, `add-former-code` and
 * `delete-description`. `readOpsState` reads what they need beyond the
 * descriptions `./plan.ts` reads; `planOps` plans their rows against it,
 * called from `planDescriptions` once the field updates and the creates
 * are planned; `uploadManifests` puts the manifests the plan builds in
 * the federation's bucket, during an apply, before the SQL file is
 * applied, once the tenant's federation, its `manifest_base_url` and its
 * `manifest_bucket` read again as the plan read them (`placeCheck`, which
 * the SQL file also holds them to). `./statements.ts` writes the rest.
 * Every row is refused in the order of the file's lines, and any refusal
 * stops the run before anything is uploaded or written.
 *
 * ## set-images
 *
 * The description is one the tenant holds or one a `create-description`
 * row of the file creates, named by `reference_code`; a description is
 * given images by one row only. Its manifest is built as
 * `./manifests.ts` builds it, from the record's fields as the file leaves
 * them (an `update-field` row's new value, or the create's values), at
 * the federation's address `{manifest_base_url}/iiif/{reference_code}/
 * manifest.json`. The row is refused when:
 *   - `n_images`, `first_image` or `last_image` disagrees with `images`,
 *     a file is named twice or is not `<volume>-img_NNNN.<ext>`, or no
 *     source is given;
 *   - a source is not an absolute URL, cannot be fetched, or its `id` is
 *     not its own address; a file is in no source; one number is shown
 *     by two canvases of a source or by different images in two sources;
 *     two file names name one canvas;
 *   - the repository has no manifest rights, or is not found;
 *   - the record already points at another manifest;
 *   - the record points at its own address and the address does not
 *     hold the manifest built (an upload there would change a manifest a
 *     record names, before the SQL file is applied);
 *   - the address holds any manifest other than the one built, whoever
 *     names it: the address follows from the reference code, so no
 *     manifest is ever overwritten;
 *   - the address answers anything but 404 or a 200 with JSON;
 *   - an `update-field` row of the file changes `iiif_manifest_url` or
 *     `repository_id` on the record (the manifest's statements come from
 *     the repository as read), or the create gives an address, or the
 *     file deletes the record.
 * The record takes the address and the digital flag. An address that
 * holds the manifest built is not uploaded to; one that holds nothing
 * is, once it reads as holding nothing again just before the put.
 *
 * Done, same, to write. A record that already names its own address,
 * with the digital flag and the manifest built at the address, writes
 * nothing: the row is "already updated" when this file's changelog row
 * for the record (its update row, or the create row of a record it
 * created) records the address or the flag, and "same" otherwise; a
 * changelog row of this file that records another address or flag
 * refuses the row.
 *
 * ## add-former-code
 *
 * The description is one the tenant holds. `former_code` is appended to
 * its `legacy_ids` under `former-reference-code`, the text read kept as
 * it is. The row is refused when the code is blank, is the record's own
 * code, is named twice for the record, is created by the file, or is the
 * reference code of another description of the federation that the file
 * does not delete; when `legacy_ids` is not a JSON list; when another
 * row of the file gives the same code to another record; or when the
 * file deletes the record. A code the record already records is checked
 * as one the file adds. The SQL file holds, when it is applied, that no
 * description of the tenant's federation as it is then, but one the file
 * deletes, has a code of the file's rows as its reference code. A code
 * the record already records writes
 * nothing: it is "same" without this file's changelog row, or when that
 * row's old and new `legacy_ids` both record it, and "already updated"
 * when only the new one does; a row whose new `legacy_ids` lacks it
 * refuses the row.
 *
 * ## delete-description
 *
 * The description is one the tenant holds, deleted as the description
 * editor's delete deletes it: the record and, by the schema's cascade,
 * its links; the parent's child count down one and its version moved;
 * the descriptions recording the code as a former one moved
 * (`formerCodeHoldersFollow`). One changelog row of kind `delete` records
 * every value the record held (`deleteSnapshotDiff`), under an id made
 * from the tenant, the file's name and the code
 * (`descriptionDeleteJournalId`). The row is refused when:
 *   - the record has children, counted by `child_count` or by the
 *     descriptions whose `parent_id` it is, or the file creates one under
 *     it (the SQL file holds, when it is applied, that no description has
 *     it as parent);
 *   - a pipeline volume, recipe declaration or entry names it;
 *   - `merged_into` is blank, is the record itself, is not a description
 *     of the tenant, or is deleted by the file;
 *   - the survivor does not record the code as a former one, already or
 *     by an `add-former-code` row of the file;
 *   - another row of the file writes the record, or names it as a
 *     parent or an `after`.
 * A code no description of the tenant holds is "already deleted" when
 * this file's delete changelog row exists and records that code; without
 * it, the row is refused. A code a description holds while this file's
 * delete changelog row for it exists is refused.
 *
 * ## Reads
 *
 * `readOpsState` reads: the federation's manifest address and bucket
 * (`readPlace`; a file with a `set-images` row stops when they are
 * missing); the repositories of the records given images, with the
 * columns a manifest's statements are made from; every source manifest
 * the file names and every address it would give, each fetched once
 * (an address with a query that differs at every run, so no cache
 * answers for it); the descriptions of the federation holding a former
 * code as their reference code; for every description to delete, every
 * column, the pipeline records that name it, its entity and place links,
 * and this file's delete changelog rows.
 *
 * @version v0.9.0
 */

import { getTableColumns } from "drizzle-orm";
import { descriptions } from "../../../app/db/schema";
import { FORMER_REFERENCE_PROVIDER, legacyIdsOf } from "../../../app/lib/export/former-codes.server";
import { manifestUrl, type ManifestDescription } from "../../../app/lib/pipeline/manifest-inputs";
import { manifestObjectPath } from "../../../app/lib/promote/manifest-builder";
import { deleteSnapshotDiff } from "../../../app/lib/stewardship.server";
import { newRecordId, type RowReader } from "../authority-links";
import { chunks, idList, storedValue, typed } from "../authority-merges";
import { escapeSql } from "../sql";
import { changedSince, foreignColumns, opOf, type DescriptionChangeRow, type Op } from "./change-file";
import {
  buildManifest,
  imagesOf,
  imagesProblem,
  legacyIsArray,
  manifestBody,
  parseManifest,
  readPlace,
  REPOSITORY_READ,
  sameJson,
  appendFormerCodes,
  type Fetched,
  type Json,
  type Place,
} from "./manifests";
import type { CreatePlan, DescriptionsState, Journaled, RowPlan, StoredDescription } from "./plan";
import { appendAll } from "../arrays";

/** The namespace of the ids of the delete changelog rows a file writes. */
export const DELETE_JOURNAL_ID_NAMESPACE = "description-delete-journal";

/** The id of the `delete` changelog row a file writes for the description it deletes under a code. */
export function descriptionDeleteJournalId(tenantId: string, file: string, code: string): Promise<string> {
  return newRecordId("", tenantId, file, code, DELETE_JOURNAL_ID_NAMESPACE);
}

/** Every column of `descriptions`: what a delete reads, guards and records. */
export const FULL_READ: readonly string[] = Object.values(getTableColumns(descriptions) as Record<string, { name: string }>).map((c) => c.name);
const COLUMN_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(getTableColumns(descriptions) as Record<string, { name: string }>).map(([key, c]) => [c.name, key]),
);

export const IMAGE_OPS: readonly Op[] = ["set-images", "add-former-code", "delete-description"];

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const blank = (v: unknown) => v === null || v === undefined || v === "";
const truthy = (v: unknown) => v === 1 || v === "1" || v === true || v === "true";

/** GETs an address: its status and, for a 200, its body as text. */
export type FetchManifest = (url: string) => Promise<Fetched>;

export interface OpsState {
  /** The federation's manifest address and bucket; null when the file has no set-images row. */
  place: Place | null;
  federationId: string;
  /** The repositories of the records given images, by id. */
  repositories: Map<string, Record<string, unknown>>;
  /** Every source manifest the file names, by the address as written. */
  sources: Map<string, Fetched>;
  /** Every address the file gives, by the address. */
  destinations: Map<string, Fetched>;
  /** Descriptions of the federation holding a former code the file adds, as their reference code, by that code. */
  formerHolders: Map<string, Array<{ id: string; code: string; tenantId: string }>>;
  /** For each description to delete: every column, as read. */
  full: Map<string, StoredDescription>;
  /** The pipeline records naming each description to delete. */
  pipelineNames: Map<string, number>;
  /** The descriptions whose parent is each description to delete, counted, whatever its child count says. */
  children: Map<string, number>;
  links: Map<string, { entities: number; places: number }>;
  /** For each code a row deletes: the id of this file's delete changelog row. */
  deleteJournalIds: Map<string, string>;
}

const isOp = (op: Op) => (r: DescriptionChangeRow) => opOf(r.cells) === op;

async function readIn(rows: RowReader, values: string[], query: (part: string) => string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of chunks([...new Set(values)].filter(Boolean), 100)) if (part.length > 0) appendAll(out, await rows(query(idList(part))));
  return out;
}

/** Fetches every address once, a few at a time. */
async function fetchAll(urls: string[], fetchManifest: FetchManifest, bust: string | null): Promise<Map<string, Fetched>> {
  const out = new Map<string, Fetched>();
  const queue = [...new Set(urls)];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const at = bust === null ? url : `${url}?v=${encodeURIComponent(bust)}`;
      out.set(url, await fetchManifest(at).catch((err: Error) => ({ status: 0, error: err.message })));
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return out;
}

/** The codes of the rows of these operations whose descriptions `./plan.ts` reads: the rows' own and the survivors. */
export function opCodes(rows: DescriptionChangeRow[]): string[] {
  return rows.filter((r) => IMAGE_OPS.includes(opOf(r.cells) as Op)).flatMap((r) => [r.cells.reference_code, r.cells.merged_into]);
}

/** What the operations of this module need, besides the descriptions `./plan.ts` reads. */
export async function readOpsState(
  rows: RowReader,
  input: { file: string; rows: DescriptionChangeRow[] },
  state: Pick<DescriptionsState, "tenantId" | "byCode" | "byId" | "createIds">,
  options: { fetchManifest?: FetchManifest; bust: string | null },
  stop: (message: string) => Error,
): Promise<OpsState> {
  const T = escapeSql(state.tenantId);
  const images = input.rows.filter(isOp("set-images"));
  const formers = input.rows.filter(isOp("add-former-code"));
  const deletes = input.rows.filter(isOp("delete-description"));
  const [t] = await rows(`SELECT federation_id FROM tenants WHERE id = ${T}`);
  const federationId = text(t?.federation_id);

  let place: Place | null = null;
  const repositories = new Map<string, Record<string, unknown>>();
  let sources = new Map<string, Fetched>();
  let destinations = new Map<string, Fetched>();
  if (images.length > 0) {
    place = await readPlace(rows, state.tenantId);
    if (!place) throw stop("The tenant's federation has no manifest_base_url or manifest_bucket");
    if (!options.fetchManifest) throw stop("A file with set-images rows needs a way to fetch manifests");
    // The repository of each record given images: its own, or the parent's for a record the file creates.
    const parentOf = new Map(input.rows.filter(isOp("create-description")).map((r) => [r.cells.reference_code, r.cells.parent_code]));
    const repositoryOf = (code: string, seen = new Set<string>()): string => {
      const d = state.byCode.get(code);
      if (d) return text(d.repository_id);
      const parent = parentOf.get(code);
      if (!parent || seen.has(code)) return "";
      seen.add(code);
      return repositoryOf(parent, seen);
    };
    const repoIds = images.map((r) => repositoryOf(r.cells.reference_code));
    for (const r of await readIn(rows, repoIds, (p) => `SELECT ${typed(REPOSITORY_READ)} FROM repositories WHERE tenant_id = ${T} AND id IN (${p})`)) {
      const repo = Object.fromEntries(REPOSITORY_READ.map((c) => [c, storedValue(r, c)]));
      repositories.set(text(repo.id), repo);
    }
    sources = await fetchAll(images.flatMap((r) => imagesOf(r.cells).sources), options.fetchManifest, null);
    destinations = await fetchAll(
      images.filter((r) => r.cells.reference_code).map((r) => manifestUrl(place!.baseUrl, r.cells.reference_code)),
      options.fetchManifest,
      options.bust,
    );
  }

  const formerHolders = new Map<string, Array<{ id: string; code: string; tenantId: string }>>();
  for (const h of await readIn(rows, formers.map((r) => r.cells.former_code), (p) =>
    `SELECT id, reference_code, tenant_id FROM descriptions WHERE reference_code IN (${p}) ` +
      `AND tenant_id IN (SELECT id FROM tenants WHERE federation_id = ${escapeSql(federationId)})`,
  )) {
    const code = text(h.reference_code);
    formerHolders.set(code, [...(formerHolders.get(code) ?? []), { id: text(h.id), code, tenantId: text(h.tenant_id) }]);
  }

  // Every column of each description to delete, read in groups within D1's result-column limit.
  const deleteIds = deletes.map((r) => state.byCode.get(r.cells.reference_code)).filter((d): d is StoredDescription => !!d).map((d) => text(d.id));
  const joined = new Map<string, Record<string, unknown>>();
  const perGroup = 49;
  const rest = FULL_READ.filter((c) => c !== "id");
  for (let i = 0; i < rest.length; i += perGroup) {
    const group = ["id", ...rest.slice(i, i + perGroup)];
    for (const r of await readIn(rows, deleteIds, (p) => `SELECT ${typed(group)} FROM descriptions WHERE tenant_id = ${T} AND id IN (${p})`)) {
      joined.set(text(r.id), { ...(joined.get(text(r.id)) ?? {}), ...r });
    }
  }
  const full = new Map<string, StoredDescription>();
  for (const [id, r] of joined) full.set(id, Object.fromEntries(FULL_READ.map((c) => [c, storedValue(r, c)])));

  const counted = async (q: (p: string) => string) => {
    const out = new Map<string, number>();
    for (const r of await readIn(rows, deleteIds, q)) out.set(text(r.id), Number(r.n));
    return out;
  };
  const children = await counted((p) => `SELECT parent_id AS id, COUNT(*) AS n FROM descriptions WHERE parent_id IN (${p}) GROUP BY parent_id`);
  const pipelineNames = await counted(
    (p) =>
      `SELECT id, SUM(n) AS n FROM (
         SELECT description_id AS id, COUNT(*) AS n FROM pipeline_volumes WHERE description_id IN (${p}) GROUP BY description_id
         UNION ALL SELECT recipe_scope_description_id, COUNT(*) FROM pipeline_volumes WHERE recipe_scope_description_id IN (${p}) GROUP BY recipe_scope_description_id
         UNION ALL SELECT scope_description_id, COUNT(*) FROM pipeline_recipe_declarations WHERE scope_description_id IN (${p}) GROUP BY scope_description_id
         UNION ALL SELECT promoted_description_id, COUNT(*) FROM entries WHERE promoted_description_id IN (${p}) GROUP BY promoted_description_id
       ) GROUP BY id`,
  );
  const entityLinks = await counted((p) => `SELECT description_id AS id, COUNT(*) AS n FROM description_entities WHERE description_id IN (${p}) GROUP BY description_id`);
  const placeLinks = await counted((p) => `SELECT description_id AS id, COUNT(*) AS n FROM description_places WHERE description_id IN (${p}) GROUP BY description_id`);
  const links = new Map(deleteIds.map((id) => [id, { entities: entityLinks.get(id) ?? 0, places: placeLinks.get(id) ?? 0 }]));

  const deleteJournalIds = new Map<string, string>();
  for (const code of new Set(deletes.map((r) => r.cells.reference_code).filter(Boolean))) {
    deleteJournalIds.set(code, await descriptionDeleteJournalId(state.tenantId, input.file, code));
  }
  return { place, federationId, repositories, sources, destinations, formerHolders, full, pipelineNames, children, links, deleteJournalIds };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** A manifest a set-images row gives its record. */
export interface ImagesPlan {
  url: string;
  key: string;
  manifest: Json;
  body: string;
  canvases: number;
  /** What the address holds: nothing, the manifest built, or another manifest. */
  held: "absent" | "same";
  /** For an address holding the manifest built: whether its bytes are the bytes built. */
  bytes: "same" | "differ" | null;
  upload: boolean;
  /** The columns written, by the editor's keys. */
  set: { iiifManifestUrl?: string; hasDigital?: true };
  /** The record the file creates, or null for a record the tenant holds. */
  created: CreatePlan | null;
  code: string;
  /** The record's id and, for a record the tenant holds, its address and version as read. */
  recordId: string;
  readUrl: string | null;
  readVersion: number | null;
  /** The sources' identities. */
  sources: string[];
}

/** A record a delete-description row deletes. */
export interface DeletePlan {
  row: DescriptionChangeRow;
  code: string;
  id: string;
  /** Every column, as read. */
  read: StoredDescription;
  parentId: string | null;
  survivorId: string;
  survivorCode: string;
  journalId: string;
  links: { entities: number; places: number };
}

export interface OpsPlan {
  uploads: ImagesPlan[];
  images: ImagesPlan[];
  deletes: DeletePlan[];
  /** For each record former codes are added to: the codes, in the file's order, and the `legacy_ids` they make. */
  formerCodes: Map<string, { codes: string[]; next: string }>;
  /** For each parent read that loses children: how many. */
  lostChildren: Map<string, number>;
}

/** The evidence of this file's changelog rows for a row that writes nothing. */
function evidence(
  entries: Array<{ key: string; entry: { old: unknown; new: unknown } | undefined; ok: (e: { old: unknown; new: unknown }) => boolean }>,
): "already updated" | "same" | "contradicts" {
  const present = entries.filter((e) => e.entry !== undefined);
  if (present.length === 0) return "same";
  return present.every((e) => e.ok(e.entry!)) ? "already updated" : "contradicts";
}

/**
 * Plans the rows of `set-images`, `add-former-code` and
 * `delete-description` (module header), with the field updates and the
 * creates already planned in `plans`.
 */
export function planOps(
  plans: RowPlan[],
  createByCode: Map<string, RowPlan>,
  state: DescriptionsState,
  refuse: (r: DescriptionChangeRow, reason: string) => void,
): OpsPlan {
  const ops = state.ops!;
  const out: OpsPlan = { uploads: [], images: [], deletes: [], formerCodes: new Map(), lostChildren: new Map() };
  const no = (p: RowPlan, reason: string) => {
    refuse(p.row, reason);
    p.status = "refused";
  };
  const opRows = plans.filter((p) => IMAGE_OPS.includes(opOf(p.row.cells) as Op));
  const journalOf = (id: string): Journaled | undefined => state.journalFound.get(state.journalIds.get(id) ?? "");

  // The descriptions the file deletes, by id, and the line that deletes each.
  const deleted = new Map<string, DescriptionChangeRow>();
  for (const p of opRows) {
    if (opOf(p.row.cells) !== "delete-description") continue;
    const d = state.byCode.get(p.row.cells.reference_code);
    if (d && !deleted.has(text(d.id))) deleted.set(text(d.id), p.row);
  }

  // The checks of a row alone.
  const live: RowPlan[] = [];
  for (const p of opRows) {
    const c = p.row.cells;
    const op = opOf(c) as Op;
    const given = foreignColumns(op).filter((col) => c[col] !== "");
    if (given.length > 0) { no(p, `a ${op} row fills only its own columns; this one gives ${given.join(", ")}`); continue; }
    if (!c.reference_code) { no(p, "reference_code is blank"); continue; }
    if (state.unsettledCodes.has(c.reference_code)) { no(p, `the description of reference code ${c.reference_code} changed while the plan read it; plan again`); continue; }
    live.push(p);
  }

  // A description of the tenant, or one the file creates.
  const target = (p: RowPlan): { d: StoredDescription } | { created: CreatePlan } | null => {
    const code = p.row.cells.reference_code;
    const createRow = createByCode.get(code);
    if (createRow && createRow.status === "refused") { no(p, `${code} is created by line ${createRow.row.line}, which is refused`); return null; }
    if (createRow && createRow.status === "create") return { created: createRow.create! };
    const d = state.byCode.get(code);
    if (!d) { no(p, `no description of ${state.tenantSlug} has the reference code ${code}`); return null; }
    return { d };
  };

  // add-former-code, first: a delete reads which codes the file adds.
  const formerRows = new Map<string, RowPlan>();
  /** The record each former code of the file is given to: one record per code. */
  const formerOwner = new Map<string, { id: string; code: string; line: number }>();
  for (const p of live.filter((x) => opOf(x.row.cells) === "add-former-code")) {
    const c = p.row.cells;
    const code = c.reference_code;
    const t = target(p);
    if (!t) continue;
    if ("created" in t) { no(p, `add-former-code names a description the tenant holds; ${code} is created by line ${t.created.row.line}`); continue; }
    const d = t.d;
    p.description = d;
    const id = text(d.id);
    const former = c.former_code;
    if (!former) { no(p, "former_code is blank"); continue; }
    if (former === code) { no(p, `former code ${former} is the record's own code`); continue; }
    const key = `${id}|${former}`;
    const twice = formerRows.get(key);
    if (twice) { no(p, `${code} is given the former code ${former} again (line ${twice.row.line})`); continue; }
    const elsewhere = formerOwner.get(former);
    if (elsewhere && elsewhere.id !== id) { no(p, `former code ${former} is given to ${elsewhere.code} by line ${elsewhere.line}`); continue; }
    formerOwner.set(former, { id, code, line: p.row.line });
    formerRows.set(key, p);
    const del = deleted.get(id);
    if (del) { no(p, `${code} is deleted by line ${del.line}`); continue; }
    const legacy = d.legacy_ids as string | null;
    if (!legacyIsArray(legacy)) { no(p, `legacy_ids of ${code} is not a JSON list`); continue; }
    // A code the record already records counts in these checks as one the file adds: neither may be a live code.
    const createRow = createByCode.get(former);
    if (createRow) { no(p, `former code ${former} is created by line ${createRow.row.line}`); continue; }
    const holder = (ops.formerHolders.get(former) ?? []).find((h) => !(h.tenantId === state.tenantId && deleted.has(h.id)));
    if (holder) { no(p, `former code ${former}: ${holder.code} (${holder.id}) holds it now`); continue; }
    if (legacyIdsOf(legacy, FORMER_REFERENCE_PROVIDER).includes(former)) {
      // This file's changelog row: a code in its old and new legacy_ids was held before the file, one in
      // its new alone the file added, and one missing from its new contradicts the row.
      const j = journalOf(id);
      const entry = j?.recordId === id ? j.diff?.legacyIds : undefined;
      let e: "same" | "already updated" | "contradicts" = "same";
      if (entry) {
        const inNew = legacyIdsOf(entry.new as string | null, FORMER_REFERENCE_PROVIDER).includes(former);
        const inOld = legacyIdsOf(entry.old as string | null, FORMER_REFERENCE_PROVIDER).includes(former);
        e = !inNew ? "contradicts" : inOld ? "same" : "already updated";
      }
      if (e === "contradicts") { no(p, `this file's changelog row for ${code} records legacy_ids other than adding ${former}`); continue; }
      p.status = e;
      p.formerCode = former;
      continue;
    }
    p.status = "update";
    p.formerCode = former;
    const entry = out.formerCodes.get(id) ?? { codes: [], next: "" };
    entry.codes.push(former);
    entry.next = appendFormerCodes(legacy, entry.codes);
    out.formerCodes.set(id, entry);
  }

  // set-images.
  const imagesOfRecord = new Map<string, RowPlan>();
  const iiifUpdates = new Map(
    plans.filter((x) => x.description && x.spec?.key === "iiifManifestUrl" && x.status !== "refused").map((x) => [text(x.description!.id), x.row]),
  );
  const repositoryUpdates = new Map(
    plans.filter((x) => x.description && x.spec?.key === "repositoryId" && x.status === "update").map((x) => [text(x.description!.id), x.row]),
  );
  for (const p of live.filter((x) => opOf(x.row.cells) === "set-images")) {
    const c = p.row.cells;
    const code = c.reference_code;
    const place = ops.place!;
    const twice = imagesOfRecord.get(code);
    if (twice) { no(p, `${code} is given images again (line ${twice.row.line})`); continue; }
    imagesOfRecord.set(code, p);
    const t = target(p);
    if (!t) continue;
    const d = "d" in t ? t.d : null;
    const created = "created" in t ? t.created : null;
    if (d) {
      p.description = d;
      const del = deleted.get(text(d.id));
      if (del) { no(p, `${code} is deleted by line ${del.line}`); continue; }
      const r = repositoryUpdates.get(text(d.id));
      if (r) { no(p, `${code} has an update-field row on repository_id in this file (line ${r.line}); give its images in another file`); continue; }
      const u = iiifUpdates.get(text(d.id));
      if (u) { no(p, `${code} has an update-field row on iiif_manifest_url in this file (line ${u.line})`); continue; }
    }
    if (created && created.row.cells.iiif_manifest_url !== "") {
      no(p, `${code} is created by line ${created.row.line} with an iiif_manifest_url of its own`);
      continue;
    }
    const given = imagesOf(c);
    const problem = imagesProblem(given);
    if (problem) { no(p, problem); continue; }
    const url = manifestUrl(place.baseUrl, code);
    const current = d ? (d.iiif_manifest_url as string | null) : null;
    if (!blank(current) && current !== url) { no(p, `the record already has a manifest, ${current}`); continue; }

    // The fields the manifest is made from, as the file leaves them.
    let fields: ManifestDescription;
    let repositoryId: string;
    if (d) {
      const next = (key: string, column: string) => {
        const u = plans.find((x) => x.status === "update" && x.description === d && x.spec?.key === key);
        return (u ? u.next ?? null : d[column] ?? null) as string | null;
      };
      fields = {
        referenceCode: code, title: next("title", "title") ?? "", dateExpression: next("dateExpression", "date_expression"),
        extent: next("extent", "extent"), language: next("language", "language"), accessConditions: next("accessConditions", "access_conditions"),
        scopeContent: next("scopeContent", "scope_content"),
      };
      repositoryId = text(d.repository_id);
    } else {
      const f = created!.fields;
      const orNull = (v: string | undefined) => (v === undefined || v === "" ? null : v);
      fields = {
        referenceCode: code, title: f.title ?? "", dateExpression: orNull(f.dateExpression), extent: orNull(f.extent), language: orNull(f.language),
        accessConditions: orNull(f.accessConditions), scopeContent: orNull(f.scopeContent),
      };
      repositoryId = created!.repositoryId;
    }
    const built = buildManifest({ ...given, referenceCode: code }, url, fields, ops.repositories.get(repositoryId), repositoryId, place, ops.sources);
    if ("bad" in built) { no(p, built.bad); continue; }

    // What the address holds: it must be read conclusively.
    const got = ops.destinations.get(url) ?? { status: 0, error: "not fetched" };
    const parsed = got.status === 200 ? parseManifest(got) : null;
    if (!(got.status === 404 || (parsed && "json" in parsed))) {
      const why = parsed && "error" in parsed ? ` (${parsed.error})` : got.error ? ` (${got.error})` : "";
      no(p, `the destination ${url} cannot be read conclusively: HTTP ${got.status}${why}`);
      continue;
    }
    const body = manifestBody(built.manifest);
    const heldJson = parsed && "json" in parsed ? parsed.json : null;
    const same = heldJson !== null && sameJson(heldJson, built.manifest);
    if (current === url && !same) {
      no(p, `it would replace an established manifest at ${url}, which differs from the one built`);
      continue;
    }
    // No manifest is ever overwritten: the address follows from the code, so another manifest there is refused, whoever names it.
    if (heldJson !== null && !same) {
      no(p, `its address ${url} already holds a manifest other than the one built`);
      continue;
    }
    const held: ImagesPlan["held"] = same ? "same" : "absent";
    const set: ImagesPlan["set"] = {};
    if (current !== url) set.iiifManifestUrl = url;
    if (created || !truthy(d!.has_digital)) set.hasDigital = true;
    const plan: ImagesPlan = {
      url, key: manifestObjectPath(code), manifest: built.manifest, body, canvases: built.canvases, held,
      bytes: held === "same" ? (got.text === body ? "same" : "differ") : null,
      upload: held !== "same", set, created, code, recordId: d ? text(d.id) : created!.id, readUrl: current,
      readVersion: d ? Number(d.updated_at) : null, sources: built.identities,
    };
    p.images = plan;
    if (created) {
      p.status = "update";
    } else if (Object.keys(set).length === 0) {
      const id = text(d!.id);
      const j = journalOf(id);
      const own = j?.recordId === id ? j.diff : undefined;
      const createRow = createByCode.get(code);
      const createJournal = createRow?.status === "already created" ? state.journalFound.get(state.createIds.get(code)?.journalId ?? "") : undefined;
      const e = evidence([
        { key: "iiifManifestUrl", entry: own?.iiifManifestUrl, ok: (x) => x.new === url },
        { key: "hasDigital", entry: own?.hasDigital, ok: (x) => x.new === true },
        { key: "iiifManifestUrl", entry: createJournal?.diff?.iiifManifestUrl, ok: (x) => x.new === url },
      ]);
      if (e === "contradicts") { no(p, `this file's changelog row for ${code} records a manifest other than ${url}`); continue; }
      p.status = e;
    } else {
      p.status = "update";
    }
    out.images.push(plan);
    if (plan.upload) out.uploads.push(plan);
  }

  // delete-description.
  const deleteRows = new Map<string, RowPlan>();
  for (const p of live.filter((x) => opOf(x.row.cells) === "delete-description")) {
    const c = p.row.cells;
    const code = c.reference_code;
    const twice = deleteRows.get(code);
    if (twice) { no(p, `${code} is deleted again (line ${twice.row.line})`); continue; }
    deleteRows.set(code, p);
    const createRow = createByCode.get(code);
    if (createRow) { no(p, `${code} is created by line ${createRow.row.line}`); continue; }
    const journalId = ops.deleteJournalIds.get(code)!;
    const journal = state.journalFound.get(journalId);
    const d = state.byCode.get(code);
    if (!d) {
      const recorded = journal && journal.kind === "delete" && journal.recordType === "description" && journal.diff?.referenceCode?.old === code;
      if (recorded) { p.status = "already deleted"; continue; }
      no(p, `no description of ${state.tenantSlug} has the reference code ${code}${journal ? "" : ", and this file has not deleted it"}`);
      continue;
    }
    p.description = d;
    const id = text(d.id);
    if (journal) { no(p, changedSince(p.row, `this file's delete changelog row for ${code} is already written, and a description holds the code`)); continue; }
    const into = c.merged_into;
    if (!into) { no(p, "merged_into is blank"); continue; }
    if (into === code) { no(p, "merged_into is the record itself"); continue; }
    if (state.unsettledCodes.has(into)) { no(p, `the description of reference code ${into} changed while the plan read it; plan again`); continue; }
    const survivor = state.byCode.get(into);
    if (!survivor) { no(p, `merged_into ${into} is not a description of ${state.tenantSlug}`); continue; }
    const survivorDeleted = deleted.get(text(survivor.id));
    if (survivorDeleted) { no(p, `merged_into ${into} is deleted by line ${survivorDeleted.line}`); continue; }
    const children = Math.max(Number(d.child_count), ops.children.get(id) ?? 0);
    if (children > 0) { no(p, `it has ${children} children`); continue; }
    const under = [...createByCode.values()].find((x) => x.status !== "refused" && x.create?.parentId === id);
    if (under) { no(p, `line ${under.row.line} creates a description under it`); continue; }
    const writer = plans.find((x) => x !== p && x.status !== "refused" && x.description && text(x.description.id) === id && opOf(x.row.cells) !== "delete-description");
    if (writer) { no(p, `${code} is also written by line ${writer.row.line}`); continue; }
    const sibling = [...createByCode.values()].find((x) => x.row.cells.after === code || x.row.cells.parent_code === code);
    if (sibling) { no(p, `${code} is named by line ${sibling.row.line} as its parent or after`); continue; }
    const recorded =
      legacyIdsOf(survivor.legacy_ids as string | null, FORMER_REFERENCE_PROVIDER).includes(code) ||
      [...formerRows.values()].some((x) => x.status !== "refused" && x.description === survivor && x.formerCode === code);
    if (!recorded) {
      no(p, `the survivor ${into} does not record ${code} as a former code, and no add-former-code row of this file adds it`);
      continue;
    }
    const named = ops.pipelineNames.get(id) ?? 0;
    if (named > 0) { no(p, `${named} pipeline volumes, recipe declarations or entries name it`); continue; }
    const read = ops.full.get(id);
    if (!read || read.updated_at !== d.updated_at) { no(p, `${code} changed while the plan read it; plan again`); continue; }
    p.status = "delete";
    const plan: DeletePlan = {
      row: p.row, code, id, read, parentId: blank(d.parent_id) ? null : text(d.parent_id), survivorId: text(survivor.id), survivorCode: into,
      journalId, links: ops.links.get(id) ?? { entities: 0, places: 0 },
    };
    p.deletion = plan;
    out.deletes.push(plan);
    if (plan.parentId) out.lostChildren.set(plan.parentId, (out.lostChildren.get(plan.parentId) ?? 0) + 1);
  }

  // A row of any operation that writes a record the file deletes.
  for (const p of plans) {
    if (p.status === "refused" || !p.description || opOf(p.row.cells) === "delete-description") continue;
    const del = deleted.get(text(p.description.id));
    if (del && out.deletes.some((x) => x.row === del)) no(p, `${text(p.description.reference_code)} is deleted by line ${del.line}`);
  }

  // A record to write whose changelog row of this file is already there was changed since.
  for (const p of live) {
    if (p.status !== "update" || !p.description) continue;
    if (journalOf(text(p.description.id))) {
      no(p, changedSince(p.row, `part of its effect is present: this file's changelog row for ${text(p.description.reference_code)} is already written, and the row would write more`));
    }
  }
  const refusedRows = new Set(plans.filter((p) => p.status === "refused").map((p) => p.row));
  out.uploads = out.uploads.filter((u) => !refusedRows.has(plans.find((p) => p.images === u)!.row));
  return out;
}

// ---------------------------------------------------------------------------
// The uploads
// ---------------------------------------------------------------------------

/** A count that is 1 while the tenant's federation, its manifest address and its bucket are as read. */
export function placeCheck(place: Place, tenantId: string): string {
  return `SELECT count(*) AS n FROM tenants t JOIN federations f ON f.id = t.federation_id WHERE t.id = ${escapeSql(tenantId)} ` +
    `AND t.federation_id = ${escapeSql(place.federationId)} AND f.manifest_base_url IS ${escapeSql(place.storedBaseUrl)} ` +
    `AND f.manifest_bucket IS ${escapeSql(place.bucket)}`;
}

/** Puts an object in the bucket: `body` is also the content of `file`. */
export type PutObject = (bucket: string, key: string, body: string, file: string) => Promise<void> | void;

/** Where a run keeps a manifest it uploads, and one an upload replaces. */
export const manifestFile = (name: string, key: string) => `${name}/manifests/${key}`;

/**
 * Uploads the manifests the plan builds, before the SQL file is applied:
 * the records given images are read again first, and must still hold
 * the address and version read (and a code to create must still be
 * free); each manifest file on disk must hold the bytes built; just
 * before each put the address must still answer 404, so a manifest that
 * landed since the plan is never overwritten; each upload is fetched
 * back from its public address and must read as uploaded. Anything else
 * stops the run before D1 is written; manifests uploaded before it stay
 * at addresses no record names.
 */
export async function uploadManifests(
  uploads: ImagesPlan[],
  place: Place,
  tenantId: string,
  providers: { rows: RowReader; readFile: (p: string) => string; writeFile: (p: string, t: string) => void; putObject?: PutObject; fetchManifest?: FetchManifest },
  name: string,
  bust: string,
  log: (line: string) => void,
  stop: (message: string) => Error,
): Promise<void> {
  if (uploads.length === 0) return;
  if (!providers.putObject || !providers.fetchManifest) throw stop("A file with manifests to upload needs a bucket to put them in");
  const T = escapeSql(tenantId);
  const [now0] = await providers.rows(placeCheck(place, tenantId));
  if (!now0 || Number(now0.n) !== 1) throw stop("The tenant's federation's manifest address or bucket changed after the plan read it; nothing was uploaded or written");
  const existing = uploads.filter((u) => !u.created);
  const now = new Map<string, Record<string, unknown>>();
  for (const r of await readIn(providers.rows, existing.map((u) => u.recordId), (p) =>
    `SELECT ${typed(["id", "iiif_manifest_url", "updated_at"])} FROM descriptions WHERE tenant_id = ${T} AND id IN (${p})`,
  )) now.set(text(r.id), r);
  for (const u of existing) {
    const r = now.get(u.recordId);
    if (!r || storedValue(r, "iiif_manifest_url") !== u.readUrl || storedValue(r, "updated_at") !== u.readVersion) {
      throw stop(`${u.code} changed after the plan read it; nothing was uploaded or written`);
    }
  }
  const taken = await readIn(providers.rows, uploads.filter((u) => u.created).map((u) => u.code), (p) =>
    `SELECT reference_code FROM descriptions WHERE tenant_id = ${T} AND reference_code IN (${p})`,
  );
  if (taken.length > 0) throw stop(`${text(taken[0].reference_code)} is already a description; nothing was uploaded or written`);
  for (const u of uploads) {
    const file = manifestFile(name, u.key);
    if (providers.readFile(file) !== u.body) throw stop(`${file} does not hold the manifest this run built; nothing more was uploaded, and nothing was written`);
  }
  let done = 0;
  for (const u of uploads) {
    const file = manifestFile(name, u.key);
    // The address must still hold nothing: a manifest that landed since the plan is never overwritten.
    const now = await providers.fetchManifest(`${u.url}?v=${encodeURIComponent(`${bust}-check`)}`).catch((err: Error) => ({ status: 0, error: err.message }));
    if (now.status !== 404) {
      throw stop(
        `its address ${u.url} holds a manifest it did not hold when the plan read it (HTTP ${now.status}); nothing more was uploaded, ` +
          `and nothing was written to D1; the ${done} manifests uploaded before it stay at addresses no record names`,
      );
    }
    await providers.putObject(place.bucket, u.key, u.body, file);
    const back = parseManifest(await providers.fetchManifest(`${u.url}?v=${encodeURIComponent(bust)}`).catch((err: Error) => ({ status: 0, error: err.message })));
    if ("error" in back || !sameJson(back.json, u.manifest)) {
      throw stop(
        `${u.url} does not read back as uploaded${"error" in back ? ` (${back.error})` : ""}; nothing has been written to D1, ` +
          `and the ${done} manifests uploaded before it stay at addresses no record names`,
      );
    }
    done += 1;
    log(`  uploaded and read back: ${u.url}`);
  }
}

/** A delete's changelog diff: every value the record held, under the schema's keys (`deleteSnapshotDiff`). */
export function deleteDiffOf(read: StoredDescription): Record<string, { old: unknown; new: null }> {
  return deleteSnapshotDiff(Object.fromEntries(FULL_READ.map((column) => [COLUMN_KEYS[column] ?? column, read[column]])));
}

// @version v0.9.0
