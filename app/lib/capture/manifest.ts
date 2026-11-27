/**
 * Capture Link — Reading and Planning a Captua Capture Manifest
 *
 * This module deals with the checks every capture manifest goes
 * through before its volumes become media pipeline volumes, whoever
 * delivers it: the operator's registration verb, `fisqua capture
 * register` (`scripts/lib/capture-cli/register.ts`), which reads the
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
 * left out, and `excluded` records left out too. A record the unit gives
 * as `excluded` (contract 1.6) is not a page: a test shot or a
 * duplicate, as an opening capture QC excluded is. It is not an
 * opening, so it is never decided, and, unlike a `rejected` record, it
 * asks for no retake and holds nothing; it does not refuse the volume.
 *
 * From version 1.9 (contract §10) a record may be a placeholder: status
 * `missing`, with `missingSide` and, once the operator closes it,
 * `closedReason` and an optional `closedNote`; any record may carry a
 * `requestId`. At versions 1.1 to 1.8 status `missing` is refused and the
 * other fields are ignored. `qcStatusOf` gives the status a record is
 * read as: an open placeholder as `rejected` (it holds the volume as a
 * record rejected on the unit does, and is no page), a closed one with
 * no image as `excluded`, a closed one with an image as `in_review` (an
 * opening, its image a page). `planPages` refuses a placeholder whose
 * images contradict its side (`missing-side`), and, at every version,
 * two records of any status sharing a `sequence` (`sequence`). A volume
 * with no page is refused as `no-pages` unless it has an open
 * placeholder, with a message of its own when every record is a
 * placeholder closed with no image (`NO_PAGES_CLOSED_ONLY`). One with
 * an open placeholder and no page is taken only as a replacement
 * (`planVolumes`): it supersedes the delivery that held the volume and
 * holds it in turn, and the volume keeps its pages; as a first delivery
 * it is refused as `no-pages` (`NO_PAGES_FIRST_OPEN`), since a pipeline
 * volume holds at least one page. `reorderNotes` notes a volume
 * whose records the registered delivery holds in another relative order
 * (`sequence-reordered`), which refuses nothing.
 *
 * From version 1.12 (contract §13) a volume may carry calibration
 * shots, photographs of a colour reference card, as `calibration`
 * beside its records, and say whether it has them as `calibrationStatus`
 * (`present` or `skipped`, the latter with an optional
 * `skippedReason`). At versions 1.1 to 1.11 both are ignored. A shot is
 * never a page: it is no record, opening or pair member, takes no place
 * in the page sequence and is never decided, so nothing that reads the
 * records reads it. Its fields are checked with the shape (an ISO 8601
 * `capturedAt`, an object of `settings` no larger than
 * `MAX_SETTINGS_BYTES` as JSON, or `field-too-long`), and, per volume,
 * `calibrationProblems` refuses a shot whose `appliesFromCaptureId`
 * names no capture of the volume's record images
 * (`calibration-applies-from`), whose keys are not those the contract
 * fixes under `<stem>/calibration/` (`calibration-key`), whose capture
 * id or keys are also a page image's or another shot's
 * (`calibration-identity`), or whose `rotateDeg` is not one of the
 * four (`rotate-deg`). Its objects join the volume's `objects`, marked
 * `calibration`, so the listing does not report them as unlisted, and
 * its plan (`PlannedShot`) goes with the planned volume.
 *
 * Each page's key is the image's filename stem; its master is
 * the preview where there is one, otherwise the capture of a JPEG-only
 * rig, at
 * `{transfer.root}{key}`, with that file's digest. A page key outside
 * the page-key pattern, a repeated page key or record sequence, a
 * Captua record id shared by two records of any status
 * (`duplicate-record`), a
 * record whose images are not one single or a left and right, a
 * filename holding a control character (U+0000-U+001F or U+007F,
 * `hasControlCharacter`, as a calibration shot's is held to), refused as
 * `filename` before any other rule quotes the name, its rotation's
 * included, a
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
 * with it null, is read by its EXIF orientation. Every text value of
 * the delivery that a refusal or note names, whatever its field, goes
 * through `quotedName`, which writes every control character as
 * `\uXXXX`, so no message carries one; a rotation of any type is shown
 * as its JSON through it (`shownValue`). Numbers the shape check has
 * read as integers (record ids, sequences) are written as they are. The
 * run spec holds its master keys and an item PDF's source key to the
 * control-character check; the media-pipeline runner applies its own check to calibration
 * keys only. A volume that passes is registered, or, when it is
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
 * and change nothing. A calibration shot's object that is missing
 * rejects the volume as `calibration-object`
 * (`missingCalibrationObjects`), which the delivery endpoint also runs
 * beside its own `object-missing` check. Sizes are reported; no content
 * is read, so a digest is checked for its form here and against the
 * object's content only where the object is read.
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
 * @version v0.9.0
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

/**
 * The statuses a record of a capture manifest may have: `captured`
 * (not yet handed over), `in_review` and `approved` (openings),
 * `rejected` (a retake outstanding on the unit) and `excluded` (not a
 * page).
 */
