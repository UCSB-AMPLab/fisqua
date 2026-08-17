/**
 * Tests — handlists
 *
 * Covers `app/lib/handlists.server.ts`, the ordered, named, persistent
 * sets a person keeps and works from. What is pinned here is the model
 * card's ruled behaviour that no surface can check for itself: the type
 * fixed by the first member and refused thereafter, dedupe reporting
 * that never lets a UNIQUE constraint surface as a crash, the soft
 * ceiling's warn-then-refuse boundary, who may manage a handlist versus
 * who may only work in it, the share dialog's eligibility gate, the
 * visibility rule that makes an absent handlist and a foreign one the
 * same 404, one name per owner per workspace, and — the hardest part —
 * that the membership integrity read never lies about a member that has
 * since been merged, split, or deleted from the workspace it was drawn
 * from.
 *
 * INTEGRITY IS COMPUTED, NOT STORED, so every merge/split/tombstone pin
 * here writes the DRIFT directly (a `merged_into` column, an
 * `authority_operations` row) rather than calling an admin route to
 * produce it — the fixture is the state the read has to resolve, not
 * the path that reaches it. The collapse pin in particular depends on
 * INSERTION ORDER: a survivor already held absorbs a later member that
 * resolves to it, so the surviving row keeps whichever member id
 * arrived first — a detail worth stating here because reading the
 * function alone would not make it obvious.
 *
 * FIXTURES. The request tenant (Neogranadina) and the second seeded
 * test tenant, which stands in for "another workspace" throughout —
 * two tenants are enough to prove the boundary; the cross-federation
 * and cross-sibling cases belong to `global-search.test.ts` and
 * `carried-scopes.test.ts`, which already pin the authority scope this
 * module borrows via `authorityScopeSql`. Most scenarios use opaque
 * string member ids, because `handlist_members.member_id` carries no
 * foreign key and most of what is pinned here (type-fixing, dedupe, the
 * ceiling, permissions, sharing, naming, reordering) never reads the
 * referenced table — only the integrity reads and the within-handlist
 * search pins seed real descriptions/entities/places. The ceiling
 * fixtures are built by inserting `handlist_members` rows directly
 * (chunked exactly as the module's own `insertMembers` is, to respect
 * D1's hundred-binding cap) rather than by calling `addMembers`
 * thousands of times.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, SECOND_TEST_TENANT_ID } from "../helpers/db";
import { NEOGRANADINA_TENANT_ID, NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import { parseSearch } from "../../app/lib/search-query";
import { runGlobalSearch, countMatching } from "../../app/lib/global-search.server";
import {
  createHandlist,
  renameHandlist,
  deleteHandlist,
  setWorkspaceVisible,
  shareHandlist,
  unshareHandlist,
  listShareCandidates,
  transferOwnership,
  addMembers,
  removeMember,
  reorderMembers,
  listForUser,
  getWithMembers,
  resolveReview,
  listMemberIds,
  HANDLIST_WARN_MEMBERS,
  HANDLIST_MAX_MEMBERS,
} from "../../app/lib/handlists.server";
import type { Tenant, User } from "../../app/context";

const TENANT_A = NEOGRANADINA_TENANT_ID;
const FED_A = NEOGRANADINA_FEDERATION_ID;
const TENANT_B = SECOND_TEST_TENANT_ID;

const OWNER_ID = "8a000000-0000-4000-8000-000000000001";
const EDITOR_ID = "8a000000-0000-4000-8000-000000000002";
const VIEWER_ID = "8a000000-0000-4000-8000-000000000003";
/** A third, plain workspace member — reaches nothing unless shared or workspace-visible. */
const COLLEAGUE_ID = "8a000000-0000-4000-8000-000000000004";
/** Owns the authority-typed fixtures; every admin-gated action needs one of these two. */
const ADMIN_ID = "8a000000-0000-4000-8000-000000000005";
const ADMIN2_ID = "8a000000-0000-4000-8000-000000000006";
/** In TENANT_B — the "another workspace" arm of the visibility rule. */
const FOREIGN_ID = "8a000000-0000-4000-8000-000000000007";

const REPO_A = "8b000000-0000-4000-8000-000000000001";
const REPO_B = "8b000000-0000-4000-8000-000000000002";

function db() {
  return drizzle(env.DB, { schema });
}

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

const owner = makeUser({ id: OWNER_ID, tenantId: TENANT_A });
const editor = makeUser({ id: EDITOR_ID, tenantId: TENANT_A });
const viewer = makeUser({ id: VIEWER_ID, tenantId: TENANT_A });
const colleague = makeUser({ id: COLLEAGUE_ID, tenantId: TENANT_A });
const admin = makeUser({ id: ADMIN_ID, tenantId: TENANT_A, isAdmin: true });
const admin2 = makeUser({ id: ADMIN2_ID, tenantId: TENANT_A, isAdmin: true });
const foreign = makeUser({ id: FOREIGN_ID, tenantId: TENANT_B });

async function loadTenant(id: string): Promise<Tenant> {
  const row = await db().select().from(schema.tenants).where(eq(schema.tenants.id, id)).get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function seedUser(id: string, tenantId: string, isAdmin: boolean): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, now, now)
    .run();
}

