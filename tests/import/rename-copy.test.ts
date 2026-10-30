/**
 * Tests — copying pre-contract captures under contract names
 *
 * This suite pins the command that copies a volume's pre-contract
 * capture images, server side within B2, into the federation's masters
 * bucket under contract names, from a rename map Captua writes. The maps
 * are built here; the tenant, the federation's record and both buckets
 * come from the in-memory providers of the storage commands
 * (`tests/import/tenant-storage-fakes.ts`). Nothing here reaches D1, B2
 * or the network.
 *
 *   - the map: a valid one parses; a wrong envelope, a bad field, a
 *     destination root other than `{slug}/`, a destination bucket other
 *     than the federation's masters bucket, a stem that is not the
 *     reference code, an ordinal above `counterAfter`, a destination key
 *     not of the contract's form, a repeated source or destination key,
 *     a repeated ordinal, camera and kind, and a file over 5 GB refuse it
 *     whole;
 *   - the dry run: each entry is `[copy]`, `[exists]`, `[conflict]` or
 *     `[missing]`, nothing is copied, and the report carries every entry
 *     with the map's fields unchanged; a hidden file or an earlier
 *     version at the destination is a conflict;
 *   - `--apply`: copies only `[copy]` entries and checks each copy; any
 *     conflict or missing entry stops it before a copy; a copy whose
 *     check fails stops it and is reported, as does a second version at
 *     the key from an overlapping run; once a copy fails, an entry whose
 *     lookup was still pending is not copied; a rerun after a partial
 *     run skips what is done;
 *   - the B2 client: the details listing reads ids and SHA1s, including
 *     `large_file_sha1` for a file uploaded in parts, the versions
 *     listing pages by name and id and keeps hide markers, and the copy
 *     call sends `b2_copy_file` with `metadataDirective: "COPY"`.
 *
 * Every value here is a test value: no real tenant, bucket, key or file.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { b2Client, sha1Of, type DestinationValues } from "../../scripts/lib/tenant-storage";
import {
  checkRenameMap,
  copyRenamedCaptures,
  parseRenameMap,
  reportPath,
  type RenameCopyProviders,
  type RenameCopyReport,
  type RenameMap,
} from "../../scripts/lib/rename-copy";
import { parseArgs } from "../../scripts/commands/copy-renamed-captures";
import { fakeWorld, FAKE_B2_DOWNLOAD, FAKE_B2_S3, FAKE_R2_S3, type FakeB2File, type FakeOptions } from "./tenant-storage-fakes";

const SLUG = "sbmal";
const STEM = "co-test-vol-001";
const MAP_ID = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SOURCE_BUCKET = "acme-old-captures";
const SOURCE_ID = "bucket-source";
const MASTERS_ID = "bucket-masters";

const RECORD: DestinationValues = {
  pipeline_delivery_endpoint: FAKE_B2_S3,
  pipeline_tiles_bucket: "acme-iiif-tiles",
  pipeline_masters_bucket: "acme-masters",
  pipeline_image_base_url: "https://iiif.acme.example.test",
  manifest_endpoint: FAKE_R2_S3,
  manifest_bucket: "acme-manifests",
  manifest_base_url: "https://manifests.acme.example.test",
  storage_secret_prefix: "FEDERATION_ACME",
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface EntryOptions {
  ordinal: number;
  camera: number;
  kind?: "capture" | "preview";
}

function entry({ ordinal, camera, kind = "capture" }: EntryOptions) {
  const nnnn = String(ordinal).padStart(4, "0");
  const old = `old/${STEM}/IMG_${nnnn}_${camera}${kind === "preview" ? "_preview.jpg" : ".CR2"}`;
  return {
    captureId: uuid(ordinal * 10 + camera),
    imageId: ordinal * 10 + camera,
    recordId: ordinal,
    capturedAt: "2026-05-01T10:00:00Z",
    ordinal,
    camera,
    role: camera === 0 ? "left" : "right",
    kind,
    originalFilename: old.split("/").pop(),
    superseded: false,
    sourceKey: old,
    destinationKey:
      kind === "preview"
        ? `${STEM}/previews/${STEM}-img_${nnnn}_c${camera}_preview.jpg`
        : `${STEM}/captures/${STEM}-img_${nnnn}_c${camera}.cr2`,
    sha256: "a".repeat(64),
    sha1: sha1(old),
    bytes: old.length,
  };
}

function rawMap(entries = [entry({ ordinal: 1, camera: 0 }), entry({ ordinal: 1, camera: 1 }), entry({ ordinal: 2, camera: 0 })]) {
  return {
    contract: "fisqua-captua-exchange",
    version: "1.1",
    kind: "rename-map",
    id: MAP_ID,
    generatedAt: "2026-10-23T12:00:00Z",
    generatedBy: { system: "captua", instance: "rig-test", systemVersion: "0.1.0" },
    inReplyTo: null,
    volume: { externalId: STEM, stem: STEM, captuaCollectionId: 7, counterAfter: 2 },
    source: { bucket: SOURCE_BUCKET },
    destination: { bucket: "acme-masters", root: `${SLUG}/` },
    entries,
  } as Record<string, any>;
}

/** The source file for an entry, as the test map describes it. */
function sourceFile(e: ReturnType<typeof entry>, over: Partial<FakeB2File> = {}): FakeB2File {
  return { fileName: e.sourceKey, contentLength: e.bytes, contentSha1: e.sha1!, ...over };
}

