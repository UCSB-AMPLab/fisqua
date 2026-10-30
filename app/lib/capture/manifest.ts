/**
 * Capture Link — Reading and Planning a Captua Capture Manifest
 *
 * This module deals with the checks every capture manifest goes
 * through before its volumes become media pipeline volumes, whoever
 * delivers it: the operator's registration command
 * (`scripts/commands/register-capture-volumes.ts`), which reads the
 * manifest from a file, and the Worker's delivery endpoint
 * (`POST /api/capture/v1/manifests`), to which a Captua unit sends it
 * itself. Both run these functions, so
 * the two routes cannot drift apart. Everything here is pure: it reads
 * the manifest and rows already read, and touches no database, bucket
 * or network.
 *
 * `checkCaptureManifest` checks the envelope (contract
 * `fisqua-captua-exchange`, a version `1.N` with N of 1 or more, any
 * minor version, since minor versions only add optional fields, kind
 * `capture-manifest`) and the manifest's shape, and refuses
 * the whole manifest on any problem, listing each one with its path: a
 * digest that is not 64 lowercase hex characters, a preview key without
 * its digest or the reverse, a stem or reference code that appears
 * twice. Fields the contract does not name are ignored, as the contract
 * asks.
 *
 * `planVolumes` decides, per volume, from rows already read: a volume
 * with no `externalId` is unmatched; one whose `externalId` is not a
 * description of the tenant is unknown; one with any record still
 * `captured` has not been handed over; one already registered past
 * `received`, held by an open run, registered for an item PDF, or
 * registered under another description or reference code is left
 * alone. Otherwise its pages are planned by `planPages`: the images of
 * every `in_review` or `approved` record, in record `sequence` order,
 * left before right, a single image standing alone, `rejected` records
 * left out. Each page's key is the image's filename stem; its master is
 * the preview where there is one, otherwise the capture of a JPEG-only
 * rig, at
 * `{transfer.root}{key}`, with that file's digest. A page key outside
 * the page-key pattern, a repeated page key or record sequence, a
 * Captua record id shared by two records of any status
 * (`duplicate-record`), a
 * record whose images are not one single or a left and right, a
 * filename not of the form `<stem>-img_<nnnn>_c<n>.<ext>`, or an object
 * key outside `{slug}/{stem}/`, or a RAW capture (`RAW_EXTENSIONS`)
 * with no preview (`preview-missing`), since Fisqua never processes a
 * RAW, a capture at any key but `<stem>/captures/<filename>`
 * (`capture-key`), or a preview at any key but `<stem>/previews/<page key>_preview.jpg`
 * (`preview-key`), which keeps a RAW or any other object from standing
 * as the preview, rejects the volume, as does a volume
 * with no pages. So does an image of any record status whose
 * `rotateDeg` is present, not null, and not one of the
 * numbers 0, 90, 180 or 270 (`rotate-deg`); an image without it, or
 * with it null, is read by its EXIF orientation. A volume that passes is registered, or, when it is
 * already registered and `received`, has its page list replaced, unless
 * a run has ever named it (`ran`): then it is left alone as
 * `not_received`, since a run has started or finished on it.
 * `setAside` sets a planned volume aside afterwards, in the same shape;
 * the registration command uses it for a delivery id already recorded
 * (`already_registered`, `id_reused`) and for a volume whose statements
 * D1 would refuse (`too_large`).
 *
 * `applyInventory` checks the planned volumes against a listing of the
 * masters bucket under each volume's prefix: a master object (the file
 * the pipeline reads for a page) that is missing rejects the volume;
 * objects under the prefix that the manifest does not name, and
 * manifest objects that are not masters and are missing, are reported
 * and change nothing. Sizes are reported; no content is read.
 *
 * `unlistedVolumes` reports the volume folders under the tenant's
 * prefix `{slug}/` that the manifest does not name and no pipeline
 * volume of the tenant is registered under. `folderOf` gives the folder
 * an object key sits in.
 *
 * Every problem is kept twice: as the sentence the command prints and
 * reports (`problems` on a page plan, `detail` on a skipped volume), and
 * as a `CaptureProblem`, `{ rule, message, ...ids }`, which the
 * delivery endpoint answers with. The rule names one check, in the
 * kebab-case of the contract's own rules (`id-reused`, `run-started`,
 * `reference-code`), and the ids name what it found (a record, an
 * object key, a path in the manifest).
 *
 * @version v0.8.0
 */

