/**
 * Link Files Export (entity_links.json, place_links.json)
 *
 * This suite covers the two publish steps that write the link files the
 * Zasqua engine reads for entity and place pages, on a real in-Worker
 * D1. The rows must keep the shape zasqua.org reads today, field for
 * field and in the same key order, and must only name descriptions and
 * authorities that the rest of the export publishes.
 *
 * The cases cover: the row shape and key order of both files; the
 * engine schemas' required keys and types; an unpublished description,
 * a merged entity and an authority without a code left out; another
 * tenant's links left out, and a federation member's links included
 * only when the member tenants are passed; the stored role written
 * verbatim, `fiador` included; `role_raw` and `date_expression` as ""
 * when the column is null; deterministic order; and a run split across
 * several steps, pages and multipart parts producing the same bytes as
 * a run in one step, with its staging objects removed afterwards.
 *
 * The storage stub keeps objects and multipart uploads in memory and
 * refuses a completed upload whose parts other than the last differ in
 * size, the rule R2 enforces, and refuses parts for an upload already
 * completed. Further cases replay the final step after the file is
 * complete (it must succeed and leave the bytes unchanged), read a
 * description with more links than one query returns, and force a step
 * to hand over on its query budget across empty windows. The last case
 * runs the real
 * `ExportStorage` multipart methods against the test R2 binding. One
 * more covers the cleanup after a failed publish: an unfinished file's
 * staging objects are deleted and its upload aborted, a finished file
 * is left alone, and running the cleanup again is harmless.
 *
 * @version v0.8.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { AHR_TENANT_ID } from "../../app/lib/tenant";
import {
  exportEntities,
  exportPlaces,
} from "../../app/lib/export/pipeline.server";
import {
  exportEntityLinks,
  exportPlaceLinks,
  abandonLinkExports,
  type LinkExportOptions,
  type LinkExportState,
} from "../../app/lib/export/link-files.server";
import { ExportStorage } from "../../app/lib/export/r2-client.server";
import { JsonArrayUpload, carryKey } from "../../app/lib/export/json-array-upload.server";
import type { ExportTenant } from "../../app/lib/export/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** In-memory storage with the object and multipart surface the link steps use. */
class MemoryStorage {
  objects = new Map<string, Uint8Array>();
  metadata = new Map<string, Record<string, string>>();
  uploads = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array>; meta?: Record<string, string> }
  >();
  completed = new Set<string>();
  partSizes: number[] = [];
  uploadsCreated = 0;
  private nextUpload = 1;

  async putObject(key: string, body: string): Promise<void> {
    this.objects.set(key, enc.encode(body));
  }
  async putObjectXml(key: string, body: string): Promise<void> {
    this.objects.set(key, enc.encode(body));
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
  async getObjectHead(
    key: string
  ): Promise<{ size: number; customMetadata?: Record<string, string> } | null> {
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
    customMetadata?: Record<string, string>
  ): Promise<string> {
    const id = `upload-${this.nextUpload++}`;
    this.uploadsCreated++;
    this.uploads.set(id, { key, parts: new Map(), meta: customMetadata });
    return id;
  }
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<{ partNumber: number; etag: string }> {
    if (this.completed.has(uploadId)) throw new Error("upload already completed");
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
    const bodies = parts.map((p, i) => {
      if (p.partNumber !== i + 1) throw new Error("parts out of order");
      if (p.etag !== `etag-${uploadId}-${p.partNumber}`) throw new Error("bad etag");
      return upload.parts.get(p.partNumber)!;
    });
    for (let i = 0; i < bodies.length - 1; i++) {
      if (bodies[i].length !== bodies[0].length) {
        throw new Error("all parts but the last must be the same size");
      }
    }
    this.partSizes = bodies.map((b) => b.length);
    const total = bodies.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of bodies) {
      out.set(b, at);
      at += b.length;
    }
    this.objects.set(key, out);
    if (upload.meta) this.metadata.set(key, upload.meta);
    else this.metadata.delete(key);
    this.uploads.delete(uploadId);
    this.completed.add(uploadId);
  }
  aborted = new Set<string>();
  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    if (!this.uploads.has(uploadId)) throw new Error("no such upload");
    this.uploads.delete(uploadId);
    this.aborted.add(uploadId);
  }
  text(key: string): string | undefined {
    const b = this.objects.get(key);
    return b ? dec.decode(b) : undefined;
  }
}

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

