/**
 * Tests — the command line's export
 *
 * This suite pins `scripts/lib/export-cli/`, the reader behind
 * `scripts/fisqua.ts export`. The run is driven against an in-memory
 * `node:sqlite` database holding the columns the export reads, through
 * an injected D1 runner that records every statement and the clock time
 * it was sent; the clock, the wait, the login-page fetch, the lock port
 * and the output folder are injected too, so nothing here reaches D1,
 * the network or the repository's `.import/`.
 *
 *   - the arguments: the four sets, `--fonds` once (more than once only
 *     for `pool`), `--out` required;
 *   - the statement check: exactly one SELECT, no JOIN, subquery, LIKE,
 *     COUNT or GROUP BY, refused before anything is sent;
 *   - paging: descriptions 200 a page on the fonds root, links and
 *     authorities by 100 ids, `pool` 500 a page by primary key;
 *   - pacing: at least 1 s between one statement's end and the next
 *     one's start;
 *   - overload: the first 7429 waits 180 s and runs the statement once
 *     more; a second stops the run and writes README.md;
 *   - the login page before the first statement and every 20, a non-200
 *     or a failed fetch stopping the run;
 *   - the checkpoint: a stopped run resumes to the same files as a run
 *     never stopped, and other arguments refuse;
 *   - the lock: a TCP port on 127.0.0.1, one per target; a second holder
 *     gets EADDRINUSE and refuses; the port is free again after a run
 *     ends, complete, stopped or refused; the listener's descriptor goes
 *     to every wrangler process, and a child holding it keeps the port
 *     bound after its parent's handle is closed or the parent is killed;
 *   - the pool's pages over whole tables carry no WHERE term beyond the
 *     keyset, and filter federation and merges locally;
 *   - phase files named by the full hex of the fonds code, so no two codes
 *     share one, and a name over 200 bytes refused before any read;
 *   - the wrangler call: one exec per attempt, never the retrying `runD1`,
 *     and wrangler's own `cli.js` run by node directly, never through npx
 *     or the bin that spawns it as a further child;
 *   - production statements: capped at 1,000 rows and sent through the
 *     production read lock's helper with the export lock's descriptor, a
 *     held read lock waited for, a stop at the time limit a stop of the
 *     run; and, with the real helper on a free port, an export's
 *     production statement and a `runD1` production read in another
 *     process (run under vite-node) never run at once, in either order;
 *     staging statements take no helper;
 *   - production needs `--confirm-production`, checked before any read;
 *   - the files: headers exactly those of the 9 and 14 November files,
 *     and the values formatted as they were.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSelectOnly, SelectRefusal } from "../../scripts/lib/export-cli/select-guard";
import { PacedReader, ExportStop } from "../../scripts/lib/export-cli/reader";
import {
  parseExportArgs,
  runExport,
  ExportRefusal,
  type ExportArgs,
  type ExportProviders,
} from "../../scripts/lib/export-cli/run";
import { fileSafeName } from "../../scripts/lib/export-cli/checkpoint";
import { acquirePortLock, LOCK_PORTS } from "../../scripts/lib/export-cli/lock";
import { exportD1 } from "../../scripts/lib/export-cli/d1";
import {
  LOCK_BUSY_EXIT,
  LOCK_POLL_MS,
  LOCK_TIMEOUT_EXIT,
  PRODUCTION_ATTEMPT_TIMEOUT_MS,
  PRODUCTION_LOCK_HELPER,
  PRODUCTION_READ_CAP,
  PRODUCTION_READ_GAP_MS,
  runD1,
} from "../../scripts/lib/d1-cli";

// ---------------------------------------------------------------------------
// The reference headers: those of the files in ahrb-aht/sources/fisqua/
// ---------------------------------------------------------------------------

const H_DESCRIPTIONS =
  "id,reference_code,parent_id,description_level,title,scope_content,date_expression,date_start,date_end,extent,is_published,has_digital,iiif_manifest_url,legacy_ids,created_at,updated_at,changelog_rows";
const H_ENTITY_LINKS =
  "description_reference_code,authority_id,authority_code,display_name,sort_name,surname,given_name,entity_type,authority_honorific,primary_function,name_variants,dates_of_existence,date_start,date_end,wikidata_id,viaf_id,dbe_id,legacy_ids,role,role_note,role_raw,sequence,link_honorific,link_function,name_as_recorded,link_id";
const H_PLACE_LINKS =
  "description_reference_code,authority_id,authority_code,display_name,label,place_type,name_variants,parent_id,parent_place_name,latitude,longitude,coordinate_precision,tgn_id,hgis_id,whg_id,fclass,legacy_ids,role,role_note,role_raw,link_id";
const H_FED_ENTITIES =
  "id,entity_code,display_name,sort_name,surname,given_name,entity_type,honorific,primary_function,name_variants,dates_of_existence,date_start,date_end,federation_id,tenant_id,links_total,links_aht,links_cab";
const H_FED_PLACES =
  "id,place_code,label,display_name,place_type,name_variants,latitude,longitude,federation_id,links_total,links_aht,links_cab";
const H_LINK_COUNTS = "fonds_prefix,entity_links,distinct_entities,place_links,distinct_places";
const H_PRIMARY_FUNCTIONS = "primary_function,entities";

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

const DDL = `
CREATE TABLE federations (id TEXT PRIMARY KEY, slug TEXT);
CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, federation_id TEXT);
CREATE TABLE descriptions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT, root_description_id TEXT,
  reference_code TEXT NOT NULL, description_level TEXT NOT NULL, title TEXT NOT NULL, scope_content TEXT,
  date_expression TEXT, date_start TEXT, date_end TEXT, extent TEXT, is_published INTEGER, has_digital INTEGER,
  iiif_manifest_url TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX desc_ref_code_idx ON descriptions (tenant_id, reference_code);
CREATE INDEX descriptions_tenant_root_id_idx ON descriptions (tenant_id, root_description_id, id);
CREATE TABLE changelog (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, record_type TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE entities (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, entity_code TEXT, display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT,
  name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, merged_into TEXT,
  wikidata_id TEXT, viaf_id TEXT, dbe_id TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]');
CREATE TABLE places (id TEXT PRIMARY KEY, federation_id TEXT NOT NULL, tenant_id TEXT, place_code TEXT, label TEXT NOT NULL,
  display_name TEXT NOT NULL, place_type TEXT, name_variants TEXT DEFAULT '[]', parent_id TEXT, latitude REAL, longitude REAL,
  coordinate_precision TEXT, merged_into TEXT, tgn_id TEXT, hgis_id TEXT, whg_id TEXT, fclass TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]');
CREATE TABLE description_entities (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, entity_id TEXT NOT NULL, role TEXT NOT NULL,
  role_note TEXT, role_raw TEXT, sequence INTEGER NOT NULL DEFAULT 0, honorific TEXT, name_as_recorded TEXT,
  related_to TEXT REFERENCES description_entities(id) ON DELETE NO ACTION, relation_certainty TEXT, attributes TEXT NOT NULL DEFAULT '{}');
CREATE TABLE description_places (id TEXT PRIMARY KEY, description_id TEXT NOT NULL, place_id TEXT NOT NULL, role TEXT NOT NULL,
  role_note TEXT, role_raw TEXT);
`;

const FED = "fed-1";
const TENANT = "t-1";
const AHT_ROOT = "e94a342e-0766-4ee6-9f64-bfa5eb79f13e";
const CAB_ROOT = "c0000000-0000-0000-0000-000000000000";
const pad = (n: number, w = 4) => String(n).padStart(w, "0");

interface Seed {
  descriptions: number; // children of the AHT root
  rootSelf: boolean; // the root's root_description_id is its own id (else NULL)
  entities: number; // federation entities beyond the named ones
  otherEntities: number; // entities of another federation, interleaved by id
}

function database(seed: Partial<Seed> = {}): DatabaseSync {
  const s: Seed = { descriptions: 450, rootSelf: true, entities: 5, otherEntities: 0, ...seed };
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  db.exec(`INSERT INTO federations VALUES ('${FED}', 'neogranadina'), ('fed-2', 'ampl');`);
  db.exec(`INSERT INTO tenants VALUES ('${TENANT}', 'ahr', '${FED}'), ('t-2', 'sbmal', 'fed-2');`);
  const d = db.prepare(
    `INSERT INTO descriptions (id, tenant_id, parent_id, root_description_id, reference_code, description_level, title, scope_content,
      date_expression, date_start, date_end, extent, is_published, has_digital, iiif_manifest_url, legacy_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  d.run(AHT_ROOT, TENANT, null, s.rootSelf ? AHT_ROOT : null, "co-ahrb-aht", "fonds", "Fondo Archivo Histórico de Tunja",
    null, null, null, null, null, 1, 0, null, '[{"provider":"django-zasqua","id":299},{"provider":"ca-collection","id":14806}]',
    1765444658000, 1765444658000);
  for (let i = 1; i <= s.descriptions; i++) {
    d.run(`a-${pad(i)}`, TENANT, AHT_ROOT, AHT_ROOT, `co-ahrb-aht-${pad(i, 3)}`, "item",
      i === 1 ? "Mortuoria y testamento de Francisco Hernández Hermoso, natural de Tunja" : `Legajo ${pad(i, 3)}`,
      i === 1 ? 'Dice "testamento"\nen dos líneas' : null, "1574-09-04", "1574-09-04", "1574-09-04", "Folios: 001r-012v",
      1, i === 1 ? 1 : 0, null, `[{"provider":"django-zasqua","id":${100000 + i}}]`, 1765538664000, 1773635476000);
  }
  d.run(CAB_ROOT, TENANT, null, CAB_ROOT, "co-ahrb-cab", "fonds", "Fondo Cabildo", null, null, null, null, null, 1, 0, null, "[]", 1, 1);
  d.run("c-0001", TENANT, CAB_ROOT, CAB_ROOT, "co-ahrb-cab-001", "item", "Cabildo", null, null, null, null, null, 1, 0, null, "[]", 1, 1);
  // A description of another fonds and of another tenant, never read.
  d.run("x-0001", "t-2", null, "x-0001", "co-ahrb-aht", "fonds", "Homónimo ajeno", null, null, null, null, null, 1, 0, null, "[]", 1, 1);

  const cl = db.prepare("INSERT INTO changelog VALUES (?, ?, ?, ?)");
  cl.run("cl-1", "a-0001", "description", 1);
  cl.run("cl-2", "a-0001", "description", 2);
  cl.run("cl-3", "a-0002", "description", 3);
  cl.run("cl-4", "a-0001", "entity", 4); // another record type
  cl.run("cl-5", AHT_ROOT, "description", 5);

  const e = db.prepare(
    `INSERT INTO entities (id, federation_id, tenant_id, entity_code, display_name, sort_name, surname, given_name, entity_type,
      honorific, primary_function, name_variants, dates_of_existence, date_start, date_end, merged_into, wikidata_id, viaf_id, dbe_id, legacy_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  e.run("7855ef14-95dd-4771-b38b-fe3a319a8351", FED, null, "ne-c8sxvc", "Francisco Hernández Hermoso", "Francisco Hernández Hermoso",
    "Hernández Hermoso", "Francisco", "person", null, "Capitán", "[]", "fl. 1574", "1574-01-01", "1574-12-31", null, null, null, null,
    '[{"provider":"django-zasqua","id":853677},{"provider":"zasqua-2026-04","id":"ne-29e99"}]');
  e.run("ent-merged", FED, null, "ne-merged", "Fusionado", "Fusionado", null, null, "person", null, "Alcalde", "[]", null, null, null,
    "7855ef14-95dd-4771-b38b-fe3a319a8351", null, null, null, "[]");
  e.run("ent-other-fed", "fed-2", "t-2", "sbmal-e-1", "Ajeno", "Ajeno", null, null, "person", null, "Alcalde", "[]", null, null, null,
    null, null, null, null, "[]");
  for (let i = 1; i <= s.entities; i++) {
    const fn = i % 3 === 0 ? "Alcalde" : i % 3 === 1 ? "Regidor" : i % 2 === 0 ? "" : null;
    e.run(`ent-${pad(i)}`, FED, null, `ne-${pad(i, 6)}`, `Persona ${i}`, `Persona ${i}`, null, null, "person", "Don", fn,
      '["Otra forma"]', null, null, null, null, null, null, null, "[]");
  }
  for (let i = 1; i <= s.otherEntities; i++) {
    e.run(`ent-${pad(i)}-o`, "fed-2", "t-2", `sbmal-${pad(i, 6)}`, `Ajena ${i}`, `Ajena ${i}`, null, null, "person", null, null,
      "[]", null, null, null, null, null, null, null, "[]");
  }

  const p = db.prepare(
    `INSERT INTO places (id, federation_id, tenant_id, place_code, label, display_name, place_type, name_variants, parent_id, latitude,
      longitude, coordinate_precision, merged_into, tgn_id, hgis_id, whg_id, fclass, legacy_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  p.run("764d05a4-67d4-437f-9b61-fb2f6ad520ab", FED, null, "nl-qvk8n9", "Tunja", "Tunja", "city", '["Santiago de Tunja"]', "pl-parent",
    5.533051, -73.361339, null, null, "7005077", "lugares13k_rel:14166077", "175088", "P",
    '[{"provider":"django-zasqua","id":95648}]');
  p.run("pl-parent", FED, null, "nl-parent", "Boyacá", "Provincia de Boyacá", "province", "[]", null, 5, -73, "approximate", null,
    null, null, null, "A", "[]");
  p.run("pl-merged", FED, null, "nl-merged", "Tunxa", "Tunxa", "city", "[]", null, null, null, null,
    "764d05a4-67d4-437f-9b61-fb2f6ad520ab", null, null, null, "P", "[]");

  const de = db.prepare(
    "INSERT INTO description_entities (id, description_id, entity_id, role, role_note, role_raw, sequence, honorific, attributes, name_as_recorded) " +
      // The fixture's link function is the `office` attribute (migration 0125).
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CASE WHEN ?9 IS NULL THEN '{}' ELSE json_object('office', ?9) END, ?10)",
  );
  const F = "7855ef14-95dd-4771-b38b-fe3a319a8351";
  de.run("d73732b3-265b-4bd9-a136-bfc8122ec47a", "a-0001", F, "subject", null, "subject", 0, null, null, "Francisco Hernández Hermoso");
  de.run("cde8e013-bb2b-4131-95d3-8b8f5a818d84", "a-0001", F, "creator", null, "creator", 0, null, null, null);
  de.run("lk-merged", "a-0002", "ent-merged", "mentioned", null, "mentioned", 0, null, null, null);
  de.run("lk-cab", "c-0001", F, "mentioned", null, "mentioned", 1, "Don", "Capitán", null);
  // One link on each of 300 AHT descriptions, so the link reads take several chunks.
  for (let i = 3; i <= Math.min(302, s.descriptions); i++) {
    de.run(`lk-${pad(i)}`, `a-${pad(i)}`, `ent-${pad(1 + (i % Math.max(1, s.entities)))}`, "mentioned", null, "mentioned", 0, null, null, null);
  }
  const dp = db.prepare("INSERT INTO description_places (id, description_id, place_id, role, role_note, role_raw) VALUES (?, ?, ?, ?, ?, ?)");
  dp.run("97bf98c1-0e02-47a0-870c-47945100d25b", "a-0001", "764d05a4-67d4-437f-9b61-fb2f6ad520ab", "mentioned", null, "mentioned");
  dp.run("pk-venue", AHT_ROOT, "764d05a4-67d4-437f-9b61-fb2f6ad520ab", "venue", null, "venue");
  dp.run("pk-merged", "a-0003", "pl-merged", "mentioned", null, "mentioned");
  dp.run("pk-cab", "c-0001", "pl-parent", "mentioned", null, "mentioned");
  return db;
}

// ---------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------

const OVERLOAD = "wrangler d1 execute failed [code: 7429]: D1 DB is overloaded. Too many resources consumed within a 10 second window";

interface Harness {
  providers: ExportProviders;
  calls: Array<{ sql: string; start: number; end: number; lockFd: number | null | undefined }>;
  sleeps: number[];
  fetches: Array<{ url: string; afterQueries: number }>;
  logs: string[];
  /** Call numbers (1-based, counting attempts) that fail as overloaded. */
  overloadOn: Set<number>;
  /** Fetch results in order; once spent, 200. */
  fetchResults: Array<number | Error>;
}

