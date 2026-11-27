/**
 * Scripts — the image manifests of the command line's descriptions
 *
 * This module deals with the IIIF manifests (the file a viewer reads to
 * show a sequence of images) that a `set-images` row of the descriptions
 * change file gives a description, made from canvases of manifests
 * already published. `./images.ts` reads and plans those rows and the
 * other rows of the same kind of list; this module holds what is about
 * the manifests alone. A manifest built here is the one the manifests
 * already published under the federation's address were built as, byte
 * for byte, so a description that already has its manifest plans as
 * `same`.
 *
 *   readPlace           the federation's `manifest_base_url` and
 *                       `manifest_bucket`, its hosting statements (read as
 *                       `readFederationHosting` reads them: a database
 *                       without the columns has none), and the tenant's
 *                       public site and provider, which the manifest's
 *                       descriptive fields name. A federation without the
 *                       address or the bucket stops the run.
 *   imagesProblem       the checks of a row's own columns: `n_images`,
 *                       `first_image` and `last_image` agree with
 *                       `images`, no file is named twice, every file is
 *                       `<volume>-img_NNNN.<ext>`, and a source is given.
 *   parseManifest       a fetched manifest's text as JSON, or why not.
 *   buildManifest       the manifest a row's images make at the record's
 *                       address. Each file is matched to the canvas, in
 *                       any of the row's sources, whose painting body id
 *                       reads `/<segment>/img_NNNN/`, where the segment is
 *                       the file's volume (`AHRB_AHT_023` read
 *                       `ahrb-aht-023`) or an item of it, with or without
 *                       a leading country code (`sameVolume`). The
 *                       canvases are taken in the row's order and
 *                       renumbered from 1 under the new manifest,
 *                       `{base}/iiif/{reference_code}`: the canvas, its
 *                       annotation page and its annotation get ids under
 *                       it and the label `img n`; size, thumbnail and body
 *                       are copied as they are. The descriptive fields
 *                       come from `resolveManifestInputs`
 *                       (`app/lib/pipeline/manifest-inputs.ts`), and the
 *                       top-level fields are written in the order the
 *                       published manifests use. A source that is not an
 *                       absolute URL, cannot be fetched, or whose `id` is
 *                       not its own address; a file found in no source;
 *                       one number shown by two canvases of a source or by
 *                       different images in two sources; two file names
 *                       for one canvas; a repository without manifest
 *                       rights: each is returned as the row's refusal.
 *   manifestBody        the bytes uploaded: the manifest's JSON and a line
 *                       break, as the retired command wrote the file it
 *                       put, so a manifest built again matches the one it
 *                       published byte for byte.
 *   sameJson            JSON equality with object keys in any order, which
 *                       decides whether an address already holds the
 *                       manifest built.
 *   manifestIdentity    an address without fragment or query, scheme and
 *                       host lowercased, which is how sources are compared.
 *   appendFormerCodes   `legacy_ids` with codes appended under
 *                       `former-reference-code`, the text read kept as it
 *                       is; `legacyIsArray` tells whether it can be.
 *
 * @version v0.9.0
 */

import {
  resolveManifestInputs,
  type ManifestDescription,
  type ManifestRepository,
} from "../../../app/lib/pipeline/manifest-inputs";
import { ManifestInputsError } from "../../../app/lib/pipeline/run-spec";
import { FORMER_REFERENCE_PROVIDER } from "../../../app/lib/export/former-codes.server";
import type { FederationHosting } from "../../../app/lib/export/attribution";
import type { RowReader } from "../authority-links";
import { escapeSql } from "../sql";

export const IIIF_CONTEXT = "http://iiif.io/api/presentation/3/context.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const blank = (v: unknown) => v === null || v === undefined || v === "";

// ---------------------------------------------------------------------------
// The federation's manifest address and bucket
// ---------------------------------------------------------------------------

export interface Place {
  federationId: string;
  baseUrl: string;
  /** `manifest_base_url` as stored, which a guard holds to. */
  storedBaseUrl: string;
  bucket: string;
  hosting: FederationHosting | null;
  tenant: { publicSiteUrl: string | null; publicSiteName: string | null; providerName: string | null; providerUrl: string | null; metsBaseUrl: string | null };
}