export const CAPTURE_RECORD_STATUSES = ["captured", "in_review", "approved", "rejected", "excluded"] as const;

/**
 * The first minor version whose records may be placeholders (contract
 * §10.1): status `missing`, with `missingSide`, and, once closed,
 * `closedReason` and an optional `closedNote`; and whose records of any
 * status may carry the `requestId` of the Fisqua request they answer.
 */
export const MISSING_RECORDS_MINOR = 9;
/** The statuses a record may have from `MISSING_RECORDS_MINOR` on. */
export const CAPTURE_RECORD_STATUSES_1_9 = [...CAPTURE_RECORD_STATUSES, "missing"] as const;
/** The side of an opening a `missing` record lacks; `both` has no image. */
export const MISSING_SIDES = ["left", "right", "both"] as const;
/** Why the operator closed a `missing` record without capturing it. */
export const CLOSED_REASONS = ["foliation_skip", "leaf_missing_from_volume", "captured_elsewhere", "other"] as const;

// The record, volume and envelope schemas take their lists as arrays of
// anything: each item is checked on its own (`checkCaptureManifest`), so
// no one parse ever meets an unbounded number of invalid items.
const recordFields = {
  captuaRecordId: z.number().int(),
  sequence: z.number().int(),
  // Free text of the operator's; not capped here, so a long note never
  // refuses a manifest. The link keeps its first `MAX_NOTE_CHARS`.
  rejectionNote: z.string().nullable(),
  images: z.array(z.unknown()),
};

/**
 * A record at versions 1.1 to 1.8. Placeholder fields are not read
 * there, as no field the contract does not name is.
 */
const recordShape = z.object({ ...recordFields, status: z.enum(CAPTURE_RECORD_STATUSES) });

/**
 * A record from 1.9 on. Each placeholder field is optional, and null is
 * read as absent. `missingSide` comes with status `missing` and only
 * with it; `closedReason` only on a `missing` record; `closedNote` only
 * with a `closedReason`. Whether the images agree with the side is a
 * check on the volume (`planPages`, `missing-side`).
 */
const recordShape19 = z
  .object({
    ...recordFields,
    status: z.enum(CAPTURE_RECORD_STATUSES_1_9),
    missingSide: z.enum(MISSING_SIDES).nullable().optional(),
    closedReason: z.enum(CLOSED_REASONS).nullable().optional(),
    // Free text, as `rejectionNote` is, and cut to the same length when kept.
    closedNote: z.string().nullable().optional(),
    requestId: z.string().min(1).max(MAX_FIELD_CHARS).nullable().optional(),
  })
  .superRefine((r, ctx) => {
    const missing = r.status === "missing";
    if (missing && r.missingSide == null) {
      ctx.addIssue({ code: "custom", path: ["missingSide"], message: "a missing record gives its missingSide" });
    }
    if (!missing && r.missingSide != null) {
      ctx.addIssue({ code: "custom", path: ["missingSide"], message: "only a missing record gives missingSide" });
    }
    if (!missing && r.closedReason != null) {
      ctx.addIssue({ code: "custom", path: ["closedReason"], message: "only a missing record gives closedReason" });
    }
    if (r.closedNote != null && r.closedReason == null) {
      ctx.addIssue({ code: "custom", path: ["closedNote"], message: "closedNote comes with closedReason" });
    }
  });

/** The minor version of a version string `CAPTURE_VERSION_PATTERN` accepts; null for any other value. */
export function minorVersionOf(version: unknown): number | null {
  if (typeof version !== "string" || !CAPTURE_VERSION_PATTERN.test(version)) return null;
  return Number(version.slice(2));
}

const volumeShape = z.object({
  externalId: z.string().min(1).max(MAX_FIELD_CHARS).nullable(),
  captuaCollectionId: z.number().int(),
  stem: z.string().min(1).max(MAX_FIELD_CHARS),
  title: z.string().max(MAX_TEXT_CHARS),
  records: z.array(z.unknown()),
});

/**
 * The first minor version whose volumes may carry calibration shots and
 * a statement about them (contract §13): `calibration` and
 * `calibrationStatus`, with `skippedReason`. Before it both are ignored,
 * as every field the contract does not name is.
 */
export const CALIBRATION_MINOR = 12;
/** What a volume says of its calibration shots (contract §13). */
export const CALIBRATION_STATUSES = ["present", "skipped"] as const;
export type CalibrationStatus = (typeof CALIBRATION_STATUSES)[number];
/**
 * The longest a shot's `settings` may be, as JSON, in bytes. Settings are
 * stored as given, so the cap keeps one shot's row, and a statement of a
 * few shots, well inside what D1 takes.
 */