import { z } from "zod";
import { PIPELINE_PAGE_KEY_PATTERN } from "../validation/enums";

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export const CAPTURE_CONTRACT = "fisqua-captua-exchange";
/** The version the registration command was written for. */
export const CAPTURE_VERSION = "1.1";
/**
 * The versions whose capture manifest this module reads: `1.N` with N of
 * 1 or more, written without leading zeros. Minor versions only add
 * optional fields, which this module reads or ignores, so
 * a consumer refuses only another major version; `1.0`, another major
 * and a malformed string are refused as `version`.
 */
export const CAPTURE_VERSION_PATTERN = /^1\.[1-9][0-9]*$/;
export const CAPTURE_KIND = "capture-manifest";

const SHA256 = /^[0-9a-f]{64}$/;
/** The longest value a manifest's identifying strings may have; S3 keys get 1,024. */
export const MAX_FIELD_CHARS = 256;
const MAX_KEY_CHARS = 1024;
/** Paths and free text the manifest carries (`transfer.root`, names, titles). */
const MAX_TEXT_CHARS = 1024;
export const MANIFEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const image = z
  .object({
    captureId: z.string().min(1).max(MAX_FIELD_CHARS),
    pairId: z.string().max(MAX_FIELD_CHARS).nullable(),
    filename: z.string().min(1).max(MAX_FIELD_CHARS),
    role: z.enum(["left", "right", "single"]),
    objectKey: z.string().min(1).max(MAX_KEY_CHARS),
    sha256: z.string().regex(SHA256),
    previewObjectKey: z.string().min(1).max(MAX_KEY_CHARS).optional(),
    previewSha256: z.string().regex(SHA256).optional(),
    // Checked per volume by `planPages` (`rotate-deg`), so a value outside
    // the four refuses its volume and not the whole manifest. null is
    // read as absent.
    rotateDeg: z.unknown().optional(),
  })
  .superRefine((img, ctx) => {
    if ((img.previewObjectKey === undefined) !== (img.previewSha256 === undefined)) {
      ctx.addIssue({ code: "custom", message: "previewObjectKey and previewSha256 come together" });
    }
  });

// The record, volume and envelope schemas take their lists as arrays of
// anything: each item is checked on its own (`checkCaptureManifest`), so
// no one parse ever meets an unbounded number of invalid items.
const recordShape = z.object({
  captuaRecordId: z.number().int(),
  sequence: z.number().int(),
  status: z.enum(["captured", "in_review", "approved", "rejected"]),
  // Free text of the operator's; not capped here, so a long note never
  // refuses a manifest. The link keeps its first `MAX_NOTE_CHARS`.
  rejectionNote: z.string().nullable(),
  images: z.array(z.unknown()),
});

const volumeShape = z.object({
  externalId: z.string().min(1).max(MAX_FIELD_CHARS).nullable(),
  captuaCollectionId: z.number().int(),
  stem: z.string().min(1).max(MAX_FIELD_CHARS),
  title: z.string().max(MAX_TEXT_CHARS),
  records: z.array(z.unknown()),
});

const envelopeShape = z.object({
  contract: z.literal(CAPTURE_CONTRACT),
  version: z.string().max(MAX_FIELD_CHARS).regex(CAPTURE_VERSION_PATTERN),
  kind: z.literal(CAPTURE_KIND),
  id: z.string().regex(MANIFEST_ID_PATTERN),
  generatedAt: z.string().max(MAX_FIELD_CHARS),
  generatedBy: z.object({
    system: z.string().max(MAX_FIELD_CHARS),
    instance: z.string().max(MAX_FIELD_CHARS),
    systemVersion: z.string().max(MAX_FIELD_CHARS),
  }),
  inReplyTo: z.string().max(MAX_FIELD_CHARS).nullable(),
  project: z.object({ captuaProjectId: z.number().int(), name: z.string().max(MAX_TEXT_CHARS) }),
  transfer: z.object({ channel: z.enum(["upload", "disk"]), root: z.string().min(1).max(MAX_TEXT_CHARS) }),
  volumes: z.array(z.unknown()),
});

export type CaptureImage = z.infer<typeof image>;

/**
 * The rotations an image may carry as `rotateDeg`:
 * clockwise degrees from its stored pixels, EXIF Orientation ignored.
 */
export const ROTATE_DEGREES = [0, 90, 180, 270] as const;
export type RotateDeg = (typeof ROTATE_DEGREES)[number];

/** Whether a value is one of `ROTATE_DEGREES`, as a JSON number. */
export function isRotateDeg(value: unknown): value is RotateDeg {
  return typeof value === "number" && (ROTATE_DEGREES as readonly number[]).includes(value);
}
export type CaptureRecord = Omit<z.infer<typeof recordShape>, "images"> & { images: CaptureImage[] };
export type CaptureVolume = Omit<z.infer<typeof volumeShape>, "records"> & { records: CaptureRecord[] };

