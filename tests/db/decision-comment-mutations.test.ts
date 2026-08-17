/**
 * Tests — decision comment mutations (server core)
 *
 * Covers `app/lib/decision-comments.server.ts`: the tenant-scoped
 * edit/delete pair for decision-anchored comment rows. Fixtures use
 * the harness's two federations: the default tenant inside the
 * Neogranadina federation, and the second tenant as lead of its own
 * separate federation — so the foreign-tenant cases exercise the
 * federation gate, the shared-space (`tenantId` NULL) cases exercise
 * within-federation visibility, and a small volume-anchored comment
 * (project/volume/entry chain) proves the module refuses to touch the
 * other side's rows.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import {
  editDecisionComment,
  deleteDecisionComment,
} from "../../app/lib/decision-comments.server";
import type { Tenant, User } from "../../app/context";

const AUTHOR_ID = "d1000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "d1000000-0000-4000-8000-000000000002";
const ADMIN_ID = "d1000000-0000-4000-8000-000000000003";
const FOREIGN_AUTHOR_ID = "d1000000-0000-4000-8000-000000000004";

function makeUser(overrides: Partial<User> & Pick<User, "id" | "tenantId">): User {
  return {
    email: `${overrides.id}@test.local`,
    name: null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

async function loadTenant(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  const row = await db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, id))
    .get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function seedUsers(): Promise<void> {
  const now = Date.now();
  const rows: Array<[string, string, boolean]> = [
    [AUTHOR_ID, DEFAULT_TEST_TENANT_ID, false],
    [OTHER_USER_ID, DEFAULT_TEST_TENANT_ID, false],
    [ADMIN_ID, DEFAULT_TEST_TENANT_ID, true],
    [FOREIGN_AUTHOR_ID, SECOND_TEST_TENANT_ID, false],
  ];
  for (const [id, tenantId, isAdmin] of rows) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, now, now)
      .run();
  }
}

async function seedDecision(opts: {
  id: string;
  tenantId: string | null;
  federationId?: string;
}): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.pendingDecisions).values({
    id: opts.id,
    federationId: opts.federationId ?? NEOGRANADINA_FEDERATION_ID,
    tenantId: opts.tenantId,
    kind: "authority-proposal",
    payload: "{}",
    sourceModule: "test",
    status: "open",
    createdAt: now,
  });
}

/** Insert a decision-anchored comment row directly, bypassing addDecisionComment. */
async function seedDecisionComment(opts: {
  id?: string;
  decisionId: string;
  tenantId: string | null;
  authorId?: string | null;
  authorLabel?: string | null;
  parentId?: string | null;
  text?: string;
  deletedAt?: number | null;
  createdAt?: number;
}): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const now = opts.createdAt ?? Date.now();
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.comments).values({
    id,
    tenantId: opts.tenantId,
    decisionId: opts.decisionId,
    authorId: opts.authorId ?? null,
    authorLabel: opts.authorLabel ?? null,
    parentId: opts.parentId ?? null,
    text: opts.text ?? "a comment",
    createdAt: now,
    updatedAt: now,
    deletedAt: opts.deletedAt ?? null,
  });
  return id;
}

/** Insert a project/volume/entry chain plus one entry-anchored comment. */
async function seedVolumeAnchoredComment(): Promise<string> {
  const db = drizzle(env.DB, { schema });
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  const commentId = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Volume-side project",
    createdBy: AUTHOR_ID,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "Volume-side volume",
    referenceCode: "REF-VOL",
    manifestUrl: "https://example.test/vol.json",
    pageCount: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.entries).values({
    id: entryId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    position: 0,
    startPage: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.comments).values({
    id: commentId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId,
    entryId,
    authorId: AUTHOR_ID,
    authorRole: "cataloguer",
    text: "volume-side comment",
    createdAt: now,
    updatedAt: now,
  });
  return commentId;
}