function setup(map: Record<string, any>, fakeOptions: FakeOptions = {}) {
  const { world, providers } = fakeWorld(fakeOptions);
  Object.assign(world.d1.federations[0], RECORD);
  world.b2.buckets.set("acme-masters", { bucketId: MASTERS_ID, bucketName: "acme-masters", bucketType: "allPrivate", corsRules: [] });
  world.b2.buckets.set(SOURCE_BUCKET, { bucketId: SOURCE_ID, bucketName: SOURCE_BUCKET, bucketType: "allPrivate", corsRules: [] });
  world.b2.files.set(SOURCE_ID, map.entries.map((e: ReturnType<typeof entry>) => sourceFile(e)));
  world.b2.files.set(MASTERS_ID, []);
  const written = new Map<string, string>();
  const rc: RenameCopyProviders = {
    d1: providers.d1,
    b2: providers.b2,
    writeFile: (p, t) => written.set(p, t),
  };
  return { world, rc, written };
}

async function run(map: Record<string, any>, rc: RenameCopyProviders, apply: boolean, lines: string[] = []) {
  return copyRenamedCaptures(parseRenameMap(map), { slug: SLUG, apply }, rc, (l) => lines.push(l));
}

async function refusal(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("the rename map", () => {
  it("parses a valid map and keeps Captua's fields as they are", () => {
    const m = parseRenameMap(rawMap());
    expect(m.entries).toHaveLength(3);
    expect(m.entries[0]).toMatchObject({ imageId: 10, recordId: 1, originalFilename: "IMG_0001_0.CR2", superseded: false });
    expect(() => checkRenameMap(m, SLUG)).not.toThrow();
  });

  it("accepts null imageId, recordId, superseded, sha1 and sha256, and ignores unknown fields", () => {
    const raw = rawMap();
    Object.assign(raw.entries[0], { imageId: null, recordId: null, superseded: null, sha1: null, sha256: null, extra: 1 });
    raw.extra = "ignored";
    const m = parseRenameMap(raw);
    expect(m.entries[0].imageId).toBeNull();
    expect("extra" in m).toBe(false);
  });

  it.each([
    ["contract", (m: any) => (m.contract = "other"), "contract"],
    ["version", (m: any) => (m.version = "1.0"), "version"],
    ["kind", (m: any) => (m.kind = "capture-manifest"), "kind"],
    ["id", (m: any) => (m.id = "not-a-uuid"), "id"],
    ["generatedBy.system", (m: any) => (m.generatedBy.system = "fisqua"), "generatedBy.system"],
    ["counterAfter", (m: any) => delete m.volume.counterAfter, "volume.counterAfter"],
    ["ordinal", (m: any) => (m.entries[0].ordinal = 0), "entries.0.ordinal"],
    ["camera", (m: any) => (m.entries[0].camera = -1), "entries.0.camera"],
    ["role", (m: any) => (m.entries[0].role = "overview"), "entries.0.role"],
    ["kind of entry", (m: any) => (m.entries[0].kind = "thumbnail"), "entries.0.kind"],
    ["sha1", (m: any) => (m.entries[0].sha1 = "abc"), "entries.0.sha1"],
    ["sha256", (m: any) => (m.entries[0].sha256 = "abc"), "entries.0.sha256"],
    ["imageId", (m: any) => (m.entries[0].imageId = "1"), "entries.0.imageId"],
    ["recordId", (m: any) => (m.entries[0].recordId = 1.5), "entries.0.recordId"],
    ["originalFilename", (m: any) => (m.entries[0].originalFilename = ""), "entries.0.originalFilename"],
    ["superseded", (m: any) => (m.entries[0].superseded = "no"), "entries.0.superseded"],
    ["bytes", (m: any) => (m.entries[0].bytes = -1), "entries.0.bytes"],
  ])("refuses a wrong %s whole", (_n, change, path) => {
    const raw = rawMap();
    change(raw);
    expect(() => parseRenameMap(raw)).toThrow(/refused whole/);
    expect(() => parseRenameMap(raw)).toThrow(new RegExp(path.replace(/\./g, "\\.")));
  });

  const ruleCases: Array<[string, (m: any) => void, RegExp]> = [
    ["a destination root other than {slug}/", (m) => (m.destination.root = "other/"), /destination\.root other\/ is not the tenant's prefix sbmal\//],
    ["a stem that is not the reference code", (m) => (m.volume.externalId = "co-test-vol-002"), /volume\.stem co-test-vol-001 is not volume\.externalId co-test-vol-002/],
    ["an ordinal above counterAfter", (m) => (m.volume.counterAfter = 1), /highest ordinal, 2, is above volume\.counterAfter 1/],
    ["an unpadded ordinal", (m) => (m.entries[2].destinationKey = `${STEM}/captures/${STEM}-img_2_c0.cr2`), /entries\.2: destinationKey .* is not/],
    ["a key whose ordinal is not the entry's", (m) => (m.entries[2].destinationKey = `${STEM}/captures/${STEM}-img_0003_c0.cr2`), /entries\.2: destinationKey/],
    ["a key whose camera is not the entry's", (m) => (m.entries[1].destinationKey = `${STEM}/captures/${STEM}-img_0001_c0.cr2`), /entries\.1: destinationKey/],
    ["a capture under previews/", (m) => (m.entries[0].destinationKey = `${STEM}/previews/${STEM}-img_0001_c0_preview.jpg`), /entries\.0: destinationKey/],
    ["a preview that is not _preview.jpg", (m) => Object.assign(m.entries[0], { kind: "preview", destinationKey: `${STEM}/previews/${STEM}-img_0001_c0.jpg` }), /entries\.0: destinationKey .* is not co-test-vol-001\/previews\/co-test-vol-001-img_0001_c0_preview\.jpg/],
    ["a key under another stem", (m) => (m.entries[0].destinationKey = `other/captures/${STEM}-img_0001_c0.cr2`), /entries\.0: destinationKey/],
    ["a repeated source key", (m) => (m.entries[1].sourceKey = m.entries[0].sourceKey), /entries\.1: sourceKey .* appears twice/],
    ["a repeated destination key", (m) => m.entries.push({ ...m.entries[0], sourceKey: "old/elsewhere.CR2" }), /destinationKey .* appears twice/],
    ["a repeated ordinal, camera and kind", (m) => m.entries.push({ ...m.entries[0], sourceKey: "old/elsewhere.CR2", destinationKey: `${STEM}/captures/${STEM}-img_0001_c0.jpg` }), /ordinal 1, camera 0 and kind capture appear twice/],
    ["a file over 5 GB", (m) => (m.entries[0].bytes = 5_000_000_001), /over the 5 GB b2_copy_file copies in one call/],
  ];

  it.each(ruleCases)("refuses %s whole, before reading B2", async (_n, change, message) => {
    const raw = rawMap();
    change(raw);
    const { world, rc } = setup(rawMap());
    const msg = await refusal(() => run(raw, rc, false));
    expect(msg).toMatch(/refused whole/);
    expect(msg).toMatch(message);
    expect(world.calls.filter((c) => c.startsWith("b2."))).toEqual([]);
  });

  it("accepts a preview and a capture of one ordinal and camera, and a five-digit ordinal", () => {
    const raw = rawMap([entry({ ordinal: 1, camera: 0 }), entry({ ordinal: 1, camera: 0, kind: "preview" }), entry({ ordinal: 12345, camera: 1 })]);
    raw.volume.counterAfter = 12345;
    expect(() => checkRenameMap(parseRenameMap(raw), SLUG)).not.toThrow();
  });

  it("refuses a destination bucket other than the federation's masters bucket, before reading B2", async () => {
    const raw = rawMap();
    raw.destination.bucket = "acme-other";
    const { world, rc } = setup(raw);
    expect(await refusal(() => run(raw, rc, false))).toMatch(
      /destination\.bucket acme-other is not the federation acme's masters bucket acme-masters/,
    );
    expect(world.calls.filter((c) => c.startsWith("b2."))).toEqual([]);
  });

  it("stops for a tenant whose federation has no complete record", async () => {
    const { world, rc } = setup(rawMap());
    world.d1.federations[0].pipeline_masters_bucket = null;
    expect(await refusal(() => run(rawMap(), rc, false))).toMatch(/no complete storage record/);
  });
});

describe("the dry run", () => {
  it("classifies copy, exists, conflict and missing, copies nothing, and writes the report", async () => {
    const entries = [
      entry({ ordinal: 1, camera: 0 }), // copy
      entry({ ordinal: 1, camera: 1 }), // exists
      entry({ ordinal: 2, camera: 0 }), // conflict
      entry({ ordinal: 2, camera: 1 }), // missing: absent
      entry({ ordinal: 3, camera: 0 }), // missing: bytes differ
      entry({ ordinal: 3, camera: 1 }), // missing: sha1 differs
    ];
    const raw = rawMap(entries);
    raw.volume.counterAfter = 3;
    const { world, rc, written } = setup(raw);
    world.b2.files.set(SOURCE_ID, [
      sourceFile(entries[0]),
      sourceFile(entries[1]),
      sourceFile(entries[2]),
      sourceFile(entries[4], { contentLength: entries[4].bytes + 1 }),
      sourceFile(entries[5], { contentSha1: sha1("something else") }),
    ]);
    world.b2.files.set(MASTERS_ID, [
      { fileName: `${SLUG}/${entries[1].destinationKey}`, contentLength: entries[1].bytes, contentSha1: entries[1].sha1! },
      { fileName: `${SLUG}/${entries[2].destinationKey}`, contentLength: entries[2].bytes, contentSha1: sha1("other") },
    ]);
    const lines: string[] = [];
    const report = await run(raw, rc, false, lines);
    expect(report.entries.map((e) => e.outcome)).toEqual(["copy", "exists", "conflict", "missing", "missing", "missing"]);
    expect(report.entries[2].reason).toContain(`the destination's SHA1 is ${sha1("other")}, the source's ${entries[2].sha1}`);
    expect(report.entries[2].destination).toEqual({ bytes: entries[2].bytes, sha1: sha1("other") });
    expect(report.entries[3].reason).toBe("the source is not in the source bucket");
    expect(report.entries[4].reason).toContain("bytes, the map says");
    expect(report.entries[5].reason).toContain("the source's SHA1 is");
    expect(world.calls.some((c) => c.startsWith("b2.copyFile"))).toBe(false);
    expect(report.applied).toBe(false);
    expect(report.totals.copy).toEqual({ objects: 1, bytes: entries[0].bytes });
    expect(report.totals.missing.objects).toBe(3);

    const text = lines.join("\n");
    expect(text).toContain(`[copy] ${entries[0].sourceKey} -> ${SLUG}/${entries[0].destinationKey}`);
    expect(text).toContain("[exists]");
    expect(text).toContain("[conflict]");
    expect(text).toContain("[missing]");
    expect(text).toMatch(/copy: 1 objects, \d+ bytes/);
    expect(text).toMatch(/map: 6 objects, \d+ bytes/);

    const saved = JSON.parse(written.get(reportPath(MAP_ID))!) as RenameCopyReport;
    expect(reportPath(MAP_ID)).toBe(`.import/rename-copy_${MAP_ID}.json`);
    expect(saved.entries).toHaveLength(6);
    expect(saved.entries[0]).toMatchObject({
      captureId: entries[0].captureId,
      imageId: entries[0].imageId,
      recordId: entries[0].recordId,
      originalFilename: entries[0].originalFilename,
      superseded: false,
      capturedAt: entries[0].capturedAt,
      outcome: "copy",
    });
  });

  it("lists the source by folder and the destination under the volume's prefix only", async () => {
    const raw = rawMap();
    const { world, rc } = setup(raw);
    await run(raw, rc, false);
    expect(world.calls.filter((c) => c.startsWith("b2.listFile"))).toEqual([
      `b2.listFileDetails:old/${STEM}/`,
      `b2.listFileVersions:${SLUG}/${STEM}/`,
    ]);
  });

  it("treats a hidden file, an earlier version or an unfinished upload at the destination as a conflict", async () => {
    const entries = [
      entry({ ordinal: 1, camera: 0 }),
      entry({ ordinal: 1, camera: 1 }),
      entry({ ordinal: 2, camera: 0 }),
      entry({ ordinal: 2, camera: 1 }),
    ];
    const raw = rawMap(entries);
    const { world, rc } = setup(raw);
    const at = (e: ReturnType<typeof entry>) => `${SLUG}/${e.destinationKey}`;
    const same = (e: ReturnType<typeof entry>, fileId: string): FakeB2File => ({
      fileName: at(e),
      fileId,
      contentLength: e.bytes,
      contentSha1: e.sha1!,
    });
    world.b2.files.set(MASTERS_ID, [
      // A copy of the source, hidden since.
      same(entries[0], "v1"),
      { fileName: at(entries[0]), fileId: "h1", contentLength: 0, action: "hide" },
      // A hide marker alone.
      { fileName: at(entries[1]), fileId: "h2", contentLength: 0, action: "hide" },
      // The source's bytes, over an earlier version.
      { fileName: at(entries[2]), fileId: "v3", contentLength: 1, contentSha1: sha1("earlier") },
      same(entries[2], "v4"),
      // A large file whose upload was started and not finished.
      { fileName: at(entries[3]), fileId: "s5", contentLength: 0, action: "start" },
    ]);
    expect(await rc.b2!.listFileDetails(MASTERS_ID, `${SLUG}/`)).toHaveLength(1);
    const report = await run(raw, rc, false);
    expect(report.entries.map((e) => e.outcome)).toEqual(["conflict", "conflict", "conflict", "conflict"]);
    for (const e of report.entries) {
      expect(e.reason).toBe("a hidden file or an earlier version is at the destination; it is left as it is");
    }
    expect(report.entries[0].destination).toBeNull();
    expect(report.entries[2].destination).toEqual({ bytes: entries[2].bytes, sha1: entries[2].sha1 });

    expect(await refusal(() => run(raw, rc, true))).toMatch(/4 entries are in conflict or missing; nothing was copied/);
    expect(world.calls.some((c) => c.startsWith("b2.copyFile"))).toBe(false);
    expect(world.b2.files.get(MASTERS_ID)).toHaveLength(6);
  });

  it("uses large_file_sha1 for a source uploaded in parts, and reports a source whose SHA1 is unknown", async () => {
    const entries = [entry({ ordinal: 1, camera: 0 }), entry({ ordinal: 1, camera: 1 })];
    entries[1].sha1 = null as any;
    const raw = rawMap(entries);
    raw.volume.counterAfter = 1;
    const { world, rc } = setup(raw);
    world.b2.files.set(SOURCE_ID, [
      sourceFile(entries[0], { contentSha1: "none", fileInfo: { large_file_sha1: entries[0].sha1! } }),
      sourceFile(entries[1], { contentSha1: "none" }),
    ]);
    const report = await run(raw, rc, false);
    expect(report.entries[0]).toMatchObject({ outcome: "copy", source: { sha1: entries[0].sha1 } });
    expect(report.entries[1]).toMatchObject({ outcome: "copy", reason: "the source's SHA1 is unknown", source: { sha1: null } });
  });

  it("needs B2 credentials", async () => {
    const raw = rawMap();
    const { rc } = setup(raw);
    expect(await refusal(() => run(raw, { ...rc, b2: null }, false))).toMatch(/needs the operator's B2 credentials/);
  });
});

describe("--apply", () => {
  it("copies only the [copy] entries, checks each, and writes the report", async () => {
    const raw = rawMap();
    const { world, rc, written } = setup(raw);
    world.b2.files.set(MASTERS_ID, [
      { fileName: `${SLUG}/${raw.entries[1].destinationKey}`, contentLength: raw.entries[1].bytes, contentSha1: raw.entries[1].sha1 },
    ]);
    const report = await run(raw, rc, true);
    expect(world.calls.filter((c) => c.startsWith("b2.copyFile")).sort()).toEqual(
      [`b2.copyFile:${SLUG}/${raw.entries[0].destinationKey}`, `b2.copyFile:${SLUG}/${raw.entries[2].destinationKey}`].sort(),
    );
    expect(report.applied).toBe(true);
    expect(report.entries.map((e) => [e.outcome, e.applied])).toEqual([
      ["copy", "copied"],
      ["exists", undefined],
      ["copy", "copied"],
    ]);
    expect(report.entries[0].check).toBe("sha1-and-size");
    const masters = world.b2.files.get(MASTERS_ID)!;
    expect(masters).toHaveLength(3);
    expect(masters.find((f) => f.fileName === `${SLUG}/${raw.entries[0].destinationKey}`)?.contentSha1).toBe(raw.entries[0].sha1);
    expect(world.b2.files.get(SOURCE_ID)).toHaveLength(3);
    expect(JSON.parse(written.get(reportPath(MAP_ID))!).totals.copied).toEqual({
      objects: 2,
      bytes: raw.entries[0].bytes + raw.entries[2].bytes,
    });
  });

  it("is refused before any copy when an entry is in conflict or missing", async () => {
    for (const kind of ["conflict", "missing"] as const) {
      const raw = rawMap();
      const { world, rc, written } = setup(raw);
      if (kind === "conflict") {
        world.b2.files.set(MASTERS_ID, [
          { fileName: `${SLUG}/${raw.entries[2].destinationKey}`, contentLength: raw.entries[2].bytes, contentSha1: sha1("other") },
        ]);
      } else {
        world.b2.files.set(SOURCE_ID, world.b2.files.get(SOURCE_ID)!.slice(0, 2));
      }
      expect(await refusal(() => run(raw, rc, true))).toMatch(/1 entry is in conflict or missing; nothing was copied/);
      expect(world.calls.some((c) => c.startsWith("b2.copyFile"))).toBe(false);
      const saved = JSON.parse(written.get(reportPath(MAP_ID))!) as RenameCopyReport;
      expect(saved.applied).toBe(false);
      expect(saved.entries.map((e) => e.outcome)).toContain(kind);
    }
  });

  it("stops and reports when a copy does not match its source, and deletes nothing", async () => {
    const raw = rawMap([entry({ ordinal: 1, camera: 0 })]);
    raw.volume.counterAfter = 1;
    const { world, rc, written } = setup(raw, { onCopy: (f) => ({ ...f, contentSha1: sha1("corrupt") }) });
    expect(await refusal(() => run(raw, rc, true))).toMatch(/1 copy failed; see the report\. Nothing was deleted/);
    const saved = JSON.parse(written.get(reportPath(MAP_ID))!) as RenameCopyReport;
    expect(saved.entries[0]).toMatchObject({ applied: "failed", destination: { sha1: sha1("corrupt") } });
    expect(saved.entries[0].appliedReason).toContain(`the copy's SHA1 is ${sha1("corrupt")}`);
    expect(world.b2.files.get(MASTERS_ID)).toHaveLength(1);
    expect(world.b2.files.get(SOURCE_ID)).toHaveLength(1);
  });

  it("stops new copies once one fails; the rest are reported not started", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ ordinal: i + 1, camera: 0 }));
    const raw = rawMap(entries);
    raw.volume.counterAfter = 10;
    const failing = `b2.copyFile:${SLUG}/${entries[0].destinationKey}`;
    const { world, rc } = setup(raw, { failOn: (c) => c === failing });
    expect(await refusal(() => run(raw, rc, true))).toMatch(/cop(y|ies) failed/);
    const copies = world.calls.filter((c) => c.startsWith("b2.copyFile"));
    expect(copies.length).toBeLessThanOrEqual(4);
  });

  it("leaves alone a file that appears at the destination after the listing", async () => {
    const raw = rawMap([entry({ ordinal: 1, camera: 0 })]);
    raw.volume.counterAfter = 1;
    const dest = `${SLUG}/${raw.entries[0].destinationKey}`;
    for (const late of [
      { fileName: dest, contentLength: 1, contentSha1: sha1("late") },
      { fileName: dest, contentLength: 0, action: "hide" as const },
    ]) {
      const { world, rc } = setup(raw);
      const list = rc.b2!.listFileVersions;
      let n = 0;
      rc.b2 = {
        ...rc.b2!,
        listFileVersions: async (bucket, prefix) => {
          if (prefix === dest && n++ === 0) world.b2.files.get(MASTERS_ID)!.push(late);
          return list(bucket, prefix);
        },
      };
      expect(await refusal(() => run(raw, rc, true))).toMatch(/1 copy failed/);
      expect(world.calls.some((c) => c.startsWith("b2.copyFile"))).toBe(false);
      expect(world.b2.files.get(MASTERS_ID)).toEqual([late]);
    }
  });

  it("does not copy an entry whose lookup was pending when another copy failed", async () => {
    const raw = rawMap([entry({ ordinal: 1, camera: 0 }), entry({ ordinal: 2, camera: 0 })]);
    const [a, b] = raw.entries.map((e: ReturnType<typeof entry>) => `${SLUG}/${e.destinationKey}`);
    const { world, rc, written } = setup(raw, { failOn: (c) => c === `b2.copyFile:${a}` });
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const list = rc.b2!.listFileVersions;
    const copy = rc.b2!.copyFile;
    rc.b2 = {
      ...rc.b2!,
      listFileVersions: async (bucket, prefix) => {
        if (prefix === b) await pending;
        return list(bucket, prefix);
      },
      copyFile: async (...args) => {
        // B's lookup is released only once A's failure has been handled.
        if (args[1] === a) setTimeout(release, 0);
        return copy(...args);
      },
    };
    expect(await refusal(() => run(raw, rc, true))).toMatch(/1 copy failed/);
    expect(world.calls).toContain(`b2.listFileVersions:${b}`);
    expect(world.calls.filter((c) => c.startsWith("b2.copyFile"))).toEqual([`b2.copyFile:${a}`]);
    const saved = JSON.parse(written.get(reportPath(MAP_ID))!) as RenameCopyReport;
    expect(saved.entries.map((e) => e.applied)).toEqual(["failed", "not-started"]);
    expect(world.b2.files.get(MASTERS_ID)).toEqual([]);
  });

  it("reports a second version at the key from an overlapping run, and deletes nothing", async () => {
    const raw = rawMap([entry({ ordinal: 1, camera: 0 })]);
    raw.volume.counterAfter = 1;
    const { world, rc, written } = setup(raw, {
      afterCopy: (made, files) => files.push({ ...made, fileId: "FAKE-OTHER-RUN" }),
    });
    expect(await refusal(() => run(raw, rc, true))).toMatch(/1 copy failed; see the report\. Nothing was deleted/);
    const saved = JSON.parse(written.get(reportPath(MAP_ID))!) as RenameCopyReport;
    expect(saved.entries[0]).toMatchObject({
      applied: "failed",
      appliedReason: "another version is at the destination besides this copy; nothing was deleted",
    });
    expect(world.b2.files.get(MASTERS_ID)!.map((f) => f.fileId)).toEqual(["FAKECOPY1", "FAKE-OTHER-RUN"]);
  });

  it("keeps at most four copies in flight", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry({ ordinal: i + 1, camera: 0 }));
    const raw = rawMap(entries);
    raw.volume.counterAfter = 12;
    const { rc } = setup(raw);
    const copy = rc.b2!.copyFile;
    let inFlight = 0;
    let peak = 0;
    rc.b2 = {
      ...rc.b2!,
      copyFile: async (...args) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await copy(...args);
        } finally {
          inFlight--;
        }
      },
    };
    const report = await run(raw, rc, true);
    expect(report.totals.copied.objects).toBe(12);
    expect(peak).toBe(4);
  });

  it("finishes a partial run when run again, skipping what is done", async () => {
    const raw = rawMap();
    const { world, rc } = setup(raw, { failOn: (c) => c === `b2.copyFile:${SLUG}/${raw.entries[2].destinationKey}` });
    await refusal(() => run(raw, rc, true));
    const firstCopies = world.calls.filter((c) => c.startsWith("b2.copyFile")).length;
    expect(world.b2.files.get(MASTERS_ID)!.length).toBeLessThan(3);

    // The same world, with the failure gone.
    const again = setup(raw);
    again.world.b2.files.set(MASTERS_ID, world.b2.files.get(MASTERS_ID)!);
    const dry = await run(raw, again.rc, false);
    const done = dry.entries.filter((e) => e.outcome === "exists").length;
    expect(done).toBe(world.b2.files.get(MASTERS_ID)!.length);
    expect(done).toBeGreaterThan(0);
    const report = await run(raw, again.rc, true);
    expect(report.entries.filter((e) => e.outcome === "exists")).toHaveLength(done);
    expect(again.world.calls.filter((c) => c.startsWith("b2.copyFile"))).toHaveLength(3 - done);
    expect(again.world.b2.files.get(MASTERS_ID)).toHaveLength(3);
    expect(firstCopies).toBeGreaterThan(0);

    // A third run copies nothing.
    const third = await run(raw, again.rc, true);
    expect(third.entries.every((e) => e.outcome === "exists")).toBe(true);
    expect(again.world.calls.filter((c) => c.startsWith("b2.copyFile"))).toHaveLength(3 - done);
  });

  it("checks a copy by size alone when no SHA1 is known, and says so", async () => {
    const entries = [entry({ ordinal: 1, camera: 0 })];
    entries[0].sha1 = null as any;
    const raw = rawMap(entries);
    raw.volume.counterAfter = 1;
    const { world, rc } = setup(raw);
    world.b2.files.set(SOURCE_ID, [sourceFile(entries[0], { contentSha1: "none" })]);
    const report = await run(raw, rc, true);
    expect(report.entries[0]).toMatchObject({ applied: "copied", check: "size-only" });
  });

  it("never prints the B2 credentials' values", async () => {
    const raw = rawMap();
    const { rc } = setup(raw);
    const lines: string[] = [];
    await run(raw, rc, true, lines);
    expect(lines.join("\n")).not.toMatch(/FAKESECRET|FAKEKEYID/);
  });
});

