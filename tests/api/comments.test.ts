/**
 * Tests — comments
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { userContext, type User } from "../../app/context";
import { action, loader } from "../../app/routes/api.comments";

type Db = ReturnType<typeof drizzle>;

function buildUser(overrides: Partial<User> & { id: string; email: string }): User {
  return {
    id: overrides.id,
    email: overrides.email,
    name: overrides.name ?? "Tester",
    isAdmin: overrides.isAdmin ?? false,
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    isCollabAdmin: overrides.isCollabAdmin ?? false,
    isArchiveUser: overrides.isArchiveUser ?? false,
    isUserManager: overrides.isUserManager ?? false,
    isCataloguer: overrides.isCataloguer ?? false,
    githubId: overrides.githubId ?? null,
  };
}

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function seedFixture(
  db: Db,
  memberRole: "lead" | "cataloguer" | "reviewer" = "lead"
) {
  const owner = await createTestUser({ email: `owner-${crypto.randomUUID()}@example.com` });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const pageId = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    name: "Test Project",
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId: owner.id,
    role: memberRole,
    createdAt: now,
  });

  await db.insert(schema.volumes).values({
    id: volumeId,
    projectId,
    name: "Test Volume",
    referenceCode: "co-test-vol",
    manifestUrl: "https://example.com/manifest.json",
    pageCount: 2,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.volumePages).values({
    id: pageId,
    volumeId,
    position: 1,
    imageUrl: "https://example.com/image-1.jpg",
    width: 800,
    height: 1200,
    label: "f.1r",
    createdAt: now,
  });

  await db.insert(schema.entries).values({
    id: entryId,
    volumeId,
    position: 0,
    startPage: 1,
    startY: 0,
    type: "item",
    title: "Test Entry",
    createdAt: now,
    updatedAt: now,
  });

  return {
    owner: buildUser({ id: owner.id, email: owner.email }),
    projectId,
    volumeId,
    entryId,
    pageId,
  };
}

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("/api/comments POST ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("returns 400 Invalid JSON body for a form-urlencoded request", async () => {
    const { owner, volumeId, entryId } = await seedFixture(db);

    const body = new URLSearchParams({
      volumeId,
      entryId,
      text: "form-urlencoded",
    });
    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toBe("Invalid JSON body");
  });

  it("accepts a JSON body with entryId and writes an entry-targeted comment", async () => {
    const { owner, volumeId, entryId } = await seedFixture(db);

    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({ volumeId, entryId, text: "entry comment" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.ok).toBe(true);
    expect(typeof json.commentId).toBe("string");

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.entryId).toBe(entryId);
    expect(row.pageId).toBeNull();
    expect(row.volumeId).toBe(volumeId);
  });

  it("accepts a JSON body with pageId and writes a page-targeted comment", async () => {
    const { owner, volumeId, pageId } = await seedFixture(db);

    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({ volumeId, pageId, text: "page comment" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(200);
    const json = await readJson(res);

    const [row] = await db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, json.commentId))
      .all();
    expect(row.entryId).toBeNull();
    expect(row.pageId).toBe(pageId);
    expect(row.volumeId).toBe(volumeId);
  });

  it("rejects a body that sets BOTH entryId and pageId with 400 Exactly one of...", async () => {
    const { owner, volumeId, entryId, pageId } = await seedFixture(db);

    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({ volumeId, entryId, pageId, text: "both" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("Exactly one of");
  });

  it("rejects a body that sets NEITHER entryId nor pageId with 400", async () => {
    const { owner, volumeId } = await seedFixture(db);

    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({ volumeId, text: "neither" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("Exactly one of");
  });

  it("rejects a body with a volumeId that does not match the entry's volume", async () => {
    const { owner, entryId } = await seedFixture(db);

    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({
        volumeId: "some-other-volume-id",
        entryId,
        text: "mismatch",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error).toContain("does not match");
  });

  it("returns 403 for a user who is not a member of the project", async () => {
    const { volumeId, entryId } = await seedFixture(db);
    const outsiderRow = await createTestUser({
      email: `outsider-${crypto.randomUUID()}@example.com`,
    });
    const outsider = buildUser({ id: outsiderRow.id, email: outsiderRow.email });

    const request = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({ volumeId, entryId, text: "sneaky" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = (await action({
      request,
      context: buildContext(outsider),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(403);
  });
});

describe("/api/comments GET ()", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("returns page-targeted comments when given a pageId", async () => {
    const { owner, volumeId, pageId } = await seedFixture(db);

    // seed one row via the API so the full path is exercised
    const postReq = new Request("http://localhost/api/comments", {
      method: "POST",
      body: JSON.stringify({ volumeId, pageId, text: "page note" }),
      headers: { "Content-Type": "application/json" },
    });
    await action({
      request: postReq,
      context: buildContext(owner),
      params: {},
    } as any);

    const getReq = new Request(
      `http://localhost/api/comments?pageId=${pageId}`,
      { method: "GET" }
    );
    const res = (await loader({
      request: getReq,
      context: buildContext(owner),
      params: {},
    } as any)) as Response;

    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(Array.isArray(json.comments)).toBe(true);
    expect(json.comments).toHaveLength(1);
    expect(json.comments[0].text).toBe("page note");
    expect(json.comments[0].pageId).toBe(pageId);
  });
});
