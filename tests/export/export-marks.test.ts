/**
 * Tests — the export marks the fonds descriptions step writes
 *
 * This suite pins `descriptions.last_exported_at`, the mark the admin
 * publish badge (`getPublishStatus`) compares with `updated_at`. The
 * fonds descriptions step (`exportFondsDescriptions`) writes it for the
 * fonds it exports, with the time it took just before it read the
 * fonds (T, given here through the `clock` seam), and only once the
 * fonds' file is complete.
 *
 * The fixture fonds holds published descriptions digitised and not,
 * one already marked and unchanged since, one edited since its mark,
 * one edited after T, an unpublished description still marked, and one
 * unpublished after T. Rows the step must not touch sit beside it:
 * another fonds of the same tenant, and another tenant's row naming the
 * fonds' root. The cases check that:
 *
 *   - every published description of the fonds that needs a mark gets
 *     T, digitised or not, and a mark already at or after its edit is
 *     left as it was;
 *   - a description edited after T keeps no mark, so the badge reads
 *     Pending publish;
 *   - an unpublished description's mark is cleared, unless it was
 *     edited after T;
 *   - nothing outside the fonds and its tenant is touched;
 *   - a failed write of the file marks and clears nothing;
 *   - running the step again with a later T leaves the marks as the
 *     first run left them;
 *   - the badge reads Live for a marked description;
 *   - a description moved into the fonds after the step read it (its
 *     root changed, its `updated_at` not) keeps the mark it had,
 *     published or not, since the file does not hold it: the step marks
 *     only the ids it wrote and clears only the unpublished ids it read;
 *   - the ids are passed in chunks, each one JSON text parameter, and
 *     every chunk is applied;
 *   - each statement reaches its rows by primary key
 *     (`EXPLAIN QUERY PLAN`), never through a tenant index, and the read
 *     of the fonds' marked unpublished descriptions seeks
 *     `descriptions_tenant_root_id_idx` on the tenant and the root.
 *
 * The storage stub keeps objects and multipart uploads in memory, and
 * can run a callback as an object is written or an upload completed,
 * after the step's last check of the fonds; the failing stub refuses to complete any object.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportFondsDescriptions,
  fondsExportMarks,
  fondsMarkedUnpublishedQuery,
} from "../../app/lib/export/pipeline.server";
import { getPublishStatus } from "../../app/components/descriptions/status-badges";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const FONDS = "co-mk";
const KEY = `neogranadina/descriptions-${FONDS}.json`;

const U0 = 1_000_000;
/** An earlier publish's mark. */
const S = 2_000_000;
/** When the step reads the fonds. */
const T = 5_000_000;

/** In-memory storage with the object and multipart surface the step uses. */
class MemoryStorage {
  objects = new Map<string, Uint8Array>();
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  private next = 1;
  constructor(
    private readonly failWrites = false,
    private readonly onComplete?: () => Promise<void>
  ) {}

  async putObject(key: string, body: string): Promise<void> {
    if (this.failWrites) throw new Error("R2 put failed");
    await this.onComplete?.();
    this.objects.set(key, new TextEncoder().encode(body));
  }
  async putObjectBytes(key: string, body: Uint8Array): Promise<void> {
    if (this.failWrites) throw new Error("R2 put failed");
    await this.onComplete?.();
    this.objects.set(key, body.slice());
  }
  async getObjectHead(key: string) {
    const b = this.objects.get(key);
    return b ? { size: b.length } : null;
  }
  async getObjectBytes(key: string) {
    return this.objects.get(key)?.slice() ?? null;
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async createMultipartUpload(key: string): Promise<string> {
    const id = `upload-${this.next++}`;
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }
  async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array) {
    this.uploads.get(uploadId)!.parts.set(partNumber, body.slice());
    return { partNumber, etag: `etag-${uploadId}-${partNumber}` };
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number }>) {
    if (this.failWrites) throw new Error("R2 complete failed");
    await this.onComplete?.();
    const upload = this.uploads.get(uploadId)!;
    const bodies = parts.map((p) => upload.parts.get(p.partNumber)!);
    const out = new Uint8Array(bodies.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of bodies) {
      out.set(b, at);
      at += b.length;
    }
    this.objects.set(key, out);
    this.uploads.delete(uploadId);
  }
  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }
}

const REPO = "00000000-0000-4000-8000-0000000000a1";
const ROOT = "00000000-0000-4000-8000-0000000000b0";
const OTHER_ROOT = "00000000-0000-4000-8000-0000000000c0";
const id = (n: number) => `00000000-0000-4000-8000-0000000000b${n}`;