/** The federation's manifest address and bucket, its hosting statements and the tenant's public site; null without the address or the bucket. */
export async function readPlace(rows: RowReader, tenantId: string): Promise<Place | null> {
  const [t] = await rows(
    `SELECT t.public_site_url, t.public_site_name, t.provider_name, t.provider_url, t.mets_base_url, t.federation_id,
       f.manifest_base_url, f.manifest_bucket
     FROM tenants t LEFT JOIN federations f ON f.id = t.federation_id WHERE t.id = ${escapeSql(tenantId)}`,
  );
  if (!t || blank(t.manifest_base_url) || blank(t.manifest_bucket)) return null;
  // As readFederationHosting: a database without the columns has no statement.
  const present = await rows(
    "SELECT name FROM pragma_table_info('federations') WHERE name IN ('hosting_statement_es', 'hosting_statement_en')",
  );
  let hosting: FederationHosting | null = null;
  if (present.length === 2) {
    const [h] = await rows(
      `SELECT hosting_statement_es, hosting_statement_en FROM federations WHERE id = ${escapeSql(text(t.federation_id))}`,
    );
    if (h) hosting = { hostingStatementEs: (h.hosting_statement_es as string | null) ?? null, hostingStatementEn: (h.hosting_statement_en as string | null) ?? null };
  }
  const opt = (v: unknown) => (blank(v) ? null : String(v));
  return {
    federationId: text(t.federation_id),
    baseUrl: text(t.manifest_base_url).replace(/\/+$/, ""),
    storedBaseUrl: text(t.manifest_base_url),
    bucket: text(t.manifest_bucket),
    hosting,
    tenant: {
      publicSiteUrl: opt(t.public_site_url),
      publicSiteName: opt(t.public_site_name),
      providerName: opt(t.provider_name),
      providerUrl: opt(t.provider_url),
      metsBaseUrl: opt(t.mets_base_url),
    },
  };
}

/** The repository columns a manifest's statements are made from. */
export const REPOSITORY_READ = [
  "id", "code", "name", "city", "region", "country", "country_code", "manifest_rights", "credit_statement_es", "credit_statement_en",
  "attribution_en", "attribution_es",
] as const;

/** A repository row as `resolveManifestInputs` takes it. */
export function manifestRepository(repo: Record<string, unknown>): ManifestRepository {
  return {
    id: text(repo.id),
    code: text(repo.code),
    name: text(repo.name),
    city: repo.city as string | null,
    region: repo.region as string | null,
    country: repo.country as string | null,
    countryCode: repo.country_code as string | null,
    manifestRights: repo.manifest_rights as string | null,
    creditStatementEs: repo.credit_statement_es as string | null,
    creditStatementEn: repo.credit_statement_en as string | null,
    attributionEn: repo.attribution_en as string | null,
    attributionEs: repo.attribution_es as string | null,
  };
}

// ---------------------------------------------------------------------------
// A row's images
// ---------------------------------------------------------------------------

/** An image file name: the volume it was taken from, then `-img_NNNN` and an extension. */
export const IMAGE_FILE = /^(.+)-img_(\d+)\.[A-Za-z0-9]+$/;
/** The path segment and image number of a painting body id, `…/<segment>/img_NNNN/…`. */
const BODY_IMAGE = /\/([^/]+)\/img_(\d+)\//;

/** The volume a file name names, as image paths spell it: `AHRB_AHT_023` reads `ahrb-aht-023`. */
const volumeOf = (file: string) => IMAGE_FILE.exec(file)![1].toLowerCase().replace(/_/g, "-");

export interface ImagesGiven {
  first: string;
  last: string;
  count: string;
  images: string[];
  sources: string[];
}

const words = (v: string) => v.split(/\s+/).filter((w) => w !== "");

/** A set-images row's image columns. */
export function imagesOf(cells: Record<string, string>): ImagesGiven {
  return {
    first: cells.first_image,
    last: cells.last_image,
    count: cells.n_images,
    images: words(cells.images),
    sources: words(cells.source_manifest),
  };
}

/** The checks of a row's image columns against each other; null when they agree. */
export function imagesProblem(row: ImagesGiven): string | null {
  const n = row.images.length;
  if (n === 0) return "images is empty";
  if (row.count !== String(n)) return `n_images is ${JSON.stringify(row.count)} but images names ${n}`;
  if (row.first !== row.images[0]) return `first_image ${row.first} is not the first of images (${row.images[0]})`;
  if (row.last !== row.images[n - 1]) return `last_image ${row.last} is not the last of images (${row.images[n - 1]})`;
  const seen = new Set<string>();
  for (const f of row.images) {
    if (seen.has(f)) return `${f} is named twice`;
    seen.add(f);
    if (!IMAGE_FILE.test(f)) return `${f} is not an image file name of the form <volume>-img_NNNN.<ext>`;
  }
  if (row.sources.length === 0) return "no source manifest is given";
  return null;
}

