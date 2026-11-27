/**
 * Tests — per-fonds descriptions file written in batches
 *
 * This suite pins how `exportFondsDescriptions` writes
 * `<slug>/descriptions-<fonds>.json` without holding the whole fonds
 * or the whole file in memory. The first production publish failed on
 * pe-bn-cdip (14,776 descriptions, 61.4M characters of OCR) with
 * `RangeError: Invalid string length`, because the step built the file
 * as one string.
 *
 * The reference is `singleStringExport`, which builds the whole file
 * as one string with `JSON.stringify`. On a fixture fonds small
 * enough for both, with batch and part sizes cut down so the new path
 * reads several batches and sends several multipart parts, the two
 * must write the same bytes. Further cases cover: OCR pages kept whole
 * when a description's text crosses the batch budget; records in `id`
 * order whatever order they were inserted in (the old query had no
 * ORDER BY, so its order was undefined); `byteSize` as the UTF-8 byte
 * count; `"[]"` for a fonds with no root and for one with nothing
 * published; and every query binding fewer than D1's 100 parameters,
 * with the number of queries bounded by the number of batches.
 *
 * A fonds that changes while its file is being written must never get
 * a completed file. The `hooks` seam changes the data between batches
 * or just before the file would be completed. The cases cover a parent
 * renamed after its children were written (caught when the parent's
 * own batch is read), a description unpublished before its batch, and
 * a rename, a move and a newly published description caught only by
 * reading the outline again at the end. Each must throw, abort the
 * upload and leave the previous file as it was. A second run once the
 * data has settled must write the file the reference builds. A
 * description published into the fonds before its batch is read is a
 * change too, and so is the last row of a batch unpublished while that
 * batch is read and published again before the end, which leaves both
 * outlines alike and only the batch short. Content edits count too: two
 * titles edited between batches (with their rows' `updated_at`), one
 * already written and one still to come, and a written description's
 * OCR replaced by new pages of the same length, are each refused, so no
 * file holds the fonds before one edit and after another. A failure
 * while the upload is being completed aborts the upload.
 *
 * Every predicate of the batch queries is pinned by a fixture that puts
 * rows the step must not read inside each batch's id range: another
 * fonds of the same tenant, another tenant's descriptions, another
 * tenant's pages on the fonds' own descriptions, and a malformed row of
 * another tenant naming the fonds' root. The file must still match the
 * reference, the page queries must return only the fonds' own
 * published pages, and the batches must be sized by the fonds' own OCR.
 *
 * The last cases run `EXPLAIN QUERY PLAN` on the outline, batch-row and
 * batch-page queries in the test D1, which, like D1, keeps no planner
 * statistics. Each must seek `descriptions_tenant_root_id_idx` with
 * equality on the tenant and the root, reach pages through
 * `ocr_pages_desc_seq_idx`, and use no primary-key or tenant index. A
 * cost case puts 2,000 unrelated descriptions, of another tenant and of
 * another fonds of the same tenant, before a one-description fonds in
 * id order, and bounds the rows each query reads by D1's own
 * `meta.rows_read`. The fonds carries former reference codes, so the
 * check of codes held now, one member tenant at a time through
 * `desc_ref_code_idx`, is bounded too; with a second member tenant
 * passed, a code that tenant holds is left out, and a code held only
 * outside the members is kept.
 *
 * The storage stub keeps objects and multipart uploads in memory and
 * refuses a completed upload whose parts other than the last differ in
 * size, the rule R2 enforces.
 *
 * @version v0.9.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  descriptions,
  ocrPages,
  repositories,
  tenants,
} from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_ID,
  seedDisabledTenant,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportFondsDescriptions,
  fondsOutlineQuery,
  fondsBatchRowsQuery,
  fondsBatchPagesQuery,
  liveReferenceCodesQuery,
} from "../../app/lib/export/pipeline.server";
import { formatDescription } from "../../app/lib/export/descriptions.server";
import { joinPageTexts } from "../../app/lib/export/rows.server";
import {
  FORMER_REFERENCE_PROVIDER,
  legacyIdsOf,
} from "../../app/lib/export/former-codes.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportDescription, ExportTenant } from "../../app/lib/export/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const FONDS = "co-x";
const KEY = `neogranadina/descriptions-${FONDS}.json`;

/** In-memory storage with the object and multipart surface the step uses. */
class MemoryStorage {
  objects = new Map<string, Uint8Array>();
  metadata = new Map<string, Record<string, string>>();
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array>; meta?: Record<string, string> }>();
  partSizes: number[] = [];
  private nextUpload = 1;

  async putObject(key: string, body: string): Promise<void> {
    this.objects.set(key, enc.encode(body));
    this.metadata.delete(key);
  }
  async putObjectBytes(
    key: string,
    body: Uint8Array,
    _contentType?: string,
    customMetadata?: Record<string, string>
  ): Promise<void> {
    this.objects.set(key, body.slice());
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
  async createMultipartUpload(key: string, customMetadata?: Record<string, string>): Promise<string> {
    const id = `upload-${this.nextUpload++}`;
    this.uploads.set(id, { key, parts: new Map(), meta: customMetadata });
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
    if (upload.meta) this.metadata.set(key, upload.meta);
    this.uploads.delete(uploadId);
  }
  aborted: string[] = [];
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

/**
 * The whole fonds read in two statements and the file built as one
 * string, returned rather than uploaded. The batched path must match
 * its bytes on any fonds small enough for it to build.
 */
async function singleStringExport(
  db: DrizzleD1Database<any>,
  fondsCode: string,
  tenant: ExportTenant,
  memberTenantIds?: string[]
): Promise<string> {
  const REFERENCE_CODE_CHUNK = 90;
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(and(eq(descriptions.referenceCode, fondsCode), eq(descriptions.tenantId, tenant.id)))
    .get();
  if (!root) return "[]";

  const fondsRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .all();

  const pages = await db
    .select({ id: ocrPages.descriptionId, text: ocrPages.text })
    .from(ocrPages)
    .innerJoin(descriptions, eq(descriptions.id, ocrPages.descriptionId))
    .where(
      and(
        eq(ocrPages.tenantId, tenant.id),
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.isPublished, true)
      )
    )
    .orderBy(asc(ocrPages.descriptionId), asc(ocrPages.pageSeq))
    .all();
  const ocrById = joinPageTexts(pages);

  const byId = new Map(fondsRows.map((r) => [r.id, r]));
  const childrenByParent = new Map<string, Array<{ referenceCode: string; descriptionLevel: string }>>();
  for (const row of fondsRows) {
    if (row.parentId) {
      const child = { referenceCode: row.referenceCode, descriptionLevel: row.descriptionLevel };
      const list = childrenByParent.get(row.parentId);
      if (list) list.push(child);
      else childrenByParent.set(row.parentId, [child]);
    }
  }

  const metsBaseUrl =
    (await db.select({ metsBaseUrl: tenants.metsBaseUrl }).from(tenants).where(eq(tenants.id, tenant.id)).get())
      ?.metsBaseUrl ?? null;

  const liveTenantIds = new Set(memberTenantIds ?? [tenant.id]);
  const formerByRow = new Map(fondsRows.map((r) => [r.id, legacyIdsOf(r.legacyIds, FORMER_REFERENCE_PROVIDER)]));
  const candidates = [...new Set([...formerByRow.values()].flat())];
  const live = new Set<string>();
  for (let i = 0; i < candidates.length; i += REFERENCE_CODE_CHUNK) {
    const rows = await db
      .select({ referenceCode: descriptions.referenceCode, tenantId: descriptions.tenantId })
      .from(descriptions)
      .where(inArray(descriptions.referenceCode, candidates.slice(i, i + REFERENCE_CODE_CHUNK)))
      .all();
    for (const r of rows) if (liveTenantIds.has(r.tenantId)) live.add(r.referenceCode);
  }

  const repoCache = new Map<string, { code: string; country: string | null }>();
  const fondsFormatted: ExportDescription[] = [];
  for (const row of fondsRows) {
    let repo = repoCache.get(row.repositoryId);
    if (!repo) {
      const repoRow = await db
        .select({ code: repositories.code, country: repositories.country })
        .from(repositories)
        .where(and(eq(repositories.id, row.repositoryId), eq(repositories.tenantId, tenant.id)))
        .get();
      repo = repoRow ?? { code: "", country: null };
      repoCache.set(row.repositoryId, repo);
    }
    const parentRefCode = row.parentId ? byId.get(row.parentId)?.referenceCode ?? null : null;
    const children = childrenByParent.get(row.id) ?? [];
    fondsFormatted.push(
      formatDescription(
        { ...row, ocrText: ocrById.get(row.id) ?? null },
        repo,
        parentRefCode,
        children,
        metsBaseUrl,
        (formerByRow.get(row.id) ?? []).filter((code) => !live.has(code))
      )
    );
  }
  return JSON.stringify(fondsFormatted);
}