type Ports = { staging: number; production: number };

function harness(db: DatabaseSync, lockPorts: Ports, over: Partial<ExportProviders> = {}): Harness {
  let t = 1_763_200_000_000;
  const h: Harness = {
    calls: [],
    sleeps: [],
    fetches: [],
    logs: [],
    overloadOn: new Set(),
    fetchResults: [],
    providers: undefined as unknown as ExportProviders,
  };
  h.providers = {
    d1: async (sql: string, lockFd?: number | null) => {
      const start = t;
      t += 40;
      h.calls.push({ sql, start, end: t, lockFd });
      if (h.overloadOn.has(h.calls.length)) throw new Error(OVERLOAD);
      return db.prepare(sql).all() as Record<string, unknown>[];
    },
    fetch: async (url: string) => {
      h.fetches.push({ url, afterQueries: h.calls.length });
      t += 5;
      const r = h.fetchResults.shift();
      if (r instanceof Error) throw r;
      return { status: r ?? 200 };
    },
    sleep: async (ms: number) => {
      h.sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    lockPort: (target) => lockPorts[target],
    workerVersion: () => "d75fa96a-f791-47fd-bab8-a23f84e9d88a",
    log: (line: string) => h.logs.push(line),
    ...over,
  };
  return h;
}

/** A port nothing listens on now, so the tests never meet a real export's lock. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** True when a listener can bind the port now. */
async function portFree(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function hold(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

let dir: string;
let ports: Ports;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "export-cli-"));
  ports = { staging: await freePort(), production: await freePort() };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const argsOf = (set: ExportArgs["set"], over: Partial<ExportArgs> = {}): ExportArgs => ({
  set,
  target: "staging",
  tenant: "ahr",
  fonds: set === "pool" ? ["co-ahrb-aht", "co-ahrb-cab"] : ["co-ahrb-aht"],
  out: join(dir, "out"),
  confirmProduction: false,
  ...over,
});
const locks = () => ports;
const file = (out: string, name: string) => readFileSync(join(out, name), "utf8");
const headerOf = (out: string, name: string) => file(out, name).split(/\r?\n/)[0];
const csvFiles = (out: string) => readdirSync(out).filter((f) => f.endsWith(".csv")).sort();
const inList = (sql: string) => {
  const m = /\bIN \(([^)]*)\)/.exec(sql);
  return m ? m[1].split(",").length : 0;
};