/**
 * The record statuses that make an opening, the unit capture QC decides:
 * the records handed over for review or approved on the unit.
 */
export const OPENING_STATUSES: ReadonlySet<string> = new Set(["in_review", "approved"]);

/** Whether a record of that status is an opening. */
export function isOpening(status: string): boolean {
  return OPENING_STATUSES.has(status);
}

/** How many openings a manifest volume has. */
export function openingCount(v: Pick<CaptureVolume, "records">): number {
  return v.records.filter((r) => isOpening(r.status)).length;
}

/** The Captua record ids of a manifest volume's openings. */
export function openingIdsOf(v: Pick<CaptureVolume, "records">): number[] {
  return v.records.filter((r) => isOpening(r.status)).map((r) => r.captuaRecordId);
}

/**
 * How many records of a manifest volume are `rejected`: openings with a
 * retake outstanding on the unit, which `planPages` leaves out and which
 * hold the volume from processing (`hold.server.ts`).
 */
export function rejectedRecordCount(v: Pick<CaptureVolume, "records">): number {
  return v.records.filter((r) => r.status === "rejected").length;
}
export type CaptureManifest = Omit<z.infer<typeof envelopeShape>, "volumes"> & { volumes: CaptureVolume[] };

/** One problem: the check that found it, a sentence, and what it names. */
export interface CaptureProblem {
  rule: string;
  message: string;
  [id: string]: unknown;
}

export type ManifestCheck =
  | { ok: true; manifest: CaptureManifest }
  | { ok: false; problems: CaptureProblem[] };

/** The rule an envelope or shape issue falls under. */
function ruleOf(path: string): string {
  if (path === "contract" || path === "kind") return "envelope";
  if (path === "version") return "version";
  return "shape";
}

/** The shape problems a manifest's check keeps; the rest are counted. */
export const MAX_SHAPE_PROBLEMS = 100;

/**
 * The problems of one check, at most `MAX_SHAPE_PROBLEMS` kept, every
 * further one counted.
 */
class ProblemCollector {
  readonly problems: CaptureProblem[] = [];
  omitted = 0;

  issues(issues: z.core.$ZodIssue[], prefix: Array<string | number>): void {
    for (const i of issues) {
      if (this.problems.length >= MAX_SHAPE_PROBLEMS) {
        this.omitted++;
        continue;
      }
      const path = [...prefix, ...i.path].map(String).join(".") || "(root)";
      const tooLong = i.code === "too_big" && (i as { origin?: string }).origin === "string";
      this.problems.push({ rule: tooLong ? "field-too-long" : ruleOf(path), message: `${path}: ${i.message}`, path });
    }
  }

  custom(path: Array<string | number>, message: string): void {
    if (this.problems.length >= MAX_SHAPE_PROBLEMS) {
      this.omitted++;
      return;
    }
    const p = path.map(String).join(".");
    this.problems.push({ rule: "shape", message: `${p}: ${message}`, path: p });
  }

  get count(): number {
    return this.problems.length + this.omitted;
  }

  result(): CaptureProblem[] {
    if (this.omitted === 0) return this.problems;
    return [
      ...this.problems,
      {
        rule: "problems-truncated",
        message: `${this.omitted} more problem${this.omitted === 1 ? " is" : "s are"} not listed`,
        omitted: this.omitted,
      },
    ];
  }
}

export interface CheckOptions {
  /**
   * The most volumes the manifest may name: 1 on the direct link, where
   * the answer names one volume (`volume-count`); none on the file
   * route, which can carry several.
   */
  maxVolumes?: number;
}

/**
 * The manifest, or every reason it is refused whole, each with its path.
 * A string past its cap is rule `field-too-long`; the delivery endpoint
 * answers a manifest whose only problems are those (or `volume-count`)
 * with 422, and any other shape problem with 400.
 *
 * The check is made a piece at a time, so its cost is bounded by the
 * body and never by how many of its items are invalid: with
 * `maxVolumes`, the volume count first, before anything else; then the
 * envelope, with its volumes as an array of anything; then each volume,
 * each record of a volume, and each image of a record, each with its own
 * schema. At most `MAX_SHAPE_PROBLEMS` problems are kept; every further
 * one is counted, and the list ends with `problems-truncated`. Paths,
 * rules and messages are those a whole-manifest parse gives.
 */