/** A D1 binding that records how many parameters each statement binds. */
function countingD1(d1: D1Database) {
  const binds: number[] = [];
  let prepared = 0;
  const proxy = new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          prepared++;
          const stmt = target.prepare(query);
          return new Proxy(stmt, {
            get(s, k) {
              if (k === "bind") {
                return (...args: unknown[]) => {
                  binds.push(args.length);
                  return s.bind(...args);
                };
              }
              const v = (s as any)[k];
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { d1: proxy as D1Database, binds, prepared: () => prepared };
}

type Db = ReturnType<typeof drizzle>;
const now = Date.now();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const formerRef = (...codes: string[]) =>
  JSON.stringify(codes.map((id) => ({ provider: "former-reference-code", id })));

interface Fixture {
  ids: string[];
  ocr: Map<string, string>;
}

/**
 * A fonds of 1 root, 3 series and `files` files, with OCR pages of
 * varied sizes (accented and astral characters included), one
 * unpublished file, and former reference codes, one of them live.
 * Ids are assigned from `idOf(n)`, so a caller can insert in id order
 * or against it.
 */
async function seedFonds(
  db: Db,
  { files = 30, idOf = (n: number) => uuid(1000 + n) }: { files?: number; idOf?: (n: number) => string } = {}
): Promise<Fixture> {
  const repoId = uuid(1);
  await db.insert(schema.repositories).values({
    id: repoId,
    tenantId: TENANT.id,
    code: "co-x",
    name: "Archivo X",
    country: "Colombia",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const ids: string[] = [];
  const ocr = new Map<string, string>();
  let n = 0;
  const insert = async (
    referenceCode: string,
    level: typeof schema.descriptions.$inferInsert["descriptionLevel"],
    parentId: string | null,
    rootId: string | null,
    extra: Partial<typeof schema.descriptions.$inferInsert> = {}
  ) => {
    const id = idOf(n++);
    await db.insert(schema.descriptions).values({
      id,
      tenantId: TENANT.id,
      repositoryId: repoId,
      parentId,
      rootDescriptionId: rootId ?? id,
      descriptionLevel: level,
      referenceCode,
      title: `Título de ${referenceCode} — «expediente» 𝄞`,
      scopeContent: `Alcance de ${referenceCode}: señor Muñoz, año de 1790.`,
      isPublished: true,
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    ids.push(id);
    return id;
  };
  const root = await insert(FONDS, "fonds", null, null, { childCount: 3 });
  const series: string[] = [];
  for (let s = 0; s < 3; s++) {
    series.push(await insert(`${FONDS}-ser${s}`, "series", root, root, { childCount: Math.ceil(files / 3) }));
  }
  // co-x-ser0 is live, so it is not a redirect.
  for (let f = 0; f < files; f++) {
    const extra: Partial<typeof schema.descriptions.$inferInsert> = {};
    if (f === 4) extra.isPublished = false;
    if (f % 7 === 2) extra.legacyIds = formerRef(`${FONDS}-old${f}`, `${FONDS}-ser0`);
    const id = await insert(`${FONDS}-ser${f % 3}-f${String(f).padStart(3, "0")}`, "file", series[f % 3], root, extra);
    // Pages: none, one, or several of growing size, inserted out of page order.
    const pageCount = f % 5;
    const texts: string[] = [];
    for (let p = pageCount; p >= 1; p--) {
      const text = `Folio ${p} de f${f}: ${"ñandú ".repeat(5 * p * ((f % 4) + 1))}fin`;
      texts[p - 1] = text;
      await db.insert(schema.ocrPages).values({
        id: `${id}-p${p}`,
        tenantId: TENANT.id,
        descriptionId: id,
        pageSeq: p,
        text,
        createdAt: now,
      });
    }
    if (pageCount > 0) ocr.set(id, texts.join("\n\n"));
  }
  return { ids, ocr };
}

describe("exportFondsDescriptions writes the file in batches", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("writes the same bytes as the single-string export, across several batches and parts", async () => {
    await seedFonds(db);
    const expected = await singleStringExport(db, FONDS, TENANT);
    const storage = new MemoryStorage();
    const result = await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, undefined, {
      batchSize: 4,
      batchOcrChars: 400,
      partSize: 2048,
    });

    expect(storage.text(KEY)).toBe(expected);
    expect(storage.partSizes.length).toBeGreaterThan(2);
    expect(result.recordCount).toBe(JSON.parse(expected).length);
    expect(result.byteSize).toBe(enc.encode(expected).length);
    // Only the file is left: no staging object, no open upload.
    expect([...storage.objects.keys()]).toEqual([KEY]);
    expect(storage.uploads.size).toBe(0);
  });

  it("writes the same bytes with the default batch and part sizes", async () => {
    await seedFonds(db);
    const expected = await singleStringExport(db, FONDS, TENANT);
    const storage = new MemoryStorage();
    await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT);
    expect(storage.text(KEY)).toBe(expected);
  });

  it("keeps each description's pages whole when its OCR crosses the batch budget", async () => {
    const { ocr } = await seedFonds(db);
    const storage = new MemoryStorage();
    // Smaller than most descriptions' OCR: almost every batch is one record.
    await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, undefined, {
      batchSize: 5,
      batchOcrChars: 60,
      partSize: 1024,
    });
    const rows = JSON.parse(storage.text(KEY)!) as Array<{ id: string; ocr_text: string }>;
    for (const row of rows) expect(row.ocr_text).toBe(ocr.get(row.id) ?? "");
    expect(rows.filter((r) => r.ocr_text.includes("\n\nFolio 2")).length).toBeGreaterThan(3);
    expect(storage.text(KEY)).toBe(await singleStringExport(db, FONDS, TENANT));
  });

  it("emits records in id order whatever order they were inserted in", async () => {
    // Ids descend as rows are inserted, so insertion order is the reverse of id order.
    await seedFonds(db, { idOf: (n) => uuid(9000 - n) });
    const storage = new MemoryStorage();
    await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, undefined, {
      batchSize: 4,
      partSize: 2048,
    });
    const rows = JSON.parse(storage.text(KEY)!) as ExportDescription[];
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    // The same records as the single-string export, once each.
    const reference = JSON.parse(await singleStringExport(db, FONDS, TENANT)) as ExportDescription[];
    const byId = (list: ExportDescription[]) =>
      Object.fromEntries(list.map((r) => [r.id, { ...r, children_level: null }]));
    expect(byId(rows)).toEqual(byId(reference));
  });

  it("returns the UTF-8 byte count of the file", async () => {
    await seedFonds(db, { files: 6 });
    const storage = new MemoryStorage();
    const result = await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT);
    const bytes = storage.objects.get(KEY)!;
    expect(result.byteSize).toBe(bytes.length);
    expect(result.byteSize).toBeGreaterThan(storage.text(KEY)!.length);
  });

  it("writes [] for a fonds with no root and for one with nothing published", async () => {
    const storage = new MemoryStorage();
    expect(await exportFondsDescriptions(db, storage as unknown as ExportStorage, "missing", TENANT)).toEqual({
      recordCount: 0,
      byteSize: 2,
    });
    expect(storage.text("neogranadina/descriptions-missing.json")).toBe("[]");

    await seedFonds(db, { files: 3 });
    await env.DB.prepare("UPDATE descriptions SET is_published = 0").run();
    expect(await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT)).toEqual({
      recordCount: 0,
      byteSize: 2,
    });
    expect(storage.text(KEY)).toBe("[]");
  });

  it("binds fewer than 100 parameters per query and runs two queries per batch", async () => {
    await seedFonds(db, { files: 60 });
    const counting = countingD1(env.DB);
    const countedDb = drizzle(counting.d1, { schema });
    const storage = new MemoryStorage();
    const result = await exportFondsDescriptions(
      countedDb,
      storage as unknown as ExportStorage,
      FONDS,
      TENANT,
      undefined,
      { batchSize: 8, batchOcrChars: 1_000_000 }
    );
    const batches = Math.ceil(result.recordCount / 8);
    expect(Math.max(...counting.binds)).toBeLessThan(100);
    // Root, outline, the marked unpublished ids, tenant, former codes,
    // repository, the outline read again before the file is completed,
    // and the one export-mark statement of 60 ids once it is: eight;
    // then rows and pages per batch.
    expect(counting.prepared()).toBeLessThanOrEqual(8 + 2 * batches);
  });
});

