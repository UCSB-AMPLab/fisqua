/**
 * Capture Link — Manifest Delivery and Volume Status
 *
 * This module deals with the two calls a Captua unit makes to Fisqua
 * over the direct link the Captua exchange contract defines: delivering a
 * capture manifest (`POST /api/capture/v1/manifests`,
 * `handleManifestDelivery`) and asking how its volumes are getting on
 * (`GET /api/capture/v1/volumes/status?refs=...`, `handleVolumeStatus`).
 * The route modules are thin shells around these two functions, which
 * take their database, settings, `fetch`, clock and id source as
 * arguments, so the tests run them against fakes.
 *
 * Both are machine calls. They run no session middleware and take no
 * cookie, and nothing about them is a browser form, so no Origin or
 * CSRF check applies. The tenant is the request's host
 * (`getTenantFromRequest`: an unknown, disabled or reserved host gets a
 * bare 404). Authentication (`authenticate`) then reads the bearer
 * token: none, or one that is not 64 lowercase hex characters, is 401;
 * its SHA-256 is looked up among every tenant's scanners, and no match
 * is 401 as well; a match that belongs to another tenant, or that has
 * been revoked, is 403. The lookup crosses tenants so that a token sent
 * to the wrong tenant's host is told apart from an unknown one; it
 * reads one row by a unique hash and nothing else of the other tenant.
 * An authenticated call records `last_seen_at` and counts against the
 * scanner's fixed one-minute window in the same statement: past 60
 * calls in the window the answer is 429 with `Retry-After`, the seconds
 * until the window turns. Answers on these paths never redirect.
 *
 * Delivery runs these steps, and answers as the Captua exchange contract
 * prescribes:
 *
 *   1. A body over `MAX_MANIFEST_BYTES`, declared or streamed, is 413.
 *   2. A body that is not UTF-8 JSON, or not a JSON object, is 400
 *      (`malformed`); one whose `id` is not a UUID is 400 (`shape`). Before
 *      it is parsed, one pass over the text (`scanJsonText`) refuses a
 *      body nested deeper than 64 levels or holding more objects, arrays
 *      or values than any 5 MiB manifest could, unknown fields included,
 *      with 400 (`shape`).
 *      Neither is recorded, since there is no id to make it idempotent.
 *   3. The id is looked up among the tenant's deliveries. The same id
 *      with the same body (compared as parsed JSON, by the digest of its
 *      canonical form) gets the first answer verbatim, whatever has
 *      happened to the volume since; with another body it is 409
 *      (`id-reused`), and the first delivery is left as it was.
 *   4. The manifest is checked as registration has always checked it
 *      (`app/lib/capture/manifest.ts`): envelope and shape (400, rules
 *      `envelope`, `version`, `shape`, at most 100 listed and the rest
 *      counted); exactly one volume (422, `volume-count`, since the answer
 *      names one volume; more than one is refused before any other
 *      check); a reference
 *      code (422, `reference-code`); the transfer root `{slug}/` (422,
 *      `transfer-root`); the volume against a description of the tenant
 *      and any pipeline volume already registered for it; every page,
 *      key and digest, and every image's `rotateDeg` (422, with each
 *      check's rule; `rotate-deg` for a rotation other than 0, 90, 180
 *      or 270).
 *   5. A volume whose pipeline volume has left `received`, is held by an
 *      open run, or has ever been named by a run is 409 (`run-started`):
 *      once a run has started or finished, a newer manifest is refused
 *      and an admin decides.
 *   6. Every object the manifest names, the capture as shot (the RAW on
 *      a RAW rig) and the preview alike, is looked for in the
 *      federation's masters bucket with Fisqua's list-only key
 *      (`masters.server.ts`). Any one missing is 422 (`object-missing`),
 *      one problem per key with its capture id and role (`missingObjects`):
 *      Captua sends a manifest only once every object it names is
 *      verified in the bucket, so a gap means the object was removed
 *      after upload and is for a person to look into. This is stricter
 *      than the registration command, which refuses only a missing
 *      master and reports the others. Objects under the volume's prefix
 *      that the manifest does not name refuse nothing and are kept as the
 *      delivery's problems (`unlisted-object`). A bucket that cannot be listed,
 *      or a federation without the key, is 503 and is not recorded, so
 *      the unit sends the same document again.
 *   7. The volume is registered, or its page list replaced, and the
 *      delivery recorded, in one `db.batch`. Every statement is guarded
 *      by the state it was planned against: the description exists and
 *      no pipeline volume holds it yet (a new volume), or the volume is
 *      still `received`, a volume run, held by no open run and named by
 *      no run (a replacement). The delivery row is written only when the
 *      volume carries this request's write time, page count and pages,
 *      so a volume that changed between the read and the write is left
 *      alone and nothing is recorded; that answer is a 409 without
 *      problems, which the unit retries. The older registered delivery
 *      of the same volume, if any, becomes `superseded` in the same
 *      batch, and the approvals of the openings whose images the new
 *      manifest did not change come over to the new delivery with it
 *      (`carry.server.ts`). The answer is 200 `{state, manifestId, volumeId}`. The
 *      delivery has route `link` and names the scanner; the registration
 *      command writes a manifest file's volumes with the same statements
 *      (`buildRegistrationStatements`), as deliveries with route `file`
 *      (`file-route.server.ts`).
 *   8. A delivery this request registered is handed to `onRegistered`,
 *      when the caller gives one, so the route can start its review run
 *      after answering. A replay of an earlier answer, and a copy of the
 *      same id another request wrote first, are not handed on.
 *
 * Every refusal with an id (400, 409, 422) is recorded as a `refused`
 * delivery with its answer, so the same id gets the same answer again.
 * The answer is stored once, and a refusal's problems are read back
 * from it (status included). Every JSON column written to
 * `capture_deliveries` (an answer, an accepted delivery's notes and
 * records) goes through `packJson`, so a refusal naming every object of
 * a large volume, or a registration noting thousands of earlier objects
 * left in the bucket, fits a D1 row; an answer is replayed byte for byte.
 * Compression alone bounds nothing (a listing of high-entropy keys
 * barely compresses), so the packed columns of a row share a hard budget,
 * `ROW_BUDGET_BYTES`; a problems list past its share keeps its first
 * problems and ends with one `problems-truncated` entry (`packProblems`),
 * in the stored answer and so in every reply. A replacement raises the volume's `pages_revision`, at
 * which dispatch claims it.
 * A refused manifest holds nothing: it registers no volume and
 * supersedes nothing, and a later manifest with a new id is checked
 * afresh. Two copies of one id arriving together write one row; the
 * other is answered from it.
 *
 * Status shows each volume at most `STATUS_PROBLEMS_PER_VOLUME` problems,
 * then one `problems-truncated` entry counting every other stored one,
 * and keeps the whole response within `STATUS_BUDGET_BYTES` by showing
 * fewer; what is stored, and a replay of it, stay complete.
 *
 * Status reads, for each distinct ref asked for (1 to `MAX_STATUS_REFS`,
 * comma-separated; otherwise 400, rule `refs`), the delivery that holds
 * the reference code's volume, its pipeline volume, the latest run
 * that named the volume, the holding delivery's capture QC decision
 * set and its latest review run (`readLatestReviewRuns`), and maps them
 * with `captureLinkState` (`status.ts`). An entry
 * whose holding delivery has decisions also carries their `decisionsId`
 * and `decidedAt`, whatever its state. The delivery that holds the
 * volume is the one `registered` (`statusRows`): `refused` is final for
 * the unit, so a
 * manifest refused after an accepted one must not stop the unit
 * following a volume that carries on under the accepted one. The latest
 * delivery, when it is a refusal committed after that one, has its
 * problems added to the entry's, each naming the refused manifest's
 * id; the unit already had the refusal as the POST's answer. Only a ref
 * with no accepted delivery reports its latest delivery as it is,
 * `refused` included. Status reads only the light columns of those two
 * rows, then each one's problems column alone, one at a time, capped as
 * it is read. The run read (`readLatestRuns`), the choice of rows
 * (`statusRows`) and the problems read (`readProblems`) are exported
 * for the Volumes screen, which shows the same state for every volume
 * of the tenant. The answer is always `{ volumes: [...] }`, one entry
 * per ref, a ref Fisqua holds nothing for as `unknown`. Reads are made
 * in chunks that keep each statement under D1's 100 bound parameters.
 *
 * Nothing here logs a token, a hash or a body.
 *
 * @version v0.8.0
 */