/** The fixture rows, by name: [id, published, digitised, updated_at, mark]. */
const ROWS = {
  digitised: [id(1), true, true, U0, null],
  plain: [id(2), true, false, U0, null],
  marked: [id(3), true, false, U0, S],
  edited: [id(4), true, true, S + 10, S],
  editedAfterT: [id(5), true, false, T + 1, null],
  editedAtT: [id(8), true, false, T, null],
  unpublished: [id(6), false, false, S + 10, S],
  unpublishedAfterT: [id(7), false, false, T + 1, S],
} as const;

async function seed() {
  await cleanDatabase();
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.repositories).values({
    id: REPO, tenantId: TENANT.id, code: "co-mk-repo", name: "Archivo MK", enabled: true, createdAt: U0, updatedAt: U0,
  });
  const base = { tenantId: TENANT.id, repositoryId: REPO, createdAt: U0, descriptionLevel: "file" as const };
  await db.insert(schema.descriptions).values({
    ...base, id: ROOT, parentId: null, rootDescriptionId: ROOT, descriptionLevel: "fonds",
    referenceCode: FONDS, title: "Fondo MK", isPublished: true, childCount: 8, updatedAt: U0,
  });
  for (const [name, [rowId, published, digitised, updatedAt, mark]] of Object.entries(ROWS)) {
    await db.insert(schema.descriptions).values({
      ...base, id: rowId, parentId: ROOT, rootDescriptionId: ROOT, referenceCode: `${FONDS}-${name}`,
      title: name, isPublished: published, hasDigital: digitised,
      iiifManifestUrl: digitised ? `https://iiif.example.org/${name}` : null,
      updatedAt, lastExportedAt: mark,
    });
  }
  // Another fonds of the same tenant, and another tenant's row naming
  // this fonds' root: the step must touch neither.
  await db.insert(schema.descriptions).values({
    ...base, id: OTHER_ROOT, parentId: null, rootDescriptionId: OTHER_ROOT, descriptionLevel: "fonds",
    referenceCode: "co-mk-other", title: "Otro", isPublished: true, updatedAt: U0,
  });
  await db.insert(schema.descriptions).values({
    ...base, tenantId: SECOND_TEST_TENANT_ID, id: "00000000-0000-4000-8000-0000000000d1", parentId: ROOT,
    rootDescriptionId: ROOT, referenceCode: "mx-mk-stray", title: "Ajeno", isPublished: true, updatedAt: U0,
  });
}

async function marks(): Promise<Record<string, number | null>> {
  const { results } = await env.DB.prepare("SELECT id, last_exported_at FROM descriptions ORDER BY id")
    .all<{ id: string; last_exported_at: number | null }>();
  return Object.fromEntries(results.map((r) => [r.id, r.last_exported_at]));
}

const run = (storage: MemoryStorage, at: number) =>
  exportFondsDescriptions(drizzle(env.DB, { schema }), storage as unknown as ExportStorage, FONDS, TENANT, [TENANT.id], {
    clock: () => at,
  });