describe("exportFondsDescriptions refuses a fonds that changes while it is written", () => {
  let db: Db;
  const PREVIOUS = enc.encode('[{"previous":true}]');

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  /** Storage holding the file an earlier publish wrote. */
  function storageWithPrevious(): MemoryStorage {
    const storage = new MemoryStorage();
    storage.objects.set(KEY, PREVIOUS.slice());
    return storage;
  }

  function expectUntouched(storage: MemoryStorage) {
    expect(storage.objects.get(KEY)).toEqual(PREVIOUS);
    expect([...storage.objects.keys()]).toEqual([KEY]);
    expect(storage.uploads.size).toBe(0);
  }

  const run = (storage: MemoryStorage, hooks?: Record<string, (i?: number) => Promise<void>>) =>
    exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, undefined, {
      batchSize: 4,
      partSize: 1024,
      hooks,
    });

  it("detects content edits to written rows between batches, so no file mixes two states", async () => {
    const { ids } = await seedFonds(db);
    const sorted = [...ids].sort();
    const storage = storageWithPrevious();
    await expect(
      run(storage, {
        beforeBatch: async (i) => {
          // One title edited after its batch, another before its batch.
          if (i === 2) {
            await env.DB.prepare("UPDATE descriptions SET title = 'Nuevo título', updated_at = ? WHERE id = ?")
              .bind(now + 1, sorted[1]).run();
            await env.DB.prepare("UPDATE descriptions SET title = 'Otro título', updated_at = ? WHERE id = ?")
              .bind(now + 1, sorted[sorted.length - 1]).run();
          }
        },
      })
    ).rejects.toThrow(/was edited after the publish began/);
    expectUntouched(storage);
  });

  it("detects a written description's OCR replaced by text of the same length", async () => {
    const { ids, ocr } = await seedFonds(db);
    const withText = [...ids].sort().find((id) => ocr.has(id))!;
    const storage = storageWithPrevious();
    await expect(
      run(storage, {
        beforeFinish: async () => {
          const pages = await env.DB.prepare("SELECT id, text FROM ocr_pages WHERE description_id = ?")
            .bind(withText).all<{ id: string; text: string }>();
          for (const p of pages.results) {
            await env.DB.prepare("UPDATE ocr_pages SET text = ?, created_at = ? WHERE id = ?")
              .bind("x".repeat(p.text.length), now + 1, p.id).run();
          }
        },
      })
    ).rejects.toThrow(/was edited after the publish began/);
    expectUntouched(storage);
  });

  it("aborts the upload when completing it fails", async () => {
    await seedFonds(db);
    const storage = storageWithPrevious();
    storage.completeMultipartUpload = async () => {
      throw new Error("complete failed");
    };
    await expect(run(storage)).rejects.toThrow("complete failed");
    expect(storage.aborted.length).toBe(1);
    expectUntouched(storage);
  });

  it("detects a parent renamed after its children were written, and aborts the upload", async () => {
    // Ids descend as rows are inserted: files come first in id order, the
    // series after them, so the series' batch is read after the rename.
    await seedFonds(db, { idOf: (n) => uuid(9000 - n) });
    const storage = storageWithPrevious();
    let reachedFinish = false;
    await expect(
      run(storage, {
        beforeBatch: async (i) => {
          if (i === 2) {
            await env.DB.prepare("UPDATE descriptions SET reference_code = ? WHERE reference_code = ?")
              .bind(`${FONDS}-serie-uno`, `${FONDS}-ser1`)
              .run();
          }
        },
        beforeFinish: async () => {
          reachedFinish = true;
        },
      })
    ).rejects.toThrow(`Fonds ${FONDS} changed during the publish`);
    // Caught at the parent's batch, not at the end.
    expect(reachedFinish).toBe(false);
    // Parts had been sent; the upload was aborted, not completed.
    expect(storage.aborted.length).toBe(1);
    expectUntouched(storage);
  });

  it("detects a description unpublished before its batch is read", async () => {
    const { ids } = await seedFonds(db);
    const storage = storageWithPrevious();
    const last = [...ids].sort()[ids.length - 1];
    await expect(
      run(storage, {
        beforeBatch: async (i) => {
          if (i === 1) {
            await env.DB.prepare("UPDATE descriptions SET is_published = 0 WHERE id = ?").bind(last).run();
          }
        },
      })
    ).rejects.toThrow(`Fonds ${FONDS} changed during the publish`);
    expectUntouched(storage);
  });

  it.each([
    ["a rename", "UPDATE descriptions SET reference_code = 'co-x-serie-cero' WHERE reference_code = 'co-x-ser0'"],
    [
      "a move",
      "UPDATE descriptions SET parent_id = (SELECT id FROM descriptions WHERE reference_code = 'co-x-ser2') WHERE reference_code = 'co-x-ser0-f000'",
    ],
    ["a former code", "UPDATE descriptions SET legacy_ids = '[]' WHERE reference_code = 'co-x-ser2-f002'"],
    ["a newly published description", "UPDATE descriptions SET is_published = 1 WHERE reference_code = 'co-x-ser1-f004'"],
  ])("detects %s made after every batch was read, from the outline read again", async (_label, statement) => {
    await seedFonds(db);
    const storage = storageWithPrevious();
    let batches = 0;
    await expect(
      run(storage, {
        beforeBatch: async () => {
          batches++;
        },
        beforeFinish: async () => {
          await env.DB.prepare(statement).run();
        },
      })
    ).rejects.toThrow(`Fonds ${FONDS} changed during the publish`);
    expect(batches).toBeGreaterThan(3);
    expect(storage.aborted.length).toBe(1);
    expectUntouched(storage);
  });

  it("writes the settled fonds on the next attempt", async () => {
    await seedFonds(db);
    const storage = storageWithPrevious();
    const rename = async () => {
      await env.DB.prepare("UPDATE descriptions SET reference_code = ? WHERE reference_code = ?")
        .bind(`${FONDS}-serie-uno`, `${FONDS}-ser1`)
        .run();
    };
    await expect(run(storage, { beforeFinish: rename })).rejects.toThrow(
      `Fonds ${FONDS} changed during the publish`
    );
    expectUntouched(storage);

    // The retry, with nothing changing under it.
    const result = await run(storage);
    const expected = await singleStringExport(db, FONDS, TENANT);
    expect(storage.text(KEY)).toBe(expected);
    expect(result.recordCount).toBe(JSON.parse(expected).length);
    const rows = JSON.parse(expected) as ExportDescription[];
    expect(rows.filter((r) => r.parent_reference_code === `${FONDS}-serie-uno`).length).toBeGreaterThan(0);
  });

  it("detects the last row of a batch unpublished for that batch and republished before the end", async () => {
    await seedFonds(db);
    const published = await env.DB.prepare(
      "SELECT id FROM descriptions WHERE root_description_id = ? AND is_published = 1 ORDER BY id"
    ).bind(uuid(1000)).all<{ id: string }>();
    // With four descriptions per batch, batch 1 ends at the eighth.
    const lastOfBatch = published.results[7].id;
    const setPublished = (value: 0 | 1) =>
      env.DB.prepare("UPDATE descriptions SET is_published = ? WHERE id = ?").bind(value, lastOfBatch).run();
    const storage = storageWithPrevious();
    await expect(
      exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, undefined, {
        batchSize: 4,
        batchOcrChars: 1_000_000,
        partSize: 1024,
        hooks: {
          beforeBatch: async (i) => {
            if (i === 1) await setPublished(0);
            if (i === 2) await setPublished(1);
          },
        },
      })
    ).rejects.toThrow("is no longer published in it");
    expectUntouched(storage);
  });

  it("detects a description published in the fonds before its batch is read", async () => {
    await seedFonds(db);
    const storage = storageWithPrevious();
    // co-x-ser1-f004 is the fixture's one unpublished file, inside the batch ranges.
    await expect(
      run(storage, {
        beforeBatch: async (i) => {
          if (i === 1) {
            await env.DB.prepare("UPDATE descriptions SET is_published = 1 WHERE reference_code = ?")
              .bind(`${FONDS}-ser1-f004`)
              .run();
          }
        },
      })
    ).rejects.toThrow(`Fonds ${FONDS} changed during the publish (${FONDS}-ser1-f004 was published`);
    expectUntouched(storage);
  });
});