import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  captureDeliveries,
  captureQcSets,
  captureScanners,
  descriptions,
  pipelineRunChunks,
  pipelineRuns,
  pipelineRunVolumes,
  pipelineVolumes,
} from "../../db/schema";
import type { Tenant } from "../../context";
import { getTenantFromRequest } from "../tenant";
import { rawBatchItem, readCappedBody } from "../pipeline/callback.server";
import { runHoldsVolumesSql } from "../pipeline/run-state.server";
import { readTenantFederation } from "../pipeline/tenant-destination.server";
import type { CaptureDeliveryRoute, CaptureDeliveryState, CaptureQcSetState } from "../validation/enums";
import {
  applyInventory,
  checkCaptureManifest,
  isRotateDeg,
  MANIFEST_ID_PATTERN,
  openingIdsOf,
  MAX_FIELD_CHARS,
  openingCount,
  planVolumes,
  rejectedRecordCount,
  transferRootProblem,
  type CaptureManifest,
  type CaptureProblem,
  type CaptureVolume,
  type DescriptionMatch,
  type ExistingVolume,
  type PlannedVolume,
} from "./manifest";
import { buildCarryForwardStatements } from "./carry.server";
import { readLatestReviewRuns } from "./review-run.server";
import { MastersListError, mastersListTarget, scanMasters } from "./masters.server";
import {
  captureLinkState,
  type StatusCaptureQc,
  type StatusDelivery,
  type StatusRun,
  type StatusVolume,
} from "./status";
import { bodyDigest, hashScannerToken, parseScannerBearer, scanJsonText } from "./token";

/**
 * The largest manifest accepted, in bytes. A Captua manifest takes about
 * 710 bytes per image as Captua writes it (measured on a staging test
 * manifest of 103 openings and 206 images, 146,585 bytes), so 5 MB holds
 * some 7,000 images, about 3,500 two-page openings: several times the
 * largest volume a unit hands over in one manifest, and small enough to
 * parse well inside a Worker's memory.
 */
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
/** Calls a token may make in one fixed one-minute window. */
export const RATE_LIMIT_PER_MINUTE = 60;
export const RATE_WINDOW_MS = 60_000;
/** Reference codes one status call may ask about. */
export const MAX_STATUS_REFS = 100;
/** Refs per read, under D1's 100 bound parameters with the tenant's. */
const READ_CHUNK = 50;
/** Pages per insert; each statement binds the chunk as one JSON value. */
const PAGES_PER_STATEMENT = 500;
/** Images per insert, bound the same way. */
const IMAGES_PER_STATEMENT = 300;

export interface CaptureLinkDeps {
  db: DrizzleD1Database<any>;
  env: object;
  fetch: typeof fetch;
  now: () => number;
  newId: () => string;
  /** Told of a delivery this request registered (step 8). */
  onRegistered?: (tenant: Tenant, deliveryId: string) => void;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function bare(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function stored(status: number, body: string): Response {
  return new Response(body, { status, headers: JSON_HEADERS });
}

const problemsBody = (problems: CaptureProblem[]) => ({ problems });

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

interface Authenticated {
  tenant: Tenant;
  scannerId: string;
}

/** The tenant and scanner of an authenticated call, or the answer to give instead. */
export async function authenticate(
  deps: CaptureLinkDeps,
  request: Request,
): Promise<Authenticated | Response> {
  let tenant: Tenant;
  try {
    tenant = await getTenantFromRequest(deps.db, request);
  } catch (thrown) {
    if (thrown instanceof Response) return bare(thrown.status === 403 ? 403 : 404);
    throw thrown;
  }
  const token = parseScannerBearer(request.headers.get("Authorization"));
  if (token === null) return bare(401, { "WWW-Authenticate": "Bearer" });
  const hash = await hashScannerToken(token);
  const scanner = await deps.db
    .select({ id: captureScanners.id, tenantId: captureScanners.tenantId, revokedAt: captureScanners.revokedAt })
    .from(captureScanners)
    .where(eq(captureScanners.tokenSha256, hash))
    .get();
  if (!scanner) return bare(401, { "WWW-Authenticate": "Bearer" });
  if (scanner.tenantId !== tenant.id || scanner.revokedAt !== null) return bare(403);

  const now = deps.now();
  const window = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const counted = await deps.db
    .update(captureScanners)
    .set({
      lastSeenAt: now,
      rateWindowCalls: sql`CASE WHEN ${captureScanners.rateWindowStart} = ${window} THEN ${captureScanners.rateWindowCalls} + 1 ELSE 1 END`,
      rateWindowStart: window,
    })
    .where(
      and(
        eq(captureScanners.id, scanner.id),
        eq(captureScanners.tenantId, tenant.id),
        eq(captureScanners.tokenSha256, hash),
        sql`${captureScanners.revokedAt} IS NULL`,
      ),
    )
    .returning({ calls: captureScanners.rateWindowCalls })
    .get();
  // Revoked or replaced between the read and the count.
  if (!counted) return bare(403);
  if (counted.calls > RATE_LIMIT_PER_MINUTE) {
    const wait = Math.max(1, Math.ceil((window + RATE_WINDOW_MS - now) / 1000));
    return bare(429, { "Retry-After": String(wait) });
  }
  return { tenant, scannerId: scanner.id };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type DeliveryRow = typeof captureDeliveries.$inferSelect;

async function readDelivery(db: DrizzleD1Database<any>, tenantId: string, id: string): Promise<DeliveryRow | undefined> {
  return db
    .select()
    .from(captureDeliveries)
    .where(and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, id)))
    .get();
}

function idReused(id: string): Response {
  return json(
    409,
    problemsBody([
      { rule: "id-reused", message: `The manifest id ${id} was delivered before with another body`, manifestId: id },
    ]),
  );
}

/**
 * A JSON column of `capture_deliveries` past this many bytes is stored
 * packed (`packJson`).
 */
export const PACK_THRESHOLD_BYTES = 64 * 1024;
const PACKED_PREFIX = '{"$gzip":"';

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/**
 * How every JSON column of `capture_deliveries` is written: as it stands
 * up to `PACK_THRESHOLD_BYTES`, past that as `{"$gzip":"<base64>"}`,
 * the text gzipped and base64-encoded. The packed form is still valid
 * JSON, and no stored value (an answer is an object of `problems` or
 * `state`, problems and records are arrays) starts the same way, so
 * `unpackJson` tells them apart by that prefix alone. Packing keeps a
 * row of a large volume under D1's 2 MB limit.
 */
export async function packJson(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= PACK_THRESHOLD_BYTES) return text;
  return JSON.stringify({ $gzip: toBase64(await through(bytes, new CompressionStream("gzip"))) });
}

