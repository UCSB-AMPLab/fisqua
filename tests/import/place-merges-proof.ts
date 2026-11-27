/**
 * Tests — the 24 October place merge list, re-expressed as `merge-place` rows
 *
 * This module turns what the reviewed place merge command produced on
 * 24 October (`scripts/commands/place-merges.ts`) into a proof of the
 * command line's `merge-place`: from the applied run's artefacts (the
 * merge list `place-merges-final.csv`, the run's JSON report and its
 * SQL file) it derives the places and links as they stood before the
 * run, the change file's `merge-place` rows, and the state the run left.
 *
 * The before state is read from the SQL file's opening guards, which
 * hold every survivor and loser on the columns the command read, and
 * every link it moved or dropped, or relied on to drop one, on all its
 * columns. The state after is what the SQL file's writes leave when they
 * are applied to that state: the places, the links, the ledger rows and
 * the changelog rows. The place codes come from the report, joined to
 * the ids through the ledger rows' `listRef`.
 *
 * The rows: one per row the list merges (`readMergeList`), in the list's
 * order, each naming its loser and its final survivor; `label_to_keep`
 * on every row of a survivor whose label the run changed; the values the
 * report says were carried, on the row that carried them; and on the
 * first row of each survivor, `name_variants_add`, the variants the
 * survivor gained in the run. A survivor's links other than those the
 * guards hold are not in the before state: a merge reads them only to
 * find collisions, and every collision's survivor link is guarded.
 *
 * `authorities-cli-places-proof.test.ts` applies the rows to the before
 * state with the command line and compares what it leaves with what the
 * run left; the committed slice is this derivation's output for a few
 * survivors (`fixtures/place-merges-2026-10-24-slice.json`).
 *
 * @version v0.9.0
 */
import { DatabaseSync } from "node:sqlite";
import { readMergeList } from "../../scripts/lib/place-merges";
import { PLACES_DDL } from "./authorities-cli-places-helpers";

type Row = Record<string, unknown>;
type Cells = Record<string, string>;

export interface ProofFixture {
  federationId: string;
  userId: string;
  now: number;
  /** Every survivor and loser, as read before the run, with its code. */
  places: Row[];
  /** Every link the run moved, dropped or relied on, as read. */
  links: Row[];
  rows: Cells[];
  expected: {
    places: Row[];
    /** The links read, each with every column after the run, or `{ id, place_id: null }` when it was dropped. */
    links: Array<Record<string, unknown> & { id: string; place_id: unknown }>;
    ledger: Array<{ source_id: string; target_id: string; movedLinks: number; droppedLinks: unknown[]; carried: Record<string, string> | null }>;
    journal: Array<{ record_type: string; record_id: string; kind: string; diff: unknown }>;
  };
}

export const PROOF_HEADER = [
  "op", "authority_code", "authority_name", "target_codes", "label_to_keep", "name_variants_add", "name_variants_remove",
  "tgn_id", "hgis_id", "whg_id", "latitude", "longitude", "coordinate_precision", "changelog_note",
];

const PLACE_GUARD = [
  "id", "updated_at", "tenant_id", "merged_into", "label", "display_name", "name_variants", "tgn_id", "hgis_id", "whg_id", "latitude", "longitude",
  "coordinate_precision",
];
const LINK_GUARD = ["id", "place_id", "description_id", "role", "role_note", "role_raw", "created_at"];
const PLACE_COLUMNS = ["id", "place_code", ...PLACE_GUARD.slice(1)];

/** The rows of a guard's VALUES table, read by SQLite itself. */
function valuesOf(scratch: DatabaseSync, statement: string, columns: string[]): Row[] {
  const start = statement.indexOf("JOIN (VALUES ") + "JOIN (VALUES ".length;
  const end = statement.lastIndexOf(") v ON ");
  return (scratch.prepare(`SELECT * FROM (VALUES ${statement.slice(start, end)})`).all() as Row[]).map((r) =>
    Object.fromEntries(columns.map((c, i) => [c, r[`column${i + 1}`]])),
  );
}

export const database = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(PLACES_DDL);
  return db;
};