/**
 * Whether a body's path segment is the file's volume or an item of it:
 * the segment, or the segment without a leading two-letter country code,
 * is the volume or starts with it and a hyphen. The published paths are
 * `co-ahrb-aht-008` for a legajo and `ahrb-aht-023-d011` for an item,
 * both from `AHRB_AHT_*` files.
 */
export function sameVolume(segment: string, volume: string): boolean {
  return [segment, segment.replace(/^[a-z]{2}-/, "")].some((s) => s === volume || s.startsWith(`${volume}-`));
}

/** The painting annotation of a canvas, when it has exactly one page with exactly one annotation. */
function paintingOf(canvas: Json): Json | null {
  if (!Array.isArray(canvas?.items) || canvas.items.length !== 1) return null;
  const page = canvas.items[0];
  if (!Array.isArray(page?.items) || page.items.length !== 1) return null;
  const a = page.items[0];
  return a && typeof a === "object" && a.body && typeof a.body.id === "string" ? a : null;
}

/** The source's canvases by the `img_NNNN` their painting body shows, each with its path segment. */
function canvasesByImage(source: Json): Map<string, Array<{ canvas: Json; segment: string }>> {
  const out = new Map<string, Array<{ canvas: Json; segment: string }>>();
  for (const canvas of Array.isArray(source.items) ? source.items : []) {
    const a = paintingOf(canvas);
    const m = a ? BODY_IMAGE.exec(a.body.id) : null;
    if (!m) continue;
    out.set(m[2], [...(out.get(m[2]) ?? []), { canvas, segment: m[1] }]);
  }
  return out;
}

/** A source canvas under the new manifest: ids and label renumbered, everything else as it was. */
function renumbered(canvas: Json, at: string, n: number): Json {
  const c = structuredClone(canvas);
  const cid = `${at}/canvas/${n}`;
  c.id = cid;
  c.label = { none: [`img ${n}`] };
  const page = c.items[0];
  page.id = `${cid}/page`;
  const a = page.items[0];
  a.id = `${cid}/annotation`;
  if ("target" in a) a.target = cid;
  return c;
}

/** The manifest, with the top-level fields in the order the published manifests use. */
function manifestOf(top: Json, canvases: Json[]): Json {
  const m: Json = { "@context": IIIF_CONTEXT, id: top.id, type: "Manifest", label: top.label };
  if (top.metadata !== undefined) m.metadata = top.metadata;
  if (top.summary !== undefined) m.summary = top.summary;
  if (top.required_statement !== null && top.required_statement !== undefined) m.requiredStatement = top.required_statement;
  if (top.rights !== null && top.rights !== undefined) m.rights = top.rights;
  m.provider = top.provider;
  if (top.see_also !== undefined) m.seeAlso = top.see_also;
  if (top.homepage !== undefined) m.homepage = top.homepage;
  m.behavior = ["paged"];
  m.items = canvases;
  return m;
}

/** JSON equality with object keys in any order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => sameJson(v, (b as unknown[])[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => k in (b as object) && sameJson((a as Json)[k], (b as Json)[k]));
}

/**
 * A manifest's identity: its address without fragment or query, scheme
 * and host lowercased (the URL parser's spelling). Null when it is not
 * an absolute URL.
 */