/** A stored JSON column's text, exactly as it was written before packing. */
export async function unpackJson(stored: string): Promise<string> {
  if (!stored.startsWith(PACKED_PREFIX)) return stored;
  const { $gzip } = JSON.parse(stored) as { $gzip: string };
  return new TextDecoder().decode(await through(fromBase64($gzip), new DecompressionStream("gzip")));
}

/** The stored answer's text, exactly as it was first answered. */
export function answerText(row: Pick<DeliveryRow, "answerBody">): Promise<string> {
  return unpackJson(row.answerBody);
}

/** The answer a delivery row holds, or `id-reused` when it holds another body. */
/**
 * How a manifest id already recorded meets a body: the same digest is a
 * replay, answered as first recorded; another is refused as `id-reused`.
 * The registration command asks the same of a file's delivery ids.
 */
export function repeatedDelivery(recordedSha256: string, digest: string): "replay" | "id-reused" {
  return recordedSha256 === digest ? "replay" : "id-reused";
}

async function answerFrom(row: DeliveryRow, digest: string): Promise<Response> {
  if (repeatedDelivery(row.bodySha256, digest) === "id-reused") return idReused(row.id);
  return stored(row.answerStatus, await answerText(row));
}

interface DeliveryContext {
  deps: CaptureLinkDeps;
  tenant: Tenant;
  scannerId: string;
  id: string;
  digest: string;
  referenceCode: string | null;
}

/**
 * The tenant's next delivery sequence number, read inside the statement
 * that writes the row, so rows are numbered in the order they were
 * committed and not the order their requests arrived.
 */
function nextSeq(tenantId: string): SQL {
  return sql`(SELECT COALESCE(MAX(s.seq), 0) + 1 FROM capture_deliveries s WHERE s.tenant_id = ${tenantId})`;
}

/**
 * The bytes one `capture_deliveries` row may give its packed columns
 * together, well under D1's 2 MB row limit, which also holds the other
 * columns. An accepted delivery's records take up to
 * `RECORDS_BUDGET_BYTES` of it, its answer what it needs (under a
 * kilobyte) and its notes the rest; a refusal's answer takes all of it.
 */
export const ROW_BUDGET_BYTES = 1_500_000;
// The records of a manifest at the 5 MiB request limit pack to at most
// about 1.23 MB, with every id a random 53-bit integer; a test holds this.
export const RECORDS_BUDGET_BYTES = 1_300_000;
/**
 * The most a problems list may take unpacked, so that reading one back
 * (status, a replay) never holds more than this at once.
 */
export const MAX_UNPACKED_PROBLEMS_BYTES = 8_000_000;

/** A column that cannot be brought within its budget; nothing is stored. */
export class CaptureBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureBudgetError";
  }
}
/** The operator's rejection note, as far as a record keeps it. */
export const MAX_NOTE_CHARS = 2000;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** The entry that closes a problems list cut short to fit its budget. */
export function truncationEntry(omitted: number): CaptureProblem {
  return {
    rule: "problems-truncated",
    message: `${omitted} more problem${omitted === 1 ? " is" : "s are"} not listed`,
    omitted,
  };
}

/**
 * A list's problems and how many more it stands for: a list that already
 * ends in `problems-truncated` counts that entry's `omitted`.
 */
export function splitTruncated(list: CaptureProblem[]): { items: CaptureProblem[]; omitted: number } {
  const last = list[list.length - 1];
  if (last && last.rule === "problems-truncated" && typeof last.omitted === "number") {
    return { items: list.slice(0, -1), omitted: last.omitted };
  }
  return { items: list, omitted: 0 };
}

/** The first `keep` problems of a list, then one entry counting every problem left out. */
export function capProblems(list: CaptureProblem[], keep: number): CaptureProblem[] {
  const { items, omitted } = splitTruncated(list);
  const left = items.length - Math.min(keep, items.length) + omitted;
  return left > 0 ? [...items.slice(0, keep), truncationEntry(left)] : items;
}

/**
 * A problems list packed (`packJson`) within `budget` bytes, and within
 * `MAX_UNPACKED_PROBLEMS_BYTES` unpacked, through `wrap`, which turns a
 * list into the column's JSON. When the whole list does not fit, the
 * longest run of problems from its start that fits is kept, followed by
 * one `problems-truncated` entry counting the rest (and any the list had
 * already left out). The size of a packed list does not grow evenly with
 * its length, so the run is found by bisection over packed sizes. A
 * budget too small for even the truncation entry alone throws
 * `CaptureBudgetError`: the result is never past the budget.
 */