/**
 * Fonds rows interleaved, by id, with rows the step must not read: a
 * description of another fonds of the same tenant and a description of
 * another tenant after each of the fonds' own, each with OCR pages, and
 * a page carrying the other tenant's id on several of the fonds' own
 * descriptions. Every one falls inside the fonds' batch ranges.
 */
async function seedNeighbours(db: Db): Promise<{ ownPages: number }> {
  await seedFonds(db, { idOf: (n) => uuid(1000 + 3 * n) });
  const otherRepo = uuid(2);
  await db.insert(schema.repositories).values({
    id: otherRepo, tenantId: SECOND_TEST_TENANT_ID, code: "co-y", name: "Archivo Y",
    enabled: true, createdAt: now, updatedAt: now,
  });
  const repoId = uuid(1);
  const ownRows = await env.DB.prepare("SELECT id FROM descriptions ORDER BY id").all<{ id: string }>();
  const otherRoot = uuid(1000 + 1);
  const foreignRoot = uuid(1000 + 2);
  let k = 0;
  for (const { id } of ownRows.results) {
    const n = (parseInt(id.slice(-12), 10) - 1000) / 3;
    for (const [offset, tenantId, repo, root, ref] of [
      [1, TENANT.id, repoId, otherRoot, `co-z-${n}`],
      [2, SECOND_TEST_TENANT_ID, otherRepo, foreignRoot, `co-y-${n}`],
    ] as const) {
      const neighbour = uuid(1000 + 3 * n + offset);
      await db.insert(schema.descriptions).values({
        id: neighbour, tenantId, repositoryId: repo, parentId: neighbour === root ? null : root,
        rootDescriptionId: root, descriptionLevel: neighbour === root ? "fonds" : "file",
        referenceCode: ref, title: `Vecino ${ref}`, isPublished: true, createdAt: now, updatedAt: now,
      });
      await db.insert(schema.ocrPages).values({
        id: `${neighbour}-p1`, tenantId, descriptionId: neighbour, pageSeq: 1,
        text: `texto vecino ${ref} `.repeat(40), createdAt: now,
      });
    }
    // Another tenant's page on every third description of the fonds.
    if (k++ % 3 === 0) {
      await db.insert(schema.ocrPages).values({
        id: `${id}-ajena`, tenantId: SECOND_TEST_TENANT_ID, descriptionId: id, pageSeq: 99,
        text: "fila ajena ".repeat(200), createdAt: now,
      });
    }
  }
  // A malformed row: another tenant's description naming the fonds'
  // root as its own, with a page carrying the fonds' tenant id. Only
  // the tenant predicates keep it and its page out.
  const stray = uuid(1000 + 3 * 5 + 2);
  await env.DB.prepare("UPDATE descriptions SET root_description_id = ? WHERE id = ?").bind(uuid(1000), stray).run();
  await db.insert(schema.ocrPages).values({
    id: `${stray}-p2`, tenantId: TENANT.id, descriptionId: stray, pageSeq: 2,
    text: "fila ajena del otro inquilino", createdAt: now,
  });
  const own = await env.DB.prepare(
    `SELECT count(*) AS n FROM ocr_pages p JOIN descriptions d ON d.id = p.description_id
     WHERE p.tenant_id = ? AND d.tenant_id = ? AND d.root_description_id = ? AND d.is_published = 1`
  ).bind(TENANT.id, TENANT.id, uuid(1000)).first<{ n: number }>();
  return { ownPages: own!.n };
}