export function manifestIdentity(address: string): string | null {
  try {
    const u = new URL(address);
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** The bytes a manifest is uploaded as: its JSON and a line break. */
export const manifestBody = (manifest: Json) => JSON.stringify(manifest) + "\n";

/** What a GET of an address gave: the status and, for a 200, the body as text. */
export interface Fetched {
  status: number;
  text?: string;
  error?: string;
}

/** A fetched manifest's JSON, or why it is not one. */
export function parseManifest(got: Fetched): { json: Json } | { error: string } {
  if (got.status !== 200) return { error: got.error ?? `HTTP ${got.status}` };
  try {
    const json = JSON.parse(got.text ?? "");
    if (!json || typeof json !== "object" || Array.isArray(json)) return { error: "not a JSON object" };
    return { json };
  } catch (err) {
    return { error: `not JSON: ${(err as Error).message}` };
  }
}

/**
 * The manifest a row's images make at `url`: the canvases of its
 * sources, matched to its file names, under the descriptive fields given
 * and the repository's statements. A problem is returned as the row's
 * refusal. `fetched` holds every source the file names, already fetched.
 */
export function buildManifest(
  row: ImagesGiven & { referenceCode: string },
  url: string,
  fields: ManifestDescription,
  repository: Record<string, unknown> | undefined,
  repositoryId: string,
  place: Place,
  fetched: Map<string, Fetched>,
): { bad: string } | { manifest: Json; canvases: number; identities: string[] } {
  const sources: Json[] = [];
  const identities: string[] = [];
  for (const s of row.sources) {
    const identity = manifestIdentity(s);
    if (identity === null) return { bad: `the source manifest ${s} is not an absolute URL` };
    const got = parseManifest(fetched.get(s) ?? { status: 0, error: "not fetched" });
    if ("error" in got || !Array.isArray(got.json.items)) {
      return { bad: `the source manifest ${s} cannot be fetched: ${"error" in got ? got.error : "it has no items"}` };
    }
    // A source is known by its address and its id, which must agree.
    const own = typeof got.json.id === "string" ? manifestIdentity(got.json.id) : null;
    if (own !== identity) return { bad: `the source manifest ${s} is not the manifest at its address: its id is ${JSON.stringify(got.json.id)}` };
    sources.push(got.json);
    identities.push(identity);
  }
  const maps = sources.map(canvasesByImage);
  const canvases: Json[] = [];
  const missing: string[] = [];
  const chosen = new Map<string, string>();
  for (const f of row.images) {
    const n = IMAGE_FILE.exec(f)![2];
    const volume = volumeOf(f);
    const hits = maps
      .map((m, i) => ({ i, c: (m.get(n) ?? []).filter((e) => sameVolume(e.segment, volume)).map((e) => e.canvas) }))
      .filter((h) => h.c.length > 0);
    if (hits.length === 0) {
      missing.push(`${f} (${volume}, img_${n})`);
      continue;
    }
    const twice = hits.find((h) => h.c.length > 1);
    if (twice) return { bad: `img_${n} is shown by ${twice.c.length} canvases of ${row.sources[twice.i]}` };
    const bodies = new Set(hits.map((h) => paintingOf(h.c[0])!.body.id));
    if (bodies.size > 1) return { bad: `img_${n} is shown by different images in ${hits.map((h) => row.sources[h.i]).join(" and ")}` };
    const body = paintingOf(hits[0].c[0])!.body.id as string;
    if (chosen.has(body)) return { bad: `${chosen.get(body)} and ${f} name the same canvas (${body})` };
    chosen.set(body, f);
    canvases.push(hits[0].c[0]);
  }
  if (missing.length > 0) return { bad: `not in ${row.sources.join(" ")}: ${missing.join(", ")}` };
  if (!repository) return { bad: `its repository ${repositoryId} is not found` };
  let top: Json;
  try {
    top = resolveManifestInputs(place.baseUrl, row.referenceCode, fields, manifestRepository(repository), place.tenant, place.hosting) as unknown as Json;
  } catch (err) {
    if (err instanceof ManifestInputsError) return { bad: `its manifest fields cannot be built: ${err.message}` };
    throw err;
  }
  const at = url.replace(/\/manifest\.json$/, "");
  return { manifest: manifestOf(top, canvases.map((c, i) => renumbered(c, at, i + 1))), canvases: canvases.length, identities };
}

// ---------------------------------------------------------------------------
// Former codes
// ---------------------------------------------------------------------------

/** `legacy_ids` with each code appended under the former-reference provider, the text read kept as it is. */
export function appendFormerCodes(stored: string | null, codes: string[]): string {
  const add = codes.map((id) => JSON.stringify({ provider: FORMER_REFERENCE_PROVIDER, id })).join(",");
  if (stored === null || stored.trim() === "" || (JSON.parse(stored) as unknown[]).length === 0) return `[${add}]`;
  const end = stored.lastIndexOf("]");
  return `${stored.slice(0, end)},${add}${stored.slice(end)}`;
}

/** Whether `legacy_ids` is a JSON list (or blank), so codes can be appended to it. */
export function legacyIsArray(stored: string | null): boolean {
  if (stored === null || stored.trim() === "") return true;
  try {
    return Array.isArray(JSON.parse(stored));
  } catch {
    return false;
  }
}

// @version v0.9.0
