/**
 * Scripts — copying pre-contract captures into the masters bucket under
 * contract names
 *
 * This module deals with the images a Captua appliance shot before it
 * named files by the Captua exchange contract. They sit in a B2
 * bucket under their old names; Captua writes one rename map per volume
 * that pairs each old key with the contract name it takes in the
 * federation's masters bucket, `{slug}/<stem>/captures/…` or
 * `{slug}/<stem>/previews/…_preview.jpg`. The command in
 * `scripts/commands/copy-renamed-captures.ts` is a thin shell around
 * `copyRenamedCaptures` here; the providers are injected, so the tests
 * run every step against fakes.
 *
 * `parseRenameMap` checks the envelope (contract
 * `fisqua-captua-exchange`, version `1.1`, kind `rename-map`, produced by
 * `captua`) and the shape, and `checkRenameMap` the rules a valid shape
 * can still break; either refuses the whole map, naming every problem:
 * a destination root other than `{slug}/`, a volume stem that is not its
 * reference code, a highest ordinal above the volume's `counterAfter`
 * (the next capture on the card would take a number the bucket already
 * holds), a destination key not of the contract's form for its ordinal,
 * camera and kind, a source or destination key that appears twice, two
 * entries with one ordinal, camera and kind, and a file over the 5 GB
 * that `b2_copy_file` copies in one call (larger files need
 * `b2_copy_part`, which this command does not do). The map's ordinals
 * are taken as Captua gives them: only their form is checked, never
 * their order against capture times. `imageId`, `recordId`,
 * `originalFilename` and `superseded` are checked and carried into the
 * report as they are; nothing here acts on them. Fields the contract does
 * not name are ignored.
 *
 * `copyRenamedCaptures` reads the tenant and its federation's record from
 * D1 (read only), refuses a map whose destination bucket is not the
 * federation's masters bucket. It lists the source with
 * `b2_list_file_names` for each file's size and SHA1 (`sha1Of`), and the
 * destination with `b2_list_file_versions`, which also shows hide
 * markers and earlier versions that `b2_list_file_names` leaves out. It
 * sorts every entry with `classifyEntry` into `[copy]` (the source holds
 * the stated bytes, and the stated SHA1 when the map gives one; no
 * version of any kind is at the destination), `[exists]` (the
 * destination holds exactly one version, a file of the source's size and
 * SHA1, which counts as done, so a rerun skips it), `[conflict]` (the
 * destination holds something else, something whose SHA1 cannot be
 * compared, a hidden file or an earlier version; never overwritten and
 * never given a new version) or `[missing]` (the source is absent or
 * differs from the map). A dry run, the default, stops there. With
 * `--apply`, any conflict or missing entry stops the command before it
 * copies anything; otherwise each `[copy]` entry is copied with
 * `b2_copy_file`, at most four in flight. Just before each copy the
 * destination key's versions are listed again, and any version that has
 * appeared there since is left alone and stops the run; after each copy
 * they are listed again, and the key must hold exactly one version, the
 * one the copy made, with the source's size and SHA1. A failed copy or
 * check stops any copy not yet started, including one whose lookup was
 * still pending; nothing is ever deleted. When neither B2 nor the map
 * knows a source's SHA1 the copy is checked by size only, and the report
 * says so. B2 has no conditional copy, so two runs of the same map must
 * not overlap; if they do, the second version at a key is reported as a
 * failure, not removed.
 *
 * Every run writes `.import/rename-copy_<map id>.json`, with every entry
 * and its outcome, and prints counts and bytes per outcome.
 *
 * @version v0.8.0
 */

import { z } from "zod";
import { RegistrationStop } from "./capture-registration";
import {
  findRecordBucket,
  resolveTenantStorage,
  type B2Api,
  type B2FileDetail,
  type B2FileVersion,
  type D1Api,
  type Log,
} from "./tenant-storage";

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export const RENAME_CONTRACT = "fisqua-captua-exchange";
export const RENAME_VERSION = "1.1";
export const RENAME_KIND = "rename-map";

/** The largest file `b2_copy_file` copies in one call: 5 GB. */
export const MAX_COPY_BYTES = 5_000_000_000;

/** Copies in flight at once. */
export const COPY_CONCURRENCY = 4;

