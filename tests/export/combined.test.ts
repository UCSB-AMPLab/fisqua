/**
 * Tests — combined
 *
 * This suite pins the descriptions index contract: `writeDescriptionsIndex`
 * takes a `tenant: ExportTenant` argument, and per-fonds entry keys and
 * the index file itself are slug-prefixed to match the per-fonds R2
 * layout that `exportFondsDescriptions` writes.
 *
 * The index lists every published fonds of the tenant that has a
 * per-fonds file. A publish of some fonds takes their entries and
 * counts from the run and keeps the others' from the stored index, so
 * the total is the sum of both. A fonds that is no longer published, or
 * whose per-fonds file is gone, leaves the index. When the stored index
 * is missing or cannot be parsed, a publish of some fonds throws
 * `DescriptionsIndexUnreadableError` and writes nothing. When the stored
 * index leaves out a published fonds whose file is in the bucket, it
 * throws `DescriptionsIndexMissingFondsError`, naming the fonds, and
 * writes nothing. A publish of every published fonds builds the index
 * without reading the stored one.
 *
 * @version v0.9.0
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  writeDescriptionsIndex,
  FondsBodyTooLargeError,
  DescriptionsIndexUnreadableError,
  DescriptionsIndexMissingFondsError,
  type DescriptionsIndex,
} from "../../app/lib/export/combined.server";
import { MemoryStorage } from "./memory-storage";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

const TEST_TENANT: ExportTenant = {
  id: "test-tenant-id",
  federationId: "b4462493-6170-44f8-ae07-24666606d1f1", // NEOGRANADINA_FEDERATION_ID
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

function mockStorage() {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    putObjectStream: vi.fn().mockResolvedValue(undefined),
    getObjectStream: vi.fn().mockResolvedValue(null),
    getObjectHead: vi.fn().mockResolvedValue(null),
  } as unknown as ExportStorage;
}

describe("writeDescriptionsIndex", () => {
  let storage: ExportStorage;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("writes descriptions-index.json with per-fonds entries and a total record count", async () => {
    const result = await writeDescriptionsIndex(
      storage,
      ["co-ahr-gob", "co-ahr-jud", "co-ahr-not"],
      {
        "co-ahr-gob": 45341,
        "co-ahr-jud": 5848,
        "co-ahr-not": 3181,
      },
      TEST_TENANT,
      ["co-ahr-gob", "co-ahr-jud", "co-ahr-not"]
    );

    expect(result).toEqual({ totalRecordCount: 54370, fondsCount: 3 });

    const call = (storage.putObject as any).mock.calls[0];
    expect(call[0]).toBe("neogranadina/descriptions-index.json");

    const parsed = JSON.parse(call[1]) as DescriptionsIndex;
    expect(parsed.version).toBe(1);
    expect(parsed.total_record_count).toBe(54370);
    expect(parsed.fonds).toHaveLength(3);
    expect(parsed.fonds[0]).toEqual({
      fonds_code: "co-ahr-gob",
      key: "neogranadina/descriptions-co-ahr-gob.json",
      record_count: 45341,
    });
    // generated_at is an ISO string
    expect(() => new Date(parsed.generated_at).toISOString()).not.toThrow();
  });

  it("defaults missing record counts to 0", async () => {
    const result = await writeDescriptionsIndex(
      storage,
      ["f1", "f2"],
      { f1: 100 }, // f2 not provided
      TEST_TENANT,
      ["f1", "f2"]
    );

    expect(result.totalRecordCount).toBe(100);
    const parsed = JSON.parse(
      (storage.putObject as any).mock.calls[0][1]
    ) as DescriptionsIndex;
    expect(parsed.fonds[1].record_count).toBe(0);
  });

  it("produces an empty index when no fonds are selected", async () => {
    const result = await writeDescriptionsIndex(storage, [], {}, TEST_TENANT, []);
    expect(result).toEqual({ totalRecordCount: 0, fondsCount: 0 });
    const parsed = JSON.parse(
      (storage.putObject as any).mock.calls[0][1]
    ) as DescriptionsIndex;
    expect(parsed.fonds).toEqual([]);
  });

  it("retains FondsBodyTooLargeError as a named export (reserved for future streaming impl)", () => {
    const err = new FondsBodyTooLargeError("co-ahr-gob", 999, 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("FondsBodyTooLargeError");
    expect(err.fondsCode).toBe("co-ahr-gob");
    expect(err.size).toBe(999);
    expect(err.limit).toBe(500);
  });
});

describe("writeDescriptionsIndex keeps the fonds a run did not select", () => {
  const INDEX_KEY = "neogranadina/descriptions-index.json";
  const fileKey = (code: string) => `neogranadina/descriptions-${code}.json`;
  const THREE = ["co-a", "co-b", "co-c"];

  /** A bucket holding the three fonds' files and the index a full publish wrote. */
  async function publishedThree(): Promise<MemoryStorage> {
    const mem = new MemoryStorage();
    for (const code of THREE) await mem.putObject(fileKey(code), "[]");
    await writeDescriptionsIndex(
      mem as unknown as ExportStorage,
      THREE,
      { "co-a": 10, "co-b": 20, "co-c": 30 },
      TEST_TENANT,
      THREE
    );
    return mem;
  }

  const storedIndex = (mem: MemoryStorage) =>
    JSON.parse(new TextDecoder().decode(mem.objects.get(INDEX_KEY)!)) as DescriptionsIndex;

  it("keeps the other two fonds with their stored counts on a publish of one of three", async () => {
    const mem = await publishedThree();
    const result = await writeDescriptionsIndex(
      mem as unknown as ExportStorage,
      ["co-b"],
      { "co-b": 25 },
      TEST_TENANT,
      THREE
    );
    expect(result).toEqual({ totalRecordCount: 65, fondsCount: 3 });
    const index = storedIndex(mem);
    expect(index.fonds).toEqual([
      { fonds_code: "co-a", key: fileKey("co-a"), record_count: 10 },
      { fonds_code: "co-b", key: fileKey("co-b"), record_count: 25 },
      { fonds_code: "co-c", key: fileKey("co-c"), record_count: 30 },
    ]);
    expect(index.total_record_count).toBe(65);
  });

  it("builds the index from scratch on a publish of every fonds, without reading the stored one", async () => {
    const mem = new MemoryStorage();
    for (const code of THREE) await mem.putObject(fileKey(code), "[]");
    await mem.putObject(INDEX_KEY, "not json");
    const result = await writeDescriptionsIndex(
      mem as unknown as ExportStorage,
      THREE,
      { "co-a": 1, "co-b": 2, "co-c": 3 },
      TEST_TENANT,
      THREE
    );
    expect(result).toEqual({ totalRecordCount: 6, fondsCount: 3 });
    expect(storedIndex(mem).fonds.map((e) => [e.fonds_code, e.record_count])).toEqual([
      ["co-a", 1],
      ["co-b", 2],
      ["co-c", 3],
    ]);
  });

  it("drops a fonds that is no longer published, and one whose file is gone", async () => {
    const mem = await publishedThree();
    // co-c is no longer published; co-a's file has been removed.
    await mem.deleteObject(fileKey("co-a"));
    const result = await writeDescriptionsIndex(
      mem as unknown as ExportStorage,
      ["co-b"],
      { "co-b": 20 },
      TEST_TENANT,
      ["co-a", "co-b"]
    );
    expect(result).toEqual({ totalRecordCount: 20, fondsCount: 1 });
    expect(storedIndex(mem).fonds.map((e) => e.fonds_code)).toEqual(["co-b"]);
  });

  it("drops a selected fonds that is no longer published", async () => {
    const mem = await publishedThree();
    const result = await writeDescriptionsIndex(
      mem as unknown as ExportStorage,
      THREE,
      { "co-a": 10, "co-b": 20, "co-c": 30 },
      TEST_TENANT,
      ["co-a", "co-b"]
    );
    expect(result).toEqual({ totalRecordCount: 30, fondsCount: 2 });
    expect(storedIndex(mem).fonds.map((e) => e.fonds_code)).toEqual(["co-a", "co-b"]);
  });

  it("refuses a publish of some fonds when the stored index leaves out a published fonds with a file, and writes nothing", async () => {
    const mem = await publishedThree();
    // The stored index lists only co-b, as a one-fonds publish left it.
    await writeDescriptionsIndex(mem as unknown as ExportStorage, ["co-b"], { "co-b": 20 }, TEST_TENANT, ["co-b"]);
    const before = mem.objects.get(INDEX_KEY);
    const run = () =>
      writeDescriptionsIndex(mem as unknown as ExportStorage, ["co-b"], { "co-b": 21 }, TEST_TENANT, THREE);
    await expect(run()).rejects.toThrow(DescriptionsIndexMissingFondsError);
    await expect(run()).rejects.toThrow(/co-a, co-c/);
    await expect(run()).rejects.toThrow(/full publish/);
    expect(mem.objects.get(INDEX_KEY)).toBe(before);
  });

  it("leaves out an unlisted published fonds that has no file", async () => {
    const mem = await publishedThree();
    await writeDescriptionsIndex(mem as unknown as ExportStorage, ["co-b"], { "co-b": 20 }, TEST_TENANT, ["co-b"]);
    await mem.deleteObject(fileKey("co-a"));
    await mem.deleteObject(fileKey("co-c"));
    const result = await writeDescriptionsIndex(
      mem as unknown as ExportStorage, ["co-b"], { "co-b": 21 }, TEST_TENANT, THREE
    );
    expect(result).toEqual({ totalRecordCount: 21, fondsCount: 1 });
  });

  for (const [label, stored] of [
    ["missing", null],
    ["not JSON", "{ not json"],
    ["without a fonds list", JSON.stringify({ version: 1, total_record_count: 3 })],
    ["with an entry lacking its count", JSON.stringify({ version: 1, fonds: [{ fonds_code: "co-a", key: "k" }] })],
  ] as const) {
    it(`refuses a publish of some fonds when the stored index is ${label}, and writes nothing`, async () => {
      const mem = new MemoryStorage();
      for (const code of THREE) await mem.putObject(fileKey(code), "[]");
      if (stored !== null) await mem.putObject(INDEX_KEY, stored);
      const before = mem.objects.get(INDEX_KEY);
      await expect(
        writeDescriptionsIndex(mem as unknown as ExportStorage, ["co-b"], { "co-b": 2 }, TEST_TENANT, THREE)
      ).rejects.toThrow(DescriptionsIndexUnreadableError);
      await expect(
        writeDescriptionsIndex(mem as unknown as ExportStorage, ["co-b"], { "co-b": 2 }, TEST_TENANT, THREE)
      ).rejects.toThrow(/neogranadina\/descriptions-index\.json/);
      expect(mem.objects.get(INDEX_KEY)).toBe(before);
    });
  }
});

// @version v0.9.0
