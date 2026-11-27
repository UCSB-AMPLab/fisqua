/**
 * Tests — images, former codes and deletes in the command line's descriptions
 *
 * This suite pins the `set-images`, `add-former-code` and
 * `delete-description` operations of the descriptions change file
 * (`scripts/lib/descriptions-cli/images.ts`, `./manifests.ts`), the rules
 * the `attach-document-images` lists were applied under, each kept in
 * one of them. The run is driven end to end against an in-memory
 * `node:sqlite` database holding every column of `descriptions`
 * (`./descriptions-cli-schema.ts`), the links with their cascade, the
 * pipeline tables, the changelog and the full-text index, with D1's
 * expression depth limit of 100 and its limit of 100 result columns
 * (`./d1-limits.ts`); the file it writes is applied as one unit, as
 * `wrangler d1 execute --file` applies it. The manifest bucket and the
 * public manifest host are one in-memory store, so an object put is what
 * a later fetch of its address reads. Nothing here reaches D1 or a bucket.
 *
 *   - set-images: the manifest built from the sources' canvases in the
 *     row's order, renumbered, with the descriptive fields
 *     `resolveManifestInputs` gives as the file leaves them; uploaded and
 *     read back before the SQL file is applied; the record's address,
 *     digital flag, version and one changelog row; a rerun "already
 *     updated", and a record that already has its manifest "same", with
 *     its bytes compared;
 *   - one refusal per rule of the image lists, each stopping the run
 *     before any upload or write;
 *   - an address holding any other manifest, whoever names it, refused
 *     at plan, and one where a manifest lands after the plan left
 *     untouched by the put;
 *   - a manifest that does not read back, and a record changed before
 *     the upload, stop before D1 is written; a SQL file refused after the
 *     uploads leaves them at addresses no record names, and a rerun finds
 *     them held;
 *   - a record the file creates, given images in the same file;
 *   - add-former-code: appended under `former-reference-code`, the text
 *     kept; done and same; its refusals;
 *   - delete-description: deleted as the editor deletes, journaled with
 *     every value held; done only on this file's delete row; its
 *     refusals; a survivor whose former code is added by the same file;
 *   - the columns of one operation on another's row;
 *   - an `update-field` row on the digital flag of a record the file
 *     gives images, refused.
 *
 * Every value here is a test value.
 *
 * @version v0.9.0
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { parseDescriptionChangeFile } from "../../scripts/lib/descriptions-cli/change-file";
import {
  descriptionDeleteJournalId,
  descriptionJournalId,
  runDescriptions,
  type DescriptionsReport,
} from "../../scripts/lib/descriptions-cli/run";
import { resolveManifestInputs } from "../../app/lib/pipeline/manifest-inputs";
import { descriptionsDdl } from "./descriptions-cli-schema";
import { d1Read } from "./d1-limits";

const D1_LIMITS = { limits: { exprDepth: 100 } } as unknown as ConstructorParameters<typeof DatabaseSync>[1];

const TENANT = "t-1";
const FILE = "aht-images-test.csv";
const NOW = 1_763_200_000_000;
const OLD = 1_700_000_000_000;
const BASE = "https://manifests.test";
const BUCKET = "manifests-test";
const REPO = "a1a1a1a1-0000-4000-8000-000000000001";
const REPO_NORIGHTS = "a1a1a1a1-0000-4000-8000-000000000002";
const RIGHTS = "http://creativecommons.org/licenses/by-nc/4.0/";

const DDL = `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT, manifest_base_url TEXT, manifest_bucket TEXT,
  hosting_statement_es TEXT, hosting_statement_en TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT, disabled_at INTEGER, descriptive_standard TEXT,
  public_site_url TEXT, public_site_name TEXT, provider_name TEXT, provider_url TEXT, mets_base_url TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, tenant_id TEXT, is_admin INTEGER DEFAULT 0, is_super_admin INTEGER DEFAULT 0,
  is_records_admin INTEGER DEFAULT 0, is_authorities_admin INTEGER DEFAULT 0, is_imports_admin INTEGER DEFAULT 0,
  is_digitization_admin INTEGER DEFAULT 0);
CREATE TABLE repositories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, city TEXT, region TEXT,
  country TEXT, country_code TEXT, manifest_rights TEXT, credit_statement_es TEXT, credit_statement_en TEXT, attribution_en TEXT,
  attribution_es TEXT);
${descriptionsDdl()}
CREATE TABLE drafts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL,
  snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL, note TEXT,
  diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update', created_at INTEGER NOT NULL, acted_as TEXT);
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, entity_id TEXT);
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, place_id TEXT);
CREATE TABLE pipeline_volumes (id TEXT PRIMARY KEY, description_id TEXT REFERENCES descriptions(id) ON DELETE RESTRICT,
  recipe_scope_description_id TEXT REFERENCES descriptions(id) ON DELETE RESTRICT);
CREATE TABLE pipeline_recipe_declarations (id TEXT PRIMARY KEY, scope_description_id TEXT REFERENCES descriptions(id) ON DELETE RESTRICT);
CREATE TABLE entries (id TEXT PRIMARY KEY, promoted_description_id TEXT REFERENCES descriptions(id));
CREATE VIRTUAL TABLE descriptions_fts USING fts5(reference_code, title, scope_content, notes, legacy_ids, tokenize='unicode61');
CREATE TRIGGER descriptions_fts_ai AFTER INSERT ON descriptions BEGIN
  INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
  VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids);
END;
CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title, scope_content, notes, legacy_ids)
  VALUES (new.rowid, new.reference_code, new.title, new.scope_content, new.notes, new.legacy_ids);
END;
CREATE TRIGGER descriptions_fts_ad AFTER DELETE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
END;
`;

// ---------------------------------------------------------------------------
// The tree: a fonds, legajo 023 (published, with its manifest) and its items
// ---------------------------------------------------------------------------

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
interface Seed { [column: string]: string | number | null }
const urlOf = (code: string) => `${BASE}/iiif/${code}/manifest.json`;
const F: Seed = {
  id: uuid(1), reference_code: "co-ahrb-aht", description_level: "fonds", title: "Archivo Histórico de Tunja", parent_id: null,
  depth: 0, root_description_id: uuid(1), path_cache: uuid(1), child_count: 1, position: 0, local_identifier: "AHT",
};
const L: Seed = {
  id: uuid(2), reference_code: "co-ahrb-aht-023", description_level: "file", title: "Legajo 023", parent_id: uuid(1),
  depth: 1, root_description_id: uuid(1), path_cache: `${uuid(1)}/${uuid(2)}`, child_count: 4, position: 0, local_identifier: "AHT-023",
  iiif_manifest_url: urlOf("co-ahrb-aht-023"), has_digital: 1,
};
const item = (k: number, over: Seed = {}): Seed => ({
  id: uuid(10 + k), reference_code: `co-ahrb-aht-023-d0${String(k).padStart(2, "0")}`, description_level: "item",
  title: `Documento ${k} del legajo 23`, parent_id: L.id, depth: 2, root_description_id: uuid(1),
  path_cache: `${L.path_cache}/${uuid(10 + k)}`, child_count: 0, position: k - 1, local_identifier: `AHT-023-d0${String(k).padStart(2, "0")}`,
  date_expression: "1682", extent: `Folios: ${k}r-${k}v`, language: "Spanish", scope_content: `Asunto ${k}.`, ...over,
});
const D1 = item(1);
const D2 = item(2);
const D3 = item(3);
const D4 = item(4);
const SEEDS = [F, L, D1, D2, D3, D4];

const pad = (n: number) => String(n).padStart(4, "0");
const file = (n: number, volume = "AHRB_AHT_023") => `${volume}-img_${pad(n)}.jpg`;

/** A published manifest whose canvases show `iiif.test/<segment>/img_NNNN` for each number given. */
function sourceManifest(code: string, segment: string, numbers: number[]) {
  const id = urlOf(code);
  const at = id.replace(/\/manifest\.json$/, "");
  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id, type: "Manifest", label: { es: [`Source ${code}`] }, behavior: ["paged"],
    items: numbers.map((n, i) => {
      const cid = `${at}/canvas/${i + 1}`;
      const image = `https://iiif.test/${segment}/img_${pad(n)}`;
      return {
        id: cid, type: "Canvas", label: { none: [`img ${i + 1}`] }, height: 1500 + n, width: 1000 + n,
        thumbnail: [{ id: `${image}/full/200,300/0/default.jpg`, type: "Image", height: 300, width: 200, format: "image/jpeg" }],
        items: [{
          id: `${cid}/page`, type: "AnnotationPage",
          items: [{
            id: `${cid}/annotation`, type: "Annotation", motivation: "painting",
            body: {
              id: `${image}/full/max/0/default.jpg`, type: "Image", height: 1500 + n, width: 1000 + n,
              service: [{ id: image, type: "ImageService3", profile: "level0" }], format: "image/jpeg",
            },
            target: cid,
          }],
        }],
      };
    }),
  };
}
const SOURCE = urlOf("co-ahrb-aht-023");

