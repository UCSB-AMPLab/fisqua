/**
 * JSON Array Upload Across Workflow Steps
 *
 * This module deals with writing one very large JSON array to R2
 * without ever holding the whole array in memory. The link files
 * (`entity_links.json`, 335,830 rows and 109 MB on zasqua.org today;
 * `place_links.json`, 201,728 rows and 67 MB) are past what one Worker
 * can build: 128 MB of memory, and V8 holds a JS string in UTF-16, so a
 * single `JSON.stringify` of the array would need about twice the file
 * size before a byte reaches R2.
 *
 * The caller hands rows over a page at a time. Each page is serialized
 * and UTF-8 encoded on its own, appended to a byte buffer, and every
 * time the buffer holds a full part it is sent as one part of an R2
 * multipart upload. R2 requires every part except the last to be the
 * same size (and at least 5 MiB), so parts are cut at a fixed byte
 * length, wherever that falls in the text, rather than at row ends.
 * Memory stays at about one part plus one page.
 *
 * Plain `put(key, ReadableStream)` was not used: R2 needs the length of
 * a streamed body up front, and the local runtime was found to stall on
 * large streamed puts when the combined descriptions file was tried
 * (see `combined.server.ts`).
 *
 * A Workflow step has its own CPU and subrequest budget, so the upload
 * can span several steps. `pause()` returns a small JSON state (upload
 * id, the parts sent, the row count) for the step to return, and stores
 * the bytes that have not yet filled a part in a staging object next to
 * the target key (`<key>.carry-<token>-<n>`). Each pause writes a new
 * staging object named by the upload's token and numbered by its
 * segment, so two publishes of the same file never share one; none is
 * overwritten, so a step that fails and is retried from its input state
 * reads exactly the bytes the previous step left. `finish()` closes the array, sends the
 * last part, completes the upload and deletes the staging objects. A
 * file smaller than one part is written with a single put instead.
 *
 * Completing the upload and deleting the staging objects are not the
 * end of the step: if anything after them fails, the Workflow runs the
 * step again from its input state, whose staging object is gone and
 * whose upload is already complete. So every upload carries a random
 * token, set when the array is started and written into the finished
 * object's custom metadata (`export-upload`). `resume()` first looks at
 * the target object; when it carries this upload's token the file is
 * already complete, and the replayed step reads its rows again only to
 * count them, sending nothing. An object left by an earlier publish has
 * another token and is overwritten as before.
 *
 * A publish that fails for good leaves its staging objects and its open
 * multipart upload behind, and the next publish starts with a new
 * token, so nothing would ever reuse them. `abandonJsonArrayUpload()`
 * takes the last state a step returned, deletes that token's staging
 * objects and aborts the upload. It is best-effort and safe to repeat:
 * a missing object or an upload already aborted or completed is not an
 * error, and a failure is logged rather than thrown, so it never hides
 * the error that ended the publish. It cannot reach what the failed
 * step created under ids that never left it: an upload that step
 * started, and, when it was the file's first step, its staging object.
 * R2's own expiry of incomplete multipart uploads removes the former.
 *
 * The upload assumes one publish per tenant at a time. `api.publish`
 * refuses a new publish while another run of the same tenant is in
 * flight, so two publishes never write the same key together, and
 * races between publishes are outside this module's scope. The token in
 * the staging keys and the token check on replay stay as defence in
 * depth: they keep one publish's bytes apart from another's if the
 * guard is ever bypassed, for instance by a run presumed dead that is
 * still going. A replayed step whose staging object is gone and whose
 * key carries another token fails rather than ends quietly, since an
 * older file and a newer publish's file cannot be told apart.
 *
 * @version v0.8.0
 */

import type { ExportStorage } from "./r2-client.server";

/** R2's minimum part size; parts are cut at this length by default. */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

/** Serializable state carried from one Workflow step to the next. */
export interface JsonArrayUploadState {
  key: string;
  /** Random per upload; written to the finished object's metadata. */
  token: string;
  uploadId: string | null;
  parts: Array<{ partNumber: number; etag: string }>;
  rowCount: number;
  /** Number of pauses so far; the staging object of the last is `<key>.carry-<token>-<segment>`. */
  segment: number;
}

const encoder = new TextEncoder();

/** Custom-metadata field holding the upload token on the finished object. */
export const UPLOAD_TOKEN_FIELD = "export-upload";

export function carryKey(key: string, token: string, segment: number): string {
  return `${key}.carry-${token}-${segment}`;
}

/**
 * Remove what an unfinished upload left in R2: the staging objects of
 * its token and its open multipart upload. Segment `segment + 1` is
 * included because the step that failed may have paused before it
 * failed. Never throws.
 */
export async function abandonJsonArrayUpload(
  storage: ExportStorage,
  state: JsonArrayUploadState
): Promise<void> {
  for (let n = 1; n <= state.segment + 1; n++) {
    const staging = carryKey(state.key, state.token, n);
    try {
      await storage.deleteObject(staging);
    } catch (err) {
      console.warn(`Could not delete staging object ${staging}:`, err);
    }
  }
  if (state.uploadId !== null) {
    try {
      await storage.abortMultipartUpload(state.key, state.uploadId);
    } catch (err) {
      // Already aborted or completed, or R2 refused: nothing more to do.
      console.warn(`Could not abort the ${state.key} upload ${state.uploadId}:`, err);
    }
  }
}