/** A D1 binding that counts the rows each page query returns. */
function pageRowCounter(d1: D1Database) {
  let pageRows = 0;
  const proxy = new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const isPages = /^select "ocr_pages"\."description_id", "ocr_pages"\."text"/.test(query);
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(s, k) {
                if (k === "bind") return (...args: unknown[]) => wrap(s.bind(...args));
                if (k === "raw" || k === "all") {
                  return async (...args: unknown[]) => {
                    const out = await (s as any)[k](...args);
                    if (isPages) pageRows += Array.isArray(out) ? out.length : out.results.length;
                    return out;
                  };
                }
                const v = (s as any)[k];
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          return wrap(target.prepare(query));
        };
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { d1: proxy as D1Database, pageRows: () => pageRows };
}

describe("exportFondsDescriptions reads only the fonds' own rows", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("writes the reference bytes with other fonds' and tenants' rows inside every batch range", async () => {
    await seedNeighbours(db);
    const expected = await singleStringExport(db, FONDS, TENANT);
    expect(expected).not.toContain("vecino");
    expect(expected).not.toContain("fila ajena");
    const storage = new MemoryStorage();
    await exportFondsDescriptions(db, storage as unknown as ExportStorage, FONDS, TENANT, undefined, {
      batchSize: 4,
      partSize: 2048,
    });
    expect(storage.text(KEY)).toBe(expected);
  });

  it("reads only the fonds' own published pages", async () => {
    const { ownPages } = await seedNeighbours(db);
    const counter = pageRowCounter(env.DB);
    const storage = new MemoryStorage();
    await exportFondsDescriptions(
      drizzle(counter.d1, { schema }),
      storage as unknown as ExportStorage,
      FONDS,
      TENANT,
      undefined,
      { batchSize: 4, partSize: 2048 }
    );
    expect(ownPages).toBeGreaterThan(0);
    expect(counter.pageRows()).toBe(ownPages);
  });

  it("sizes batches by the fonds' own pages, not another tenant's", async () => {
    await seedNeighbours(db);
    // Own OCR length per published description, in id order, as the batches see it.
    const own = await env.DB.prepare(
      `SELECT d.id, coalesce(sum(length(p.text)), 0) AS c FROM descriptions d
       LEFT JOIN ocr_pages p ON p.description_id = d.id AND p.tenant_id = ?
       WHERE d.tenant_id = ? AND d.root_description_id = ? AND d.is_published = 1
       GROUP BY d.id ORDER BY d.id`
    ).bind(TENANT.id, TENANT.id, uuid(1000)).all<{ id: string; c: number }>();
    const budget = 600;
    let expected = 0;
    for (let i = 0; i < own.results.length; expected++) {
      let chars = own.results[i++].c;
      while (i < own.results.length && chars + own.results[i].c <= budget) chars += own.results[i++].c;
    }
    let batches = 0;
    await exportFondsDescriptions(
      db, new MemoryStorage() as unknown as ExportStorage, FONDS, TENANT, undefined,
      { batchSize: 1000, batchOcrChars: budget, hooks: { beforeBatch: async () => { batches++; } } }
    );
    expect(batches).toBe(expected);
  });
});