describe("arguments", () => {
  it("reads --map, --tenant and --apply, and nothing else", () => {
    expect(parseArgs(["--map", "m.json", "--tenant", SLUG])).toEqual({ map: "m.json", tenant: SLUG, apply: false, sourceRecord: "production" });
    expect(parseArgs(["--map", "m.json", "--tenant", SLUG, "--source-record", "staging"]).sourceRecord).toBe("staging");
    expect(() => parseArgs(["--map", "m.json", "--tenant", SLUG, "--source-record", "local"])).toThrow(/production or staging/);
    expect(parseArgs(["--map", "m.json", "--tenant", SLUG, "--apply"]).apply).toBe(true);
    expect(() => parseArgs(["--tenant", SLUG])).toThrow(/--map is required/);
    expect(() => parseArgs(["--map", "m.json"])).toThrow(/--tenant is required/);
    expect(() => parseArgs(["--map", "m.json", "--tenant", SLUG, "--target", "production"])).toThrow(/Unknown argument/);
  });
});

describe("the B2 client", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  function recorder(handler: (url: string, body: any) => Response) {
    const seen: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      seen.push({ url, body });
      if (url.endsWith("b2_authorize_account")) {
        return ok({ accountId: "acct", apiUrl: "https://api000.example.test", s3ApiUrl: FAKE_B2_S3, downloadUrl: FAKE_B2_DOWNLOAD, authorizationToken: "tok" });
      }
      return handler(url, body);
    }) as typeof fetch;
    return { seen, fetchImpl };
  }

  it("lists names, sizes, ids and SHA1s page by page", async () => {
    const big = "b".repeat(40);
    const { seen, fetchImpl } = recorder((_url, body) =>
      body.startFileName
        ? ok({ files: [{ fileName: "p/c", fileId: "id-c", contentLength: 3, contentSha1: "none", action: "upload" }], nextFileName: null })
        : ok({
            files: [
              { fileName: "p/a", fileId: "id-a", contentLength: 1, contentSha1: "a".repeat(40), action: "upload" },
              { fileName: "p/b", fileId: "id-b", contentLength: 2, contentSha1: "none", fileInfo: { large_file_sha1: big }, action: "upload" },
              { fileName: "p/sub/", contentLength: 0, action: "folder" },
            ],
            nextFileName: "p/c",
          }),
    );
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.listFileDetails("bk", "p/")).toEqual([
      { fileName: "p/a", fileId: "id-a", contentLength: 1, sha1: "a".repeat(40) },
      { fileName: "p/b", fileId: "id-b", contentLength: 2, sha1: big },
      { fileName: "p/c", fileId: "id-c", contentLength: 3, sha1: null },
    ]);
    expect(seen.filter((r) => r.url.endsWith("b2_list_file_names")).map((r) => r.body.startFileName ?? null)).toEqual([null, "p/c"]);
  });

  it("lists every version, hide markers and unfinished large files included, paging by name and id", async () => {
    const h = "d".repeat(40);
    const { seen, fetchImpl } = recorder((_url, body) =>
      body.startFileName
        ? ok({ files: [{ fileName: "p/a", fileId: "id-a1", contentLength: 1, contentSha1: h, action: "upload" }], nextFileName: null, nextFileId: null })
        : ok({
            files: [
              { fileName: "p/a", fileId: "id-a3", contentLength: 0, contentSha1: "none", action: "hide" },
              { fileName: "p/a", fileId: "id-a2", contentLength: 2, contentSha1: h, action: "upload" },
              { fileName: "p/b", fileId: "id-b1", contentLength: 0, action: "start" },
            ],
            nextFileName: "p/a",
            nextFileId: "id-a1",
          }),
    );
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.listFileVersions("bk", "p/")).toEqual([
      { fileName: "p/a", fileId: "id-a3", action: "hide", contentLength: 0, sha1: null },
      { fileName: "p/a", fileId: "id-a2", action: "upload", contentLength: 2, sha1: h },
      { fileName: "p/b", fileId: "id-b1", action: "start", contentLength: 0, sha1: null },
      { fileName: "p/a", fileId: "id-a1", action: "upload", contentLength: 1, sha1: h },
    ]);
    const calls = seen.filter((r) => r.url.endsWith("b2_list_file_versions"));
    expect(calls.map((r) => [r.body.startFileName ?? null, r.body.startFileId ?? null])).toEqual([
      [null, null],
      ["p/a", "id-a1"],
    ]);
    expect(calls.every((r) => r.body.maxFileCount === 1000 && r.body.prefix === "p/")).toBe(true);
  });

  it("copies with b2_copy_file, metadata copied", async () => {
    const { seen, fetchImpl } = recorder(() => ok({ fileId: "new-id" }));
    const b2 = b2Client("operator-key-id", "operator-key", fetchImpl);
    expect(await b2.copyFile("src-id", "sbmal/x/captures/x-img_0001_c0.cr2", "bk-dest")).toEqual({ fileId: "new-id" });
    const call = seen.find((r) => r.url.endsWith("b2_copy_file"))!;
    expect(call.url).toBe("https://api000.example.test/b2api/v2/b2_copy_file");
    expect(call.body).toMatchObject({
      sourceFileId: "src-id",
      fileName: "sbmal/x/captures/x-img_0001_c0.cr2",
      destinationBucketId: "bk-dest",
      metadataDirective: "COPY",
    });
  });

  it("reads a SHA1 from contentSha1, an unverified mark, or large_file_sha1, else null", () => {
    const h = "c".repeat(40);
    expect(sha1Of({ contentSha1: h })).toBe(h);
    expect(sha1Of({ contentSha1: `unverified:${h}` })).toBe(h);
    expect(sha1Of({ contentSha1: "none", fileInfo: { large_file_sha1: h } })).toBe(h);
    expect(sha1Of({ contentSha1: "none" })).toBeNull();
    expect(sha1Of({})).toBeNull();
  });
});

// @version v0.8.0