// ---------------------------------------------------------------------------
// The arguments
// ---------------------------------------------------------------------------

describe("export arguments", () => {
  const base = ["export", "descriptions", "--target", "staging", "--tenant", "ahr", "--fonds", "co-ahrb-aht", "--out", "x"];
  it("reads the set, the target, the tenant, the fonds and the folder", () => {
    expect(parseExportArgs(base)).toEqual({
      set: "descriptions", target: "staging", tenant: "ahr", fonds: ["co-ahrb-aht"], out: "x", confirmProduction: false,
    });
  });
  it("takes --fonds more than once only for pool", () => {
    const pool = ["export", "pool", "--target", "production", "--tenant", "ahr", "--fonds", "co-ahrb-aht", "--fonds", "co-ahrb-cab",
      "--out", "x", "--confirm-production"];
    expect(parseExportArgs(pool).fonds).toEqual(["co-ahrb-aht", "co-ahrb-cab"]);
    expect(parseExportArgs(pool).confirmProduction).toBe(true);
    expect(() => parseExportArgs([...base, "--fonds", "co-ahrb-cab"])).toThrow(/once/);
  });
  it("takes no --clear-lock: the lock leaves nothing to clear", () => {
    expect(() => parseExportArgs([...base, "--clear-lock"])).toThrow(/Unknown argument: --clear-lock/);
  });
  it("refuses an unknown set, a missing --out and a missing --fonds", () => {
    expect(() => parseExportArgs(["export", "things", ...base.slice(2)])).toThrow(/descriptions, entity-links, place-links or pool/);
    expect(() => parseExportArgs(base.slice(0, -2))).toThrow(/--out/);
    expect(() => parseExportArgs(["export", "entity-links", "--target", "staging", "--tenant", "ahr", "--out", "x"])).toThrow(/--fonds/);
    expect(() => parseExportArgs([...base.slice(0, 3), "local", ...base.slice(4)])).toThrow(/staging or production/);
  });
});

// ---------------------------------------------------------------------------
// The statement check
// ---------------------------------------------------------------------------