const FONDS_INDEX = "descriptions_tenant_root_id_idx (tenant_id=? AND root_description_id=?";

describe("the descriptions step's queries are bounded by the fonds", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  async function plan(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<string[]> {
    const { sql, params } = query.toSQL();
    const out = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
    return out.results.map((r) => r.detail);
  }

  /** No step of the plan walks the primary key or the tenant indexes. */
  function expectNoWideScan(detail: string[]) {
    for (const d of detail) {
      expect(d).not.toMatch(/sqlite_autoindex_descriptions_1|ocr_pages_tenant_idx|descriptions_tenant_updated_idx|^SCAN /);
    }
  }

  it("runs without planner statistics, as D1 does", async () => {
    const stat = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").first<{ n: number }>();
    expect(stat!.n).toBe(0);
  });

  it("reads the outline through the fonds index and each description's pages by id", async () => {
    const db = drizzle(env.DB, { schema });
    const detail = await plan(fondsOutlineQuery(db, TENANT.id, uuid(1000)));
    expect(detail.some((d) => d.includes(`${FONDS_INDEX})`))).toBe(true);
    expect(detail.some((d) => d.includes("ocr_pages_desc_seq_idx (description_id=?)"))).toBe(true);
    expectNoWideScan(detail);
  });

  it("reads a batch's rows by an id range inside the fonds index", async () => {
    const db = drizzle(env.DB, { schema });
    const detail = await plan(fondsBatchRowsQuery(db, TENANT.id, uuid(1000), uuid(1001), uuid(1100)));
    expect(detail.some((d) => d.includes(`${FONDS_INDEX} AND id>? AND id<?)`))).toBe(true);
    expectNoWideScan(detail);
    // The first batch has no lower bound, and is still bounded by the fonds.
    const first = await plan(fondsBatchRowsQuery(db, TENANT.id, uuid(1000), null, uuid(1100)));
    expect(first.some((d) => d.includes(`${FONDS_INDEX} AND id<?)`))).toBe(true);
    expectNoWideScan(first);
  });

  it("checks former codes against one tenant at a time through desc_ref_code_idx", async () => {
    const db = drizzle(env.DB, { schema });
    const detail = await plan(liveReferenceCodesQuery(db, TENANT.id, ["co-x-1", "co-x-2", "co-x-3"]));
    expect(detail.some((d) => d.includes("desc_ref_code_idx (tenant_id=? AND reference_code=?)"))).toBe(true);
    for (const d of detail) expect(d).not.toMatch(/^SCAN /);
  });

  it("reads a batch's pages from the fonds index, then each description's pages by id", async () => {
    const db = drizzle(env.DB, { schema });
    for (const afterId of [uuid(1001), null]) {
      const detail = await plan(fondsBatchPagesQuery(db, TENANT.id, uuid(1000), afterId, uuid(1100)));
      expect(detail[0]).toContain(`SEARCH descriptions USING INDEX ${FONDS_INDEX} AND id`);
      expect(detail.some((d) => d.includes("ocr_pages_desc_seq_idx (description_id=?)"))).toBe(true);
      expectNoWideScan(detail);
    }
  });
});