const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const entrySchema = z.object({
  captureId: z.string().regex(UUID),
  imageId: z.number().int().nullable(),
  recordId: z.number().int().nullable(),
  capturedAt: z.string().min(1),
  ordinal: z.number().int().min(1),
  camera: z.number().int().min(0),
  role: z.enum(["left", "right", "single"]),
  kind: z.enum(["capture", "preview"]),
  originalFilename: z.string().min(1),
  superseded: z.boolean().nullable(),
  sourceKey: z.string().min(1),
  destinationKey: z.string().min(1),
  sha256: z.string().regex(SHA256).nullable(),
  sha1: z.string().regex(SHA1).nullable(),
  bytes: z.number().int().min(0),
});

const mapSchema = z.object({
  contract: z.literal(RENAME_CONTRACT),
  version: z.literal(RENAME_VERSION),
  kind: z.literal(RENAME_KIND),
  id: z.string().regex(UUID),
  generatedAt: z.string().min(1),
  generatedBy: z.object({ system: z.literal("captua"), instance: z.string(), systemVersion: z.string() }),
  inReplyTo: z.string().regex(UUID).nullable(),
  volume: z.object({
    externalId: z.string().min(1),
    stem: z.string().min(1),
    captuaCollectionId: z.number().int(),
    counterAfter: z.number().int().min(0),
  }),
  source: z.object({ bucket: z.string().min(1) }),
  destination: z.object({ bucket: z.string().min(1), root: z.string().min(1) }),
  entries: z.array(entrySchema).min(1),
});

export type RenameMap = z.infer<typeof mapSchema>;
export type RenameEntry = RenameMap["entries"][number];