export function checkCaptureManifest(raw: unknown, options: CheckOptions = {}): ManifestCheck {
  if (options.maxVolumes !== undefined && raw !== null && typeof raw === "object") {
    const volumes = (raw as Record<string, unknown>).volumes;
    if (Array.isArray(volumes) && volumes.length > options.maxVolumes) {
      return {
        ok: false,
        problems: [
          {
            rule: "volume-count",
            message: `A manifest delivered over the link names one volume; this one names ${volumes.length}`,
            count: volumes.length,
          },
        ],
      };
    }
  }

  const found = new ProblemCollector();
  const envelope = envelopeShape.safeParse(raw);
  if (!envelope.success) found.issues(envelope.error.issues, []);
  const rawVolumes = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).volumes : undefined;
  const volumes: CaptureVolume[] = [];
  if (Array.isArray(rawVolumes)) {
    rawVolumes.forEach((rv, vi) => {
      const v = volumeShape.safeParse(rv);
      if (!v.success) found.issues(v.error.issues, ["volumes", vi]);
      const rawRecords = rv !== null && typeof rv === "object" ? (rv as Record<string, unknown>).records : undefined;
      const records: CaptureRecord[] = [];
      if (Array.isArray(rawRecords)) {
        rawRecords.forEach((rr, ri) => {
          const r = recordShape.safeParse(rr);
          if (!r.success) found.issues(r.error.issues, ["volumes", vi, "records", ri]);
          const rawImages = rr !== null && typeof rr === "object" ? (rr as Record<string, unknown>).images : undefined;
          const images: CaptureImage[] = [];
          if (Array.isArray(rawImages)) {
            rawImages.forEach((ri2, ii) => {
              const img = image.safeParse(ri2);
              if (!img.success) found.issues(img.error.issues, ["volumes", vi, "records", ri, "images", ii]);
              else if (found.count === 0) images.push(img.data);
            });
          }
          if (r.success && found.count === 0) records.push({ ...r.data, images });
        });
      }
      if (v.success && found.count === 0) volumes.push({ ...v.data, records });
    });
  }

  // Repeated stems and reference codes, once every piece is sound.
  if (envelope.success && found.count === 0) {
    const stems = new Set<string>();
    const codes = new Set<string>();
    volumes.forEach((v, i) => {
      if (stems.has(v.stem)) found.custom(["volumes", i, "stem"], `stem ${v.stem} appears twice`);
      stems.add(v.stem);
      if (v.externalId !== null) {
        if (codes.has(v.externalId)) found.custom(["volumes", i, "externalId"], `externalId ${v.externalId} appears twice`);
        codes.add(v.externalId);
      }
    });
  }

  if (!envelope.success || found.count > 0) return { ok: false, problems: found.result() };
  return { ok: true, manifest: { ...envelope.data, volumes } };
}

/** Whether the manifest's transfer root is the tenant's slug prefix. */
export function transferRootProblem(manifest: CaptureManifest, slug: string): CaptureProblem | null {
  if (manifest.transfer.root === `${slug}/`) return null;
  return {
    rule: "transfer-root",
    message: `The manifest's transfer root ${manifest.transfer.root} is not the tenant's prefix ${slug}/`,
    root: manifest.transfer.root,
  };
}