/** Seeds a database with the federation, tenant, actor, descriptions, places and links of a fixture. */
export function seed(db: DatabaseSync, f: ProofFixture): void {
  db.exec(`INSERT INTO federations VALUES ('${f.federationId}', 'neogranadina-fed', 'active', 't-1', 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO tenants VALUES ('t-1', 'neogranadina', '${f.federationId}', NULL, 1, 'ne', 'nl');`);
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('${f.userId}', 'admin@example.org', 'Admin', 't-1', 1);`);
  const d = db.prepare("INSERT OR IGNORE INTO descriptions VALUES (?, 't-1', ?)");
  for (const l of f.links) d.run(String(l.description_id), `ref-${l.description_id}`);
  const p = db.prepare(
    `INSERT INTO places (id, federation_id, place_code, ${PLACE_GUARD.slice(1).join(", ")}, created_at) VALUES (?, ?, ?, ${PLACE_GUARD.slice(1).map(() => "?").join(", ")}, 1)`,
  );
  for (const x of f.places) p.run(...([x.id, f.federationId, x.place_code, ...PLACE_GUARD.slice(1).map((c) => x[c])] as never[]));
  const l = db.prepare(`INSERT INTO description_places (${LINK_GUARD.join(", ")}) VALUES (${LINK_GUARD.map(() => "?").join(", ")})`);
  for (const x of f.links) l.run(...(LINK_GUARD.map((c) => x[c]) as never[]));
}

/** What a database holds of a fixture's places, links, ledger and changelog, for comparing. */
export function stateOf(db: DatabaseSync, f: Pick<ProofFixture, "places" | "links">): ProofFixture["expected"] {
  const placeIds = f.places.map((p) => String(p.id));
  const linkIds = new Set(f.links.map((l) => String(l.id)));
  const inList = (ids: string[]) => ids.map((i) => `'${i}'`).join(", ") || "''";
  const placesAfter = (db.prepare(`SELECT ${PLACE_COLUMNS.join(", ")} FROM places WHERE id IN (${inList(placeIds)}) ORDER BY id`).all() as Row[]);
  const linksAfter = new Map((db.prepare(`SELECT ${LINK_GUARD.join(", ")} FROM description_places WHERE id IN (${inList([...linkIds])})`).all() as Row[])
    .map((r) => [String(r.id), r]));
  const ledger = (db.prepare(`SELECT source_id, target_id, detail FROM authority_operations WHERE source_id IN (${inList(placeIds)}) ORDER BY source_id`).all() as Row[])
    .map((r) => {
      const d = JSON.parse(String(r.detail));
      const carried = d.carried ? Object.fromEntries(Object.entries(d.carried as Record<string, string>).map(([k, v]) => [k === "coords" ? "coordinates" : k, v])) : null;
      return { source_id: String(r.source_id), target_id: String(r.target_id), movedLinks: d.movedLinks, droppedLinks: d.droppedLinks, carried };
    });
  const journal = (db.prepare("SELECT record_type, record_id, kind, diff FROM changelog").all() as Row[])
    .map((r) => ({ record_type: String(r.record_type), record_id: String(r.record_id), kind: String(r.kind), diff: JSON.parse(String(r.diff)) }))
    .filter((j) => (j.record_type === "place" ? placeIds.includes(j.record_id) : linkIds.has(String((j.diff as Row).id))))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return {
    places: placesAfter,
    links: [...linkIds].sort().map((id) => (linksAfter.get(id) as ProofFixture["expected"]["links"][number] | undefined) ?? { id, place_id: null }),
    ledger,
    journal,
  };
}

/** A canonical form, keys sorted at every level, so two states compare whatever their key order. */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canonical((v as Row)[k])]));
  return v;
}

/**
 * Derives the fixture from the run's artefacts. `only`, when given,
 * keeps the survivors whose codes it names, their losers and their links.
 */
export function proofFixture(sql: string, report: { merges: Array<{ ref: string; loser: string; survivor: string }>; carried: any[]; labelChanges: any[] }, list: Uint8Array, only?: Set<string>): ProofFixture {
  const statements = sql.split("\n").filter((s) => s.trim() !== "");
  const scratch = new DatabaseSync(":memory:");
  const guards = statements.filter((s) => s.startsWith("SELECT CASE"));
  const before = guards.filter((s) => s.includes("a place in the list has changed")).flatMap((s) => valuesOf(scratch, s, PLACE_GUARD));
  const links = guards.filter((s) => s.includes("a link has changed since it was read")).flatMap((s) => valuesOf(scratch, s, LINK_GUARD));
  const federationId = /"places"\."federation_id" = '([^']+)'/.exec(sql)![1];
  const userId = /"authority_operations" \([^)]*\) values \('[^']*', '[^']*', 'place', 'merge', '[^']*', '[^']*', '([^']*)'/.exec(sql)![1];
  const now = Number(/"updated_at" = (\d+)/.exec(sql)![1]);

  // Replay the run's writes on the state before it, with placeholder codes.
  const db = database();
  const draft: ProofFixture = {
    federationId, userId, now, places: before.map((p) => ({ ...p, place_code: `tmp-${p.id}` })), links, rows: [],
    expected: { places: [], links: [], ledger: [], journal: [] },
  };
  seed(db, draft);
  db.exec("BEGIN");
  for (const s of statements) if (!s.startsWith("SELECT CASE")) db.exec(s);
  db.exec("COMMIT");

  // Codes, through the ledger's listRef.
  const byRef = new Map(report.merges.map((m) => [m.ref, m]));
  const code = new Map<string, string>();
  for (const r of db.prepare("SELECT source_id, target_id, detail FROM authority_operations").all() as Row[]) {
    const m = byRef.get(JSON.parse(String(r.detail)).listRef);
    if (!m) throw new Error(`no merge in the report has the ref of ledger row ${String(r.source_id)}`);
    code.set(String(r.source_id), m.loser);
    code.set(String(r.target_id), m.survivor);
  }
  const idOf = new Map([...code].map(([id, c]) => [c, id]));
  for (const p of draft.places) p.place_code = code.get(String(p.id)) ?? p.place_code;
  db.exec("UPDATE places SET place_code = NULL");
  const setCode = db.prepare("UPDATE places SET place_code = ? WHERE id = ?");
  for (const [id, c] of code) setCode.run(c, id);
  const expected = stateOf(db, draft);

  // The rows, from the list.
  const placeOf = new Map(draft.places.map((p) => [String(p.place_code), p]));
  const after = new Map(expected.places.map((p) => [String(p.place_code), p]));
  const label = new Map(report.labelChanges.map((c) => [c.survivorCode as string, c.new as string]));
  const merging = readMergeList(list).rows;
  if (merging.map((r) => r.ref).sort().join("|") !== report.merges.map((m) => m.ref).sort().join("|")) {
    throw new Error("the list's merging rows are not the report's merges");
  }
  const seen = new Set<string>();
  const rows: Cells[] = [];
  for (const m of merging) {
    const loser = placeOf.get(m.loserCode);
    const survivor = placeOf.get(m.finalSurvivorCode);
    if (!loser || !survivor) throw new Error(`${m.ref}: ${m.loserCode} or ${m.finalSurvivorCode} is not among the places the run read`);
    const row: Cells = {
      op: "merge-place", authority_code: m.loserCode, authority_name: String(loser.label), target_codes: m.finalSurvivorCode,
      label_to_keep: label.get(m.finalSurvivorCode) ?? "", changelog_note: `Place merge list place-merges-final.csv, ruled 2026-10-24 (${m.ref})`,
    };
    for (const c of report.carried.filter((x) => x.ref === m.ref)) {
      if (c.field === "coords") {
        const v = /^(-?[\d.]+),(-?[\d.]+) \(([^)]+)\)$/.exec(c.value)!;
        Object.assign(row, { latitude: v[1], longitude: v[2], coordinate_precision: v[3] === "no precision" ? "" : v[3] });
      } else row[{ tgnId: "tgn_id", hgisId: "hgis_id", whgId: "whg_id" }[c.field as "tgnId" | "hgisId" | "whgId"]] = c.value;
    }
    if (!seen.has(m.finalSurvivorCode)) {
      seen.add(m.finalSurvivorCode);
      const had = new Set(JSON.parse(String(survivor.name_variants ?? "[]")) as string[]);
      const now = JSON.parse(String(after.get(m.finalSurvivorCode)!.name_variants ?? "[]")) as string[];
      row.name_variants_add = now.filter((v) => !had.has(v)).join(" | ");
    }
    rows.push(row);
  }

  const fixture: ProofFixture = { federationId, userId, now, places: draft.places, links, rows, expected };
  if (!only) return fixture;
  // The slice: the survivors named, their losers, and the links of both.
  const kept = new Set<string>();
  const keptRows = rows.filter((r) => only.has(r.target_codes));
  for (const r of keptRows) for (const c of [r.authority_code, r.target_codes]) kept.add(idOf.get(c)!);
  const places = draft.places.filter((p) => kept.has(String(p.id)));
  const keptLinks = links.filter((l) => kept.has(String(l.place_id)));
  const all = expected;
  const linkIds = new Set(keptLinks.map((l) => String(l.id)));
  return {
    federationId, userId, now, places, links: keptLinks, rows: keptRows,
    expected: {
      places: all.places.filter((p) => kept.has(String(p.id))),
      links: all.links.filter((l) => linkIds.has(l.id)),
      ledger: all.ledger.filter((l) => kept.has(l.source_id)),
      journal: all.journal.filter((j) => (j.record_type === "place" ? kept.has(j.record_id) : linkIds.has(String((j.diff as Row).id)))),
    },
  };
}

// @version v0.9.0