/** The map, or a stop listing why the whole map is refused. */
export function parseRenameMap(raw: unknown): RenameMap {
  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RegistrationStop(
      "The rename map is refused whole",
      parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** `<nnnn>`: the ordinal, zero-padded to four digits at least. */
export function padOrdinal(ordinal: number): string {
  return String(ordinal).padStart(4, "0");
}

/** Why an entry's destination key is not the contract's name for it; null when it is. */
export function destinationKeyProblem(stem: string, e: RenameEntry): string | null {
  const base = `${stem}-img_${padOrdinal(e.ordinal)}_c${e.camera}`;
  if (e.kind === "preview") {
    const wanted = `${stem}/previews/${base}_preview.jpg`;
    return e.destinationKey === wanted ? null : `destinationKey ${e.destinationKey} is not ${wanted}`;
  }
  const head = `${stem}/captures/${base}.`;
  const ok = e.destinationKey.startsWith(head) && /^[A-Za-z0-9]+$/.test(e.destinationKey.slice(head.length));
  return ok ? null : `destinationKey ${e.destinationKey} is not ${head}<ext>`;
}

/**
 * Every rule of the map a valid shape can still break, for one tenant;
 * stops naming each problem, or returns when there is none.
 */
export function checkRenameMap(map: RenameMap, slug: string): void {
  const problems: string[] = [];
  const { stem, externalId, counterAfter } = map.volume;
  if (map.destination.root !== `${slug}/`) {
    problems.push(`destination.root ${map.destination.root} is not the tenant's prefix ${slug}/`);
  }
  if (stem !== externalId) problems.push(`volume.stem ${stem} is not volume.externalId ${externalId}`);
  const highest = Math.max(...map.entries.map((e) => e.ordinal));
  if (highest > counterAfter) {
    problems.push(`the highest ordinal, ${highest}, is above volume.counterAfter ${counterAfter}`);
  }
  const sources = new Set<string>();
  const destinations = new Set<string>();
  const slots = new Set<string>();
  map.entries.forEach((e, i) => {
    const at = `entries.${i}`;
    const keyProblem = destinationKeyProblem(stem, e);
    if (keyProblem) problems.push(`${at}: ${keyProblem}`);
    if (sources.has(e.sourceKey)) problems.push(`${at}: sourceKey ${e.sourceKey} appears twice`);
    sources.add(e.sourceKey);
    if (destinations.has(e.destinationKey)) problems.push(`${at}: destinationKey ${e.destinationKey} appears twice`);
    destinations.add(e.destinationKey);
    const slot = `${e.ordinal}/${e.camera}/${e.kind}`;
    if (slots.has(slot)) {
      problems.push(`${at}: ordinal ${e.ordinal}, camera ${e.camera} and kind ${e.kind} appear twice`);
    }
    slots.add(slot);
    if (e.bytes > MAX_COPY_BYTES) {
      problems.push(
        `${at}: ${e.sourceKey} is ${e.bytes} bytes, over the 5 GB b2_copy_file copies in one call; ` +
          "this command does not copy large files in parts",
      );
    }
  });
  if (problems.length > 0) throw new RegistrationStop("The rename map is refused whole", problems);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Outcome = "copy" | "exists" | "conflict" | "missing";

/** A file as the report shows it: size and SHA1 (null when unknown). */
export interface SeenFile {
  bytes: number;
  sha1: string | null;
}

export interface Classified {
  outcome: Outcome;
  reason: string | null;
  /** The SHA1 the copy must carry: B2's for the source, else the map's; null when neither knows. */
  expectedSha1: string | null;
  source: SeenFile | null;
  destination: SeenFile | null;
}

const seen = (f: B2FileDetail | undefined): SeenFile | null =>
  f ? { bytes: f.contentLength, sha1: f.sha1 } : null;

/** The version a name shows in a listing: its newest, when that is an upload. */
export function visibleVersion(versions: B2FileVersion[]): B2FileVersion | undefined {
  return versions[0]?.action === "upload" ? versions[0] : undefined;
}

const HIDDEN_OR_EARLIER = "a hidden file or an earlier version is at the destination; it is left as it is";

/**
 * One entry's outcome from what the source key holds and every version
 * at the destination key, newest first.
 */
export function classifyEntry(
  e: RenameEntry,
  src: B2FileDetail | undefined,
  dstVersions: B2FileVersion[],
): Classified {
  const dst = visibleVersion(dstVersions);
  const base = { source: seen(src), destination: seen(dst) };
  if (!src) return { ...base, outcome: "missing", reason: "the source is not in the source bucket", expectedSha1: null };
  if (src.contentLength !== e.bytes) {
    return {
      ...base,
      outcome: "missing",
      reason: `the source holds ${src.contentLength} bytes, the map says ${e.bytes}`,
      expectedSha1: null,
    };
  }
  if (e.sha1 && src.sha1 && src.sha1 !== e.sha1) {
    return {
      ...base,
      outcome: "missing",
      reason: `the source's SHA1 is ${src.sha1}, the map says ${e.sha1}`,
      expectedSha1: null,
    };
  }
  const expectedSha1 = src.sha1 ?? e.sha1;
  const unknownNote = src.sha1 ? null : e.sha1 ? "B2 does not know the source's SHA1; the map's is used" : "the source's SHA1 is unknown";
  if (dstVersions.length === 0) return { ...base, outcome: "copy", reason: unknownNote, expectedSha1 };
  if (!dst) return { ...base, outcome: "conflict", reason: HIDDEN_OR_EARLIER, expectedSha1 };
  if (dst.contentLength !== src.contentLength) {
    return {
      ...base,
      outcome: "conflict",
      reason: `the destination holds ${dst.contentLength} bytes, the source ${src.contentLength}`,
      expectedSha1,
    };
  }
  if (!expectedSha1 || !dst.sha1) {
    return {
      ...base,
      outcome: "conflict",
      reason: "a file is at the destination and its SHA1 cannot be compared with the source's",
      expectedSha1,
    };
  }
  if (dst.sha1 !== expectedSha1) {
    return {
      ...base,
      outcome: "conflict",
      reason: `the destination's SHA1 is ${dst.sha1}, the source's ${expectedSha1}`,
      expectedSha1,
    };
  }
  if (dstVersions.length !== 1) return { ...base, outcome: "conflict", reason: HIDDEN_OR_EARLIER, expectedSha1 };
  return { ...base, outcome: "exists", reason: null, expectedSha1 };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface RenameCopyOptions {
  /** The tenant's slug. */
  slug: string;
  apply: boolean;
}

export interface RenameCopyProviders {
  /** The production database, read only. */
  d1: D1Api;
  /** Null without the operator's B2 credentials; the command needs them. */
  b2: B2Api | null;
  /** Writes a local file (the report). */
  writeFile: (path: string, text: string) => void;
}

/** After `--apply`: copied and checked, failed, or not started because the run stopped. */
export type ApplyResult = "copied" | "failed" | "not-started";

export interface ReportEntry extends RenameEntry {
  /** The full key in the destination bucket. */
  destinationObject: string;
  outcome: Outcome;
  reason: string | null;
  source: SeenFile | null;
  destination: SeenFile | null;
  applied?: ApplyResult;
  appliedReason?: string | null;
  /** How the copy was checked: SHA1 and size, or size alone when no SHA1 was known. */
  check?: "sha1-and-size" | "size-only";
}

export interface RenameCopyReport {
  mapId: string;
  tenant: string;
  volume: RenameMap["volume"];
  sourceBucket: string;
  destinationBucket: string;
  applied: boolean;
  totals: Record<Outcome | ApplyResult, { objects: number; bytes: number }>;
  entries: ReportEntry[];
}

export const OUTPUT_DIR = ".import";

export function reportPath(mapId: string): string {
  return `${OUTPUT_DIR}/rename-copy_${mapId}.json`;
}

/** The prefixes that list every source key: each key's folder, or the key itself at the bucket's top. */
function sourcePrefixes(keys: string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const slash = k.lastIndexOf("/");
    out.add(slash >= 0 ? k.slice(0, slash + 1) : k);
  }
  return [...out].sort();
}

async function listByName(b2: B2Api, bucketId: string, prefixes: string[]): Promise<Map<string, B2FileDetail>> {
  const out = new Map<string, B2FileDetail>();
  for (const p of prefixes) for (const f of await b2.listFileDetails(bucketId, p)) out.set(f.fileName, f);
  return out;
}

/** Every version under a prefix, by name, each name's newest first. */
async function versionsByName(b2: B2Api, bucketId: string, prefix: string): Promise<Map<string, B2FileVersion[]>> {
  const out = new Map<string, B2FileVersion[]>();
  for (const v of await b2.listFileVersions(bucketId, prefix)) out.set(v.fileName, [...(out.get(v.fileName) ?? []), v]);
  return out;
}

/** Every version at exactly one key, newest first. */
async function exactVersions(b2: B2Api, bucketId: string, key: string): Promise<B2FileVersion[]> {
  return (await b2.listFileVersions(bucketId, key)).filter((v) => v.fileName === key);
}

/** Runs `work` over `items`, at most `limit` at once, starting none once `stopped()` holds. */
async function inPool<T>(items: T[], limit: number, stopped: () => boolean, work: (item: T) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !stopped()) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

function line(r: ReportEntry): string {
  const what = `${r.sourceKey} -> ${r.destinationObject}`;
  const src = r.source ? `${r.source.bytes} bytes, SHA1 ${r.source.sha1 ?? "unknown"}` : "no source";
  const dst = r.destination ? `; destination ${r.destination.bytes} bytes, SHA1 ${r.destination.sha1 ?? "unknown"}` : "";
  return `  [${r.outcome}] ${what} (${src}${dst})${r.reason ? `: ${r.reason}` : ""}`;
}

function totalsOf(entries: ReportEntry[]): RenameCopyReport["totals"] {
  const zero = () => ({ objects: 0, bytes: 0 });
  const t: RenameCopyReport["totals"] = {
    copy: zero(),
    exists: zero(),
    conflict: zero(),
    missing: zero(),
    copied: zero(),
    failed: zero(),
    "not-started": zero(),
  };
  for (const e of entries) {
    t[e.outcome].objects++;
    t[e.outcome].bytes += e.bytes;
    if (e.applied) {
      t[e.applied].objects++;
      t[e.applied].bytes += e.bytes;
    }
  }
  return t;
}

/**
 * Copies one volume's pre-contract captures into the masters bucket
 * under contract names, or in a dry run says what it would do. Writes
 * the report on every run that gets as far as the listing; stops after
 * writing it when `--apply` meets a conflict or missing entry, or a copy
 * fails its check. Returns the report.
 */
export async function copyRenamedCaptures(
  map: RenameMap,
  options: RenameCopyOptions,
  providers: RenameCopyProviders,
  log: Log,
): Promise<RenameCopyReport> {
  const { tenant, federation } = await resolveTenantStorage(options.slug, providers.d1);
  checkRenameMap(map, tenant.slug);
  if (map.destination.bucket !== federation.pipeline_masters_bucket) {
    throw new RegistrationStop(
      `The rename map is refused whole: destination.bucket ${map.destination.bucket} is not the federation ` +
        `${federation.slug}'s masters bucket ${federation.pipeline_masters_bucket}`,
    );
  }
  const b2 = providers.b2;
  if (!b2) throw new RegistrationStop("The command needs the operator's B2 credentials, to read both buckets");

  const root = map.destination.root;
  const { stem } = map.volume;
  log(`Tenant ${tenant.slug} (${tenant.id}), federation ${federation.slug}${options.apply ? "" : ", dry run"}`);
  log(
    `Rename map ${map.id}: volume ${stem}, ${map.entries.length} entries, ` +
      `${map.source.bucket} -> ${map.destination.bucket}/${root}${stem}/`,
  );
  log("");
  log("Buckets");
  const sourceId = await findSourceBucket(b2, map.source.bucket, log);
  const destId = await findRecordBucket(b2, map.destination.bucket, "masters bucket", log);

  const sources = await listByName(b2, sourceId, sourcePrefixes(map.entries.map((e) => e.sourceKey)));
  const destinations = await versionsByName(b2, destId, `${root}${stem}/`);

  const rows: Array<{ entry: ReportEntry; expectedSha1: string | null; src: B2FileDetail | undefined }> = [];
  for (const e of map.entries) {
    const destinationObject = `${root}${e.destinationKey}`;
    const src = sources.get(e.sourceKey);
    const c = classifyEntry(e, src, destinations.get(destinationObject) ?? []);
    rows.push({
      entry: {
        ...e,
        destinationObject,
        outcome: c.outcome,
        reason: c.reason,
        source: c.source,
        destination: c.destination,
      },
      expectedSha1: c.expectedSha1,
      src,
    });
  }

  log("");
  log("Entries");
  for (const r of rows) log(line(r.entry));

  const report: RenameCopyReport = {
    mapId: map.id,
    tenant: tenant.slug,
    volume: map.volume,
    sourceBucket: map.source.bucket,
    destinationBucket: map.destination.bucket,
    applied: false,
    totals: totalsOf([]),
    entries: rows.map((r) => r.entry),
  };
  const finish = () => {
    report.totals = totalsOf(report.entries);
    providers.writeFile(reportPath(map.id), JSON.stringify(report, null, 2) + "\n");
    log("");
    log("Totals");
    for (const [k, v] of Object.entries(report.totals)) {
      if (v.objects > 0) log(`  ${k}: ${v.objects} objects, ${v.bytes} bytes`);
    }
    log(`  map: ${report.entries.length} objects, ${report.entries.reduce((n, e) => n + e.bytes, 0)} bytes`);
    log("");
    log(`Report: ${reportPath(map.id)}`);
  };

  const blocking = rows.filter((r) => r.entry.outcome === "conflict" || r.entry.outcome === "missing");
  if (!options.apply) {
    finish();
    return report;
  }
  if (blocking.length > 0) {
    finish();
    throw new RegistrationStop(
      `${blocking.length} entr${blocking.length === 1 ? "y is" : "ies are"} in conflict or missing; nothing was copied`,
    );
  }

  report.applied = true;
  const toCopy = rows.filter((r) => r.entry.outcome === "copy");
  for (const r of toCopy) r.entry.applied = "not-started";
  let stopped = false;
  log("");
  log("Copies");
  await inPool(toCopy, COPY_CONCURRENCY, () => stopped, async (r) => {
    const e = r.entry;
    const fail = (why: string) => {
      e.applied = "failed";
      e.appliedReason = why;
      stopped = true;
      log(`  [failed] ${e.destinationObject}: ${why}`);
    };
    try {
      const before = await exactVersions(b2, destId, e.destinationObject);
      if (before.length > 0) {
        e.destination = seen(visibleVersion(before));
        return fail("a file appeared at the destination after the listing; it is left as it is");
      }
      // Another copy may have failed while this lookup was pending.
      if (stopped) return;
      const { fileId } = await b2.copyFile(r.src!.fileId, e.destinationObject, destId);
      const versions = await exactVersions(b2, destId, e.destinationObject);
      const after = versions.find((v) => v.fileId === fileId);
      e.destination = seen(after ?? visibleVersion(versions));
      if (versions.length === 0) return fail("the copy is not at the destination");
      if (versions.length !== 1 || !after) {
        return fail("another version is at the destination besides this copy; nothing was deleted");
      }
      if (after.contentLength !== r.src!.contentLength) {
        return fail(`the copy holds ${after.contentLength} bytes, the source ${r.src!.contentLength}`);
      }
      if (r.expectedSha1) {
        if (after.sha1 !== r.expectedSha1) {
          return fail(`the copy's SHA1 is ${after.sha1 ?? "unknown"}, the source's ${r.expectedSha1}`);
        }
        e.check = "sha1-and-size";
      } else {
        e.check = "size-only";
      }
      e.applied = "copied";
      e.appliedReason = null;
      log(`  [copied] ${e.destinationObject} (${after.contentLength} bytes, checked by ${e.check})`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

  finish();
  const failed = toCopy.filter((r) => r.entry.applied === "failed").length;
  if (failed > 0) {
    throw new RegistrationStop(`${failed} cop${failed === 1 ? "y" : "ies"} failed; see the report. Nothing was deleted`);
  }
  return report;
}

async function findSourceBucket(b2: B2Api, name: string, log: Log): Promise<string> {
  const bucket = await b2.findBucket(name);
  if (!bucket) throw new RegistrationStop(`The source bucket ${name} is not in the B2 account`);
  log(`  [exists] B2 source bucket ${name}`);
  return bucket.bucketId;
}

// @version v0.8.0