type Db = ReturnType<typeof drizzle>;
type LinkStep = typeof exportEntityLinks;

/** Run a link step to completion, as the workflow does; returns the steps taken. */
async function runToEnd(
  run: LinkStep,
  db: Db,
  storage: MemoryStorage,
  memberTenantIds?: string[],
  options: Omit<LinkExportOptions, "state"> = {}
): Promise<LinkExportState[]> {
  const states: LinkExportState[] = [];
  let state: LinkExportState | undefined;
  do {
    // Round-trip through JSON, as a Workflow step boundary does.
    state = JSON.parse(
      JSON.stringify(
        await run(db, storage as unknown as ExportStorage, TENANT, memberTenantIds, {
          ...options,
          state,
        })
      )
    ) as LinkExportState;
    states.push(state);
  } while (!state.done);
  return states;
}

const ENTITY_LINK_KEYS = [
  "reference_code",
  "title",
  "date_expression",
  "date_start",
  "repository_code",
  "entity_code",
  "role",
  "role_raw",
];
const PLACE_LINK_KEYS = [
  "reference_code",
  "title",
  "date_expression",
  "date_start",
  "repository_code",
  "place_code",
  "place_label",
  "role",
];

/**
 * Hand check against zasqua-engine schemas/entity_links.schema.json and
 * place_links.schema.json: required keys present, and every key the
 * schema types is a string.
 */
function checkAgainstSchema(
  rows: Array<Record<string, unknown>>,
  required: string[],
  typedStrings: string[]
) {
  for (const row of rows) {
    for (const k of required) expect(row, `required ${k}`).toHaveProperty(k);
    for (const k of typedStrings) {
      if (k in row) expect(typeof row[k], `${k} must be a string`).toBe("string");
    }
  }
}