describe("decision comment mutations", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenant: Tenant;
  let foreignTenant: Tenant;
  let author: User;
  let otherUser: User;
  let admin: User;
  let foreignAuthor: User;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedUsers();
    db = drizzle(env.DB, { schema });
    tenant = await loadTenant(DEFAULT_TEST_TENANT_ID);
    foreignTenant = await loadTenant(SECOND_TEST_TENANT_ID);
    author = makeUser({ id: AUTHOR_ID, tenantId: DEFAULT_TEST_TENANT_ID });
    otherUser = makeUser({ id: OTHER_USER_ID, tenantId: DEFAULT_TEST_TENANT_ID });
    admin = makeUser({ id: ADMIN_ID, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
    foreignAuthor = makeUser({ id: FOREIGN_AUTHOR_ID, tenantId: SECOND_TEST_TENANT_ID });
  });

  describe("editDecisionComment", () => {
    it("400s on an empty (post-trim) body", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
      });

      await expect(
        editDecisionComment(db, author, tenant, commentId, "   "),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("404s when the comment does not exist", async () => {
      await expect(
        editDecisionComment(db, author, tenant, crypto.randomUUID(), "new text"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("404s on a volume-anchored comment (not this module's territory)", async () => {
      const commentId = await seedVolumeAnchoredComment();

      await expect(
        editDecisionComment(db, author, tenant, commentId, "new text"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("404s on a foreign federation's decision comment", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({
        id: decisionId,
        tenantId: SECOND_TEST_TENANT_ID,
        federationId: SECOND_TEST_FEDERATION_ID,
      });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: SECOND_TEST_TENANT_ID,
        authorId: FOREIGN_AUTHOR_ID,
      });

      await expect(
        editDecisionComment(db, author, tenant, commentId, "new text"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("404s on a shared-space comment from another federation", async () => {
      // tenantId NULL is shared within a federation, never across
      // federations: the federation gate must fire before the
      // NULL-tenant visibility rule can admit the caller.
      const decisionId = crypto.randomUUID();
      await seedDecision({
        id: decisionId,
        tenantId: null,
        federationId: SECOND_TEST_FEDERATION_ID,
      });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: null,
        authorId: FOREIGN_AUTHOR_ID,
      });

      await expect(
        editDecisionComment(db, author, tenant, commentId, "new text"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("is visible (no tenant-mismatch 404) on a NULL-tenant shared-space comment", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: null });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: null,
        authorId: AUTHOR_ID,
        text: "shared thread",
      });

      const result = await editDecisionComment(
        db,
        author,
        tenant,
        commentId,
        "shared thread, edited",
      );
      expect(result).toEqual({ changed: true });
    });

    it("410s when the comment is already deleted", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
        deletedAt: Date.now(),
      });

      await expect(
        editDecisionComment(db, author, tenant, commentId, "new text"),
      ).rejects.toMatchObject({ status: 410 });
    });

    it("403s when a non-author tries to edit", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
      });

      await expect(
        editDecisionComment(db, otherUser, tenant, commentId, "new text"),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("403s a label-authored comment even for an admin (no admin override on edit)", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorLabel: "Fisqua",
      });

      await expect(
        editDecisionComment(db, admin, tenant, commentId, "new text"),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("no-op edit returns changed:false and leaves editedAt/updatedAt untouched", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const createdAt = 1_000;
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
        text: "same text",
        createdAt,
      });

      const result = await editDecisionComment(
        db,
        author,
        tenant,
        commentId,
        "  same text  ",
        5_000,
      );
      expect(result).toEqual({ changed: false });

      const row = await db
        .select()
        .from(schema.comments)
        .where(eq(schema.comments.id, commentId))
        .get();
      expect(row!.editedAt).toBeNull();
      expect(row!.updatedAt).toBe(createdAt);
      expect(row!.createdAt).toBe(createdAt);
    });

    it("a real edit sets editedAt and updatedAt, and preserves createdAt", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const createdAt = 1_000;
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
        text: "original text",
        createdAt,
      });

      const result = await editDecisionComment(
        db,
        author,
        tenant,
        commentId,
        "revised text",
        9_000,
      );
      expect(result).toEqual({ changed: true });

      const row = await db
        .select()
        .from(schema.comments)
        .where(eq(schema.comments.id, commentId))
        .get();
      expect(row!.text).toBe("revised text");
      expect(row!.editedAt).toBe(9_000);
      expect(row!.updatedAt).toBe(9_000);
      expect(row!.createdAt).toBe(createdAt);
    });
  });

  describe("deleteDecisionComment", () => {
    it("403s when a non-author, non-admin tries to delete", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
      });

      await expect(
        deleteDecisionComment(db, otherUser, tenant, commentId),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("lets an admin delete another user's comment", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
      });

      const result = await deleteDecisionComment(db, admin, tenant, commentId, 7_000);
      expect(result).toEqual({ cascadedCount: 0 });

      const row = await db
        .select()
        .from(schema.comments)
        .where(eq(schema.comments.id, commentId))
        .get();
      expect(row!.deletedAt).toBe(7_000);
      expect(row!.deletedBy).toBe(ADMIN_ID);
    });

    it("lets an admin delete a label-authored (pipeline) comment", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorLabel: "Fisqua",
      });

      const result = await deleteDecisionComment(db, admin, tenant, commentId);
      expect(result.cascadedCount).toBe(0);

      const row = await db
        .select()
        .from(schema.comments)
        .where(eq(schema.comments.id, commentId))
        .get();
      expect(row!.deletedAt).not.toBeNull();
    });

    it("root cascade marks replies deleted and reports cascadedCount", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const rootId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
        text: "root",
      });
      const replyOneId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: OTHER_USER_ID,
        parentId: rootId,
        text: "reply one",
      });
      const replyTwoId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorLabel: "Fisqua",
        parentId: rootId,
        text: "reply two",
      });

      const result = await deleteDecisionComment(db, author, tenant, rootId, 8_000);
      expect(result).toEqual({ cascadedCount: 2 });

      for (const id of [rootId, replyOneId, replyTwoId]) {
        const row = await db
          .select()
          .from(schema.comments)
          .where(eq(schema.comments.id, id))
          .get();
        expect(row!.deletedAt).toBe(8_000);
      }
    });

    it("410s on a second delete", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({ id: decisionId, tenantId: DEFAULT_TEST_TENANT_ID });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        authorId: AUTHOR_ID,
      });

      await deleteDecisionComment(db, author, tenant, commentId);
      await expect(
        deleteDecisionComment(db, author, tenant, commentId),
      ).rejects.toMatchObject({ status: 410 });
    });

    it("404s on a volume-anchored comment", async () => {
      const commentId = await seedVolumeAnchoredComment();

      await expect(
        deleteDecisionComment(db, author, tenant, commentId),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("404s on a foreign federation's decision comment", async () => {
      const decisionId = crypto.randomUUID();
      await seedDecision({
        id: decisionId,
        tenantId: SECOND_TEST_TENANT_ID,
        federationId: SECOND_TEST_FEDERATION_ID,
      });
      const commentId = await seedDecisionComment({
        decisionId,
        tenantId: SECOND_TEST_TENANT_ID,
        authorId: FOREIGN_AUTHOR_ID,
      });

      await expect(
        deleteDecisionComment(db, admin, tenant, commentId),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
