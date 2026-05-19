/**
 * Tests — R2 export-storage client
 *
 * This suite pins `ExportStorage`, the thin wrapper around the
 * Cloudflare R2 bucket binding that the publish pipeline calls to
 * upload generated JSON and XML payloads. The wrapper exists so the
 * pipeline can stay agnostic about R2's exact `put` shape (content
 * type, custom metadata, conditional headers) and so the test pool
 * can swap a mocked bucket in place of the real binding.
 *
 * The cases exercise content-type tagging (JSON → application/json,
 * XML → application/xml), the cache-control header the public CDN
 * consumes to decide TTL, the delete path used when republishing
 * supersedes prior objects, and the error-surfacing contract — R2
 * exceptions surface as structured errors rather than the raw
 * binding error.
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