const now = Date.now();
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function seedRepo(db: Db, tenantId: string, code: string) {
  const repoId = id();
  await db.insert(schema.repositories).values({
    id: repoId,
    tenantId,
    code,
    name: code,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return repoId;
}

async function seedDescription(
  db: Db,
  tenantId: string,
  repositoryId: string,
  referenceCode: string,
  extra: Partial<typeof schema.descriptions.$inferInsert> = {}
) {
  const descId = id();
  await db.insert(schema.descriptions).values({
    id: descId,
    tenantId,
    repositoryId,
    parentId: null,
    rootDescriptionId: descId,
    descriptionLevel: "file",
    referenceCode,
    title: `Title of ${referenceCode}`,
    dateExpression: "1760-07-23",
    dateStart: "1760-07-23",
    isPublished: true,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return descId;
}

async function seedEntity(
  db: Db,
  federationId: string,
  entityCode: string | null,
  extra: Partial<typeof schema.entities.$inferInsert> = {}
) {
  const entityId = id();
  await db.insert(schema.entities).values({
    id: entityId,
    federationId,
    entityCode,
    displayName: entityCode ?? "uncoded",
    sortName: entityCode ?? "uncoded",
    entityType: "person",
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return entityId;
}

async function seedPlace(
  db: Db,
  federationId: string,
  placeCode: string | null,
  label: string,
  extra: Partial<typeof schema.places.$inferInsert> = {}
) {
  const placeId = id();
  await db.insert(schema.places).values({
    id: placeId,
    federationId,
    placeCode,
    label,
    displayName: `${label}, display`,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return placeId;
}

async function linkEntity(
  db: Db,
  descriptionId: string,
  entityId: string,
  role: (typeof schema.descriptionEntities.$inferInsert)["role"],
  roleRaw: string | null = null
) {
  await db.insert(schema.descriptionEntities).values({
    id: id(),
    descriptionId,
    entityId,
    role,
    roleRaw,
    createdAt: now,
  });
}

async function linkPlace(
  db: Db,
  descriptionId: string,
  placeId: string,
  role: (typeof schema.descriptionPlaces.$inferInsert)["role"]
) {
  await db.insert(schema.descriptionPlaces).values({
    id: id(),
    descriptionId,
    placeId,
    role,
    createdAt: now,
  });
}

async function seedAhrMember(db: Db) {
  await db.insert(schema.tenants).values({
    id: AHR_TENANT_ID,
    slug: "ahr",
    name: "Archivo Histórico de Rionegro",
    kind: "tenant",
    descriptiveStandard: "isadg",
    status: "active",
    crowdsourcingEnabled: false,
    vocabularyHubEnabled: true,
    publishPipelineEnabled: true,
    multiRepositoryEnabled: false,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * The main fixture: two published descriptions in the lead tenant with
 * entity and place links, plus every kind of link the files must leave
 * out (unpublished description, merged or uncoded authority, another
 * federation's tenant) and one link in a federation member.
 */
async function seedFixture(db: Db) {
  const repo = await seedRepo(db, DEFAULT_TEST_TENANT_ID, "co-cihjml");
  const d1 = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, "co-cihjml-acc-00002", {
    dateExpression: null,
    dateStart: null,
  });
  const d2 = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, "co-cihjml-acc-00001", {
    dateExpression: "1630-01-04 .. 1630-04-12",
    dateStart: "1630-01-04",
  });
  const dUnpublished = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, "co-cihjml-acc-00003", {
    isPublished: false,
  });

  const eA = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-aaaaa");
  const eB = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-bbbbb");
  const eMerged = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-mmmmm", { mergedInto: eA });
  const eUncoded = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, null);

  await linkEntity(db, d1, eB, "fiador", "fiador del otorgante");
  await linkEntity(db, d1, eA, "sender");
  await linkEntity(db, d1, eA, "apoderado", null);
  await linkEntity(db, d2, eA, "heir", "heredero");
  await linkEntity(db, d1, eMerged, "witness");
  await linkEntity(db, d1, eUncoded, "witness");
  await linkEntity(db, dUnpublished, eA, "recipient");

  const pA = await seedPlace(db, DEFAULT_TEST_FEDERATION_ID, "nl-mab94", "Almaguer");
  const pMerged = await seedPlace(db, DEFAULT_TEST_FEDERATION_ID, "nl-zzzzz", "Merged", { mergedInto: pA });
  await linkPlace(db, d2, pA, "subject");
  await linkPlace(db, d1, pA, "sent_from");
  await linkPlace(db, d1, pMerged, "subject");
  await linkPlace(db, dUnpublished, pA, "subject");

  // Another federation's tenant: its links never appear.
  const otherRepo = await seedRepo(db, SECOND_TEST_TENANT_ID, "mx-other");
  const dOther = await seedDescription(db, SECOND_TEST_TENANT_ID, otherRepo, "mx-other-001");
  const eOther = await seedEntity(db, SECOND_TEST_FEDERATION_ID, "ne-other");
  const pOther = await seedPlace(db, SECOND_TEST_FEDERATION_ID, "nl-other", "Otro");
  await linkEntity(db, dOther, eOther, "subject");
  await linkPlace(db, dOther, pOther, "subject");

  // A member of the lead's federation: included only in a federation publish.
  await seedAhrMember(db);
  const ahrRepo = await seedRepo(db, AHR_TENANT_ID, "co-ahr");
  const dAhr = await seedDescription(db, AHR_TENANT_ID, ahrRepo, "co-ahr-gob-001");
  await linkEntity(db, dAhr, eA, "official");
  await linkPlace(db, dAhr, pA, "created");
}

describe("link files export", () => {
  let db: Db;
  let storage: MemoryStorage;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    storage = new MemoryStorage();
  });

  it("writes entity_links.json in today's row shape, key order and role values", async () => {
    await seedFixture(db);
    const states = await runToEnd(exportEntityLinks, db, storage);
    expect(states).toHaveLength(1);
    expect(states[0].count).toBe(4);

    const rows = JSON.parse(storage.text("neogranadina/entity_links.json")!);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) expect(Object.keys(row)).toEqual(ENTITY_LINK_KEYS);

    expect(rows).toEqual([
      {
        reference_code: "co-cihjml-acc-00001",
        title: "Title of co-cihjml-acc-00001",
        date_expression: "1630-01-04 .. 1630-04-12",
        date_start: "1630-01-04",
        repository_code: "co-cihjml",
        entity_code: "ne-aaaaa",
        role: "heir",
        role_raw: "heredero",
      },
      {
        reference_code: "co-cihjml-acc-00002",
        title: "Title of co-cihjml-acc-00002",
        date_expression: "",
        date_start: null,
        repository_code: "co-cihjml",
        entity_code: "ne-aaaaa",
        role: "apoderado",
        role_raw: "",
      },
      {
        reference_code: "co-cihjml-acc-00002",
        title: "Title of co-cihjml-acc-00002",
        date_expression: "",
        date_start: null,
        repository_code: "co-cihjml",
        entity_code: "ne-aaaaa",
        role: "sender",
        role_raw: "",
      },
      {
        reference_code: "co-cihjml-acc-00002",
        title: "Title of co-cihjml-acc-00002",
        date_expression: "",
        date_start: null,
        repository_code: "co-cihjml",
        entity_code: "ne-bbbbb",
        role: "fiador",
        role_raw: "fiador del otorgante",
      },
    ]);

    checkAgainstSchema(
      rows,
      ["entity_code", "reference_code", "role"],
      ["entity_code", "reference_code", "title", "date_expression", "repository_code", "role", "role_raw"]
    );
  });

  it("writes place_links.json in today's row shape and key order", async () => {
    await seedFixture(db);
    const states = await runToEnd(exportPlaceLinks, db, storage);
    expect(states[states.length - 1].count).toBe(2);

    const rows = JSON.parse(storage.text("neogranadina/place_links.json")!);
    for (const row of rows) expect(Object.keys(row)).toEqual(PLACE_LINK_KEYS);
    expect(rows).toEqual([
      {
        reference_code: "co-cihjml-acc-00001",
        title: "Title of co-cihjml-acc-00001",
        date_expression: "1630-01-04 .. 1630-04-12",
        date_start: "1630-01-04",
        repository_code: "co-cihjml",
        place_code: "nl-mab94",
        place_label: "Almaguer",
        role: "subject",
      },
      {
        reference_code: "co-cihjml-acc-00002",
        title: "Title of co-cihjml-acc-00002",
        date_expression: "",
        date_start: null,
        repository_code: "co-cihjml",
        place_code: "nl-mab94",
        place_label: "Almaguer",
        role: "sent_from",
      },
    ]);

    checkAgainstSchema(
      rows,
      ["place_code", "reference_code"],
      ["place_code", "reference_code", "title", "date_expression", "repository_code", "role"]
    );
  });

  it("names only entities and places that entities.json and places.json export", async () => {
    await seedFixture(db);
    const s = storage as unknown as ExportStorage;
    await exportEntities(db, s, TENANT);
    await exportPlaces(db, s, TENANT);
    await runToEnd(exportEntityLinks, db, storage);
    await runToEnd(exportPlaceLinks, db, storage);

    const entityCodes = new Set(
      JSON.parse(storage.text("neogranadina/entities.json")!).map((e: any) => e.entity_code)
    );
    const placeCodes = new Set(
      JSON.parse(storage.text("neogranadina/places.json")!).map((p: any) => p.place_code)
    );
    const entityLinks = JSON.parse(storage.text("neogranadina/entity_links.json")!);
    const placeLinks = JSON.parse(storage.text("neogranadina/place_links.json")!);
    for (const l of entityLinks) expect(entityCodes.has(l.entity_code)).toBe(true);
    for (const l of placeLinks) expect(placeCodes.has(l.place_code)).toBe(true);

    const all = JSON.stringify([entityLinks, placeLinks]);
    expect(all).not.toContain("co-cihjml-acc-00003"); // unpublished
    expect(all).not.toContain("ne-mmmmm"); // merged entity
    expect(all).not.toContain("nl-zzzzz"); // merged place
    expect(all).not.toContain("mx-other"); // another tenant
    expect(all).not.toContain("co-ahr-gob-001"); // member, not passed
  });

  it("includes a federation member's links when the member tenants are passed", async () => {
    await seedFixture(db);
    const members = [DEFAULT_TEST_TENANT_ID, AHR_TENANT_ID];
    await runToEnd(exportEntityLinks, db, storage, members);
    await runToEnd(exportPlaceLinks, db, storage, members);

    const entityLinks = JSON.parse(storage.text("neogranadina/entity_links.json")!);
    const placeLinks = JSON.parse(storage.text("neogranadina/place_links.json")!);
    expect(entityLinks).toHaveLength(5);
    expect(placeLinks).toHaveLength(3);
    expect(entityLinks).toContainEqual(
      expect.objectContaining({
        reference_code: "co-ahr-gob-001",
        repository_code: "co-ahr",
        entity_code: "ne-aaaaa",
        role: "official",
      })
    );
    expect(placeLinks).toContainEqual(
      expect.objectContaining({ reference_code: "co-ahr-gob-001", role: "created" })
    );
    expect(JSON.stringify(entityLinks)).not.toContain("mx-other");
    // Written under the publish slug only.
    expect([...storage.objects.keys()].every((k) => k.startsWith("neogranadina/"))).toBe(true);
  });

  it("writes [] when there are no links", async () => {
    const states = await runToEnd(exportEntityLinks, db, storage);
    expect(states[0]).toMatchObject({ done: true, count: 0 });
    expect(storage.text("neogranadina/entity_links.json")).toBe("[]");
    await runToEnd(exportPlaceLinks, db, storage);
    expect(storage.text("neogranadina/place_links.json")).toBe("[]");
  });

  it("produces the same bytes across steps, pages and parts as in one step", async () => {
    const repo = await seedRepo(db, DEFAULT_TEST_TENANT_ID, "co-big");
    const eA = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-aaaaa");
    const eB = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-bbbbb");
    const pA = await seedPlace(db, DEFAULT_TEST_FEDERATION_ID, "nl-aaaaa", "Popayán");
    // Insert in shuffled order so the file's order comes from the query.
    const n = 30;
    const order = Array.from({ length: n }, (_, i) => (i * 7) % n);
    for (const i of order) {
      const ref = `co-big-${String(i).padStart(3, "0")}`;
      const d = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, ref, {
        title: `Título ${i} — señor Muñoz`,
      });
      await linkEntity(db, d, eB, "seller", i % 2 ? "vendedor" : null);
      await linkEntity(db, d, eA, "buyer");
      await linkPlace(db, d, pA, "created");
    }

    const whole = new MemoryStorage();
    const wholeStates = await runToEnd(exportEntityLinks, db, whole);
    expect(wholeStates).toHaveLength(1);
    const expected = whole.text("neogranadina/entity_links.json")!;

    // 4 descriptions a page, a new step after 10 links, 64-byte parts:
    // many steps, pages and parts, with multi-byte characters cut
    // across part and step boundaries.
    const split = await runToEnd(exportEntityLinks, db, storage, undefined, {
      descriptionPageSize: 4,
      rowsPerStep: 10,
      partSize: 64,
    });
    expect(split.length).toBeGreaterThan(3);
    expect(split[split.length - 1]).toMatchObject({ done: true, count: 2 * n });
    expect(storage.partSizes.length).toBeGreaterThan(10);
    expect(storage.partSizes.slice(0, -1).every((s) => s === 64)).toBe(true);
    expect(storage.text("neogranadina/entity_links.json")).toBe(expected);

    // Staging objects are gone; only the file remains.
    expect([...storage.objects.keys()]).toEqual(["neogranadina/entity_links.json"]);

    const rows = JSON.parse(expected);
    expect(rows).toHaveLength(2 * n);
    const sortKeys = rows.map((r: any) => `${r.reference_code}|${r.entity_code}|${r.role}`);
    expect(sortKeys).toEqual([...sortKeys].sort());
    expect(rows[0]).toMatchObject({ reference_code: "co-big-000", entity_code: "ne-aaaaa", role: "buyer" });

    // Place file, split the same way, matches its one-step run too.
    const placeWhole = new MemoryStorage();
    await runToEnd(exportPlaceLinks, db, placeWhole);
    const placeSplit = new MemoryStorage();
    await runToEnd(exportPlaceLinks, db, placeSplit, undefined, {
      descriptionPageSize: 3,
      rowsPerStep: 5,
      partSize: 64,
    });
    expect(placeSplit.text("neogranadina/place_links.json")).toBe(
      placeWhole.text("neogranadina/place_links.json")
    );
    expect(JSON.parse(placeSplit.text("neogranadina/place_links.json")!)).toHaveLength(n);
  });

  it("is deterministic across runs", async () => {
    await seedFixture(db);
    const members = [AHR_TENANT_ID, DEFAULT_TEST_TENANT_ID];
    await runToEnd(exportEntityLinks, db, storage, members);
    const first = storage.text("neogranadina/entity_links.json");
    const again = new MemoryStorage();
    await runToEnd(exportEntityLinks, db, again, [...members].reverse());
    expect(again.text("neogranadina/entity_links.json")).toBe(first);
  });

  it("replays the final step after completion and leaves the bytes unchanged", async () => {
    const repo = await seedRepo(db, DEFAULT_TEST_TENANT_ID, "co-rep");
    const eA = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-aaaaa");
    for (let i = 0; i < 12; i++) {
      const d = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, `co-rep-${String(i).padStart(2, "0")}`, {
        title: `Título ${i} — Popayán`,
      });
      await linkEntity(db, d, eA, "subject");
    }

    // Multipart path (small parts) and single-put path (one large part).
    for (const partSize of [64, 1 << 20]) {
      const store = new MemoryStorage();
      const opts = { descriptionPageSize: 3, rowsPerStep: 4, partSize };
      const states = await runToEnd(exportEntityLinks, db, store, undefined, opts);
      expect(states.length).toBeGreaterThan(1);
      const key = "neogranadina/entity_links.json";
      const bytes = store.text(key);
      const uploads = store.uploadsCreated;
      // Staging objects already deleted by the completed step.
      expect([...store.objects.keys()]).toEqual([key]);

      // The Workflow re-runs the final step from the same input state.
      const finalInput = states[states.length - 2];
      const replay = await exportEntityLinks(
        db,
        store as unknown as ExportStorage,
        TENANT,
        undefined,
        { ...opts, state: JSON.parse(JSON.stringify(finalInput)) }
      );
      expect(replay).toMatchObject({ done: true, count: 12 });
      expect(store.text(key)).toBe(bytes);
      expect(store.uploadsCreated).toBe(uploads);
      expect(JSON.parse(bytes!)).toHaveLength(12);
    }
  });

  it("does not take an earlier publish's object for a completed upload", async () => {
    await seedFixture(db);
    const first = new MemoryStorage();
    await runToEnd(exportEntityLinks, db, first);
    const stale = first.objects.get("neogranadina/entity_links.json")!;

    // A new run over the old object (another token) rewrites it.
    const store = new MemoryStorage();
    await store.putObjectBytes("neogranadina/entity_links.json", enc.encode("[1]"), undefined, {
      "export-upload": "an-earlier-run",
    });
    await runToEnd(exportEntityLinks, db, store, undefined, { rowsPerStep: 1, descriptionPageSize: 1 });
    expect(store.objects.get("neogranadina/entity_links.json")).toEqual(stale);
  });

  it("reads a description with more links than one query returns", async () => {
    const repo = await seedRepo(db, DEFAULT_TEST_TENANT_ID, "co-many");
    const d = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, "co-many-001");
    const d2 = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, "co-many-002");
    const roles = ["subject", "mentioned", "witness"] as const;
    for (let i = 0; i < 6; i++) {
      const e = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, `ne-m${i}`);
      for (const role of roles) await linkEntity(db, d, e, role);
    }
    const eLast = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-zz");
    await linkEntity(db, d2, eLast, "subject");

    const whole = new MemoryStorage();
    await runToEnd(exportEntityLinks, db, whole);
    const expected = whole.text("neogranadina/entity_links.json")!;
    expect(JSON.parse(expected)).toHaveLength(19);

    // One query per step: each step's row increase is one query's rows,
    // which never exceeds the link page size.
    const states = await runToEnd(exportEntityLinks, db, storage, undefined, {
      linkPageSize: 5,
      queriesPerStep: 1,
    });
    const perStep = states.map((s, i) => s.count - (i ? states[i - 1].count : 0));
    expect(Math.max(...perStep)).toBe(5);
    expect(perStep.filter((n) => n === 5).length).toBe(3); // 18 links of d in pages of 5
    expect(storage.text("neogranadina/entity_links.json")).toBe(expected);
  });

  it("hands over on its query budget across windows without links", async () => {
    const repo = await seedRepo(db, DEFAULT_TEST_TENANT_ID, "co-empty");
    for (let i = 0; i < 30; i++) {
      await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, `co-empty-${String(i).padStart(2, "0")}`);
    }
    const eA = await seedEntity(db, DEFAULT_TEST_FEDERATION_ID, "ne-aaaaa");
    const dLast = await seedDescription(db, DEFAULT_TEST_TENANT_ID, repo, "co-empty-99");
    await linkEntity(db, dLast, eA, "subject");

    const states = await runToEnd(exportEntityLinks, db, storage, undefined, {
      descriptionPageSize: 2,
      queriesPerStep: 5,
    });
    // 16 windows, two queries each, plus the final empty page: well past one budget.
    expect(states.length).toBeGreaterThanOrEqual(6);
    expect(states.slice(0, -1).every((s) => !s.done && s.count === 0)).toBe(true);
    const rows = JSON.parse(storage.text("neogranadina/entity_links.json")!);
    expect(rows).toEqual([expect.objectContaining({ reference_code: "co-empty-99", entity_code: "ne-aaaaa" })]);
    expect([...storage.objects.keys()]).toEqual(["neogranadina/entity_links.json"]);
  });

  it("fails rather than take an older object when its staging object is missing", async () => {
    const storage = new MemoryStorage();
    const store = storage as unknown as ExportStorage;
    const key = "neogranadina/place_links.json";
    await storage.putObjectBytes(key, enc.encode("[1]"), undefined, {
      "export-upload": "an-earlier-run",
    });
    const a = JsonArrayUpload.start(store, key, 64);
    await a.writeRows([{ run: "a", n: 1 }]);
    const state = await a.pause();
    await storage.deleteObject(carryKey(key, state.token, state.segment));

    await expect(JsonArrayUpload.resume(store, state, 64)).rejects.toThrow(/is missing/);
    expect(storage.text(key)).toBe("[1]");
  });

  it("fails a replayed final step when another publish has since rewritten the file", async () => {
    const storage = new MemoryStorage();
    const store = storage as unknown as ExportStorage;
    const key = "neogranadina/place_links.json";
    const a = JsonArrayUpload.start(store, key, 64);
    await a.writeRows([{ run: "a", n: 1 }]);
    const aFinalStepInput = await a.pause();
    await (await JsonArrayUpload.resume(store, aFinalStepInput, 64)).finish();

    const b = JsonArrayUpload.start(store, key, 64);
    await b.writeRows([{ run: "b", n: 1 }]);
    await b.finish();

    await expect(JsonArrayUpload.resume(store, aFinalStepInput, 64)).rejects.toThrow(/is missing/);
    expect(JSON.parse(storage.text(key)!)).toEqual([{ run: "b", n: 1 }]);
  });

  it("keeps two overlapping uploads of one key from sharing staging objects", async () => {
    const storage = new MemoryStorage();
    const store = storage as unknown as ExportStorage;
    const key = "neogranadina/entity_links.json";
    const a = JsonArrayUpload.start(store, key, 64);
    await a.writeRows([{ run: "a", n: 1 }]);
    const aState = await a.pause();

    const b = JsonArrayUpload.start(store, key, 64);
    await b.writeRows([{ run: "b", n: 1 }]);
    const bState = await b.pause();
    await (await JsonArrayUpload.resume(store, bState, 64)).finish();
    expect(JSON.parse(storage.text(key)!)).toEqual([{ run: "b", n: 1 }]);

    const resumed = await JsonArrayUpload.resume(store, aState, 64);
    await resumed.writeRows([{ run: "a", n: 2 }]);
    await resumed.finish();
    expect(JSON.parse(storage.text(key)!)).toEqual([
      { run: "a", n: 1 },
      { run: "a", n: 2 },
    ]);
    expect([...storage.objects.keys()]).toEqual([key]);
  });

  it("removes an unfinished upload's staging objects and multipart upload after a failed publish", async () => {
    await seedFixture(db);
    const options = { descriptionPageSize: 1, linkPageSize: 1, rowsPerStep: 1, partSize: 64 };
    const first = await exportEntityLinks(
      db, storage as unknown as ExportStorage, TENANT, undefined, options
    );
    const second = await exportEntityLinks(
      db, storage as unknown as ExportStorage, TENANT, undefined, { ...options, state: first }
    );
    const third = await exportEntityLinks(
      db, storage as unknown as ExportStorage, TENANT, undefined, { ...options, state: second }
    );
    expect(third.done).toBe(false);
    expect(third.upload.uploadId).not.toBeNull();
    const staging = () =>
      [...storage.objects.keys()].filter((k) => k.includes(`.carry-${third.upload.token}-`));
    expect(staging().length).toBeGreaterThan(0);
    // Another file's finished state is left alone.
    const other = await runToEnd(exportPlaceLinks, db, storage);
    const placeKey = "neogranadina/place_links.json";
    const placeBytes = storage.text(placeKey);

    // The failure path passes the last state each file returned.
    await abandonLinkExports(storage as unknown as ExportStorage, [
      third,
      other[other.length - 1],
      undefined,
    ]);
    expect(staging()).toEqual([]);
    expect(storage.aborted.has(third.upload.uploadId!)).toBe(true);
    expect(storage.uploads.size).toBe(0);
    expect(storage.text(placeKey)).toBe(placeBytes);

    // A second run finds nothing left: objects missing, upload already
    // aborted. It neither throws nor touches anything else.
    await expect(
      abandonLinkExports(storage as unknown as ExportStorage, [third])
    ).resolves.toBeUndefined();
    expect(storage.text(placeKey)).toBe(placeBytes);
  });

  it("completes a multipart upload through ExportStorage on the R2 binding", async () => {
    const bucket = (env as unknown as { EXPORT_BUCKET: R2Bucket }).EXPORT_BUCKET;
    const store = new ExportStorage(bucket);
    const key = "link-files-test/multipart.json";
    const part = new Uint8Array(5 * 1024 * 1024).fill(0x61);
    const tail = enc.encode("tail");

    const uploadId = await store.createMultipartUpload(key, { "export-upload": "token-1" });
    const p1 = await store.uploadPart(key, uploadId, 1, part);
    const p2 = await store.uploadPart(key, uploadId, 2, tail);
    await store.completeMultipartUpload(key, uploadId, [p1, p2]);

    const head = await store.getObjectHead(key);
    expect(head?.size).toBe(part.length + tail.length);
    expect(head?.customMetadata?.["export-upload"]).toBe("token-1");

    await store.putObjectBytes(`${key}.carry-token-1-1`, tail, "application/octet-stream");
    expect(dec.decode((await store.getObjectBytes(`${key}.carry-token-1-1`))!)).toBe("tail");
    expect(await store.getObjectBytes(`${key}.missing`)).toBeNull();

    await store.deleteObject(key);
    await store.deleteObject(`${key}.carry-token-1-1`);
  });
});