export async function packProblems(
  problems: CaptureProblem[],
  budget: number,
  wrap: (list: CaptureProblem[]) => string,
): Promise<string> {
  const fits = (text: string, packed: string) =>
    byteLength(text) <= MAX_UNPACKED_PROBLEMS_BYTES && byteLength(packed) <= budget;
  const wholeText = wrap(problems);
  const whole = await packJson(wholeText);
  if (fits(wholeText, whole)) return whole;
  const { items, omitted } = splitTruncated(problems);
  const cut = async (k: number) => {
    const text = wrap(capProblems([...items, ...(omitted > 0 ? [truncationEntry(omitted)] : [])], k));
    return { text, packed: await packJson(text) };
  };
  const none = await cut(0);
  if (!fits(none.text, none.packed)) {
    throw new CaptureBudgetError(`A budget of ${budget} bytes cannot hold even the truncation entry`);
  }
  let best = none.packed;
  let lo = 1;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const c = await cut(mid);
    if (fits(c.text, c.packed)) {
      best = c.packed;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * The accepted manifest's records, packed within `budget`
 * (`RECORDS_BUDGET_BYTES`): each opening with its rejection note cut to
 * `MAX_NOTE_CHARS`, and shorter (200 characters, then none) only if the
 * notes would not fit otherwise. Records without notes are bounded by the
 * 5 MiB request: the most openings a manifest can name, each with
 * arbitrary ids, pack well inside the share (a test holds this). Should
 * they not fit, `CaptureBudgetError` is thrown and nothing is stored.
 */
export async function packRecords(v: CaptureVolume, budget: number = RECORDS_BUDGET_BYTES): Promise<string> {
  for (const noteChars of [MAX_NOTE_CHARS, 200, 0]) {
    const packed = await packJson(JSON.stringify(recordsOf(v, noteChars)));
    if (byteLength(packed) <= budget) return packed;
  }
  throw new CaptureBudgetError(`The records do not fit ${budget} bytes even without notes`);
}

/**
 * The `unlisted-object` notes of a scan of the volume's prefix: one per
 * object the scan kept, then `problems-truncated` counting the rest.
 */
export function unlistedNotes(stem: string, scan: { unlisted: Array<{ key: string; size: number }>; unlistedOmitted: number }): CaptureProblem[] {
  const notes: CaptureProblem[] = scan.unlisted.map((o) => ({
    rule: "unlisted-object",
    message: `${o.key} is in the masters bucket and not in the manifest`,
    stem,
    objectKey: o.key,
    size: o.size,
  }));
  return scan.unlistedOmitted > 0 ? [...notes, truncationEntry(scan.unlistedOmitted)] : notes;
}

/** Records a refusal and answers with whatever the row holds afterwards. */
async function refuse(ctx: DeliveryContext, status: 400 | 409 | 422, problems: CaptureProblem[]): Promise<Response> {
  const { deps, tenant } = ctx;
  // The problems are kept once, in the answer, within the row's budget;
  // the answer given is the one stored, so a replay matches it.
  let packed: string;
  try {
    packed = await packProblems(problems, ROW_BUDGET_BYTES, (list) => JSON.stringify(problemsBody(list)));
  } catch (err) {
    if (err instanceof CaptureBudgetError) return json(500, {});
    throw err;
  }
  await deps.db
    .insert(captureDeliveries)
    .values({
      tenantId: tenant.id,
      id: ctx.id,
      route: "link",
      scannerId: ctx.scannerId,
      referenceCode: ctx.referenceCode,
      pipelineVolumeId: null,
      bodySha256: ctx.digest,
      state: "refused",
      problems: "[]",
      answerStatus: status,
      answerBody: packed,
      records: null,
      openings: 0,
      receivedAt: deps.now(),
      seq: nextSeq(tenant.id),
    })
    .onConflictDoNothing()
    .run();
  const row = await readDelivery(deps.db, tenant.id, ctx.id);
  return row ? answerFrom(row, ctx.digest) : stored(status, await unpackJson(packed));
}

/**
 * The manifest's records, which capture QC decisions are made against
 * (`qc.server.ts`). Their images are rows of `capture_images` (`imagesOf`).
 */
function recordsOf(v: CaptureVolume, noteChars: number = MAX_NOTE_CHARS) {
  return v.records.map((r) => ({
    captuaRecordId: r.captuaRecordId,
    sequence: r.sequence,
    status: r.status,
    rejectionNote: r.rejectionNote === null ? null : Array.from(r.rejectionNote).slice(0, noteChars).join(""),
  }));
}

/** One image of an accepted manifest, with every object it names. */
export interface DeliveredImage {
  captuaRecordId: number;
  captureId: string;
  pairId: string | null;
  role: string;
  pageKey: string;
  captureKey: string;
  captureSha256: string;
  captureBytes: number | null;
  previewKey: string | null;
  previewSha256: string | null;
  previewBytes: number | null;
  /** The status of the image's record in the manifest. */
  recordStatus: string;
  /** The image's `rotateDeg`; null when the manifest left it out or gave null. */
  rotateDeg: number | null;
}

/**
 * Every image of the manifest, any record status, with the capture (the
 * RAW on a RAW rig, kept for preservation) and the preview where there
 * is one: full object key, digest, and size as the masters listing gave
 * it, and its record's status, which tells an opening's images from the
 * rest, and its `rotateDeg`, null when the manifest left it out or gave
 * null. A manifest naming an absent object is refused before this, so
 * the sizes are always there; null is kept for an object the listing
 * lacks.
 */
export function imagesOf(v: CaptureVolume, root: string, listing: Map<string, number>): DeliveredImage[] {
  return v.records.flatMap((r) =>
    r.images.map((i) => {
      const captureKey = `${root}${i.objectKey}`;
      const previewKey = i.previewObjectKey === undefined ? null : `${root}${i.previewObjectKey}`;
      return {
        captuaRecordId: r.captuaRecordId,
        captureId: i.captureId,
        pairId: i.pairId,
        role: i.role,
        pageKey: i.filename.replace(/\.[^.]+$/, ""),
        captureKey,
        captureSha256: i.sha256,
        captureBytes: listing.get(captureKey) ?? null,
        previewKey,
        previewSha256: i.previewSha256 ?? null,
        previewBytes: previewKey === null ? null : listing.get(previewKey) ?? null,
        recordStatus: r.status,
        // `planPages` has refused any other value before this is read.
        rotateDeg: isRotateDeg(i.rotateDeg) ? i.rotateDeg : null,
      };
    }),
  );
}

/**
 * One `object-missing` problem for each object the manifest names that
 * the masters listing does not hold, capture or preview, any record
 * status. The shape is the one agreed with Captua, exactly:
 * `{rule, message, objectKey, captureId, role, kind}`, where
 * `objectKey` is the key as the manifest writes it (`objectKey` or
 * `previewObjectKey`, relative to `transfer.root`), `captureId` and
 * `role` are the image's, and `kind` is `capture` or `preview`.
 */
export function missingObjects(v: CaptureVolume, root: string, listing: Map<string, number>): CaptureProblem[] {
  const out: CaptureProblem[] = [];
  for (const r of v.records) {
    for (const i of r.images) {
      const objects: Array<["capture" | "preview", string]> = [["capture", i.objectKey]];
      if (i.previewObjectKey !== undefined) objects.push(["preview", i.previewObjectKey]);
      for (const [kind, key] of objects) {
        if (listing.has(`${root}${key}`)) continue;
        out.push({
          rule: "object-missing",
          message: `The ${kind} ${key} is named by the manifest and is not in the masters bucket`,
          objectKey: key,
          captureId: i.captureId,
          role: i.role,
          kind,
        });
      }
    }
  }
  return out;
}

async function readExisting(
  db: DrizzleD1Database<any>,
  tenantId: string,
  description: DescriptionMatch,
  now: number,
): Promise<ExistingVolume[]> {
  const rows = await db
    .select({
      id: pipelineVolumes.id,
      descriptionId: pipelineVolumes.descriptionId,
      referenceCode: pipelineVolumes.referenceCode,
      kind: pipelineVolumes.kind,
      state: pipelineVolumes.state,
      held: sql<number>`EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = pipeline_volumes.held_by_run_id AND r.tenant_id = ${tenantId} AND (${runHoldsVolumesSql(now)}))`,
      ran: sql<number>`EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.pipeline_volume_id = pipeline_volumes.id AND rv.tenant_id = ${tenantId})`,
    })
    .from(pipelineVolumes)
    .where(
      and(
        eq(pipelineVolumes.tenantId, tenantId),
        or(eq(pipelineVolumes.descriptionId, description.id), eq(pipelineVolumes.referenceCode, description.referenceCode)),
      ),
    )
    .all();
  return rows.map((r) => ({ ...r, held: Number(r.held) === 1, ran: Number(r.ran) === 1 }));
}

/**
 * The volume, still received, a volume run, held by no open run and
 * named by no run: the state a registration is planned against, and the
 * one capture QC decisions may be recorded in (`qc.server.ts`).
 */
export function volumeStillOpen(tenantId: string, volumeId: string, now: number): SQL {
  return sql`EXISTS (SELECT 1 FROM pipeline_volumes v WHERE v.tenant_id = ${tenantId} AND v.id = ${volumeId} AND v.state = 'received' AND v.kind = 'volume_run' AND (v.held_by_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.tenant_id = ${tenantId} AND r.id = v.held_by_run_id AND (${runHoldsVolumesSql(now)}))) AND NOT EXISTS (SELECT 1 FROM pipeline_run_volumes rv WHERE rv.tenant_id = ${tenantId} AND rv.pipeline_volume_id = v.id))`;
}

interface MastersColumns {
  endpoint: string;
  bucket: string;
}

/**
 * The statements of step 7, in order. Pure: it builds, it does not run.
 * The registration command builds its file from these as well
 * (`file-route.server.ts`): a file delivery has route `file`, no
 * scanner, and smaller chunks, since its statements are written out as
 * SQL text and D1 caps a statement at 100 KB.
 */
export function buildRegistrationStatements(
  db: DrizzleD1Database<any>,
  w: {
    tenantId: string;
    route: CaptureDeliveryRoute;
    /** The scanner of a link delivery; null for a file delivery. */
    scannerId: string | null;
    manifestId: string;
    digest: string;
    volume: PlannedVolume;
    masters: MastersColumns;
    /** The notes and records as stored, through `packJson`. */
    notes: string;
    records: string;
    /** The manifest volume's openings (`openingCount`), which the hold reads. */
    openings: number;
    /** The manifest volume's `rejected` records (`rejectedRecordCount`), which the hold reads. */
    rejectedRecords: number;
    /** The Captua record ids of those openings, which a retake's carried approvals are limited to. */
    openingIds: number[];
    images: DeliveredImage[];
    answerBody: string;
    now: number;
    newId: () => string;
    /** Pages per insert; `PAGES_PER_STATEMENT` unless given. */
    pagesPerStatement?: number;
    /** Images per insert; `IMAGES_PER_STATEMENT` unless given. */
    imagesPerStatement?: number;
  },
): BatchItem<"sqlite">[] {
  const { tenantId: t, volume: v, now } = w;
  const volumeId = v.volumeId as string;
  const descriptionId = v.descriptionId as string;
  const code = v.referenceCode as string;
  const pages = v.pages ?? [];
  const count = pages.length;
  const pagesPer = w.pagesPerStatement ?? PAGES_PER_STATEMENT;
  const imagesPer = w.imagesPerStatement ?? IMAGES_PER_STATEMENT;
  const out: BatchItem<"sqlite">[] = [];

  if (v.action === "register") {
    out.push(
      rawBatchItem(
        db,
        sql`INSERT INTO pipeline_volumes (id, tenant_id, description_id, reference_code, kind, state,
          masters_backend, masters_endpoint, masters_bucket, masters_prefix, masters_key, checksums_key,
          expected_count, recipe_scope_description_id, restricted, created_at, updated_at)
        SELECT ${volumeId}, ${t}, ${descriptionId}, ${code}, 'volume_run', 'received',
          'b2', ${w.masters.endpoint}, ${w.masters.bucket}, ${v.mastersPrefix as string}, NULL, NULL,
          ${count}, ${descriptionId}, 0, ${now}, ${now}
        WHERE EXISTS (SELECT 1 FROM descriptions d WHERE d.tenant_id = ${t} AND d.id = ${descriptionId} AND d.reference_code = ${code})
          AND NOT EXISTS (SELECT 1 FROM pipeline_volumes pv WHERE pv.tenant_id = ${t} AND (pv.description_id = ${descriptionId} OR pv.reference_code = ${code}))`,
      ),
    );
  } else {
    out.push(
      db
        .update(pipelineVolumes)
        .set({
          mastersBackend: "b2",
          mastersEndpoint: w.masters.endpoint,
          mastersBucket: w.masters.bucket,
          mastersPrefix: v.mastersPrefix as string,
          expectedCount: count,
          updatedAt: now,
          // Dispatch claims the volume only at the revision it read.
          pagesRevision: sql`${pipelineVolumes.pagesRevision} + 1`,
        })
        .where(
          and(
            eq(pipelineVolumes.tenantId, t),
            eq(pipelineVolumes.id, volumeId),
            volumeStillOpen(t, volumeId, now),
          ),
        ),
    );
    out.push(
      rawBatchItem(
        db,
        sql`DELETE FROM pipeline_volume_pages WHERE tenant_id = ${t} AND pipeline_volume_id = ${volumeId}
          AND ${volumeStillOpen(t, volumeId, now)}`,
      ),
    );
  }

  // Names this batch's delivery row, so its image rows go under it and
  // under no other, and its page rows: each page's id is the write id, a
  // dot and the page's sequence, so the closing guard recognises this
  // batch's pages by that prefix in a statement of fixed size, however
  // many pages the volume has.
  const writeId = w.newId();
  const pagePrefix = `${writeId}.`;
  const pageRows = pages.map((p) => ({ id: `${pagePrefix}${p.seq}`, seq: p.seq, k: p.pageKey, m: p.masterKey, s: p.sha256 }));
  for (let i = 0; i < pageRows.length; i += pagesPer) {
    const chunk = JSON.stringify(pageRows.slice(i, i + pagesPer));
    out.push(
      rawBatchItem(
        db,
        sql`INSERT INTO pipeline_volume_pages (id, tenant_id, pipeline_volume_id, seq, page_key, master_key, pdf_page, sha256)
        SELECT json_extract(j.value, '$.id'), pv.tenant_id, pv.id, json_extract(j.value, '$.seq'),
          json_extract(j.value, '$.k'), json_extract(j.value, '$.m'), NULL, json_extract(j.value, '$.s')
        FROM json_each(${chunk}) j
        JOIN pipeline_volumes pv ON pv.tenant_id = ${t} AND pv.id = ${volumeId}
        WHERE ${volumeStillOpen(t, volumeId, now)}`,
      ),
    );
  }

  // Every write above landed: the volume is still in the state they were
  // guarded by, carries this request's write time and page count, and
  // its pages are exactly the rows this request wrote. The supersede and
  // the delivery are written only then, so a delivery is never recorded
  // as accepted over pages it did not write.
  const landed = writesLanded(t, volumeId, now, count, pagePrefix);

  // The older registered delivery of the volume, before the new one is
  // written: at most one delivery per volume is registered (a partial
  // unique index), and it is the one that holds the volume.
  out.push(
    db
      .update(captureDeliveries)
      .set({ state: "superseded", supersededBy: w.manifestId, supersededAt: now })
      .where(
        and(
          eq(captureDeliveries.tenantId, t),
          eq(captureDeliveries.pipelineVolumeId, volumeId),
          eq(captureDeliveries.state, "registered"),
          ne(captureDeliveries.id, w.manifestId),
          landed,
        ),
      ),
  );

  out.push(
    rawBatchItem(
      db,
      sql`INSERT INTO capture_deliveries (tenant_id, id, route, scanner_id, reference_code, pipeline_volume_id, body_sha256,
          state, problems, answer_status, answer_body, records, openings, rejected_records, received_at, superseded_by,
          superseded_at, seq, write_id)
        SELECT ${t}, ${w.manifestId}, ${w.route}, ${w.scannerId}, ${code}, ${volumeId}, ${w.digest},
          'registered', ${w.notes}, 200, ${w.answerBody}, ${w.records}, ${w.openings}, ${w.rejectedRecords}, ${now},
          NULL, NULL, ${nextSeq(t)}, ${writeId}
        WHERE EXISTS (SELECT 1 FROM pipeline_volumes v WHERE v.tenant_id = ${t} AND v.id = ${volumeId})
          AND ${landed}`,
    ),
  );

  // The images, every object each names, under the delivery this batch
  // wrote, recognised by its write id: a copy of the same manifest id
  // planned at the same time finds another batch's row under that id,
  // and must not add its images to it.
  for (let i = 0; i < w.images.length; i += imagesPer) {
    const chunk = JSON.stringify(
      w.images.slice(i, i + imagesPer).map((img) => ({ id: w.newId(), ...img })),
    );
    out.push(
      rawBatchItem(
        db,
        sql`INSERT INTO capture_images (id, tenant_id, delivery_id, captua_record_id, capture_id, pair_id, role, page_key,
          capture_key, capture_sha256, capture_bytes, preview_key, preview_sha256, preview_bytes, record_status, rotate_deg)
        SELECT json_extract(j.value, '$.id'), d.tenant_id, d.id, json_extract(j.value, '$.captuaRecordId'),
          json_extract(j.value, '$.captureId'), json_extract(j.value, '$.pairId'), json_extract(j.value, '$.role'),
          json_extract(j.value, '$.pageKey'), json_extract(j.value, '$.captureKey'), json_extract(j.value, '$.captureSha256'),
          json_extract(j.value, '$.captureBytes'), json_extract(j.value, '$.previewKey'),
          json_extract(j.value, '$.previewSha256'), json_extract(j.value, '$.previewBytes'),
          json_extract(j.value, '$.recordStatus'), json_extract(j.value, '$.rotateDeg')
        FROM json_each(${chunk}) j
        JOIN capture_deliveries d ON d.tenant_id = ${t} AND d.id = ${w.manifestId} AND d.state = 'registered'
          AND d.write_id = ${writeId}`,
      ),
    );
  }

  // A retake: the approvals of the openings whose images it did not
  // change come over from the delivery it superseded (`carry.server.ts`).
  if (v.action !== "register") {
    out.push(
      ...buildCarryForwardStatements(db, {
        tenantId: t,
        volumeId,
        deliveryId: w.manifestId,
        writeId,
        openings: w.openings,
        openingIds: w.openingIds,
        decisionsId: w.newId(),
        now,
      }),
    );
  }
  return out;
}

/** The closing guard of a registration batch (see `buildRegistrationStatements`). */
function writesLanded(tenantId: string, volumeId: string, now: number, count: number, pagePrefix: string): SQL {
  return sql`${volumeStillOpen(tenantId, volumeId, now)}
    AND EXISTS (SELECT 1 FROM pipeline_volumes lv WHERE lv.tenant_id = ${tenantId} AND lv.id = ${volumeId}
      AND lv.updated_at = ${now} AND lv.expected_count = ${count})
    AND (SELECT COUNT(*) FROM pipeline_volume_pages p WHERE p.tenant_id = ${tenantId} AND p.pipeline_volume_id = ${volumeId}) = ${count}
    AND (SELECT COUNT(*) FROM pipeline_volume_pages q WHERE q.tenant_id = ${tenantId} AND q.pipeline_volume_id = ${volumeId}
      AND substr(q.id, 1, ${pagePrefix.length}) = ${pagePrefix}) = ${count}`;
}

function runStarted(code: string, detail: string): CaptureProblem {
  return {
    rule: "run-started",
    message: `A pipeline run has started or finished on the volume ${code} (${detail}); a Fisqua admin decides`,
    referenceCode: code,
  };
}

export async function handleManifestDelivery(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "POST") return bare(405, { Allow: "POST" });
  const auth = await authenticate(deps, request);
  if (auth instanceof Response) return auth;
  const { tenant, scannerId } = auth;

  // 1–2. Size, then JSON.
  const bytes = await readCappedBody(request, MAX_MANIFEST_BYTES);
  if (bytes === null) return bare(413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return json(400, problemsBody([{ rule: "malformed", message: "The body is not UTF-8 JSON" }]));
  }
  // Bounded before it is parsed: nesting, containers and values, in one
  // pass over the text, so neither parsing nor canonicalising can run
  // out of stack or memory on what no manifest would hold.
  const scanned = scanJsonText(text);
  if (!scanned.ok) return json(400, problemsBody([{ rule: "shape", message: scanned.message, path: "(root)" }]));
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, problemsBody([{ rule: "malformed", message: "The body is not UTF-8 JSON" }]));
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return json(400, problemsBody([{ rule: "malformed", message: "The body is not a JSON object" }]));
  }
  const id = (raw as Record<string, unknown>).id;
  if (typeof id !== "string" || !MANIFEST_ID_PATTERN.test(id)) {
    return json(400, problemsBody([{ rule: "shape", message: "id: the manifest id is not a UUID", path: "id" }]));
  }

  // 3. A repeated id.
  const digest = await bodyDigest(raw);
  const earlier = await readDelivery(deps.db, tenant.id, id);
  if (earlier) return await answerFrom(earlier, digest);

  // 4. The manifest's checks.
  const volumes = (raw as Record<string, unknown>).volumes;
  const first = Array.isArray(volumes) && volumes.length === 1 ? (volumes[0] as Record<string, unknown> | null) : null;
  // Kept on a refusal only when it could be a reference code at all, so
  // an outsized value never reaches the row.
  const firstCode =
    first && typeof first.externalId === "string" && first.externalId.length <= MAX_FIELD_CHARS ? first.externalId : null;
  const ctx: DeliveryContext = { deps, tenant, scannerId, id, digest, referenceCode: firstCode };

  const checked = checkCaptureManifest(raw, { maxVolumes: 1 });
  if (!checked.ok) {
    // Over-long fields and a second volume are 422; any other shape
    // problem makes the body malformed, 400.
    const unprocessable = checked.problems.every((p) => p.rule === "field-too-long" || p.rule === "volume-count");
    return refuse(ctx, unprocessable ? 422 : 400, checked.problems);
  }
  const manifest: CaptureManifest = checked.manifest;
  if (manifest.volumes.length !== 1) {
    return refuse(ctx, 422, [
      {
        rule: "volume-count",
        message: `A manifest delivered over the link names one volume; this one names ${manifest.volumes.length}`,
        count: manifest.volumes.length,
      },
    ]);
  }
  const v = manifest.volumes[0];
  if (v.externalId === null) {
    return refuse(ctx, 422, [{ rule: "reference-code", message: "The volume has no reference code", stem: v.stem }]);
  }
  const root = transferRootProblem(manifest, tenant.slug);
  if (root) return refuse(ctx, 422, [root]);

  const now = deps.now();
  const description = await deps.db
    .select({ id: descriptions.id, referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.referenceCode, v.externalId)))
    .get();
  const matches = new Map<string, DescriptionMatch>();
  if (description) matches.set(description.referenceCode, description);
  const existing = description ? await readExisting(deps.db, tenant.id, description, now) : [];

  const [planned] = planVolumes({
    manifest,
    slug: tenant.slug,
    descriptions: matches,
    existing,
    newId: deps.newId,
  });
  if (planned.action === "skip") {
    const status = planned.reason === "not_received" || planned.reason === "held_by_run" ? 409 : 422;
    const problems =
      status === 409 ? [runStarted(v.externalId, (planned.detail ?? []).join("; ") || "held by a run")] : planned.issues ?? [];
    return refuse(ctx, status, problems);
  }

  // 6. The masters bucket.
  const federation = await readTenantFederation(deps.db, tenant);
  let scan: Awaited<ReturnType<typeof scanMasters>>;
  try {
    const target = mastersListTarget(federation, deps.env);
    const named = new Set((planned.objects ?? []).map((o) => o.key));
    scan = await scanMasters(target, planned.mastersPrefix as string, named, deps.fetch);
  } catch (err) {
    if (err instanceof MastersListError) return bare(503, { "Retry-After": "60" });
    throw err;
  }
  const listing = scan.present;
  const missing = missingObjects(v, manifest.transfer.root, listing);
  if (missing.length > 0) return refuse(ctx, 422, missing);
  const [inventoried] = applyInventory([planned], new Map([[planned.mastersPrefix as string, listing]]));
  if (inventoried.action === "skip") return refuse(ctx, 422, inventoried.issues ?? []);

  // 7. The writes.
  const answerBody = JSON.stringify({ state: "registered", manifestId: id, volumeId: inventoried.volumeId });
  // The row's budget: the records first, then the answer, the notes the rest.
  let records: string;
  let packedAnswer: string;
  let notes: string;
  try {
    records = await packRecords(v);
    packedAnswer = await packJson(answerBody);
    notes = await packProblems(
      unlistedNotes(v.stem, scan),
      ROW_BUDGET_BYTES - byteLength(records) - byteLength(packedAnswer),
      (list) => JSON.stringify(list),
    );
  } catch (err) {
    // Never written: a row past its budget would fail in D1 on every retry.
    if (err instanceof CaptureBudgetError) return json(500, {});
    throw err;
  }
  // The ids the statements are built with, the write id among them, so
  // step 8 can tell this request's registration from another's.
  const minted = new Set<string>();
  const statements = buildRegistrationStatements(deps.db, {
    tenantId: tenant.id,
    route: "link",
    scannerId,
    manifestId: id,
    digest,
    volume: inventoried,
    masters: {
      endpoint: (federation?.pipelineDeliveryEndpoint as string).replace(/\/+$/, ""),
      bucket: federation?.pipelineMastersBucket as string,
    },
    notes,
    records,
    openings: openingCount(v),
    rejectedRecords: rejectedRecordCount(v),
    openingIds: openingIdsOf(v),
    images: imagesOf(v, manifest.transfer.root, listing),
    answerBody: packedAnswer,
    now,
    newId: () => {
      const made = deps.newId();
      minted.add(made);
      return made;
    },
  });
  try {
    await deps.db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    // Another copy of this id may have been written first.
    const row = await readDelivery(deps.db, tenant.id, id);
    if (row) return answerFrom(row, digest);
    throw err;
  }
  const row = await readDelivery(deps.db, tenant.id, id);
  if (!row) return json(409, {});
  const answer = await answerFrom(row, digest);
  // 8. Only this request's own registration is handed on.
  if (answer.status === 200 && row.state === "registered" && row.writeId !== null && minted.has(row.writeId)) {
    deps.onRegistered?.(tenant, id);
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function parseProblems(stored: string | null): Promise<CaptureProblem[]> {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(await unpackJson(stored));
    return Array.isArray(parsed) ? (parsed as CaptureProblem[]) : [];
  } catch {
    return [];
  }
}