async function seedRepository(id: string, tenantId: string, code: string): Promise<void> {
  const now = Date.now();
  await db().insert(schema.repositories).values({
    id,
    tenantId,
    code,
    name: `Repository ${code}`,
    countryCode: "COL",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedDescription(values: {
  id: string;
  tenantId: string;
  repositoryId: string;
  referenceCode: string;
  title: string;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.descriptions).values({
    id: values.id,
    tenantId: values.tenantId,
    repositoryId: values.repositoryId,
    descriptionLevel: "item",
    referenceCode: values.referenceCode,
    title: values.title,
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedEntity(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
  mergedInto?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.entities).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    entityCode: `ne-${values.id.slice(-6)}`,
    displayName: values.displayName,
    sortName: values.displayName.toLowerCase(),
    entityType: "person",
    mergedInto: values.mergedInto ?? null,
    nameVariants: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPlace(values: {
  id: string;
  federationId: string;
  tenantId: string | null;
  displayName: string;
  mergedInto?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db().insert(schema.places).values({
    id: values.id,
    federationId: values.federationId,
    tenantId: values.tenantId,
    placeCode: `nl-${values.id.slice(-6)}`,
    label: values.displayName,
    displayName: values.displayName,
    mergedInto: values.mergedInto ?? null,
    nameVariants: "[]",
    legacyIds: "[]",
    createdAt: now,
    updatedAt: now,
  });
}

/** One 'split' row on the append-only ledger. */
async function seedSplitOperation(values: {
  id: string;
  sourceId: string;
  targetId: string;
  createdAt: number;
}): Promise<void> {
  await db().insert(schema.authorityOperations).values({
    id: values.id,
    federationId: FED_A,
    recordType: "entity",
    operation: "split",
    sourceId: values.sourceId,
    targetId: values.targetId,
    userId: ADMIN_ID,
    detail: null,
    createdAt: values.createdAt,
  });
}

/**
 * Insert `handlist_members` rows directly, chunked exactly as the
 * module's own `insertMembers` is (15 rows per statement, 6 columns
 * each — under D1's hundred-binding cap), batched in groups so a
 * ten-thousand-row ceiling fixture costs a handful of round trips
 * instead of one call to `addMembers` per member.
 */
async function seedMemberRowsDirect(
  handlistId: string,
  memberIds: string[],
  startPosition: number,
  addedBy: string,
  now: number,
): Promise<void> {
  const ROWS_PER_INSERT = 15;
  const INSERTS_PER_BATCH = 40;
  let statements: unknown[] = [];
  for (let i = 0; i < memberIds.length; i += ROWS_PER_INSERT) {
    const chunk = memberIds.slice(i, i + ROWS_PER_INSERT);
    statements.push(
      db()
        .insert(schema.handlistMembers)
        .values(
          chunk.map((memberId, j) => ({
            id: crypto.randomUUID(),
            handlistId,
            memberId,
            position: startPosition + i + j,
            addedBy,
            createdAt: now,
          })),
        ),
    );
    if (statements.length >= INSERTS_PER_BATCH) {
      await db().batch(statements as never);
      statements = [];
    }
  }
  if (statements.length > 0) {
    await db().batch(statements as never);
  }
}

async function seedFixtures(): Promise<void> {
  await seedUser(OWNER_ID, TENANT_A, false);
  await seedUser(EDITOR_ID, TENANT_A, false);
  await seedUser(VIEWER_ID, TENANT_A, false);
  await seedUser(COLLEAGUE_ID, TENANT_A, false);
  await seedUser(ADMIN_ID, TENANT_A, true);
  await seedUser(ADMIN2_ID, TENANT_A, true);
  await seedUser(FOREIGN_ID, TENANT_B, false);

  await seedRepository(REPO_A, TENANT_A, "HL-A");
  await seedRepository(REPO_B, TENANT_B, "HL-B");
}

describe("handlists", () => {
  let tenantA: Tenant;
  let tenantB: Tenant;

  beforeAll(async () => {
    await applyMigrations();
    await cleanDatabase();
    await seedFixtures();
    tenantA = await loadTenant(TENANT_A);
    tenantB = await loadTenant(TENANT_B);
  });

  describe("type fixed by the first member", () => {
    it("refuses a create carrying members but no recordType", async () => {
      const error = await createHandlist(db(), tenantA, owner, {
        name: "No type stated",
        memberIds: ["rec-notype-1"],
      }).catch((e) => e);
      expect(error).toBeInstanceOf(Response);
      expect(error.status).toBe(400);
    });

    it("fixes the type on the first add and refuses a mismatched later add", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Type fixed at birth",
        recordType: "records",
        memberIds: ["rec-type-1"],
      });
      expect(created.recordType).toBe("records");

      const mismatch = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "entities",
        memberIds: ["ent-mismatch-1"],
      }).catch((e) => e);
      expect(mismatch).toBeInstanceOf(Response);
      expect(mismatch.status).toBe(400);
      const body = await mismatch.text();
      expect(body).toContain("records");
      expect(body).toContain("entities");

      // The refusal changed nothing: the type is still what it was, and
      // the mismatched member never landed.
      const after = await listMemberIds(db(), tenantA, owner, created.id);
      expect(after.recordType).toBe("records");
      expect(after.memberIds).toEqual(["rec-type-1"]);

      // A matching add still works.
      const matched = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "records",
        memberIds: ["rec-type-2"],
      });
      expect(matched.total).toBe(2);
    });

    it("leaves an empty handlist untyped until its first add fixes it", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Untyped until filled",
      });
      expect(created.recordType).toBeNull();
      const beforeAdd = await listMemberIds(db(), tenantA, owner, created.id);
      expect(beforeAdd.recordType).toBeNull();

      const first = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "records",
        memberIds: ["rec-first-1"],
      });
      expect(first.recordType).toBe("records");
      const afterAdd = await listMemberIds(db(), tenantA, owner, created.id);
      expect(afterAdd.recordType).toBe("records");
    });
  });

  describe("dedupe on add", () => {
    it("dedupes members handed to create in one call", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Dedupe at creation",
        recordType: "records",
        memberIds: ["rec-dd-a", "rec-dd-b", "rec-dd-a"],
      });
      expect(created.added).toBe(2);
      expect(created.alreadyIn).toBe(0);
      expect(created.total).toBe(2);
    });

    it("reports {added, alreadyIn} honestly, and the UNIQUE constraint never surfaces as a crash", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Dedupe on add",
        recordType: "records",
        memberIds: ["rec-dd2-a", "rec-dd2-b"],
      });

      // rec-dd2-a is already held; rec-dd2-c arrives twice in the same
      // call. Neither should throw, and the counts should tell the
      // truth about what actually happened.
      const first = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "records",
        memberIds: ["rec-dd2-a", "rec-dd2-c", "rec-dd2-c"],
      });
      expect(first.added).toBe(1);
      expect(first.alreadyIn).toBe(1);
      expect(first.total).toBe(3);

      // A second call where every id is already held: a pure no-op,
      // not an error.
      const second = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "records",
        memberIds: ["rec-dd2-a", "rec-dd2-b", "rec-dd2-c"],
      });
      expect(second.added).toBe(0);
      expect(second.alreadyIn).toBe(3);
      expect(second.total).toBe(3);

      const held = await listMemberIds(db(), tenantA, owner, created.id);
      expect(held.memberIds).toHaveLength(3);
    });
  });

  describe("the ceiling", () => {
    it("warns past HANDLIST_WARN_MEMBERS but still lands the add", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Ceiling warn",
        recordType: "records",
        memberIds: ["warn-first"],
      });
      // Fill to exactly the threshold directly — not through addMembers,
      // which would mean HANDLIST_WARN_MEMBERS - 1 individual calls.
      const bulk = Array.from(
        { length: HANDLIST_WARN_MEMBERS - 1 },
        (_, i) => `warn-bulk-${i}`,
      );
      await seedMemberRowsDirect(created.id, bulk, 1, OWNER_ID, Date.now());
      const atThreshold = await listMemberIds(db(), tenantA, owner, created.id);
      expect(atThreshold.memberIds).toHaveLength(HANDLIST_WARN_MEMBERS);

      // One more crosses the line: the add lands, and warn is true.
      const crossed = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "records",
        memberIds: ["warn-crosses-the-line"],
      });
      expect(crossed.added).toBe(1);
      expect(crossed.total).toBe(HANDLIST_WARN_MEMBERS + 1);
      expect(crossed.warn).toBe(true);
    });

    it("refuses past HANDLIST_MAX_MEMBERS with a 400 that names the number, storing nothing new", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Ceiling refuse",
        recordType: "records",
        memberIds: ["refuse-first"],
      });
      const bulk = Array.from(
        { length: HANDLIST_MAX_MEMBERS - 1 },
        (_, i) => `refuse-bulk-${i}`,
      );
      await seedMemberRowsDirect(created.id, bulk, 1, OWNER_ID, Date.now());
      const atCap = await listMemberIds(db(), tenantA, owner, created.id);
      expect(atCap.memberIds).toHaveLength(HANDLIST_MAX_MEMBERS);

      const refused = await addMembers(db(), tenantA, owner, created.id, {
        recordType: "records",
        memberIds: ["refuse-over-the-cap"],
      }).catch((e) => e);
      expect(refused).toBeInstanceOf(Response);
      expect(refused.status).toBe(400);
      const body = await refused.text();
      expect(body).toContain(String(HANDLIST_MAX_MEMBERS));
      expect(body).toContain(String(HANDLIST_MAX_MEMBERS + 1));

      // Refused, not truncated to the cap: the member count is exactly
      // what it was before the refused call.
      const after = await listMemberIds(db(), tenantA, owner, created.id);
      expect(after.memberIds).toHaveLength(HANDLIST_MAX_MEMBERS);
      expect(after.memberIds).not.toContain("refuse-over-the-cap");
    });
  });

  describe("owner-only management", () => {
    async function makeManagedHandlist() {
      const created = await createHandlist(db(), tenantA, owner, {
        name: `Managed ${crypto.randomUUID()}`,
        recordType: "records",
        memberIds: ["rec-mgmt-1"],
      });
      await shareHandlist(db(), tenantA, owner, created.id, {
        userId: EDITOR_ID,
        role: "editor",
      });
      await shareHandlist(db(), tenantA, owner, created.id, {
        userId: VIEWER_ID,
        role: "viewer",
      });
      return created.id;
    }

    it("refuses rename, delete, share, workspace-visible and transfer to an editor and a viewer", async () => {
      for (const actor of [editor, viewer]) {
        const id = await makeManagedHandlist();

        const rename = await renameHandlist(db(), tenantA, actor, id, {
          name: "Renamed by a non-owner",
        }).catch((e) => e);
        expect(rename).toBeInstanceOf(Response);
        expect(rename.status).toBe(403);

        const del = await deleteHandlist(db(), tenantA, actor, id).catch((e) => e);
        expect(del).toBeInstanceOf(Response);
        expect(del.status).toBe(403);

        const share = await shareHandlist(db(), tenantA, actor, id, {
          userId: COLLEAGUE_ID,
          role: "viewer",
        }).catch((e) => e);
        expect(share).toBeInstanceOf(Response);
        expect(share.status).toBe(403);

        const visible = await setWorkspaceVisible(db(), tenantA, actor, id, true).catch(
          (e) => e,
        );
        expect(visible).toBeInstanceOf(Response);
        expect(visible.status).toBe(403);

        const transfer = await transferOwnership(db(), tenantA, actor, id, EDITOR_ID).catch(
          (e) => e,
        );
        expect(transfer).toBeInstanceOf(Response);
        expect(transfer.status).toBe(403);
      }
    });

    it("lets an editor add, remove and reorder, and refuses a viewer all three", async () => {
      const id = await makeManagedHandlist();

      const added = await addMembers(db(), tenantA, editor, id, {
        recordType: "records",
        memberIds: ["rec-mgmt-2"],
      });
      expect(added.total).toBe(2);

      await removeMember(db(), tenantA, editor, id, "rec-mgmt-2");
      const afterRemove = await listMemberIds(db(), tenantA, owner, id);
      expect(afterRemove.memberIds).toEqual(["rec-mgmt-1"]);

      await addMembers(db(), tenantA, editor, id, {
        recordType: "records",
        memberIds: ["rec-mgmt-3"],
      });
      await reorderMembers(db(), tenantA, editor, id, ["rec-mgmt-3", "rec-mgmt-1"]);
      const reordered = await listMemberIds(db(), tenantA, owner, id);
      expect(reordered.memberIds).toEqual(["rec-mgmt-3", "rec-mgmt-1"]);

      const viewerAdd = await addMembers(db(), tenantA, viewer, id, {
        recordType: "records",
        memberIds: ["rec-mgmt-4"],
      }).catch((e) => e);
      expect(viewerAdd).toBeInstanceOf(Response);
      expect(viewerAdd.status).toBe(403);

      const viewerRemove = await removeMember(db(), tenantA, viewer, id, "rec-mgmt-1").catch(
        (e) => e,
      );
      expect(viewerRemove).toBeInstanceOf(Response);
      expect(viewerRemove.status).toBe(403);

      const viewerReorder = await reorderMembers(db(), tenantA, viewer, id, [
        "rec-mgmt-1",
      ]).catch((e) => e);
      expect(viewerReorder).toBeInstanceOf(Response);
      expect(viewerReorder.status).toBe(403);
    });
  });

  describe("share eligibility on an authorities-typed handlist", () => {
    async function makeAuthorityHandlist() {
      // A member is required to actually FIX the type — recordType stays
      // NULL on an empty create regardless of what is asked for, so an
      // authority-typed fixture needs at least one member to be authority
      // at read time.
      return await createHandlist(db(), tenantA, admin, {
        name: `Authorities ${crypto.randomUUID()}`,
        recordType: "entities",
        memberIds: ["ent-eligibility-seed"],
      });
    }

    it("refuses sharing with a non-admin and succeeds sharing with an admin", async () => {
      const created = await makeAuthorityHandlist();

      const refused = await shareHandlist(db(), tenantA, admin, created.id, {
        userId: OWNER_ID,
        role: "viewer",
      }).catch((e) => e);
      expect(refused).toBeInstanceOf(Response);
      expect(refused.status).toBe(400);

      // Refused, not stored.
      const detail = await getWithMembers(db(), tenantA, admin, created.id);
      expect(detail.shares).toEqual([]);

      await shareHandlist(db(), tenantA, admin, created.id, {
        userId: ADMIN2_ID,
        role: "editor",
      });
      const afterShare = await getWithMembers(db(), tenantA, admin, created.id);
      expect(afterShare.shares.map((s) => s.userId)).toEqual([ADMIN2_ID]);
    });

    it("marks the non-admin candidate ineligible with the reason, and the admin eligible", async () => {
      const created = await makeAuthorityHandlist();
      const candidates = await listShareCandidates(db(), tenantA, admin, created.id);

      const nonAdminRow = candidates.find((c) => c.userId === OWNER_ID);
      expect(nonAdminRow?.eligible).toBe(false);
      expect(nonAdminRow?.ineligibleReason).toBe("authorities-admin-only");

      const adminRow = candidates.find((c) => c.userId === ADMIN2_ID);
      expect(adminRow?.eligible).toBe(true);
      expect(adminRow?.ineligibleReason).toBeNull();
    });
  });

  describe("visibility", () => {
    it("the owner sees it", async () => {
      const created = await createHandlist(db(), tenantA, owner, { name: "Owner sees" });
      const detail = await getWithMembers(db(), tenantA, owner, created.id);
      expect(detail.role).toBe("owner");
    });

    it("a sharee sees it", async () => {
      const created = await createHandlist(db(), tenantA, owner, { name: "Sharee sees" });
      await shareHandlist(db(), tenantA, owner, created.id, {
        userId: EDITOR_ID,
        role: "viewer",
      });
      const detail = await getWithMembers(db(), tenantA, editor, created.id);
      expect(detail.role).toBe("viewer");
    });

    it("a workspace-visible handlist is visible to a third tenant member", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Workspace visible",
        workspaceVisible: true,
      });
      const detail = await getWithMembers(db(), tenantA, colleague, created.id);
      expect(detail.role).toBe("workspace");
      expect(detail.canEdit).toBe(false);
      expect(detail.canManage).toBe(false);
    });

    it("404s for a user from another tenant, and for an id that never existed — indistinguishably", async () => {
      const created = await createHandlist(db(), tenantA, owner, { name: "Foreign 404" });

      const foreignTenant = await getWithMembers(db(), tenantB, foreign, created.id).catch(
        (e) => e,
      );
      const neverExisted = await getWithMembers(
        db(),
        tenantA,
        owner,
        "8f0f0f0f-0000-4000-8000-00000000ffff",
      ).catch((e) => e);

      for (const refusal of [foreignTenant, neverExisted]) {
        expect(refusal).toBeInstanceOf(Response);
        expect(refusal.status).toBe(404);
      }
      const bodies = await Promise.all(
        [foreignTenant, neverExisted].map((r: Response) => r.text()),
      );
      expect(new Set(bodies).size).toBe(1);

      // And the owner still reads it — the gate refused, the row exists.
      expect((await getWithMembers(db(), tenantA, owner, created.id)).id).toBe(created.id);
    });
  });

  describe("duplicate name per (tenant, owner)", () => {
    it("refuses a second handlist with the same name for the same owner, on create and on rename", async () => {
      await createHandlist(db(), tenantA, owner, { name: "Padrones" });

      const dupCreate = await createHandlist(db(), tenantA, owner, {
        name: "Padrones",
      }).catch((e) => e);
      expect(dupCreate).toBeInstanceOf(Response);
      expect(dupCreate.status).toBe(409);

      const other = await createHandlist(db(), tenantA, owner, { name: "Matriculas" });
      const dupRename = await renameHandlist(db(), tenantA, owner, other.id, {
        name: "Padrones",
      }).catch((e) => e);
      expect(dupRename).toBeInstanceOf(Response);
      expect(dupRename.status).toBe(409);
    });

    it("allows the same name under a different owner", async () => {
      const mine = await createHandlist(db(), tenantA, owner, { name: "Compartido" });
      const theirs = await createHandlist(db(), tenantA, editor, { name: "Compartido" });
      expect(mine.id).not.toBe(theirs.id);
    });
  });

  describe("membership integrity — entities", () => {
    const E_SURVIVOR = "8d000000-0000-4000-8000-000000000001";
    const E_MERGED_AWAY = "8d000000-0000-4000-8000-000000000002";
    const E_COLLAPSE_SURVIVOR = "8d000000-0000-4000-8000-000000000003";
    const E_COLLAPSE_LOSER = "8d000000-0000-4000-8000-000000000004";
    const E_SPLIT_SOURCE = "8d000000-0000-4000-8000-000000000005";
    const E_SPLIT_TARGET = "8d000000-0000-4000-8000-000000000006";
    const E_SPLIT_HISTORY = "8d000000-0000-4000-8000-000000000007";
    const E_SPLIT_HISTORY_TARGET = "8d000000-0000-4000-8000-000000000008";
    /** Never seeded — the tombstone case. */
    const E_TOMBSTONE = "8d000000-0000-4000-8000-0000000000ff";

    const T0 = 1_700_000_000_000;
    /** After the members are added, so the split reads as CURRENT drift. */
    const T_SPLIT_AFTER = T0 + 10_000;
    /** Before the member is added, so the split reads as HISTORY. */
    const T_SPLIT_BEFORE = T0 - 10_000;

    let handlistId: string;

    beforeAll(async () => {
      await seedEntity({
        id: E_SURVIVOR,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Ana Survivor",
      });
      await seedEntity({
        id: E_MERGED_AWAY,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Beto MergedAway",
        mergedInto: E_SURVIVOR,
      });
      await seedEntity({
        id: E_COLLAPSE_SURVIVOR,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Clara CollapseSurvivor",
      });
      await seedEntity({
        id: E_COLLAPSE_LOSER,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Diego CollapseLoser",
        mergedInto: E_COLLAPSE_SURVIVOR,
      });
      await seedEntity({
        id: E_SPLIT_SOURCE,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Elsa SplitSource",
      });
      await seedEntity({
        id: E_SPLIT_TARGET,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Franco SplitTarget",
      });
      await seedEntity({
        id: E_SPLIT_HISTORY,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Gina SplitHistory",
      });
      await seedEntity({
        id: E_SPLIT_HISTORY_TARGET,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Hugo SplitHistoryTarget",
      });

      // The split on E_SPLIT_SOURCE happens AFTER the member is added
      // below (T_SPLIT_AFTER > T0): current drift, must flag.
      await seedSplitOperation({
        id: "8e000000-0000-4000-8000-000000000001",
        sourceId: E_SPLIT_SOURCE,
        targetId: E_SPLIT_TARGET,
        createdAt: T_SPLIT_AFTER,
      });
      // The split on E_SPLIT_HISTORY happens BEFORE the member is added
      // (T_SPLIT_BEFORE < T0): the person added it knowing what it
      // already was — history, not drift, must not flag.
      await seedSplitOperation({
        id: "8e000000-0000-4000-8000-000000000002",
        sourceId: E_SPLIT_HISTORY,
        targetId: E_SPLIT_HISTORY_TARGET,
        createdAt: T_SPLIT_BEFORE,
      });

      const created = await createHandlist(
        db(),
        tenantA,
        admin,
        {
          name: "Integrity check",
          recordType: "entities",
          // E_COLLAPSE_SURVIVOR arrives first, so when E_COLLAPSE_LOSER
          // (merged into it) is added next, the survivor's row is the
          // one already in `byResolved` and absorbs it.
          memberIds: [E_COLLAPSE_SURVIVOR],
        },
        T0,
      );
      handlistId = created.id;
      await addMembers(
        db(),
        tenantA,
        admin,
        handlistId,
        {
          recordType: "entities",
          memberIds: [
            E_COLLAPSE_LOSER,
            E_MERGED_AWAY,
            E_SPLIT_SOURCE,
            E_SPLIT_HISTORY,
            E_TOMBSTONE,
          ],
        },
        T0,
      );
    });

    it("follows a merge to the survivor without collapsing when the survivor is not itself a member", async () => {
      const detail = await getWithMembers(db(), tenantA, admin, handlistId);
      const row = detail.members.find((m) => m.memberId === E_MERGED_AWAY);
      expect(row).toBeDefined();
      expect(row!.state).toBe("merged");
      expect(row!.resolvedId).toBe(E_SURVIVOR);
      expect(row!.title).toBe("Ana Survivor");
      expect(row!.collapsedFrom).toEqual([]);
      expect(row!.exportable).toBe(true);
      expect(row!.needsReview).toBe(false);
    });

    it("collapses a member into an already-held survivor, dropping the count", async () => {
      const detail = await getWithMembers(db(), tenantA, admin, handlistId);
      const survivorRow = detail.members.find((m) => m.memberId === E_COLLAPSE_SURVIVOR);
      expect(survivorRow).toBeDefined();
      expect(survivorRow!.state).toBe("merged");
      expect(survivorRow!.collapsedFrom).toEqual([E_COLLAPSE_LOSER]);
      // The loser never appears as its own row.
      expect(
        detail.members.find((m) => m.memberId === E_COLLAPSE_LOSER),
      ).toBeUndefined();
    });

    it("shows a deleted member as a tombstone, present but excluded from exportable", async () => {
      const detail = await getWithMembers(db(), tenantA, admin, handlistId);
      const row = detail.members.find((m) => m.memberId === E_TOMBSTONE);
      expect(row).toBeDefined();
      expect(row!.state).toBe("missing");
      expect(row!.resolvedId).toBeNull();
      expect(row!.exportable).toBe(false);
    });

    it("flags a split source with needsReview and both successors, excluded from exportable", async () => {
      const detail = await getWithMembers(db(), tenantA, admin, handlistId);
      const row = detail.members.find((m) => m.memberId === E_SPLIT_SOURCE);
      expect(row).toBeDefined();
      expect(row!.state).toBe("split");
      expect(row!.needsReview).toBe(true);
      expect(row!.exportable).toBe(false);
      expect(row!.successors.map((s) => s.id)).toEqual([E_SPLIT_SOURCE, E_SPLIT_TARGET]);
    });

    it("does not flag a split that predates the member's arrival — history, not drift", async () => {
      const detail = await getWithMembers(db(), tenantA, admin, handlistId);
      const row = detail.members.find((m) => m.memberId === E_SPLIT_HISTORY);
      expect(row).toBeDefined();
      expect(row!.state).toBe("present");
      expect(row!.needsReview).toBe(false);
      expect(row!.exportable).toBe(true);
    });

    it("reports honest total/exportable/needsReview across every row, and needsReview iff a row needs it", async () => {
      const detail = await getWithMembers(db(), tenantA, admin, handlistId);
      // Six adds, one collapse: 5 rows.
      expect(detail.total).toBe(5);
      // Exportable: the collapsed survivor, the merged-away row and the
      // history row. Excluded: the tombstone and the split.
      expect(detail.exportable).toBe(3);
      expect(detail.missingCount).toBe(1);
      expect(detail.needsReviewCount).toBe(1);
      expect(detail.needsReview).toBe(true);
    });
  });

  describe("membership integrity — places follow the same rule", () => {
    it("follows a place merge to its survivor", async () => {
      const P_SURVIVOR = "8f000000-0000-4000-8000-000000000001";
      const P_LOSER = "8f000000-0000-4000-8000-000000000002";
      await seedPlace({
        id: P_SURVIVOR,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Cachipay Survivor",
      });
      await seedPlace({
        id: P_LOSER,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Cachipay Loser",
        mergedInto: P_SURVIVOR,
      });
      const created = await createHandlist(db(), tenantA, admin, {
        name: "Places integrity",
        recordType: "places",
        memberIds: [P_LOSER],
      });
      const detail = await getWithMembers(db(), tenantA, admin, created.id);
      const row = detail.members.find((m) => m.memberId === P_LOSER);
      expect(row?.state).toBe("merged");
      expect(row?.resolvedId).toBe(P_SURVIVOR);
      expect(row?.title).toBe("Cachipay Survivor");
    });
  });

  describe("resolveReview", () => {
    it("acknowledge repoints a merged member at its survivor", async () => {
      const E_MEMBER = "89000000-0000-4000-8000-000000000001";
      const E_SURVIVOR = "89000000-0000-4000-8000-000000000002";
      await seedEntity({
        id: E_SURVIVOR,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Ack Survivor",
      });
      await seedEntity({
        id: E_MEMBER,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Ack Member",
        mergedInto: E_SURVIVOR,
      });
      const created = await createHandlist(db(), tenantA, admin, {
        name: "Acknowledge a merge",
        recordType: "entities",
        memberIds: [E_MEMBER],
      });

      const before = await getWithMembers(db(), tenantA, admin, created.id);
      expect(before.members[0].state).toBe("merged");
      expect(before.needsReview).toBe(false);

      await resolveReview(db(), tenantA, admin, created.id, {
        memberId: E_MEMBER,
        action: "acknowledge",
      });

      const after = await getWithMembers(db(), tenantA, admin, created.id);
      expect(after.members).toHaveLength(1);
      expect(after.members[0].memberId).toBe(E_SURVIVOR);
      expect(after.members[0].state).toBe("present");
      expect(after.needsReview).toBe(false);
    });

    /** Shared split fixture for the four `keep`/`keep-both`/`remove` cases below. */
    const E_SOURCE = "89000000-0000-4000-8000-000000000010";
    const E_TARGET = "89000000-0000-4000-8000-000000000011";
    const T_MEMBER = 1_710_000_000_000;
    const T_OP = T_MEMBER + 10_000;

    async function seedSplitFixtureOnce() {
      const existing = await db()
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, E_SOURCE))
        .get();
      if (existing) return;
      await seedEntity({
        id: E_SOURCE,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Keep Source",
      });
      await seedEntity({
        id: E_TARGET,
        federationId: FED_A,
        tenantId: TENANT_A,
        displayName: "Keep Target",
      });
      await seedSplitOperation({
        id: "89000000-0000-4000-8000-0000000000a0",
        sourceId: E_SOURCE,
        targetId: E_TARGET,
        createdAt: T_OP,
      });
    }

    async function makeSplitHandlist(name: string) {
      await seedSplitFixtureOnce();
      return await createHandlist(
        db(),
        tenantA,
        admin,
        { name, recordType: "entities", memberIds: [E_SOURCE] },
        T_MEMBER,
      );
    }

    it("keep with the original successor id re-stamps and clears the split flag", async () => {
      const created = await makeSplitHandlist("Keep original");
      const before = await getWithMembers(db(), tenantA, admin, created.id);
      expect(before.members[0].state).toBe("split");

      await resolveReview(db(), tenantA, admin, created.id, {
        memberId: E_SOURCE,
        action: "keep",
        successorId: E_SOURCE,
      });

      const after = await getWithMembers(db(), tenantA, admin, created.id);
      expect(after.members).toHaveLength(1);
      expect(after.members[0].memberId).toBe(E_SOURCE);
      expect(after.members[0].state).toBe("present");
      expect(after.needsReview).toBe(false);
    });

    it("keep with the new successor id repoints the membership", async () => {
      const created = await makeSplitHandlist("Keep successor");

      await resolveReview(db(), tenantA, admin, created.id, {
        memberId: E_SOURCE,
        action: "keep",
        successorId: E_TARGET,
      });

      const after = await getWithMembers(db(), tenantA, admin, created.id);
      expect(after.members).toHaveLength(1);
      expect(after.members[0].memberId).toBe(E_TARGET);
      expect(after.members[0].state).toBe("present");
      expect(after.needsReview).toBe(false);
    });

    it("keep-both results in both successors as members", async () => {
      const created = await makeSplitHandlist("Keep both");

      await resolveReview(db(), tenantA, admin, created.id, {
        memberId: E_SOURCE,
        action: "keep-both",
      });

      const after = await getWithMembers(db(), tenantA, admin, created.id);
      expect(after.total).toBe(2);
      expect(after.members.map((m) => m.memberId).sort()).toEqual(
        [E_SOURCE, E_TARGET].sort(),
      );
      expect(after.needsReview).toBe(false);
    });

    it("remove drops the row entirely", async () => {
      const created = await makeSplitHandlist("Remove");

      await resolveReview(db(), tenantA, admin, created.id, {
        memberId: E_SOURCE,
        action: "remove",
      });

      const after = await getWithMembers(db(), tenantA, admin, created.id);
      expect(after.members).toEqual([]);
      expect(after.total).toBe(0);
    });
  });

  describe("reorder", () => {
    it("honours an explicit order and appends the omitted ids in their original relative order", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Reorder me",
        recordType: "records",
        memberIds: ["r1", "r2", "r3", "r4"],
      });
      await shareHandlist(db(), tenantA, owner, created.id, {
        userId: VIEWER_ID,
        role: "viewer",
      });

      // r3 and r1 named explicitly; r2 and r4 (omitted) keep their
      // relative order (r2 before r4) at the end.
      await reorderMembers(db(), tenantA, owner, created.id, ["r3", "r1"]);
      const after = await listMemberIds(db(), tenantA, owner, created.id);
      expect(after.memberIds).toEqual(["r3", "r1", "r2", "r4"]);

      const refused = await reorderMembers(db(), tenantA, viewer, created.id, [
        "r1",
      ]).catch((e) => e);
      expect(refused).toBeInstanceOf(Response);
      expect(refused.status).toBe(403);
    });
  });

  describe("within-handlist search", () => {
    const D_H1 = "8c000000-0000-4000-8000-000000000001";
    const D_H2 = "8c000000-0000-4000-8000-000000000002";
    const D_H3 = "8c000000-0000-4000-8000-000000000003";
    /** In TENANT_B, on the same marker word, inserted as a member anyway. */
    const D_H_FOREIGN = "8c000000-0000-4000-8000-000000000004";

    let handlistId: string;

    beforeAll(async () => {
      await seedDescription({
        id: D_H1,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: "HL-H01",
        title: "Cofradía del sagrario",
      });
      await seedDescription({
        id: D_H2,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: "HL-H02",
        title: "Cofradía de las ánimas",
      });
      await seedDescription({
        id: D_H3,
        tenantId: TENANT_A,
        repositoryId: REPO_A,
        referenceCode: "HL-H03",
        title: "Cofradía del Rosario",
      });
      await seedDescription({
        id: D_H_FOREIGN,
        tenantId: TENANT_B,
        repositoryId: REPO_B,
        referenceCode: "HL-HF1",
        title: "Cofradía ajena",
      });

      const created = await createHandlist(db(), tenantA, owner, {
        name: "Search scope",
        recordType: "records",
        memberIds: [D_H1, D_H2],
      });
      handlistId = created.id;
      // Inserted as a member deliberately: the tenant predicate, not the
      // membership check, is what must keep it out of the results.
      await addMembers(db(), tenantA, owner, handlistId, {
        recordType: "records",
        memberIds: [D_H_FOREIGN],
      });
    });

    it("confines results to members AND the tenant, while the unscoped query returns the superset", async () => {
      const scoped = await runGlobalSearch(
        db(),
        { tenantId: TENANT_A, federationId: FED_A, includeAuthorities: true, handlistId },
        parseSearch(["cofradia"]),
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(scoped.page?.total).toBe(2);
      const ids = (scoped.page?.rows as { id: string }[]).map((r) => r.id).sort();
      expect(ids).toEqual([D_H1, D_H2].sort());
      expect(ids).not.toContain(D_H3);
      expect(ids).not.toContain(D_H_FOREIGN);

      const unscoped = await runGlobalSearch(
        db(),
        { tenantId: TENANT_A, federationId: FED_A, includeAuthorities: true },
        parseSearch(["cofradia"]),
        { category: "descriptions", page: 1, facets: {}, sort: null },
      );
      expect(unscoped.page?.total).toBe(3);
    });

    it("countMatching with handlistId cleared reports the workspace figure", async () => {
      const withinCount = await countMatching(
        db(),
        { tenantId: TENANT_A, federationId: FED_A, includeAuthorities: true, handlistId },
        parseSearch(["cofradia"]),
        { category: "descriptions", facets: {} },
      );
      expect(withinCount).toBe(2);

      const workspaceCount = await countMatching(
        db(),
        {
          tenantId: TENANT_A,
          federationId: FED_A,
          includeAuthorities: true,
          handlistId: null,
        },
        parseSearch(["cofradia"]),
        { category: "descriptions", facets: {} },
      );
      expect(workspaceCount).toBe(3);
    });
  });

  describe("listForUser", () => {
    it("filters mine/shared/all with honest counts", async () => {
      const mine = await createHandlist(db(), tenantA, owner, { name: "Filter mine" });
      const sharedWithMe = await createHandlist(db(), tenantA, editor, {
        name: "Filter shared with owner",
      });
      await shareHandlist(db(), tenantA, editor, sharedWithMe.id, {
        userId: OWNER_ID,
        role: "viewer",
      });
      // Neither owned nor shared: must not appear under "mine" or "shared".
      await createHandlist(db(), tenantA, editor, { name: "Filter not owner's business" });

      const mineList = await listForUser(db(), tenantA, owner, "mine");
      expect(mineList.some((h) => h.id === mine.id)).toBe(true);
      expect(mineList.some((h) => h.id === sharedWithMe.id)).toBe(false);

      const sharedList = await listForUser(db(), tenantA, owner, "shared");
      expect(sharedList.some((h) => h.id === sharedWithMe.id)).toBe(true);
      expect(sharedList.some((h) => h.id === mine.id)).toBe(false);

      const allList = await listForUser(db(), tenantA, owner, "all");
      expect(allList.some((h) => h.id === mine.id)).toBe(true);
      expect(allList.some((h) => h.id === sharedWithMe.id)).toBe(true);
    });

    it("carries locked: true for a shared authorities-typed handlist once the sharee is no longer admin", async () => {
      const created = await createHandlist(db(), tenantA, admin, {
        name: "Locked residue",
        recordType: "entities",
        // Again, a member is required to actually fix the type.
        memberIds: ["ent-locked-seed"],
      });
      await shareHandlist(db(), tenantA, admin, created.id, {
        userId: ADMIN2_ID,
        role: "editor",
      });

      // Simulate a demotion: the same person, now without the admin
      // flag on the request context (their handlist_shares row is
      // untouched — nothing in this module rewrites it on demotion).
      const demoted = makeUser({ id: ADMIN2_ID, tenantId: TENANT_A, isAdmin: false });
      const list = await listForUser(db(), tenantA, demoted, "shared");
      const row = list.find((h) => h.id === created.id);
      expect(row).toBeDefined();
      expect(row!.locked).toBe(true);
      expect(row!.lockedReason).toBe("authorities-admin-only");
    });
  });

  describe("transferOwnership", () => {
    it("works for the owner", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Transfer by owner",
      });
      await transferOwnership(db(), tenantA, owner, created.id, EDITOR_ID);
      const detail = await getWithMembers(db(), tenantA, editor, created.id);
      expect(detail.role).toBe("owner");
      expect(detail.ownerId).toBe(EDITOR_ID);
    });

    it("works for a tenant admin who is not the owner", async () => {
      // Visibility is not an admin bypass: loadAccess still requires the
      // admin to reach the handlist as owner, sharee or workspace-visible
      // before transferOwnership's admin carve-out even applies.
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Transfer by admin",
        workspaceVisible: true,
      });
      await transferOwnership(db(), tenantA, admin, created.id, VIEWER_ID);
      const detail = await getWithMembers(db(), tenantA, viewer, created.id);
      expect(detail.ownerId).toBe(VIEWER_ID);
    });

    it("is refused for a random editor", async () => {
      const created = await createHandlist(db(), tenantA, owner, {
        name: "Transfer refused",
      });
      await shareHandlist(db(), tenantA, owner, created.id, {
        userId: EDITOR_ID,
        role: "editor",
      });
      const refused = await transferOwnership(
        db(),
        tenantA,
        editor,
        created.id,
        VIEWER_ID,
      ).catch((e) => e);
      expect(refused).toBeInstanceOf(Response);
      expect(refused.status).toBe(403);
    });
  });
});