function database(seeds: Seed[] = SEEDS, opts: { bucket?: string | null } = {}): DatabaseSync {
  const db = new DatabaseSync(":memory:", D1_LIMITS);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(DDL);
  const bucket = opts.bucket === undefined ? BUCKET : opts.bucket;
  db.prepare("INSERT INTO federations VALUES ('fed-1', 'neogranadina-fed', ?, ?, 'Alojado en la prueba.', 'Hosted on the test.')").run(BASE, bucket);
  db.exec(
    `INSERT INTO tenants VALUES ('${TENANT}', 'neogranadina', 'fed-1', NULL, 'isadg', 'https://site.test', 'Sitio', 'Proveedor', ` +
      `'https://provider.test', 'https://mets.test'), ('t-2', 'other', 'fed-1', NULL, 'isadg', NULL, NULL, NULL, NULL, NULL);`,
  );
  db.exec(`INSERT INTO users (id, email, name, tenant_id, is_admin) VALUES ('user_001', 'admin@example.org', 'Admin', '${TENANT}', 1);`);
  db.prepare("INSERT INTO repositories VALUES (?, ?, 'AHRB', 'Archivo Histórico Regional de Boyacá', 'Tunja', 'Boyacá', 'Colombia', 'CO', ?, 'Crédito', 'Credit', NULL, NULL)")
    .run(REPO, TENANT, RIGHTS);
  db.prepare("INSERT INTO repositories VALUES (?, ?, 'NR', 'Sin derechos', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)").run(REPO_NORIGHTS, TENANT);
  for (const s of seeds) {
    const r: Seed = { tenant_id: TENANT, repository_id: REPO, updated_at: OLD, created_at: 1, is_published: 1, ...s };
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO descriptions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
  }
  return db;
}

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