function errorClassOf(text: string | null): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { class?: unknown };
    return typeof parsed.class === "string" ? parsed.class : null;
  } catch {
    return null;
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * A delivery's problems: a refusal's from its stored answer, an accepted
 * delivery's from what its registration reported.
 */
/** Problems a status entry shows per volume, before the response budget. */
export const STATUS_PROBLEMS_PER_VOLUME = 100;
/** The most bytes a status response may take; past it, each volume shows fewer problems. */
export const STATUS_BUDGET_BYTES = 1_000_000;

/** The columns status reads of a delivery: none of the packed ones. */
export interface StatusRow {
  id: string;
  state: string;
  seq: number;
  referenceCode: string | null;
  pipelineVolumeId: string | null;
  receivedAt: number;
  supersededAt: number | null;
  /** The delivery's openings and rejected records, which `captureLinkState` weighs. */
  openings: number;
  rejectedRecords: number;
}

/**
 * The deliveries a ref's status reports, from its light rows: the one
 * `registered` delivery, which holds the volume (a partial unique index
 * allows one per volume, and each accepted batch supersedes the others),
 * and the latest committed delivery (`seq`, not `received_at`, which is
 * taken before the bucket is listed). With a holder, the latest is
 * reported beside it only when it is a refusal committed after it. With
 * none, the latest is reported as it is.
 */
export function statusRows(
  rows: StatusRow[],
): { reported: StatusRow; refusal: StatusRow | null } | null {
  if (rows.length === 0) return null;
  const latest = rows.reduce((a, b) => (b.seq > a.seq ? b : a));
  const holder = rows.find((r) => r.state === "registered");
  if (!holder) return { reported: latest, refusal: null };
  const refusal = latest.state === "refused" && latest.seq > holder.seq ? latest : null;
  return { reported: holder, refusal };
}

/**
 * One delivery's problems, at most `keep` of them with one entry counting
 * the rest: an accepted delivery's notes, a refusal's from its stored
 * answer. Only that one column is read and unpacked, so status holds one
 * list at a time, never more than `MAX_UNPACKED_PROBLEMS_BYTES`.
 */
export async function readProblems(
  db: DrizzleD1Database<any>,
  tenantId: string,
  row: StatusRow,
  keep: number,
): Promise<CaptureProblem[]> {
  const refused = row.state === "refused";
  const stored = await db
    .select({ text: refused ? captureDeliveries.answerBody : captureDeliveries.problems })
    .from(captureDeliveries)
    .where(and(eq(captureDeliveries.tenantId, tenantId), eq(captureDeliveries.id, row.id)))
    .get();
  if (!stored) return [];
  let list: CaptureProblem[] = [];
  try {
    const parsed = JSON.parse(await unpackJson(stored.text)) as unknown;
    const raw = refused ? (parsed as { problems?: unknown }).problems : parsed;
    list = Array.isArray(raw) ? (raw as CaptureProblem[]) : [];
  } catch {
    list = [];
  }
  return capProblems(list, keep);
}

export interface StatusEntry {
  ref: string;
  volumeId: string | null;
  manifestId: string | null;
  state: string;
  enteredAt: string | null;
  problems: CaptureProblem[];
  /** Present once any opening of the holding delivery is decided. */
  decisionsId?: string;
  decidedAt?: string;
}

/** The light columns status reads of a delivery's decision set. */
interface StatusQcSet {
  decisionsId: string;
  decidedAt: number;
  state: CaptureQcSetState;
  stateEnteredAt: number;
}

/**
 * The latest run that named each of `volumeIds`, volumes of the tenant,
 * with the volume's row in it and its dispatch chunk: what
 * `captureLinkState` reads as `run`. A volume no run has named is absent
 * from the map. Read in chunks under D1's 100 bound parameters.
 */
export async function readLatestRuns(
  db: DrizzleD1Database<any>,
  tenantId: string,
  volumeIds: string[],
  now: number,
): Promise<Map<string, StatusRun>> {
  const runs = new Map<string, StatusRun>();
  for (const part of chunks(volumeIds, READ_CHUNK)) {
    const rows = await db
      .select({
        pipelineVolumeId: pipelineRunVolumes.pipelineVolumeId,
        runId: pipelineRuns.id,
        holds: sql<number>`CASE WHEN ${pipelineRuns.tokenRevokedAt} IS NULL AND ${pipelineRuns.tokenExpiresAt} > ${now} THEN 1 ELSE 0 END`,
        runCreatedAt: pipelineRuns.createdAt,
        dispatchedAt: pipelineRuns.dispatchedAt,
        completedAt: pipelineRuns.completedAt,
        volumeStatus: pipelineRunVolumes.status,
        volumeReportedAt: pipelineRunVolumes.reportedAt,
        volumeError: pipelineRunVolumes.error,
        volumeCreatedAt: pipelineRunVolumes.createdAt,
        chunkStatus: pipelineRunChunks.status,
        chunkDispatchedAt: pipelineRunChunks.dispatchedAt,
      })
      .from(pipelineRunVolumes)
      .innerJoin(
        pipelineRuns,
        and(eq(pipelineRuns.id, pipelineRunVolumes.runId), eq(pipelineRuns.tenantId, tenantId)),
      )
      .leftJoin(
        pipelineRunChunks,
        and(
          eq(pipelineRunChunks.runId, pipelineRunVolumes.runId),
          eq(pipelineRunChunks.chunkIndex, pipelineRunVolumes.chunkIndex),
          eq(pipelineRunChunks.tenantId, tenantId),
        ),
      )
      .where(and(eq(pipelineRunVolumes.tenantId, tenantId), inArray(pipelineRunVolumes.pipelineVolumeId, part)))
      .orderBy(desc(pipelineRunVolumes.createdAt), desc(pipelineRuns.createdAt))
      .all();
    for (const r of rows) {
      if (runs.has(r.pipelineVolumeId)) continue;
      runs.set(r.pipelineVolumeId, {
        runId: r.runId,
        holds: Number(r.holds) === 1,
        createdAt: r.runCreatedAt,
        dispatchedAt: r.dispatchedAt,
        completedAt: r.completedAt,
        volumeStatus: r.volumeStatus,
        volumeReportedAt: r.volumeReportedAt,
        volumeErrorClass: errorClassOf(r.volumeError),
        chunkStatus: r.chunkStatus ?? null,
        chunkDispatchedAt: r.chunkDispatchedAt ?? null,
      });
    }
  }
  return runs;
}

export async function handleVolumeStatus(deps: CaptureLinkDeps, request: Request): Promise<Response> {
  if (request.method !== "GET") return bare(405, { Allow: "GET" });
  const auth = await authenticate(deps, request);
  if (auth instanceof Response) return auth;
  const tenantId = auth.tenant.id;

  const param = new URL(request.url).searchParams.get("refs") ?? "";
  const refs = [...new Set(param.split(",").map((r) => r.trim()).filter((r) => r.length > 0))];
  if (refs.length === 0 || refs.length > MAX_STATUS_REFS) {
    return json(
      400,
      problemsBody([
        {
          rule: "refs",
          message: `refs takes 1 to ${MAX_STATUS_REFS} reference codes, comma-separated; ${refs.length} were given`,
          count: refs.length,
        },
      ]),
    );
  }
  const now = deps.now();

  // The light columns of at most two deliveries per ref: the one that
  // holds the volume, and the latest committed. No packed column is read
  // here, and no history beyond those two.
  const deliveries = new Map<string, StatusRow[]>();
  const volumes = new Map<string, typeof pipelineVolumes.$inferSelect>();
  for (const part of chunks(refs, READ_CHUNK)) {
    const rows = await deps.db
      .select({
        id: captureDeliveries.id,
        state: captureDeliveries.state,
        seq: captureDeliveries.seq,
        referenceCode: captureDeliveries.referenceCode,
        pipelineVolumeId: captureDeliveries.pipelineVolumeId,
        receivedAt: captureDeliveries.receivedAt,
        supersededAt: captureDeliveries.supersededAt,
        openings: captureDeliveries.openings,
        rejectedRecords: captureDeliveries.rejectedRecords,
      })
      .from(captureDeliveries)
      .where(
        and(
          eq(captureDeliveries.tenantId, tenantId),
          inArray(captureDeliveries.referenceCode, part),
          sql`(${captureDeliveries.state} = 'registered' OR ${captureDeliveries.seq} = (SELECT MAX(s.seq) FROM capture_deliveries s WHERE s.tenant_id = ${tenantId} AND s.reference_code = ${captureDeliveries.referenceCode}))`,
        ),
      )
      .all();
    for (const r of rows) {
      const ref = r.referenceCode as string;
      const list = deliveries.get(ref) ?? [];
      list.push(r);
      deliveries.set(ref, list);
    }
    const vols = await deps.db
      .select()
      .from(pipelineVolumes)
      .where(and(eq(pipelineVolumes.tenantId, tenantId), inArray(pipelineVolumes.referenceCode, part)))
      .all();
    for (const v of vols) volumes.set(v.referenceCode, v);
  }

  const runs = await readLatestRuns(
    deps.db,
    tenantId,
    [...volumes.values()].map((v) => v.id),
    now,
  );

  // The decision sets of the deliveries that hold a volume: only
  // the holder's set counts, since decisions belong to the delivery they
  // were made on.
  const qcSets = new Map<string, StatusQcSet>();
  const holderIds = [...deliveries.values()].flatMap((rows) =>
    rows.filter((r) => r.state === "registered").map((r) => r.id),
  );
  for (const part of chunks(holderIds, READ_CHUNK)) {
    const rows = await deps.db
      .select({
        deliveryId: captureQcSets.deliveryId,
        decisionsId: captureQcSets.decisionsId,
        decidedAt: captureQcSets.decidedAt,
        state: captureQcSets.state,
        stateEnteredAt: captureQcSets.stateEnteredAt,
      })
      .from(captureQcSets)
      .where(and(eq(captureQcSets.tenantId, tenantId), inArray(captureQcSets.deliveryId, part)))
      .all();
    for (const r of rows) qcSets.set(r.deliveryId, r);
  }

  // The holding deliveries' latest review runs.
  const reviews = await readLatestReviewRuns(deps.db, tenantId, holderIds, now);

  // Each ref's problems, read one list at a time and capped as read.
  const listed = new Map<string, { chosen: ReturnType<typeof statusRows>; items: CaptureProblem[]; omitted: number }>();
  for (const ref of refs) {
    const chosen = statusRows(deliveries.get(ref) ?? []);
    let items: CaptureProblem[] = [];
    let omitted = 0;
    if (chosen) {
      const own = splitTruncated(await readProblems(deps.db, tenantId, chosen.reported, STATUS_PROBLEMS_PER_VOLUME));
      items = own.items;
      omitted = own.omitted;
      if (chosen.refusal) {
        const later = splitTruncated(await readProblems(deps.db, tenantId, chosen.refusal, STATUS_PROBLEMS_PER_VOLUME));
        const refusalId = chosen.refusal.id;
        items = [...items, ...later.items.map((p) => ({ ...p, manifestId: refusalId }))];
        omitted += later.omitted;
      }
    }
    listed.set(ref, { chosen, items, omitted });
  }

  const entriesFor = (keep: number): StatusEntry[] =>
    refs.map((ref) => {
      const { chosen, items, omitted } = listed.get(ref) as { chosen: ReturnType<typeof statusRows>; items: CaptureProblem[]; omitted: number };
      const d = chosen?.reported ?? null;
      const v = volumes.get(ref) ?? null;
      const delivery: StatusDelivery | null = d && {
        id: d.id,
        state: d.state as CaptureDeliveryState,
        problems: items,
        receivedAt: d.receivedAt,
        supersededAt: d.supersededAt,
        openings: d.openings,
        rejectedRecords: d.rejectedRecords,
      };
      const volume: StatusVolume | null = v && {
        id: v.id,
        state: v.state,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        heldByRunId: v.heldByRunId,
      };
      const set = d && d.state === "registered" ? qcSets.get(d.id) ?? null : null;
      const captureQc: StatusCaptureQc | null = set && { state: set.state, enteredAt: set.stateEnteredAt };
      const review = d && d.state === "registered" ? reviews.get(d.id) ?? null : null;
      const linked = captureLinkState({ delivery, volume, run: v ? runs.get(v.id) ?? null : null, captureQc, review });
      const entry: StatusEntry = {
        ref,
        volumeId: v?.id ?? d?.pipelineVolumeId ?? null,
        manifestId: d?.id ?? null,
        state: linked.state,
        enteredAt: iso(linked.enteredAt),
        problems: capProblems([...linked.problems, ...(omitted > 0 ? [truncationEntry(omitted)] : [])], keep),
      };
      if (set) {
        entry.decisionsId = set.decisionsId;
        entry.decidedAt = iso(set.decidedAt) as string;
      }
      return entry;
    });

  // The whole response within its budget: fewer problems per volume
  // until it fits. Every list still ends by counting what it leaves out.
  let keep = STATUS_PROBLEMS_PER_VOLUME;
  let body = JSON.stringify({ volumes: entriesFor(keep) });
  while (byteLength(body) > STATUS_BUDGET_BYTES && keep > 0) {
    keep = Math.floor(keep / 2);
    body = JSON.stringify({ volumes: entriesFor(keep) });
  }
  return new Response(body, { status: 200, headers: JSON_HEADERS });
}

// @version v0.8.0
