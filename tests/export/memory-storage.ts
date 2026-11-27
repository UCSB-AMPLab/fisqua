/**
 * In-Memory Export Storage for Tests
 *
 * This module deals with a stand-in for `ExportStorage` that keeps
 * objects, their custom metadata and content types, and multipart
 * uploads in memory, for the suites that check what the per-fonds
 * EAD3 and Dublin Core steps write. It refuses a completed upload whose
 * parts other than the last differ in size, the rule R2 enforces, and
 * records the size of each part sent and each upload aborted.
 *
 * @version v0.9.0
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class MemoryStorage {
  objects = new Map<string, Uint8Array>();
  metadata = new Map<string, Record<string, string>>();
  contentTypes = new Map<string, string>();
  uploads = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array>; meta?: Record<string, string>; contentType?: string }
  >();
  partSizes: number[] = [];
  aborted: string[] = [];
  private nextUpload = 1;

  async putObject(key: string, body: string): Promise<void> {
    this.objects.set(key, enc.encode(body));
    this.contentTypes.set(key, "application/json; charset=utf-8");
    this.metadata.delete(key);
  }
  async putObjectXml(key: string, body: string): Promise<void> {
    this.objects.set(key, enc.encode(body));
    this.contentTypes.set(key, "application/xml; charset=utf-8");
    this.metadata.delete(key);
  }
  async putObjectBytes(
    key: string,
    body: Uint8Array,
    contentType = "application/json; charset=utf-8",
    customMetadata?: Record<string, string>
  ): Promise<void> {
    this.objects.set(key, body.slice());
    this.contentTypes.set(key, contentType);
    if (customMetadata) this.metadata.set(key, customMetadata);
    else this.metadata.delete(key);
  }
  async getObjectHead(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null> {
    const b = this.objects.get(key);
    return b ? { size: b.length, customMetadata: this.metadata.get(key) } : null;
  }
  async getObjectBytes(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.slice() ?? null;
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    this.metadata.delete(key);
  }
  async createMultipartUpload(
    key: string,
    customMetadata?: Record<string, string>,
    contentType = "application/json; charset=utf-8"
  ): Promise<string> {
    const id = `upload-${this.nextUpload++}`;
    this.uploads.set(id, { key, parts: new Map(), meta: customMetadata, contentType });
    return id;
  }
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error("no such upload");
    upload.parts.set(partNumber, body.slice());
    return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
  }
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>
  ): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error("no such upload");
    const bodies = parts.map((p) => upload.parts.get(p.partNumber)!);
    for (let i = 0; i < bodies.length - 1; i++) {
      if (bodies[i].length !== bodies[0].length) {
        throw new Error("all parts but the last must be the same size");
      }
    }
    this.partSizes = bodies.map((b) => b.length);
    const out = new Uint8Array(bodies.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of bodies) {
      out.set(b, at);
      at += b.length;
    }
    this.objects.set(key, out);
    if (upload.contentType) this.contentTypes.set(key, upload.contentType);
    if (upload.meta) this.metadata.set(key, upload.meta);
    this.uploads.delete(uploadId);
  }
  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    if (!this.uploads.has(uploadId)) throw new Error("no such upload");
    this.uploads.delete(uploadId);
    this.aborted.push(uploadId);
  }
  text(key: string): string | undefined {
    const b = this.objects.get(key);
    return b ? dec.decode(b) : undefined;
  }
}

// @version v0.9.0