export const MAX_SETTINGS_BYTES = 16 * 1024;

/**
 * One calibration shot: a photograph of a colour reference card, never a
 * page. Its object fields are those of a record image, without `role`
 * and `pairId`; `rotateDeg` is checked per volume as an image's is.
 * `settings` is any object, kept as given. `capturedAt` is an ISO 8601
 * timestamp, with or without an offset.
 */
const calibrationShot = z
  .object({
    captureId: z.string().min(1).max(MAX_FIELD_CHARS),
    filename: z.string().min(1).max(MAX_FIELD_CHARS),
    objectKey: z.string().min(1).max(MAX_KEY_CHARS),
    sha256: z.string().regex(SHA256),
    previewObjectKey: z.string().min(1).max(MAX_KEY_CHARS).optional(),
    previewSha256: z.string().regex(SHA256).optional(),
    rotateDeg: z.unknown().optional(),
    camera: z.string().min(1).max(MAX_FIELD_CHARS),
    capturedAt: z.string().max(MAX_FIELD_CHARS).pipe(z.iso.datetime({ offset: true, local: true })),
    settings: z.record(z.string(), z.unknown()),
    appliesFromCaptureId: z.string().min(1).max(MAX_FIELD_CHARS),
  })
  .superRefine((shot, ctx) => {
    if ((shot.previewObjectKey === undefined) !== (shot.previewSha256 === undefined)) {
      ctx.addIssue({ code: "custom", message: "previewObjectKey and previewSha256 come together" });
    }
  });

export type CalibrationShot = z.infer<typeof calibrationShot>;

/**
 * A volume's statement about its shots from 1.12 on. null is read as
 * absent. `skippedReason` is free text, as a rejection note is, and is
 * kept only with `skipped`.
 */
