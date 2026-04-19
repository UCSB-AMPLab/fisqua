/**
 * Tests — r2 client
 *
 * @version v0.3.0
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExportStorage } from "../../app/lib/export/r2-client.server";

function createMockBucket(): R2Bucket {
  return {
    put: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    head: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

describe("ExportStorage", () => {
  let bucket: R2Bucket;
  let storage: ExportStorage;

  beforeEach(() => {
    bucket = createMockBucket();
    storage = new ExportStorage(bucket);
  });

  it("uploads JSON with correct content type", async () => {
    await storage.putObject("data/descriptions.json", '{"test":true}');
    expect(bucket.put).toHaveBeenCalledWith(
      "data/descriptions.json",
      '{"test":true}',
      { httpMetadata: { contentType: "application/json; charset=utf-8" } }
    );
  });

  it("deletes an object by key", async () => {
    await storage.deleteObject("children/old-file.json");
    expect(bucket.delete).toHaveBeenCalledWith("children/old-file.json");
  });

  it("does not throw when deleting a non-existent object", async () => {
    // R2 delete is idempotent — no error on missing keys
    await expect(
      storage.deleteObject("missing.json")
    ).resolves.toBeUndefined();
  });
});
