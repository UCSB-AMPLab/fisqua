/**
 * Tests — children_level in the descriptions files and repositories.json
 *
 * This suite pins that a root description carries the same
 * `children_level` in its fonds' descriptions file and in
 * repositories.json, and that both give the description level of the
 * root's published children: the most common one when they mix, and
 * none when the root has no published children.
 *
 * The first fonds has five file-level children and three series, so
 * both files must give it "file", a value no root formatted without its
 * children could reach. One of its files has a published item and
 * gives "item"; the others give nothing. The second fonds has a child
 * count of one but its only child is unpublished, so it gives nothing.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { exportFondsDescriptions, exportRepositories } from "../../app/lib/export/pipeline.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";
import { MemoryStorage } from "./memory-storage";

const TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};
const now = 1_700_000_000_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REPO = uuid(1);
const A = uuid(10);
const B = uuid(11);

async function seed(db: DrizzleD1Database<any>): Promise<void> {
  await db.insert(schema.repositories).values({
    id: REPO, tenantId: TENANT.id, code: "co-x", name: "X", enabled: true, createdAt: now, updatedAt: now,
  });
  const desc = (
    id: string, parentId: string | null, rootId: string, level: string, referenceCode: string,
    childCount: number, isPublished = true
  ) =>
    db.insert(schema.descriptions).values({
      id, tenantId: TENANT.id, repositoryId: REPO, parentId, rootDescriptionId: rootId,
      descriptionLevel: level as any, referenceCode, title: referenceCode, childCount, isPublished,
      createdAt: now, updatedAt: now,
    });
  await desc(A, null, A, "fonds", "co-x-a", 8);
  await desc(B, null, B, "fonds", "co-x-b", 1);
  for (let i = 0; i < 3; i++) await desc(uuid(100 + i), A, A, "series", `co-x-a-s${i}`, 0);
  for (let i = 0; i < 5; i++) await desc(uuid(200 + i), A, A, "file", `co-x-a-f${i}`, i === 0 ? 1 : 0);
  await desc(uuid(300), uuid(200), A, "item", "co-x-a-f0-001", 0);
  await desc(uuid(400), B, B, "file", "co-x-b-f0", 0, false);
}

describe("children_level in the descriptions files and repositories.json", () => {
  let db: DrizzleD1Database<any>;
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    await seed(db);
  });

  async function levels(): Promise<{ file: Map<string, string | null>; repos: Map<string, string | null> }> {
    const storage = new MemoryStorage();
    const s = storage as unknown as ExportStorage;
    await exportFondsDescriptions(db, s, "co-x-a", TENANT);
    await exportFondsDescriptions(db, s, "co-x-b", TENANT);
    await exportRepositories(db, s, TENANT);
    const file = new Map<string, string | null>();
    for (const fonds of ["co-x-a", "co-x-b"]) {
      const rows = JSON.parse(storage.text(`neogranadina/descriptions-${fonds}.json`) ?? "null") as Array<Record<string, any>>;
      for (const r of rows) file.set(r.reference_code, r.children_level);
    }
    const repos = new Map<string, string | null>();
    for (const repo of JSON.parse(storage.text("neogranadina/repositories.json") ?? "null") as Array<Record<string, any>>) {
      for (const r of repo.root_descriptions) repos.set(r.reference_code, r.children_level);
    }
    return { file, repos };
  }

  it("gives each description the level of its published children", async () => {
    const { file } = await levels();
    expect(file.get("co-x-a")).toBe("file");
    expect(file.get("co-x-a-f0")).toBe("item");
    expect(file.get("co-x-a-f1")).toBeNull();
    expect(file.get("co-x-a-s0")).toBeNull();
    expect(file.get("co-x-b")).toBeNull();
  });

  it("gives each root in repositories.json the level its descriptions file gives it", async () => {
    const { file, repos } = await levels();
    expect(repos.get("co-x-a")).toBe("file");
    expect(repos.get("co-x-b")).toBeNull();
    expect([...repos.keys()].sort()).toEqual(["co-x-a", "co-x-b"]);
    for (const [code, level] of repos) expect(level).toBe(file.get(code));
  });
});

// @version v0.9.0