const calibrationStatusShape = z.object({
  calibrationStatus: z.enum(CALIBRATION_STATUSES).nullable().optional(),
  skippedReason: z.string().nullable().optional(),
  calibration: z.array(z.unknown()).nullable().optional(),
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
export type CaptureRecord = Omit<z.infer<typeof recordShape19>, "images"> & { images: CaptureImage[] };
export type CaptureVolume = Omit<z.infer<typeof volumeShape>, "records"> & {
  records: CaptureRecord[];
  /** The volume's calibration shots, from 1.12 on; absent before, or when the manifest gives none. */
  calibration?: CalibrationShot[];
  /** What the volume says of its shots, from 1.12 on; absent when it says nothing. */
  calibrationStatus?: CalibrationStatus;
  /** Why the shots were skipped, with `skipped` only. */
  skippedReason?: string;
};

/**
 * The record statuses that make an opening, the unit capture QC decides:
 * the records handed over for review or approved on the unit.
 */
export const OPENING_STATUSES: ReadonlySet<string> = new Set(["in_review", "approved"]);

/** Whether a record of that status is an opening. */
export function isOpening(status: string): boolean {
  return OPENING_STATUSES.has(status);
}

/** What `qcStatusOf` reads of a record: its status and, for a placeholder, its side and closing reason. */
export interface RecordStatusFields {
  status: string;
  missingSide?: string | null;
  closedReason?: string | null;
}

/**
 * The status capture QC, the hold and the pages read a record as. Every
 * status but `missing` is read as itself. A `missing` record (contract
 * §10.3) is read as:
 *
 *   - `rejected` while it is open (no `closedReason`): a capture the
 *     unit owes, which is not an opening, is not a page, and holds the
 *     volume exactly as a record rejected on the unit does;
 *   - `excluded` once closed with no image (`missingSide` `both`): not
 *     an opening, not a page, and holding nothing;
 *   - `in_review` once closed with the image of its other side: an
 *     opening capture QC decides, whose image is a page.
 *
 * The delivery's records keep `missing` and the placeholder's fields as
 * the manifest gives them. The delivery's counts and its images'
 * `record_status` are written from this reading, so the hold,
 * carry-over, dispatch and the review images read a placeholder through
 * the statuses they already know.
 */
export function qcStatusOf(r: RecordStatusFields): string {
  if (r.status !== "missing") return r.status;
  if (r.closedReason == null) return "rejected";
  return r.missingSide === "both" ? "excluded" : "in_review";
}

/** Whether a record is a placeholder not yet closed (contract §10.3): it holds the volume. */
export function isOpenPlaceholder(r: RecordStatusFields): boolean {
  return r.status === "missing" && r.closedReason == null;
}

/** Why a volume whose every record is a placeholder closed with no image is refused (`no-pages`). */
export const NO_PAGES_CLOSED_ONLY =
  "every record of the volume is a placeholder closed with no image, so no record has an image to make a page";

/** Why a volume's first delivery with open placeholders and no page is refused (`no-pages`). */
export const NO_PAGES_FIRST_OPEN =
  "no record has an image to make a page, and Fisqua holds no earlier delivery of the volume for its open placeholders to hold";

/** Whether a record is an opening, read as `qcStatusOf` reads it. */
export function isOpeningRecord(r: RecordStatusFields): boolean {
  return isOpening(qcStatusOf(r));
}

/** How many openings a manifest volume has. */
export function openingCount(v: Pick<CaptureVolume, "records">): number {
  return v.records.filter(isOpeningRecord).length;
}

/** The Captua record ids of a manifest volume's openings. */
export function openingIdsOf(v: Pick<CaptureVolume, "records">): number[] {
  return v.records.filter(isOpeningRecord).map((r) => r.captuaRecordId);
}

/**
 * How many records of a manifest volume are read as `rejected`
 * (`qcStatusOf`): openings with a retake outstanding on the unit, and
 * open placeholders. `planPages` leaves them out, and they hold the
 * volume from processing (`hold.server.ts`).
 */
export function rejectedRecordCount(v: Pick<CaptureVolume, "records">): number {
  return v.records.filter((r) => qcStatusOf(r) === "rejected").length;
}

type Sequenced = { captuaRecordId: number; sequence: number };

/**
 * Whether the records both lists hold appear in a different relative
 * order, each list ordered by `sequence` (contract §10.2). Records in
 * only one list are left out, so a placeholder inserted, or a record
 * left out, with the rest renumbered around it, is no reordering.
 */
export function sequenceReordered(previous: ReadonlyArray<Sequenced>, current: ReadonlyArray<Sequenced>): boolean {
  const before = new Set(previous.map((r) => r.captuaRecordId));
  const now = new Set(current.map((r) => r.captuaRecordId));
  const order = (list: ReadonlyArray<Sequenced>, other: Set<number>) =>
    list
      .filter((r) => other.has(r.captuaRecordId))
      .sort((a, b) => a.sequence - b.sequence || a.captuaRecordId - b.captuaRecordId)
      .map((r) => r.captuaRecordId);
  const a = order(previous, now);
  const b = order(current, before);
  return a.some((id, i) => id !== b[i]);
}

/**
 * The `sequence-reordered` note of a volume whose records the volume's
 * registered delivery (`previous`, null when it has none) holds in
 * another relative order (`sequenceReordered`); none otherwise. A note
 * refuses nothing: approvals still carry over by record id and identical
 * images.
 */
export function reorderNotes(
  v: Pick<CaptureVolume, "stem" | "externalId" | "records">,
  previous: ReadonlyArray<Sequenced> | null,
): CaptureProblem[] {
  if (previous === null || !sequenceReordered(previous, v.records)) return [];
  return [
    {
      rule: "sequence-reordered",
      message: "The volume's records appear in a different order from the delivery Fisqua had registered",
      stem: v.stem,
      ...(v.externalId !== null ? { referenceCode: v.externalId } : {}),
    },
  ];
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

  /** A problem of its own rule, kept and counted as the others are. */
  ruled(rule: string, path: Array<string | number>, message: string): void {
    if (this.problems.length >= MAX_SHAPE_PROBLEMS) {
      this.omitted++;
      return;
    }
    const p = path.map(String).join(".");
    this.problems.push({ rule, message: `${p}: ${message}`, path: p });
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
  // Placeholders are read from 1.9 on; records of an unreadable version are read as 1.1's.
  const minor = minorVersionOf(raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).version : null);
  const recordSchema = minor !== null && minor >= MISSING_RECORDS_MINOR ? recordShape19 : recordShape;
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
          const r = recordSchema.safeParse(rr);
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
      // Calibration shots and their statement, from 1.12 on (contract §13).
      const calibration: Partial<Pick<CaptureVolume, "calibration" | "calibrationStatus" | "skippedReason">> = {};
      if (minor !== null && minor >= CALIBRATION_MINOR && rv !== null && typeof rv === "object") {
        const c = calibrationStatusShape.safeParse(rv);
        if (!c.success) found.issues(c.error.issues, ["volumes", vi]);
        else {
          if (c.data.calibrationStatus != null) calibration.calibrationStatus = c.data.calibrationStatus;
          if (c.data.calibrationStatus === "skipped" && c.data.skippedReason != null) {
            calibration.skippedReason = c.data.skippedReason;
          }
          if (Array.isArray(c.data.calibration)) {
            const shots: CalibrationShot[] = [];
            c.data.calibration.forEach((rs, si) => {
              const at = ["volumes", vi, "calibration", si];
              const shot = calibrationShot.safeParse(rs);
              if (!shot.success) {
                found.issues(shot.error.issues, at);
                return;
              }
              const bytes = new TextEncoder().encode(JSON.stringify(shot.data.settings)).length;
              if (bytes > MAX_SETTINGS_BYTES) {
                found.ruled("field-too-long", [...at, "settings"], `settings take ${bytes} bytes as JSON, past ${MAX_SETTINGS_BYTES}`);
                return;
              }
              if (found.count === 0) shots.push(shot.data);
            });
            calibration.calibration = shots;
          }
        }
      }
      if (v.success && found.count === 0) volumes.push({ ...v.data, records, ...calibration });
    });
  }

  // Repeated stems and reference codes, once every piece is sound.
  if (envelope.success && found.count === 0) {
    const stems = new Set<string>();
    const codes = new Set<string>();
    volumes.forEach((v, i) => {
      if (stems.has(v.stem)) found.custom(["volumes", i, "stem"], `stem ${quotedName(v.stem)} appears twice`);
      stems.add(v.stem);
      if (v.externalId !== null) {
        if (codes.has(v.externalId)) found.custom(["volumes", i, "externalId"], `externalId ${quotedName(v.externalId)} appears twice`);
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
    message: `The manifest's transfer root ${quotedName(manifest.transfer.root)} is not the tenant's prefix ${quotedName(`${slug}/`)}`,
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
  /** A calibration shot's object (contract §13), never a master; checked on its own (`missingCalibrationObjects`). */
  calibration?: boolean;
}

/** One object of a calibration shot: its full key and the key as the manifest writes it. */
export interface PlannedShotObject {
  kind: "capture" | "preview";
  /** Relative to `transfer.root`, as the manifest writes it. */
  objectKey: string;
  /** The full key in the masters bucket. */
  key: string;
}

/** A calibration shot of a planned volume, with the objects it names. */
export interface PlannedShot {
  captureId: string;
  objects: PlannedShotObject[];
}

export interface PagePlan {
  pages: PlannedPage[];
  /** Reasons the volume is rejected; empty when it passes. */
  problems: string[];
  /** The same reasons, each with its rule and ids. */
  issues: CaptureProblem[];
  /** Every object key the manifest names for the volume, any record status, calibration shots included. */
  objects: ManifestObject[];
  /** The volume's calibration shots (contract §13), in manifest order; none before 1.12. */
  calibration: PlannedShot[];
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
  const calibration = plannedShots(v, root);
  for (const shot of calibration) {
    for (const o of shot.objects) objects.push({ key: o.key, master: false, calibration: true });
  }
  calibrationProblems(v).forEach((p) => issues.push(p));

  if (!PIPELINE_PAGE_KEY_PATTERN.test(v.stem)) problem("stem", `stem ${quotedName(v.stem)} is outside the page-key pattern`);

  const kept = v.records
    .filter((r) => {
      const s = qcStatusOf(r);
      return s === "in_review" || s === "approved" || (allowCaptured && s === "captured");
    })
    .sort((a, b) => a.sequence - b.sequence);

  // A page's file name holding a control character is refused before any
  // other rule quotes the name, so its first refusal is this one; the page
  // is planned no further.
  const badNames = new Set<CaptureImage>();
  for (const r of kept) {
    for (const img of [...r.images].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])) {
      if (!hasControlCharacter(img.filename)) continue;
      badNames.add(img);
      problem("filename", `the image's file name ${quotedName(img.filename)} holds a control character`, {
        captuaRecordId: r.captuaRecordId,
        captureId: img.captureId,
        filename: img.filename,
      });
    }
  }

  // Every image's rotation, any record status: each image becomes a
  // `capture_images` row, whose CHECK takes the four values only.
  for (const r of v.records) {
    for (const img of r.images) {
      if (img.rotateDeg === undefined || img.rotateDeg === null || isRotateDeg(img.rotateDeg)) continue;
      problem(
        "rotate-deg",
        `the image ${quotedName(img.filename)} has rotateDeg ${shownValue(img.rotateDeg)}, not 0, 90, 180 or 270`,
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

  // A sequence names one record of the volume, whatever its status: the
  // order of a volume is its records' sequence alone (contract §10.2).
  const bySequence = new Map<number, number[]>();
  for (const r of v.records) bySequence.set(r.sequence, [...(bySequence.get(r.sequence) ?? []), r.captuaRecordId]);
  for (const [sequence, ids] of bySequence) {
    if (ids.length < 2) continue;
    problem("sequence", `record sequence ${sequence} appears on records ${ids.join(", ")}`, { sequence, captuaRecordIds: ids });
  }

  // A placeholder's images are those of the side it has: none when it
  // misses both, otherwise the one image of the other side.
  const sideBroken = new Set<number>();
  for (const r of v.records) {
    if (r.status !== "missing") continue;
    const roles = r.images.map((i) => i.role).join(",");
    const expected = r.missingSide === "both" ? "" : r.missingSide === "left" ? "right" : "left";
    if (roles === expected) continue;
    sideBroken.add(r.captuaRecordId);
    problem(
      "missing-side",
      `record ${r.captuaRecordId} misses ${r.missingSide === "both" ? "both sides" : `its ${r.missingSide} side`} and has images ${roles.replace(/,/g, ", ") || "none"}`,
      { captuaRecordId: r.captuaRecordId, missingSide: r.missingSide },
    );
  }

  const pages: PlannedPage[] = [];
  const keys = new Set<string>();
  for (const r of kept) {
    if (sideBroken.has(r.captuaRecordId)) continue;
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
      // Refused above, before the rotation check.
      if (badNames.has(img)) continue;
      if (!fileForm.test(img.filename)) {
        problem("filename", `filename ${quotedName(img.filename)} is not of the form ${quotedName(`${v.stem}-img_<nnnn>_c<n>.<ext>`)}`, {
          ...ids,
          filename: img.filename,
        });
        continue;
      }
      const pageKey = img.filename.replace(/\.[^.]+$/, "");
      if (!PIPELINE_PAGE_KEY_PATTERN.test(pageKey)) {
        problem("page-key", `page key ${quotedName(pageKey)} is outside the page-key pattern`, { ...ids, pageKey });
        continue;
      }
      if (keys.has(pageKey)) {
        problem("page-key", `page key ${quotedName(pageKey)} appears twice`, { ...ids, pageKey });
        continue;
      }
      keys.add(pageKey);
      // The capture sits at the key the contract names for it, under its own
      // filename, so the file the filename describes is the file read.
      const expectedCapture = captureKeyFor(v.stem, img.filename);
      if (img.objectKey !== expectedCapture) {
        const shown = hasControlCharacter(img.objectKey)
          ? `${quotedName(img.objectKey)}, which holds a control character`
          : `${quotedName(img.objectKey)}, not ${quotedName(expectedCapture)}`;
        problem("capture-key", `the capture ${quotedName(img.filename)} is at ${shown}`, {
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
          const shown = hasControlCharacter(img.previewObjectKey)
            ? `${quotedName(img.previewObjectKey)}, which holds a control character`
            : `${quotedName(img.previewObjectKey)}, not ${quotedName(expected)}`;
          problem("preview-key", `the preview of ${quotedName(img.filename)} is ${shown}`, {
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
        problem("object-key", `${outside.map(quotedName).join(" and ")} ${outside.length > 1 ? "lie" : "lies"} outside ${quotedName(prefix)}`, {
          ...ids,
          objectKeys: outside,
        });
        continue;
      }
      // The pipeline reads the preview, or the capture of a JPEG-only rig;
      // a RAW is a preservation master and is never its input.
      if (previewKey === null && (isRawCapture(img.filename) || isRawCapture(img.objectKey))) {
        problem("preview-missing", `${quotedName(img.filename)} is a RAW capture with no preview`, {
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
  for (const o of objects) o.master = !o.calibration && masters.has(o.key);
  // A delivery with no page passes here only when it has an open
  // placeholder, which holds the volume; `planVolumes` takes it only as a
  // replacement.
  if (issues.length === 0 && pages.length === 0 && !v.records.some(isOpenPlaceholder)) {
    const closedOnly = v.records.length > 0 && v.records.every((r) => r.status === "missing");
    problem("no-pages", closedOnly ? NO_PAGES_CLOSED_ONLY : "no in_review or approved record has an image");
  }
  return { pages, problems: issues.map((i) => i.message), issues, objects, calibration };
}

/** A volume's calibration shots with the objects each names, in manifest order. */
function plannedShots(v: CaptureVolume, root: string): PlannedShot[] {
  return (v.calibration ?? []).map((shot) => ({
    captureId: shot.captureId,
    objects: [
      { kind: "capture" as const, objectKey: shot.objectKey, key: `${root}${shot.objectKey}` },
      ...(shot.previewObjectKey !== undefined
        ? [{ kind: "preview" as const, objectKey: shot.previewObjectKey, key: `${root}${shot.previewObjectKey}` }]
        : []),
    ],
  }));
}

/** Where the exchange contract puts a calibration shot, relative to the transfer root. */
export function calibrationKeyFor(stem: string, filename: string): string {
  return `${stem}/calibration/${filename}`;
}

/** The name of a calibration shot's preview: its filename's stem, `_preview.jpg`. */
function calibrationPreviewName(filename: string): string {
  return `${filename.replace(/\.[^.]+$/, "")}_preview.jpg`;
}

/** Where it puts a calibration shot's preview, beside the shot. */
export function calibrationPreviewKeyFor(stem: string, filename: string): string {
  return `${stem}/calibration/${calibrationPreviewName(filename)}`;
}

/**
 * Whether a file name or object key holds a control character (U+0000-U+001F
 * or U+007F). rclone lists the files it reads one per line, so a newline in a
 * key splits it in two and the file reads as missing. A page image's file name
 * and keys and a calibration shot's file name are held to it here, and the run
 * spec holds its master keys, an item PDF's source key and its calibration
 * keys to it (`run-spec.ts`). The media-pipeline runner applies its own check
 * to calibration keys only.
 */
export function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * A file name or key as a refusal quotes it: in double quotes, a quote or
 * backslash escaped with a backslash, and every control character
 * (U+0000-U+001F, U+007F) written as `\uXXXX`, so no message carries one.
 */
export function quotedName(value: string): string {
  const escaped = value
    .replace(/["\\]/g, (c) => `\\${c}`)
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

/**
 * A value of any type as a refusal shows it: its JSON, cut to 32 characters
 * with an ellipsis, through `quotedName`, so a string, or an object's key,
 * that holds a control character shows it escaped.
 */
function shownValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return quotedName(text.length > 32 ? `${text.slice(0, 32)}…` : text);
}

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** At most 200 bytes of UTF-8, and no unpaired surrogate, which has no UTF-8 form. */
function fitsNameBytes(name: string): boolean {
  return !UNPAIRED_SURROGATE.test(name) && new TextEncoder().encode(name).length <= 200;
}

/**
 * A shot's filename is one path segment: not `.` or `..`, no `/` or
 * backslash, no control character (U+0000-U+001F, U+007F), no unpaired
 * surrogate, at most 200 bytes of UTF-8. The empty string fails here too, though the shape check refuses
 * it first.
 */
function isCalibrationFilename(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !/[\\/]/.test(name) &&
    !hasControlCharacter(name) &&
    fitsNameBytes(name)
  );
}

/**
 * Why a volume's calibration shots refuse it, before the bucket is
 * listed (contract §13): a shot at any key but
 * `<stem>/calibration/<filename>`, or a preview at any but
 * `<stem>/calibration/<filename stem>_preview.jpg`, or a filename that
 * is a path (`calibration-key`); a shot whose `captureId`, `objectKey`
 * or `previewObjectKey` is also a record image's (capture or preview
 * key), or an earlier shot's (`calibration-identity`), which would
 * otherwise let one file stand as a shot and a page; a shot whose `appliesFromCaptureId` names no
 * capture of a record image of the volume, whatever the record's status
 * (`calibration-applies-from`), and a shot whose `rotateDeg` is present,
 * not null, and not 0, 90, 180 or 270 (`rotate-deg`, as for an image).
 * A shot is never a page, so nothing here touches the pages.
 */
export function calibrationProblems(v: CaptureVolume): CaptureProblem[] {
  const shots = v.calibration ?? [];
  if (shots.length === 0) return [];
  const images = v.records.flatMap((r) => r.images);
  const captures = new Set(images.map((i) => i.captureId));
  // Every key a record image names, capture or preview: a shot may share none.
  const imageKeys = new Set(images.flatMap((i) => [i.objectKey, ...(i.previewObjectKey !== undefined ? [i.previewObjectKey] : [])]));
  const shotIds = new Set<string>();
  const shotKeys = new Set<string>();
  const out: CaptureProblem[] = [];
  shots.forEach((shot, index) => {
    const ids = { stem: v.stem, calibrationIndex: index, captureId: shot.captureId };
    // The keys the contract fixes for a shot, as `capture-key` and
    // `preview-key` fix a page image's.
    const expected = calibrationKeyFor(v.stem, shot.filename);
    const nameOk = isCalibrationFilename(shot.filename);
    if (!nameOk || shot.objectKey !== expected) {
      out.push({
        rule: "calibration-key",
        message: nameOk
          ? `the calibration shot ${quotedName(shot.filename)} is at ${quotedName(shot.objectKey)}, not ${quotedName(expected)}`
          : `the calibration shot's file name ${quotedName(shot.filename)} is not a single path segment of at most 200 bytes without control characters`,
        ...ids,
        objectKey: shot.objectKey,
        kind: "capture",
      });
    }
    if (shot.previewObjectKey !== undefined) {
      const expectedPreview = calibrationPreviewKeyFor(v.stem, shot.filename);
      // The preview's name is held to the same cap as the shot's.
      const previewFits = fitsNameBytes(calibrationPreviewName(shot.filename));
      if (shot.previewObjectKey !== expectedPreview || !previewFits) {
        out.push({
          rule: "calibration-key",
          message: previewFits
            ? `the preview of the calibration shot ${quotedName(shot.filename)} is ${quotedName(shot.previewObjectKey)}, not ${quotedName(expectedPreview)}`
            : `the preview name of the calibration shot ${quotedName(shot.filename)} is longer than 200 bytes`,
          ...ids,
          objectKey: shot.previewObjectKey,
          kind: "preview",
        });
      }
    }
    // One identity per shot: never a record image's, never another shot's.
    const identity = (field: "captureId" | "objectKey" | "previewObjectKey", value: string) =>
      out.push({
        rule: "calibration-identity",
        message: `the calibration shot ${quotedName(shot.filename)} has the ${field} ${quotedName(value)} of a page image or of another shot`,
        ...ids,
        field,
        value,
      });
    if (captures.has(shot.captureId) || shotIds.has(shot.captureId)) identity("captureId", shot.captureId);
    shotIds.add(shot.captureId);
    for (const field of ["objectKey", "previewObjectKey"] as const) {
      const key = shot[field];
      if (key === undefined) continue;
      if (imageKeys.has(key) || shotKeys.has(key)) identity(field, key);
      shotKeys.add(key);
    }
    if (!captures.has(shot.appliesFromCaptureId)) {
      out.push({
        rule: "calibration-applies-from",
        message: `the calibration shot ${quotedName(shot.filename)} applies from ${quotedName(shot.appliesFromCaptureId)}, which is no capture of the volume`,
        ...ids,
        appliesFromCaptureId: shot.appliesFromCaptureId,
      });
    }
    if (shot.rotateDeg !== undefined && shot.rotateDeg !== null && !isRotateDeg(shot.rotateDeg)) {
      out.push({
        rule: "rotate-deg",
        message: `the calibration shot ${quotedName(shot.filename)} has rotateDeg ${shownValue(shot.rotateDeg)}, not 0, 90, 180 or 270`,
        ...ids,
      });
    }
  });
  return out;
}

/**
 * One `calibration-object` problem for each object of a calibration shot
 * that the masters listing does not hold (contract §13), capture or
 * preview: `{rule, message, stem, objectKey, captureId, kind}`, with
 * `objectKey` as the manifest writes it. A key outside the volume's
 * prefix is never in its listing, so it is reported here too.
 */
export function missingCalibrationObjects(
  stem: string,
  shots: ReadonlyArray<PlannedShot>,
  listing: ReadonlyMap<string, number>,
): CaptureProblem[] {
  const out: CaptureProblem[] = [];
  for (const shot of shots) {
    for (const o of shot.objects) {
      if (listing.has(o.key)) continue;
      out.push({
        rule: "calibration-object",
        message: `The calibration shot's ${o.kind} ${quotedName(o.objectKey)} is named by the manifest and is not in the masters bucket`,
        stem,
        objectKey: o.objectKey,
        captureId: shot.captureId,
        kind: o.kind,
      });
    }
  }
  return out;
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
  | "missing_calibration"
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
  /** The volume's calibration shots and their objects (contract §13); set for register and replace. */
  calibration?: PlannedShot[];
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
  missing_calibration: "calibration-object",
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
  missing_calibration: "A calibration shot's object is not in the masters bucket",
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
    // A delivery with no page, only open placeholders to hold the volume,
    // is taken only over a volume Fisqua already holds: it supersedes that
    // volume's delivery and holds it. A volume's first delivery needs a
    // page, since a pipeline volume holds at least one.
    if (plan.pages.length === 0 && !current) {
      return skip(v, "rejected", [NO_PAGES_FIRST_OPEN], [{ rule: "no-pages", message: NO_PAGES_FIRST_OPEN, stem: v.stem }]);
    }
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
      calibration: plan.calibration,
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
    const missingOthers = objects.filter((o) => !o.master && !o.calibration && !listed.has(o.key)).map((o) => o.key);
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
        detail: missingMasters.map((k) => `${quotedName(k)} is not in the masters bucket`),
        issues: missingMasters.map((k) => ({
          rule: SKIP_RULES.missing_objects,
          message: `${quotedName(k)} is not in the masters bucket`,
          stem: v.stem,
          objectKey: k,
        })),
        inventory,
      };
    }
    // A calibration shot's object missing refuses the volume (contract §13).
    const missingShots = missingCalibrationObjects(v.stem, v.calibration ?? [], listed);
    if (missingShots.length > 0) {
      return {
        stem: v.stem,
        externalId: v.externalId,
        captuaCollectionId: v.captuaCollectionId,
        action: "skip",
        reason: "missing_calibration",
        detail: missingShots.map((p) => p.message),
        issues: missingShots,
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
      message: `${quotedName(o.key)} is in the masters bucket and not in the manifest`,
      stem: v.stem,
      objectKey: o.key,
      size: o.size,
    })),
    ...inv.missingOthers.map((k) => ({
      rule: "missing-object",
      message: `${quotedName(k)} is in the manifest and not in the masters bucket`,
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

// @version v0.9.0