/** Where a volume's masters sit in the federation's masters bucket. */
export function mastersPrefixFor(slug: string, stem: string): string {
  return `${slug}/${stem}/`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface PlannedPage {
  seq: number;
  pageKey: string;
  masterKey: string;
  sha256: string;
}

/** Every key of a volume's manifest, with whether the pipeline reads it. */
export interface ManifestObject {
  key: string;
  master: boolean;
}

export interface PagePlan {
  pages: PlannedPage[];
  /** Reasons the volume is rejected; empty when it passes. */
  problems: string[];
  /** The same reasons, each with its rule and ids. */
  issues: CaptureProblem[];
  /** Every object key the manifest names for the volume, any record status. */
  objects: ManifestObject[];
}

const ROLE_ORDER = { left: 0, right: 1, single: 2 } as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Camera RAW file extensions. A capture with one of these is a
 * preservation master that Fisqua never processes, so its page needs the
 * preview extracted from it.
 */
export const RAW_EXTENSIONS = [
  "3fr", "arw", "cr2", "cr3", "crw", "dcr", "dng", "erf", "iiq", "kdc", "mef", "mos", "mrw",
  "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
] as const;

/** Where the exchange contract puts a capture, relative to the transfer root. */
export function captureKeyFor(stem: string, filename: string): string {
  return `${stem}/captures/${filename}`;
}

/**
 * Where the exchange contract puts the preview of a capture, relative to
 * the transfer root.
 */
export function previewKeyFor(stem: string, pageKey: string): string {
  return `${stem}/previews/${pageKey}_preview.jpg`;
}

export function isRawCapture(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return (RAW_EXTENSIONS as readonly string[]).includes(ext);
}

function rolesValid(images: CaptureImage[]): boolean {
  const roles = images.map((i) => i.role).sort().join(",");
  return roles === "single" || roles === "left" || roles === "right" || roles === "left,right";
}

/**
 * The pages of one volume, in canvas order, and the reasons, if any,
 * the volume is rejected. Reads the manifest only.
 */
export function planPages(v: CaptureVolume, slug: string, root: string, allowCaptured = false): PagePlan {
  const issues: CaptureProblem[] = [];
  const problem = (rule: string, message: string, ids: Record<string, unknown> = {}) =>
    issues.push({ rule, message, stem: v.stem, ...ids });
  const prefix = mastersPrefixFor(slug, v.stem);
  const fileForm = new RegExp(`^${escapeRegExp(v.stem)}-img_\\d{4,}_c\\d+\\.[A-Za-z0-9]+$`);
  const under = (key: string) => key.startsWith(prefix) && key.length > prefix.length;

  const objects: ManifestObject[] = [];
  for (const r of v.records) {
    for (const img of r.images) {
      objects.push({ key: `${root}${img.objectKey}`, master: false });
      if (img.previewObjectKey !== undefined) objects.push({ key: `${root}${img.previewObjectKey}`, master: false });
    }
  }

  if (!PIPELINE_PAGE_KEY_PATTERN.test(v.stem)) problem("stem", `stem ${v.stem} is outside the page-key pattern`);

  // Every image's rotation, any record status: each image becomes a
  // `capture_images` row, whose CHECK takes the four values only.
  for (const r of v.records) {
    for (const img of r.images) {
      if (img.rotateDeg === undefined || img.rotateDeg === null || isRotateDeg(img.rotateDeg)) continue;
      const shown = JSON.stringify(img.rotateDeg) ?? String(img.rotateDeg);
      problem(
        "rotate-deg",
        `the image ${img.filename} has rotateDeg ${shown.length > 32 ? `${shown.slice(0, 32)}…` : shown}, not 0, 90, 180 or 270`,
        { captuaRecordId: r.captuaRecordId, captureId: img.captureId, role: img.role },
      );
    }
  }

  // A Captua record id names one record of the volume, whatever its
  // status: capture QC decides by it, and an id shared by two records
  // would let a decision on one stand for the other.
  const recordIds = new Set<number>();
  const repeated = new Set<number>();
  for (const r of v.records) {
    if (recordIds.has(r.captuaRecordId)) repeated.add(r.captuaRecordId);
    recordIds.add(r.captuaRecordId);
  }
  for (const id of repeated) {
    problem("duplicate-record", `Captua record id ${id} appears on more than one record`, { captuaRecordId: id });
  }

  const kept = v.records
    .filter((r) => r.status === "in_review" || r.status === "approved" || (allowCaptured && r.status === "captured"))
    .sort((a, b) => a.sequence - b.sequence);
  const sequences = new Set<number>();
  for (const r of kept) {
    if (sequences.has(r.sequence)) {
      problem("sequence", `record sequence ${r.sequence} appears twice`, { captuaRecordId: r.captuaRecordId });
    }
    sequences.add(r.sequence);
  }

  const pages: PlannedPage[] = [];
  const keys = new Set<string>();
  for (const r of kept) {
    if (!rolesValid(r.images)) {
      problem(
        "roles",
        `record ${r.captuaRecordId} has images ${r.images.map((i) => i.role).join(", ") || "none"}, not one single or a left and right`,
        { captuaRecordId: r.captuaRecordId },
      );
      continue;
    }
    const ordered = [...r.images].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
    for (const img of ordered) {
      const ids = { captuaRecordId: r.captuaRecordId, captureId: img.captureId };
      if (!fileForm.test(img.filename)) {
        problem("filename", `filename ${img.filename} is not of the form ${v.stem}-img_<nnnn>_c<n>.<ext>`, {
          ...ids,
          filename: img.filename,
        });
        continue;
      }
      const pageKey = img.filename.replace(/\.[^.]+$/, "");
      if (!PIPELINE_PAGE_KEY_PATTERN.test(pageKey)) {
        problem("page-key", `page key ${pageKey} is outside the page-key pattern`, { ...ids, pageKey });
        continue;
      }
      if (keys.has(pageKey)) {
        problem("page-key", `page key ${pageKey} appears twice`, { ...ids, pageKey });
        continue;
      }
      keys.add(pageKey);
      // The capture sits at the key the contract names for it, under its own
      // filename, so the file the filename describes is the file read.
      const expectedCapture = captureKeyFor(v.stem, img.filename);
      if (img.objectKey !== expectedCapture) {
        problem("capture-key", `the capture ${img.filename} is at ${img.objectKey}, not ${expectedCapture}`, {
          ...ids,
          objectKey: img.objectKey,
          role: img.role,
        });
        continue;
      }
      // A preview is the JPEG extracted from its capture, at the key
      // the contract names for it:
      // `<stem>/previews/<capture stem>_preview.jpg`. Any other key (the
      // capture's own, a RAW, another image's) could make something
      // other than that JPEG the page's master.
      if (img.previewObjectKey !== undefined) {
        const expected = previewKeyFor(v.stem, pageKey);
        if (img.previewObjectKey !== expected) {
          problem("preview-key", `the preview of ${img.filename} is ${img.previewObjectKey}, not ${expected}`, {
            ...ids,
            objectKey: img.previewObjectKey,
            role: img.role,
          });
          continue;
        }
      }
      const captureKey = `${root}${img.objectKey}`;
      const previewKey = img.previewObjectKey === undefined ? null : `${root}${img.previewObjectKey}`;
      const outside = [captureKey, previewKey].filter((k): k is string => k !== null && !under(k));
      if (outside.length > 0) {
        problem("object-key", `${outside.join(" and ")} ${outside.length > 1 ? "lie" : "lies"} outside ${prefix}`, {
          ...ids,
          objectKeys: outside,
        });
        continue;
      }
      // The pipeline reads the preview, or the capture of a JPEG-only rig;
      // a RAW is a preservation master and is never its input.
      if (previewKey === null && (isRawCapture(img.filename) || isRawCapture(img.objectKey))) {
        problem("preview-missing", `${img.filename} is a RAW capture with no preview`, {
          ...ids,
          objectKey: img.objectKey,
          role: img.role,
        });
        continue;
      }
      const masterKey = previewKey !== null ? previewKey : captureKey;
      const sha256 = previewKey !== null ? (img.previewSha256 as string) : img.sha256;
      pages.push({ seq: pages.length + 1, pageKey, masterKey, sha256 });
    }
  }
  const masters = new Set(pages.map((p) => p.masterKey));
  for (const o of objects) o.master = masters.has(o.key);
  if (issues.length === 0 && pages.length === 0) problem("no-pages", "no in_review or approved record has an image");
  return { pages, problems: issues.map((i) => i.message), issues, objects };
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

export interface DescriptionMatch {
  id: string;
  referenceCode: string;
}

export interface ExistingVolume {
  id: string;
  descriptionId: string;
  referenceCode: string;
  kind: string;
  state: string;
  /** Whether an open run (token neither revoked nor expired) holds it. */
  held: boolean;
  /** Whether any run, open or closed, has named it. */
  ran?: boolean;
}

export type SkipReason =
  | "unmatched"
  | "unknown_description"
  | "not_handed_over"
  | "not_received"
  | "held_by_run"
  | "not_volume_run"
  | "registered_otherwise"
  | "rejected"
  | "missing_objects"
  | "already_registered"
  | "id_reused"
  | "too_large";

export interface VolumeInventory {
  /** Master objects and their sizes. */
  masterBytes: number;
  /** Master keys the listing does not hold. */
  missingMasters: string[];
  /** Manifest objects the pipeline does not read that the listing does not hold. */
  missingOthers: string[];
  /** Objects under the prefix that the manifest does not name. */
  unlisted: { key: string; size: number }[];
}

export interface PlannedVolume {
  stem: string;
  externalId: string | null;
  captuaCollectionId: number;
  action: "register" | "replace" | "skip";
  reason?: SkipReason;
  detail?: string[];
  /** Why the volume is skipped, each with its rule and ids; set for skip. */
  issues?: CaptureProblem[];
  /** Set for register and replace. */
  volumeId?: string;
  descriptionId?: string;
  referenceCode?: string;
  mastersPrefix?: string;
  pages?: PlannedPage[];
  objects?: ManifestObject[];
  /** Null until the masters bucket is listed. */
  inventory?: VolumeInventory | null;
}

export interface PlanInput {
  manifest: CaptureManifest;
  slug: string;
  /** Descriptions of the tenant, by reference code. */
  descriptions: Map<string, DescriptionMatch>;
  /** The tenant's pipeline volumes for those descriptions or reference codes. */
  existing: ExistingVolume[];
  newId: () => string;
  /**
   * Treat `captured` records as handed over. For a staging test only:
   * the command refuses it against production, and the delivery
   * endpoint never sets it.
   */
  allowCaptured?: boolean;
}

/** The rule each skip reason is answered with. */
export const SKIP_RULES: Record<SkipReason, string> = {
  unmatched: "reference-code",
  unknown_description: "description",
  not_handed_over: "not-handed-over",
  not_received: "run-started",
  held_by_run: "run-started",
  not_volume_run: "not-volume-run",
  registered_otherwise: "registered-otherwise",
  rejected: "pages",
  missing_objects: "missing-object",
  already_registered: "already-registered",
  id_reused: "id-reused",
  too_large: "too-large",
};

const SKIP_MESSAGES: Record<SkipReason, string> = {
  unmatched: "The volume has no reference code",
  unknown_description: "The volume's reference code is not a description of the tenant",
  not_handed_over: "The volume has records still captured",
  not_received: "A pipeline run has already started on the volume",
  held_by_run: "A pipeline run holds the volume",
  not_volume_run: "The volume is registered for an item PDF",
  registered_otherwise: "The volume is registered under another description or reference code",
  rejected: "The volume's pages fail a check",
  missing_objects: "A master object is not in the masters bucket",
  already_registered: "The manifest is already recorded as the volume's delivery; nothing is written again",
  id_reused: "The delivery id is already recorded with a different manifest body",
  too_large: "A statement for the volume is larger than D1 takes",
};

function skip(
  v: CaptureVolume,
  reason: SkipReason,
  detail: string[] = [],
  issues?: CaptureProblem[],
): PlannedVolume {
  const ids = { stem: v.stem, ...(v.externalId !== null ? { referenceCode: v.externalId } : {}) };
  return {
    stem: v.stem,
    externalId: v.externalId,
    captuaCollectionId: v.captuaCollectionId,
    action: "skip",
    reason,
    detail,
    issues: issues ?? [
      {
        rule: SKIP_RULES[reason],
        message: detail.length > 0 ? `${SKIP_MESSAGES[reason]}: ${detail.join("; ")}` : SKIP_MESSAGES[reason],
        ...ids,
      },
    ],
  };
}

/**
 * A planned volume set aside after planning, with its reason and
 * detail, in the shape `planVolumes` gives a volume it skips. The
 * registration command sets aside a volume whose delivery id is
 * already recorded.
 */
export function setAside(v: PlannedVolume, reason: SkipReason, detail: string[] = []): PlannedVolume {
  return {
    stem: v.stem,
    externalId: v.externalId,
    captuaCollectionId: v.captuaCollectionId,
    action: "skip",
    reason,
    detail,
    issues: [
      {
        rule: SKIP_RULES[reason],
        message: detail.length > 0 ? `${SKIP_MESSAGES[reason]}: ${detail.join("; ")}` : SKIP_MESSAGES[reason],
        stem: v.stem,
        ...(v.externalId !== null ? { referenceCode: v.externalId } : {}),
      },
    ],
    ...(v.inventory !== undefined ? { inventory: v.inventory } : {}),
  };
}

/** Decides each volume from the manifest and rows already read (module header). */
export function planVolumes(input: PlanInput): PlannedVolume[] {
  const { manifest, slug } = input;
  return manifest.volumes.map((v) => {
    if (v.externalId === null) return skip(v, "unmatched");
    const description = input.descriptions.get(v.externalId);
    if (!description) return skip(v, "unknown_description");
    const captured = v.records.filter((r) => r.status === "captured");
    if (captured.length > 0 && !input.allowCaptured) {
      return skip(
        v,
        "not_handed_over",
        captured.map((r) => `record ${r.captuaRecordId} is captured`),
        captured.map((r) => ({
          rule: SKIP_RULES.not_handed_over,
          message: `record ${r.captuaRecordId} is captured`,
          stem: v.stem,
          captuaRecordId: r.captuaRecordId,
        })),
      );
    }

    const existing = input.existing.filter(
      (e) => e.descriptionId === description.id || e.referenceCode === description.referenceCode,
    );
    const current = existing.length === 1 ? existing[0] : null;
    if (existing.length > 1 || (current && (current.descriptionId !== description.id || current.referenceCode !== description.referenceCode))) {
      return skip(
        v,
        "registered_otherwise",
        existing.map((e) => `pipeline volume ${e.id} (${e.referenceCode}, description ${e.descriptionId})`),
      );
    }
    if (current && current.state !== "received") return skip(v, "not_received", [`state ${current.state}`]);
    if (current && current.kind !== "volume_run") return skip(v, "not_volume_run", [`kind ${current.kind}`]);
    if (current && current.held) return skip(v, "held_by_run");

    const plan = planPages(v, slug, manifest.transfer.root, input.allowCaptured ?? false);
    if (plan.problems.length > 0) return skip(v, "rejected", plan.problems, plan.issues);
    // Once a run has started or finished on the volume, a newer manifest
    // does not replace its pages; an admin decides.
    if (current && current.ran) return skip(v, "not_received", ["a run has named it"]);

    return {
      stem: v.stem,
      externalId: v.externalId,
      captuaCollectionId: v.captuaCollectionId,
      action: current ? "replace" : "register",
      volumeId: current ? current.id : input.newId(),
      descriptionId: description.id,
      referenceCode: description.referenceCode,
      mastersPrefix: mastersPrefixFor(slug, v.stem),
      pages: plan.pages,
      objects: plan.objects,
      inventory: null,
    };
  });
}

/**
 * Checks each planned volume against the listing of its prefix, keyed by
 * prefix: object key to size. A missing master rejects the volume.
 */
export function applyInventory(
  volumes: PlannedVolume[],
  listings: Map<string, Map<string, number>>,
): PlannedVolume[] {
  return volumes.map((v) => {
    if (v.action === "skip") return v;
    const listed = listings.get(v.mastersPrefix as string) ?? new Map<string, number>();
    const objects = v.objects ?? [];
    const named = new Set(objects.map((o) => o.key));
    const missingMasters = (v.pages ?? []).map((p) => p.masterKey).filter((k) => !listed.has(k));
    const missingOthers = objects.filter((o) => !o.master && !listed.has(o.key)).map((o) => o.key);
    const unlisted = [...listed.entries()]
      .filter(([key]) => !named.has(key))
      .map(([key, size]) => ({ key, size }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const masterBytes = (v.pages ?? []).reduce((sum, p) => sum + (listed.get(p.masterKey) ?? 0), 0);
    const inventory: VolumeInventory = { masterBytes, missingMasters, missingOthers, unlisted };
    if (missingMasters.length > 0) {
      return {
        stem: v.stem,
        externalId: v.externalId,
        captuaCollectionId: v.captuaCollectionId,
        action: "skip",
        reason: "missing_objects",
        detail: missingMasters.map((k) => `${k} is not in the masters bucket`),
        issues: missingMasters.map((k) => ({
          rule: SKIP_RULES.missing_objects,
          message: `${k} is not in the masters bucket`,
          stem: v.stem,
          objectKey: k,
        })),
        inventory,
      };
    }
    return { ...v, inventory };
  });
}

/**
 * What the inventory reported without rejecting the volume: objects
 * under its prefix the manifest does not name, and named objects the
 * pipeline does not read that are not in the bucket.
 */
export function inventoryNotes(v: PlannedVolume): CaptureProblem[] {
  const inv = v.inventory;
  if (!inv) return [];
  return [
    ...inv.unlisted.map((o) => ({
      rule: "unlisted-object",
      message: `${o.key} is in the masters bucket and not in the manifest`,
      stem: v.stem,
      objectKey: o.key,
      size: o.size,
    })),
    ...inv.missingOthers.map((k) => ({
      rule: "missing-object",
      message: `${k} is in the manifest and not in the masters bucket`,
      stem: v.stem,
      objectKey: k,
    })),
  ];
}

/**
 * Folders under the tenant's prefix that hold no volume: Captua's
 * catalogue backups (`{slug}/db-backups/`), which sit beside the volume
 * folders because the appliance key writes only under the tenant prefix.
 */
export const NON_VOLUME_FOLDERS = ["db-backups/"];

/**
 * The volume folders under the tenant's prefix that are neither named by
 * the manifest nor registered, sorted. `registered` holds each pipeline
 * volume's `masters_prefix`, and for an item PDF the folder of its
 * `masters_key`. `NON_VOLUME_FOLDERS` are never reported.
 */
export function unlistedVolumes(
  folders: string[],
  slug: string,
  manifestStems: string[],
  registered: string[],
): string[] {
  const known = new Set([
    ...manifestStems.map((stem) => mastersPrefixFor(slug, stem)),
    ...registered,
    ...NON_VOLUME_FOLDERS.map((f) => `${slug}/${f}`),
  ]);
  return [...new Set(folders)].filter((f) => f.startsWith(`${slug}/`) && !known.has(f)).sort();
}

/** The folder `{slug}/<stem>/` an object key sits in, or null outside one. */
export function folderOf(key: string, slug: string): string | null {
  if (!key.startsWith(`${slug}/`)) return null;
  const rest = key.slice(slug.length + 1);
  const cut = rest.indexOf("/");
  return cut > 0 ? `${slug}/${rest.slice(0, cut + 1)}` : null;
}

// @version v0.8.0