describe("export marks of the fonds descriptions step", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(seed);

  it("marks every published description that needs it with the read time, digitised or not", async () => {
    const storage = new MemoryStorage();
    await run(storage, T);
    expect(storage.objects.has(KEY)).toBe(true);
    const m = await marks();
    expect(m[ROOT]).toBe(T);
    expect(m[ROWS.digitised[0]]).toBe(T);
    expect(m[ROWS.plain[0]]).toBe(T);
    expect(m[ROWS.edited[0]]).toBe(T);
    // Already marked at or after its last edit: left as it was.
    expect(m[ROWS.marked[0]]).toBe(S);
  });

  it("leaves a description edited after the read time unmarked, so it reads Pending publish", async () => {
    await run(new MemoryStorage(), T);
    const m = await marks();
    expect(m[ROWS.editedAfterT[0]]).toBeNull();
    expect(getPublishStatus(true, m[ROWS.editedAfterT[0]], ROWS.editedAfterT[3])).toBe("pending_publish");
  });

  it("leaves a description edited in the read's own millisecond unmarked", async () => {
    await run(new MemoryStorage(), T);
    const m = await marks();
    expect(m[ROWS.editedAtT[0]]).toBeNull();
  });

  it("clears an unpublished description's mark, unless it was edited after the read time", async () => {
    await run(new MemoryStorage(), T);
    const m = await marks();
    expect(m[ROWS.unpublished[0]]).toBeNull();
    expect(getPublishStatus(false, m[ROWS.unpublished[0]], ROWS.unpublished[3])).toBe("unpublished");
    expect(m[ROWS.unpublishedAfterT[0]]).toBe(S);
  });

  it("touches nothing outside the fonds and its tenant", async () => {
    await run(new MemoryStorage(), T);
    const m = await marks();
    expect(m[OTHER_ROOT]).toBeNull();
    expect(m["00000000-0000-4000-8000-0000000000d1"]).toBeNull();
  });

  it("marks and clears nothing when the file's write fails", async () => {
    const before = await marks();
    await expect(run(new MemoryStorage(true), T)).rejects.toThrow();
    expect(await marks()).toEqual(before);
  });

  it("leaves the marks as they were when the step runs again with a later read time", async () => {
    const storage = new MemoryStorage();
    await run(storage, T);
    const first = await marks();
    // A retry reads at a later time. The rows edited after T fall before
    // the later read time, so the retry marks or clears them; every
    // other row keeps the mark the first run left.
    await run(storage, T + 1_000);
    const second = await marks();
    for (const name of ["digitised", "plain", "marked", "edited", "unpublished"] as const) {
      expect(second[ROWS[name][0]]).toBe(first[ROWS[name][0]]);
    }
    expect(second[ROOT]).toBe(first[ROOT]);
  });

  it("reads Live on the badge for a marked description", async () => {
    await run(new MemoryStorage(), T);
    const m = await marks();
    expect(getPublishStatus(true, m[ROWS.plain[0]], ROWS.plain[3])).toBe("live");
    expect(getPublishStatus(true, m[ROWS.digitised[0]], ROWS.digitised[3])).toBe("live");
  });

  it("leaves a description moved into the fonds after the read with the mark it had", async () => {
    const db = drizzle(env.DB, { schema });
    const published = "00000000-0000-4000-8000-0000000000e1";
    const unpublished = "00000000-0000-4000-8000-0000000000e2";
    const base = { tenantId: TENANT.id, repositoryId: REPO, createdAt: U0, updatedAt: U0, descriptionLevel: "file" as const };
    await db.insert(schema.descriptions).values([
      { ...base, id: published, parentId: OTHER_ROOT, rootDescriptionId: OTHER_ROOT, referenceCode: "co-mk-other-1", title: "Movido", isPublished: true },
      { ...base, id: unpublished, parentId: OTHER_ROOT, rootDescriptionId: OTHER_ROOT, referenceCode: "co-mk-other-2", title: "Movido retirado", isPublished: false, lastExportedAt: S },
    ]);
    // The move rewrites the root and parent and leaves updated_at alone,
    // as the move action does; it lands after the step's last check.
    const move = async () => {
      await env.DB.prepare("UPDATE descriptions SET root_description_id = ?1, parent_id = ?1 WHERE id IN (?2, ?3)")
        .bind(ROOT, published, unpublished).run();
    };
    await run(new MemoryStorage(false, move), T);
    const m = await marks();
    expect(m[published]).toBeNull();
    expect(m[unpublished]).toBe(S);
    // The rows the file holds are still marked.
    expect(m[ROWS.plain[0]]).toBe(T);
  });

  it("applies every chunk of ids", async () => {
    const db = drizzle(env.DB, { schema });
    const markIds = [ROOT, ROWS.digitised[0], ROWS.plain[0], ROWS.edited[0], ROWS.editedAfterT[0]];
    const statements = fondsExportMarks(db, TENANT.id, markIds, [ROWS.unpublished[0]], T, 2);
    expect(statements).toHaveLength(4);
    for (const statement of statements) expect(statement.toSQL().params.length).toBeLessThan(10);
    await db.batch(statements as never);
    const m = await marks();
    for (const rowId of [ROOT, ROWS.digitised[0], ROWS.plain[0], ROWS.edited[0]]) expect(m[rowId]).toBe(T);
    expect(m[ROWS.editedAfterT[0]]).toBeNull();
    expect(m[ROWS.unpublished[0]]).toBeNull();
  });

  it("reaches the rows by primary key in every statement", async () => {
    const db = drizzle(env.DB, { schema });
    for (const statement of fondsExportMarks(db, TENANT.id, [ROOT], [ROWS.unpublished[0]], T)) {
      const { sql, params } = statement.toSQL();
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const details = plan.results.map((r) => r.detail).join("\n");
      expect(details).toMatch(/SEARCH descriptions USING INDEX sqlite_autoindex_descriptions_1 \(id=\?\)/);
      expect(details).not.toMatch(/descriptions_tenant_/);
    }
    const { sql, params } = fondsMarkedUnpublishedQuery(db, TENANT.id, ROOT).toSQL();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n"))
      .toMatch(/descriptions_tenant_root_id_idx \(tenant_id=\? AND root_description_id=\?/);
  });
});

// @version v0.9.0
