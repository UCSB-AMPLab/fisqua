/**
 * Capture File Route — Deliveries Registered from a Manifest File
 *
 * This module deals with the capture manifests an operator registers
 * from a file with the registration command
 * (`scripts/commands/register-capture-volumes.ts`), the route kept for a
 * Captua unit without a link token. Such a
 * manifest is recorded as a delivery, as one sent over the link is, so
 * its volume goes through capture QC and is held from processing until
 * every opening is approved (`hold.server.ts`). The statements are the
 * link's own (`buildRegistrationStatements` in `link.server.ts`): one
 * path writes the volume, its pages, the delivery and its images, and
 * supersedes the volume's older delivery, carrying over the approvals
 * of the openings whose images did not change (`carry.server.ts`),
 * whichever route the manifest came by, under the same guards.
 *
 * `fileDeliveryId` names a volume's delivery. A file with one volume
 * uses the manifest's id, as the link does. A file may carry several
 * volumes and a delivery holds one, so each volume of such a file gets
 * a UUIDv5 of `FILE_DELIVERY_NAMESPACE` and `<manifest id>/<stem>`, and
 * the same file gives the same ids again.
 *
 * `fileRegistrationSql` builds one volume's statements and renders each
 * as SQL text with its values written in (`renderStatement`), since the
 * command applies them as one file with `wrangler d1 execute --file`.
 * The delivery has route `file` and no scanner. Its answer is the one
 * the link gives an accepted manifest, 200 `{state, manifestId,
 * volumeId}`, with the delivery's id as `manifestId`, the id capture QC
 * decisions name. Its body digest is the file's, so the same document
 * sent over the link later with the same id gets this answer again. Its
 * notes are what the inventory reported without rejecting the volume
 * (`inventoryNotes`); its records and images are the manifest volume's,
 * each image with the sizes the masters listing gave and null for an
 * object the listing lacks, since the command refuses only a missing
 * master. The openings capture QC decides are the records `in_review` or
 * `approved`, so the `captured` records a staging test registers with
 * `--allow-captured` give pages but are not openings.
 *
 * Pages and images go `FILE_ROWS_PER_STATEMENT` to a statement. D1
 * refuses a statement over 100 KB, and a value written into the text
 * counts towards it where a bound one would not, so any statement past
 * `MAX_FILE_STATEMENT_BYTES` refuses the volume with
 * `CaptureBudgetError`, and the command sets it aside. The closing guard
 * recognises the batch's pages by their id prefix, not by a list of
 * ids, so its statements keep one size however many pages the volume
 * has; what can still pass the limit is the delivery row itself, when
 * its packed records and notes do.
 *
 * @version v0.8.0
 */

import { drizzle } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import {
  buildRegistrationStatements,
  CaptureBudgetError,
  imagesOf,
  packJson,
  packProblems,
  packRecords,
  ROW_BUDGET_BYTES,
} from "./link.server";
import {
  inventoryNotes,
  openingCount,
  openingIdsOf,
  rejectedRecordCount,
  type CaptureManifest,
  type PlannedVolume,
} from "./manifest";

/**
 * The namespace of the UUIDv5 ids of a multi-volume file's deliveries.
 * Fixed for good: changing it would give the same file new delivery ids.
 */
export const FILE_DELIVERY_NAMESPACE = "de3fa775-bdc3-43d9-8525-20cec0b7b13b";

/** Pages, or images, per insert of a file delivery. */
export const FILE_ROWS_PER_STATEMENT = 100;

/** The longest statement a file may hold, under D1's 100 KB with room for its overhead. */
export const MAX_FILE_STATEMENT_BYTES = 95_000;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** A UUIDv5 (RFC 9562): SHA-1 of the namespace's bytes and the name's UTF-8. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const hex = namespace.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Not a UUID: ${namespace}`);
  const ns = new Uint8Array(16);
  for (let i = 0; i < 16; i++) ns[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(ns.length + nameBytes.length);
  data.set(ns);
  data.set(nameBytes, ns.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", data)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const out = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/** The delivery id of one volume of a manifest file (module header). */
export function fileDeliveryId(manifest: CaptureManifest, stem: string): Promise<string> {
  if (manifest.volumes.length === 1) return Promise.resolve(manifest.id);
  return uuidV5(FILE_DELIVERY_NAMESPACE, `${manifest.id}/${stem}`);
}

/** A value as an SQLite literal. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} into SQL`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`Cannot write a ${typeof value} into SQL`);
}

