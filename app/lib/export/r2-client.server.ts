/**
 * R2 Storage Client for the Publish Pipeline
 *
 * This module deals with a thin wrapper around the Cloudflare R2
 * binding that exposes only the operations the export pipeline needs:
 * JSON puts, XML puts, streaming puts, streaming gets, head-for-size,
 * and deletes. It isolates the rest of the pipeline from the R2
 * binding's API surface and gives the test suite a single surface to
 * stub.
 *
 * `putObjectXml` lets downstream EAD3 + DC builders land their XML
 * artefacts under each tenant's R2 prefix with the correct
 * content-type, without forking another R2 client abstraction. JSON
 * and XML put paths share the same backing bucket; only the
 * `Content-Type` header differs.
 *
 * The byte and multipart methods serve the link files
 * (`entity_links.json`, `place_links.json`), which run to 60-110 MB
 * and cannot be built as one string inside a Worker. They are written
 * as an R2 multipart upload in fixed-size parts (R2 requires every
 * part but the last to be the same size and at least 5 MiB), and the
 * bytes that do not yet fill a part are kept in a small staging object
 * between Workflow steps. See `json-array-upload.server.ts`.
 *
 * @version v0.8.0
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
   * Upload an XML string to R2 at the given key path. Used by the
   * EAD3 and Dublin Core builders so their per-fonds files
   * arrive with `application/xml; charset=utf-8` rather than the
   * JSON content-type. Caller is responsible for prefixing the key
   * with `${tenant.slug}/` — this method does no key rewriting.
   */
  async putObjectXml(key: string, body: string): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: "application/xml; charset=utf-8" },
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
   * Upload raw bytes. Used for the link files' staging objects (bytes
   * that may end mid-character, so they cannot travel as a string) and
   * for a link file small enough to fit in one part.
   */
  async putObjectBytes(
    key: string,
    body: Uint8Array,
    contentType = "application/json; charset=utf-8",
    customMetadata?: Record<string, string>
  ): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType },
      ...(customMetadata ? { customMetadata } : {}),
    });
  }

  /**
   * Read an object's bytes, or null when it does not exist. Only used
   * for the link files' staging objects, which are smaller than one part.
   */
  async getObjectBytes(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  /**
   * Start a multipart upload to `key`; returns its upload id. The
   * custom metadata is carried by the object once the upload completes.
   */
  async createMultipartUpload(
    key: string,
    customMetadata?: Record<string, string>
  ): Promise<string> {
    const upload = await this.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      ...(customMetadata ? { customMetadata } : {}),
    });
    return upload.uploadId;
  }

  /**
   * Upload one part of a multipart upload started in this or an earlier
   * Workflow step. Re-uploading a part number replaces it, so a retried
   * step can send the same parts again.
   */
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, body);
    return { partNumber: part.partNumber, etag: part.etag };
  }

  /** Complete a multipart upload from its recorded parts. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.complete(parts);
  }

  /** Abort a multipart upload; its parts are discarded. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    await upload.abort();
  }

  /**
   * HEAD an object to retrieve its size without fetching the body.
   * Used by the per-fonds byteSize guard in streamCombinedDescriptions to
   * fail fast on oversized fonds before any body is loaded into memory,
   * and by the link-file upload to recognise its own finished object by
   * the token in its custom metadata.
   */
  async getObjectHead(
    key: string
  ): Promise<{ size: number; customMetadata?: Record<string, string> } | null> {
    const head = await this.bucket.head(key);
    return head ? { size: head.size, customMetadata: head.customMetadata } : null;
  }
}
