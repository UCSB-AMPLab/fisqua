/**
 * R2 Storage Client for the Publish Pipeline
 *
 * Thin wrapper around the Cloudflare R2 binding that exposes only the
 * operations the export pipeline needs: JSON puts, streaming puts,
 * streaming gets, head-for-size, and deletes. Isolates the rest of the
 * pipeline from the R2 binding's API surface and gives the test suite
 * a single surface to stub.
 *
 * @version v0.3.0
 */
export class ExportStorage {
  constructor(private bucket: R2Bucket) {}

  /**
   * Upload a JSON string to R2 at the given key path.
   */
  async putObject(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  /**
   * Delete an object from R2 by key.
   * Used for cleanup of orphaned children files.
   */
  async deleteObject(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  /**
   * Stream a body to R2 at the given key. R2's `put` accepts a ReadableStream
   * natively, so memory stays bounded to one chunk at a time on the JS side.
   * Used by the streaming combined-descriptions writer.
   */
  async putObjectStream(key: string, body: ReadableStream): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  /**
   * Open a streaming GET for an object. Returns null if the object does not exist.
   * Used by the streaming combined-descriptions writer to read per-fonds bodies
   * one at a time.
   */
  async getObjectStream(key: string): Promise<ReadableStream | null> {
    const obj = await this.bucket.get(key);
    return obj?.body ?? null;
  }

  /**
   * HEAD an object to retrieve its size without fetching the body.
   * Used by the per-fonds byteSize guard in streamCombinedDescriptions to
   * fail fast on oversized fonds before any body is loaded into memory.
   */
  async getObjectHead(key: string): Promise<{ size: number } | null> {
    const head = await this.bucket.head(key);
    return head ? { size: head.size } : null;
  }
}