const HEADER = [
  "op", "reference_code", "field", "current_value", "new_value", "fisqua_id", "images", "source_manifest", "first_image", "last_image",
  "n_images", "former_code", "merged_into", "parent_code", "description_level", "title", "date_expression", "extent", "is_published", "rule", "changelog_note",
];
type Cells = Record<string, string>;
const csvOf = (header: string[], rows: Cells[]) =>
  [header.join(","), ...rows.map((r) => header.map((h) => {
    const v = r[h] ?? "";
    return /[",\n\r]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";

const images = (code: string, files: string[], sources = [SOURCE], over: Cells = {}): Cells => ({
  op: "set-images", reference_code: code, images: files.join(" "), source_manifest: sources.join(" "), first_image: files[0] ?? "",
  last_image: files[files.length - 1] ?? "", n_images: String(files.length), rule: "images by stamped folio",
  changelog_note: `Images attached for ${code}.`, ...over,
});
const former = (code: string, formerCode: string): Cells => ({
  op: "add-former-code", reference_code: code, former_code: formerCode, changelog_note: `Former code ${formerCode} kept on ${code}.`,
});
const remove = (code: string, into: string): Cells => ({
  op: "delete-description", reference_code: code, merged_into: into, changelog_note: `Deleted ${code}, joined to ${into}.`,
});
const update = (d: Seed, field: string, current: string, next: string): Cells => ({
  op: "update-field", reference_code: String(d.reference_code), field, current_value: current, new_value: next, changelog_note: "Corrección",
});
const create = (code: string, over: Cells = {}): Cells => ({
  op: "create-description", reference_code: code, parent_code: String(L.reference_code), description_level: "item", title: `Documento ${code}`, date_expression: "1682",
  extent: "Folios: 9r-9v", is_published: "1", changelog_note: `Created ${code}.`, ...over,
});

// ---------------------------------------------------------------------------
// The run, against node:sqlite and an in-memory bucket
// ---------------------------------------------------------------------------

function applyAsOneUnit(db: DatabaseSync, statements: string[]): void {
  db.exec("BEGIN");
  try {
    db.exec(statements.join("\n"));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The bucket and the public host: what is put under a key is what its address returns. */
type Store = Map<string, string>;
const storeWith = (...manifests: Array<Record<string, any>>): Store =>
  new Map(manifests.map((m) => [m.id as string, JSON.stringify(m) + "\n"]));

interface Run { report: DescriptionsReport; written: Map<string, string>; applied: string[][]; puts: string[]; events: string[]; fetched: string[] }

async function run(
  db: DatabaseSync,
  store: Store,
  rows: Cells[],
  opts: {
    apply?: boolean; file?: string; header?: string[];
    beforeApply?: (db: DatabaseSync) => void; beforeUpload?: (db: DatabaseSync) => void;
    answer?: (url: string) => { status: number; text?: string } | undefined;
    readBack?: (url: string, text: string) => string;
  } = {},
): Promise<Run> {
  const written = new Map<string, string>();
  const applied: string[][] = [];
  const puts: string[] = [];
  const events: string[] = [];
  const fetched: string[] = [];
  const name = opts.file ?? FILE;
  const report = await runDescriptions(
    { file: name, rows: parseDescriptionChangeFile(csvOf(opts.header ?? HEADER, rows), name) },
    { target: "staging", tenant: "neogranadina", actorEmail: "admin@example.org", apply: opts.apply ?? false, confirmProduction: false },
    {
      rows: async (sql) => d1Read(db, sql),
      writeFile: (p, t) => written.set(p, t),
      createFile: (p, t) => {
        if (written.has(p)) throw new Error(`EEXIST: ${p}`);
        written.set(p, t);
      },
      readFile: (p) => written.get(p) ?? "",
      newId: () => "0f1e2d3c-0000-4000-8000-000000000000",
      applyFile: (_p, statements) => {
        events.push("apply");
        applied.push(statements);
        opts.beforeApply?.(db);
        applyAsOneUnit(db, statements);
      },
      now: () => NOW,
      fetchManifest: async (url) => {
        fetched.push(url);
        // A fetch of this store ignores the query.
        const key = url.replace(/[?#].*$/, "");
        const forced = opts.answer?.(key);
        if (forced) return forced;
        const held = store.get(key);
        if (held === undefined) return { status: 404 };
        return { status: 200, text: opts.readBack && events.some((e) => e.startsWith("put")) ? opts.readBack(key, held) : held };
      },
      putObject: (bucket, key, body, path) => {
        if (puts.length === 0) opts.beforeUpload?.(db);
        expect(bucket).toBe(BUCKET);
        expect(written.get(path)).toBe(body);
        events.push(`put ${key}`);
        puts.push(key);
        store.set(`${BASE}/${key}`, body);
      },
    },
    () => {},
  );
  return { report, written, applied, puts, events, fetched };
}

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Array<Record<string, any>>;
const byCode = (db: DatabaseSync, code: string) => all(db, `SELECT * FROM descriptions WHERE tenant_id = '${TENANT}' AND reference_code = '${code}'`)[0];
const reasons = (r: DescriptionsReport) => r.refusals.map((f) => `${f.ref}: ${f.reason}`).join("\n");
const statuses = (r: DescriptionsReport) => r.rows.map((x) => x.status);
const count = (db: DatabaseSync, sql: string) => Number(all(db, sql)[0].n);
const snapshot = (db: DatabaseSync) => JSON.stringify([all(db, "SELECT * FROM descriptions ORDER BY id"), all(db, "SELECT * FROM changelog ORDER BY id")]);

/** The manifest a record's fields build, as `resolveManifestInputs` gives its top. */
function top(code: string, fields: { title: string; extent: string | null; scope: string | null; date?: string | null; language?: string | null }) {
  return resolveManifestInputs(
    BASE, code,
    { referenceCode: code, title: fields.title, dateExpression: fields.date ?? null, extent: fields.extent, language: fields.language ?? null, accessConditions: null, scopeContent: fields.scope },
    {
      id: REPO, code: "AHRB", name: "Archivo Histórico Regional de Boyacá", city: "Tunja", region: "Boyacá", country: "Colombia", countryCode: "CO",
      manifestRights: RIGHTS, creditStatementEs: "Crédito", creditStatementEn: "Credit", attributionEn: null, attributionEs: null,
    },
    { publicSiteUrl: "https://site.test", publicSiteName: "Sitio", providerName: "Proveedor", providerUrl: "https://provider.test", metsBaseUrl: "https://mets.test" },
    { hostingStatementEs: "Alojado en la prueba.", hostingStatementEn: "Hosted on the test." },
  ) as Record<string, any>;
}

const legajo = () => sourceManifest("co-ahrb-aht-023", "co-ahrb-aht-023", [1, 2, 3, 4, 5, 6, 7, 8]);

// ---------------------------------------------------------------------------
// set-images
// ---------------------------------------------------------------------------

describe("set-images", () => {
  it("builds the manifest from the source's canvases in the row's order, uploads it before the SQL file, then writes the record", async () => {
    const db = database();
    const store = storeWith(legajo());
    const rows = [images(String(D1.reference_code), [file(3), file(1), file(2)])];
    const dry = await run(db, store, rows);
    expect(reasons(dry.report)).toBe("");
    expect(dry.report.outcome).toBe("dry run");
    expect(dry.puts).toEqual([]);
    expect(dry.report.manifests).toEqual([{ line: 2, code: D1.reference_code, url: urlOf(String(D1.reference_code)), canvases: 3, held: "absent", bytes: null, upload: true }]);
    // The dry run keeps the manifest it would upload beside the report.
    const key = `iiif/${D1.reference_code}/manifest.json`;
    const kept = [...dry.written].find(([p]) => p.endsWith(`/manifests/${key}`))![1];
    expect(kept.endsWith("}\n")).toBe(true);

    const { report, events, puts } = await run(db, store, rows, { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");
    expect(puts).toEqual([key]);
    expect(events.indexOf(`put ${key}`)).toBeLessThan(events.indexOf("apply"));

    const m = JSON.parse(store.get(urlOf(String(D1.reference_code)))!);
    const at = urlOf(String(D1.reference_code)).replace(/\/manifest\.json$/, "");
    expect(Object.keys(m)).toEqual(["@context", "id", "type", "label", "metadata", "summary", "requiredStatement", "rights", "provider", "seeAlso", "homepage", "behavior", "items"]);
    const t = top(String(D1.reference_code), { title: String(D1.title), extent: String(D1.extent), scope: String(D1.scope_content), date: "1682", language: "Spanish" });
    expect(m).toMatchObject({ id: t.id, label: t.label, metadata: t.metadata, summary: t.summary, requiredStatement: t.required_statement, rights: RIGHTS, behavior: ["paged"] });
    expect(m.items.map((c: any) => c.items[0].items[0].body.id)).toEqual([3, 1, 2].map((n) => `https://iiif.test/co-ahrb-aht-023/img_${pad(n)}/full/max/0/default.jpg`));
    const src = legajo().items[2];
    expect(m.items[0]).toEqual({
      ...src, id: `${at}/canvas/1`, label: { none: ["img 1"] },
      items: [{ ...src.items[0], id: `${at}/canvas/1/page`, items: [{ ...src.items[0].items[0], id: `${at}/canvas/1/annotation`, target: `${at}/canvas/1` }] }],
    });

    const d = byCode(db, String(D1.reference_code));
    expect(d).toMatchObject({ iiif_manifest_url: urlOf(String(D1.reference_code)), has_digital: 1, updated_by: "user_001", extent: D1.extent });
    expect(d.updated_at).toBeGreaterThan(OLD);
    const logs = all(db, "SELECT * FROM changelog");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ id: await descriptionJournalId(TENANT, FILE, String(D1.id)), kind: "update", note: `Images attached for ${D1.reference_code}.`, run_id: null });
    expect(JSON.parse(logs[0].diff)).toEqual({ iiifManifestUrl: { old: null, new: urlOf(String(D1.reference_code)) }, hasDigital: { old: false, new: true } });

    // Run again: the row is done on this file's changelog row, and nothing is uploaded or written.
    const before = snapshot(db);
    const again = await run(db, store, rows, { apply: true });
    expect(again.report.outcome).toBe("nothing to write");
    expect(statuses(again.report)).toEqual(["already updated"]);
    expect(again.puts).toEqual([]);
    expect(snapshot(db)).toBe(before);
    expect(again.report.totals).toMatchObject({ manifests: 1, uploads: 0, manifestsSame: 1, manifestBytesSame: 1 });
  });

  it("plans a record that already names its own address, with the manifest built there, as same, and compares its bytes", async () => {
    const db = database();
    const store = storeWith(legajo());
    const rows = [images(String(D1.reference_code), [file(1), file(2)])];
    await run(db, store, rows, { apply: true, file: "first.csv" });
    const same = await run(db, store, rows);
    expect(reasons(same.report)).toBe("");
    expect(statuses(same.report)).toEqual(["same"]);
    expect(same.report.manifests[0]).toMatchObject({ held: "same", bytes: "same", upload: false });

    // The same JSON in other bytes is still the manifest built, and the report says the bytes differ.
    const url = urlOf(String(D1.reference_code));
    store.set(url, JSON.stringify(JSON.parse(store.get(url)!), null, 2));
    const spaced = await run(db, store, rows);
    expect(statuses(spaced.report)).toEqual(["same"]);
    expect(spaced.report.manifests[0]).toMatchObject({ held: "same", bytes: "differ" });
  });

  it("takes canvases from two manifests, matching each file on its volume and number, and builds with the extent the file leaves", async () => {
    const other = sourceManifest("co-ahrb-aht-024", "co-ahrb-aht-024", [1, 2]);
    // An item manifest of the volume, whose segment is the volume and an item suffix.
    const itemSource = sourceManifest("co-ahrb-aht-023-d004", "ahrb-aht-023-d004", [9]);
    const db = database();
    const store = storeWith(legajo(), other, itemSource);
    const rows = [
      update(D1, "extent", String(D1.extent), "Folios: 1r-3v"),
      images(String(D1.reference_code), [file(1), file(2, "AHRB_AHT_024"), file(9)], [SOURCE, urlOf("co-ahrb-aht-024"), urlOf("co-ahrb-aht-023-d004")]),
    ];
    const { report } = await run(db, store, rows, { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const m = JSON.parse(store.get(urlOf(String(D1.reference_code)))!);
    expect(m.items.map((c: any) => c.items[0].items[0].body.id)).toEqual([
      "https://iiif.test/co-ahrb-aht-023/img_0001/full/max/0/default.jpg",
      "https://iiif.test/co-ahrb-aht-024/img_0002/full/max/0/default.jpg",
      "https://iiif.test/ahrb-aht-023-d004/img_0009/full/max/0/default.jpg",
    ]);
    expect(m.metadata).toEqual(top(String(D1.reference_code), { title: String(D1.title), extent: "Folios: 1r-3v", scope: null, date: "1682", language: "Spanish" }).metadata);
    // One record, one version, one changelog row for the extent and the images.
    const logs = all(db, "SELECT * FROM changelog");
    expect(logs).toHaveLength(1);
    expect(Object.keys(JSON.parse(logs[0].diff))).toEqual(["extent", "iiifManifestUrl", "hasDigital"]);
    expect(logs[0].note).toBe(`Corrección\nImages attached for ${D1.reference_code}.`);
  });

  it("refuses an address that holds another manifest, whoever names it, and overwrites nothing", async () => {
    const db = database();
    const url = urlOf(String(D1.reference_code));
    const stale = JSON.stringify({ id: url, type: "Manifest", items: [] }) + "\n";
    const store = storeWith(legajo());
    store.set(url, stale);
    const { report, puts, applied } = await run(db, store, [images(String(D1.reference_code), [file(1)])], { apply: true });
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/line 2: its address .*co-ahrb-aht-023-d001\/manifest.json already holds a manifest other than the one built/);
    expect(puts).toEqual([]);
    expect(applied).toEqual([]);
    expect(store.get(url)).toBe(stale);
  });

  it("uploads nothing when a manifest lands at the address after the plan, before the put", async () => {
    const db = database();
    const url = urlOf(String(D1.reference_code));
    const store = storeWith(legajo());
    const other = JSON.stringify({ id: url, type: "Manifest", items: [] }) + "\n";
    let reads = 0;
    const before = snapshot(db);
    await expect(run(db, store, [images(String(D1.reference_code), [file(1)])], {
      apply: true,
      // The plan reads the address empty; the read just before the put finds a manifest there.
      answer: (u) => (u === url && ++reads > 1 ? { status: 200, text: other } : undefined),
    })).rejects.toThrow(/its address .* holds a manifest it did not hold when the plan read it \(HTTP 200\); nothing more was uploaded, and nothing was written to D1/);
    expect(store.has(url)).toBe(false);
    expect(snapshot(db)).toBe(before);
  });

  describe("a refusal stops the run before any upload or write", () => {
    async function refused(rows: Cells[], pattern: RegExp, setup: { seeds?: Seed[]; store?: Store; answer?: (url: string) => { status: number; text?: string } | undefined } = {}) {
      const db = database(setup.seeds);
      const store = setup.store ?? storeWith(legajo());
      const before = snapshot(db);
      const { report, puts, applied } = await run(db, store, rows, { apply: true, answer: setup.answer });
      expect(report.outcome).toBe("refused");
      expect(reasons(report)).toMatch(pattern);
      expect(puts).toEqual([]);
      expect(applied).toEqual([]);
      expect(snapshot(db)).toBe(before);
    }
    const code = String(D1.reference_code);

    it("on a count, first or last image that disagrees with the images", async () => {
      await refused([images(code, [file(1), file(2)], [SOURCE], { n_images: "3" })], /n_images is "3" but images names 2/);
      await refused([images(code, [file(1), file(2)], [SOURCE], { first_image: file(2) })], /first_image .* is not the first of images/);
      await refused([images(code, [file(1), file(2)], [SOURCE], { last_image: file(1) })], /last_image .* is not the last of images/);
    });
    it("on an image named twice, a file name not of the image form, or no source", async () => {
      await refused([images(code, [file(1), file(1)])], /is named twice/);
      await refused([images(code, ["photo.jpg"])], /photo.jpg is not an image file name/);
      await refused([images(code, [file(1)], [])], /no source manifest is given/);
    });
    it("on an image found in no source, including one of the same number in another volume", async () => {
      await refused([images(code, [file(9)])], /not in .*: AHRB_AHT_023-img_0009.jpg \(ahrb-aht-023, img_0009\)/);
      await refused([images(code, [file(1, "AHRB_AHT_099")])], /not in .*AHRB_AHT_099-img_0001.jpg/);
    });
    it("on a source that cannot be fetched, is not an absolute URL, or whose id is not its address", async () => {
      await refused([images(code, [file(1)], [urlOf("co-missing")])], /the source manifest .*co-missing.* cannot be fetched: HTTP 404/);
      await refused([images(code, [file(1)], ["manifest.json"])], /the source manifest manifest.json is not an absolute URL/);
      const moved = { ...legajo(), id: urlOf("co-elsewhere") };
      await refused([images(code, [file(1)])], /is not the manifest at its address: its id is/, { store: new Map([[SOURCE, JSON.stringify(moved)]]) });
    });
    it("on a number shown by two canvases of a source, and on two file names for one canvas", async () => {
      const doubled = legajo();
      doubled.items.push(structuredClone(doubled.items[0]));
      await refused([images(code, [file(1)])], /img_0001 is shown by 2 canvases of/, { store: storeWith(doubled) });
      await refused([images(code, [file(1), "AHRB_AHT_023-img_0001.png"])], /name the same canvas/);
    });
    it("on a record that already points at another manifest", async () => {
      await refused([images(code, [file(1)])], /the record already has a manifest, https:\/\/elsewhere.test\/m.json/, {
        seeds: [F, L, item(1, { iiif_manifest_url: "https://elsewhere.test/m.json" }), D2, D3, D4],
      });
    });
    it("on a record that names its own address when the address does not hold the manifest built", async () => {
      const seeds = [F, L, item(1, { iiif_manifest_url: urlOf(code), has_digital: 1 }), D2, D3, D4];
      await refused([images(code, [file(1)])], /it would replace an established manifest at/, { seeds });
      const store = storeWith(legajo(), { id: urlOf(code), type: "Manifest", items: [] });
      await refused([images(code, [file(1)])], /it would replace an established manifest at/, { seeds, store });
    });
    it("on an address that cannot be read conclusively", async () => {
      await refused([images(code, [file(1)])], /the destination .* cannot be read conclusively: HTTP 500/, { answer: (u) => (u === urlOf(code) ? { status: 500 } : undefined) });
      await refused([images(code, [file(1)])], /cannot be read conclusively: HTTP 200 \(not JSON/, { answer: (u) => (u === urlOf(code) ? { status: 200, text: "<html>" } : undefined) });
    });
    it("on an address holding a manifest no record names, which another row of the file reads as a source", async () => {
      // d002's address holds a manifest no record names; d001 takes its canvases from it, under another spelling of the address.
      const d2source = sourceManifest(String(D2.reference_code), "co-ahrb-aht-023", [5]);
      const store = storeWith(legajo(), d2source);
      await refused(
        [images(String(D2.reference_code), [file(1)]), images(code, [file(5)], [`${urlOf(String(D2.reference_code))}#x`])],
        /line 2: its address .*co-ahrb-aht-023-d002\/manifest.json already holds a manifest other than the one built/,
        { store },
      );
    });
    it("on a record given images twice, an update of its address in the same file, or a record the file deletes", async () => {
      await refused([images(code, [file(1)]), images(code, [file(2)])], /is given images again \(line 2\)/);
      await refused([update(D1, "iiif_manifest_url", "", "https://x.test/m.json"), images(code, [file(1)])], /has an update-field row on iiif_manifest_url/);
      await refused([images(code, [file(1)]), remove(code, String(D2.reference_code))], /is deleted by line 3/);
    });
    it("on a repository without manifest rights, and a code no description holds", async () => {
      await refused([images(code, [file(1)])], /its manifest fields cannot be built: Repository NR has no manifest rights/, {
        seeds: [F, L, item(1, { repository_id: REPO_NORIGHTS }), D2, D3, D4],
      });
      await refused([images("co-ahrb-aht-023-d099", [file(1)])], /no description of neogranadina has the reference code co-ahrb-aht-023-d099/);
    });
  });

  it("stops the run on a federation without a manifest bucket", async () => {
    const db = database(SEEDS, { bucket: null });
    await expect(run(db, storeWith(legajo()), [images(String(D1.reference_code), [file(1)])])).rejects.toThrow(/no manifest_base_url or manifest_bucket/);
  });

  it("stops before D1 is written when an uploaded manifest does not read back as uploaded", async () => {
    const db = database();
    const before = snapshot(db);
    await expect(run(db, storeWith(legajo()), [images(String(D1.reference_code), [file(1)])], {
      apply: true, readBack: (url, held) => (url === urlOf(String(D1.reference_code)) ? JSON.stringify({ ...JSON.parse(held), label: { es: ["x"] } }) : held),
    })).rejects.toThrow(/does not read back as uploaded; nothing has been written to D1/);
    expect(snapshot(db)).toBe(before);
  });

  it("uploads nothing and writes nothing when the record changes after the plan, before the upload", async () => {
    const db = database();
    const store = storeWith(legajo());
    const before = store.size;
    // The record is saved between the apply's plan and its uploads: the check before the first put sees it.
    let saved = false;
    const rows = [images(String(D1.reference_code), [file(1)])];
    const runWithSave = run(db, store, rows, {
      apply: true,
      answer: (url) => {
        if (url === urlOf(String(D1.reference_code)) && !saved) {
          saved = true;
          db.exec(`UPDATE descriptions SET updated_at = ${OLD + 1} WHERE id = '${D1.id}'`);
        }
        return undefined;
      },
    });
    await expect(runWithSave).rejects.toThrow(/changed after the plan read it; nothing was uploaded or written/);
    expect(store.size).toBe(before);
  });

  it("leaves the manifests at addresses no record names when the SQL file is refused, and a rerun finds them held", async () => {
    const db = database();
    const store = storeWith(legajo());
    const rows = [images(String(D1.reference_code), [file(1)])];
    await expect(run(db, store, rows, {
      apply: true, beforeApply: (x) => x.exec(`UPDATE descriptions SET title = 'Otro' WHERE id = '${D1.id}'`),
    })).rejects.toThrow(/malformed JSON|ABORT/);
    expect(store.has(urlOf(String(D1.reference_code)))).toBe(true);
    expect(byCode(db, String(D1.reference_code)).iiif_manifest_url).toBe(null);
    db.exec(`UPDATE descriptions SET title = '${D1.title}' WHERE id = '${D1.id}'`);
    const again = await run(db, store, rows, { apply: true });
    expect(again.report.outcome).toBe("verified");
    expect(again.report.manifests[0]).toMatchObject({ held: "same", upload: false });
    expect(again.puts).toEqual([]);
  });

  it("gives a record the file creates its images, in its create, and runs again as done", async () => {
    const db = database();
    const store = storeWith(legajo());
    const code = "co-ahrb-aht-023-d005";
    const rows = [create(code), images(code, [file(6), file(7)])];
    const { report } = await run(db, store, rows, { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const d = byCode(db, code);
    expect(d).toMatchObject({ iiif_manifest_url: urlOf(code), has_digital: 1, repository_id: REPO, extent: "Folios: 9r-9v" });
    const logs = all(db, `SELECT * FROM changelog WHERE record_id = '${d.id}'`);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0].diff)).toMatchObject({ iiifManifestUrl: { old: null, new: urlOf(code) }, hasDigital: { old: null, new: true } });
    const m = JSON.parse(store.get(urlOf(code))!);
    expect(m.metadata).toEqual(top(code, { title: `Documento ${code}`, extent: "Folios: 9r-9v", scope: null, date: "1682" }).metadata);
    const again = await run(db, store, rows, { apply: true });
    expect(statuses(again.report)).toEqual(["already created", "already updated"]);
    expect(again.report.outcome).toBe("nothing to write");
  });

  it("refuses a record the file creates whose address holds another manifest", async () => {
    const db = database();
    const code = "co-ahrb-aht-023-d005";
    const store = storeWith(legajo(), { id: urlOf(code), type: "Manifest", items: [] });
    const { report } = await run(db, store, [create(code), images(code, [file(6)])]);
    expect(reasons(report)).toMatch(/line 3: its address .* already holds a manifest/);
  });
});

// ---------------------------------------------------------------------------
// add-former-code
// ---------------------------------------------------------------------------

describe("add-former-code", () => {
  it("appends the code under former-reference-code, keeping the text read, and runs again as done", async () => {
    const legacy = '[{"provider":"django-zasqua","id":42579},{"provider":"ca-object","id":78279}]';
    const db = database([F, L, item(1, { legacy_ids: legacy }), D2, D3, D4]);
    const store = storeWith(legajo());
    const rows = [former(String(D1.reference_code), "co-ahrb-aht-023-d099")];
    const { report } = await run(db, store, rows, { apply: true });
    expect(report.outcome).toBe("verified");
    const d = byCode(db, String(D1.reference_code));
    expect(d.legacy_ids).toBe(`${legacy.slice(0, -1)},{"provider":"former-reference-code","id":"co-ahrb-aht-023-d099"}]`);
    const [log] = all(db, "SELECT * FROM changelog");
    expect(JSON.parse(log.diff)).toEqual({ legacyIds: { old: legacy, new: d.legacy_ids } });
    const again = await run(db, store, rows);
    expect(statuses(again.report)).toEqual(["already updated"]);
    const other = await run(db, store, rows, { file: "other.csv" });
    expect(statuses(other.report)).toEqual(["same"]);
  });

  it("refuses a code another description holds, its own code, a code named twice, a legacy_ids that is not a list, and a code the file creates", async () => {
    const db = database([F, L, D1, D2, item(3, { legacy_ids: '{"a":1}' }), D4]);
    const { report } = await run(db, storeWith(), [
      former(String(D1.reference_code), String(D2.reference_code)),
      former(String(D1.reference_code), String(D1.reference_code)),
      former(String(D4.reference_code), "co-x"),
      former(String(D4.reference_code), "co-x"),
      former(String(D3.reference_code), "co-y"),
      create("co-ahrb-aht-023-d007"),
      former(String(D4.reference_code), "co-ahrb-aht-023-d007"),
      former(String(D4.reference_code), ""),
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: former code ${D2.reference_code}: ${D2.reference_code} (${D2.id}) holds it now`,
      `${FILE} line 3: former code ${D1.reference_code} is the record's own code`,
      `${FILE} line 5: ${D4.reference_code} is given the former code co-x again (line 4)`,
      `${FILE} line 6: legacy_ids of ${D3.reference_code} is not a JSON list`,
      `${FILE} line 8: former code co-ahrb-aht-023-d007 is created by line 7`,
      `${FILE} line 9: former_code is blank`,
    ].join("\n"));
  });

  it("refuses a code a description of another tenant of the federation holds", async () => {
    const db = database([...SEEDS, { id: uuid(80), tenant_id: "t-2", reference_code: "co-otro-001", description_level: "file", title: "Ajeno", depth: 0, child_count: 0, position: 0 }]);
    const { report } = await run(db, storeWith(), [former(String(D1.reference_code), "co-otro-001")]);
    expect(reasons(report)).toMatch(/former code co-otro-001: co-otro-001 \(.*\) holds it now/);
  });
});

// ---------------------------------------------------------------------------
// delete-description
// ---------------------------------------------------------------------------

describe("delete-description", () => {
  it("joins one record into another: images from both, the extent, the former code, then the delete, as one file", async () => {
    // The former code holder of d002 elsewhere follows the delete, as the editor's delete moves it.
    const holder = item(4, { legacy_ids: `[{"provider":"former-reference-code","id":"${D2.reference_code}"}]` });
    const db = database([F, L, D1, D2, D3, holder]);
    db.exec(`INSERT INTO description_entities VALUES ('de-1', '${D2.id}', 'e-1'); INSERT INTO description_places VALUES ('dp-1', '${D2.id}', 'p-1');`);
    const store = storeWith(legajo());
    const code = String(D1.reference_code);
    const rows = [
      update(D1, "extent", String(D1.extent), "Folios: 1r-2v"),
      images(code, [file(1), file(2), file(3)]),
      former(code, String(D2.reference_code)),
      remove(String(D2.reference_code), code),
    ];
    const held = byCode(db, String(D2.reference_code));
    const { report } = await run(db, store, rows, { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");
    expect(report.deletes).toEqual([{ line: 5, code: D2.reference_code, id: D2.id, mergedInto: code, links: { entities: 1, places: 1 } }]);

    expect(byCode(db, String(D2.reference_code))).toBeUndefined();
    expect(count(db, "SELECT count(*) AS n FROM description_entities")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM description_places")).toBe(0);
    const parent = byCode(db, String(L.reference_code));
    expect(parent).toMatchObject({ child_count: 3 });
    expect(parent.updated_at).toBeGreaterThan(OLD);
    expect(byCode(db, String(D4.reference_code)).updated_at).toBeGreaterThan(OLD);
    const survivor = byCode(db, code);
    expect(survivor).toMatchObject({ extent: "Folios: 1r-2v", iiif_manifest_url: urlOf(code), has_digital: 1 });
    expect(survivor.legacy_ids).toBe(`[{"provider":"former-reference-code","id":"${D2.reference_code}"}]`);

    const del = all(db, `SELECT * FROM changelog WHERE kind = 'delete'`);
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ id: await descriptionDeleteJournalId(TENANT, FILE, String(D2.reference_code)), record_id: D2.id, note: `Deleted ${D2.reference_code}, joined to ${code}.` });
    const snap = JSON.parse(del[0].diff);
    expect(Object.values(snap).every((e: any) => e.new === null)).toBe(true);
    expect(snap).toMatchObject({ referenceCode: { old: D2.reference_code }, title: { old: D2.title }, extent: { old: D2.extent }, updatedAt: { old: OLD } });
    expect(Object.keys(snap)).toHaveLength(Object.keys(held).length);

    // Run again: done on this file's rows.
    const before = snapshot(db);
    const again = await run(db, store, rows, { apply: true });
    expect(reasons(again.report)).toBe("");
    expect(statuses(again.report)).toEqual(["already updated", "already updated", "already updated", "already deleted"]);
    expect(again.report.outcome).toBe("nothing to write");
    expect(snapshot(db)).toBe(before);
  });

  it("deletes when the survivor already records the code, and refuses a code no description holds without this file's delete row", async () => {
    const db = database([F, L, item(1, { legacy_ids: `[{"provider":"former-reference-code","id":"${D2.reference_code}"}, 7]` }), D2, D3, D4]);
    const rows = [remove(String(D2.reference_code), String(D1.reference_code))];
    const { report } = await run(db, storeWith(), rows, { apply: true, file: "first.csv" });
    expect(report.outcome).toBe("verified");
    const other = await run(db, storeWith(), rows, { file: "second.csv" });
    expect(reasons(other.report)).toBe(`second.csv line 2: no description of neogranadina has the reference code ${D2.reference_code}, and this file has not deleted it`);
  });

  describe("refuses", () => {
    const into = String(D1.reference_code);
    const recorded = (code: string) => item(1, { legacy_ids: `[{"provider":"former-reference-code","id":"${code}"}]` });
    async function refusedDelete(rows: Cells[], pattern: RegExp, seeds: Seed[], setup?: (db: DatabaseSync) => void) {
      const db = database(seeds);
      setup?.(db);
      const before = snapshot(db);
      const { report, applied } = await run(db, storeWith(), rows, { apply: true });
      expect(report.outcome).toBe("refused");
      expect(reasons(report)).toMatch(pattern);
      expect(applied).toEqual([]);
      expect(snapshot(db)).toBe(before);
    }
    it("a record with children, or one the file creates a child under", async () => {
      await refusedDelete([remove(String(L.reference_code), String(F.reference_code))], /it has 4 children/, [F, L, D1, D2, D3, D4]);
      const empty = item(3, { child_count: 0, description_level: "file" });
      await refusedDelete(
        [create(`${D3.reference_code}-x01`, { parent_code: String(D3.reference_code) }), remove(String(D3.reference_code), into)],
        /line 3: line 2 creates a description under it/,
        [F, L, recorded(String(D3.reference_code)), D2, empty, D4],
      );
    });
    it("a record a pipeline record names", async () => {
      await refusedDelete([remove(String(D2.reference_code), into)], /1 pipeline volumes, recipe declarations or entries name it/,
        [F, L, recorded(String(D2.reference_code)), D2, D3, D4], (db) => db.exec(`INSERT INTO entries VALUES ('en-1', '${D2.id}')`));
    });
    it("a survivor that does not exist, is the record itself, is deleted in the same file, or is blank", async () => {
      const seeds = [F, L, recorded(String(D2.reference_code)), D2, D3, D4];
      await refusedDelete([remove(String(D2.reference_code), "co-none")], /merged_into co-none is not a description of neogranadina/, seeds);
      await refusedDelete([remove(String(D2.reference_code), String(D2.reference_code))], /merged_into is the record itself/, seeds);
      await refusedDelete([remove(String(D2.reference_code), into), remove(into, String(D3.reference_code))], /line 2: merged_into .* is deleted by line 3/, seeds);
      await refusedDelete([remove(String(D2.reference_code), "")], /merged_into is blank/, seeds);
    });
    it("a survivor that does not record the code as a former one, stored or added in the file", async () => {
      await refusedDelete([remove(String(D2.reference_code), into)],
        new RegExp(`the survivor ${into} does not record ${D2.reference_code} as a former code, and no add-former-code row of this file adds it`),
        [F, L, D1, D2, D3, D4]);
      await refusedDelete([former(into, "co-other"), remove(String(D2.reference_code), into)], /does not record .* as a former code/, [F, L, D1, D2, D3, D4]);
    });
    it("a record another row of the file writes", async () => {
      await refusedDelete([update(D2, "title", String(D2.title), "Otro"), remove(String(D2.reference_code), into)], /line 3: .* is also written by line 2/,
        [F, L, recorded(String(D2.reference_code)), D2, D3, D4]);
    });
  });

  it("writes nothing when the survivor changes between the plan and the write", async () => {
    const db = database();
    const code = String(D1.reference_code);
    const before = snapshot(db);
    await expect(run(db, storeWith(), [former(code, String(D2.reference_code)), remove(String(D2.reference_code), code)], {
      apply: true, beforeApply: (x) => x.exec(`UPDATE descriptions SET legacy_ids = '[]', updated_at = ${OLD + 5} WHERE id = '${D1.id}'`),
    })).rejects.toThrow(/malformed JSON|ABORT/);
    db.exec(`UPDATE descriptions SET updated_at = ${OLD} WHERE id = '${D1.id}'`);
    expect(snapshot(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The change file
// ---------------------------------------------------------------------------

describe("the change file", () => {
  it("refuses a row that fills another operation's columns", async () => {
    const db = database();
    const { report } = await run(db, storeWith(legajo()), [
      { ...images(String(D1.reference_code), [file(1)]), former_code: "co-x" },
      { ...former(String(D2.reference_code), "co-y"), merged_into: String(D1.reference_code) },
      { ...remove(String(D3.reference_code), String(D1.reference_code)), images: file(1) },
      { ...update(D4, "title", String(D4.title), "Otro"), former_code: "co-z" },
      { ...create("co-ahrb-aht-023-d009"), images: file(1) },
    ]);
    expect(reasons(report)).toBe([
      `${FILE} line 2: a set-images row fills only its own columns; this one gives former_code`,
      `${FILE} line 3: a add-former-code row fills only its own columns; this one gives merged_into`,
      `${FILE} line 4: a delete-description row fills only its own columns; this one gives images`,
      `${FILE} line 5: an update-field row fills only its own columns; this one gives former_code`,
      `${FILE} line 6: a create-description row fills only its own columns; this one gives images`,
    ].join("\n"));
  });

  it("needs each operation's columns in the header", () => {
    expect(() => parseDescriptionChangeFile("op,reference_code,images\nset-images,x,a\n", FILE)).toThrow(/missing columns source_manifest, first_image, last_image, n_images/);
    expect(() => parseDescriptionChangeFile("op,reference_code\nadd-former-code,x\n", FILE)).toThrow(/missing columns former_code/);
    expect(() => parseDescriptionChangeFile("op,reference_code\ndelete-description,x\n", FILE)).toThrow(/missing columns merged_into/);
  });
});

// ---------------------------------------------------------------------------
// Review findings: each pinned by a test
// ---------------------------------------------------------------------------

describe("the guards a review asked for", () => {
  it("refuses to delete a record with an actual child whatever its child count says, at plan and at apply", async () => {
    const recorded = item(1, { legacy_ids: `[{"provider":"former-reference-code","id":"${D2.reference_code}"}]` });
    const orphan: Seed = { ...item(5), id: uuid(50), reference_code: `${D2.reference_code}-x01`, parent_id: D2.id, local_identifier: "x" };
    const db = database([F, L, recorded, D2, D3, D4, orphan]);
    const atPlan = await run(db, storeWith(), [remove(String(D2.reference_code), String(D1.reference_code))]);
    expect(reasons(atPlan.report)).toMatch(/line 2: it has 1 children/);

    const later = database([F, L, recorded, D2, D3, D4]);
    const before = snapshot(later);
    await expect(run(later, storeWith(), [remove(String(D2.reference_code), String(D1.reference_code))], {
      apply: true,
      beforeApply: (x) => x.prepare(
        `INSERT INTO descriptions (id, tenant_id, repository_id, reference_code, description_level, title, parent_id, updated_at, created_at) ` +
          `VALUES ('${uuid(51)}', '${TENANT}', '${REPO}', 'co-late', 'item', 'Late', '${D2.id}', 1, 1)`,
      ).run(),
    })).rejects.toThrow(/malformed JSON|ABORT/);
    later.exec(`DELETE FROM descriptions WHERE id = '${uuid(51)}'`);
    expect(snapshot(later)).toBe(before);
  });

  it("stops before any upload when the tenant's federation, address or bucket changes after the plan, and guards them in the SQL file", async () => {
    const db = database();
    const store = storeWith(legajo());
    const rows = [images(String(D1.reference_code), [file(1)])];
    let changed = false;
    await expect(run(db, store, rows, {
      apply: true,
      answer: (url) => {
        if (url === urlOf(String(D1.reference_code)) && !changed) {
          changed = true;
          db.exec("UPDATE federations SET manifest_bucket = 'other-bucket'");
        }
        return undefined;
      },
    })).rejects.toThrow(/federation's manifest address or bucket changed after the plan read it; nothing was uploaded or written/);
    expect(store.has(urlOf(String(D1.reference_code)))).toBe(false);

    const again = database();
    const { written } = await run(again, storeWith(legajo()), rows);
    const sql = [...written].find(([k]) => k.endsWith(".sql"))![1];
    again.exec("UPDATE federations SET manifest_base_url = 'https://elsewhere.test'");
    const failing = sql.split("\n").filter((st) => st.startsWith("SELECT CASE")).filter((st) => {
      try { again.prepare(st).all(); return false; } catch { return true; }
    });
    expect(failing.join("\n")).toMatch(/manifest address or bucket has changed since it was read/);
  });

  it("refuses set-images on a record whose repository the same file changes", async () => {
    const db = database();
    const { report } = await run(db, storeWith(legajo()), [
      update(D1, "repository_id", REPO, REPO_NORIGHTS),
      images(String(D1.reference_code), [file(1)]),
    ]);
    expect(reasons(report)).toMatch(/line 3: .* has an update-field row on repository_id in this file \(line 2\)/);
  });

  it("refuses an update-field row on has_digital for a record a set-images row of the same file gives images", async () => {
    const db = database();
    const code = String(D1.reference_code);
    const { report } = await run(db, storeWith(legajo()), [
      update(D1, "has_digital", "0", "1"),
      images(code, [file(1)]),
    ]);
    expect(reasons(report)).toMatch(new RegExp(`line 2: ${code} is given images by line 3, which sets has_digital; change has_digital in another file`));
  });

  it("refuses two rows that give one former code to two records", async () => {
    const db = database();
    const { report } = await run(db, storeWith(), [former(String(D1.reference_code), "co-x"), former(String(D3.reference_code), "co-x")]);
    expect(reasons(report)).toMatch(/line 3: former code co-x is given to .* by line 2/);
  });

  it("aborts when a description of the federation takes a former code as its reference code after the plan", async () => {
    const db = database();
    const before = snapshot(db);
    await expect(run(db, storeWith(), [former(String(D1.reference_code), "co-otro-009")], {
      apply: true,
      beforeApply: (x) => x.prepare(
        `INSERT INTO descriptions (id, tenant_id, repository_id, reference_code, description_level, title, updated_at, created_at) ` +
          `VALUES ('${uuid(81)}', 't-2', '${REPO}', 'co-otro-009', 'file', 'Ajeno', 1, 1)`,
      ).run(),
    })).rejects.toThrow(/malformed JSON|ABORT/);
    db.exec(`DELETE FROM descriptions WHERE id = '${uuid(81)}'`);
    expect(snapshot(db)).toBe(before);
  });

  it("verifies a file that adds a code the record holds and a new one, and runs again as same and already updated", async () => {
    const legacy = '[{"provider":"former-reference-code","id":"co-x"}]';
    const db = database([F, L, item(1, { legacy_ids: legacy }), D2, D3, D4]);
    const rows = [former(String(D1.reference_code), "co-x"), former(String(D1.reference_code), "co-y")];
    const { report } = await run(db, storeWith(), rows, { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.outcome).toBe("verified");
    const again = await run(db, storeWith(), rows);
    expect(reasons(again.report)).toBe("");
    expect(statuses(again.report)).toEqual(["same", "already updated"]);
  });
});

describe("the guards a second review asked for", () => {
  it("refuses a former code the record already records when the same file creates it as a live code", async () => {
    const legacy = '[{"provider":"former-reference-code","id":"co-ahrb-aht-023-d009"}]';
    const db = database([F, L, item(1, { legacy_ids: legacy }), D2, D3, D4]);
    const before = snapshot(db);
    const { report, applied } = await run(db, storeWith(), [former(String(D1.reference_code), "co-ahrb-aht-023-d009"), create("co-ahrb-aht-023-d009")], { apply: true });
    expect(report.outcome).toBe("refused");
    expect(reasons(report)).toMatch(/line 2: former code co-ahrb-aht-023-d009 is created by line 3/);
    expect(applied).toEqual([]);
    expect(snapshot(db)).toBe(before);
  });

  it("aborts a file of former codes when the tenant moves to a federation that holds the code as a live one", async () => {
    const db = database();
    db.exec("INSERT INTO federations (id, slug) VALUES ('fed-2', 'other-fed')");
    db.exec("INSERT INTO tenants (id, slug, federation_id) VALUES ('t-3', 'third', 'fed-2')");
    db.prepare(
      `INSERT INTO descriptions (id, tenant_id, repository_id, reference_code, description_level, title, updated_at, created_at) ` +
        `VALUES ('${uuid(82)}', 't-3', '${REPO}', 'co-tercero-001', 'file', 'Tercero', 1, 1)`,
    ).run();
    const before = snapshot(db);
    await expect(run(db, storeWith(), [former(String(D1.reference_code), "co-tercero-001")], {
      apply: true,
      beforeApply: (x) => x.exec(`UPDATE tenants SET federation_id = 'fed-2' WHERE id = '${TENANT}'`),
    })).rejects.toThrow(/malformed JSON|ABORT/);
    db.exec(`UPDATE tenants SET federation_id = 'fed-1' WHERE id = '${TENANT}'`);
    expect(snapshot(db)).toBe(before);
  });

  it("gives images beside an update-field row that leaves the repository as it is, and runs again as already updated", async () => {
    const db = database();
    const store = storeWith(legajo());
    const rows = [update(D1, "repository_id", REPO, REPO), images(String(D1.reference_code), [file(1)])];
    const { report } = await run(db, store, rows, { apply: true });
    expect(reasons(report)).toBe("");
    expect(report.outcome).toBe("verified");
    const again = await run(db, store, rows);
    expect(reasons(again.report)).toBe("");
    expect(statuses(again.report)).toEqual(["same", "already updated"]);
  });
});

// @version v0.9.0