export class JsonArrayUpload {
  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  /** Size of the finished object when a replayed step finds it complete. */
  private completedSize: number | null = null;

  private constructor(
    private storage: ExportStorage,
    private state: JsonArrayUploadState,
    private partSize: number
  ) {}

  /** Begin a new array at `key`. */
  static start(
    storage: ExportStorage,
    key: string,
    partSize = DEFAULT_PART_SIZE
  ): JsonArrayUpload {
    const upload = new JsonArrayUpload(
      storage,
      {
        key,
        token: crypto.randomUUID(),
        uploadId: null,
        parts: [],
        rowCount: 0,
        segment: 0,
      },
      partSize
    );
    upload.append(encoder.encode("["));
    return upload;
  }

  /** Continue an array from the state an earlier step returned. */
  static async resume(
    storage: ExportStorage,
    state: JsonArrayUploadState,
    partSize = DEFAULT_PART_SIZE
  ): Promise<JsonArrayUpload> {
    const upload = new JsonArrayUpload(
      storage,
      { ...state, parts: [...state.parts] },
      partSize
    );
    const head = await storage.getObjectHead(state.key);
    if (head && head.customMetadata?.[UPLOAD_TOKEN_FIELD] === state.token) {
      // A replay of the step that already finished this file.
      upload.completedSize = head.size;
      return upload;
    }
    if (state.segment > 0) {
      const carried = await storage.getObjectBytes(
        carryKey(state.key, state.token, state.segment)
      );
      // A missing staging object is an error even when the key holds an
      // object: without this upload's token on it, nothing shows that
      // this upload finished, and an earlier publish's file would be
      // reported as this one.
      if (!carried) {
        throw new Error(
          `Staging object ${carryKey(state.key, state.token, state.segment)} is missing; the ${state.key} upload cannot continue`
        );
      }
      upload.append(carried);
    }
    return upload;
  }

  get rowCount(): number {
    return this.state.rowCount;
  }

  /** A copy of the current state. */
  snapshot(): JsonArrayUploadState {
    return { ...this.state, parts: [...this.state.parts] };
  }

  /** Append one page of rows and send every part the buffer now fills. */
  async writeRows(rows: unknown[]): Promise<void> {
    if (rows.length === 0) return;
    let text = "";
    for (const row of rows) {
      text += (this.state.rowCount > 0 ? "," : "") + JSON.stringify(row);
      this.state.rowCount++;
    }
    if (this.completedSize !== null) return;
    this.append(encoder.encode(text));
    await this.sendFullParts();
  }

  /** Store the unsent bytes and return the state for the next step. */
  async pause(): Promise<JsonArrayUploadState> {
    if (this.completedSize !== null) return this.snapshot();
    const segment = this.state.segment + 1;
    await this.storage.putObjectBytes(
      carryKey(this.state.key, this.state.token, segment),
      this.take(this.bufferedBytes),
      "application/octet-stream"
    );
    this.state.segment = segment;
    return { ...this.state, parts: [...this.state.parts] };
  }

  /** Close the array and complete the object. Returns rows and bytes written. */
  async finish(): Promise<{ rowCount: number; byteSize: number }> {
    if (this.completedSize !== null) {
      await this.deleteStaging();
      return { rowCount: this.state.rowCount, byteSize: this.completedSize };
    }
    this.append(encoder.encode("]"));
    let byteSize: number;
    if (this.state.uploadId === null) {
      byteSize = this.bufferedBytes;
      await this.storage.putObjectBytes(
        this.state.key,
        this.take(byteSize),
        undefined,
        { [UPLOAD_TOKEN_FIELD]: this.state.token }
      );
    } else {
      await this.sendFullParts();
      const tail = this.bufferedBytes;
      if (tail > 0) await this.sendPart(this.take(tail));
      byteSize = (this.state.parts.length - (tail > 0 ? 1 : 0)) * this.partSize + tail;
      await this.storage.completeMultipartUpload(
        this.state.key,
        this.state.uploadId,
        this.state.parts
      );
    }
    await this.deleteStaging();
    return { rowCount: this.state.rowCount, byteSize };
  }

  /**
   * Staging objects are only needed until the file is complete. A
   * failed delete leaves a small orphan but must not fail the step
   * after the upload has been completed.
   */
  private async deleteStaging(): Promise<void> {
    for (let n = 1; n <= this.state.segment; n++) {
      try {
        await this.storage.deleteObject(carryKey(this.state.key, this.state.token, n));
      } catch {
        /* best effort */
      }
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.bufferedBytes += bytes.length;
  }

  /** Remove and return the first `n` buffered bytes as one array. */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.bufferedBytes -= n;
    return out;
  }

  private async sendFullParts(): Promise<void> {
    while (this.bufferedBytes >= this.partSize) {
      await this.sendPart(this.take(this.partSize));
    }
  }

  private async sendPart(bytes: Uint8Array): Promise<void> {
    if (this.state.uploadId === null) {
      this.state.uploadId = await this.storage.createMultipartUpload(
        this.state.key,
        { [UPLOAD_TOKEN_FIELD]: this.state.token }
      );
    }
    const part = await this.storage.uploadPart(
      this.state.key,
      this.state.uploadId,
      this.state.parts.length + 1,
      bytes
    );
    this.state.parts.push(part);
  }
}