describe("the SELECT-only check", () => {
  it("accepts one plain SELECT, with keywords inside literals", () => {
    expect(() => assertSelectOnly("SELECT id, title FROM descriptions WHERE tenant_id = 't-1' AND id > '' ORDER BY id LIMIT 200")).not.toThrow();
    expect(() => assertSelectOnly("SELECT id FROM descriptions WHERE reference_code = 'count; join (select like) group by'")).not.toThrow();
    expect(() => assertSelectOnly("SELECT id FROM entities WHERE id IN ('a', 'b''c') AND merged_into IS NULL")).not.toThrow();
  });
  it.each([
    ["a join", "SELECT d.id FROM descriptions d JOIN description_entities de ON de.description_id = d.id"],
    ["a left join", "SELECT id FROM descriptions LEFT JOIN changelog ON 1"],
    ["a comma join", "SELECT a.id FROM descriptions a, changelog b WHERE a.id = b.record_id"],
    ["a subquery", "SELECT id FROM descriptions WHERE tenant_id IN (SELECT id FROM tenants)"],
    ["a correlated count", "SELECT id, (select count(*) from changelog where record_id = d.id) FROM descriptions d"],
    ["LIKE", "SELECT id FROM descriptions WHERE reference_code LIKE 'co-ahrb-aht-%'"],
    ["COUNT", "SELECT COUNT(*) FROM descriptions"],
    ["GROUP BY", "SELECT entity_id FROM description_entities GROUP  BY entity_id"],
    ["two statements", "SELECT id FROM tenants; SELECT id FROM federations"],
    ["a trailing statement", "SELECT id FROM tenants; DELETE FROM tenants"],
    ["a write", "DELETE FROM tenants WHERE id = 'x'"],
    ["a WITH", "WITH x AS (SELECT 1) SELECT * FROM x"],
    ["a pragma", "PRAGMA table_info(descriptions)"],
    ["a comment", "SELECT id FROM tenants -- x"],
    ["an unterminated literal", "SELECT id FROM tenants WHERE slug = 'ahr"],
  ])("refuses %s", (_name, sql) => {
    expect(() => assertSelectOnly(sql)).toThrow(SelectRefusal);
  });
  it("refuses in the reader before anything is sent", async () => {
    let sent = 0;
    let fetched = 0;
    const reader = new PacedReader({
      d1: async () => { sent++; return []; },
      fetch: async () => { fetched++; return { status: 200 }; },
      sleep: async () => {},
      now: () => 0,
      log: () => {},
    }, "https://example.org/login");
    await expect(reader.select("SELECT COUNT(*) FROM descriptions")).rejects.toThrow(SelectRefusal);
    expect(sent).toBe(0);
    expect(fetched).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Paging, pacing, overload, the login page
// ---------------------------------------------------------------------------

describe("how the export reads", () => {
  it("pages descriptions 200 at a time on the fonds root, and reads changelog by 100 ids", async () => {
    const h = harness(database(), locks());
    const result = await runExport(argsOf("descriptions"), h.providers);
    expect(result.outcome).toBe("complete");
    const pages = h.calls.filter((c) => /FROM descriptions WHERE tenant_id = 't-1' AND root_description_id = /.test(c.sql));
    expect(pages.length).toBe(3); // 451 rows: 200, 200, 51
    for (const p of pages) expect(p.sql).toMatch(/AND id > '[^']*' ORDER BY id LIMIT 200$/);
    expect(pages[1].sql).toContain("id > 'a-0200'");
    const changelog = h.calls.filter((c) => /FROM changelog/.test(c.sql));
    expect(changelog.length).toBe(5);
    for (const c of changelog) expect(inList(c.sql)).toBeLessThanOrEqual(100);
    for (const c of h.calls) expect(c.sql).not.toMatch(/\b(JOIN|LIKE|COUNT|GROUP BY)\b/i);
  });

  it("includes the fonds root whether its root_description_id is its own id or NULL", async () => {
    for (const rootSelf of [true, false]) {
      const out = join(dir, `root-${rootSelf}`);
      const h = harness(database({ descriptions: 3, rootSelf }), locks());
      await runExport(argsOf("descriptions", { out }), h.providers);
      const lines = file(out, "aht-descriptions.csv").trimEnd().split("\r\n");
      expect(lines.length).toBe(1 + 4);
      expect(lines[1]).toBe(
        `${AHT_ROOT},co-ahrb-aht,,fonds,Fondo Archivo Histórico de Tunja,,,,,,1,0,,"[{""provider"":""django-zasqua"",""id"":299},{""provider"":""ca-collection"",""id"":14806}]",1765444658000,1765444658000,1`,
      );
    }
  });

  it("reads links by 100 description ids and authorities by 100 ids, live ones only", async () => {
    const h = harness(database({ entities: 250 }), locks());
    await runExport(argsOf("entity-links"), h.providers);
    const links = h.calls.filter((c) => /FROM description_entities/.test(c.sql));
    expect(links.length).toBe(5);
    for (const c of links) expect(inList(c.sql)).toBeLessThanOrEqual(100);
    const ents = h.calls.filter((c) => /FROM entities/.test(c.sql));
    expect(ents.length).toBeGreaterThan(1);
    for (const c of ents) {
      expect(inList(c.sql)).toBeLessThanOrEqual(100);
      expect(c.sql).toContain("merged_into IS NULL");
    }
    const csv = file(join(dir, "out"), "aht-entity-links.csv");
    expect(csv).not.toContain("lk-merged");
    expect(csv).not.toContain("lk-cab");
  });

  it("pages the pool 500 at a time by primary key", async () => {
    const h = harness(database({ entities: 1200 }), locks());
    await runExport(argsOf("pool"), h.providers);
    const ents = h.calls.filter((c) => /FROM entities/.test(c.sql));
    expect(ents.length).toBe(3); // 1201 live federation entities
    for (const c of ents) expect(c.sql).toMatch(/^SELECT [a-z_, ]+ FROM entities WHERE id > '[^']*' ORDER BY id LIMIT 500$/);
    const de = h.calls.filter((c) => /FROM description_entities/.test(c.sql));
    expect(de.length).toBe(1);
    expect(de[0].sql).toMatch(/WHERE id > '' ORDER BY id LIMIT 500$/);
  });

  it("leaves at least 1 s between the end of one statement and the start of the next", async () => {
    const h = harness(database({ descriptions: 40 }), locks());
    await runExport(argsOf("place-links"), h.providers);
    expect(h.calls.length).toBeGreaterThan(4);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i].start - h.calls[i - 1].end).toBeGreaterThanOrEqual(1000);
  });

  it("waits 180 s on the first 7429 and runs that statement once more", async () => {
    const h = harness(database({ descriptions: 40 }), locks());
    h.overloadOn.add(3);
    const result = await runExport(argsOf("descriptions"), h.providers);
    expect(result.outcome).toBe("complete");
    expect(h.sleeps).toContain(180_000);
    expect(h.calls[3].sql).toBe(h.calls[2].sql);
    expect(h.calls[3].start - h.calls[2].end).toBeGreaterThanOrEqual(180_000);
    // The sign-in page is fetched again before the statement is sent once more.
    expect(h.fetches.map((f) => f.afterQueries)).toEqual([0, 3]);
    expect(existsSync(join(dir, "out", "README.md"))).toBe(false);
  });

  it("stops on a second 7429 anywhere in the run and writes README.md", async () => {
    const h = harness(database({ descriptions: 40 }), locks());
    h.overloadOn.add(2);
    h.overloadOn.add(5);
    const result = await runExport(argsOf("descriptions"), h.providers);
    expect(result.outcome).toBe("stopped");
    expect(h.calls.length).toBe(5);
    expect(h.sleeps.filter((ms) => ms === 180_000).length).toBe(1);
    const readme = file(join(dir, "out"), "README.md");
    expect(readme).toMatch(/partial/i);
    expect(readme).toMatch(/7429/);
    expect(readme).toMatch(/aht-descriptions\.csv/);
    expect(csvFiles(join(dir, "out"))).toEqual([]);
    expect(await portFree(ports.staging)).toBe(true);
  });

  it("checks the login page before the first statement and after every 20", async () => {
    const h = harness(database({ descriptions: 40, entities: 6000 }), locks());
    await runExport(argsOf("pool"), h.providers);
    expect(h.calls.length).toBeGreaterThan(20);
    expect(h.fetches[0]).toEqual({ url: "https://ahr.staging.fisqua.org/login", afterQueries: 0 });
    const expected = Array.from({ length: Math.ceil(h.calls.length / 20) }, (_, i) => i * 20);
    expect(h.fetches.map((f) => f.afterQueries)).toEqual(expected);
  });

  it("checks the production login page on production", async () => {
    const h = harness(database({ descriptions: 3 }), locks());
    await runExport(argsOf("descriptions", { target: "production", confirmProduction: true }), h.providers);
    expect(h.fetches[0].url).toBe("https://neogranadina.fisqua.org/login");
  });

  it("stops when the login page answers anything but 200, or cannot be fetched", async () => {
    const h = harness(database({ descriptions: 40, entities: 6000 }), locks());
    h.fetchResults.push(200, 500);
    const result = await runExport(argsOf("pool"), h.providers);
    expect(result.outcome).toBe("stopped");
    expect(h.calls.length).toBe(20);
    expect(file(join(dir, "out"), "README.md")).toMatch(/500/);

    const out2 = join(dir, "out2");
    const h2 = harness(database(), locks());
    h2.fetchResults.push(new Error("getaddrinfo ENOTFOUND"));
    const r2 = await runExport(argsOf("descriptions", { out: out2 }), h2.providers);
    expect(r2.outcome).toBe("stopped");
    expect(h2.calls.length).toBe(0);
    expect(file(out2, "README.md")).toMatch(/ENOTFOUND/);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint, lock, production
// ---------------------------------------------------------------------------

describe("resuming, the lock and production", () => {
  it.each(["descriptions", "entity-links", "place-links", "pool"] as const)(
    "resumes a stopped %s run to the same files as a run never stopped",
    async (set) => {
      const seed = { descriptions: 450, entities: 700 };
      const whole = join(dir, "whole");
      const uninterrupted = harness(database(seed), locks());
      await runExport(argsOf(set, { out: whole }), uninterrupted.providers);

      const parts = join(dir, "parts");
      const first = harness(database(seed), locks());
      first.overloadOn.add(4);
      first.overloadOn.add(5);
      expect((await runExport(argsOf(set, { out: parts }), first.providers)).outcome).toBe("stopped");
      expect(existsSync(join(parts, "README.md"))).toBe(true);
      // A page appended after the checkpoint was last written is dropped on resume.
      // c-0001 is a CAB description: kept, it would change every set's output.
      appendFileSync(join(parts, ".export-parts", "descriptions_co-ahrb-aht.jsonl"),
        '{"id":"c-0001","reference_code":"co-ahrb-aht-stray","title":"stray","legacy_ids":"[]"}\n');

      const second = harness(database(seed), locks());
      expect((await runExport(argsOf(set, { out: parts }), second.providers)).outcome).toBe("complete");
      // Pages already read are not read again.
      expect(second.calls.length).toBeLessThan(uninterrupted.calls.length);
      expect(csvFiles(parts)).toEqual(csvFiles(whole));
      for (const f of csvFiles(whole)) expect(file(parts, f)).toBe(file(whole, f));
      expect(existsSync(join(parts, "README.md"))).toBe(false);
    },
  );

  it("refuses a checkpoint written with other arguments", async () => {
    const h = harness(database(), locks());
    h.overloadOn.add(2);
    h.overloadOn.add(3);
    await runExport(argsOf("descriptions"), h.providers);
    const again = harness(database(), locks());
    await expect(runExport(argsOf("descriptions", { fonds: ["co-ahrb-cab"] }), again.providers)).rejects.toThrow(ExportRefusal);
    await expect(runExport(argsOf("entity-links"), again.providers)).rejects.toThrow(/checkpoint/);
    expect(again.calls.length).toBe(0);
  });

  it("refuses a second export while one holds the target's port, and names it", async () => {
    const first = await acquirePortLock("staging", ports.staging);
    expect(Number.isInteger(first.fd) && first.fd > 2).toBe(true);
    try {
      await expect(acquirePortLock("staging", ports.staging)).rejects.toThrow(
        new RegExp(`Another export against staging is running, or another program holds 127\\.0\\.0\\.1:${ports.staging}`),
      );
      const h = harness(database(), locks());
      await expect(runExport(argsOf("descriptions", { out: join(dir, "elsewhere") }), h.providers)).rejects.toThrow(/another export/i);
      expect(h.calls.length).toBe(0);
      expect(h.fetches.length).toBe(0);
      // Production has its own port.
      const p = await runExport(argsOf("descriptions", { target: "production", confirmProduction: true }), harness(database({ descriptions: 3 }), locks()).providers);
      expect(p.outcome).toBe("complete");
    } finally {
      await first.release();
    }
    expect(await portFree(ports.staging)).toBe(true);
  });

  it("refuses when another program holds the port", async () => {
    const other = await hold(ports.staging);
    try {
      await expect(runExport(argsOf("descriptions"), harness(database(), locks()).providers)).rejects.toThrow(ExportRefusal);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("frees the port when a run completes, stops or is refused", async () => {
    const h = harness(database({ descriptions: 3 }), locks());
    expect((await runExport(argsOf("descriptions"), h.providers)).outcome).toBe("complete");
    expect(await portFree(ports.staging)).toBe(true);

    const s2 = harness(database({ descriptions: 3 }), locks());
    s2.overloadOn.add(2);
    s2.overloadOn.add(3);
    expect((await runExport(argsOf("descriptions", { out: join(dir, "stopped") }), s2.providers)).outcome).toBe("stopped");
    expect(await portFree(ports.staging)).toBe(true);

    // A refusal thrown after the port is taken: the checkpoint belongs to another export.
    await expect(runExport(argsOf("entity-links", { out: join(dir, "stopped") }), harness(database(), locks()).providers)).rejects.toThrow(/checkpoint/);
    expect(await portFree(ports.staging)).toBe(true);

    // An error thrown from D1 that is not a stop.
    const broken = harness(database({ descriptions: 3 }), locks(), {
      sleep: async () => { throw new Error("clock broke"); },
    });
    await expect(runExport(argsOf("descriptions", { out: join(dir, "broken") }), broken.providers)).rejects.toThrow(/clock broke/);
    expect(await portFree(ports.staging)).toBe(true);
  });

  it("hands the lock's descriptor to every statement's runner", async () => {
    const h = harness(database({ descriptions: 3 }), locks());
    await runExport(argsOf("descriptions"), h.providers);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) expect(Number.isInteger(c.lockFd) && (c.lockFd as number) > 2).toBe(true);
  });

  it("stays bound while a child holds the listener's descriptor, after the parent's handle is closed", async () => {
    const lock = await acquirePortLock("staging", ports.staging);
    const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], {
      stdio: ["pipe", "ignore", "ignore", lock.fd],
    });
    await new Promise((resolve) => child.once("spawn", resolve));
    await lock.release();
    expect(await portFree(ports.staging)).toBe(false);
    await expect(acquirePortLock("staging", ports.staging)).rejects.toThrow(/Another export against staging/);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin!.end();
    await exited;
    expect(await portFree(ports.staging)).toBe(true);
  });

  it("stays bound after the parent is killed while its child holds the descriptor", async () => {
    // A parent that binds the port as acquirePortLock does, hands the
    // descriptor to a child, reports both pids and waits to be killed.
    const parentScript = `
      const net = require("node:net");
      const { spawn } = require("node:child_process");
      const server = net.createServer();
      server.listen({ host: "127.0.0.1", port: ${ports.staging}, exclusive: true }, () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["ignore", "ignore", "ignore", server._handle.fd], detached: true,
        });
        child.unref();
        process.stdout.write(JSON.stringify({ child: child.pid }) + "\\n");
      });
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", parentScript], { stdio: ["ignore", "pipe", "inherit"] });
    const line = await new Promise<string>((resolve) => parent.stdout!.once("data", (b) => resolve(String(b))));
    const childPid = (JSON.parse(line) as { child: number }).child;
    try {
      const gone = new Promise((resolve) => parent.once("exit", resolve));
      parent.kill("SIGKILL");
      await gone;
      expect(await portFree(ports.staging)).toBe(false);
    } finally {
      process.kill(childPid, "SIGKILL");
    }
    for (let i = 0; i < 50 && !(await portFree(ports.staging)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await portFree(ports.staging)).toBe(true);
  });

  it("uses fixed ports per target from the command line", () => {
    expect(LOCK_PORTS).toEqual({ production: 47391, staging: 47392 });
  });

  it("refuses production without --confirm-production before anything is read", async () => {
    const h = harness(database(), locks());
    await expect(runExport(argsOf("descriptions", { target: "production" }), h.providers)).rejects.toThrow(/--confirm-production/);
    expect(h.calls.length).toBe(0);
    expect(h.fetches.length).toBe(0);
    expect(await portFree(ports.production)).toBe(true);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("refuses to run again into a folder whose export is complete", async () => {
    const h = harness(database({ descriptions: 3 }), locks());
    await runExport(argsOf("descriptions"), h.providers);
    await expect(runExport(argsOf("descriptions"), harness(database(), locks()).providers)).rejects.toThrow(/complete/);
  });
});

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

describe("the files", () => {
  it("writes the descriptions with the reference header and their changelog row counts", async () => {
    const out = join(dir, "out");
    await runExport(argsOf("descriptions"), harness(database({ descriptions: 3 }), locks()).providers);
    expect(headerOf(out, "aht-descriptions.csv")).toBe(H_DESCRIPTIONS);
    const text = file(out, "aht-descriptions.csv");
    expect(text.endsWith("\r\n")).toBe(true);
    const lines = text.trimEnd().split("\r\n");
    expect(lines.map((l) => l.split(",")[1])).toEqual(["reference_code", "co-ahrb-aht", "co-ahrb-aht-001", "co-ahrb-aht-002", "co-ahrb-aht-003"]);
    expect(text).toContain(
      `a-0001,co-ahrb-aht-001,${AHT_ROOT},item,"Mortuoria y testamento de Francisco Hernández Hermoso, natural de Tunja","Dice ""testamento""\nen dos líneas",1574-09-04,1574-09-04,1574-09-04,Folios: 001r-012v,1,1,,"[{""provider"":""django-zasqua"",""id"":100001}]",1765538664000,1773635476000,2\r\n`,
    );
    expect(lines[3].endsWith(",1")).toBe(true);
    expect(lines[4].endsWith(",0")).toBe(true);
    const summary = file(out, "summary.md");
    expect(summary).toMatch(/aht-descriptions\.csv \| 4/);
    expect(summary).toContain("d75fa96a-f791-47fd-bab8-a23f84e9d88a");
    expect(summary).toMatch(/UTC/);
  });

  it("writes entity links with the reference header, ordered by reference code and link id", async () => {
    const out = join(dir, "out");
    await runExport(argsOf("entity-links"), harness(database({ descriptions: 3 }), locks()).providers);
    expect(headerOf(out, "aht-entity-links.csv")).toBe(H_ENTITY_LINKS);
    const lines = file(out, "aht-entity-links.csv").trimEnd().split("\n");
    expect(lines[1]).toBe(
      `co-ahrb-aht-001,7855ef14-95dd-4771-b38b-fe3a319a8351,ne-c8sxvc,Francisco Hernández Hermoso,Francisco Hernández Hermoso,Hernández Hermoso,Francisco,person,,Capitán,[],fl. 1574,1574-01-01,1574-12-31,,,,"[{""provider"":""django-zasqua"",""id"":853677},{""provider"":""zasqua-2026-04"",""id"":""ne-29e99""}]",creator,,creator,0,,,,cde8e013-bb2b-4131-95d3-8b8f5a818d84`,
    );
    expect(lines[2]).toMatch(/,subject,,subject,0,,,Francisco Hernández Hermoso,d73732b3-265b-4bd9-a136-bfc8122ec47a$/);
    expect(lines.length).toBe(1 + 3); // the merged entity's link is left out
  });

  it("writes place links with the reference header and the parent's name", async () => {
    const out = join(dir, "out");
    await runExport(argsOf("place-links"), harness(database({ descriptions: 3 }), locks()).providers);
    expect(headerOf(out, "aht-place-links.csv")).toBe(H_PLACE_LINKS);
    const lines = file(out, "aht-place-links.csv").trimEnd().split("\n");
    expect(lines.length).toBe(1 + 2);
    expect(lines[1]).toBe(
      `co-ahrb-aht,764d05a4-67d4-437f-9b61-fb2f6ad520ab,nl-qvk8n9,Tunja,Tunja,city,"[""Santiago de Tunja""]",pl-parent,Provincia de Boyacá,5.533051,-73.361339,,7005077,lugares13k_rel:14166077,175088,P,"[{""provider"":""django-zasqua"",""id"":95648}]",venue,,venue,pk-venue`,
    );
  });

  it("writes the pool with the reference headers, link counts per fonds and primary functions", async () => {
    const out = join(dir, "out");
    await runExport(argsOf("pool"), harness(database({ descriptions: 10, entities: 6 }), locks()).providers);
    expect(headerOf(out, "federation-entities.csv")).toBe(H_FED_ENTITIES);
    expect(headerOf(out, "federation-places.csv")).toBe(H_FED_PLACES);
    expect(headerOf(out, "link-counts-by-fonds.csv")).toBe(H_LINK_COUNTS);
    expect(headerOf(out, "neogranadina-primary-functions.csv")).toBe(H_PRIMARY_FUNCTIONS);

    const ents = file(out, "federation-entities.csv").trimEnd().split("\r\n");
    expect(ents.length).toBe(1 + 7); // live entities of fed-1 only
    expect(ents.some((l) => l.includes("ent-merged") || l.includes("ent-other-fed"))).toBe(false);
    expect(ents.find((l) => l.startsWith("7855ef14"))).toMatch(/,fed-1,,3,2,1$/);
    const places = file(out, "federation-places.csv").trimEnd().split("\r\n");
    expect(places.find((l) => l.startsWith("764d05a4"))).toBe(
      `764d05a4-67d4-437f-9b61-fb2f6ad520ab,nl-qvk8n9,Tunja,Tunja,city,"[""Santiago de Tunja""]",5.533051,-73.361339,fed-1,2,2,0`,
    );
    expect(places.find((l) => l.startsWith("pl-parent"))).toBe("pl-parent,nl-parent,Boyacá,Provincia de Boyacá,province,[],5,-73,fed-1,1,0,1");

    expect(file(out, "link-counts-by-fonds.csv")).toBe(
      `${H_LINK_COUNTS}\r\nco-ahrb-aht,${2 + 8},${1 + 6},2,1\r\nco-ahrb-cab,1,1,1,1\r\n`,
    );
    // Capitán 1; Regidor ent-1, ent-4; Alcalde ent-3, ent-6; '' and NULL left out.
    expect(file(out, "neogranadina-primary-functions.csv")).toBe(`${H_PRIMARY_FUNCTIONS}\r\nRegidor,2\r\nAlcalde,2\r\nCapitán,1\r\n`);
  });

  it("names the link columns after the last part of each fonds' code", async () => {
    const out = join(dir, "out");
    await runExport(argsOf("pool", { fonds: ["co-ahrb-cab"] }), harness(database({ descriptions: 3 }), locks()).providers);
    expect(headerOf(out, "federation-places.csv")).toBe(
      "id,place_code,label,display_name,place_type,name_variants,latitude,longitude,federation_id,links_total,links_cab",
    );
  });
});

// ---------------------------------------------------------------------------
// Whole-table pages, phase files, the wrangler call
// ---------------------------------------------------------------------------

describe("the pool's whole-table pages", () => {
  it("send no WHERE term beyond the keyset, and page sparse matches to the end", async () => {
    const out = join(dir, "out");
    const h = harness(database({ descriptions: 10, entities: 5, otherEntities: 1300 }), locks());
    await runExport(argsOf("pool"), h.providers);
    const whole = h.calls.filter((c) => /FROM (entities|places|description_entities|description_places) /.test(c.sql));
    for (const c of whole) expect(c.sql).toMatch(/^SELECT [a-z_, ]+ FROM [a-z_]+ WHERE id > '[^']*' ORDER BY id LIMIT 500$/);
    // 1,308 entities in all: three pages, the last short.
    expect(h.calls.filter((c) => / FROM entities /.test(c.sql)).length).toBe(3);
    const ents = file(out, "federation-entities.csv").trimEnd().split("\r\n");
    expect(ents.length).toBe(1 + 6); // live fed-1 entities only, from pages mostly of fed-2
    expect(ents.some((l) => /-o,|ent-merged|ent-other-fed/.test(l))).toBe(false);
    expect(ents.slice(1).map((l) => l.split(",")[0])).toEqual(
      ["7855ef14-95dd-4771-b38b-fe3a319a8351", "ent-0001", "ent-0002", "ent-0003", "ent-0004", "ent-0005"],
    );
    const places = file(out, "federation-places.csv").trimEnd().split("\r\n");
    expect(places.length).toBe(1 + 2);
    expect(places.some((l) => l.startsWith("pl-merged"))).toBe(false);
  });
});

describe("phase files", () => {
  const A = "co-ahrb-a/b";
  const B = "co-ahrb-a:b";
  const seedTwo = (db: DatabaseSync) => {
    const d = db.prepare(
      "INSERT INTO descriptions (id, tenant_id, parent_id, root_description_id, reference_code, description_level, title, legacy_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 1, 1)",
    );
    const de = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role) VALUES (?, ?, ?, 'mentioned')");
    d.run("r-a", TENANT, null, "r-a", A, "fonds", "A");
    d.run("r-b", TENANT, null, "r-b", B, "fonds", "B");
    for (let i = 1; i <= 3; i++) {
      d.run(`ra-${i}`, TENANT, "r-a", "r-a", `${A}-${i}`, "item", "A");
      de.run(`lka-${i}`, `ra-${i}`, "ent-0001");
    }
    d.run("rb-1", TENANT, "r-b", "r-b", `${B}-1`, "item", "B");
    de.run("lkb-1", "rb-1", "ent-0002");
    return db;
  };

  it("keep two fonds whose codes differ only in a / and a : apart, and resume correctly", async () => {
    const args = (out: string) => argsOf("pool", { fonds: [A, B], out });
    const whole = join(dir, "whole");
    await runExport(args(whole), harness(seedTwo(database({ descriptions: 3 })), locks()).providers);
    expect(file(whole, "link-counts-by-fonds.csv")).toBe(`${H_LINK_COUNTS}\r\n${A},3,1,0,0\r\n${B},1,1,0,0\r\n`);
    expect(headerOf(whole, "federation-entities.csv").endsWith(",links_total,links_a/b,links_a:b")).toBe(true);

    const parts = join(dir, "parts");
    const first = harness(seedTwo(database({ descriptions: 3 })), locks());
    first.overloadOn.add(6); // the second fonds' descriptions page
    first.overloadOn.add(7);
    expect((await runExport(args(parts), first.providers)).outcome).toBe("stopped");
    // Each fonds has its own descriptions file.
    expect(readdirSync(join(parts, ".export-parts")).filter((f) => f.startsWith("descriptions")).length).toBe(2);
    const second = harness(seedTwo(database({ descriptions: 3 })), locks());
    expect((await runExport(args(parts), second.providers)).outcome).toBe("complete");
    for (const f of csvFiles(whole)) expect(file(parts, f)).toBe(file(whole, f));
  });
});

describe("phase file names", () => {
  // These two had the same first 8 hex of their SHA-256.
  const A = "co-" + "a".repeat(77) + "-01299e";
  const B = "co-" + "a".repeat(77) + "-01e75b";

  it("are injective: the full hex of the code, never a hash", () => {
    for (const kind of ["root", "descriptions"]) {
      const a = fileSafeName(`${kind}:${A}`);
      const b = fileSafeName(`${kind}:${B}`);
      expect(a).not.toBe(b);
      expect(a.endsWith(Buffer.from(A, "utf8").toString("hex"))).toBe(true);
      expect(Buffer.byteLength(`${a}.jsonl`)).toBeLessThanOrEqual(200);
    }
    expect(fileSafeName("tenant")).toBe("tenant");
  });

  it("keep two long codes apart through a stopped and resumed pool", async () => {
    const seedLong = (db: DatabaseSync) => {
      const d = db.prepare(
        "INSERT INTO descriptions (id, tenant_id, parent_id, root_description_id, reference_code, description_level, title, legacy_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 1, 1)",
      );
      const de = db.prepare("INSERT INTO description_entities (id, description_id, entity_id, role) VALUES (?, ?, ?, 'mentioned')");
      d.run("r-a", TENANT, null, "r-a", A, "fonds", "A");
      d.run("r-b", TENANT, null, "r-b", B, "fonds", "B");
      for (let i = 1; i <= 2; i++) {
        d.run(`ra-${i}`, TENANT, "r-a", "r-a", `${A}-${i}`, "item", "A");
        de.run(`lka-${i}`, `ra-${i}`, "ent-0001");
      }
      return db;
    };
    const args = (out: string) => argsOf("pool", { fonds: [A, B], out });
    const whole = join(dir, "whole");
    await runExport(args(whole), harness(seedLong(database({ descriptions: 3 })), locks()).providers);
    expect(file(whole, "link-counts-by-fonds.csv")).toBe(`${H_LINK_COUNTS}\r\n${A},2,1,0,0\r\n${B},0,0,0,0\r\n`);
    const parts = join(dir, "parts");
    const first = harness(seedLong(database({ descriptions: 3 })), locks());
    first.overloadOn.add(6);
    first.overloadOn.add(7);
    expect((await runExport(args(parts), first.providers)).outcome).toBe("stopped");
    expect(readdirSync(join(parts, ".export-parts")).filter((f) => f.startsWith("descriptions")).length).toBe(2);
    expect((await runExport(args(parts), harness(seedLong(database({ descriptions: 3 })), locks()).providers)).outcome).toBe("complete");
    for (const f of csvFiles(whole)) expect(file(parts, f)).toBe(file(whole, f));
  });

  it("refuses, before anything is read, a code whose file name would pass 200 bytes", async () => {
    const h = harness(database(), locks());
    await expect(runExport(argsOf("pool", { fonds: ["co-" + "a".repeat(100)] }), h.providers)).rejects.toThrow(/200 bytes/);
    expect(h.calls.length).toBe(0);
    expect(h.fetches.length).toBe(0);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });
});

describe("the wrangler call", () => {
  const overloaded = () =>
    Object.assign(new Error("Command failed: npx wrangler d1 execute"), {
      stdout: "",
      stderr: "✘ [ERROR] D1 DB is overloaded. Too many resources consumed within a 10 second window [code: 7429]",
    });
  const ok = (rows: unknown[]) => `Executing on remote database fisqua-staging-db:\n${JSON.stringify([{ results: rows, success: true }])}`;

  it("runs wrangler's cli.js with node once per call, handing it the lock's descriptor", async () => {
    const execs: Array<{ command: string; args: string[]; stdio: unknown }> = [];
    const d1 = exportD1("staging", (command, args, options) => {
      execs.push({ command, args, stdio: options.stdio });
      return ok([{ id: "x" }]);
    });
    expect(await d1("SELECT id FROM tenants WHERE slug = 'ahr'", 17)).toEqual([{ id: "x" }]);
    expect(execs.length).toBe(1);
    expect(execs[0].command).toBe(process.execPath);
    const [noWarnings, vmModules, cli, ...rest] = execs[0].args;
    expect([noWarnings, vmModules]).toEqual(["--no-warnings", "--experimental-vm-modules"]);
    expect(cli).toMatch(/node_modules\/wrangler\/wrangler-dist\/cli\.js$/);
    expect(existsSync(cli)).toBe(true);
    expect(rest).toEqual(["d1", "execute", "fisqua-staging-db", "--env", "staging", "--remote", "--json", "--command",
      "SELECT id FROM tenants WHERE slug = 'ahr'"]);
    expect(execs[0].stdio).toEqual(["pipe", "pipe", "pipe", 17]);
    expect(execs.some((e) => e.command === "npx" || e.args.some((a) => /bin\/wrangler/.test(a)))).toBe(false);
  });

  it("hands descriptor 3 to the process the real exec starts, which holds the port", async () => {
    // A stand-in for cli.js: reports whether its descriptor 3 is a socket, and the port is still
    // bound while it runs even though nothing else in it listens.
    const fake = join(dir, "fake-cli.js");
    writeFileSync(fake, `
      const fs = require("node:fs");
      process.stdout.write(JSON.stringify([{ results: [{ socket: fs.fstatSync(3).isSocket(), args: process.argv.slice(2) }] }]));
    `);
    const lock = await acquirePortLock("staging", ports.staging);
    try {
      const d1 = exportD1("staging", undefined, fake);
      const [row] = await d1("SELECT id FROM tenants", lock.fd);
      expect(row.socket).toBe(true);
      expect((row.args as string[]).slice(0, 3)).toEqual(["d1", "execute", "fisqua-staging-db"]);
    } finally {
      await lock.release();
    }
    expect(await portFree(ports.staging)).toBe(true);
  });

  it("makes one exec on a 7429 and hands the overload to the reader", async () => {
    let n = 0;
    const d1 = exportD1("production", () => {
      n++;
      throw overloaded();
    });
    await expect(d1("SELECT id FROM tenants")).rejects.toThrow(/\[code: 7429\]/);
    expect(n).toBe(1);
  });

  it("makes exactly one exec per attempt under the reader's 7429 rule", async () => {
    let n = 0;
    const sleeps: number[] = [];
    let t = 0;
    const reader = new PacedReader({
      d1: exportD1("staging", () => {
        n++;
        if (n === 1) throw overloaded();
        return ok([{ id: "y" }]);
      }),
      fetch: async () => ({ status: 200 }),
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
      log: () => {},
    }, "https://example.org/login");
    expect(await reader.select("SELECT id FROM tenants")).toEqual([{ id: "y" }]);
    expect(n).toBe(2);
    expect(sleeps).toEqual([180_000]);

    n = 0;
    const always = new PacedReader({
      d1: exportD1("staging", () => { n++; throw overloaded(); }),
      fetch: async () => ({ status: 200 }),
      sleep: async (ms) => { t += ms; },
      now: () => t,
      log: () => {},
    }, "https://example.org/login");
    await expect(always.select("SELECT id FROM tenants")).rejects.toThrow(ExportStop);
    expect(n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Production reads through the production read lock
// ---------------------------------------------------------------------------

describe("production reads, through the production read lock", () => {
  // The import suite's config turns the read lock and pacing off; these tests turn them back on.
  const SWITCH = "FISQUA_D1_PRODUCTION_GUARD";
  const configured = process.env[SWITCH];
  beforeEach(() => {
    delete process.env[SWITCH];
  });
  afterEach(() => {
    if (configured === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = configured;
  });
  const ok = (rows: unknown[]) => `Executing on remote database fisqua-db:\n${JSON.stringify([{ results: rows, success: true }])}`;
  const sql = "SELECT id FROM tenants WHERE slug = 'ahr'";

  it("sends each production statement through the lock helper, with the export's descriptor", async () => {
    const execs: Array<{ command: string; args: string[]; stdio: unknown }> = [];
    const cli = "/x/wrangler-dist/cli.js";
    const d1 = exportD1(
      "production",
      (command, args, options) => (execs.push({ command, args, stdio: options.stdio }), ok([{ id: "x" }])),
      cli,
      { guard: { dir, port: 47999 } },
    );
    expect(await d1(sql, 17)).toEqual([{ id: "x" }]);
    expect(execs).toHaveLength(1);
    expect(execs[0].command).toBe(process.execPath);
    expect(execs[0].args).toEqual([
      PRODUCTION_LOCK_HELPER, "47999", String(PRODUCTION_ATTEMPT_TIMEOUT_MS), join(dir, "d1-production.last"), String(PRODUCTION_READ_GAP_MS),
      process.execPath, "--no-warnings", "--experimental-vm-modules", cli,
      "d1", "execute", "fisqua-db", "--remote", "--json", "--command", sql,
    ]);
    expect(execs[0].stdio).toEqual(["pipe", "pipe", "pipe", 17]);
  });

  it("waits while another process holds the read lock, and tries again", async () => {
    let n = 0;
    const waits: number[] = [];
    const lines: string[] = [];
    const d1 = exportD1(
      "production",
      () => {
        n++;
        if (n <= 2) throw Object.assign(new Error("Command failed"), { status: LOCK_BUSY_EXIT, stdout: "", stderr: "" });
        return ok([{ id: "y" }]);
      },
      "/x/cli.js",
      { guard: { dir, port: 47999 }, wait: (ms) => void waits.push(ms), log: (l) => void lines.push(l) },
    );
    expect(await d1(sql)).toEqual([{ id: "y" }]);
    expect(n).toBe(3);
    expect(waits).toEqual([LOCK_POLL_MS, LOCK_POLL_MS]);
    expect(lines.filter((l) => /waiting/i.test(l))).toHaveLength(1);
  });

  it("reports a read stopped at the time limit as a refusal the reader stops on, not an overload", async () => {
    let n = 0;
    const d1 = exportD1(
      "production",
      () => {
        n++;
        throw Object.assign(new Error("Command failed"), { status: LOCK_TIMEOUT_EXIT, stdout: "", stderr: "stopped" });
      },
      "/x/cli.js",
      { guard: { dir, port: 47999 } },
    );
    let t = 0;
    const reader = new PacedReader(
      { d1, fetch: async () => ({ status: 200 }), sleep: async (ms) => void (t += ms), now: () => t, log: () => {} },
      "https://example.org/login",
    );
    await expect(reader.select(sql)).rejects.toThrow(/time limit/);
    expect(n).toBe(1);
  });

  it("stops at once on a read stopped at the time limit, even when its output mentions an overload", async () => {
    let n = 0;
    const d1 = exportD1(
      "production",
      () => {
        n++;
        throw Object.assign(new Error("Command failed"), {
          status: LOCK_TIMEOUT_EXIT,
          stdout: "",
          stderr: "D1 DB is overloaded. Too many resources consumed within a 10 second window [code: 7429]\nThe production D1 read ran longer than 300000 ms and was stopped.",
        });
      },
      "/x/cli.js",
      { guard: { dir, port: 47999 } },
    );
    let t = 0;
    const sleeps: number[] = [];
    const reader = new PacedReader(
      { d1, fetch: async () => ({ status: 200 }), sleep: async (ms) => void (sleeps.push(ms), (t += ms)), now: () => t, log: () => {} },
      "https://example.org/login",
    );
    const err = await reader.select(sql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportStop);
    expect((err as Error).message).toMatch(/time limit/);
    expect(n).toBe(1);
    expect(reader.overloads).toBe(0);
    expect(sleeps).not.toContain(180_000);
  });

  it("refuses a production statement above the 1,000-row cap before anything is sent", async () => {
    let n = 0;
    const d1 = exportD1("production", () => (n++, ok([])), "/x/cli.js", { guard: { dir, port: 47999 } });
    await expect(d1("SELECT id FROM descriptions ORDER BY id LIMIT 1001")).rejects.toThrow(/1,000/);
    expect(n).toBe(0);
  });

  it("asks for no page above the cap", async () => {
    const { DESCRIPTIONS_PAGE, LINK_PAGE, POOL_PAGE, ID_CHUNK } = await import("../../scripts/lib/export-cli/sets");
    for (const size of [DESCRIPTIONS_PAGE, LINK_PAGE, POOL_PAGE, ID_CHUNK]) expect(size).toBeLessThanOrEqual(PRODUCTION_READ_CAP);
  });

  it("leaves staging reads alone: wrangler's cli.js directly, no helper", async () => {
    const execs: Array<{ args: string[] }> = [];
    const d1 = exportD1("staging", (_c, args) => (execs.push({ args }), ok([])), "/x/cli.js", { guard: { dir, port: 47999 } });
    await d1("SELECT id FROM descriptions ORDER BY id LIMIT 5000", 17);
    expect(execs[0].args.slice(0, 3)).toEqual(["--no-warnings", "--experimental-vm-modules", "/x/cli.js"]);
    expect(execs[0].args).not.toContain(PRODUCTION_LOCK_HELPER);
    expect(readdirSync(dir)).toEqual([]);
  });

  /** A stand-in for wrangler: records when it started and ended, holds for FAKE_MS, prints one result set. */
  function fakeWrangler(): string {
    const file = join(dir, "fake-wrangler.mjs");
    writeFileSync(
      file,
      [
        'import * as fs from "node:fs";',
        "const [log, ms] = [process.env.FAKE_LOG, Number(process.env.FAKE_MS ?? 0)];",
        'fs.appendFileSync(log, `start ${Date.now()}\\n`);',
        "setTimeout(() => {",
        '  fs.appendFileSync(log, `end ${Date.now()}\\n`);',
        '  process.stdout.write(JSON.stringify([{ results: [{ n: 1 }] }]));',
        "}, ms);",
      ].join("\n"),
    );
    return file;
  }

  const root = join(import.meta.dirname, "../..");
  /** Runs `body` in a separate process under vite-node, so it can hold the read lock while this one reads. */
  function inOtherProcess(body: string, env: Record<string, string>) {
    const script = join(dir, `other-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(script, body);
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== SWITCH) childEnv[k] = v;
    // An empty Vite config, so the project's Worker plugins do not replace Node's child_process.
    const config = join(dir, "vite.config.mjs");
    writeFileSync(config, "export default {};\n");
    return spawn(join(root, "node_modules/.bin/vite-node"), ["--config", config, script], { cwd: root, stdio: "ignore", env: { ...childEnv, ...env } as NodeJS.ProcessEnv });
  }
  const exited = (child: ReturnType<typeof spawn>) =>
    new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve)));
  async function until(check: () => boolean, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const time = (file: string, what: string) => Number(readFileSync(file, "utf8").match(new RegExp(`${what} (\\d+)`))![1]);
  const blockingWait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 100));

  it("never runs an export's production read while a runD1 production read is running", async () => {
    const port = await freePort();
    const wrangler = fakeWrangler();
    const logA = join(dir, "rund1.log");
    const logB = join(dir, "export.log");
    const d1cli = join(root, "scripts/lib/d1-cli.ts");
    const a = inOtherProcess(
      `import { runD1 } from ${JSON.stringify(d1cli)};
runD1(["wrangler", "d1", "execute", "fisqua-db", "--remote", "--json", "--command", "SELECT 1"], {
  log: () => {},
  guard: { dir: ${JSON.stringify(dir)}, port: ${port}, gapMs: 0, timeoutMs: 60000, wrangler: [process.execPath, ${JSON.stringify(wrangler)}] },
});
`,
      { FAKE_LOG: logA, FAKE_MS: "1500" },
    );
    try {
      await until(() => existsSync(logA));
      const lines: string[] = [];
      const exec = (command: string, args: string[], options: { stdio?: unknown; maxBuffer?: number }) =>
        execFileSync(command, args, {
          encoding: "utf8",
          env: { ...process.env, FAKE_LOG: logB, FAKE_MS: "0" },
          stdio: options.stdio as never,
          maxBuffer: options.maxBuffer,
        });
      const d1 = exportD1("production", exec, wrangler, {
        guard: { dir, port, gapMs: 0, timeoutMs: 60_000 },
        wait: blockingWait,
        log: (l) => void lines.push(l),
      });
      expect(await d1("SELECT id FROM tenants")).toEqual([{ n: 1 }]);
      expect(time(logB, "start")).toBeGreaterThanOrEqual(time(logA, "end"));
      expect(lines.filter((l) => /waiting/i.test(l))).toHaveLength(1);
    } finally {
      await exited(a);
    }
  }, 60_000);

  it("never runs a runD1 production read while an export's production read is running", async () => {
    const port = await freePort();
    const wrangler = fakeWrangler();
    const logA = join(dir, "export.log");
    const logB = join(dir, "rund1.log");
    const exportModule = join(root, "scripts/lib/export-cli/d1.ts");
    const a = inOtherProcess(
      `import { exportD1 } from ${JSON.stringify(exportModule)};
await exportD1("production", undefined, ${JSON.stringify(wrangler)}, {
  log: () => {},
  guard: { dir: ${JSON.stringify(dir)}, port: ${port}, gapMs: 0, timeoutMs: 60000 },
})("SELECT id FROM tenants");
`,
      { FAKE_LOG: logA, FAKE_MS: "1500" },
    );
    try {
      await until(() => existsSync(logA));
      const lines: string[] = [];
      const out = runD1(["wrangler", "d1", "execute", "fisqua-db", "--remote", "--json", "--command", "SELECT 1"], {
        exec: (command, args, opts) =>
          execFileSync(command, args, { encoding: "utf8", env: { ...process.env, FAKE_LOG: logB, FAKE_MS: "0" }, maxBuffer: opts.maxBuffer }),
        wait: blockingWait,
        log: (l) => void lines.push(l),
        guard: { dir, port, gapMs: 0, timeoutMs: 60_000, wrangler: [process.execPath, wrangler] },
      });
      expect(JSON.parse(out)[0].results).toEqual([{ n: 1 }]);
      expect(time(logB, "start")).toBeGreaterThanOrEqual(time(logA, "end"));
      expect(lines.filter((l) => /waiting/i.test(l))).toHaveLength(1);
    } finally {
      await exited(a);
    }
  }, 60_000);
});

// @version v0.9.0