describe("the descriptions step's cost does not grow with unrelated rows", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  /** D1's own count of the rows a statement read. */
  async function rowsRead(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<number> {
    const { sql, params } = query.toSQL();
    const out = await env.DB.prepare(sql).bind(...params).all();
    return out.meta.rows_read;
  }

  it("reads a one-description fonds whose id sorts last without touching the rows before it", async () => {
    const repoA = uuid(1);
    const repoB = uuid(2);
    await db.insert(schema.repositories).values([
      { id: repoA, tenantId: TENANT.id, code: "co-x", name: "X", enabled: true, createdAt: now, updatedAt: now },
      { id: repoB, tenantId: SECOND_TEST_TENANT_ID, code: "co-y", name: "Y", enabled: true, createdAt: now, updatedAt: now },
    ]);
    // 2,000 unrelated descriptions, each with a page: half in another
    // fonds of the same tenant, half in another tenant, ids interleaved.
    const otherRoot = uuid(10);
    const foreignRoot = uuid(11);
    const rows: Array<typeof schema.descriptions.$inferInsert> = [];
    for (let i = 0; i < 2000; i++) {
      const own = i % 2 === 0;
      const root = own ? otherRoot : foreignRoot;
      const id = i < 2 ? root : uuid(100 + i);
      rows.push({
        id, tenantId: own ? TENANT.id : SECOND_TEST_TENANT_ID, repositoryId: own ? repoA : repoB,
        parentId: id === root ? null : root, rootDescriptionId: root, descriptionLevel: id === root ? "fonds" : "file",
        referenceCode: `ref-${i}`, title: `T${i}`, isPublished: true, createdAt: now, updatedAt: now,
      });
    }
    // One statement per row: D1 binds at most 100 parameters.
    const insertDescription = env.DB.prepare(
      `INSERT INTO descriptions (id, tenant_id, repository_id, parent_id, root_description_id, description_level,
         reference_code, title, is_published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    const insertPage = env.DB.prepare(
      "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, created_at) VALUES (?, ?, ?, 1, 'texto', ?)"
    );
    await env.DB.batch(
      rows.map((r) =>
        insertDescription.bind(
          r.id, r.tenantId, r.repositoryId, r.parentId, r.rootDescriptionId, r.descriptionLevel,
          r.referenceCode, r.title, now, now
        )
      )
    );
    await env.DB.batch(rows.map((r) => insertPage.bind(`${r.id}-p1`, r.tenantId, r.id, now)));
    // The fonds: one description, its id after every other.
    const lone = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(schema.descriptions).values({
      id: lone, tenantId: TENANT.id, repositoryId: repoA, parentId: null, rootDescriptionId: lone,
      descriptionLevel: "fonds", referenceCode: "co-x-lone", title: "Solo", isPublished: true,
      // ref-0 is held now in this tenant, ref-1 in another tenant.
      legacyIds: formerRef("ref-0", "ref-1", "co-x-gone"),
      createdAt: now, updatedAt: now,
    });
    await db.insert(schema.ocrPages).values({
      id: `${lone}-p1`, tenantId: TENANT.id, descriptionId: lone, pageSeq: 1, text: "uno", createdAt: now,
    });

    // One row and its page, a handful of index entries: never the 2,000.
    expect(await rowsRead(fondsOutlineQuery(db, TENANT.id, lone))).toBeLessThanOrEqual(5);
    expect(await rowsRead(fondsBatchRowsQuery(db, TENANT.id, lone, null, lone))).toBeLessThanOrEqual(5);
    expect(await rowsRead(fondsBatchPagesQuery(db, TENANT.id, lone, null, lone))).toBeLessThanOrEqual(5);
    // Three codes, at most one index entry each: never the 2,000.
    const codes = ["ref-0", "ref-1", "co-x-gone"];
    expect(await rowsRead(liveReferenceCodesQuery(db, TENANT.id, codes))).toBeLessThanOrEqual(5);
    expect(await rowsRead(liveReferenceCodesQuery(db, SECOND_TEST_TENANT_ID, codes))).toBeLessThanOrEqual(5);

    const storage = new MemoryStorage();
    const result = await exportFondsDescriptions(db, storage as unknown as ExportStorage, "co-x-lone", TENANT);
    expect(result.recordCount).toBe(1);
    const [record] = JSON.parse(storage.text("neogranadina/descriptions-co-x-lone.json")!);
    expect(record.former_reference_codes).toEqual(["ref-1", "co-x-gone"]);

    // A federation: ref-1 is live in a member tenant, so it is left out
    // too; a code held only by a tenant outside the members still counts
    // as former.
    await seedDisabledTenant();
    const repoC = uuid(3);
    await db.insert(schema.repositories).values({
      id: repoC, tenantId: DISABLED_TEST_TENANT_ID, code: "co-w", name: "W", enabled: true, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.descriptions).values({
      id: uuid(5), tenantId: DISABLED_TEST_TENANT_ID, repositoryId: repoC, parentId: null, rootDescriptionId: uuid(5),
      descriptionLevel: "fonds", referenceCode: "co-x-gone", title: "Fuera", isPublished: true,
      createdAt: now, updatedAt: now,
    });
    const federated = new MemoryStorage();
    await exportFondsDescriptions(db, federated as unknown as ExportStorage, "co-x-lone", TENANT, [
      TENANT.id,
      SECOND_TEST_TENANT_ID,
    ]);
    const [member] = JSON.parse(federated.text("neogranadina/descriptions-co-x-lone.json")!);
    expect(member.former_reference_codes).toEqual(["co-x-gone"]);
  });
});

// @version v0.9.0