/**
 * One built statement as SQL text, each `?` outside a quoted string or
 * identifier replaced by its value as a literal, ending in `;`.
 */
export function renderStatement(item: BatchItem<"sqlite">): string {
  const q = item as unknown as {
    getQuery?: () => { sql: string; params: unknown[] };
    toSQL?: () => { sql: string; params: unknown[] };
  };
  const { sql: text, params } = q.getQuery ? q.getQuery() : (q.toSQL as () => { sql: string; params: unknown[] })();
  let out = "";
  let next = 0;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      if (next >= params.length) throw new Error("A statement has more placeholders than values");
      out += literal(params[next++]);
    } else {
      out += ch;
    }
  }
  if (next !== params.length) throw new Error("A statement has more values than placeholders");
  return `${out.trim()};`;
}

/** Builds statements only; nothing is ever run through this client. */
function builder() {
  return drizzle({ prepare: () => ({}) } as unknown as D1Database);
}

export interface FileRegistrationInput {
  tenantId: string;
  manifest: CaptureManifest;
  /** A planned volume of the manifest, registered or replaced, its inventory taken. */
  volume: PlannedVolume;
  /** The SHA-256 of the file's body in canonical form (`bodyDigest`). */
  digest: string;
  masters: { endpoint: string; bucket: string };
  /** The masters listing under the volume's prefix: full key to size. */
  listing: Map<string, number>;
  now: number;
  newId: () => string;
}

export interface FileRegistration {
  deliveryId: string;
  statements: string[];
}

/** One volume's registration and delivery, as SQL text (module header). */
export async function fileRegistrationSql(input: FileRegistrationInput): Promise<FileRegistration> {
  const { manifest, volume } = input;
  if (volume.action === "skip") throw new Error(`The volume ${volume.stem} is not registered`);
  const v = manifest.volumes.find((m) => m.stem === volume.stem);
  if (!v) throw new Error(`The manifest has no volume ${volume.stem}`);
  const deliveryId = await fileDeliveryId(manifest, volume.stem);

  const records = await packRecords(v);
  const answer = await packJson(
    JSON.stringify({ state: "registered", manifestId: deliveryId, volumeId: volume.volumeId }),
  );
  const notes = await packProblems(
    inventoryNotes(volume),
    ROW_BUDGET_BYTES - byteLength(records) - byteLength(answer),
    (list) => JSON.stringify(list),
  );
  const items = buildRegistrationStatements(builder(), {
    tenantId: input.tenantId,
    route: "file",
    scannerId: null,
    manifestId: deliveryId,
    digest: input.digest,
    volume,
    masters: input.masters,
    notes,
    records,
    openings: openingCount(v),
    rejectedRecords: rejectedRecordCount(v),
    openingIds: openingIdsOf(v),
    images: imagesOf(v, manifest.transfer.root, input.listing),
    answerBody: answer,
    now: input.now,
    newId: input.newId,
    pagesPerStatement: FILE_ROWS_PER_STATEMENT,
    imagesPerStatement: FILE_ROWS_PER_STATEMENT,
  });
  const statements = items.map(renderStatement);
  for (const s of statements) {
    const bytes = byteLength(s);
    if (bytes > MAX_FILE_STATEMENT_BYTES) {
      throw new CaptureBudgetError(
        `A statement for the volume ${volume.stem} takes ${bytes} bytes, past the ${MAX_FILE_STATEMENT_BYTES} a file statement may take`,
      );
    }
  }
  return { deliveryId, statements };
}

// @version v0.8.0
